import { DEFS } from '../../data/buildings';
import { UNITS, type UnitKind } from '../../data/units';
import type { Building, BuildingKey, Coord } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { findBuildingSpot, planPlots } from '../actuation';
import { economyStock, storeStock, type AIView } from '../perception';
import type { PolicyContext } from './types';

/**
 * The shared deterministic EXECUTOR: the mechanics every macro policy needs and
 * none of them should own privately — affordability with site reservations,
 * legal placement (including tower rings and forester coverage), staffing, farm
 * plots, and demolishing construction that will never finish.
 *
 * This module exists because of an explicit instruction in
 * docs/tensor-retrain-plan.md: "Extract reusable strategic execution helpers
 * from the successful Classic supplier/placement/worker logic. Do not duplicate
 * a weaker second executor in Tensor." A learned policy has to be judged on the
 * STRATEGY it chooses, so it must actuate through the same proven mechanics the
 * Classic benchmark uses — otherwise a lost match only proves the experimental
 * seat had clumsier hands.
 *
 * Everything here is behaviour lifted verbatim out of `ClassicMacro`, which now
 * calls back into it.
 */

/** Free villagers kept idle so a finished building is staffed immediately. */
export const VILLAGER_RESERVE = 2;
/** A forester only serves the woodcutters inside its planting radius. */
export const TIMBER_SUPPORT_RANGE = 9;
/**
 * Anchor bands tried in order when siting a forester on its woodcutter.
 *
 * Legality alone put lodges a median of 5 and as far as 15 tiles from the hut
 * they serve, because `anchorDistance` is only the THIRD tiebreaker in the
 * placement sort — open ground and clearance outrank it, and there is plenty
 * of both further out. A lodge planting saplings at the edge of its radius
 * replaces trees the cutter has to walk to; one planting inside the grove
 * replaces them where they are being felled.
 *
 * Tried tight-first with the full radius as the fallback, so preferring a
 * close site can never cost the lodge outright on cramped ground.
 */
const TIMBER_ANCHOR_BANDS = [4, TIMBER_SUPPORT_RANGE] as const;

/** Rank eight perimeter sectors so successive home towers cover the widest
 * unguarded arc. The first tower faces the enemy approach; later towers spread
 * around the full ring before filling nearby gaps. */
