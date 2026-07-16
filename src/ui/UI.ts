import { DEFS, MENU_CATEGORIES } from '../data/buildings';
import { ITEMS, MARKET_VALUES, RES_SHOWN } from '../data/items';
import { UNITS, type UnitKind } from '../data/units';
import { ROAD_STONE_COST } from '../constants';
import { installFavicon, logoSVG } from './logo';
import { audio } from '../audio/Audio';
import { unitLabel } from '../game/util';
import { MAX_MARKET_ORDERS } from '../game/MarketSystem';
import { buildingIconSVG, goldCoinIconSVG, itemIconSVG } from './icons';
import { tradeLoadTime, tradePartner, tradeShipmentActive } from '../game/trade';
import type { Game } from '../game/Game';
import type { Building, BuildingDef, ItemKey, Mode } from '../types';

const $ = (id: string) => document.getElementById(id)!;

/** Format seconds as m:ss (clamped at zero). */
function fmtTime(s: number): string {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

/**
 * All DOM overlay: resource bar, objective, speed controls, build menu,
 * inspector, worker panel, toasts. Reads state from the current Game; pushes
 * build-mode changes out through the `onMode` callback (wired to Controls).
 *
 * The DOM is wired once in the constructor; `setGame()` rebinds it to each
 * level's fresh Game as levels are torn down and rebuilt.
 */
export class UI {
  onMode: (m: Mode) => void = () => {};
  onSandboxCard: (id: string) => boolean = () => false;
  onSandboxRemoveCard: (id: string) => boolean = () => false;
  onOpenCards: () => void = () => {};

  private game: Game | null = null;
  private readonly resEls: Record<string, HTMLElement> = {};
  private readonly resRowEls: Record<string, HTMLElement> = {};
  private unitsOpen = false;
  private unitTab = 'all';
  private lastTabsHTML = '';
  private tradeOpen = false;
  private pendingRequestId: string | null = null;
  private speedLocked = false;   // co-op runs at a fixed 1× — a local pause would desync
  private sandbox = false;
  // first-ascension onboarding: the buildings to construct for this level's
  // objective (empty when tutorials are off / on combat levels)
  private checklistKeys: string[] = [];

  constructor() {
    $('logo').innerHTML = logoSVG(30);
    ($('goldChip').querySelector('.coin') as HTMLElement).innerHTML = goldCoinIconSVG(15);
    installFavicon();
    this.observeTopbar();
    this.buildResbar();
    this.buildMenu();
    this.wireSpeed();
    this.wireUnitPanel();
    this.wirePerkPanel();
    this.wireInspector();
    this.wireTradePanel();
    this.setCoOp(false);
  }

  /** Publish the live top-bar height as `--topbar-h` so the side panels, wave
   *  banner and toasts sit just below it instead of a fixed offset — on small
   *  screens the resource bar wraps taller and used to hide behind them. */
  private observeTopbar(): void {
    const bar = $('topbar');
    const set = (): void => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
    set();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(set).observe(bar);
    addEventListener('resize', set);
  }

  /** Bind the HUD to a level's Game and reset transient UI state. */
  setGame(game: Game): void {
    this.game = game;
    // the biome decides what may be built: forbidden cards vanish for the level
    const banned = new Set<string>(game.disabledBuildings());
    document.querySelectorAll<HTMLElement>('.bcard[data-key]').forEach(el => {
      el.classList.toggle('bio-hidden', banned.has(el.dataset.key!));
    });
    // clear any prior level's onboarding locks/filters; main re-applies them
    // for a first-ascension level right after this call
    this.applyProgression(null, null);
    this.setChecklist([]);
    this.showCategory('materials');
    this.showInspector(null);
    this.updateWave(null);
    this.setSpeed(1);
    this.refreshResbar();
    this.refreshBuildCosts();
    this.renderUnits();
  }

  /** First-ascension onboarding: grey out the buildings not yet unlocked and
   *  surface only the resources those unlocked buildings involve, so a first
   *  time player meets the menu a handful of cards at a time. Pass nulls to
   *  clear — every harder tier and the sandbox show the whole menu and every
   *  resource. Called by main after {@link setGame}. */
  applyProgression(locked: string[] | null, resources: Set<string> | null): void {
    const lockedSet = new Set<string>(locked ?? []);
    document.querySelectorAll<HTMLElement>('.bcard[data-key]').forEach(el => {
      el.classList.toggle('locked', lockedSet.has(el.dataset.key!));
    });
    // clams only exist on coastal maps: where no clam digger can be raised, the
    // resource is meaningless, so hide it whatever the progression set says
    const banned = this.game ? new Set(this.game.disabledBuildings()) : new Set<string>();
    const noClams = banned.has('clamdigger');
    for (const k of RES_SHOWN) {
      const show = (!resources || resources.has(k)) && !(k === 'clam' && noClams);
      this.resRowEls[k].style.display = show ? '' : 'none';
    }
  }

  /** First-ascension onboarding: the ordered buildings to construct for this
   *  level's objective. Rendered as a ticking checklist under the objective and
   *  used to highlight the next card to place. Empty clears both. */
  setChecklist(keys: string[]): void {
    this.checklistKeys = keys;
    this.renderChecklist();
  }

  /** Move the "build this next" card highlight to the first building not yet
   *  placed. The full "Build these" list itself lives in the objective modal
   *  (see buildChecklistHTML), not in the HUD panel. Cheap; called each tick. */
  private renderChecklist(): void {
    const box = $('objChecklist');
    // the build list is shown in the objective modal now, never in the panel
    box.style.display = 'none'; box.innerHTML = '';
    // clear any previous suggestion highlight (cards and their tabs) first
    document.querySelectorAll<HTMLElement>('.bcard.suggest, .btab.suggest').forEach(el => el.classList.remove('suggest'));
    if (!this.game || !this.checklistKeys.length) { this.placeInspector(); return; }
    const g = this.game;
    const built = (key: string) => g.buildings.some(b => b.key === key);
    const placed = (key: string) => built(key) || g.sites.some(s => s.key === key);
    let nextKey: string | null = null;
    // the first not-yet-placed building is the one we nudge the player toward
    for (const key of this.checklistKeys) {
      if (!(key in DEFS)) continue;
      if (!placed(key)) { nextKey = key; break; }
    }
    if (nextKey) {
      const card = document.querySelector<HTMLElement>(`.bcard[data-key="${nextKey}"]`);
      if (card && !card.classList.contains('bio-hidden')) {
        card.classList.add('suggest');
        // guide the eye to the right tab too when the suggested card is on a
        // category that isn't the one currently shown
        const cat = card.dataset.cat;
        const tab = cat && document.querySelector<HTMLElement>(`.btab[data-cat="${cat}"]`);
        if (tab && !tab.classList.contains('on')) tab.classList.add('suggest');
      }
    }
    this.placeInspector();
  }

  /** The onboarding "Build these" list as checklist rows, for the objective
   *  modal. Empty when there's no checklist (higher ascensions, combat levels). */
  buildChecklistHTML(): string {
    if (!this.game || !this.checklistKeys.length) return '';
    const g = this.game;
    const built = (key: string) => g.buildings.some(b => b.key === key);
    const placed = (key: string) => built(key) || g.sites.some(s => s.key === key);
    let rows = '';
    for (const key of this.checklistKeys) {
      const def = DEFS[key as keyof typeof DEFS];
      if (!def) continue;
      const done = built(key);
      const state = done ? 'done' : placed(key) ? 'wip' : 'todo';
      const mark = done ? '✓' : placed(key) ? '…' : '○';
      rows += `<div class="ckrow ${state}"><span class="ckmark">${mark}</span><span class="ckicon">${buildingIconSVG(key as any, def)}</span><span class="cknm">${def.name}</span></div>`;
    }
    return `<div class="ck-head">Build these</div>${rows}`;
  }

  /** Update build-menu card costs to reflect the run's cost-reducing upgrades. */
  private refreshBuildCosts(): void {
    if (!this.game) return;
    // The build menu belongs to the local player, so preview costs through their
    // own rule set (in co-op that carries their hero's discounts/penalties).
    const mods = this.game.modsFor(this.game.localPlayerId);
    document.querySelectorAll<HTMLElement>('.bcard[data-key]').forEach(el => {
      const key = el.dataset.key!;
      if (!(key in DEFS)) return;
      const def = DEFS[key as keyof typeof DEFS];
      const costEl = el.querySelector('.cost');
      if (costEl) costEl.innerHTML = this.costHTML(mods.buildingCost(def));
      // production timers shift with speed upgrades too
      const timeEl = el.querySelector('.ptime');
      if (timeEl) timeEl.textContent = this.timeHTML(def);
    });
    // the road card's stone cost can be rule-bent to zero (corvée roads)
    const roadCost = document.querySelector<HTMLElement>('.bcard[data-key="road"] .cost');
    if (roadCost) {
      const rc = mods.roadCost();
      roadCost.innerHTML = (rc > 0 ? `<i>${itemIconSVG('stone', 11)}${rc}</i>` : '<i>free</i>') + ' · drag';
    }
  }

  /** Set the objective card text (driven by main until Phase 1's Objectives). */
  setObjective(text: string): void { $('objText').textContent = text; }

  /** Set the persistent level label shown above the objective progress. */
  setLevel(index: number, name: string): void { $('objLabel').textContent = `Level ${index} · ${name}`; }

  /** Per-tick objective card update: label, progress ratio (0..1), seconds left. */
  updateObjective(label: string, ratio: number, remaining: number): void {
    $('objText').textContent = label;
    ($('objBar') as HTMLElement).style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
    const t = $('timerChip');
    t.textContent = fmtTime(remaining);
    t.classList.toggle('low', remaining <= 30);
  }

  /** Show the run's gold total in the HUD chip. */
  setGold(n: number): void { $('goldText').textContent = String(n); }

  /** Show the level's active curses under the objective (hidden when none). */
  setMutators(muts: { icon: string; name: string; desc: string }[]): void {
    const el = $('objMutators');
    el.style.display = muts.length ? 'flex' : 'none';
    el.innerHTML = muts.map(m => `<span class="mutchip" title="${m.desc}">${m.icon} ${m.name}</span>`).join('');
  }

  /** Refresh the "next raid" countdown banner, or hide it when no wave is pending. */
  updateWave(info: { in: number; count: number; label?: string } | null): void {
    const el = $('wavebar') as HTMLElement;
    if (!info) { el.style.display = 'none'; this.placeToasts(); return; }
    el.style.display = 'flex';
    // muster-triggered raids show what will provoke them instead of a countdown
    $('waveText').textContent = info.label ?? `Next raid in ${fmtTime(info.in)} · ${info.count} raiders`;
    el.classList.toggle('imminent', !info.label && info.in <= 10);
    this.placeToasts();
  }

  /** Toast messages and the raid countdown share the top-centre of the screen;
   *  drop the toast column below the banner whenever it is showing so the two
   *  never overlay. */
  private placeToasts(): void {
    const wave = $('wavebar') as HTMLElement;
    const showing = wave.style.display !== 'none';
    ($('toasts') as HTMLElement).style.top = showing ? Math.round(wave.getBoundingClientRect().bottom + 8) + 'px' : '';
  }

  /** Toggle sandbox HUD: no objective card, no timer, no debug-win button. */
  setSandbox(on: boolean): void {
    this.sandbox = on;
    ($('objective') as HTMLElement).style.display = on ? 'none' : '';
    ($('timerChip') as HTMLElement).style.display = on ? 'none' : '';
    ($('btnDebugWin') as HTMLElement).style.display = on ? 'none' : '';
  }

  /** Toggle the co-op HUD: the Trade tab appears, the speed stays locked at 1×. */
  setCoOp(on: boolean): void {
    this.speedLocked = on;
    ($('btnTrade') as HTMLElement).style.display = on ? 'block' : 'none';
    ($('sp0') as HTMLElement).style.display = on ? 'none' : '';
    ($('sp3') as HTMLElement).style.display = on ? 'none' : '';
    if (!on) this.setTradeOpen(false);
  }

  // ---------- co-op trade tab ----------
  private wireTradePanel(): void {
    $('btnTrade').onclick = () => this.setTradeOpen(!this.tradeOpen);
    $('closeTrade').onclick = () => this.setTradeOpen(false);
    for (const id of ['tradeSendItem', 'tradeReqItem']) {
      ($(id) as HTMLSelectElement).innerHTML = RES_SHOWN.map(k => `<option value="${k}">${ITEMS[k].name}</option>`).join('');
    }
    $('btnTradeSend').onclick = () => this.submitTradeSend();
    $('btnTradeRequest').onclick = () => this.submitTradeRequest();
    // lists re-render each tick, so actions are delegated like the inspector's
    for (const id of ['tradeRequests', 'tradeShipments']) {
      $(id).addEventListener('pointerdown', e => {
        const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
        if (b) this.tradeAction(b.dataset.act!, b.dataset.id!);
      });
    }
  }

  private setTradeOpen(open: boolean): void {
    this.tradeOpen = open;
    ($('tradepanel') as HTMLElement).style.display = open ? 'block' : 'none';
    if (open) this.renderTrade();
    else { this.pendingRequestId = null; $('tradeSendNote').textContent = ''; }
  }

  /** The ally's main storehouse (deliveries land at their castle). */
  private allyStore(): Building | null {
    if (!this.game) return null;
    return this.game.stores(tradePartner(this.game.localPlayerId))[0] ?? null;
  }

  /** Your storehouse holding the most of the item — carts load there. */
  private ownStoreFor(item: string): Building | null {
    if (!this.game) return null;
    const stores = this.game.stores(this.game.localPlayerId);
    if (!stores.length) return null;
    return stores.reduce((a, b) => ((b.stock![item] || 0) > (a.stock![item] || 0) ? b : a));
  }

  private submitTradeSend(): void {
    if (!this.game) return;
    const item = ($('tradeSendItem') as HTMLSelectElement).value;
    const amount = Math.max(1, Math.min(999, parseInt(($('tradeSendAmt') as HTMLInputElement).value, 10) || 0));
    const source = this.ownStoreFor(item);
    const dest = this.allyStore();
    if (!source || !dest) { this.toast('Trade needs both castles standing', 'err'); return; }
    this.game.submitCommand({
      type: 'sendTrade', item: item as ItemKey, amount,
      sourceId: source.id, destinationId: dest.id,
      requestId: this.pendingRequestId ?? undefined,
    });
    this.pendingRequestId = null;
    $('tradeSendNote').textContent = '';
    audio.play('click');
  }

  private submitTradeRequest(): void {
    if (!this.game) return;
    const item = ($('tradeReqItem') as HTMLSelectElement).value;
    const amount = Math.max(1, Math.min(999, parseInt(($('tradeReqAmt') as HTMLInputElement).value, 10) || 0));
    const dest = this.game.stores(this.game.localPlayerId)[0];
    if (!dest) return;
    this.game.submitCommand({ type: 'requestTrade', item: item as ItemKey, amount, destinationId: dest.id });
    audio.play('click');
  }

  private tradeAction(act: string, id: string): void {
    if (!this.game) return;
    if (act === 'fulfill') {
      const r = this.game.tradeRequests.find(req => req.id === id && req.status === 'open');
      if (!r) return;
      ($('tradeSendItem') as HTMLSelectElement).value = r.item;
      ($('tradeSendAmt') as HTMLInputElement).value = String(r.amount);
      this.pendingRequestId = r.id;
      $('tradeSendNote').textContent = 'Fulfilling your ally’s request — adjust the amount, then press Send.';
      audio.play('click');
      return;
    }
    if (act === 'cancelReq') { this.game.submitCommand({ type: 'cancelTradeRequest', requestId: id }); return; }
    if (act === 'cancelShip') this.game.submitCommand({ type: 'cancelTradeShipment', shipmentId: id });
  }

  private renderTrade(): void {
    const g = this.game;
    if (!g || !this.tradeOpen) return;
    const local = g.localPlayerId;
    const open = g.tradeRequests.filter(r => r.status === 'open');
    $('tradeRequests').innerHTML = open.length ? open.map(r => {
      const mine = r.from === local;
      const who = mine ? 'You ask for' : 'Your ally asks for';
      const actions = mine
        ? `<button data-act="cancelReq" data-id="${r.id}">Cancel</button>`
        : `<button data-act="fulfill" data-id="${r.id}">Fulfill</button><button data-act="cancelReq" data-id="${r.id}">Decline</button>`;
      return `<div class="tr-line">${itemIconSVG(r.item, 13)}<div class="grow">${who} <b>${r.amount} ${ITEMS[r.item].name.toLowerCase()}</b></div>${actions}</div>`;
    }).join('') : '<div class="tr-empty">No open requests.</div>';

    const active = g.tradeShipments.filter(tradeShipmentActive);
    $('tradeShipments').innerHTML = active.length ? active.map(s => {
      const outgoing = s.from === local;
      const dir = outgoing ? '→ to your ally' : '← from your ally';
      const remaining = Math.max(0, Math.round(s.at + tradeLoadTime(s.amount) + s.eta - g.elapsed));
      const status = s.phase === 'loading' ? 'loading the cart'
        : s.phase === 'returning' ? 'recalled — heading home'
        : `on the road · ~${fmtTime(remaining)}`;
      const cancel = outgoing && s.phase !== 'returning'
        ? `<button data-act="cancelShip" data-id="${s.id}">${s.phase === 'loading' ? 'Cancel' : 'Recall'}</button>` : '';
      return `<div class="tr-line">${itemIconSVG(s.item, 13)}<div class="grow"><b>${s.amount} ${ITEMS[s.item].name.toLowerCase()}</b> ${dir}<small>${status}</small></div>${cancel}</div>`;
    }).join('') : '<div class="tr-empty">No carts on the road.</div>';

    $('tradeHistory').innerHTML = g.tradeHistory.length ? g.tradeHistory.slice(0, 8).map(h =>
      `<div class="tr-line"><div class="grow">${h.text}<small>${fmtTime(h.at)} · ${h.kind}</small></div></div>`,
    ).join('') : '<div class="tr-empty">Nothing traded yet.</div>';
  }

  /** Refresh modifier-derived HUD after a live sandbox card purchase. */
  refreshModifiers(): void { this.refreshBuildCosts(); }

  // ---------- resource bar & objective ----------
  private buildResbar(): void {
    const bar = $('resbar');
    for (const k of RES_SHOWN) {
      const el = document.createElement('div'); el.className = 'res';
      el.innerHTML = `${itemIconSVG(k, 15)}<b>0</b><span>${ITEMS[k].name}</span>`;
      bar.appendChild(el);
      this.resEls[k] = el.querySelector('b')!;
      this.resRowEls[k] = el;
    }
  }
  private refreshResbar(): void {
    if (!this.game) return;
    // the bar counts what's actually available in the main storehouse; the
    // tooltip breaks down where the rest of the world's supply is sitting
    for (const k of RES_SHOWN) {
      const d = this.game.itemBreakdown(k);
      this.resEls[k].textContent = String(d.store);
      this.resRowEls[k].title = `${ITEMS[k].name} — ${d.store} in the castle · ${d.buildings} in buildings · ${d.carried} being carried`;
    }
  }

  // ---------- build menu ----------
  private costHTML(cost: BuildingDef['cost']): string {
    let s = '';
    for (const k in cost) { if (!(cost as any)[k]) continue; s += `<i>${itemIconSVG(k as ItemKey, 10)}${(cost as any)[k]}</i>`; }
    return s || '<i>free</i>';
  }
  /** Seconds to produce/gather one item (mods-adjusted once a Game is bound). */
  private prodTime(def: BuildingDef): number | null {
    const mods = this.game ? this.game.modsFor(this.game.localPlayerId) : null;
    if (def.recipe) return mods ? mods.recipeTime(def) : def.recipe.time;
    if (def.gather && def.gather.out) return mods ? mods.gatherTime(def) : def.gather.time;
    return null;
  }
  private timeHTML(def: BuildingDef): string {
    const t = this.prodTime(def);
    return t == null ? '' : `⏱ ${Math.round(t * 10) / 10}s / item`;
  }
  private buildMenu(): void {
    const menu = $('buildmenu');
    menu.innerHTML = '';
    const tabs = document.createElement('div'); tabs.id = 'buildtabs';
    const row = document.createElement('div'); row.id = 'buildrow';
    menu.append(tabs, row);

    // one tab per goal; every category's cards live in the row but only the
    // active category's are shown (roads & demolish stay visible on every tab).
    for (const cat of MENU_CATEGORIES) {
      const tab = document.createElement('button'); tab.className = 'btab'; tab.dataset.cat = cat.id; tab.textContent = cat.name;
      tab.onclick = () => { audio.play('click'); this.showCategory(cat.id); };
      tabs.appendChild(tab);
      for (const key of cat.keys) {
        const def = DEFS[key];
        const el = document.createElement('div'); el.className = 'bcard'; el.dataset.key = key; el.dataset.cat = cat.id; el.title = def.desc;
        el.innerHTML = `<div class="icon">${buildingIconSVG(key, def)}</div><div class="nm">${def.name}</div><div class="cost">${this.costHTML(def.cost)}</div><div class="ptime">${this.timeHTML(def)}</div><div class="lockmark">🔒</div>`;
        el.onclick = () => {
          // buildings the first-ascension onboarding hasn't unlocked yet are inert
          if (el.classList.contains('locked')) { audio.play('error'); this.toast(`${def.name} unlocks on a later level`); return; }
          audio.play('click'); this.onMode(el.classList.contains('on') ? null : { type: 'build', key });
        };
        row.appendChild(el);
      }
      if (cat.stub) {
        const st = document.createElement('div'); st.className = 'bcard stub'; st.dataset.cat = cat.id; st.textContent = cat.stub;
        row.appendChild(st);
      }
    }

    const sep = document.createElement('div'); sep.className = 'bsep'; row.appendChild(sep);
    const road = document.createElement('div'); road.className = 'bcard'; road.dataset.key = 'road'; road.title = `Costs ${ROAD_STONE_COST} stone per tile · workers route along roads and walk 30% faster on them · demolishing a road refunds the stone`;
    road.innerHTML = `<div class="icon"><svg width="38" height="32" viewBox="0 0 38 32"><path d="M4 30C10 18 25 16 34 2" stroke="#5e4a35" stroke-width="10" fill="none" stroke-linecap="round"/><path d="M4 30C10 18 25 16 34 2" stroke="#c6ae83" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="3 2"/></svg></div><div class="nm">Road</div><div class="cost"><i>${itemIconSVG('stone', 10)}${ROAD_STONE_COST}</i> · drag</div><div class="ptime"></div>`;
    road.onclick = () => { audio.play('click'); this.onMode(road.classList.contains('on') ? null : { type: 'road' }); };
    row.appendChild(road);
    const dl = document.createElement('div'); dl.className = 'bcard'; dl.dataset.key = 'demolish'; dl.title = `Remove roads, sites and buildings \u00b7 demolishing a road refunds ${ROAD_STONE_COST} stone`;
    dl.innerHTML = '<div class="icon"><svg width="30" height="26" viewBox="0 0 30 26"><path d="M7 5 L23 21 M23 5 L7 21" stroke="#c96b4a" stroke-width="4" fill="none" stroke-linecap="round"/></svg></div><div class="nm">Demolish</div><div class="cost"><i>click / drag</i></div><div class="ptime"></div>';
    dl.onclick = () => { audio.play('click'); this.onMode(dl.classList.contains('on') ? null : { type: 'demolish' }); };
    row.appendChild(dl);

    this.showCategory(MENU_CATEGORIES[0].id);
  }

  /** Reveal one build-menu category's cards; roads & demolish always stay shown. */
  private showCategory(id: string): void {
    document.querySelectorAll<HTMLElement>('#buildtabs .btab').forEach(t => t.classList.toggle('on', t.dataset.cat === id));
    document.querySelectorAll<HTMLElement>('#buildrow .bcard[data-cat]').forEach(c => { c.style.display = c.dataset.cat === id ? '' : 'none'; });
  }

  // ---------- speed ----------
  private wireSpeed(): void {
    $('sp0').onclick = () => this.setSpeed(0);
    $('sp1').onclick = () => this.setSpeed(1);
    $('sp3').onclick = () => this.setSpeed(3);
  }
  setSpeed(s: number): void {
    if (this.speedLocked && s !== 1) return;
    if (this.game) this.game.simSpeed = s;
    $('sp0').classList.toggle('on', s === 0);
    $('sp1').classList.toggle('on', s === 1);
    $('sp3').classList.toggle('on', s === 3);
  }
  togglePause(): void { if (this.game && !this.speedLocked) this.setSpeed(this.game.simSpeed === 0 ? 1 : 0); }

  // ---------- inspector ----------
  private wireInspector(): void {
    $('closeInsp').onclick = () => this.game?.select(null);
    // Delegated on the stable #inspBody: the body's innerHTML is rebuilt every
    // tick, so a per-button onclick can be destroyed mid-click. pointerdown here
    // fires on press and survives re-renders.
    $('inspBody').addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      const o = this.game?.selected;
      if (t && t.closest('#plotBtn')) {
        if (o && o.def && o.def.fields) { audio.play('click'); this.onMode({ type: 'plot', building: o }); }
        return;
      }
      if (t && t.closest('#bellBtn')) {
        if (o && o.def && o.def.store) { this.game!.submitCommand({ type: 'setBell', active: !this.game!.bell }); this.renderInspector(); }
        return;
      }
      if (t && t.closest('#prioBtn')) {
        if (o && (o.isSite || (o.def && (o.def.recipe || o.def.gather)))) {
          this.game!.submitCommand({ type: 'setPriority', siteId: o.id, priority: !o.priority });
          this.renderInspector();
        }
        return;
      }
      const trainBtn = t && t.closest('[data-train]') as HTMLElement | null;
      if (trainBtn && o && o.def && (o.def.military || o.def.trainer)) {
        const times = e.shiftKey ? 5 : 1;
        for (let i = 0; i < times; i++) this.game!.submitCommand({ type: 'queueTraining', buildingId: o.id, unit: trainBtn.dataset.train! });
        this.renderInspector();
        return;
      }
      const cancelBtn = t && t.closest('[data-cancel]') as HTMLElement | null;
      if (cancelBtn && o && o.def && (o.def.military || o.def.trainer)) {
        this.game!.submitCommand({ type: 'cancelTraining', buildingId: o.id, index: parseInt(cancelBtn.dataset.cancel!, 10) });
        this.renderInspector();
      }
    });
    $('inspBody').addEventListener('change', e => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (!target.matches('[data-market-control]')) return;
      const b = this.game?.selected;
      if (!b || b.key !== 'market') return;
      const orders: { item: ItemKey; amount: number }[] = [];
      document.querySelectorAll<HTMLElement>('#inspBody .market-row').forEach(row => {
        const sel = row.querySelector('select') as HTMLSelectElement;
        const amt = row.querySelector('input') as HTMLInputElement;
        if (!sel || sel.value === '-') return;
        // A freshly picked resource leaves the units field at its 0 default;
        // configure() drops zero-amount orders, so seed a sensible quantity
        // whenever a good is assigned but no amount has been set yet.
        let amount = Number(amt.value);
        if (!(amount > 0)) { amount = 10; amt.value = '10'; }
        orders.push({ item: sel.value as ItemKey, amount });
      });
      this.game!.configureMarket(b, orders);
      audio.play('click');
      this.renderInspector();
    });
  }
  showInspector(obj: any): void {
    $('inspector').style.display = obj ? 'block' : 'none';
    if (obj) this.renderInspector();
  }
  private invRowsHTML(obj: Record<string, number>): string {
    let s = '';
    for (const k in obj) { if (!obj[k]) continue; s += `<div class="invrow">${itemIconSVG(k as ItemKey, 14)}${ITEMS[k as keyof typeof ITEMS].name}<b>${obj[k]}</b></div>`; }
    return s || '<div class="invrow" style="color:var(--ink-dim)">empty</div>';
  }
  /** Keep the inspector clear of the objective card above it: the card's
   *  height varies (long objective text, mutator chips) and a fixed top made
   *  the two panels touch. */
  private placeInspector(): void {
    const obj = $('objective');
    const visible = obj.style.display !== 'none' && obj.offsetParent !== null;
    $('inspector').style.top = visible ? Math.round(obj.getBoundingClientRect().bottom + 10) + 'px' : 'calc(var(--topbar-h, 52px) + 12px)';
  }
  private renderInspector(): void {
    const o = this.game?.selected; if (!o) return;
    this.placeInspector();
    // A selected unit has no building `def` — show its live stats instead.
    if (o.role !== undefined && !o.def) {
      $('inspName').textContent = o.roleName;
      const support = UNITS[o.role as UnitKind]?.heal;
      if (o.dmg > 0 || support) {
        $('inspSub').textContent = o.faction !== 'player'
          ? 'Hostile'
          : !this.game?.ownedByLocal(o)
            ? support ? 'Allied support' : 'Allied fighter'
            : support ? 'Support — automatically heals nearby allies' : 'Fighter — right-click to order, drag to box-select';
        const hp = Math.max(0, Math.round(o.hp)), ratio = Math.max(0, o.hp / o.maxHp);
        const hcol2 = ratio > 0.5 ? 'var(--good)' : ratio > 0.25 ? 'var(--accent)' : 'var(--bad)';
        let fb = '<div class="sect">Status</div><div class="invrow">' + o.status + '</div>';
        fb += `<div class="sect">Health</div><div class="invrow">HP<b>${hp} / ${o.maxHp}</b></div>`;
        fb += `<div class="bar"><div style="width:${Math.round(ratio * 100)}%;background:${hcol2}"></div></div>`;
        if (support) {
          fb += `<div class="sect">Healing</div><div class="invrow">Restores<b>${support.amount} HP</b></div>`;
          fb += `<div class="invrow">Radius<b>${support.range} tiles</b></div><div class="invrow">Prayer every<b>${support.rate}s</b></div>`;
        } else {
          fb += `<div class="sect">Combat</div><div class="invrow">Damage<b>${Math.round(o.dmg * 10) / 10}</b></div>`;
          fb += `<div class="invrow">${o.range > 1.6 ? 'Range' : 'Reach'}<b>${Math.round(o.range * 10) / 10} tiles</b></div>`;
          fb += `<div class="invrow">Attack every<b>${o.atkCd}s</b></div>`;
        }
        $('inspBody').innerHTML = fb;
        return;
      }
      $('inspSub').textContent = o.home ? 'Works at the ' + o.home.name : 'Free worker';
      const h = Math.round(o.hunger);
      const cond = o.hunger >= 66 ? 'Well fed · +12% speed' : o.hunger <= 25 ? 'Hungry · −25% speed' : 'Content';
      const hcol = o.hunger > 50 ? 'var(--good)' : o.hunger > 25 ? 'var(--accent)' : 'var(--bad)';
      let ub = '<div class="sect">Status</div><div class="invrow">' + o.status + '</div>';
      ub += `<div class="sect">Condition</div><div class="invrow">${cond}<b>${h}%</b></div>`;
      ub += `<div class="bar"><div style="width:${h}%;background:${hcol}"></div></div>`;
      if (o.carrying) ub += '<div class="sect">Carrying</div>' + `<div class="invrow">${itemIconSVG(o.carrying as ItemKey, 14)}${ITEMS[o.carrying as keyof typeof ITEMS].name}<b>1</b></div>`;
      $('inspBody').innerHTML = ub;
      return;
    }
    $('inspName').textContent = o.def.name + (o.isSite ? ' — site' : '');
    $('inspSub').textContent = o.def.desc || '';
    let body = '';
    if (o.isSite) {
      body += '<div class="sect">Materials needed</div>';
      for (const k in o.needs) body += `<div class="invrow">${itemIconSVG(k as ItemKey, 14)}${ITEMS[k as keyof typeof ITEMS].name}<b>${o.delivered[k] || 0} / ${o.needs[k]}</b></div>`;
      if (o.ready) body += `<div class="sect">Construction</div><div class="bar"><div style="width:${Math.round(o.progress * 100)}%"></div></div>`;
      else body += '<div class="hnote">Waiting for serfs to deliver materials…</div>';
      if (o.def.military) body += '<div class="hnote">Right-click the map to set the rally flag now; it will remain after construction.</div>';
      body += `<button class="inspbtn${o.priority ? ' on' : ''}" id="prioBtn">${o.priority ? '★ Prioritized — click to unset' : '☆ Prioritize construction'}</button>`;
    } else if (o.def.store) {
      if (o === this.game!.store) {
      const bell = this.game!.bell;
      body += `<button class="inspbtn${bell ? ' on' : ''}" id="bellBtn">\u{1F514} ${bell ? 'Bell tolling — send workers back out' : 'Ring the bell — shelter all workers'}</button>`;
      body += '<div class="hnote">Every non-combat worker runs inside the castle until the bell rings again. Hotkey: B</div>';
      }
      body += '<div class="sect">Stock</div>' + this.invRowsHTML(o.stock);
    } else {
      if (!o.active) body += o.def.worker ? '<div class="hnote">Waiting for a trained villager to staff it…</div>' : '<div class="hnote">Waiting for worker to arrive…</div>';
      if (o.key === 'market') {
        const orders: { item: ItemKey; amount: number }[] = o.marketOrders ?? [];
        const transit = this.game!.marketCaravansInTransit(o);
        const totalAmount = orders.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
        body += '<div class="sect">Export surplus — up to 3 goods</div>';
        // three assignable slots: each a resource picker (— clears it) + amount
        for (let i = 0; i < MAX_MARKET_ORDERS; i++) {
          const cur = orders[i];
          const options = `<option value="-">— none —</option>` + (Object.keys(MARKET_VALUES) as ItemKey[]).map(k =>
            `<option value="${k}"${cur && cur.item === k ? ' selected' : ''}>${ITEMS[k].name} · ${MARKET_VALUES[k]} coin</option>`).join('');
          body += `<div class="marketctl market-row"><label>Resource<select data-market-control>${options}</select></label>`;
          body += `<label>Units<input data-market-control type="number" min="0" max="50" step="1" value="${cur ? cur.amount : 0}"></label></div>`;
        }
        body += `<div class="invrow">Expected income<b>${this.game!.marketIncomePerMinute(o)} coin / min</b></div>`;
        body += `<div class="invrow">${transit ? 'Trader caravan' : totalAmount > 0 ? 'Next caravan' : 'Exports paused'}<b>${transit ? 'loading outside' : totalAmount > 0 ? `${Math.ceil(o.marketTimer ?? 60)}s` : 'assign a good'}</b></div>`;
        body += '<div class="sect">Waiting at market</div>' + this.invRowsHTML(o.inp);
        body += '<div class="hnote">Serfs carry assigned goods here; a trader halts outside, loads up and pays the coin straight into your global stock. Caravans are neutral and cannot be attacked.</div>';
      }
      if (o.def.recipe) {
        body += `<div class="sect">Production</div><div class="bar"><div style="width:${Math.round(o.prog * 100)}%"></div></div>`;
        body += '<div class="sect">Inputs</div>' + this.invRowsHTML(o.inp);
        body += o.def.recipe.globalOutput
          ? `<div class="sect">Output</div><div class="hnote">${ITEMS[o.def.recipe.out as ItemKey].name} enters global stock immediately — no serf pickup required.</div>`
          : '<div class="sect">Output ready for pickup</div>' + this.invRowsHTML(o.out);
        body += `<button class="inspbtn${o.priority ? ' on' : ''}" id="prioBtn">${o.priority ? '★ Prioritized — click to unset' : '☆ Prioritize'}</button>`;
      } else if (o.def.gather) {
        body += '<div class="sect">Output ready for pickup</div>' + this.invRowsHTML(o.out);
        body += `<button class="inspbtn${o.priority ? ' on' : ''}" id="prioBtn">${o.priority ? '★ Prioritized — click to unset' : '☆ Prioritize'}</button>`;
      } else if (o.def.tavern) {
        const tv = o.def.tavern;
        body += `<div class="sect">Provisions (any food · serves up to ${tv.capacity} workers)</div>` + this.invRowsHTML(o.inp);
        const fed: any[] = o.fedUnits || [];
        body += `<div class="sect">Feeding now (${fed.length}/${tv.capacity})</div>`;
        if (fed.length) {
          for (const u of fed) body += `<div class="invrow"><div class="dot" style="background:#${u.colorHex.toString(16).padStart(6, '0')};border-radius:50%"></div>${u.roleName}<b style="font-weight:400;color:var(--ink-dim);font-size:11px">${u.status}</b></div>`;
        } else {
          body += '<div class="invrow" style="color:var(--ink-dim)">no one is dining right now</div>';
        }
      }
      if (o.def.fields) {
        const cap = o.def.plots ?? 8;
        body += `<div class="sect">Plots</div><div class="invrow">Plots in use<b>${o.fieldsList.length} / ${cap}</b></div>`;
        body += o.fieldsList.length < cap
          ? '<button id="plotBtn" class="inspbtn">+ Place plots</button>'
          : '<div class="hnote">Plot limit reached.</div>';
      }
      if (o.worker) body += `<div class="sect">Worker</div><div class="invrow"><div class="dot" style="background:#${o.def.wcolor.toString(16).padStart(6, '0')};border-radius:50%"></div>${o.worker.roleName}<b style="font-weight:400;color:var(--ink-dim);font-size:11px">${o.worker.status}</b></div>`;
      if (o.def.tower) {
        const tw = o.def.tower;
        body += '<div class="sect">Tower</div>';
        body += `<div class="invrow">Arrow damage<b>${tw.dmg}</b></div><div class="invrow">Range<b>${tw.range} tiles</b></div><div class="invrow">Fires every<b>${tw.rate}s</b></div>`;
      }
      if (o.def.military || o.def.trainer) {
        const mil = o.def.military || o.def.trainer;
        // Preview training cost/time through the building owner's rule set.
        const mods = this.game!.modsFor(o.owner);
        body += '<div class="sect">Train</div>';
        if (!o.active) body += '<div class="hnote">Building still being raised…</div>';
        else {
          for (const t of mil.units) {
            const dynamicCost = mods.unitCost(t.kind, t.cost);
            const cost = Object.entries(dynamicCost).map(([k, n]) =>
              `<i>${itemIconSVG(k as ItemKey, 13)}<span class="tcname">${ITEMS[k as ItemKey].name}</span> ${n}</i>`).join('')
              || '<i class="tcfree">free</i>';
            const dynamicTime = Math.round(t.time * mods.trainTime(t.kind));
            body += `<button class="inspbtn train" data-train="${t.kind}" title="${t.desc ? `${t.desc} — ` : ''}Shift+click queues 5">`
              + `<span class="trow"><span class="tname">+ ${unitLabel(t.kind)}</span><span class="ttime">${dynamicTime}s</span></span>`
              + `<span class="tcost">${cost}</span></button>`;
            if (t.desc) body += `<div class="tinfo">${t.desc}</div>`;
          }
          if (o.def.military) body += '<div class="hnote">Right-click the map with this building selected to set a rally flag.</div>';
          const q = o.trainQ || [];
          body += `<div class="sect">Training queue (${q.length})${q.length ? ' — click to cancel' : ''}</div>`;
          if (q.length) {
            body += `<div class="bar"><div style="width:${Math.round((o.prog || 0) * 100)}%"></div></div>`;
            body += '<div class="tqueue">';
            for (let i = 0; i < q.length; i++) {
              const name = unitLabel(q[i]);
              body += `<button class="tqchip${i === 0 ? ' active' : ''}" data-cancel="${i}" title="Cancel this order"><span>${i + 1}. ${name}</span> ✕</button>`;
            }
            body += '</div>';
          } else body += '<div class="invrow" style="color:var(--ink-dim)">empty — queue units with the buttons above</div>';
        }
      }
    }
    $('inspBody').innerHTML = body;
  }

  // ---------- worker panel ----------
  private wireUnitPanel(): void {
    const toggle = $('unitsToggle'), panel = $('unitpanel');
    toggle.onclick = () => { this.unitsOpen = !this.unitsOpen; panel.style.display = this.unitsOpen ? 'block' : 'none'; toggle.style.display = this.unitsOpen ? 'none' : ''; this.renderUnits(); };
    document.addEventListener('keydown', e => { if (e.key === 'u') toggle.click(); });
    const h3 = $('unitTitle');
    h3.style.cursor = 'pointer'; h3.title = 'Click to collapse';
    h3.onclick = () => { this.unitsOpen = false; panel.style.display = 'none'; toggle.style.display = ''; };
    $('unitTabs').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('.utab') as HTMLElement | null;
      if (b) { this.unitTab = b.dataset.tab!; this.renderUnits(); }
    });
  }

  /** Which worker-panel tab a unit's role belongs to. */
  private unitCat(role: string): 'serf' | 'villager' | 'laborer' | 'military' | 'specialist' {
    if (role === 'serf') return 'serf';
    if (role === 'villager') return 'villager';
    if (role === 'laborer') return 'laborer';
    if (role in UNITS) return 'military';
    return 'specialist';
  }

  /** Always show the three labour-pool KPIs on the (collapsed) Workers button so
   *  their health is visible at a glance, and pulse it when one runs short. */
  private setWorkerWarning(shortage: boolean, metrics: ReturnType<Game['workerMetrics']>): void {
    const toggle = $('unitsToggle');
    toggle.classList.toggle('warn', shortage);
    const pools = [
      { k: 'villager', label: 'Villagers' },
      { k: 'serf', label: 'Serfs' },
      { k: 'builder', label: 'Builders' },
    ] as const;
    const chips = pools.map(({ k, label }) => {
      const m = metrics[k];
      // villagers count "spare" workers ready to post; when buildings sit unstaffed
      // show the shortfall as a negative pill so the deficit reads at a glance
      const n = k === 'villager' && m.deficit > 0 ? -m.deficit : m.count;
      const tip = k === 'villager' ? `Villagers ready to work · ${m.note}` : `${label}: ${m.note}`;
      return `<span class="utab${m.status === 'bad' ? ' short' : ''}" title="${tip}"><span class="ulbl">${label}</span><b>${n}</b><i class="kpi ${m.status}"></i></span>`;
    }).join('');
    const total = this.game ? this.game.units.filter(u => !u.dead && u.faction === 'player').length : 0;
    toggle.innerHTML = `<h3 class="serif wtitle">${shortage ? '' : ''}Workers · ${total}</h3><div class="wkpis">${chips}</div>`;
    const bad = pools.filter(p => metrics[p.k].status === 'bad');
    toggle.title = bad.length ? 'Short-handed — ' + bad.map(p => `${p.label}: ${metrics[p.k].note}`).join(' · ') : 'Open the worker roster (U)';
  }

  /** Keep the Workers-button shortage badge live even while the panel is closed. */
  private updateWorkerWarning(): void {
    if (!this.game) return;
    const metrics = this.game.workerMetrics();
    const shortage = (['serf', 'villager', 'builder'] as const).some(k => metrics[k].status === 'bad');
    this.setWorkerWarning(shortage, metrics);
  }

  private renderUnits(): void {
    if (!this.unitsOpen || !this.game) { this.updateWorkerWarning(); return; }
    const players = this.game.units.filter(u => u.faction === 'player' && this.game!.ownedByLocal(u));
    const counts: Record<string, number> = { all: players.length, serf: 0, villager: 0, laborer: 0, specialist: 0, military: 0 };
    for (const u of players) counts[this.unitCat(u.role)]++;
    // Live logistics KPIs: which of the labour pools is short-handed.
    const metrics = this.game.workerMetrics();
    const metricFor = (id: string) => id === 'serf' ? metrics.serf : id === 'laborer' ? metrics.builder : id === 'villager' ? metrics.villager : null;
    const shortage = (['serf', 'villager', 'builder'] as const).some(k => metrics[k].status === 'bad');
    $('unitTitle').textContent = `Workers · ${players.length}`;
    this.setWorkerWarning(shortage, metrics);
    const tabsDef: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'villager', label: 'Villagers' },
      { id: 'serf', label: 'Serfs' },
      { id: 'laborer', label: 'Builders' },
      { id: 'specialist', label: 'Trades' },
      { id: 'military', label: 'Army' },
    ];
    // fall back to All if the active tab emptied out
    if (this.unitTab !== 'all' && counts[this.unitTab] === 0) this.unitTab = 'all';
    let tabs = '';
    for (const c of tabsDef) {
      // the Villagers pill always shows so its deficit stays visible even at zero spare
      if (c.id !== 'all' && c.id !== 'villager' && counts[c.id] === 0 && this.unitTab !== c.id) continue;
      const m = metricFor(c.id);
      // villagers show a negative count when buildings sit unstaffed (workers short)
      const n = c.id === 'villager' && m && m.deficit > 0 ? -m.deficit : counts[c.id];
      const tip = c.id === 'villager' ? `Ready to work — ${m!.note}` : m ? m.note : '';
      // a small traffic-light dot + hover note flags an under-supplied pool
      const kpi = m ? ` <i class="kpi ${m.status}" title="${m.note}"></i>` : '';
      tabs += `<button class="utab${this.unitTab === c.id ? ' on' : ''}${m && m.status === 'bad' ? ' short' : ''}" data-tab="${c.id}"${tip ? ` title="${tip}"` : ''}>${c.label} <b>${n}</b>${kpi}</button>`;
    }
    if (tabs !== this.lastTabsHTML) { $('unitTabs').innerHTML = tabs; this.lastTabsHTML = tabs; }

    const shown = this.unitTab === 'all' ? players : players.filter(u => this.unitCat(u.role) === this.unitTab);
    let s = '';
    for (const u of shown) {
      const hcol = u.hunger > 50 ? 'var(--good)' : u.hunger > 25 ? 'var(--accent)' : 'var(--bad)';
      s += `<div class="urow"><div class="dot" style="background:#${u.colorHex.toString(16).padStart(6, '0')}"></div><div class="info"><div class="rn">${u.roleName}</div><div class="st">${u.status}</div></div><div class="hbar" title="Hunger — feed workers at a Tavern to keep them fast"><div style="width:${Math.round(u.hunger)}%;background:${hcol}"></div></div></div>`;
    }
    $('unitlist').innerHTML = s || '<div class="urow" style="color:var(--ink-dim);justify-content:center">none of this kind</div>';
  }

  // ---------- heritage / power-up cards ----------
  // The top-bar Cards button opens the full Heritage & power-ups modal; the
  // modal itself is rendered by installSandboxTools (the single card UI).
  private wirePerkPanel(): void {
    $('btnPerks').addEventListener('click', () => this.onOpenCards());
  }

  /** Refresh the top-bar Cards button count from the run's cards and unlocks. */
  setPerks(upgrades: string[], unlocks: string[]): void {
    $('btnPerks').textContent = `🃏 Cards · ${upgrades.length + unlocks.length}`;
  }

  // ---------- toasts ----------
  toast(msg: string, cls?: string): void {
    this.placeToasts();
    const el = document.createElement('div'); el.className = 'toast' + (cls ? ' ' + cls : ''); el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 3200);
  }

  /** Periodic refresh from the game loop. */
  tick(): void {
    if (!this.game) return;
    this.refreshResbar();
    this.renderUnits();
    if (this.checklistKeys.length) this.renderChecklist();
    const focused = document.activeElement as HTMLElement | null;
    if (this.game.selected && !focused?.matches('[data-market-control]')) this.renderInspector();
    if (this.tradeOpen) this.renderTrade();
  }
}
