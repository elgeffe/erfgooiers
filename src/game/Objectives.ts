import type { ItemKey } from '../types';
import type { Game } from './Game';

/**
 * Level goals as data. Evaluated each tick against the live Game; `produce` and
 * `collect` count events (production, gold-pile pickups) rather than net stock,
 * so consuming an item later doesn't undo progress. `stock` checks current
 * holdings and can require several goods at once.
 */
export interface StockReq { item: ItemKey; n: number; }

export type ObjectiveDef =
  | { kind: 'stock'; reqs: StockReq[] }
  | { kind: 'produce'; item: ItemKey; n: number }
  | { kind: 'produceMulti'; reqs: StockReq[] }
  | { kind: 'collect'; n: number };

const ITEM_LABEL: Record<string, string> = {
  trunk: 'Trunk', timber: 'Timber', stone: 'Stone', wheat: 'Wheat', flour: 'Flour',
  bread: 'Bread', goldore: 'Gold ore', coal: 'Coal', coin: 'Coin',
  grape: 'Grapes', wine: 'Wine', meat: 'Meat', sausage: 'Sausage',
};

export interface ObjectiveStatus { done: boolean; label: string; ratio: number; }

/** Live tracker for one level's objective. */
export class Objective {
  private readonly produced: Record<string, number> = {};   // production events per item
  private collected = 0;  // gold piles picked up (collect kind)

  constructor(readonly def: ObjectiveDef) {}

  /** Fired by Game whenever a good is produced (recipe or gather). */
  onProduce(item: string): void {
    this.produced[item] = (this.produced[item] || 0) + 1;
  }

  /** Fired by Game whenever a gold pile is collected. */
  onCollect(): void {
    if (this.def.kind === 'collect') this.collected++;
  }

  /** One-line brief for the objective card. */
  brief(): string {
    const d = this.def;
    if (d.kind === 'stock') return 'Stock ' + d.reqs.map(r => `${r.n} ${ITEM_LABEL[r.item].toLowerCase()}`).join(' + ');
    if (d.kind === 'produce') return `Produce ${d.n} ${ITEM_LABEL[d.item].toLowerCase()}`;
    if (d.kind === 'produceMulti') return 'Produce ' + d.reqs.map(r => `${r.n} ${ITEM_LABEL[r.item].toLowerCase()}`).join(' + ');
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
    const c = Math.min(d.n, this.collected);
    return { done: this.collected >= d.n, label: `Gold piles ${c}/${d.n}`, ratio: c / d.n };
  }
}
