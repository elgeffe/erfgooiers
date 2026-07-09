import * as THREE from 'three';
import { DEFS } from '../data/buildings';
import type { Game } from '../game/Game';
import type { View } from '../render/View';
import type { UI } from '../ui/UI';
import type { Mode, Unit } from '../types';

// Isometric screen-space basis vectors for panning.
const RIGHT = new THREE.Vector3(1, 0, -1).normalize();
const FWD = new THREE.Vector3(-1, 0, -1).normalize();

/**
 * Camera + pointer/keyboard interaction: panning, zoom, placement mode, road
 * painting, demolishing and selection. Owns the current interaction `mode` and
 * the build rotation; drives the View's ghost/road cursor.
 */
export class Controls {
  private game: Game | null = null;
  private mode: Mode = null;
  private buildRot = 0;
  private ghostTile: { x: number; y: number } | null = null;

  private readonly keys: Record<string, boolean> = {};
  private dragging = false;
  private lastMouse: { x: number; y: number } | null = null;
  private roadPainting = false;
  private plotPainting = false;
  private demoDragging = false;

  // army selection (left-drag box; right-click orders; 1–5 recall control groups)
  private selUnits: Unit[] = [];
  private readonly ctrlGroups: Record<string, Unit[]> = {};
  private boxStart: { x: number; y: number } | null = null;
  private boxing = false;
  private readonly selbox = document.getElementById('selbox') as HTMLElement | null;

