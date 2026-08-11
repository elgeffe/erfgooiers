/**
 * Per-match KPIs — the instrumentation layer for evaluation, NOT a reward.
 *
 * The training signal stays win/loss/draw. That is deliberate and it is a
 * lesson this project already paid for: v1 rewarded five-minute economic
 * margin and was measured to prefer fast starts over wins, and the scripted
 * baseline draws six games against Godlike while +80 ahead on material. Every
 * KPI here correlates with winning, and every one of them can therefore be hit
 * while losing. Optimise the outcome; measure the KPIs.
 *
 * What they are for, in order of how much they are worth:
 *
 *   1. DIAGNOSIS. Every mechanism found in this project so far — the siege
 *      deadlock, recovery paralysis, tavern starvation, forester distance, the
 *      timeout draws — needed a bespoke throwaway script written after the
 *      fact, because the match record held seven scalars and dropped the rest.
 *      These are the numbers that would have shown each of them directly.
 *   2. CHEAP TRIAGE. Milestone timings have far lower variance than match
 *      score, so a build-order regression is visible at n=20 with a tight
 *      interval where the outcome needs n=120 to resolve ±8%.
 *   3. CONVERSION, which material margin cannot express. `enemyCastleLow` is
 *      how close the seat came to actually winning: it separates "never
 *      reached the keep" from "had it at 5% and ran out of clock" in exactly
 *      the drawn games where margin reads as a comfortable lead.
 *
 * Sampling is O(units + buildings) every SAMPLE_INTERVAL sim-seconds, which is
 * a rounding error against the simulation itself (92% of match cost).
 */
import type { Game } from '../../src/game/Game';
import type { Building, PlayerId } from '../../src/types';

/** Sim seconds between samples. Coarse on purpose: these are match-scale
 *  summaries, and the integrals below only need to be unbiased, not exact. */
const SAMPLE_INTERVAL = 10;

/** Buildings whose first completion is a build-order landmark. Kept flat and
 *  explicit rather than derived from the phase milestones, because a milestone
 *  that changes definition would silently rewrite historical comparisons. */
const LANDMARKS = [
  'woodcutter', 'sawmill', 'forester', 'quarry', 'farm', 'mill', 'bakery',
  'tavern', 'barracks', 'smithy', 'armory', 'stable', 'engineer', 'mint',
] as const;
type Landmark = (typeof LANDMARKS)[number];

export interface MatchKPIs {
  /** Sim seconds to the first completed building of each kind; absent if it
   *  never landed, which is itself the finding more often than not. */
  landmark: Partial<Record<Landmark, number>>;
  /** First tick at which the seat fielded 1 / 10 / 25 / 40 fighters. */
  army10: number | null;
  army25: number | null;
  army40: number | null;
  /** Peak and final army, and the peak the ENEMY reached — a seat that never
   *  saw a big enemy army lost for different reasons than one that did. */
  armyPeak: number;
  armyFinal: number;
  enemyArmyPeak: number;

  /** CONVERSION. How close the seat came to ending the match. */
  /** Lowest fraction of its maximum the enemy storehouse was ever driven to. */
  enemyCastleLow: number;
  /** ...and the same for the seat's own keep, the mirror-image risk metric. */
  ownCastleLow: number;
  /** Sim seconds the seat spent with its army inside the enemy half. */
  pressureSeconds: number;
  /** Sim seconds the enemy spent inside the seat's half. */
  besiegedSeconds: number;

  /** WASTE. Each is an integral in unit-seconds, so they are comparable
   *  across matches of different length only after dividing by simSeconds. */
  /** Villagers alive but unassigned to any building. */
  idleVillagerSeconds: number;
  /** Buildings standing with no worker in them. */
  unstaffedSeconds: number;
  /** Coin/timber/stone held above a large threshold — hoarding, not economy. */
  floatSeconds: number;
  /** Construction sites open but starved of a delivery. */
  stalledSiteSeconds: number;
}

const EMPTY = (): MatchKPIs => ({
  landmark: {},
  army10: null, army25: null, army40: null,
  armyPeak: 0, armyFinal: 0, enemyArmyPeak: 0,
  enemyCastleLow: 1, ownCastleLow: 1,
  pressureSeconds: 0, besiegedSeconds: 0,
  idleVillagerSeconds: 0, unstaffedSeconds: 0, floatSeconds: 0, stalledSiteSeconds: 0,
});

