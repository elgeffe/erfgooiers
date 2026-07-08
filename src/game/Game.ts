import * as THREE from 'three';
import { ROAD_STONE_COST, PLOT_RANGE, BASE_SPEED } from '../constants';
import { DEFS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { UNITS, type UnitKind } from '../data/units';
import type { EnemySetup } from '../data/levels';
import { simRng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import type { World } from '../world/World';
import type { View } from '../render/View';
import type { Building, BuildingKey, Coord, Faction, Site, Unit } from '../types';
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
  villagers?: number;   // untrained recruits the Guild Hall starts with (default 4)
}

export const DEFAULT_KIT: StartKit = {
  stock: { timber: 16, stone: 10, bread: 8 },
  serfs: 4,
  laborers: 1,
  villagers: 7,
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
  guild!: Building;
  selected: any = null;
  simSpeed = 1;

  /** Sim seconds elapsed this level (drives the hard timer & speed bonus). */
  elapsed = 0;
  /** The level's objective tracker, or null (e.g. debug/sandbox). */
  objective: Objective | null = null;
  /** Set true when the castle is razed (or later, the hero dies) — main ends the run. */
  defeat = false;

  toast: (msg: string, cls?: string) => void = () => {};
  onSelect: (obj: any) => void = () => {};
  /** Called when gold is picked up off the map (already run through goldMult). */
  onGold: (amount: number) => void = () => {};
  /** Play a named sound effect (wired to the AudioEngine by main). */
  sfx: (name: string) => void = () => {};
  /** A unit took a hit at a world point — main wires this to the gore layer. */
  onHurt: (x: number, z: number, faction: Faction) => void = () => {};
  /** A unit died at a world point — main spawns a corpse + blood pool. */
  onDeath: (x: number, z: number, faction: Faction, colorHex: number) => void = () => {};
  /** A combat unit was killed — main updates objectives/tallies. */
  onKill: (u: Unit) => void = () => {};

  private readonly pickups: { x: number; y: number }[] = [];
  private dispatchT = 0;
  private fieldT = 0;
  private roadWarnT = 0;
  private plotWarnT = 0;

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
    this.store.stock = { timber: 0, stone: 0, bread: 0, trunk: 0, wheat: 0, flour: 0, goldore: 0, coal: 0, coin: 0, grape: 0, wine: 0, meat: 0, sausage: 0, fish: 0, ...kit.stock };
    const bonus = this.mods.startStock();
    for (const k in bonus) this.store.stock[k] = (this.store.stock[k] || 0) + (bonus as Record<string, number>)[k];
    const d = doorTile(this.store);
    const serfs = kit.serfs + this.mods.extraSerfs();
    const laborers = kit.laborers + this.mods.extraLaborers();
    for (let i = 0; i < serfs; i++) this.spawnUnit('serf', 0xd8c49a, { x: d.x - 2 + (i % 4), y: d.y + Math.floor(i / 4) });
    for (let i = 0; i < laborers; i++) { const u = this.spawnUnit('laborer', 0xc97b3d, { x: d.x + 2 + (i % 3), y: d.y + Math.floor(i / 3) }); u.roleName = 'Laborer'; }
    // the Guild Hall trains the villagers who staff your buildings (separate from storage)
    this.guild = this.placeBuilding('guildhall', cx + 3, cy, true);
    const gd = doorTile(this.guild);
    const villagers = kit.villagers ?? DEFAULT_KIT.villagers ?? 4;
    for (let i = 0; i < villagers; i++) this.spawnCivilian('villager', { x: gd.x - 1 + (i % 4), y: gd.y + 1 + Math.floor(i / 4) });
  }

  // =====================================================================
  //  Buildings / sites
  // =====================================================================
  placeBuilding(key: BuildingKey, tx: number, ty: number, instant = false, rot = 0, faction: Faction = 'player'): Building {
    const def = DEFS[key];
    const mesh = this.view.createBuildingMesh(def);
    mesh.rotation.y = -rot * Math.PI / 2;
    mesh.position.set(this.world.wx(tx) + 0.5, 0, this.world.wz(ty) + 0.5);
    this.view.add(mesh);
    const facMult = faction === 'player' ? (def.store ? this.mods.castleHpMult() : 1) : (this.mods.buildingHpMult(faction) || 1);
    const maxHp = Math.round((def.hp ?? 100) * facMult);
    const b: Building = {
      key, def, x: tx, y: ty, rot, active: false, inp: {}, out: {}, incoming: {},
      prog: 0, working: false, worker: null, fieldsList: [], mesh, name: def.name,
      faction, hp: maxHp, maxHp,
    };
    const tiles = this.world.tiles;
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) { tiles[y][x].b = b; if (tiles[y][x].tree) this.removeTree(x, y); if (tiles[y][x].deco) this.removeDeco(x, y); }
    this.buildings.push(b);
    if (instant) b.active = true;
    return b;
  }

  /** Max plots a fields-building may hold (data-driven, with a safe default). */
  private fieldCap(b: Building): number { return b.def.plots ?? 8; }

  /**
   * Player-placed plot: attach a crop/pasture tile to the given fields-building
   * (the one selected in its inspector) while it has room and range. Click & drag.
   */
  placePlot(tx: number, ty: number, b: Building): void {
    if (b.removed || !b.def.fields) return;
    const t = this.world.T(tx, ty);
    if (!t || t.type !== 'grass' || t.b || t.site || t.road || t.field || t.dep) return;
    if (b.fieldsList.length >= this.fieldCap(b)) {
      const now = Date.now();
      if (now - this.plotWarnT > 1500) { this.plotWarnT = now; this.toast(`${b.name} has no room for more plots`, 'err'); this.sfx('error'); }
      return;
    }
    if (Math.hypot(tx - (b.x + 0.5), ty - (b.y + 0.5)) > PLOT_RANGE) {
      const now = Date.now();
      if (now - this.plotWarnT > 1500) { this.plotWarnT = now; this.toast(`Too far — plots must sit within ${PLOT_RANGE} tiles of the ${b.name}`, 'err'); this.sfx('error'); }
      return;
    }
    if (t.deco) this.removeDeco(tx, ty);
    t.field = { farm: b, growth: rnd() * 0.4, meshes: [] };
    b.fieldsList.push({ x: tx, y: ty });
    this.view.refreshTile(tx, ty); this.view.addFieldCrop(tx, ty, t.field);
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
    // worker buildings stay unstaffed until a trained villager reports in (staffBuildings)
    if (!s.def.worker) b.active = true;
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
      faction: 'player', spd: BASE_SPEED, hp: 20, maxHp: 20, dmg: 0, range: 0, atkCd: 1, atkTimer: 0,
      dead: false, raider: false, foe: null, foeB: null, order: null, special: 0, hpBar: null,
    };
    this.units.push(u);
    return u;
  }

  /** Spawn a combat unit (player soldier/archer, or enemy/wild fighter) from its def. */
  spawnFighter(kind: UnitKind, tile: { x: number; y: number }, faction?: Faction): Unit {
    const def = UNITS[kind];
    const fac = faction ?? def.faction;
    const u = this.spawnUnit(kind, def.color, tile);
    u.roleName = def.name;
    u.faction = fac;
    u.spd = def.speed * this.mods.combatMult('speed', kind);
    u.maxHp = u.hp = Math.round(def.hp * this.mods.combatMult('hp', kind));
    u.dmg = def.dmg * this.mods.combatMult('damage', kind);
    u.range = def.range * this.mods.combatMult('range', kind);
    u.atkCd = def.atkCd;
    u.hunger = 100; // fighters don't idle for hunger
    u.status = def.name;
    u.mesh.scale.setScalar(def.scale);
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
        for (let i = 0; i < rem; i++) demands.push({ pri: s.priority ? -1 : 0, to: s, item: it });
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
      if (!b.active || !b.def.tavern) continue;
      const tv = b.def.tavern;
      const total = tv.foods.reduce((s, f) => s + (b.inp[f] || 0) + (b.incoming[f] || 0), 0);
      if (total >= tv.capacity) continue;
      for (const it of tv.foods) {
        const have = (b.inp[it] || 0) + (b.incoming[it] || 0);
        if (have < 2) demands.push({ pri: 1, to: b, item: it });
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
    // build prioritized sites first, then any other ready site
    let target: Site | null = null;
    for (const s of this.sites) { if (s.ready && !s.builder && s.priority) { target = s; break; } }
    if (!target) for (const s of this.sites) { if (s.ready && !s.builder) { target = s; break; } }
    if (target) { target.builder = u; u.target = target; u.wstate = 'build'; }
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
    if (g.node === 'fish') {
      // stand on an empty shore tile that touches lake water and cast a line
      for (let y = Math.max(0, b.y - g.range); y <= Math.min(H - 1, b.y + 1 + g.range); y++) for (let x = Math.max(0, b.x - g.range); x <= Math.min(W - 1, b.x + 1 + g.range); x++) {
        const t = tiles[y][x];
        if (t.type !== 'grass' || t.b || t.site || t.tree || t.dep || t.road || t.field) continue;
        if (!this.adjLake(x, y)) continue;
        const d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; best = { x, y }; }
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
      u.mesh.visible = true;
      const d = doorTile(b);
      if (u.tx === d.x && u.ty === d.y && !u.path) { u.wstate = 'home'; b.active = true; this.toast(b.def.name + ' is now staffed'); }
      else if (!u.path) { if (!this.sendTo(u, d.x, d.y)) u.timer = 1; }
      if (u.path) this.moveUnit(u, dt);
      u.status = 'Moving in';
      return;
    }
    const def = b.def;
    if (def.recipe) {
      u.mesh.visible = false; u.mesh.position.y = 0;
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
    // Non-producing staffed buildings (e.g. the Tavern): the worker just tends
    // it from inside, so it stays hidden until the building is torn down.
    if (!def.gather) { u.mesh.visible = false; u.mesh.position.y = 0; u.status = 'Tending'; return; }
    if (u.wstate === 'home') {
      u.mesh.visible = false;
      u.mesh.position.y = 0;
      if (this.outTotal(b) >= this.mods.outCap()) { u.status = 'Output full'; return; }
      const node = this.findNode(b);
      if (!node) { u.status = 'No resources in range'; return; }
      u.target = node;
      if (def.gather!.node === 'tree') { this.world.tiles[node.y][node.x].tree!.reserved = true; }
      u.wstate = 'toNode';
    }
    if (u.wstate === 'toNode') {
      u.mesh.visible = true;
      const n = u.target;
      if (u.tx === n.x && u.ty === n.y && !u.path) { u.wstate = 'gather'; u.timer = this.mods.gatherTime(def); }
      else if (!u.path) { if (!this.sendTo(u, n.x, n.y)) { u.wstate = 'home'; u.target = null; return; } }
      if (u.path) this.moveUnit(u, dt);
      u.status = 'Heading out';
      return;
    }
    if (u.wstate === 'gather') {
      u.mesh.visible = true;
      u.status = def.gather!.node === 'plant' ? 'Planting' : 'Gathering';
      u.bob += dt * 11; u.mesh.position.y = Math.abs(Math.sin(u.bob)) * 0.07;
      u.timer -= dt;
      if (u.timer <= 0) {
        const n = u.target, t = this.world.tiles[n.y][n.x];
        if (def.gather!.node === 'tree') { if (t.tree) this.removeTree(n.x, n.y); this.setCarrying(u, 'trunk'); this.sfx('chop'); }
        else if (def.gather!.node === 'field') { if (t.field) { t.field.growth = 0; this.view.refreshTile(n.x, n.y); this.view.scaleFieldCrop(t.field); } this.setCarrying(u, def.gather!.out ?? 'wheat'); this.sfx('harvest'); }
        else if (def.gather!.node === 'plant') {
          if (!t.tree && !t.b && !t.site && !t.road && !t.field && !t.dep) { if (t.deco) this.removeDeco(n.x, n.y); t.tree = { growth: 0.12, reserved: false, meshes: [], s: 0.85 + rnd() * 0.4, kind: Math.floor(rnd() * 4) }; this.view.addTree(n.x, n.y, t.tree); }
        } else if (def.gather!.node === 'fish') { this.setCarrying(u, def.gather!.out); this.sfx('harvest'); }
        else { if (t.dep) { t.dep.amt--; if (t.dep.amt <= 0) this.removeDep(n.x, n.y); } this.setCarrying(u, def.gather!.out); }
        u.wstate = 'return'; u.mesh.position.y = 0;
      }
      return;
    }
    if (u.wstate === 'return') {
      u.mesh.visible = true;
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

  /** Is an orthogonal neighbour a lake-water tile (the shore a fisher casts from)? */
  private adjLake(x: number, y: number): boolean {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const t = this.world.T(x + dx, y + dy); if (t && t.type === 'water' && t.lake) return true; }
    return false;
  }
  private lakeInRange(tx: number, ty: number, r: number): boolean {
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    for (let y = Math.max(0, ty - r); y <= Math.min(H - 1, ty + 1 + r); y++) for (let x = Math.max(0, tx - r); x <= Math.min(W - 1, tx + 1 + r); x++) if (tiles[y][x].type === 'water' && tiles[y][x].lake) return true;
    return false;
  }

  tryPlace(key: BuildingKey, tx: number, ty: number, rot: number): void {
    if (!this.canPlace(key, tx, ty, rot)) { this.sfx('error'); this.toast('Cannot build here — the entrance tile must be clear too', 'err'); return; }
    const def = DEFS[key];
    if (key === 'quarry' && !this.depositInRange('stone', tx, ty, 9)) { this.toast('No stone deposits in range — build near the grey rocks', 'err'); return; }
    if (key === 'goldmine' && !this.depositInRange('gold', tx, ty, 9)) { this.toast('No gold deposits in range', 'err'); return; }
    if (key === 'coalmine' && !this.depositInRange('coal', tx, ty, 9)) { this.toast('No coal deposits in range', 'err'); return; }
    if (key === 'fishery' && !this.lakeInRange(tx, ty, def.gather!.range)) { this.toast('No fishing water in range — build on the lake shore', 'err'); return; }
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
    if (t.road) { t.road = false; this.store.stock!['stone'] = (this.store.stock!['stone'] || 0) + ROAD_STONE_COST; this.view.refreshTile(tx, ty); this.view.removeRoad(tx, ty); return; }
    if (t.field) {
      const list = t.field.farm.fieldsList, i = list.findIndex(f => f.x === tx && f.y === ty);
      if (i >= 0) list.splice(i, 1);
      this.view.removeMeshes(t.field.meshes); t.field = null; this.view.refreshTile(tx, ty); return;
    }
    if (dragOnly) return;
    if (t.b) {
      if (t.b.def.store) { this.toast('The storehouse cannot be demolished', 'err'); return; }
      if (t.b.faction !== 'player') { this.toast('Enemy strongholds must be destroyed in battle', 'err'); return; }
      this.sfx('demolish'); this.removeBuilding(t.b); this.toast(t.b.def.name + ' demolished'); return;
    }
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
    if (b.worker) { const w = b.worker; this.view.remove(w.mesh); this.units.splice(this.units.indexOf(w), 1); if (this.selected === w) this.select(null); }
    for (const f of b.fieldsList) { const t = this.world.tiles[f.y][f.x]; if (t.field) { this.view.removeMeshes(t.field.meshes); t.field = null; this.view.refreshTile(f.x, f.y); } }
    for (let y = b.y; y < b.y + 2; y++) for (let x = b.x; x < b.x + 2; x++) this.world.tiles[y][x].b = null;
    this.view.remove(b.mesh);
    this.buildings.splice(this.buildings.indexOf(b), 1);
    if (this.selected === b) this.select(null);
  }

  select(obj: any): void { this.selected = obj; this.onSelect(obj); }

  /** Nearest visible unit to a world-space ground point, or null (used by Controls). */
  pickUnit(wx: number, wz: number, radius = 0.6): Unit | null {
    let best: Unit | null = null, bd = radius * radius;
    for (const u of this.units) {
      if (!u.mesh.visible) continue;
      const dx = u.mesh.position.x - wx, dz = u.mesh.position.z - wz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = u; }
    }
    return best;
  }

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
  //  Combat
  // =====================================================================
  /** Are two factions hostile? Player fights all non-player; enemy/wild fight the player. */
  private hostile(a: Faction, b: Faction): boolean {
    if (a === b) return false;
    return a === 'player' ? b !== 'player' : b === 'player';
  }

  /** True for units that run the combat behavior (soldiers, bandits, boars, dragon…). */
  private isFighter(u: Unit): boolean { return (UNITS as any)[u.role] !== undefined; }

  private unitDist(a: Unit, b: Unit): number {
    const dx = a.mesh.position.x - b.mesh.position.x, dz = a.mesh.position.z - b.mesh.position.z;
    return Math.hypot(dx, dz);
  }

  /** Nearest hostile fighter within the aggro radius, or null. */
  private acquireTarget(u: Unit): Unit | null {
    const AGGRO = 13;
    let best: Unit | null = null, bd = AGGRO * AGGRO;
    for (const o of this.units) {
      if (o.dead || o === u) continue;
      if (!this.hostile(u.faction, o.faction)) continue;
      const dx = o.tx - u.tx, dy = o.ty - u.ty, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = o; }
    }
    return best;
  }

  private faceUnit(u: Unit, foe: Unit): void {
    const dx = foe.mesh.position.x - u.mesh.position.x, dz = foe.mesh.position.z - u.mesh.position.z;
    if (dx || dz) u.mesh.rotation.y = Math.atan2(dx, dz);
  }

  private attack(attacker: Unit, foe: Unit): void {
    foe.hp -= attacker.dmg;
    this.onHurt(foe.mesh.position.x, foe.mesh.position.z, foe.faction);
    // retaliation: an idle victim turns on its attacker
    if (!foe.foe && this.hostile(foe.faction, attacker.faction)) foe.foe = attacker;
    if (foe.hp <= 0) this.killUnit(foe);
  }

  private killUnit(u: Unit): void {
    if (u.dead) return;
    u.dead = true;
    this.onDeath(u.mesh.position.x, u.mesh.position.z, u.faction, u.colorHex);
    this.onKill(u);
    this.objective?.onKill(u.role, u.faction);
    for (const o of this.units) if (o.foe === u) o.foe = null;
  }

  private combatUpdate(u: Unit, dt: number): void {
    u.atkTimer = Math.max(0, u.atkTimer - dt);
    if (u.role === 'dragon') this.dragonSpecial(u, dt);

    let foe = u.foe;
    if (foe && foe.dead) foe = null;
    if (u.order && u.order.type === 'attack' && u.order.foe && !u.order.foe.dead) foe = u.order.foe;
    // pure 'move' orders don't auto-seek (lets you march past enemies); everything else does
    const canSeek = !u.order || u.order.type !== 'move';
    if (!foe && canSeek) foe = this.acquireTarget(u);
    u.foe = foe;

    if (foe) {
      const d = this.unitDist(u, foe);
      if (d <= u.range + 0.1) {
        u.path = null;
        this.faceUnit(u, foe);
        u.mesh.position.y = 0;
        if (u.atkTimer <= 0) { u.atkTimer = u.atkCd; this.attack(u, foe); }
      } else {
        // chase — throttle A* so hundreds of pursuers don't re-path every tick
        if (!u.path) { u.timer -= dt; if (u.timer <= 0) { this.sendTo(u, foe.tx, foe.ty); u.timer = 0.4 + rnd() * 0.35; } }
        this.moveUnit(u, dt);
      }
      return;
    }

    // no unit foe: go for a hostile building (castle for raiders, camps for the player army)
    let bt = u.foeB;
    if (bt && bt.removed) bt = null;
    if (!bt && canSeek) bt = this.buildingTargetFor(u);
    u.foeB = bt;
    if (bt) {
      const c = this.buildingCenter(bt);
      const dx = c.x - u.mesh.position.x, dz = c.z - u.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d <= u.range + 1.15) {
        u.path = null;
        u.mesh.rotation.y = Math.atan2(dx, dz);
        u.mesh.position.y = 0;
        if (u.atkTimer <= 0) { u.atkTimer = u.atkCd; this.attackBuilding(u, bt); }
      } else {
        if (!u.path) { u.timer -= dt; if (u.timer <= 0) { const dr = doorTile(bt); this.sendTo(u, dr.x, dr.y); u.timer = 0.5 + rnd() * 0.4; } }
        this.moveUnit(u, dt);
      }
      return;
    }

    // no foe: follow a move/attack-move order, else idle in place
    if (u.order && (u.order.type === 'move' || u.order.type === 'attackMove')) {
      if (!u.path) {
        if (u.tx === u.order.x && u.ty === u.order.y) { u.order = null; }
        else if (!this.sendTo(u, u.order.x, u.order.y)) { u.order = null; }
      }
      if (u.path) this.moveUnit(u, dt); else u.mesh.position.y = 0;
    } else {
      u.mesh.position.y = 0;
    }
  }

  private buildingCenter(b: Building): { x: number; z: number } {
    return { x: this.world.wx(b.x) + 0.5, z: this.world.wz(b.y) + 0.5 };
  }

  /** The building a fighter should march on: raiders storm the nearest player building,
   *  the player army razes the nearest enemy stronghold in reach. */
  private buildingTargetFor(u: Unit): Building | null {
    if (u.faction === 'wild') return null; // beasts fight units, not walls
    if (u.faction !== 'player' && !u.raider) return null; // camp guards hold their ground
    const RANGE = u.faction === 'player' ? 18 : 1e9; // raiders always march on the castle
    let best: Building | null = null, bd = RANGE * RANGE;
    for (const b of this.buildings) {
      if (b.removed || !this.hostile(u.faction, b.faction)) continue;
      const c = this.buildingCenter(b);
      const dx = c.x - u.mesh.position.x, dz = c.z - u.mesh.position.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = b; }
    }
    return best;
  }

  private attackBuilding(u: Unit, b: Building): void {
    b.hp -= u.dmg;
    this.onHurt(this.buildingCenter(b).x, this.buildingCenter(b).z, b.faction);
    if (b.hp <= 0) this.destroyBuilding(b);
  }

  private destroyBuilding(b: Building): void {
    if (b.removed) return;
    const c = this.buildingCenter(b);
    for (let i = 0; i < 4; i++) this.onDeath(c.x + (rnd() - 0.5) * 1.4, c.z + (rnd() - 0.5) * 1.4, b.faction, b.def.roof);
    this.objective?.onStructureDestroyed(b.faction);
    for (const o of this.units) if (o.foeB === b) o.foeB = null;
    const isCastle = b === this.store;
    this.removeBuilding(b);
    this.toast(b.def.name + (b.faction === 'player' ? ' has fallen!' : ' destroyed!'), 'err');
    if (isCastle) this.defeat = true;
  }

  /** The dragon's periodic fire-breath: an area stomp that scorches nearby
   *  player units and any building it stands over. */
  private dragonSpecial(u: Unit, dt: number): void {
    u.special -= dt;
    if (u.special > 0) return;
    const R = 3.6;
    let hit = false;
    for (const o of this.units) {
      if (o.dead || o.faction !== 'player') continue;
      const dx = o.mesh.position.x - u.mesh.position.x, dz = o.mesh.position.z - u.mesh.position.z;
      if (dx * dx + dz * dz <= R * R) { o.hp -= 26; this.onHurt(o.mesh.position.x, o.mesh.position.z, o.faction); hit = true; if (o.hp <= 0) this.killUnit(o); }
    }
    for (const b of this.buildings) {
      if (b.removed || b.faction !== 'player') continue;
      const c = this.buildingCenter(b);
      const dx = c.x - u.mesh.position.x, dz = c.z - u.mesh.position.z;
      if (dx * dx + dz * dz <= (R + 1.2) * (R + 1.2)) this.attackBuilding(u, b);
    }
    if (hit) this.sfx('error');
    u.special = 4.5;
  }

  /** Toggle a construction site's priority (materials & builders go there first). */
  togglePriority(s: Site): void {
    s.priority = !s.priority;
    this.sfx('click');
    this.toast(s.priority ? s.def.name + ' prioritized' : s.def.name + ' no longer prioritized');
  }

  /** Issue a command to a unit (used by Controls for hero/army orders). */
  orderUnit(u: Unit, type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null): void {
    u.order = { type, x, y, foe };
    u.foe = type === 'attack' ? foe : null;
    u.path = null;
  }

  /** Scatter `count` fighters of a kind around a world point (sandbox/level spawner). */
  spawnSquad(kind: UnitKind, count: number, worldX: number, worldZ: number, faction?: Faction): Unit[] {
    const W = this.world.W, H = this.world.H;
    const cx = Math.max(2, Math.min(W - 3, Math.floor(worldX + W / 2)));
    const cy = Math.max(2, Math.min(H - 3, Math.floor(worldZ + H / 2)));
    const out: Unit[] = [];
    const tryTile = (x: number, y: number): void => {
      if (out.length >= count || this.units.length >= 1600) return; // cap for perf
      const t = this.world.T(x, y);
      if (!t || t.type === 'water' || t.b || t.site || t.dep) return;
      out.push(this.spawnFighter(kind, { x, y }, faction));
    };
    tryTile(cx, cy);
    for (let r = 1; r < 14 && out.length < count; r++) {
      for (let dx = -r; dx <= r && out.length < count; dx++)
        for (let dy = -r; dy <= r && out.length < count; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring perimeter only
          tryTile(cx + dx, cy + dy);
        }
    }
    return out;
  }

  // =====================================================================
  //  Enemy director — waves, camps, wild beasts, a boss and a commander
  // =====================================================================
  private enemy: EnemySetup | null = null;
  private waveIdx = 0;
  private waves: { units: Unit[]; cleared: boolean }[] = [];
  private commanderT = 0;
  private camps: Building[] = [];

  /** Configure and spawn a level's enemy presence (called by main after init). */
  setEnemies(setup: EnemySetup | null): void {
    this.enemy = setup;
    this.waveIdx = 0; this.waves = []; this.commanderT = 0; this.camps = [];
    if (!setup) return;
    if (setup.wild) for (const w of setup.wild) this.spawnWild(w.kind, w.count);
    if (setup.camps) for (const c of setup.camps) for (let i = 0; i < c.count; i++) this.spawnStronghold('banditcamp', c.guards);
    if (setup.keep) { const camp = this.spawnStronghold('enemycastle', setup.keep.guards); if (camp && setup.towers) for (let i = 0; i < setup.towers; i++) this.spawnTowerNear(camp); }
    if (setup.boss) this.spawnBoss(setup.boss);
  }

  private combatDirector(sdt: number): void {
    if (!this.enemy) return;
    // launch scheduled raid waves at the castle
    const w = this.enemy.waves;
    if (w) while (this.waveIdx < w.length && this.elapsed >= w[this.waveIdx].at) {
      const def = w[this.waveIdx++];
      this.waves.push({ units: this.spawnRaid(def.kind, def.count, 'edge'), cleared: false });
      this.toast('A raid approaches!', 'err'); this.sfx('error');
    }
    // count a wave as cleared once every raider in it is dead
    for (const wv of this.waves) {
      if (wv.cleared || !wv.units.length) continue;
      if (wv.units.every(u => u.dead)) { wv.cleared = true; this.objective?.onWaveCleared(); this.toast('Raid repelled!'); }
    }
    // the enemy commander sends fresh squads on a timer
    const cmd = this.enemy.commander;
    if (cmd) { this.commanderT += sdt; if (this.commanderT >= cmd.every) { this.commanderT = 0; this.spawnRaid(cmd.kind, cmd.count, cmd.from ?? 'camp'); } }
    // watchtowers loose arrows at the nearest player fighter
    this.towerFire(sdt);
  }

  private towerFire(sdt: number): void {
    for (const b of this.buildings) {
      if (b.removed || b.faction === 'player' || b.key !== 'watchtower') continue;
      b.prog += sdt;
      if (b.prog < 1.6) continue;
      b.prog = 0;
      const c = this.buildingCenter(b);
      let best: Unit | null = null, bd = 6 * 6;
      for (const u of this.units) {
        if (u.dead || u.faction !== 'player' || u.dmg <= 0) continue;
        const dx = u.mesh.position.x - c.x, dz = u.mesh.position.z - c.z, d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = u; }
      }
      if (best) { best.hp -= 12; this.onHurt(best.mesh.position.x, best.mesh.position.z, best.faction); if (best.hp <= 0) this.killUnit(best); }
    }
  }

  /** A raid squad from a map edge (or a camp), ordered to march on the castle. */
  private spawnRaid(kind: UnitKind, count: number, from: 'edge' | 'camp'): Unit[] {
    let ox: number, oz: number;
    if (from === 'camp' && this.camps.length) { const c = this.camps[Math.floor(rnd() * this.camps.length)]; ox = this.world.wx(c.x); oz = this.world.wz(c.y); }
    else { const e = this.randomEdge(); ox = e.x; oz = e.z; }
    const squad = this.spawnSquad(kind, count, ox, oz, 'enemy');
    const castle = this.store;
    for (const u of squad) { u.raider = true; if (castle) this.orderUnit(u, 'attackMove', castle.x + 1, castle.y + 1); }
    return squad;
  }

  private randomEdge(): { x: number; z: number } {
    const W = this.world.W, H = this.world.H;
    const side = Math.floor(rnd() * 4);
    let tx = 1, ty = 1;
    if (side === 0) { tx = 1 + Math.floor(rnd() * (W - 2)); ty = 1; }
    else if (side === 1) { tx = 1 + Math.floor(rnd() * (W - 2)); ty = H - 2; }
    else if (side === 2) { tx = 1; ty = 1 + Math.floor(rnd() * (H - 2)); }
    else { tx = W - 2; ty = 1 + Math.floor(rnd() * (H - 2)); }
    return { x: this.world.wx(tx), z: this.world.wz(ty) };
  }

  /** Scatter wild beasts across the map, clear of the central build zone. */
  private spawnWild(kind: UnitKind, count: number): void {
    const W = this.world.W, H = this.world.H, cx = W / 2, cy = H / 2;
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      const x = 2 + Math.floor(rnd() * (W - 4)), y = 2 + Math.floor(rnd() * (H - 4));
      if (Math.abs(x - cx) < 7 && Math.abs(y - cy) < 7) continue;
      const t = this.world.T(x, y);
      if (!t || t.type === 'water' || t.b || t.site || t.dep) continue;
      this.spawnFighter(kind, { x, y }, 'wild'); placed++;
    }
  }

  /** Place an enemy stronghold away from the centre and post guards around it. */
  private spawnStronghold(key: BuildingKey, guards: number): Building | null {
    const spot = this.findStrongholdSpot();
    if (!spot) return null;
    const b = this.placeBuilding(key, spot.x, spot.y, true, 0, 'enemy');
    b.active = true;
    this.camps.push(b);
    this.spawnSquad('bandit', guards, this.world.wx(spot.x), this.world.wz(spot.y), 'enemy');
    return b;
  }

  private spawnTowerNear(b: Building): void {
    for (let r = 3; r < 8; r++) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
        const x = b.x + dx, y = b.y + dy;
        if (this.areaClear(x, y)) { const t = this.placeBuilding('watchtower', x, y, true, 0, 'enemy'); t.active = true; return; }
      }
    }
  }

  private spawnBoss(kind: UnitKind): void {
    const e = this.randomEdge();
    const squad = this.spawnSquad(kind, 1, e.x, e.z, 'wild');
    const castle = this.store;
    for (const u of squad) { u.raider = true; if (castle) this.orderUnit(u, 'attackMove', castle.x + 1, castle.y + 1); }
    this.toast('The Dragon of Het Gooi descends!', 'err');
  }

  private areaClear(tx: number, ty: number): boolean {
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) {
      const t = this.world.T(x, y);
      if (!t || t.type === 'water' || t.b || t.site || t.dep || t.road) return false;
    }
    return true;
  }

  private findStrongholdSpot(): { x: number; y: number } | null {
    const W = this.world.W, H = this.world.H, cx = W / 2, cy = H / 2;
    for (let tries = 0; tries < 400; tries++) {
      const x = 2 + Math.floor(rnd() * (W - 5)), y = 2 + Math.floor(rnd() * (H - 5));
      if (Math.abs(x - cx) < 9 && Math.abs(y - cy) < 9) continue; // keep clear of the player's start
      if (this.areaClear(x, y)) return { x, y };
    }
    return null;
  }

  /** Remove units flagged dead this tick (deferred so combat iteration stays stable). */
  private sweepDead(): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (!u.dead) continue;
      if (this.selected === u) this.select(null);
      this.view.remove(u.mesh);
      this.units.splice(i, 1);
    }
  }

  // =====================================================================
  //  Simulation tick (already scaled by sim speed)
  // =====================================================================
  update(sdt: number): void {
    this.elapsed += sdt;
    this.dispatchT += sdt;
    if (this.dispatchT > 0.45) { this.dispatchT = 0; this.dispatch(); }
    for (const u of this.units) {
      if (u.dead) continue;
      u.hunger = Math.max(0, u.hunger - sdt * 100 / 600);
      if (this.isFighter(u)) this.combatUpdate(u, sdt);
      else if (u.role === 'serf') this.serfUpdate(u, sdt);
      else if (u.role === 'laborer') this.laborerUpdate(u, sdt);
      else this.workerUpdate(u, sdt);
    }
    this.sweepDead();
    this.growthUpdate(sdt);
    this.serveTaverns(sdt);
    this.trainQueues(sdt);
    this.staffBuildings();
    this.combatDirector(sdt);
    this.fieldT += sdt;
    if (this.fieldT > 0.5) { this.fieldT = 0; this.fieldRecolor(); }
  }

  /** Queue a unit at a barracks/guild hall, paying its cost from the store. */
  trainUnit(b: Building, kind: string): boolean {
    const spec = b.def.military ?? b.def.trainer;
    if (!spec || !b.active || !spec.trains.includes(kind)) return false;
    const store = this.store;
    if (!store || !store.stock) return false;
    for (const k in spec.cost) if ((store.stock[k] || 0) < (spec.cost as any)[k]) { this.toast('Not enough resources to train a ' + kind, 'err'); this.sfx('error'); return false; }
    for (const k in spec.cost) store.stock[k] -= (spec.cost as any)[k];
    (b.trainQ ||= []).push(kind);
    this.sfx('click');
    return true;
  }

  /** Cancel a queued training order by index, refunding its cost to the store. */
  cancelTrain(b: Building, index: number): void {
    if (!b.trainQ || index < 0 || index >= b.trainQ.length) return;
    const spec = b.def.military ?? b.def.trainer;
    b.trainQ.splice(index, 1);
    if (index === 0) b.prog = 0;           // scrap progress on the in-flight unit
    if (spec && this.store?.stock) for (const k in spec.cost) this.store.stock[k] = (this.store.stock[k] || 0) + (spec.cost as any)[k];
    this.sfx('click');
  }

  /** Spawn a civilian worker (serf / laborer / villager) at a tile. */
  private spawnCivilian(role: string, tile: { x: number; y: number }): Unit {
    if (role === 'serf') return this.spawnUnit('serf', 0xd8c49a, tile);
    if (role === 'laborer') { const u = this.spawnUnit('laborer', 0xc97b3d, tile); u.roleName = 'Laborer'; return u; }
    const u = this.spawnUnit('villager', 0xcdbb8f, tile); u.roleName = 'Villager'; u.status = 'Awaiting a post'; return u;
  }

  /** Barracks & guild halls turn their player-built queue into units over time. */
  private trainQueues(sdt: number): void {
    for (const b of this.buildings) {
      const spec = b.def.military ?? b.def.trainer;
      if (!spec || !b.active) continue;
      if (!b.trainQ || !b.trainQ.length) { b.prog = 0; continue; }
      b.prog += sdt / spec.time;
      if (b.prog >= 1) {
        b.prog = 0;
        const kind = b.trainQ.shift()!;
        const d = doorTile(b);
        if ((UNITS as any)[kind]) this.spawnFighter(kind as UnitKind, { x: d.x, y: d.y }, 'player');
        else this.spawnCivilian(kind, { x: d.x, y: d.y });
        this.sfx('build');
      }
    }
  }

  /** Send an idle villager to become the specialist of each unstaffed building. */
  private staffBuildings(): void {
    for (const b of this.buildings) {
      if (b.removed || !b.def.worker || b.worker || b.faction !== 'player') continue;
      let best: Unit | null = null, bd = 1e9;
      for (const u of this.units) {
        if (u.dead || u.role !== 'villager' || u.home) continue;
        const dd = Math.abs(u.tx - b.x) + Math.abs(u.ty - b.y);
        if (dd < bd) { bd = dd; best = u; }
      }
      if (!best) continue;
      const tile = { x: best.tx, y: best.ty };
      this.view.remove(best.mesh); this.units.splice(this.units.indexOf(best), 1);
      if (this.selected === best) this.select(null);
      const def = b.def;
      const u = this.spawnUnit(def.worker!.toLowerCase(), def.wcolor!, tile);
      u.home = b; u.wstate = 'goHome'; u.roleName = def.worker!;
      b.worker = u;
    }
  }

  /** Taverns burn food on a timer to refill the hunger of workers, up to capacity. */
  private serveTaverns(sdt: number): void {
    for (const b of this.buildings) {
      const tv = b.def.tavern;
      if (!tv || !b.active) continue;
      b.prog += sdt / tv.time;
      if (b.prog < 1) continue;
      b.prog = 0;
      // hungriest player workers first (fighters don't dine here); unlimited range
      const eaters = this.units
        .filter(u => u.faction === 'player' && !this.isFighter(u) && u.hunger < 90)
        .sort((a, c) => a.hunger - c.hunger)
        .slice(0, tv.capacity);
      const fed: Unit[] = [];
      for (const u of eaters) {
        const food = tv.foods.find(f => (b.inp[f] || 0) > 0);
        if (!food) break;                  // out of provisions this cycle
        b.inp[food]--;
        u.hunger = 100;
        fed.push(u);
      }
      b.fedUnits = fed;
    }
  }
}
