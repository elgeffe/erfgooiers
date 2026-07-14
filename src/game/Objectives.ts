import type { ItemKey } from '../types';
import { UNITS, type UnitKind } from '../data/units';
import type { Game } from './Game';

/**
 * Level goals as data. Evaluated each tick against the live Game; `produce` and
 * `collect` count events (production, gold-pile pickups) rather than net stock,
 * so consuming an item later doesn't undo progress. `stock` checks current
 * holdings and can require several goods at once. Combat goals (`survive`,
 * `slay`, `destroy`) count kills / cleared waves / razed enemy buildings.
 */
export interface StockReq { item: ItemKey; n: number; }

export type ObjectiveDef =
  | { kind: 'stock'; reqs: StockReq[] }
  | { kind: 'produce'; item: ItemKey; n: number }
  | { kind: 'produceMulti'; reqs: StockReq[] }
  /** Two goals in one level: hit the production targets AND train fighters —
   *  military drill before the combat arc begins. */
  | { kind: 'produceTrain'; reqs: StockReq[]; train: number }
  | { kind: 'collect'; n: number }
  | { kind: 'survive'; waves: number }
  | { kind: 'slay'; unit: UnitKind; n: number }
  /** Hunt several kinds at once (higher-difficulty hunts: wolves AND boars). */
  | { kind: 'slayMulti'; reqs: { unit: UnitKind; n: number }[] }
  | { kind: 'destroy'; n: number }
  /** Total war (top ascensions): raze every enemy stronghold, kill every
   *  hostile unit and outlast every raid still to come. */
  | { kind: 'clearAll' }
  /** PvP skirmish: the level ends when a player's storehouse falls. The card
   *  shows the goal; main resolves the winner off Game.eliminated. */
  | { kind: 'skirmish' };

/**
 * Adapt a level's objective to the run's ascension tier.
 *  - From Very Hard (a ≥ 2), level 1 opens with a whole-economy multi goal —
 *    tuned production and a fed workforce, not a single hut.
 *  - From Absurd (a ≥ 3), economy quantities swell by half, honest to the name.
 *  Combat and collection goals stay untouched: their counts are bounded by
 *  what the map actually spawns.
 */
/** Combat levels whose goal becomes total annihilation at the top tier. */
const CLEAR_ALL_LEVELS = new Set([5, 7, 8, 9]);

export function ascendObjective(def: ObjectiveDef, ascension: number, levelIndex: number): ObjectiveDef {
  // From Absurd (a ≥ 3) the Defend and assault levels stop asking for a fixed
  // tally and demand the whole map cleared — every stronghold, unit and raid.
  if (ascension >= 3 && CLEAR_ALL_LEVELS.has(levelIndex)) return { kind: 'clearAll' };
  if (levelIndex === 1 && ascension >= 2) {
    def = ascension >= 4
      ? { kind: 'produceMulti', reqs: [{ item: 'timber', n: 12 }, { item: 'bread', n: 8 }, { item: 'coin', n: 4 }] }
      : { kind: 'produceMulti', reqs: [{ item: 'timber', n: 10 }, { item: 'bread', n: 6 }] };
  }
  // the hunt hardens with the tier: from Hard the quarry is wolves AND boars,
  // with counts growing every tier (the map spawns matching packs — see main)
  if (def.kind === 'slay' && ascension >= 1 && (def.unit === 'boar' || def.unit === 'wolf')) {
    const n = def.n + 2 * (ascension - 1);
    def = { kind: 'slayMulti', reqs: [{ unit: 'boar', n }, { unit: 'wolf', n }] };
  }
  if (ascension < 3) return def;
  const swell = (n: number) => Math.ceil(n * 1.5);
  switch (def.kind) {
    case 'produce': return { ...def, n: swell(def.n) };
    case 'produceMulti': return { ...def, reqs: def.reqs.map(r => ({ ...r, n: swell(r.n) })) };
    case 'produceTrain': return { ...def, reqs: def.reqs.map(r => ({ ...r, n: swell(r.n) })), train: swell(def.train) };
    case 'stock': return { ...def, reqs: def.reqs.map(r => ({ ...r, n: swell(r.n) })) };
    default: return def;
  }
}

