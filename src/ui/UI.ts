import { DEFS, MENU_CATEGORIES } from '../data/buildings';
import { ITEMS, RES_SHOWN } from '../data/items';
import { ROAD_STONE_COST } from '../constants';
import { installFavicon, logoSVG } from './logo';
import { audio } from '../audio/Audio';
import type { Game } from '../game/Game';
import type { BuildingDef, Mode } from '../types';

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

  private game: Game | null = null;
  private readonly resEls: Record<string, HTMLElement> = {};
  private unitsOpen = false;
  private unitTab = 'all';

  constructor() {
    $('logo').innerHTML = logoSVG(30);
    installFavicon();
    this.buildResbar();
    this.buildMenu();
    this.wireSpeed();
    this.wireUnitPanel();
    this.wireInspector();
  }

  /** Bind the HUD to a level's Game and reset transient UI state. */
  setGame(game: Game): void {
    this.game = game;
    this.showInspector(null);
    this.setSpeed(1);
    this.refreshResbar();
    this.refreshBuildCosts();
    this.renderUnits();
  }

  /** Update build-menu card costs to reflect the run's cost-reducing upgrades. */
  private refreshBuildCosts(): void {
    if (!this.game) return;
    const mods = this.game.mods;
    document.querySelectorAll<HTMLElement>('.bcard[data-key]').forEach(el => {
      const key = el.dataset.key!;
      if (!(key in DEFS)) return;
      const costEl = el.querySelector('.cost');
      if (costEl) costEl.innerHTML = this.costHTML(mods.buildingCost(DEFS[key as keyof typeof DEFS]));
    });
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

  /** Toggle sandbox HUD: no objective card, no timer, no debug-win button. */
  setSandbox(on: boolean): void {
    ($('objective') as HTMLElement).style.display = on ? 'none' : '';
    ($('timerChip') as HTMLElement).style.display = on ? 'none' : '';
    ($('btnDebugWin') as HTMLElement).style.display = on ? 'none' : '';
  }

  // ---------- resource bar & objective ----------
  private buildResbar(): void {
    const bar = $('resbar');
    for (const k of RES_SHOWN) {
      const el = document.createElement('div'); el.className = 'res';
      el.innerHTML = `<div class="dot" style="background:${ITEMS[k].color}"></div><b>0</b><span>${ITEMS[k].name}</span>`;
      bar.appendChild(el);
      this.resEls[k] = el.querySelector('b')!;
    }
  }
  private refreshResbar(): void {
    if (!this.game) return;
    for (const k of RES_SHOWN) this.resEls[k].textContent = String(this.game.countItem(k));
  }

  // ---------- build menu ----------
  private iconSVG(def: BuildingDef): string {
    const r = '#' + def.roof.toString(16).padStart(6, '0'), w = '#' + def.wall.toString(16).padStart(6, '0');
    return `<svg width="30" height="26" viewBox="0 0 30 26"><rect x="6" y="12" width="18" height="12" rx="1" fill="${w}"/><path d="M3 13 L15 3 L27 13 Z" fill="${r}"/></svg>`;
  }
  private costHTML(cost: BuildingDef['cost']): string {
    let s = '';
    for (const k in cost) { if (!(cost as any)[k]) continue; s += `<i><span class="dot" style="background:${ITEMS[k as keyof typeof ITEMS].color}"></span>${(cost as any)[k]}</i>`; }
    return s || '<i>free</i>';
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
        el.innerHTML = `<div class="icon">${this.iconSVG(def)}</div><div class="nm">${def.name}</div><div class="cost">${this.costHTML(def.cost)}</div>`;
        el.onclick = () => { audio.play('click'); this.onMode(el.classList.contains('on') ? null : { type: 'build', key }); };
        row.appendChild(el);
      }
      if (cat.stub) {
        const st = document.createElement('div'); st.className = 'bcard stub'; st.dataset.cat = cat.id; st.textContent = cat.stub;
        row.appendChild(st);
      }
    }

    const sep = document.createElement('div'); sep.className = 'bsep'; row.appendChild(sep);
    const road = document.createElement('div'); road.className = 'bcard'; road.dataset.key = 'road'; road.title = `Costs ${ROAD_STONE_COST} stone per tile · workers route along roads and walk 30% faster on them · demolishing a road refunds the stone`;
    road.innerHTML = `<div class="icon"><svg width="30" height="26" viewBox="0 0 30 26"><path d="M4 24 C10 14 20 12 26 2" stroke="#b9a179" stroke-width="6" fill="none" stroke-linecap="round"/></svg></div><div class="nm">Road</div><div class="cost"><i><span class="dot" style="background:${ITEMS.stone.color}"></span>${ROAD_STONE_COST}</i> · drag</div>`;
    road.onclick = () => { audio.play('click'); this.onMode(road.classList.contains('on') ? null : { type: 'road' }); };
    row.appendChild(road);
    const dl = document.createElement('div'); dl.className = 'bcard'; dl.dataset.key = 'demolish'; dl.title = `Remove roads, sites and buildings \u00b7 demolishing a road refunds ${ROAD_STONE_COST} stone`;
    dl.innerHTML = '<div class="icon"><svg width="30" height="26" viewBox="0 0 30 26"><path d="M7 5 L23 21 M23 5 L7 21" stroke="#c96b4a" stroke-width="4" fill="none" stroke-linecap="round"/></svg></div><div class="nm">Demolish</div><div class="cost"><i>click / drag</i></div>';
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
    if (this.game) this.game.simSpeed = s;
    $('sp0').classList.toggle('on', s === 0);
    $('sp1').classList.toggle('on', s === 1);
    $('sp3').classList.toggle('on', s === 3);
  }
  togglePause(): void { if (this.game) this.setSpeed(this.game.simSpeed === 0 ? 1 : 0); }

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
      const trainBtn = t && t.closest('[data-train]') as HTMLElement | null;
      if (trainBtn && o && o.def && (o.def.military || o.def.trainer)) {
        this.game!.trainUnit(o, trainBtn.dataset.train!);
        this.renderInspector();
      }
    });
  }
  showInspector(obj: any): void {
    $('inspector').style.display = obj ? 'block' : 'none';
    if (obj) this.renderInspector();
  }
  private invRowsHTML(obj: Record<string, number>): string {
    let s = '';
    for (const k in obj) { if (!obj[k]) continue; s += `<div class="invrow"><div class="dot" style="background:${ITEMS[k as keyof typeof ITEMS].color}"></div>${ITEMS[k as keyof typeof ITEMS].name}<b>${obj[k]}</b></div>`; }
    return s || '<div class="invrow" style="color:var(--ink-dim)">empty</div>';
  }
  private renderInspector(): void {
    const o = this.game?.selected; if (!o) return;
    // A selected unit has no building `def` — show its live stats instead.
    if (o.role !== undefined && !o.def) {
      $('inspName').textContent = o.roleName;
      $('inspSub').textContent = o.home ? 'Works at the ' + o.home.name : 'Free worker';
      const h = Math.round(o.hunger);
      const cond = o.hunger >= 66 ? 'Well fed · +12% speed' : o.hunger <= 25 ? 'Hungry · −25% speed' : 'Content';
      const hcol = o.hunger > 50 ? 'var(--good)' : o.hunger > 25 ? 'var(--accent)' : 'var(--bad)';
      let ub = '<div class="sect">Status</div><div class="invrow">' + o.status + '</div>';
      ub += `<div class="sect">Condition</div><div class="invrow">${cond}<b>${h}%</b></div>`;
      ub += `<div class="bar"><div style="width:${h}%;background:${hcol}"></div></div>`;
      if (o.carrying) ub += '<div class="sect">Carrying</div>' + `<div class="invrow"><div class="dot" style="background:${ITEMS[o.carrying as keyof typeof ITEMS].color}"></div>${ITEMS[o.carrying as keyof typeof ITEMS].name}<b>1</b></div>`;
      $('inspBody').innerHTML = ub;
      return;
    }
    $('inspName').textContent = o.def.name + (o.isSite ? ' — site' : '');
    $('inspSub').textContent = o.def.desc || '';
    let body = '';
    if (o.isSite) {
      body += '<div class="sect">Materials needed</div>';
      for (const k in o.needs) body += `<div class="invrow"><div class="dot" style="background:${ITEMS[k as keyof typeof ITEMS].color}"></div>${ITEMS[k as keyof typeof ITEMS].name}<b>${o.delivered[k] || 0} / ${o.needs[k]}</b></div>`;
      if (o.ready) body += `<div class="sect">Construction</div><div class="bar"><div style="width:${Math.round(o.progress * 100)}%"></div></div>`;
      else body += '<div class="hnote">Waiting for serfs to deliver materials…</div>';
    } else if (o.def.store) {
      body += '<div class="sect">Stock</div>' + this.invRowsHTML(o.stock);
    } else {
      if (!o.active) body += o.def.worker ? '<div class="hnote">Waiting for a trained villager to staff it…</div>' : '<div class="hnote">Waiting for worker to arrive…</div>';
      if (o.def.recipe) {
        body += `<div class="sect">Production</div><div class="bar"><div style="width:${Math.round(o.prog * 100)}%"></div></div>`;
        body += '<div class="sect">Inputs</div>' + this.invRowsHTML(o.inp);
        body += '<div class="sect">Output ready for pickup</div>' + this.invRowsHTML(o.out);
      } else if (o.def.gather) {
        body += '<div class="sect">Output ready for pickup</div>' + this.invRowsHTML(o.out);
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
      if (o.def.military || o.def.trainer) {
        const mil = o.def.military || o.def.trainer;
        const costStr = Object.entries(mil.cost).map(([k, n]) => `${n} ${ITEMS[k as keyof typeof ITEMS].name.toLowerCase()}`).join(' + ') || 'free';
        body += `<div class="sect">Train (${costStr} each)</div>`;
        if (!o.active) body += '<div class="hnote">Building still being raised…</div>';
        else {
          for (const kind of mil.trains) body += `<button class="inspbtn" data-train="${kind}">+ ${kind[0].toUpperCase() + kind.slice(1)}</button>`;
          const q = o.trainQ || [];
          body += `<div class="sect">Training queue (${q.length})</div>`;
          if (q.length) { body += `<div class="bar"><div style="width:${Math.round((o.prog || 0) * 100)}%"></div></div>`; body += `<div class="invrow">${q.map((k: string) => k).join(', ')}</div>`; }
          else body += '<div class="invrow" style="color:var(--ink-dim)">idle</div>';
        }
      }
    }
    $('inspBody').innerHTML = body;
  }

  // ---------- worker panel ----------
  private wireUnitPanel(): void {
    const toggle = $('unitsToggle'), panel = $('unitpanel');
    toggle.onclick = () => { this.unitsOpen = !this.unitsOpen; panel.style.display = this.unitsOpen ? 'block' : 'none'; toggle.style.display = this.unitsOpen ? 'none' : 'block'; this.renderUnits(); };
    document.addEventListener('keydown', e => { if (e.key === 'u') toggle.click(); });
    const h3 = $('unitTitle');
    h3.style.cursor = 'pointer'; h3.title = 'Click to collapse';
    h3.onclick = () => { this.unitsOpen = false; panel.style.display = 'none'; toggle.style.display = 'block'; };
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
    if (role === 'soldier' || role === 'archer') return 'military';
    return 'specialist';
  }

  private renderUnits(): void {
    if (!this.unitsOpen || !this.game) return;
    const players = this.game.units.filter(u => u.faction === 'player');
    const counts: Record<string, number> = { all: players.length, serf: 0, villager: 0, laborer: 0, specialist: 0, military: 0 };
    for (const u of players) counts[this.unitCat(u.role)]++;
    $('unitTitle').textContent = `Workers · ${players.length}`;

    const tabsDef: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'serf', label: 'Serfs' },
      { id: 'laborer', label: 'Builders' },
      { id: 'villager', label: 'Idle' },
      { id: 'specialist', label: 'Trades' },
      { id: 'military', label: 'Army' },
    ];
    // fall back to All if the active tab emptied out
    if (this.unitTab !== 'all' && counts[this.unitTab] === 0) this.unitTab = 'all';
    let tabs = '';
    for (const c of tabsDef) {
      if (c.id !== 'all' && counts[c.id] === 0 && this.unitTab !== c.id) continue;
      tabs += `<button class="utab${this.unitTab === c.id ? ' on' : ''}" data-tab="${c.id}">${c.label} <b>${counts[c.id]}</b></button>`;
    }
    $('unitTabs').innerHTML = tabs;

    const shown = this.unitTab === 'all' ? players : players.filter(u => this.unitCat(u.role) === this.unitTab);
    let s = '';
    for (const u of shown) {
      const hcol = u.hunger > 50 ? 'var(--good)' : u.hunger > 25 ? 'var(--accent)' : 'var(--bad)';
      s += `<div class="urow"><div class="dot" style="background:#${u.colorHex.toString(16).padStart(6, '0')}"></div><div class="info"><div class="rn">${u.roleName}</div><div class="st">${u.status}</div></div><div class="hbar" title="Hunger — feed workers at a Tavern to keep them fast"><div style="width:${Math.round(u.hunger)}%;background:${hcol}"></div></div></div>`;
    }
    $('unitlist').innerHTML = s || '<div class="urow" style="color:var(--ink-dim);justify-content:center">none of this kind</div>';
  }

  // ---------- toasts ----------
  toast(msg: string, cls?: string): void {
    const el = document.createElement('div'); el.className = 'toast' + (cls ? ' ' + cls : ''); el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 3200);
  }

  /** Periodic refresh from the game loop. */
  tick(): void {
    if (!this.game) return;
    this.refreshResbar();
    this.renderUnits();
    if (this.game.selected) this.renderInspector();
  }
}
