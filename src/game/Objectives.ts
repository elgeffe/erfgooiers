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
  | { kind: 'collect'; n: number }
  | { kind: 'survive'; waves: number }
  | { kind: 'slay'; unit: UnitKind; n: number }
  | { kind: 'destroy'; n: number };

/**
 * Adapt a level's objective to the run's ascension tier.
 *  - From Very Hard (a ≥ 2), level 1 opens with a whole-economy multi goal —
 *    tuned production and a fed workforce, not a single hut.
 *  - From Absurd (a ≥ 3), economy quantities swell by half, honest to the name.
 *  Combat and collection goals stay untouched: their counts are bounded by
 *  what the map actually spawns.
 */
export function ascendObjective(def: ObjectiveDef, ascension: number, levelIndex: number): ObjectiveDef {
  if (levelIndex === 1 && ascension >= 2) {
    def = ascension >= 4
      ? { kind: 'produceMulti', reqs: [{ item: 'timber', n: 12 }, { item: 'bread', n: 8 }, { item: 'coin', n: 4 }] }
      : { kind: 'produceMulti', reqs: [{ item: 'timber', n: 10 }, { item: 'bread', n: 6 }] };
  }
  if (ascension < 3) return def;
  const swell = (n: number) => Math.ceil(n * 1.5);
  switch (def.kind) {
    case 'produce': return { ...def, n: swell(def.n) };
    case 'produceMulti': return { ...def, reqs: def.reqs.map(r => ({ ...r, n: swell(r.n) })) };
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
    if (d.kind === 'survive') return `Survive ${d.waves} raid wave${d.waves > 1 ? 's' : ''}`;
    if (d.kind === 'slay') return `Slay ${d.n} ${UNITS[d.unit].name.toLowerCase()}${d.n > 1 ? 's' : ''}`;
    if (d.kind === 'destroy') return `Destroy ${d.n} enemy ${d.n > 1 ? 'strongholds' : 'stronghold'}`;
    return `Collect ${d.n} gold piles`;
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
    // destroy
    const s = Math.min(d.n, this.structures);
    return { done: this.structures >= d.n, label: `Strongholds razed ${s}/${d.n}`, ratio: s / d.n };
  }
}