/** Above this, stock is sitting still rather than being turned into anything. */
const FLOAT_THRESHOLD = 400;

/**
 * Samples a live match. Construct once, call `sample` every tick — it rate
 * limits itself — and read `kpis` at the end.
 */
export class KpiTracker {
  readonly kpis = EMPTY();
  private nextSampleAt = 0;
  private readonly seen = new Set<string>();
  private ownStore: Building | null = null;
  private enemyStore: Building | null = null;

  constructor(
    private readonly game: Game,
    private readonly seat: PlayerId,
    private readonly rival: PlayerId,
  ) {}

  /**
   * The last word on the match. MUST be called once the loop ends: a razed
   * keep both drops out of `playerStores` and ends the match on a tick the
   * rate limiter would usually skip, so without this the winning matches
   * report whatever the keep's health was up to ten seconds before it fell.
   */
  finish(): void {
    this.sample(true);
  }

  sample(force = false): void {
    const { game, seat, rival, kpis } = this;
    const now = game.elapsed;
    if (!force && now < this.nextSampleAt) return;
    this.nextSampleAt = now + SAMPLE_INTERVAL;

    // --- landmarks: first completion only, hence the seen set ---
    for (const building of game.buildings) {
      if (building.removed || building.owner !== seat) continue;
      const key = building.key as Landmark;
      if (this.seen.has(key) || !LANDMARKS.includes(key)) continue;
      this.seen.add(key);
      kpis.landmark[key] = Math.round(now);
    }

    // --- army curve ---
    let army = 0, enemyArmy = 0, villagers = 0, idleVillagers = 0;
    // Hold the keeps by reference once seen. A razed storehouse is dropped
    // from `playerStores`, so re-reading the map every sample would lose the
    // building at the exact moment its health is the thing worth recording.
    this.ownStore ??= game.playerStores.get(seat) ?? null;
    this.enemyStore ??= game.playerStores.get(rival) ?? null;
    const ownStore = this.ownStore;
    const enemyStore = this.enemyStore;
    let pressing = 0, besieging = 0;
    for (const unit of game.units) {
      if (unit.dead) continue;
      const fighter = unit.dmg > 0;
      if (unit.owner === seat) {
        if (fighter) {
          army++;
          if (enemyStore && near(unit, enemyStore)) pressing++;
        } else {
          villagers++;
          // "Free" exactly as perception.ts defines it — a villager with no
          // home building — so this KPI means the same thing as the value
          // net's `own_free_villagers` feature rather than something adjacent.
          if (unit.role === 'villager' && !unit.home) idleVillagers++;
        }
      } else if (unit.owner === rival && fighter) {
        enemyArmy++;
        if (ownStore && near(unit, ownStore)) besieging++;
      }
    }
    kpis.armyPeak = Math.max(kpis.armyPeak, army);
    kpis.enemyArmyPeak = Math.max(kpis.enemyArmyPeak, enemyArmy);
    kpis.armyFinal = army;
    if (kpis.army10 === null && army >= 10) kpis.army10 = Math.round(now);
    if (kpis.army25 === null && army >= 25) kpis.army25 = Math.round(now);
    if (kpis.army40 === null && army >= 40) kpis.army40 = Math.round(now);

    // A wave counts as pressure once a real slice of it is on the enemy keep,
    // not when one outrider wanders past it.
    if (pressing >= Math.max(3, army * 0.3)) kpis.pressureSeconds += SAMPLE_INTERVAL;
    if (besieging >= Math.max(3, enemyArmy * 0.3)) kpis.besiegedSeconds += SAMPLE_INTERVAL;

    // --- conversion: how close either keep came to falling ---
    if (enemyStore && !enemyStore.removed) {
      kpis.enemyCastleLow = Math.min(kpis.enemyCastleLow, enemyStore.hp / Math.max(1, enemyStore.maxHp));
    } else if (enemyStore) {
      kpis.enemyCastleLow = 0;
    }
    if (ownStore && !ownStore.removed) {
      kpis.ownCastleLow = Math.min(kpis.ownCastleLow, ownStore.hp / Math.max(1, ownStore.maxHp));
    } else if (ownStore) {
      kpis.ownCastleLow = 0;
    }

    // --- waste integrals ---
    kpis.idleVillagerSeconds += idleVillagers * SAMPLE_INTERVAL;
    let unstaffed = 0;
    for (const building of game.buildings) {
      if (building.removed || building.owner !== seat) continue;
      if (building.def.worker && !building.worker) unstaffed++;
    }
    kpis.unstaffedSeconds += unstaffed * SAMPLE_INTERVAL;
    const stock = ownStore?.stock ?? {};
    for (const item of ['coin', 'timber', 'stone'] as const) {
      if ((stock[item] ?? 0) > FLOAT_THRESHOLD) kpis.floatSeconds += SAMPLE_INTERVAL;
    }
    let stalled = 0;
    for (const site of game.sites) {
      if (site.owner !== seat) continue;
      const wanted = Object.entries(site.needs)
        .some(([item, amount]) => (site.delivered[item] ?? 0) < amount);
      if (wanted) stalled++;
    }
    kpis.stalledSiteSeconds += stalled * SAMPLE_INTERVAL;
  }
}