  constructor(private readonly view: View, private readonly ui: UI) {
    const canvas = this.view.renderer.domElement;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    addEventListener('pointermove', e => this.onMove(e));
    addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.view.zoom(e.deltaY > 0 ? 1.1 : 0.9); }, { passive: false });
    addEventListener('keydown', e => this.onKey(e));
    addEventListener('keyup', e => { this.keys[e.key.toLowerCase()] = false; });
  }

  /** Bind to a level's Game; clears any active build mode and stale squads. */
  setGame(game: Game): void {
    this.game = game;
    this.selUnits = [];
    for (const k in this.ctrlGroups) delete this.ctrlGroups[k];
    this.setMode(null);
  }

  setMode(m: Mode): void {
    this.mode = m;
    document.querySelectorAll<HTMLElement>('.bcard').forEach(e =>
      e.classList.toggle('on', !!m && ((m.type === 'road' && e.dataset.key === 'road') || (m.type === 'plot' && e.dataset.key === 'plot') || (m.type === 'demolish' && e.dataset.key === 'demolish') || (m.type === 'build' && e.dataset.key === m.key))));
    this.view.hideGhost();
    this.view.hideRoadCursor();
    if (m && m.type === 'road' && this.game) this.view.showEntranceMarkers(this.game.entranceTiles());
    else this.view.hideEntranceMarkers();
    const hint = document.getElementById('hint')!;
    const menu = document.getElementById('buildmenu')!;
    if (m) {
      hint.style.display = 'block';
      hint.style.bottom = (menu.getBoundingClientRect().height + 22) + 'px';
      hint.textContent = m.type === 'road' ? 'Click & drag to paint road — Esc to stop'
        : m.type === 'plot' ? `Click & drag to add plots for the ${m.building.name} — Esc to stop`
        : m.type === 'demolish' ? 'Click a building or site — drag over roads & plots to remove — Esc to stop'
          : `Click to place ${DEFS[m.key].name} — R to rotate · Esc to cancel`;
    } else hint.style.display = 'none';
  }

  private refreshGhost(tx: number, ty: number): void {
    if (!this.game || !this.mode || this.mode.type !== 'build') return;
    const key = this.mode.key;
    this.view.showGhost(DEFS[key], key, tx, ty, this.buildRot, this.game.canPlace(key, tx, ty, this.buildRot));
    this.ghostTile = { x: tx, y: ty };
  }

  // ---------- pointer ----------
  private onDown(e: PointerEvent): void {
    this.lastMouse = { x: e.clientX, y: e.clientY };
    // right-click cancels an active placement mode
    if (e.button === 2 && this.mode) { this.setMode(null); return; }
    // right-click with an army selected = issue an order (no camera pan)
    if (e.button === 2 && this.game && this.selUnits.length) { this.orderSelection(e); return; }
    // right-click with a barracks selected = plant its rally flag
    if (e.button === 2 && this.game && this.game.selected && this.game.selected.def?.military) {
      const rt = this.view.tileAt(e.clientX, e.clientY);
      if (rt) { this.game.setRally(this.game.selected, rt.x, rt.y); return; }
    }
    if (e.button === 2 || e.button === 1) { this.dragging = true; return; }
    if (e.button !== 0 || !this.game) return;
    const t = this.view.tileAt(e.clientX, e.clientY);
    if (!t) return;
    const m = this.mode;
    if (m && m.type === 'road') { this.roadPainting = true; this.game.paintRoad(t.x, t.y); return; }
    if (m && m.type === 'plot') { this.plotPainting = true; this.game.placePlot(t.x, t.y, m.building); return; }
    if (m && m.type === 'demolish') { this.demoDragging = true; this.game.demolishAt(t.x, t.y, false); return; }
    if (m && m.type === 'build') { this.game.tryPlace(m.key, t.x, t.y, this.buildRot); if (!this.keys['shift']) this.setMode(null); return; }
    // no mode: begin a potential selection box (resolved on pointerup)
    this.boxStart = { x: e.clientX, y: e.clientY };
    this.boxing = false;
  }

  private onMove(e: PointerEvent): void {
    if (this.dragging && this.lastMouse) {
      const dx = e.clientX - this.lastMouse.x, dy = e.clientY - this.lastMouse.y;
      const scale = this.view.viewSize * 2 / innerHeight;
      const v = RIGHT.clone().multiplyScalar(-dx * scale * 0.72).add(FWD.clone().multiplyScalar(dy * scale));
      this.view.pan(v);
    }
    // grow the selection box once the pointer moves past a small threshold
    if (this.boxStart) {
      const dx = e.clientX - this.boxStart.x, dy = e.clientY - this.boxStart.y;
      if (this.boxing || dx * dx + dy * dy > 36) { this.boxing = true; this.drawSelBox(e.clientX, e.clientY); }
    }
    this.lastMouse = { x: e.clientX, y: e.clientY };
    const m = this.mode;
    if (this.game && this.roadPainting) { const t = this.view.tileAt(e.clientX, e.clientY); if (t) this.game.paintRoad(t.x, t.y); }
    if (this.game && this.plotPainting && m && m.type === 'plot') { const t = this.view.tileAt(e.clientX, e.clientY); if (t) this.game.placePlot(t.x, t.y, m.building); }
    if (this.game && this.demoDragging) { const t = this.view.tileAt(e.clientX, e.clientY); if (t) this.game.demolishAt(t.x, t.y, true); }
    if (m && (m.type === 'road' || m.type === 'demolish' || m.type === 'plot')) { const t = this.view.tileAt(e.clientX, e.clientY); if (t) this.view.showRoadCursor(t.x, t.y, m.type); else this.view.hideRoadCursor(); }
    if (m && m.type === 'build') { const t = this.view.tileAt(e.clientX, e.clientY); if (t) this.refreshGhost(t.x, t.y); }
  }

  private onUp(e: PointerEvent): void {
    this.dragging = false; this.roadPainting = false; this.plotPainting = false; this.demoDragging = false;
    if (this.boxStart && this.game) {
      if (this.boxing) this.selectBox(this.boxStart.x, this.boxStart.y, e.clientX, e.clientY);
      else this.clickSelect(e);
    }
    this.boxStart = null; this.boxing = false;
    if (this.selbox) this.selbox.style.display = 'none';
  }

  /** A plain left-click with no drag: pick a single unit/building or clear. */
  private clickSelect(e: PointerEvent): void {
    if (!this.game) return;
    const t = this.view.tileAt(e.clientX, e.clientY);
    if (!t) return;
    const gp = this.view.groundPoint(e.clientX, e.clientY);
    const u = this.game.pickUnit(gp.x, gp.z);
    if (u) {
      this.game.select(u);
      this.selUnits = u.faction === 'player' && u.dmg > 0 ? [u] : [];
      return;
    }
    this.selUnits = [];
    this.game.selectAt(t.x, t.y);
  }

  /** Box-select every player fighter whose screen position falls in the rectangle. */
  private selectBox(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.game) return;
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const picked: Unit[] = [];
    for (const u of this.game.units) {
      if (u.faction !== 'player' || u.dmg <= 0) continue;
      const s = this.view.worldToScreen(u.mesh.position.x, u.mesh.position.y, u.mesh.position.z);
      if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) picked.push(u);
    }
    this.selUnits = picked;
    if (picked.length) this.ui.toast(`${picked.length} selected`);
  }

  /** Right-click order for the current selection: attack a hostile, else
   *  attack-move in formation (each unit gets its own nearby tile). */
  private orderSelection(e: PointerEvent): void {
    if (!this.game) return;
    const gp = this.view.groundPoint(e.clientX, e.clientY);
    const foe = this.game.pickUnit(gp.x, gp.z);
    const t = this.view.tileAt(e.clientX, e.clientY);
    if (foe && foe.faction !== 'player') {
      this.game.orderGroup(this.selUnits, 'attack', foe.tx, foe.ty, foe);
    } else if (t) {
      this.game.orderGroup(this.selUnits, 'attackMove', t.x, t.y);
    }
  }

  private drawSelBox(x: number, y: number): void {
    if (!this.selbox || !this.boxStart) return;
    const minX = Math.min(this.boxStart.x, x), minY = Math.min(this.boxStart.y, y);
    this.selbox.style.display = 'block';
    this.selbox.style.left = minX + 'px';
    this.selbox.style.top = minY + 'px';
    this.selbox.style.width = Math.abs(x - this.boxStart.x) + 'px';
    this.selbox.style.height = Math.abs(y - this.boxStart.y) + 'px';
  }

  // ---------- keyboard ----------
  private onKey(e: KeyboardEvent): void {
    this.keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape') { this.setMode(null); this.game?.select(null); }
    if ((e.key === 'r' || e.key === 'R') && this.mode && this.mode.type === 'build') {
      this.buildRot = (this.buildRot + 1) % 4;
      if (this.ghostTile) this.refreshGhost(this.ghostTile.x, this.ghostTile.y);
    }
    if (e.key === ' ') { e.preventDefault(); this.ui.togglePause(); }
    // control groups: Shift+1..5 assigns the current selection, 1..5 recalls it
    const dg = /^Digit([1-5])$/.exec(e.code);
    if (dg && this.game) {
      const slot = dg[1];
      if (e.shiftKey) {
        if (this.selUnits.length) { this.ctrlGroups[slot] = [...this.selUnits]; this.ui.toast(`Squad ${slot} assigned (${this.selUnits.length} fighters)`); }
      } else {
        const g = (this.ctrlGroups[slot] || []).filter(u => !u.dead && this.game!.units.indexOf(u) >= 0);
        this.ctrlGroups[slot] = g;
        if (g.length) {
          this.selUnits = [...g];
          // pressing the same squad key again centres the camera on it
          const p = g[0].mesh.position;
          if (this.lastGroupKey === slot) this.view.centerOn(p.x, p.z);
          this.lastGroupKey = slot;
        }
      }
    } else this.lastGroupKey = null;
  }
  private lastGroupKey: string | null = null;

  /** Per-frame keyboard camera panning (called from the game loop). */
  update(dt: number): void {
    const pan = dt * 14 * (this.view.viewSize / 13);
    let v: THREE.Vector3 | null = null;
    const add = (dir: THREE.Vector3, s: number) => { v = (v || new THREE.Vector3()).add(dir.clone().multiplyScalar(s)); };
    if (this.keys['w'] || this.keys['arrowup']) add(FWD, pan);
    if (this.keys['s'] || this.keys['arrowdown']) add(FWD, -pan);
    if (this.keys['a'] || this.keys['arrowleft']) add(RIGHT, -pan);
    if (this.keys['d'] || this.keys['arrowright']) add(RIGHT, pan);
    if (v) this.view.pan(v);

    // keep the selection live: drop any fighters that have died, then draw rings
    if (this.game && this.selUnits.length) {
      this.selUnits = this.selUnits.filter(u => !u.dead && this.game!.units.indexOf(u) >= 0);
    }
    this.view.showSelection(this.selUnits);
  }
}
