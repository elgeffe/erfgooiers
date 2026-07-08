import { Rng, levelSeed } from '../engine/rng';
import { UPGRADES, upgradePrice, type UpgradeDef } from '../data/upgrades';
import type { RunState } from '../game/RunState';

const $ = (id: string) => document.getElementById(id)!;

/**
 * The between-levels shop. Rolls 5 purchasable wares + a 1-of-3 free draft,
 * deterministically per (run, level) so a reload lands on the same offer. Buying
 * mutates the run's gold and upgrade list; the next `startLevel` rebuilds the
 * Modifiers from those ids. Phase 1 offers the economy pool only.
 */
export class Shop {
  private run!: RunState;
  private rng!: Rng;
  private slots: UpgradeDef[] = [];
  private draft: UpgradeDef[] = [];
  private draftPicked = false;
  private draftChoice: UpgradeDef | null = null;
  private rerolls = 0;

  constructor(private readonly onContinue: () => void) {
    ($('btnShopContinue') as HTMLButtonElement).onclick = () => this.onContinue();
    ($('btnReroll') as HTMLButtonElement).onclick = () => this.reroll();
  }

  /** Show the shop for the run's just-cleared level. */
  open(run: RunState): void {
    this.run = run;
    this.rng = new Rng(levelSeed(run.runSeed, run.levelIndex) ^ 0x5f356495);
    this.rerolls = 0;
    this.slots = this.sample(5);
    this.draft = this.sample(3);
    this.draftPicked = false;
    this.draftChoice = null;
    this.render();
  }

  private pool(): UpgradeDef[] { return UPGRADES.filter(u => u.pool === 'economy'); }

  /** Sample n distinct upgrades from the pool using the deterministic stream. */
  private sample(n: number): UpgradeDef[] {
    const pool = this.pool().slice();
    const out: UpgradeDef[] = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(this.rng.int(pool.length), 1)[0]);
    }
    return out;
  }

  private rerollCost(): number { return 5 + this.rerolls * 4 + (this.run.levelIndex - 1) * 2; }

  private reroll(): void {
    const cost = this.rerollCost();
    if (this.run.gold < cost) return;
    this.run.gold -= cost;
    this.rerolls++;
    this.slots = this.sample(5);
    this.render();
  }

  private buy(def: UpgradeDef): void {
    const price = upgradePrice(def, this.run.levelIndex);
    if (this.run.gold < price) return;
    this.run.gold -= price;
    this.run.upgrades.push(def.id);
    // remove this ware from the current offer so it can't be double-bought
    this.slots = this.slots.filter(u => u !== def);
    this.render();
  }

  private pickDraft(def: UpgradeDef): void {
    if (this.draftPicked) return;
    this.run.upgrades.push(def.id);
    this.draftPicked = true;
    this.draftChoice = def;
    this.render();
  }

  private card(def: UpgradeDef, priceLabel: string, cls: string, onClick: () => void): HTMLElement {
    const el = document.createElement('div');
    el.className = 'scard' + (cls ? ' ' + cls : '');
    el.innerHTML = `<div class="sc-name">${def.name}</div><div class="sc-desc">${def.desc}</div><div class="sc-price ${cls}">${priceLabel}</div>`;
    if (!cls.includes('disabled') && !cls.includes('picked')) el.onclick = onClick;
    return el;
  }

  private render(): void {
    $('shopGold').innerHTML = `<b>${this.run.gold}</b> gold · next: level ${this.run.levelIndex + 1}`;
    ($('rerollCost') as HTMLElement).textContent = String(this.rerollCost());
    ($('btnReroll') as HTMLButtonElement).classList.toggle('disabled', this.run.gold < this.rerollCost());

    const slots = $('shopSlots'); slots.innerHTML = '';
    for (const def of this.slots) {
      const price = upgradePrice(def, this.run.levelIndex);
      const afford = this.run.gold >= price;
      slots.appendChild(this.card(def, `${price}g`, afford ? '' : 'cant disabled', () => this.buy(def)));
    }
    if (!this.slots.length) slots.innerHTML = '<div class="sc-desc">All wares bought.</div>';

    const draft = $('shopDraft'); draft.innerHTML = '';
    for (const def of this.draft) {
      const picked = this.draftChoice === def;
      const cls = this.draftPicked ? (picked ? 'picked' : 'disabled') : '';
      draft.appendChild(this.card(def, this.draftPicked ? (picked ? 'chosen ✓' : '—') : 'free', cls, () => this.pickDraft(def)));
    }
  }
}