const ITEM_LABEL: Record<string, string> = {
  trunk: 'Trunk', timber: 'Timber', stone: 'Stone', wheat: 'Wheat', flour: 'Flour',
  bread: 'Bread', goldore: 'Gold ore', coal: 'Coal', coin: 'Coin',
  grape: 'Grapes', wine: 'Wine', meat: 'Meat', sausage: 'Sausage',
  fish: 'Fish', clam: 'Clams', iron: 'Iron', weapon: 'Weapons', armor: 'Armor',
};

export interface ObjectiveStatus { done: boolean; label: string; ratio: number; }

/** Live tracker for one level's objective. */
export class Objective {
  private readonly produced: Record<string, number> = {};   // production events per item
  private collected = 0;  // gold piles picked up (collect kind)
  private readonly kills: Record<string, number> = {};      // enemy/wild kills per unit kind
  private wavesCleared = 0;
  private structures = 0; // enemy buildings destroyed
  private trained = 0;    // fighters trained at the player's buildings
  private clearAllBase = 0; // clearAll: hostile units + strongholds present at first sight

  constructor(readonly def: ObjectiveDef) {}

  /** Fired by Game whenever a good is produced (recipe or gather). `n` lets
   *  rule-bender cards weight an item's objective credit (e.g. wine ×2). */
  onProduce(item: string, n = 1): void {
    this.produced[item] = (this.produced[item] || 0) + n;
  }

  /** Fired by Game whenever a gold pile is collected. */
  onCollect(): void {
    if (this.def.kind === 'collect') this.collected++;
  }

  /** Fired by Game whenever a fighter finishes training at a player building. */
  onTrain(): void { this.trained++; }

  /** Fired by Game when a unit dies (role = its unit kind, faction = its side). */
  onKill(role: string, faction: string): void {
    if (faction === 'player') return;
    this.kills[role] = (this.kills[role] || 0) + 1;
  }

  /** Fired by Game when a spawned raid wave is fully wiped out. */
  onWaveCleared(): void { this.wavesCleared++; }

  /** Fired by Game when a hostile building is razed. */
  onStructureDestroyed(faction: string): void { if (faction !== 'player') this.structures++; }

  /** One-line brief for the objective card. */
  brief(): string {
    const d = this.def;
    if (d.kind === 'stock') return 'Stock ' + d.reqs.map(r => `${r.n} ${ITEM_LABEL[r.item].toLowerCase()}`).join(' + ');
    if (d.kind === 'produce') return `Produce ${d.n} ${ITEM_LABEL[d.item].toLowerCase()}`;
    if (d.kind === 'produceMulti') return 'Produce ' + d.reqs.map(r => `${r.n} ${ITEM_LABEL[r.item].toLowerCase()}`).join(' + ');
    if (d.kind === 'produceTrain') return 'Produce ' + d.reqs.map(r => `${r.n} ${ITEM_LABEL[r.item].toLowerCase()}`).join(' + ') + ` · train ${d.train} fighters`;
    if (d.kind === 'survive') return `Survive ${d.waves} raid wave${d.waves > 1 ? 's' : ''}`;
    if (d.kind === 'slay') return `Slay ${d.n} ${UNITS[d.unit].name.toLowerCase()}${d.n > 1 ? 's' : ''}`;
    if (d.kind === 'slayMulti') return 'Slay ' + d.reqs.map(r => `${r.n} ${UNITS[r.unit].name.toLowerCase()}${r.n > 1 ? 's' : ''}`).join(' + ');
    if (d.kind === 'destroy') return `Destroy ${d.n} enemy ${d.n > 1 ? 'strongholds' : 'stronghold'}`;
    if (d.kind === 'clearAll') return 'Clear the map — every stronghold, every foe, every raid';
    if (d.kind === 'skirmish') return "Destroy your rival's storehouse before yours falls";
    return `Collect ${d.n} gold piles`;
  }

