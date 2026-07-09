import { Rng, levelSeed } from '../engine/rng';
import { MAX_CARDS, RARITY_WEIGHT, UPGRADES, UPGRADE_BY_ID, upgradePrice, type UpgradeDef } from '../data/upgrades';
import type { RunState } from '../game/RunState';

const $ = (id: string) => document.getElementById(id)!;

/** What a card sells back for (half its price at the current level, floored). */
export function sellPrice(def: UpgradeDef, levelIndex: number): number {
  return Math.max(1, Math.floor(upgradePrice(def, levelIndex) / 2));
}

/**
 * The between-levels shop. Rolls 3 purchasable wares — weighted by rarity and
 * excluding owned uniques — deterministically per (run, level, reroll) so a
 * reload lands on the same offer. A run holds at most MAX_CARDS cards; once
 * the slots are full, buying means selling one first, and the shop's owned
 * row is where that trade-off is made.
 */
export class Shop {
  private run!: RunState;
  private rng!: Rng;
  private slots: UpgradeDef[] = [];
  private rerolls = 0;
  private freeReroll = false;      // Heritage unlock: first reroll each visit is free
  private usedFreeReroll = false;

  constructor(private readonly onContinue: () => void) {
    ($('btnShopContinue') as HTMLButtonElement).onclick = () => this.onContinue();
    ($('btnReroll') as HTMLButtonElement).onclick = () => this.reroll();
  }

  /** Show the shop for the run's just-cleared level. */
  open(run: RunState, freeReroll = false): void {
    this.run = run;
    this.rng = new Rng(levelSeed(run.runSeed, run.levelIndex) ^ 0x5f356495);
    this.rerolls = 0;
    this.freeReroll = freeReroll;
    this.usedFreeReroll = false;
    this.slots = this.sample(3);
    this.render();
  }

  /** Economy wares always; military wares join once combat levels are next (5+).
   *  Owned uniques never show up again this run. */
  private pool(): UpgradeDef[] {
    return UPGRADES.filter(u =>
      (u.pool === 'economy' || (u.pool === 'military' && this.run.levelIndex >= 4)) &&
      !(u.unique && this.run.upgrades.includes(u.id)));
  }

  /** Sample n distinct upgrades, weighted by rarity, from the deterministic stream. */
  private sample(n: number): UpgradeDef[] {
    const pool = this.pool().slice();
    const out: UpgradeDef[] = [];
    while (out.length < n && pool.length) {
      let total = 0;
      for (const u of pool) total += RARITY_WEIGHT[u.rarity];
      let roll = this.rng.next() * total;
      let idx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        roll -= RARITY_WEIGHT[pool[i].rarity];
        if (roll < 0) { idx = i; break; }
      }
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }

  private rerollCost(): number {
    if (this.freeReroll && !this.usedFreeReroll) return 0;
    return 5 + this.rerolls * 4 + (this.run.levelIndex - 1) * 2;
  }

  private reroll(): void {
    const cost = this.rerollCost();
    if (this.run.gold < cost) return;
    if (cost === 0) this.usedFreeReroll = true;
    this.run.gold -= cost;
    this.rerolls++;
    this.slots = this.sample(3);
    this.render();
  }

  private buy(def: UpgradeDef): void {
    const price = upgradePrice(def, this.run.levelIndex);
    if (this.run.gold < price || this.run.upgrades.length >= MAX_CARDS) return;
    this.run.gold -= price;
    this.run.upgrades.push(def.id);
    // remove this ware from the current offer so it can't be double-bought
    this.slots = this.slots.filter(u => u !== def);
    this.render();
  }

  private sell(index: number): void {
    const id = this.run.upgrades[index];
    const def = UPGRADE_BY_ID[id];
    if (!def) return;
    this.run.upgrades.splice(index, 1);
    this.run.gold += sellPrice(def, this.run.levelIndex);
    this.render();
  }

  private card(def: UpgradeDef, priceLabel: string, cls: string, onClick: () => void): HTMLElement {
    const el = document.createElement('div');
    el.className = `scard rar-${def.rarity}` + (cls ? ' ' + cls : '');
    const tag = def.rarity !== 'common' ? `<span class="rtag rtag-${def.rarity}">${def.rarity}${def.unique ? ' · unique' : ''}</span>` : (def.unique ? '<span class="rtag">unique</span>' : '');
    el.innerHTML = `<div class="sc-icon">${def.icon}</div><div class="sc-body"><div class="sc-name">${def.name}${tag}</div><div class="sc-desc">${def.desc}</div><div class="sc-price ${cls}">${priceLabel}</div></div>`;
    if (!cls.includes('disabled') && !cls.includes('picked')) el.onclick = onClick;
    return el;
  }

  private render(): void {
    $('shopGold').innerHTML = `<b>${this.run.gold}</b> gold · next: level ${this.run.levelIndex + 1}`;
    ($('rerollCost') as HTMLElement).textContent = String(this.rerollCost());
    ($('btnReroll') as HTMLButtonElement).classList.toggle('disabled', this.run.gold < this.rerollCost());

    const full = this.run.upgrades.length >= MAX_CARDS;
    const slots = $('shopSlots'); slots.innerHTML = '';
    for (const def of this.slots) {
      const price = upgradePrice(def, this.run.levelIndex);
      const afford = this.run.gold >= price && !full;
      const label = full ? `${price}g — slots full` : `${price}g`;
      slots.appendChild(this.card(def, label, afford ? '' : 'cant disabled', () => this.buy(def)));
    }
    if (!this.slots.length) slots.innerHTML = '<div class="sc-desc">All wares bought.</div>';

    // owned cards — the run's 5 slots, each sellable for half price
    $('ownedLabel').textContent = `Your cards (${this.run.upgrades.length}/${MAX_CARDS})` +
      (full ? ' — full: sell a card to make room' : ' — click a card to sell it');
    const owned = $('shopOwned'); owned.innerHTML = '';
    this.run.upgrades.forEach((id, i) => {
      const def = UPGRADE_BY_ID[id];
      if (!def) return;
      owned.appendChild(this.card(def, `sell +${sellPrice(def, this.run.levelIndex)}g`, 'sellable', () => this.sell(i)));
    });
    if (!this.run.upgrades.length) owned.innerHTML = '<div class="sc-desc">No cards yet — every card you buy fills one of your five slots.</div>';
  }
}