export function rankPerimeterTowerAnchors(
  home: Coord, approach: Coord, existing: readonly Coord[], radius = 11,
): Coord[] {
  const directions = [
    { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
    { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
  ];
  return directions
    .map(direction => ({ x: home.x + direction.x * radius, y: home.y + direction.y * radius }))
    .sort((a, b) => {
      const coverageA = existing.length
        ? Math.min(...existing.map(tower => Math.max(Math.abs(a.x - tower.x), Math.abs(a.y - tower.y))))
        : 0;
      const coverageB = existing.length
        ? Math.min(...existing.map(tower => Math.max(Math.abs(b.x - tower.x), Math.abs(b.y - tower.y))))
        : 0;
      const approachA = Math.max(Math.abs(a.x - approach.x), Math.abs(a.y - approach.y));
      const approachB = Math.max(Math.abs(b.x - approach.x), Math.abs(b.y - approach.y));
      return coverageB - coverageA || approachA - approachB || a.y - b.y || a.x - b.x;
    });
}

/** The first woodcutter no forester covers — where another lodge would help. */
export function selectUncoveredWoodcutter(
  woodcutters: readonly Coord[], foresters: readonly Coord[], range = TIMBER_SUPPORT_RANGE,
): Coord | null {
  return [...woodcutters]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .find(woodcutter => !foresters.some(forester => Math.max(
      Math.abs(forester.x - woodcutter.x), Math.abs(forester.y - woodcutter.y),
    ) <= range)) ?? null;
}

/** The seat's own first woodcutter standing outside every forester's reach. */
export function uncoveredWoodcutter(view: AIView): Coord | null {
  const owned = [...view.buildings, ...view.sites];
  return selectUncoveredWoodcutter(
    owned.filter(entity => entity.key === 'woodcutter'),
    owned.filter(entity => entity.key === 'forester'),
  );
}

/**
 * Can this seat pay for `key` right now? Stock already promised to open sites
 * is reserved, so two commands in one pass cannot spend the same timber twice
 * and recreate the many-half-built-site gridlock.
 */
export function affordable(ctx: PolicyContext, key: BuildingKey): boolean {
  const cost = ctx.game.modsFor(ctx.view.owner).buildingCost(DEFS[key]) as Record<string, number>;
  for (const item in cost) {
    let committed = 0;
    for (const site of ctx.view.sites) {
      committed += Math.max(0, (site.needs[item] ?? 0) - (site.delivered[item] ?? 0));
    }
    if (economyStock(ctx.game, ctx.view.owner, item) - committed < cost[item]) return false;
  }
  return true;
}

/**
 * Turn "I want a `key`" into a legal placement command, or null. Towers are
 * placed around the home perimeter ring; a forester only next to a woodcutter
 * it can actually serve; everything else through the shared placement search.
 * A failed search cools the key down in `blockedUntil` instead of burning the
 * search budget again on the next pass.
 */
export function placeBuilding(
  ctx: PolicyContext, key: BuildingKey, blockedUntil: Map<BuildingKey, number>,
): GameCommand | null {
  const { game, world, view, profile, rng } = ctx;
  if ((blockedUntil.get(key) ?? 0) > view.elapsed || !affordable(ctx, key)) return null;
  const reach = 22 + profile.expansion * 8;
  const timberAnchor = key === 'forester' ? uncoveredWoodcutter(view) : null;
  // Never scatter a forester beyond the nine-tile timber ecosystem it serves.
  // If every cutter is already covered, another lodge adds no capacity.
  if (key === 'forester' && !timberAnchor) return null;
  let spot = null;
  if (key === 'watchtower' || key === 'stonetower') {
    const home = { x: view.store!.x + 1, y: view.store!.y + 1 };
    const homeTowers = [...view.buildings, ...view.sites]
      .filter(entity => (entity.key === 'watchtower' || entity.key === 'stonetower')
        && Math.max(Math.abs(entity.x - home.x), Math.abs(entity.y - home.y)) <= 18);
    for (const anchor of rankPerimeterTowerAnchors(home, ctx.approach, homeTowers)) {
      spot = findBuildingSpot(game, world, view, key, rng, ctx.approach, reach, anchor, 4);
      if (spot) break;
    }
  } else if (timberAnchor) {
    for (const band of TIMBER_ANCHOR_BANDS) {
      spot = findBuildingSpot(game, world, view, key, rng, ctx.approach, reach, timberAnchor, band);
      if (spot) break;
    }
  } else {
    spot = findBuildingSpot(game, world, view, key, rng, ctx.approach, reach);
  }
  if (spot) return { type: 'placeBuilding', key, x: spot.x, y: spot.y, rot: spot.rot };
  blockedUntil.set(key, view.elapsed + 45);
  return null;
}

/** Attach crop/pasture plots to any field building still short of them. */
export function fieldPlots(ctx: PolicyContext): GameCommand | null {
  for (const building of ctx.view.buildings) {
    if (!building.def.fields) continue;
    const cells = planPlots(ctx.game, building);
    if (cells.length) return { type: 'placePlots', buildingId: building.id, cells };
  }
  return null;
}

/**
 * Per-site progress watermarks. A site whose deliveries and build progress have
 * not moved in minutes is never finishing (unreachable ground, dead supply
 * line): demolishing it frees the tile and releases every serf task bound to
 * it. The count of stalled sites is also the honest "my logistics are broken"
 * signal the Tensor v2 recovery overlay reads.
 */
export class SiteWatch {
  private readonly watch = new Map<number, { since: number; watermark: number }>();
  private stalledCount = 0;

  /** Sites seen frozen for longer than the patience window on the last step. */
  get stalled(): number { return this.stalledCount; }

  /** Update the watermarks and return a demolish command for a dead site. */
  step(view: AIView, patience = 150): GameCommand | null {
    const seen = new Set<number>();
    let demolish: GameCommand | null = null;
    let stalled = 0;
    for (const site of view.sites) {
      seen.add(site.id);
      let watermark = Math.round(site.progress * 100) + (site.ready ? 1000 : 0);
      for (const item in site.delivered) watermark += site.delivered[item] || 0;
      const watch = this.watch.get(site.id);
      if (!watch || watch.watermark !== watermark) {
        this.watch.set(site.id, { since: view.elapsed, watermark });
        continue;
      }
      if (view.elapsed - watch.since > patience) {
        stalled++;
        if (!demolish) demolish = { type: 'demolish', x: site.x, y: site.y, drag: false };
      }
    }
    for (const id of [...this.watch.keys()]) if (!seen.has(id)) this.watch.delete(id);
    this.stalledCount = stalled;
    return demolish;
  }
}

/**
 * Hire the civilian the settlement is most short of. Specialists first — an
 * unstaffed building produces nothing and villagers are what turn coin back
 * into coin — then haulers scaled to the size of the economy, then builders.
 */
export function staffEconomy(ctx: PolicyContext): GameCommand | null {
  const { game, view, profile } = ctx;
  const guild = view.buildings.find(b => b.def.trainer && b.active);
  if (!guild) return null;
  const queued = guild.trainQ ?? [];
  if (queued.length >= 2) return null;
  const coin = storeStock(game, view.owner, 'coin');
  const queuedOf = (kind: string): number => queued.filter(entry => entry === kind).length;

  const villagersWanted = view.workers.unstaffed
    + view.sites.filter(site => site.def.worker).length
    + VILLAGER_RESERVE - view.workers.freeVillagers - queuedOf('villager');
  if (villagersWanted > 0 && coin >= 1) {
    return { type: 'queueTraining', buildingId: guild.id, unit: 'villager' };
  }
  if (coin <= profile.workerReserveCoin) return null;
  // Haulers scale with the economy, but one-per-building overstaffs a town:
  // serfs spend most of their time idle while consuming every new coin ahead
  // of the army. The deeper profiles get a modest distance allowance for
  // their remote mines; the cap remains high enough for the largest planned
  // settlement without recreating the old ten-serf bottleneck.
  const production = view.buildings.filter(b => b.def.recipe || b.def.gather || b.def.tavern).length;
  const mobilising = profile.attackEnabled && view.armySize < profile.attackArmy;
  const serfScale = mobilising ? 0.4 : 0.5 + profile.expansion * 0.1;
  const serfTarget = Math.min(6 + Math.ceil(production * serfScale), mobilising ? 24 : 36);
  if (view.workers.serfs + queuedOf('serf') < serfTarget) {
    return { type: 'queueTraining', buildingId: guild.id, unit: 'serf' };
  }
  // Builders are deliberately last: the starting builder carries the whole
  // opening; extra construction throughput is a late-game luxury only after
  // every job is staffed and the logistics target is met.
  const coinEngineRunning = view.buildings.some(b => b.key === 'mint' && b.worker);
  const laborerTarget = coinEngineRunning && view.elapsed > 360 ? Math.min(3, Math.max(1, view.sites.length)) : 1;
  if (view.workers.laborers + queuedOf('laborer') < laborerTarget) {
    return { type: 'queueTraining', buildingId: guild.id, unit: 'laborer' };
  }
  return null;
}

// ---- army composition (shared: reactive counters, quotas, training) ----

export type ArmyCategory = 'mounted' | 'ranged' | 'melee';

function unitCategory(kind: string): ArmyCategory {
  const def = (UNITS as Record<string, (typeof UNITS)[UnitKind] | undefined>)[kind];
  if (!def) return 'melee';
  if (def.tags?.includes('mounted')) return 'mounted';
  if (def.arrows || def.range > 1.6) return 'ranged';
  return 'melee';
}

/** The rival army's dominant category and how lopsided it is (null = too small
 *  a force to bother countering). */
export function dominantEnemyCategory(byKind: Partial<Record<UnitKind, number>>): { cat: ArmyCategory; frac: number } | null {
  const cats: Record<ArmyCategory, number> = { mounted: 0, ranged: 0, melee: 0 };
  let total = 0;
  for (const kind in byKind) {
    const def = UNITS[kind as UnitKind];
    // Support and siege are strategic quotas, not a field-composition signal:
    // treating priests as melee and trebuchets as ranged taught the counter
    // system to suppress exactly the combined-arms tools Godlike needs.
    if (def?.heal || def?.model === 'siege') continue;
    const n = byKind[kind as UnitKind] ?? 0;
    total += n;
    cats[unitCategory(kind)] += n;
  }
  if (total < 3) return null;
  let best: ArmyCategory = 'melee', bestN = -1;
  for (const c of ['mounted', 'ranged', 'melee'] as ArmyCategory[]) if (cats[c] > bestN) { bestN = cats[c]; best = c; }
  return { cat: best, frac: bestN / total };
}

/** How much to reweight training `myKind` given the enemy's dominant category:
 *  pikemen shred cavalry (data-backed 2.5× bonus), durable melee closes on and
 *  soaks archers, archers kite melee. Scaled by reactivity × how lopsided the
 *  enemy is, so a mixed enemy barely shifts the shopping list. */
export function counterMultiplier(myKind: string, enemyDom: ArmyCategory, gain: number): number {
  const mine = unitCategory(myKind);
  if (enemyDom === 'mounted') return myKind === 'pikeman' ? 1 + 2.5 * gain : mine === 'melee' ? 1 + 0.3 * gain : 1 - 0.3 * gain;
  if (enemyDom === 'ranged') return mine === 'melee' ? 1 + 1.5 * gain : mine === 'ranged' ? 1 - 0.4 * gain : 1;
  return mine === 'ranged' ? 1 + 1.5 * gain : 1; // enemy melee-heavy → archers
}

/** Convert composition weights into exact standing-army slots. Largest-
 * remainder allocation is deterministic and sums to the cap, so cheap units
 * cannot consume slots reserved for cavalry, siege or priests. */
export function allocateUnitQuotas(weights: Readonly<Record<string, number>>, cap: number): Record<string, number> {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!entries.length || total <= 0 || cap <= 0) return {};
  const rows = entries.map(([kind, weight]) => {
    const exact = weight / total * cap;
    return { kind, quota: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = cap - rows.reduce((sum, row) => sum + row.quota, 0);
  rows.sort((a, b) => b.remainder - a.remainder || a.kind.localeCompare(b.kind));
  for (let i = 0; i < rows.length && left > 0; i++, left--) rows[i].quota++;
  return Object.fromEntries(rows.map(row => [row.kind, row.quota]));
}

/**
 * Queue the fighter the army is most short of, given a composition `mix`.
 *
 * The mix is a parameter rather than a read of `profile.unitMix` because that
 * is exactly the decision a learned policy takes over: Classic passes its
 * persona's fixed table, Tensor v2 passes the composition its sampled bundle
 * asked for, and both then get the same quota discipline — counter-reweighting,
 * exact largest-remainder slots, a first-wave floor over the trainers that
 * actually exist, and reserves that stop cheap infantry from eating the timber
 * a trebuchet or the coin a priest is waiting for.
 */
export function trainFighter(
  ctx: PolicyContext, mix: Readonly<Record<string, number>>, civilianCoinReserve = 0,
): GameCommand | null {
  const { game, view, profile, rng } = ctx;
  // Specialists come first. A queued barracks fighter must never spend the
  // coin that turns a completed production building (or imminent site) into
  // a working one. This is deliberately stronger than the ordinary reserve:
  // once every post is covered, civilian and military queues may run in
  // parallel again.
  if (view.workers.unstaffed > 0) return null;
  let queuedTotal = 0;
  const queuedByKind: Record<string, number> = {};
  const trainers: Building[] = [];
  for (const building of view.buildings) {
    if (!building.def.military || !building.active) continue;
    for (const kind of building.trainQ ?? []) {
      queuedTotal++;
      queuedByKind[kind] = (queuedByKind[kind] ?? 0) + 1;
    }
    if ((building.trainQ?.length ?? 0) < 2) trainers.push(building);
  }
  if (!trainers.length || view.armySize + queuedTotal >= profile.armyCap) return null;

  // Worker coins are permanent working capital. A staffed mint can still run
  // dry when its first ore vein exhausts or a miner dies; spending the final
  // coins on fighters at that moment makes the whole economy unrecoverable.
  const coinReserve = profile.workerReserveCoin + civilianCoinReserve;

  // A better player scouts the rival army and trains counters: the target
  // mix is reweighted toward what beats the enemy's dominant category (graded
  // by profile.counter). Fair read — only what this seat can see.
  const enemyDom = profile.counter > 0 ? dominantEnemyCategory(view.enemyArmyByKind) : null;

  // Allocate the final cap into exact per-kind slots. When all affordable
  // kinds have filled their quotas, WAIT for the missing premium resource or
  // trainer; never fill its reserved slots with another cheap archer.
  const target: Record<string, number> = {};
  for (const kind in mix) {
    let w = mix[kind] ?? 0;
    const def = UNITS[kind as UnitKind];
    if (enemyDom && !def?.heal && def?.model !== 'siege') {
      w *= counterMultiplier(kind, enemyDom.cat, profile.counter * enemyDom.frac);
    }
    if (w > 0) target[kind] = w;
  }
  const fullQuotas = allocateUnitQuotas(target, profile.armyCap);
  const projected: Record<string, number> = { ...queuedByKind };
  for (const unit of view.army) projected[unit.role] = (projected[unit.role] ?? 0) + 1;
  const projectedTotal = Object.values(projected).reduce((sum, count) => sum + count, 0);
  const availableKinds = new Set<string>();
  for (const building of trainers) for (const training of building.def.military!.units) {
    if ((target[training.kind] ?? 0) > 0) availableKinds.add(training.kind);
  }
  const availableFullSlots = [...availableKinds].reduce((sum, kind) => sum + (fullQuotas[kind] ?? 0), 0);
  // Before the Stable/Engineer/Monastery stand, reserved premium slots must
  // not leave the town defended by half an army. Reallocate only the first
  // wave floor over the trainers that exist; once that defensive core stands,
  // switch back to the exact final cap so every remaining slot is premium.
  const quotas = projectedTotal < profile.attackArmy && availableFullSlots < profile.attackArmy
    ? allocateUnitQuotas(Object.fromEntries([...availableKinds].map(kind => [kind, target[kind]])), profile.attackArmy)
    : fullQuotas;
  let priests = 0;
  for (const kind in projected) {
    const def = UNITS[kind as UnitKind];
    if (def?.heal) priests += projected[kind] ?? 0;
  }

  let best: { building: Building; kind: string } | null = null;
  let bestDeficit = -Infinity;
  for (const building of trainers) {
    for (const training of building.def.military!.units) {
      const kind = training.kind;
      const quota = quotas[kind] ?? 0;
      if (quota <= 0 || (projected[kind] ?? 0) >= quota) continue;
      const cost = game.modsFor(view.owner).unitCost(kind, training.cost) as Record<string, number>;
      const def = UNITS[kind as UnitKind];
      // CONSTRUCTION MATERIALS COME FIRST. A reserve here used to be justified
      // as holding the ten timber a siege engine costs, and it vanished when the
      // engines did — but measurement says that was never the work it did. Its
      // real effect was to throttle cheap-fighter training so timber kept
      // reaching BUILDINGS. Deleting it alongside the siege cost Godlike most of
      // its base by minute 18: one woodcutter instead of two, no stable, no
      // monastery, two stone towers instead of five, no mounted arm at all, and
      // 68.8% down to 59.4% against Hard. So the rule stays — honestly named,
      // and keyed on how deep a persona means to expand rather than on engines
      // it no longer builds.
      const buildTimberReserve = profile.expansion >= 3 ? 10 : 0;
      let ok = true;
      for (const item in cost) {
        const reserve = item === 'coin' ? coinReserve : item === 'timber' ? buildTimberReserve : 0;
        if (storeStock(game, view.owner, item) < cost[item] + reserve) { ok = false; break; }
      }
      if (!ok) continue;
      // Normalized missing quota, plus tiny deterministic jitter for ties.
      const essential = def?.heal && priests < profile.minPriests ? 15 : 0;
      const deficit = essential + (quota - (projected[kind] ?? 0)) / quota + rng.next() * 0.002;
      if (deficit > bestDeficit) { bestDeficit = deficit; best = { building, kind }; }
    }
  }
  if (!best) return null;
  return { type: 'queueTraining', buildingId: best.building.id, unit: best.kind };
}

/**
 * Raise the profile's defensive tower on a paced schedule, independent of
 * whatever else the policy wants to build. One tower comes online after the
 * barracks; another perimeter sector unlocks every ninety seconds thereafter.
 *
 * Shared because defence should not depend on a policy remembering to ask for
 * it. Tensor v2 built towers only when its sampled bundle happened to contain
 * `defend:home`, and fielded three or four against Godlike's six while its army
 * was being ground down at home — the schedule is the mechanism that stops a
 * perimeter from being a matter of luck.
 */
export function planHomeTower(ctx: PolicyContext, blockedUntil: Map<BuildingKey, number>): GameCommand | null {
  const { view, profile } = ctx;
  if (profile.towers <= 0 || (view.built.barracks ?? 0) < 1
    || view.sites.length >= profile.maxPendingSites) return null;
  const home = { x: view.store!.x + 1, y: view.store!.y + 1 };
  const homeTowerCount = [...view.buildings, ...view.sites]
    .filter(entity => entity.key === profile.towerKey
      && Math.max(Math.abs(entity.x - home.x), Math.abs(entity.y - home.y)) <= 18)
    .length;
  const scheduled = Math.min(profile.towers, 1 + Math.floor(Math.max(0, view.elapsed - 360) / 90));
  return homeTowerCount < scheduled ? placeBuilding(ctx, profile.towerKey, blockedUntil) : null;
}