  /** Per-requirement breakdown for the objective card and the objective modal.
   *  Single-goal kinds return one line; multi-goal kinds one line each. Keeps
   *  the full list in the modal so the card can show only the next step. */
  steps(game: Game): { label: string; done: boolean }[] {
    const d = this.def;
    const one = (label: string, done: boolean) => [{ label, done }];
    switch (d.kind) {
      case 'stock':
        return d.reqs.map(r => { const c = Math.min(r.n, game.countItem(r.item)); return { label: `${ITEM_LABEL[r.item]} ${c}/${r.n}`, done: c >= r.n }; });
      case 'produce': {
        const made = this.produced[d.item] || 0; const c = Math.min(d.n, made);
        return one(`${ITEM_LABEL[d.item]} ${c}/${d.n}`, made >= d.n);
      }
      case 'produceMulti':
        return d.reqs.map(r => { const made = this.produced[r.item] || 0; const c = Math.min(r.n, made); return { label: `${ITEM_LABEL[r.item]} ${c}/${r.n}`, done: made >= r.n }; });
      case 'produceTrain': {
        const steps = d.reqs.map(r => { const made = this.produced[r.item] || 0; const c = Math.min(r.n, made); return { label: `${ITEM_LABEL[r.item]} ${c}/${r.n}`, done: made >= r.n }; });
        const tr = Math.min(d.train, this.trained);
        steps.push({ label: `Trained fighters ${tr}/${d.train}`, done: this.trained >= d.train });
        return steps;
      }
      case 'collect': { const c = Math.min(d.n, this.collected); return one(`Gold piles ${c}/${d.n}`, this.collected >= d.n); }
      case 'survive': { const w = Math.min(d.waves, this.wavesCleared); return one(`Waves survived ${w}/${d.waves}`, this.wavesCleared >= d.waves); }
      case 'slay': { const k = Math.min(d.n, this.kills[d.unit] || 0); return one(`${UNITS[d.unit].name} slain ${k}/${d.n}`, (this.kills[d.unit] || 0) >= d.n); }
      case 'slayMulti':
        return d.reqs.map(r => { const k = Math.min(r.n, this.kills[r.unit] || 0); return { label: `${UNITS[r.unit].name}s ${k}/${r.n}`, done: (this.kills[r.unit] || 0) >= r.n }; });
      case 'destroy': { const s = Math.min(d.n, this.structures); return one(`Strongholds razed ${s}/${d.n}`, this.structures >= d.n); }
      case 'skirmish':
        return one('The rival storehouse stands', game.eliminated.size > 0);
      case 'clearAll': {
        const foes = game.hostileUnitsLeft(), holds = game.enemyStructuresLeft(), pending = game.scheduledWavesPending();
        return [
          { label: `Foes remaining ${foes}`, done: foes === 0 },
          { label: `Strongholds ${holds}`, done: holds === 0 },
          { label: pending ? 'A raid still looms' : 'No raids pending', done: !pending },
        ];
      }
    }
  }

  /** The compact label for the objective card: the first unmet step, plus a
   *  "step i/n" counter when the goal has several parts. */
  nextStepLabel(game: Game): string {
    const steps = this.steps(game);
    if (steps.length <= 1) return steps[0]?.label ?? '';
    const next = steps.find(s => !s.done) ?? steps[steps.length - 1];
    const done = steps.filter(s => s.done).length;
    return `${next.label} · step ${Math.min(done + 1, steps.length)}/${steps.length}`;
  }

