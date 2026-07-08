import * as THREE from 'three';
import { ROAD_STONE_COST } from '../constants';
import { DEFS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { simRng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import type { World } from '../world/World';
import type { View } from '../render/View';
import type { Building, BuildingKey, Coord, Site, Unit } from '../types';
import { doorTile } from './util';
import { Modifiers } from './Modifiers';
import type { Objective } from './Objectives';

// Gameplay events use the sim stream (reseeded per level), never worldgen/cosmetic.
const rnd = () => simRng.next();

/** The goods and workers a level hands you at the start (before run upgrades). */
export interface StartKit {
  stock: Partial<Record<string, number>>;
  serfs: number;
  laborers: number;
}

export const DEFAULT_KIT: StartKit = {
  stock: { timber: 16, stone: 10, bread: 8 },
  serfs: 6,
  laborers: 2,
};

/**
 * The simulation: buildings, construction sites, units and the serf logistics
 * dispatcher. Operates on the World (tiles) and asks the View for meshes. Emits
 * `toast` / `onSelect` callbacks that the UI wires up. No DOM, no Three.js scene
 * bookkeeping beyond requesting/removing meshes.
 */
export class Game {
  readonly buildings: Building[] = [];
  readonly sites: Site[] = [];
  readonly units: Unit[] = [];
  store!: Building;
  selected: any = null;
  simSpeed = 1;

  /** Sim seconds elapsed this level (drives the hard timer & speed bonus). */
  elapsed = 0;
  /** The level's objective tracker, or null (e.g. debug/sandbox). */
  objective: Objective | null = null;

  toast: (msg: string, cls?: string) => void = () => {};
  onSelect: (obj: any) => void = () => {};
  /** Called when gold is picked up off the map (already run through goldMult). */
  onGold: (amount: number) => void = () => {};
  /** Play a named sound effect (wired to the AudioEngine by main). */
  sfx: (name: string) => void = () => {};

  private readonly pickups: { x: number; y: number }[] = [];
  private dispatchT = 0;
  private fieldT = 0;
  private roadWarnT = 0;

  constructor(private readonly world: World, private readonly view: View, readonly mods: Modifiers = new Modifiers()) {}

  // =====================================================================
  //  Setup
  // =====================================================================
  init(kit: StartKit = DEFAULT_KIT): void {
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    // index the map's gold piles so serfs can be dispatched to collect them
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tiles[y][x].pickup) this.pickups.push({ x, y });
    // clear a build zone at the map centre for the starting settlement
    const cx = Math.floor(W / 2) - 1, cy = Math.floor(H / 2) - 1;
    for (let y = cy - 1; y < cy + 5; y++) for (let x = cx - 2; x < cx + 5; x++) {
      const t = this.world.T(x, y); if (!t) continue;
      if (t.tree) this.removeTree(x, y);
      if (t.dep) this.removeDep(x, y);
      if (t.deco) this.removeDeco(x, y);
      t.type = 'grass'; this.view.refreshTile(x, y);
    }
    this.store = this.placeBuilding('storehouse', cx, cy, true);
    // base kit stock, then run-upgrade start bonuses on top
    this.store.stock = { timber: 0, stone: 0, bread: 0, trunk: 0, wheat: 0, flour: 0, goldore: 0, coal: 0, coin: 0, grape: 0, wine: 0, meat: 0, sausage: 0, ...kit.stock };
    const bonus = this.mods.startStock();
    for (const k in bonus) this.store.stock[k] = (this.store.stock[k] || 0) + (bonus as Record<string, number>)[k];
    const d = doorTile(this.store);
    const serfs = kit.serfs + this.mods.extraSerfs();
    const laborers = kit.laborers + this.mods.extraLaborers();
    for (let i = 0; i < serfs; i++) this.spawnUnit('serf', 0xd8c49a, { x: d.x - 2 + (i % 4), y: d.y + Math.floor(i / 4) });
    for (let i = 0; i < laborers; i++) { const u = this.spawnUnit('laborer', 0xc97b3d, { x: d.x + 2 + (i % 3), y: d.y + Math.floor(i / 3) }); u.roleName = 'Laborer'; }
  }

  // =====================================================================
  //  Buildings / sites
  // =====================================================================
  placeBuilding(key: BuildingKey, tx: number, ty: number, instant = false, rot = 0): Building {
    const def = DEFS[key];
    const mesh = this.view.createBuildingMesh(def);
    mesh.rotation.y = -rot * Math.PI / 2;
    mesh.position.set(this.world.wx(tx) + 0.5, 0, this.world.wz(ty) + 0.5);
    this.view.add(mesh);
    const b: Building = {
      key, def, x: tx, y: ty, rot, active: false, inp: {}, out: {}, incoming: {},
      prog: 0, working: false, worker: null, fieldsList: [], mesh, name: def.name,
    };
    const tiles = this.world.tiles;
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) { tiles[y][x].b = b; if (tiles[y][x].tree) this.removeTree(x, y); if (tiles[y][x].deco) this.removeDeco(x, y); }
    this.buildings.push(b);
    if (def.fields) this.createFields(b);
    if (instant) b.active = true;
    return b;
  }

  private createFields(farm: Building): void {
    let n = 0;
    for (let r = 2; r <= 4 && n < 7; r++) {
      for (let y = farm.y - r; y <= farm.y + 1 + r && n < 7; y++) for (let x = farm.x - r; x <= farm.x + 1 + r && n < 7; x++) {
        if (x >= farm.x - 1 && x <= farm.x + 2 && y >= farm.y - 1 && y <= farm.y + 2) continue;
        const t = this.world.T(x, y);
        if (t && t.type === 'grass' && !t.b && !t.site && !t.tree && !t.dep && !t.road && !t.field) {
          if (t.deco) this.removeDeco(x, y);
          t.field = { farm, growth: rnd() * 0.5, meshes: [] }; farm.fieldsList.push({ x, y }); this.view.refreshTile(x, y); this.view.addFieldCrop(x, y, t.field); n++;
        }
      }
    }
  }

  removeTree(x: number, y: number): void { const t = this.world.tiles[y][x]; if (t.tree) { this.view.removeMeshes(t.tree.meshes); t.tree = null; } }
  removeDep(x: number, y: number): void { const t = this.world.tiles[y][x]; if (t.dep) { this.view.removeMeshes(t.dep.meshes); t.dep = null; } }
  removeDeco(x: number, y: number): void { const t = this.world.tiles[y][x]; if (t.deco) { this.view.removeMeshes(t.deco.meshes); t.deco = null; } }

  placeSite(key: BuildingKey, tx: number, ty: number, rot = 0): Site {
    const def = DEFS[key];
    const { group, frame } = this.view.createScaffold(def);
    frame.rotation.y = -rot * Math.PI / 2;
    group.position.set(this.world.wx(tx) + 0.5, 0, this.world.wz(ty) + 0.5);
    this.view.add(group);
    const s: Site = {
      key, def, x: tx, y: ty, rot, needs: this.mods.buildingCost(def) as Record<string, number>, delivered: {}, incoming: {},
      progress: 0, ready: false, builder: null, mesh: group, frame, isSite: true, name: def.name + ' (site)',
    };
    for (const k in s.needs) { s.delivered[k] = 0; s.incoming[k] = 0; }
    const tiles = this.world.tiles;
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) { tiles[y][x].site = s; if (tiles[y][x].tree) this.removeTree(x, y); if (tiles[y][x].deco) this.removeDeco(x, y); }
    this.sites.push(s);
    this.checkSiteReady(s); // a zero-cost site (cost fully reduced) is ready at once
    return s;
  }

  private completeSite(s: Site): void {
    const tiles = this.world.tiles;
    for (let y = s.y; y < s.y + 2; y++) for (let x = s.x; x < s.x + 2; x++) tiles[y][x].site = null;
    this.view.remove(s.mesh);
    this.sites.splice(this.sites.indexOf(s), 1);
    const b = this.placeBuilding(s.key, s.x, s.y, false, s.rot);
    this.toast(s.def.name + ' completed');
    this.sfx('build');
    if (s.def.worker) {
      const u = this.spawnUnit(s.def.worker.toLowerCase(), s.def.wcolor!, this.store ? doorTile(this.store) : doorTile(b));
      u.home = b; u.wstate = 'goHome'; u.roleName = s.def.worker;
      b.worker = u;
    } else b.active = true;
    if (this.selected === s) this.select(b);
  }

  // =====================================================================
  //  Units
  // =====================================================================
  spawnUnit(role: string, colorHex: number, tile: { x: number; y: number }): Unit {
    const { group, itemMesh } = this.view.createUnit(colorHex, role, tile.x, tile.y);
    const u: Unit = {
      role, roleName: role[0].toUpperCase() + role.slice(1), colorHex, mesh: group, itemMesh,
      tx: tile.x, ty: tile.y, path: null, pathI: 0, task: null, carrying: null, collect: null,
      home: null, wstate: 'idle', timer: 0, target: null, hunger: 70 + rnd() * 30, bob: 0, status: 'Idle',
    };
    this.units.push(u);
    return u;
  }

  private setCarrying(u: Unit, item: string | null): void {
    u.carrying = item;
    u.itemMesh.visible = !!item;
    if (item) (u.itemMesh.material as THREE.MeshLambertMaterial).color.setHex(ITEMS[item as keyof typeof ITEMS].hex);
  }

  private sendTo(u: Unit, x: number, y: number): boolean {
    const p = findPath(this.world, u.tx, u.ty, x, y);
    if (p === null) { u.path = null; return false; }
    u.path = p; u.pathI = 0; return true;
  }

  private moveUnit(u: Unit, dt: number): boolean {
    if (!u.path || u.pathI >= u.path.length) return true;
    const node = u.path[u.pathI];
    const tgt = new THREE.Vector3(this.world.wx(node.x), 0, this.world.wz(node.y));
    const cur = u.mesh.position;
    const curTile = this.world.T(u.tx, u.ty);
    const sp = this.mods.unitSpeed(u) * (curTile && curTile.road ? 1.3 : 1);
    const d = tgt.clone().sub(cur); d.y = 0;
    const dist = d.length();
    const step = sp * dt;
    if (dist <= step) {
      cur.x = tgt.x; cur.z = tgt.z; u.tx = node.x; u.ty = node.y; u.pathI++;
      if (u.pathI >= u.path.length) { u.path = null; return true; }
    } else {
      d.normalize().multiplyScalar(step); cur.add(d);
      u.mesh.rotation.y = Math.atan2(d.x, d.z);
      u.bob += dt * 10;
      u.mesh.position.y = Math.abs(Math.sin(u.bob)) * 0.045;
    }
    return false;
  }

  // =====================================================================
  //  Serf logistics dispatcher
  // =====================================================================
  private bDist(a: any, b: any): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

  private dispatch(): void {
    let idle = this.units.filter(u => u.role === 'serf' && !u.task && !u.collect);
    if (!idle.length) return;
    const carryCap = this.mods.carryCap(), outCap = this.mods.outCap();
    const demands: any[] = [];
    for (const s of this.sites) {
      for (const it in s.needs) {
        const rem = s.needs[it] - (s.delivered[it] || 0) - (s.incoming[it] || 0);
        for (let i = 0; i < rem; i++) demands.push({ pri: 0, to: s, item: it });
      }
    }
    for (const b of this.buildings) {
      if (!b.active || !b.def.recipe) continue;
      for (const it in b.def.recipe.inp) {
        const have = (b.inp[it] || 0) + (b.incoming[it] || 0);
        if (have < carryCap) demands.push({ pri: 1, to: b, item: it });
      }
    }
    for (const b of this.buildings) {
      if (!b.active || b.def.store) continue;
      for (const it in b.out) {
        if (b.out[it] > 0) {
          const wanted = demands.some(d => d.item === it);
          if (!wanted || b.out[it] >= outCap - 1) demands.push({ pri: 2, to: this.store, item: it, from: b });
        }
      }
    }
    demands.sort((a, b) => a.pri - b.pri);
    for (const d of demands) {
      if (!idle.length) break;
      let from: any = null;
      if (d.from) { if (d.from.out[d.item] > 0) from = d.from; }
      else {
        let best: any = null, bd = 1e9;
        for (const b of this.buildings) {
          if (b === d.to) continue;
          const avail = b.def.store ? (b.stock![d.item] || 0) : (b.out[d.item] || 0);
          if (avail > 0) { const dd = this.bDist(b, d.to) + (b.def.store ? 0.5 : 0); if (dd < bd) { bd = dd; best = b; } }
        }
        from = best;
      }
      if (!from) continue;
      let su: Unit | null = null, sd = 1e9;
      const fd = doorTile(from);
      for (const u of idle) { const dd = Math.abs(u.tx - fd.x) + Math.abs(u.ty - fd.y); if (dd < sd) { sd = dd; su = u; } }
      if (!su) continue;
      if (from.def.store) from.stock[d.item]--; else from.out[d.item]--;
      if (d.to.isSite) d.to.incoming[d.item] = (d.to.incoming[d.item] || 0) + 1;
      else if (!d.to.def.store) d.to.incoming[d.item] = (d.to.incoming[d.item] || 0) + 1;
      su.task = { from, to: d.to, item: d.item, phase: 'pickup' };
      su.status = 'Fetching ' + ITEMS[d.item as keyof typeof ITEMS].name;
      idle = idle.filter(u => u !== su);
    }
  }

  private serfUpdate(u: Unit, dt: number): void {
    const t = u.task;
    if (!t) { u.status = 'Idle'; return; }
    if (t.phase === 'pickup') {
      const d = doorTile(t.from);
      if (u.tx === d.x && u.ty === d.y && !u.path) {
        this.setCarrying(u, t.item);
        t.phase = 'deliver';
        u.status = 'Carrying ' + ITEMS[t.item as keyof typeof ITEMS].name + ' → ' + t.to.name;
      } else if (!u.path) { if (!this.sendTo(u, d.x, d.y)) { this.cancelTask(u); return; } }
    }
    if (t.phase === 'deliver') {
      const d = doorTile(t.to);
      if (u.tx === d.x && u.ty === d.y && !u.path) {
        if (t.to.isSite) { t.to.incoming[t.item]--; t.to.delivered[t.item]++; this.checkSiteReady(t.to); }
        else if (t.to.def.store) { t.to.stock[t.item] = (t.to.stock[t.item] || 0) + 1; }
        else { t.to.incoming[t.item]--; t.to.inp[t.item] = (t.to.inp[t.item] || 0) + 1; }
        this.setCarrying(u, null); u.task = null; u.status = 'Idle';
      } else if (!u.path && u.carrying) { if (!this.sendTo(u, d.x, d.y)) { this.cancelTask(u); return; } }
    }
    if (u.path) this.moveUnit(u, dt); else u.mesh.position.y = 0;
  }

  private cancelTask(u: Unit): void {
    const t = u.task; if (!t) return;
    if (t.phase === 'pickup' && !t.from.removed) { if (t.from.def && t.from.def.store) t.from.stock[t.item]++; else t.from.out[t.item]++; }
    if (t.to.isSite) t.to.incoming[t.item] = Math.max(0, (t.to.incoming[t.item] || 0) - 1);
    else if (t.to.def && !t.to.def.store) t.to.incoming[t.item] = Math.max(0, (t.to.incoming[t.item] || 0) - 1);
    if (u.carrying && this.store) this.store.stock![u.carrying] = (this.store.stock![u.carrying] || 0) + 1;
    this.setCarrying(u, null); u.task = null; u.status = 'Idle';
  }

  private checkSiteReady(s: Site): void {
    for (const k in s.needs) if ((s.delivered[k] || 0) < s.needs[k]) return;
    s.ready = true;
    s.frame.visible = true; s.frame.scale.set(1, 0.05, 1);
  }

  // =====================================================================
  //  Laborers & specialists
  // =====================================================================
  private laborerUpdate(u: Unit, dt: number): void {
    if (u.wstate === 'build') {
      const s = u.target as Site;
      if (!s || this.sites.indexOf(s) < 0) { u.wstate = 'idle'; u.target = null; return; }
      const d = doorTile(s);
      if (u.tx === d.x && u.ty === d.y && !u.path) {
        u.status = 'Building ' + s.def.name;
        s.progress += dt / this.mods.buildTime();
        u.bob += dt * 12; u.mesh.position.y = Math.abs(Math.sin(u.bob)) * 0.07;
        s.frame.scale.y = Math.max(0.05, s.progress);
        s.frame.position.y = 0;
        if (s.progress >= 1) { u.wstate = 'idle'; u.target = null; u.status = 'Idle'; this.completeSite(s); }
      } else if (!u.path) { if (!this.sendTo(u, d.x, d.y)) { u.wstate = 'idle'; u.target = null; } }
      if (u.path) this.moveUnit(u, dt);
      return;
    }
    u.status = 'Idle';
    u.mesh.position.y = 0;
    for (const s of this.sites) { if (s.ready && !s.builder) { s.builder = u; u.target = s; u.wstate = 'build'; break; } }
  }

  private outTotal(b: Building): number { let n = 0; for (const k in b.out) n += b.out[k]; return n; }

  private findNode(b: Building): any {
    const g = b.def.gather!, cx = b.x + 0.5, cy = b.y + 0.5;
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    let best: any = null, bd = 1e9;
    if (g.node === 'field') {
      for (const f of b.fieldsList) { const t = tiles[f.y][f.x]; if (t.field && t.field.growth >= 1) { const d = Math.hypot(f.x - cx, f.y - cy); if (d < bd) { bd = d; best = f; } } }
      return best;
    }
    if (g.node === 'plant') {
      for (let y = Math.max(0, b.y - g.range); y <= Math.min(H - 1, b.y + 1 + g.range); y++) for (let x = Math.max(0, b.x - g.range); x <= Math.min(W - 1, b.x + 1 + g.range); x++) {
        const t = tiles[y][x];
        if (t.type === 'grass' && !t.b && !t.site && !t.tree && !t.dep && !t.road && !t.field) { const d = Math.hypot(x - cx, y - cy); if (d > 2.2 && d < bd) { bd = d; best = { x, y }; } }
      }
      return best;
    }
    for (let y = Math.max(0, b.y - g.range); y <= Math.min(H - 1, b.y + 1 + g.range); y++) for (let x = Math.max(0, b.x - g.range); x <= Math.min(W - 1, b.x + 1 + g.range); x++) {
      const t = tiles[y][x];
      let ok = false;
      if (g.node === 'tree') ok = !!(t.tree && t.tree.growth >= 1 && !t.tree.reserved);
      else if (g.node === 'stone') ok = !!(t.dep && t.dep.kind === 'stone' && t.dep.amt > 0);
      else if (g.node === 'gold') ok = !!(t.dep && t.dep.kind === 'gold' && t.dep.amt > 0);
      else if (g.node === 'coal') ok = !!(t.dep && t.dep.kind === 'coal' && t.dep.amt > 0);
      if (ok) { const d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; best = { x, y }; } }
    }
    return best;
  }

  private workerUpdate(u: Unit, dt: number): void {
    const b = u.home;
    if (!b) return;
    if (u.wstate === 'goHome') {
      const d = doorTile(b);
      if (u.tx === d.x && u.ty === d.y && !u.path) { u.wstate = 'home'; b.active = true; this.toast(b.def.name + ' is now staffed'); }
      else if (!u.path) { if (!this.sendTo(u, d.x, d.y)) u.timer = 1; }
      if (u.path) this.moveUnit(u, dt);
      u.status = 'Moving in';
      return;
    }
    const def = b.def;
    if (def.recipe) {
      u.mesh.position.y = 0;
      if (b.working) {
        u.status = 'Working';
        u.bob += dt * 10; u.mesh.position.y = Math.abs(Math.sin(u.bob)) * 0.05;
        b.prog += dt / this.mods.recipeTime(def);
        if (b.prog >= 1) { b.prog = 0; b.working = false; b.out[def.recipe.out] = (b.out[def.recipe.out] || 0) + 1; this.objective?.onProduce(def.recipe.out); }
      } else {
        u.status = 'Waiting for materials';
        if (this.outTotal(b) < this.mods.outCap()) {
          let can = true;
          for (const k in def.recipe.inp) if ((b.inp[k] || 0) < (def.recipe.inp as any)[k]) can = false;
          if (can) { for (const k in def.recipe.inp) b.inp[k] -= (def.recipe.inp as any)[k]; b.working = true; b.prog = 0; }
        } else u.status = 'Output full';
      }
      return;
    }
    if (u.wstate === 'home') {
      u.mesh.position.y = 0;
      if (this.outTotal(b) >= this.mods.outCap()) { u.status = 'Output full'; return; }
      const node = this.findNode(b);
      if (!node) { u.status = 'No resources in range'; return; }
      u.target = node;
      if (def.gather!.node === 'tree') { this.world.tiles[node.y][node.x].tree!.reserved = true; }
      u.wstate = 'toNode';
    }
    if (u.wstate === 'toNode') {
      const n = u.target;
      if (u.tx === n.x && u.ty === n.y && !u.path) { u.wstate = 'gather'; u.timer = this.mods.gatherTime(def); }
      else if (!u.path) { if (!this.sendTo(u, n.x, n.y)) { u.wstate = 'home'; u.target = null; return; } }
      if (u.path) this.moveUnit(u, dt);
      u.status = 'Heading out';
      return;
    }
    if (u.wstate === 'gather') {
      u.status = def.gather!.node === 'plant' ? 'Planting' : 'Gathering';
      u.bob += dt * 11; u.mesh.position.y = Math.abs(Math.sin(u.bob)) * 0.07;
      u.timer -= dt;
      if (u.timer <= 0) {
        const n = u.target, t = this.world.tiles[n.y][n.x];
        if (def.gather!.node === 'tree') { if (t.tree) this.removeTree(n.x, n.y); this.setCarrying(u, 'trunk'); this.sfx('chop'); }
        else if (def.gather!.node === 'field') { if (t.field) { t.field.growth = 0; this.view.refreshTile(n.x, n.y); this.view.scaleFieldCrop(t.field); } this.setCarrying(u, def.gather!.out ?? 'wheat'); this.sfx('harvest'); }
        else if (def.gather!.node === 'plant') {
          if (!t.tree && !t.b && !t.site && !t.road && !t.field && !t.dep) { if (t.deco) this.removeDeco(n.x, n.y); t.tree = { growth: 0.12, reserved: false, meshes: [], s: 0.85 + rnd() * 0.4, kind: Math.floor(rnd() * 4) }; this.view.addTree(n.x, n.y, t.tree); }
        } else { if (t.dep) { t.dep.amt--; if (t.dep.amt <= 0) this.removeDep(n.x, n.y); } this.setCarrying(u, def.gather!.out); }
        u.wstate = 'return'; u.mesh.position.y = 0;
      }
      return;
    }
    if (u.wstate === 'return') {
      const d = doorTile(b);
      if (u.tx === d.x && u.ty === d.y && !u.path) {
        if (u.carrying) { b.out[u.carrying] = (b.out[u.carrying] || 0) + 1; this.objective?.onProduce(u.carrying); this.setCarrying(u, null); }
        u.wstate = 'home';
      } else if (!u.path) { if (!this.sendTo(u, d.x, d.y)) { u.wstate = 'home'; this.setCarrying(u, null); } }
      if (u.path) this.moveUnit(u, dt);
      u.status = 'Returning';
    }
  }

  // =====================================================================
  //  Growth
  // =====================================================================
  private growthUpdate(dt: number): void {
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    const fg = this.mods.fieldGrowth();
    for (const b of this.buildings) { if (b.def.fields) for (const f of b.fieldsList) { const t = tiles[f.y][f.x]; if (t.field && t.field.growth < 1) { t.field.growth += dt / 22 * fg; if (t.field.growth > 1) t.field.growth = 1; this.view.scaleFieldCrop(t.field); } } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x]; if (t.tree && t.tree.growth < 1) { t.tree.growth += dt / 40; if (t.tree.growth > 1) t.tree.growth = 1; const s = t.tree.s * Math.max(0.15, t.tree.growth); (t.tree.meshes[0] as THREE.Object3D).scale.set(s, s, s); } }
  }
  private fieldRecolor(): void { for (const b of this.buildings) { if (b.def.fields) for (const f of b.fieldsList) this.view.refreshTile(f.x, f.y); } }

  // =====================================================================
  //  Queries & placement
  // =====================================================================
  countItem(item: string): number {
    let n = this.store.stock![item] || 0;
    for (const b of this.buildings) { if (!b.def.store) n += (b.inp[item] || 0) + (b.out[item] || 0); }
    for (const u of this.units) if (u.carrying === item) n++;
    return n;
  }

  canPlace(key: BuildingKey, tx: number, ty: number, rot: number): boolean {
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) {
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep || t.road || t.field) return false;
    }
    const d = doorTile({ x: tx, y: ty, rot });
    return this.world.passable(d.x, d.y);
  }

  private depositInRange(kind: string, tx: number, ty: number, range: number): boolean {
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    for (let y = Math.max(0, ty - range); y <= Math.min(H - 1, ty + 1 + range); y++) for (let x = Math.max(0, tx - range); x <= Math.min(W - 1, tx + 1 + range); x++) {
      const t = tiles[y][x]; if (t.dep && t.dep.kind === kind && t.dep.amt > 0) return true;
    }
    return false;
  }
  private nearTree(tx: number, ty: number, r: number): boolean {
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    for (let y = Math.max(0, ty - r); y <= Math.min(H - 1, ty + 1 + r); y++) for (let x = Math.max(0, tx - r); x <= Math.min(W - 1, tx + 1 + r); x++) if (tiles[y][x].tree) return true;
    return false;
  }

  tryPlace(key: BuildingKey, tx: number, ty: number, rot: number): void {
    if (!this.canPlace(key, tx, ty, rot)) { this.sfx('error'); this.toast('Cannot build here — the entrance tile must be clear too', 'err'); return; }
    const def = DEFS[key];
    if (key === 'quarry' && !this.depositInRange('stone', tx, ty, 9)) { this.toast('No stone deposits in range — build near the grey rocks', 'err'); return; }
    if (key === 'goldmine' && !this.depositInRange('gold', tx, ty, 9)) { this.toast('No gold deposits in range', 'err'); return; }
    if (key === 'coalmine' && !this.depositInRange('coal', tx, ty, 9)) { this.toast('No coal deposits in range', 'err'); return; }
    if (key === 'woodcutter' && !this.nearTree(tx, ty, 9)) this.toast('Warning: few trees nearby', 'err');
    const cost = this.mods.buildingCost(def);
    for (const k in cost) { if (this.countItem(k) < (cost as any)[k]) { this.toast('Not enough ' + ITEMS[k as keyof typeof ITEMS].name + ' in the world — site will wait', 'err'); break; } }
    this.placeSite(key, tx, ty, rot);
    this.sfx('place');
    this.toast(def.name + ' site placed — serfs will deliver materials');
  }

  paintRoad(tx: number, ty: number): void {
    const t = this.world.T(tx, ty);
    if (!t || t.type !== 'grass' || t.b || t.site || t.road || t.field || t.dep) return;
    if ((this.store.stock?.['stone'] || 0) < ROAD_STONE_COST) {
      const now = Date.now();
      if (now - this.roadWarnT > 1500) { this.roadWarnT = now; this.toast('Out of stone — quarry more to build roads', 'err'); this.sfx('error'); }
      return;
    }
    this.store.stock!['stone'] -= ROAD_STONE_COST;
    if (t.tree) this.removeTree(tx, ty);
    if (t.deco) this.removeDeco(tx, ty);
    t.road = true; this.view.refreshTile(tx, ty); this.view.addRoad(tx, ty);
  }

  demolishAt(tx: number, ty: number, dragOnly: boolean): void {
    const t = this.world.T(tx, ty); if (!t) return;
    if (t.road) { t.road = false; this.view.refreshTile(tx, ty); this.view.removeRoad(tx, ty); return; }
    if (dragOnly) return;
    if (t.b) { if (t.b.def.store) { this.toast('The storehouse cannot be demolished', 'err'); return; } this.sfx('demolish'); this.removeBuilding(t.b); return; }
    if (t.site) { this.sfx('demolish'); this.removeSite(t.site); return; }
  }

  private removeSite(s: Site): void {
    s.removed = true;
    for (const u of this.units) if (u.task && (u.task.to === s || u.task.from === s)) this.cancelTask(u);
    if (s.builder) { s.builder.wstate = 'idle'; s.builder.target = null; s.builder.status = 'Idle'; }
    for (let y = s.y; y < s.y + 2; y++) for (let x = s.x; x < s.x + 2; x++) this.world.tiles[y][x].site = null;
    this.view.remove(s.mesh);
    this.sites.splice(this.sites.indexOf(s), 1);
    if (this.selected === s) this.select(null);
    this.toast(s.def.name + ' site removed');
  }

  private removeBuilding(b: Building): void {
    b.removed = true;
    for (const u of this.units) if (u.task && (u.task.to === b || u.task.from === b)) this.cancelTask(u);
    if (b.worker) { const w = b.worker; this.view.remove(w.mesh); this.units.splice(this.units.indexOf(w), 1); }
    for (const f of b.fieldsList) { const t = this.world.tiles[f.y][f.x]; if (t.field) { this.view.removeMeshes(t.field.meshes); t.field = null; this.view.refreshTile(f.x, f.y); } }
    for (let y = b.y; y < b.y + 2; y++) for (let x = b.x; x < b.x + 2; x++) this.world.tiles[y][x].b = null;
    this.view.remove(b.mesh);
    this.buildings.splice(this.buildings.indexOf(b), 1);
    if (this.selected === b) this.select(null);
    this.toast(b.def.name + ' demolished');
  }

  select(obj: any): void { this.selected = obj; this.onSelect(obj); }

  /** Door/entrance tiles of every building and site — highlighted while painting roads. */
  entranceTiles(): Coord[] {
    const out: Coord[] = [];
    for (const b of this.buildings) out.push(doorTile(b));
    for (const s of this.sites) out.push(doorTile(s));
    return out;
  }

  /** Click-select a building/site at a tile, or collect a gold pile (used by Controls). */
  selectAt(tx: number, ty: number): void {
    const t = this.world.tiles[ty][tx];
    if (t.pickup) { this.collectGoldAt(tx, ty); return; }
    if (t.b) this.select(t.b);
    else if (t.site) this.select(t.site);
    else this.select(null);
  }

  /** The player clicked a gold pile on the map — collect it instantly. */
  collectGoldAt(tx: number, ty: number): void {
    const t = this.world.T(tx, ty);
    if (!t || !t.pickup) return;
    const gain = Math.max(1, Math.round(t.pickup.gold * this.mods.goldMult()));
    this.view.removeMeshes(t.pickup.meshes);
    t.pickup = null;
    const i = this.pickups.findIndex(p => p.x === tx && p.y === ty);
    if (i >= 0) this.pickups.splice(i, 1);
    this.onGold(gain);
    this.sfx('coin');
    this.objective?.onCollect();
    this.toast('Collected a gold pile (+' + gain + ' gold)');
  }

  // =====================================================================
  //  Simulation tick (already scaled by sim speed)
  // =====================================================================
  update(sdt: number): void {
    this.elapsed += sdt;
    this.dispatchT += sdt;
    if (this.dispatchT > 0.45) { this.dispatchT = 0; this.dispatch(); }
    for (const u of this.units) {
      u.hunger = Math.max(0, u.hunger - sdt * 100 / 600);
      if (u.role === 'serf') this.serfUpdate(u, sdt);
      else if (u.role === 'laborer') this.laborerUpdate(u, sdt);
      else this.workerUpdate(u, sdt);
    }
    this.growthUpdate(sdt);
    this.fieldT += sdt;
    if (this.fieldT > 0.5) { this.fieldT = 0; this.fieldRecolor(); }
  }
}