/** Inside the ring where a unit is meaningfully threatening a storehouse. */
function near(unit: { tx: number; ty: number }, store: { x: number; y: number }): boolean {
  return Math.max(Math.abs(unit.tx - store.x), Math.abs(unit.ty - store.y)) <= 14;
}

// ---- reporting ----

/** Mean of a numeric field over matches that have the KPI block at all. */
function mean(rows: MatchKPIs[], pick: (k: MatchKPIs) => number | null): number | null {
  const values = rows.map(pick).filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const show = (value: number | null, digits = 0): string =>
  value === null ? '   —' : value.toFixed(digits).padStart(6);

/**
 * A compact KPI table for a set of matches, optionally split by outcome — the
 * split is where the diagnosis usually is, since the interesting question is
 * rarely "what is the average" but "what did the losses do differently".
 */
export function kpiReport(label: string, rows: { score: number; kpis?: MatchKPIs }[]): string {
  const withKpis = rows.filter((r): r is { score: number; kpis: MatchKPIs } => !!r.kpis);
  if (!withKpis.length) return `${label}: no KPI blocks recorded\n`;
  const buckets: [string, MatchKPIs[]][] = [
    ['all', withKpis.map(r => r.kpis)],
    ['wins', withKpis.filter(r => r.score === 1).map(r => r.kpis)],
    ['draws', withKpis.filter(r => r.score === 0.5).map(r => r.kpis)],
    ['losses', withKpis.filter(r => r.score === 0).map(r => r.kpis)],
  ];
  const lines = [`\n${label} — KPIs by outcome (n=${withKpis.length})`];
  lines.push('bucket      n  barracks  army25  peak  enemyKeepLow  pressS  idleVil  float');
  for (const [name, set] of buckets) {
    if (!set.length) continue;
    lines.push(
      `${name.padEnd(8)} ${String(set.length).padStart(4)}  `
      + `${show(mean(set, k => k.landmark.barracks ?? null))}  `
      + `${show(mean(set, k => k.army25))}  `
      + `${show(mean(set, k => k.armyPeak), 1)}  `
      + `${show(mean(set, k => k.enemyCastleLow * 100), 1)}%  `
      + `${show(mean(set, k => k.pressureSeconds))}  `
      + `${show(mean(set, k => k.idleVillagerSeconds / 60))}  `
      + `${show(mean(set, k => k.floatSeconds))}`,
    );
  }
  // Landmarks that frequently never land are the loudest single signal here:
  // a build that is missing in half the matches is a plan that does not run.
  const missing = LANDMARKS
    .map(key => [key, withKpis.filter(r => r.kpis.landmark[key] === undefined).length] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (missing.length) {
    lines.push('never built: ' + missing
      .map(([key, count]) => `${key} ${(count / withKpis.length * 100).toFixed(0)}%`).join('  '));
  }
  return lines.join('\n') + '\n';
}
