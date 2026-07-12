import { Rng, levelSeed } from '../engine/rng';
import { MAX_CARDS, RARITY_WEIGHT, UPGRADES, UPGRADE_BY_ID, cardUnlocked, upgradePrice, type UpgradeDef } from '../data/upgrades';
import { MUTATOR_BY_ID, type Contract } from '../data/mutators';
import { HERO_BY_ID } from '../data/heroes';
import { BIOMES, campaignBiome } from '../data/biomes';
import { levelFor } from '../data/levels';
import { Objective } from '../game/Objectives';
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
  private contracts: Contract[] = [];
  private chosen: Contract | null = null;
  private slotCount = 3;           // wares per roll (ascension 1 trims it)
  private lifetime = { levelsCleared: 0, wins: 0 }; // gates the drip-fed cards

  constructor(private readonly onContinue: (contract: Contract) => void) {
    ($('btnShopContinue') as HTMLButtonElement).onclick = () => { if (this.chosen) this.onContinue(this.chosen); };
    ($('btnReroll') as HTMLButtonElement).onclick = () => this.reroll();
  }

  /** Show the shop for the run's just-cleared level, offering next-level contracts. */
  open(run: RunState, contracts: Contract[], freeReroll = false, tally: { label: string; gold: number }[] = [],
    opts: { slots?: number; lifetime?: { levelsCleared: number; wins: number } } = {}): void {
    this.run = run;
    this.rng = new Rng(levelSeed(run.runSeed, run.levelIndex) ^ 0x5f356495);
    this.rerolls = 0;
    this.freeReroll = freeReroll;
    this.usedFreeReroll = false;
    this.contracts = contracts;
    this.chosen = contracts.length === 1 ? contracts[0] : null;
    this.slotCount = opts.slots ?? 3;
    if (opts.lifetime) this.lifetime = opts.lifetime;
    this.slots = this.sample(this.slotCount);
    this.renderTally(tally);
    this.render();
  }

  /** The reckoning: an itemized tally of the cleared level's gold. */
  private renderTally(rows: { label: string; gold: number }[]): void {
    const el = $('shopTally');
    if (!rows.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const total = rows.reduce((s, r) => s + r.gold, 0);
    el.innerHTML =
      '<div class="shopsect">The reckoning</div>' +
      rows.map(r => `<div class="tallyrow"><span>${r.label}</span><b>+${r.gold}g</b></div>`).join('') +
      `<div class="tallyrow total"><span>Level total</span><b>+${Math.max(1, total)}g</b></div>`;
  }

  /** Economy wares always; military wares join once combat levels are next (5+);
   *  hero wares only while their hero leads the run. Owned uniques never show
   *  up again this run. */
  private pool(): UpgradeDef[] {
    return UPGRADES.filter(u =>
      (u.pool === 'economy' ||
       (u.pool === 'military' && this.run.levelIndex >= 4) ||
       (u.pool === 'hero' && u.hero === this.run.hero)) &&
      cardUnlocked(u, this.lifetime) &&
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
    this.slots = this.sample(this.slotCount);
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
    const hero = this.run.hero ? HERO_BY_ID[this.run.hero] : null;
    $('shopGold').innerHTML = `<b>${this.run.gold}</b> gold · next: level ${this.run.levelIndex + 1}` +
      (hero ? ` · led by ${hero.icon} ${hero.name}` : '');
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

    this.renderContracts();
  }

  /** The road ahead: pick how to take on the next level. */
  private renderContracts(): void {
    const nextIndex = this.run.levelIndex + 1;
    const level = levelFor(nextIndex);
    const grid = $('shopContracts'); grid.innerHTML = '';
    for (const c of this.contracts) {
      const el = document.createElement('div');
      el.className = `scard contract con-${c.kind}` + (this.chosen === c ? ' picked' : '');
      const brief = new Objective(level.objectives[c.objectiveIdx % level.objectives.length]).brief();
      const bio = BIOMES[campaignBiome(this.run.ascension, nextIndex)];
      const bioLine = bio.key !== 'gooi' ? `<br><i>${bio.name} — ${bio.desc}</i>` : '';
      const curses = c.mutators.map(id => {
        const m = MUTATOR_BY_ID[id];
        return m ? `<div class="mutrow"><span class="mutchip">${m.icon} ${m.name}</span><span class="mutdesc">${m.desc}</span></div>` : '';
      }).join('') || '<span class="mutchip calm">No curses</span>';
      el.innerHTML =
        `<div class="sc-body"><div class="sc-name">${c.kind === 'elite' ? '⚔️ ' : ''}${c.name}</div>` +
        `<div class="sc-desc">Level ${nextIndex} · ${level.name}<br>${brief}${bioLine}</div>` +
        `<div class="conchips">${curses}</div>` +
        `<div class="sc-price">${c.reward}g on clear</div></div>`;
      el.onclick = () => { this.chosen = c; this.render(); };
      grid.appendChild(el);
    }
    const btn = $('btnShopContinue') as HTMLButtonElement;
    btn.classList.toggle('disabled', !this.chosen);
    btn.textContent = this.chosen ? `Take the ${this.chosen.name} →` : 'Choose a contract above';
  }
}