  evaluate(game: Game): ObjectiveStatus {
    const d = this.def;
    if (d.kind === 'stock') {
      let have = 0, need = 0, done = true;
      const parts: string[] = [];
      for (const r of d.reqs) {
        const c = Math.min(r.n, game.countItem(r.item));
        parts.push(`${ITEM_LABEL[r.item]} ${c}/${r.n}`);
        have += c; need += r.n;
        if (c < r.n) done = false;
      }
      return { done, label: parts.join(' · '), ratio: need ? have / need : 1 };
    }
    if (d.kind === 'produce') {
      const made = this.produced[d.item] || 0;
      const c = Math.min(d.n, made);
      return { done: made >= d.n, label: `${ITEM_LABEL[d.item]} ${c}/${d.n}`, ratio: c / d.n };
    }
    if (d.kind === 'produceMulti') {
      let have = 0, need = 0, done = true;
      const parts: string[] = [];
      for (const r of d.reqs) {
        const made = this.produced[r.item] || 0;
        const c = Math.min(r.n, made);
        parts.push(`${ITEM_LABEL[r.item]} ${c}/${r.n}`);
        have += c; need += r.n;
        if (made < r.n) done = false;
      }
      return { done, label: parts.join(' · '), ratio: need ? have / need : 1 };
    }
    if (d.kind === 'produceTrain') {
      let have = 0, need = 0, done = true;
      const parts: string[] = [];
      for (const r of d.reqs) {
        const made = this.produced[r.item] || 0;
        const c = Math.min(r.n, made);
        parts.push(`${ITEM_LABEL[r.item]} ${c}/${r.n}`);
        have += c; need += r.n;
        if (made < r.n) done = false;
      }
      const tr = Math.min(d.train, this.trained);
      parts.push(`Trained Military ${tr}/${d.train}`);
      have += tr; need += d.train;
      if (this.trained < d.train) done = false;
      return { done, label: parts.join(' · '), ratio: need ? have / need : 1 };
    }
    if (d.kind === 'collect') {
      const c = Math.min(d.n, this.collected);
      return { done: this.collected >= d.n, label: `Gold piles ${c}/${d.n}`, ratio: c / d.n };
    }
    if (d.kind === 'survive') {
      const w = Math.min(d.waves, this.wavesCleared);
      return { done: this.wavesCleared >= d.waves, label: `Waves survived ${w}/${d.waves}`, ratio: w / d.waves };
    }
    if (d.kind === 'slay') {
      const k = Math.min(d.n, this.kills[d.unit] || 0);
      return { done: (this.kills[d.unit] || 0) >= d.n, label: `${UNITS[d.unit].name} slain ${k}/${d.n}`, ratio: k / d.n };
    }
    if (d.kind === 'slayMulti') {
      let have = 0, need = 0, done = true;
      const parts: string[] = [];
      for (const r of d.reqs) {
        const k = Math.min(r.n, this.kills[r.unit] || 0);
        parts.push(`${UNITS[r.unit].name}s ${k}/${r.n}`);
        have += k; need += r.n;
        if ((this.kills[r.unit] || 0) < r.n) done = false;
      }
      return { done, label: parts.join(' · '), ratio: need ? have / need : 1 };
    }
    if (d.kind === 'skirmish') {
      const done = game.eliminated.size > 0;
      return { done, label: done ? 'A storehouse has fallen' : 'The rival storehouse stands', ratio: done ? 1 : 0 };
    }
    if (d.kind === 'clearAll') {
      const foes = game.hostileUnitsLeft();
      const holds = game.enemyStructuresLeft();
      const pending = game.scheduledWavesPending();
      // snapshot the starting host the first time we look, for a sensible bar
      if (this.clearAllBase === 0) this.clearAllBase = Math.max(1, foes + holds);
      const done = foes === 0 && holds === 0 && !pending;
      const label = `Foes ${foes} · Strongholds ${holds}` + (pending ? ' · a raid still looms' : '');
      const ratio = done ? 1 : Math.max(0, Math.min(0.95, 1 - (foes + holds) / this.clearAllBase));
      return { done, label, ratio };
    }
    // destroy
    const s = Math.min(d.n, this.structures);
    return { done: this.structures >= d.n, label: `Strongholds razed ${s}/${d.n}`, ratio: s / d.n };
  }
}
