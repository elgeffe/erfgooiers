import * as THREE from 'three';
import { ROAD_STONE_COST, PLOT_RANGE, BASE_SPEED } from '../constants';
import { DEFS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { UNITS, type UnitKind } from '../data/units';
import type { EnemySetup } from '../data/levels';
import { simRng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import { formationSpots } from '../engine/formations';
import type { World } from '../world/World';
import type { View } from '../render/View';
import type { Building, BuildingKey, Coord, Faction, Formation, Site, Unit } from '../types';
import { doorTile, unitLabel } from './util';
import { Modifiers } from './Modifiers';
import type { Objective } from './Objectives';

// Gameplay events use the sim stream (reseeded per level), never worldgen/cosmetic.
const rnd = () => simRng.next();
const MAX_UNITS = 11000;

/** The goods and workers a level hands you at the start (before run upgrades). */
export interface StartKit {
  stock: Partial<Record<string, number>>;
  serfs: number;
  laborers: number;
  villagers?: number;   // untrained recruits the Guild Hall starts with (default 4)
}

export const DEFAULT_KIT: StartKit = {
  stock: { timber: 16, stone: 10, bread: 8, coin: 6 },
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
  onDeath: (x: number, z: number, faction: Faction, colorHex: number, role: string, scale: number) => void = () => {};
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
    this.store.stock = Object.fromEntries(Object.keys(ITEMS).map(key => [key, kit.stock[key] ?? 0]));
    const bonus = this.mods.startStock();
    for (const k in bonus) this.store.stock[k] = (this.store.stock[k] || 0) + (bonus as Record<string, number>)[k];
    const d = doorTile(this.store);
    const serfs = kit.serfs + this.mods.extraSerfs();
    const laborers = kit.laborers + this.mods.extraLaborers();
    for (let i = 0; i < serfs; i++) this.spawnUnit('serf', 0xd8c49a, { x: d.x - 2 + (i % 4), y: d.y + Math.floor(i / 4) });
    for (let i = 0; i < laborers; i++) { const u = this.spawnUnit('laborer', 0xc97b3d, { x: d.x + 2 + (i % 3), y: d.y + Math.floor(i / 3) }); u.roleName = 'Builder'; }
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
    const mesh = this.view.createBuildingMesh(key, def);
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
    // fields-buildings carry a floating marker that nags for plot placement
    // until every plot square is down (toggled & animated by View.animate)
    if (def.fields && faction === 'player') {
      const marker = this.view.createPlotMarker();
      marker.userData.dynamic = true;
      marker.position.y = 2.4;
      marker.visible = false;
      mesh.add(marker);
      mesh.userData.plotMarker = marker;
    }
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

  // Static doodads live in merged scenery chunks; clearing the tile state and
  // dirtying the chunk re-bakes it without them. Growing trees also carry an
  // individual mesh, removed via removeMeshes.
  removeTree(x: number, y: number): void { const t = this.world.tiles[y][x]; if (t.tree) { this.view.removeMeshes(t.tree.meshes); t.tree = null; this.view.dirtyTile(x, y); } }
  removeDep(x: number, y: number): void { const t = this.world.tiles[y][x]; if (t.dep) { this.view.removeMeshes(t.dep.meshes); t.dep = null; this.view.dirtyTile(x, y); } }
  removeDeco(x: number, y: number): void { const t = this.world.tiles[y][x]; if (t.deco) { this.view.removeMeshes(t.deco.meshes); t.deco = null; this.view.dirtyTile(x, y); } }

  placeSite(key: BuildingKey, tx: number, ty: number, rot = 0): Site {
    const def = DEFS[key];
    const { group, frame } = this.view.createScaffold(key, def);
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
      dead: false, raider: false, foe: null, foeB: null, order: null, special: 0, anchor: null, lungeT: 0, hpBar: null,
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
    u.anchor = { x: tile.x, y: tile.y }; // beasts & guards roam around home
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

  /** Tile under a unit's current world position (paths are smoothed, so tx/ty
   *  must track the mesh continuously rather than only at node arrivals). */
  private syncTile(u: Unit): void {
    const W = this.world.W, H = this.world.H;
    u.tx = Math.max(0, Math.min(W - 1, Math.round(u.mesh.position.x + W / 2 - 0.5)));
    u.ty = Math.max(0, Math.min(H - 1, Math.round(u.mesh.position.z + H / 2 - 0.5)));
  }

  private moveUnit(u: Unit, dt: number): boolean {
    if (!u.path || u.pathI >= u.path.length) { u.path = null; return true; }
    const node = u.path[u.pathI];
    // plain scalar math — this runs for every moving unit every tick, so no
    // per-call Vector3 allocations (GC churn at 20 tps with hundreds of units)
    const tx = this.world.wx(node.x), tz = this.world.wz(node.y);
    const cur = u.mesh.position;
    const curTile = this.world.T(u.tx, u.ty);
    // corvée roads' downside only drags the player's own folk off-road
    const offRoad = u.faction === 'player' ? this.mods.offRoadMult() : 1;
    const sp = this.mods.unitSpeed(u) * (curTile && curTile.road ? 1.3 : offRoad);
    const dx = tx - cur.x, dz = tz - cur.z;
    const dist = Math.hypot(dx, dz);
    const step = sp * dt;
    if (dist <= step) {
      cur.x = tx; cur.z = tz; u.tx = node.x; u.ty = node.y; u.pathI++;
      if (u.pathI >= u.path.length) { u.path = null; return true; }
    } else {
      const k = step / dist;
      cur.x += dx * k; cur.z += dz * k;
      u.mesh.rotation.y = Math.atan2(dx, dz);
      u.bob += dt * 10;
      u.mesh.position.y = Math.abs(Math.sin(u.bob)) * 0.045;
      this.syncTile(u);
    }
    return false;
  }

  /** Direct steering for flying units (the dragon): no tiles, no paths — just
   *  glide toward the point, banking to face travel, wings flapping. */
  private moveFlying(u: Unit, dt: number, wx: number, wz: number): boolean {
    const cur = u.mesh.position;
    const dx = wx - cur.x, dz = wz - cur.z;
    const dist = Math.hypot(dx, dz);
    const step = this.mods.unitSpeed(u) * dt;
    if (dist > 0.01) u.mesh.rotation.y = Math.atan2(dx, dz);
    if (dist <= step) { cur.x = wx; cur.z = wz; } else { cur.x += dx / dist * step; cur.z += dz / dist * step; }
    this.syncTile(u);
    return dist <= step;
  }

  /** Hover bob + wing flap for a flying unit, run every tick whatever it does. */
  private animateFlight(u: Unit, dt: number): void {
    u.bob += dt * 5;
    u.mesh.position.y = 0.45 + Math.sin(u.bob * 0.8) * 0.12;
    const wings = u.mesh.userData.wings as THREE.Object3D[] | undefined;
    if (wings) for (const w of wings) w.rotation.x = (w.userData.flapBase as number) + (w.userData.flapSign as number) * Math.sin(u.bob) * 0.4;
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
      for (const it in this.mods.recipeInputs(b.def)) {
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
      } else if (!u.path) {
        // can't reach the site right now — release the claim so another
        // builder (or this one, later) can take it, instead of it sitting
        // claimed-but-untouched forever
        if (!this.sendTo(u, d.x, d.y)) { s.builder = null; u.wstate = 'idle'; u.target = null; }
      }
      if (u.path) this.moveUnit(u, dt);
      return;
    }
    u.status = 'Idle';
    u.mesh.position.y = 0;
    // build prioritized sites first, then any other ready site; a claim whose
    // builder died or wandered off no longer blocks the site
    const claimable = (s: Site): boolean => {
      if (!s.ready) return false;
      if (s.builder && (s.builder.dead || s.builder.target !== s)) s.builder = null;
      return !s.builder;
    };
    let target: Site | null = null;
    for (const s of this.sites) { if (claimable(s) && s.priority) { target = s; break; } }
    if (!target) for (const s of this.sites) { if (claimable(s)) { target = s; break; } }
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
      else if (g.node === 'iron') ok = !!(t.dep && t.dep.kind === 'iron' && t.dep.amt > 0);
      if (!ok) continue;
      if (t.dep) {
        // ore heaps are solid: the miner works from a free neighbouring tile
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const sx = x + ox, sy = y + oy;
          if (!this.world.passable(sx, sy)) continue;
          const d = Math.hypot(sx - cx, sy - cy);
          if (d < bd) { bd = d; best = { x: sx, y: sy, depX: x, depY: y }; }
        }
      } else {
        const d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; best = { x, y }; }
      }
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
        if (b.prog >= 1) { b.prog = 0; b.working = false; b.out[def.recipe.out] = (b.out[def.recipe.out] || 0) + 1; this.objective?.onProduce(def.recipe.out, this.mods.objectiveWeight(def.recipe.out)); }
      } else {
        u.status = 'Waiting for materials';
        if (this.outTotal(b) < this.mods.outCap()) {
          const inp = this.mods.recipeInputs(def);
          let can = true;
          for (const k in inp) if ((b.inp[k] || 0) < (inp as any)[k]) can = false;
          if (can) { for (const k in inp) b.inp[k] -= (inp as any)[k]; b.working = true; b.prog = 0; }
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
        if (def.gather!.node === 'tree') {
          // coppice craft: take the trunk but leave the tree standing
          if (t.tree) { if (this.mods.preserveTrees()) t.tree.reserved = false; else this.removeTree(n.x, n.y); }
          this.setCarrying(u, 'trunk'); this.sfx('chop');
        }
        else if (def.gather!.node === 'field') { if (t.field) { t.field.growth = 0; this.view.refreshTile(n.x, n.y); this.view.scaleFieldCrop(t.field); } this.setCarrying(u, def.gather!.out ?? 'wheat'); this.sfx('harvest'); }
        else if (def.gather!.node === 'plant') {
          if (!t.tree && !t.b && !t.site && !t.road && !t.field && !t.dep) { if (t.deco) this.removeDeco(n.x, n.y); t.tree = { growth: 0.12, reserved: false, meshes: [], s: 0.85 + rnd() * 0.4, kind: Math.floor(rnd() * 4) }; this.view.addTree(n.x, n.y, t.tree); }
        } else if (def.gather!.node === 'fish') { this.setCarrying(u, def.gather!.out); this.sfx('harvest'); }
        else {
          // the miner stands beside the (solid) heap; the ore comes off the heap's tile
          const dtile = this.world.T(n.depX ?? n.x, n.depY ?? n.y);
          if (dtile?.dep) { dtile.dep.amt--; if (dtile.dep.amt <= 0) this.removeDep(n.depX ?? n.x, n.depY ?? n.y); }
          this.setCarrying(u, def.gather!.out);
        }
        u.wstate = 'return'; u.mesh.position.y = 0;
      }
      return;
    }
    if (u.wstate === 'return') {
      u.mesh.visible = true;
      const d = doorTile(b);
      if (u.tx === d.x && u.ty === d.y && !u.path) {
        if (u.carrying) { b.out[u.carrying] = (b.out[u.carrying] || 0) + 1; this.objective?.onProduce(u.carrying, this.mods.objectiveWeight(u.carrying)); this.setCarrying(u, null); }
        u.wstate = 'home';
      } else if (!u.path) { if (!this.sendTo(u, d.x, d.y)) { u.wstate = 'home'; this.setCarrying(u, null); } }
      if (u.path) this.moveUnit(u, dt);
      u.status = 'Returning';
    }
  }

  /**
   * An unposted villager ambles between spots near the village centre, pausing
   * between strolls. Purely cosmetic — a villager is plucked out of this loop the
   * moment `staffBuildings` assigns it to an unstaffed building.
   */
  private villagerStroll(u: Unit, dt: number): void {
    u.mesh.visible = true;
    if (u.wstate !== 'stroll' && u.wstate !== 'strollWait') { u.wstate = 'strollWait'; u.timer = rnd() * 2.5; }
    if (u.wstate === 'strollWait') {
      u.status = 'Idling in the village';
      u.mesh.position.y = 0;
      u.timer -= dt;
      if (u.timer > 0) return;
      const g = this.guild ?? this.store, cx = g.x + 1, cy = g.y + 1;
      for (let tries = 0; tries < 8; tries++) {
        const x = cx + Math.round((rnd() - 0.5) * 14), y = cy + Math.round((rnd() - 0.5) * 14);
        const t = this.world.T(x, y);
        if (!t || t.type !== 'grass' || t.b || t.site || t.dep) continue;
        if (this.sendTo(u, x, y)) { u.wstate = 'stroll'; return; }
      }
      u.timer = 1 + rnd() * 2;                 // nowhere to go — wait, then retry
      return;
    }
    // wstate === 'stroll'
    u.status = 'Strolling';
    if (u.path) this.moveUnit(u, dt);
    else { u.wstate = 'strollWait'; u.timer = 1.5 + rnd() * 3; }
  }

  // =====================================================================
  //  Growth
  // =====================================================================
  private growthUpdate(dt: number): void {
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    const fg = this.mods.fieldGrowth();
    for (const b of this.buildings) { if (b.def.fields) for (const f of b.fieldsList) { const t = tiles[f.y][f.x]; if (t.field && t.field.growth < 1) { t.field.growth += dt / 22 * fg; if (t.field.growth > 1) t.field.growth = 1; this.view.scaleFieldCrop(t.field); } } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[y][x];
      if (!t.tree || t.tree.growth >= 1) continue;
      t.tree.growth += dt / 40;
      if (t.tree.growth >= 1) { t.tree.growth = 1; this.view.treeMatured(x, y, t.tree); continue; }
      const s = t.tree.s * Math.max(0.15, t.tree.growth);
      const m = t.tree.meshes[0] as THREE.Object3D | undefined;
      if (m) m.scale.set(s, s, s);
    }
  }
  private fieldRecolor(): void { for (const b of this.buildings) { if (b.def.fields) for (const f of b.fieldsList) this.view.refreshTile(f.x, f.y); } }

  // =====================================================================
  //  Queries & placement
  // =====================================================================
  /** Total goods sitting in the storehouse (the end-of-level surplus tally). */
  stockTotal(): number {
    let n = 0;
    const s = this.store?.stock;
    if (s) for (const k in s) n += s[k];
    return n;
  }

  /** Player workers (non-fighters) currently well fed — the tavern tally. */
  wellFedWorkers(): number {
    let n = 0;
    for (const u of this.units) if (!u.dead && u.faction === 'player' && u.dmg === 0 && u.hunger >= 66) n++;
    return n;
  }

  countItem(item: string): number {
    const d = this.itemBreakdown(item);
    return d.store + d.buildings + d.carried;
  }

  /** Where an item currently sits: main storehouse vs. building inventories vs. in transit. */
  itemBreakdown(item: string): { store: number; buildings: number; carried: number } {
    let store = this.store.stock![item] || 0, buildings = 0, carried = 0;
    for (const b of this.buildings) { if (!b.def.store) buildings += (b.inp[item] || 0) + (b.out[item] || 0); }
    for (const u of this.units) if (u.carrying === item) carried++;
    return { store, buildings, carried };
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
    if (key === 'ironmine' && !this.depositInRange('iron', tx, ty, 9)) { this.toast('No iron deposits in range — build near the rusty rocks', 'err'); return; }
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
    const cost = this.mods.roadCost();
    if ((this.store.stock?.['stone'] || 0) < cost) {
      const now = Date.now();
      if (now - this.roadWarnT > 1500) { this.roadWarnT = now; this.toast('Out of stone — quarry more to build roads', 'err'); this.sfx('error'); }
      return;
    }
    this.store.stock!['stone'] -= cost;
    if (t.tree) this.removeTree(tx, ty);
    if (t.deco) this.removeDeco(tx, ty);
    t.road = true; this.mods.ctx.roadTiles++;
    this.view.refreshTile(tx, ty); this.view.addRoad(tx, ty);
  }

  demolishAt(tx: number, ty: number, dragOnly: boolean): void {
    const t = this.world.T(tx, ty); if (!t) return;
    if (t.road) { t.road = false; this.mods.ctx.roadTiles = Math.max(0, this.mods.ctx.roadTiles - 1); this.store.stock!['stone'] = (this.store.stock!['stone'] || 0) + this.mods.roadCost(); this.view.refreshTile(tx, ty); this.view.removeRoad(tx, ty); return; }
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
    if (b.rallyMesh) this.view.remove(b.rallyMesh);
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

  // ---------------------------------------------------------------------
  //  Coarse spatial hash (8×8-tile cells), rebuilt once per tick and shared
  //  by every proximity query: target acquisition, tower fire, fire volleys
  //  and projectile impacts. Queries pad by one cell so units that moved
  //  since the tick started are still found. O(n) build instead of the old
  //  O(n²) every-fighter-scans-every-unit — matters near the 1,600-unit cap.
  // ---------------------------------------------------------------------
  private hashCols = 0;
  private readonly unitHash = new Map<number, Unit[]>();

  private buildUnitHash(): void {
    this.unitHash.clear();
    this.hashCols = (this.world.W >> 3) + 2;
    for (const u of this.units) {
      if (u.dead) continue;
      const k = (u.ty >> 3) * this.hashCols + (u.tx >> 3);
      let c = this.unitHash.get(k);
      if (!c) { c = []; this.unitHash.set(k, c); }
      c.push(u);
    }
  }

  /** Visit live units whose tick-start tile is within ~r tiles of (tx, ty). */
  private forUnitsNear(tx: number, ty: number, r: number, fn: (o: Unit) => void): void {
    const c0 = Math.max(0, tx - r) >> 3, c1 = Math.max(0, tx + r) >> 3;
    const r0 = Math.max(0, ty - r) >> 3, r1 = Math.max(0, ty + r) >> 3;
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const cell = this.unitHash.get(cy * this.hashCols + cx);
      if (!cell) continue;
      for (const o of cell) fn(o);
    }
  }

  /** Nearest hostile fighter within the given aggro radius, or null. */
  private acquireTarget(u: Unit, aggro: number): Unit | null {
    let best: Unit | null = null, bd = aggro * aggro;
    this.forUnitsNear(u.tx, u.ty, Math.ceil(aggro) + 1, o => {
      if (o.dead || o === u) return;
      if (!this.hostile(u.faction, o.faction)) return;
      const dx = o.tx - u.tx, dy = o.ty - u.ty, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = o; }
    });
    return best;
  }

  private faceUnit(u: Unit, foe: Unit): void {
    const dx = foe.mesh.position.x - u.mesh.position.x, dz = foe.mesh.position.z - u.mesh.position.z;
    if (dx || dz) u.mesh.rotation.y = Math.atan2(dx, dz);
  }

  /** Apply damage to a unit: hurt feedback, retaliation, death. */
  private hurtUnit(source: Unit | null, victim: Unit, dmg: number): void {
    victim.hp -= dmg;
    this.onHurt(victim.mesh.position.x, victim.mesh.position.z, victim.faction);
    // retaliation: an idle victim turns on its attacker
    if (source && !source.dead && !victim.foe && this.hostile(victim.faction, source.faction)) victim.foe = source;
    if (victim.hp <= 0) this.killUnit(victim);
  }

  private attack(attacker: Unit, foe: Unit): void {
    attacker.lungeT = 0.22; // little hop into the swing
    if (this.swingsSteel(attacker)) this.sfx('sword');
    this.hurtUnit(attacker, foe, attacker.dmg);
  }

  /** Melee humans (soldiers, knights, bandits) clash steel; beasts stay mute. */
  private swingsSteel(u: Unit): boolean {
    const def = UNITS[u.role as UnitKind];
    return !!def && def.model === 'human' && !def.arrows;
  }

  private killUnit(u: Unit): void {
    if (u.dead) return;
    u.dead = true;
    this.onDeath(u.mesh.position.x, u.mesh.position.z, u.faction, u.colorHex, u.role, u.mesh.scale.x || 1);
    this.onKill(u);
    this.objective?.onKill(u.role, u.faction);
    for (const o of this.units) if (o.foe === u) o.foe = null;
  }

  private combatUpdate(u: Unit, dt: number): void {
    const def = UNITS[u.role as UnitKind];
    const flying = !!def.flying;
    u.atkTimer = Math.max(0, u.atkTimer - dt);
    if (u.lungeT > 0) u.lungeT = Math.max(0, u.lungeT - dt);
    if (flying) this.animateFlight(u, dt);
    if (def.fire) this.fireVolley(u, dt);

    // wild beasts leash: a chase that strays too far from home is abandoned
    if (u.faction === 'wild' && def.leash && u.anchor) {
      const da = Math.hypot(u.tx - u.anchor.x, u.ty - u.anchor.y);
      if (u.wstate === 'leash') {
        if (da < 3) { u.wstate = 'idle'; }
        else {
          if (!u.path) this.sendTo(u, u.anchor.x, u.anchor.y);
          this.moveUnit(u, dt);
          u.status = 'Heading home';
          return;
        }
      } else if (da > def.leash) { u.wstate = 'leash'; u.foe = null; u.path = null; return; }
    }

    let foe = u.foe;
    if (foe && foe.dead) foe = null;
    if (u.order && u.order.type === 'attack' && u.order.foe && !u.order.foe.dead) foe = u.order.foe;
    // pure 'move' orders don't auto-seek (lets you march past enemies); everything else does
    const canSeek = !u.order || u.order.type !== 'move';
    if (!foe && canSeek) foe = this.acquireTarget(u, def.aggro);
    u.foe = foe;

    if (foe) {
      // big foes are easier to reach — extend melee reach by their bulk
      const reach = u.range + 0.1 + Math.max(0, ((foe.mesh.scale.x || 1) - 1)) * 0.4;
      const d = this.unitDist(u, foe);
      if (d <= reach) {
        u.path = null;
        this.faceUnit(u, foe);
        this.groundPose(u, flying);
        if (u.atkTimer <= 0) {
          u.atkTimer = u.atkCd;
          if (def.arrows) this.fireArrow(u, u.faction, u.mesh.position.x, 0.6, u.mesh.position.z, foe, u.dmg);
          else this.attack(u, foe);
        }
      } else if (flying) {
        this.moveFlying(u, dt, foe.mesh.position.x, foe.mesh.position.z);
      } else {
        // chase — throttle A* so hundreds of pursuers don't re-path every tick;
        // charging beasts (boars) put on a burst of speed
        if (!u.path) { u.timer -= dt; if (u.timer <= 0) { this.sendTo(u, foe.tx, foe.ty); u.timer = 0.4 + rnd() * 0.35; } }
        this.moveUnit(u, def.charge ? dt * def.charge : dt);
        u.status = 'Fighting';
      }
      return;
    }

    // no unit foe: go for a hostile building (the castle for raiders & the dragon,
    // camps for the player army)
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
        this.groundPose(u, flying);
        if (u.atkTimer <= 0) { u.atkTimer = u.atkCd; u.lungeT = 0.22; this.attackBuilding(u, bt); }
      } else if (flying) {
        this.moveFlying(u, dt, c.x, c.z);
      } else {
        // besiege: head for a free tile around the walls, not everyone to the door
        if (!u.path) { u.timer -= dt; if (u.timer <= 0) { const s = this.siegeTile(u, bt); this.sendTo(u, s.x, s.y); u.timer = 0.5 + rnd() * 0.4; } }
        this.moveUnit(u, dt);
      }
      return;
    }

    // no foe: follow a move/attack-move order, wander near home, or hold
    if (u.order && (u.order.type === 'move' || u.order.type === 'attackMove')) {
      if (flying) {
        if (this.moveFlying(u, dt, this.world.wx(u.order.x), this.world.wz(u.order.y))) u.order = null;
        return;
      }
      if (!u.path) {
        if (u.tx === u.order.x && u.ty === u.order.y) { u.order = null; }
        else if (!this.sendTo(u, u.order.x, u.order.y)) { u.order = null; }
      }
      if (u.path) this.moveUnit(u, dt); else this.groundPose(u, flying);
    } else if (def.wander) {
      this.wander(u, dt);
    } else {
      this.groundPose(u, flying);
    }
  }

  /** Resting pose between swings: melee units hop into each attack, fliers hover. */
  private groundPose(u: Unit, flying: boolean): void {
    if (flying) return; // animateFlight owns the y of a flier
    u.mesh.position.y = u.lungeT > 0 ? Math.sin((1 - u.lungeT / 0.22) * Math.PI) * 0.12 : 0;
  }

  /** Idle beasts & camp guards amble around their anchor, pausing to root & graze. */
  private wander(u: Unit, dt: number): void {
    if (u.path) { this.moveUnit(u, dt); u.status = 'Roaming'; return; }
    u.mesh.position.y = 0;
    u.status = 'Grazing';
    u.timer -= dt;
    if (u.timer > 0) return;
    u.timer = 1.5 + rnd() * 4;
    const a = u.anchor ?? { x: u.tx, y: u.ty };
    for (let tries = 0; tries < 6; tries++) {
      const x = a.x + Math.round((rnd() - 0.5) * 8), y = a.y + Math.round((rnd() - 0.5) * 8);
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep) continue;
      if (this.sendTo(u, x, y)) return;
    }
  }

  private buildingCenter(b: Building): { x: number; z: number } {
    return { x: this.world.wx(b.x) + 0.5, z: this.world.wz(b.y) + 0.5 };
  }

  /** The building a fighter should march on: raiders (and the dragon) storm the
   *  nearest player building, the player army razes the nearest enemy stronghold
   *  in reach. Non-raiding beasts and camp guards leave walls alone. */
  private buildingTargetFor(u: Unit): Building | null {
    if (u.faction !== 'player' && !u.raider) return null;
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

  /** A free tile on the ring around a building's 2×2 footprint, salted per unit
   *  so a squad surrounds the walls instead of stacking at the door. */
  private siegeTile(u: Unit, b: Building): Coord {
    let best: Coord | null = null, bd = 1e9;
    for (let y = b.y - 1; y <= b.y + 2; y++) for (let x = b.x - 1; x <= b.x + 2; x++) {
      if (x >= b.x && x <= b.x + 1 && y >= b.y && y <= b.y + 1) continue;
      if (!this.world.passable(x, y)) continue;
      const salt = ((x * 31 + y * 17 + u.tx * 7 + u.ty * 3) % 5) * 0.8;
      const dd = Math.hypot(x - u.tx, y - u.ty) + salt;
      if (dd < bd) { bd = dd; best = { x, y } }
    }
    return best ?? doorTile(b);
  }

  private attackBuilding(u: Unit, b: Building): void {
    if (this.swingsSteel(u)) this.sfx('sword');
    b.hp -= u.dmg;
    this.onHurt(this.buildingCenter(b).x, this.buildingCenter(b).z, b.faction);
    if (b.hp <= 0) this.destroyBuilding(b);
  }

  private destroyBuilding(b: Building): void {
    if (b.removed) return;
    const c = this.buildingCenter(b);
    for (let i = 0; i < 4; i++) this.onDeath(c.x + (rnd() - 0.5) * 1.4, c.z + (rnd() - 0.5) * 1.4, b.faction, b.def.roof, 'serf', 1);
    this.objective?.onStructureDestroyed(b.faction);
    for (const o of this.units) if (o.foeB === b) o.foeB = null;
    const isCastle = b === this.store;
    this.removeBuilding(b);
    this.toast(b.def.name + (b.faction === 'player' ? ' has fallen!' : ' destroyed!'), 'err');
    if (isCastle) this.defeat = true;
  }

  /** A fire-wielder's periodic volley (dragon breath, demon magic): fire gobs
   *  spat at whatever it is fighting (or the nearest player building),
   *  splashing flame where they land. */
  private fireVolley(u: Unit, dt: number): void {
    u.special -= dt;
    if (u.special > 0) return;
    let tx: number | null = null, tz = 0;
    const foe = u.foe && !u.foe.dead ? u.foe : this.acquireTarget(u, 8);
    if (foe) { tx = foe.mesh.position.x; tz = foe.mesh.position.z; }
    else {
      const bt = u.foeB && !u.foeB.removed ? u.foeB : null;
      if (bt) { const c = this.buildingCenter(bt); const d = Math.hypot(c.x - u.mesh.position.x, c.z - u.mesh.position.z); if (d < 9) { tx = c.x; tz = c.z; } }
    }
    if (tx === null) { u.special = 1; return; } // nothing worth torching — check again soon
    const mx = u.mesh.position.x, mz = u.mesh.position.z;
    const my = 1.6 * (u.mesh.scale.y || 1);
    for (let i = 0; i < 5; i++) {
      const ang = rnd() * Math.PI * 2, rr = rnd() * 1.3;
      this.fireFlame(u, u.faction, mx, my, mz, tx + Math.cos(ang) * rr, tz + Math.sin(ang) * rr, 12);
    }
    this.sfx('error');
    u.special = 5;
  }

  // =====================================================================
  //  Projectiles — arrows arc from archers & towers, fire gobs from the dragon
  // =====================================================================
  private readonly projectiles: {
    mesh: THREE.Object3D;
    sx: number; sy: number; sz: number;
    ex: number; ey: number; ez: number;
    t: number; dur: number; arc: number;
    from: Faction; shooter: Unit | null; target: Unit | null;
    dmg: number; kind: 'arrow' | 'fire';
  }[] = [];
  private readonly flames: { mesh: THREE.Object3D; life: number; max: number }[] = [];

  /** Loose an arrow at a unit; damage lands when the arrow does. */
  private fireArrow(shooter: Unit | null, from: Faction, x: number, y: number, z: number, target: Unit, dmg: number): void {
    const tx = target.mesh.position.x, tz = target.mesh.position.z;
    const dist = Math.hypot(tx - x, tz - z);
    const mesh = this.view.createArrow();
    mesh.position.set(x, y, z);
    this.sfx('arrow');
    this.projectiles.push({
      mesh, sx: x, sy: y, sz: z, ex: tx, ey: 0.35, ez: tz,
      t: 0, dur: Math.max(0.16, dist / 11), arc: Math.min(1.3, 0.15 + dist * 0.08),
      from, shooter, target, dmg, kind: 'arrow',
    });
  }

  /** Spit a gob of dragon fire at a ground point; it splashes where it lands. */
  private fireFlame(shooter: Unit | null, from: Faction, x: number, y: number, z: number, ex: number, ez: number, dmg: number): void {
    const dist = Math.hypot(ex - x, ez - z);
    const mesh = this.view.createFireball();
    mesh.position.set(x, y, z);
    this.projectiles.push({
      mesh, sx: x, sy: y, sz: z, ex, ey: 0.1, ez,
      t: 0, dur: Math.max(0.25, dist / 8), arc: 0.5,
      from, shooter, target: null, dmg, kind: 'fire',
    });
  }

  private updateProjectiles(sdt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      // arrows home gently onto their moving target so shots connect
      if (p.target && !p.target.dead) { p.ex = p.target.mesh.position.x; p.ez = p.target.mesh.position.z; }
      p.t += sdt;
      const k = Math.min(1, p.t / p.dur);
      const x = p.sx + (p.ex - p.sx) * k;
      const z = p.sz + (p.ez - p.sz) * k;
      const y = p.sy + (p.ey - p.sy) * k + Math.sin(k * Math.PI) * p.arc;
      const dx = x - p.mesh.position.x, dy = y - p.mesh.position.y, dz = z - p.mesh.position.z;
      if (dx || dz) { p.mesh.rotation.y = Math.atan2(dx, dz); p.mesh.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz)); }
      p.mesh.position.set(x, y, z);
      if (k < 1) continue;
      this.view.remove(p.mesh);
      this.projectiles.splice(i, 1);
      this.impact(p);
    }
  }

  private impact(p: { ex: number; ez: number; from: Faction; shooter: Unit | null; target: Unit | null; dmg: number; kind: 'arrow' | 'fire' }): void {
    const W = this.world.W, H = this.world.H;
    const itx = Math.max(0, Math.min(W - 1, Math.round(p.ex + W / 2 - 0.5)));
    const ity = Math.max(0, Math.min(H - 1, Math.round(p.ez + H / 2 - 0.5)));
    if (p.kind === 'fire') {
      // splash: scorch hostile units & buildings around the landing point
      this.forUnitsNear(itx, ity, 4, o => {
        if (o.dead || !this.hostile(p.from, o.faction)) return;
        const dx = o.mesh.position.x - p.ex, dz = o.mesh.position.z - p.ez;
        if (dx * dx + dz * dz <= 1.3 * 1.3) this.hurtUnit(p.shooter, o, p.dmg);
      });
      for (const b of this.buildings) {
        if (b.removed || !this.hostile(p.from, b.faction)) continue;
        const c = this.buildingCenter(b);
        const dx = c.x - p.ex, dz = c.z - p.ez;
        if (dx * dx + dz * dz <= 1.7 * 1.7) { b.hp -= p.dmg; this.onHurt(c.x, c.z, b.faction); if (b.hp <= 0) this.destroyBuilding(b); }
      }
      const mesh = this.view.createFlame();
      mesh.position.set(p.ex, 0, p.ez);
      this.flames.push({ mesh, life: 1.1, max: 1.1 });
      return;
    }
    // arrow: hit the tracked target if it's still close, else whoever is standing there
    if (p.target && !p.target.dead && Math.hypot(p.target.mesh.position.x - p.ex, p.target.mesh.position.z - p.ez) < 0.7) {
      this.hurtUnit(p.shooter, p.target, p.dmg);
      return;
    }
    let best: Unit | null = null, bd = 0.6 * 0.6;
    this.forUnitsNear(itx, ity, 3, o => {
      if (o.dead || !this.hostile(p.from, o.faction)) return;
      const dx = o.mesh.position.x - p.ex, dz = o.mesh.position.z - p.ez, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = o; }
    });
    if (best) this.hurtUnit(p.shooter, best as Unit, p.dmg);
  }

  /** Flames flare where dragon fire lands, then gutter out. */
  private updateFlames(sdt: number): void {
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.life -= sdt;
      if (f.life <= 0) { this.view.remove(f.mesh); this.flames.splice(i, 1); continue; }
      const k = f.life / f.max;
      f.mesh.scale.setScalar(0.6 + 0.7 * Math.sin(Math.min(1, (1 - k) * 3) * Math.PI * 0.5));
      f.mesh.traverse((o: any) => { if (o.material && o.material.transparent) o.material.opacity = 0.9 * k; });
    }
  }

  // =====================================================================
  //  Separation — units softly shoulder each other aside, never stacking
  // =====================================================================
  private separate(dt: number): void {
    const W = this.world.W;
    const cells = new Map<number, Unit[]>();
    const list: Unit[] = [];
    for (const u of this.units) {
      if (u.dead || !u.mesh.visible) continue;
      list.push(u);
      const k = u.ty * W + u.tx;
      let c = cells.get(k);
      if (!c) { c = []; cells.set(k, c); }
      c.push(u);
    }
    const push = Math.min(1, dt * 6);
    for (const u of list) {
      // stationary workers hold their spot; fliers are above the crowd
      if (u.wstate === 'gather' || u.wstate === 'build') continue;
      if ((UNITS as Partial<Record<string, { flying?: boolean }>>)[u.role]?.flying) continue;
      const ru = 0.3 * (u.mesh.scale.x || 1);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const c = cells.get((u.ty + oy) * W + (u.tx + ox));
        if (!c) continue;
        for (const o of c) {
          if (o === u) continue;
          const dx = o.mesh.position.x - u.mesh.position.x, dz = o.mesh.position.z - u.mesh.position.z;
          const r = ru + 0.3 * (o.mesh.scale.x || 1);
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          let nx: number, nz: number;
          const d = Math.sqrt(d2);
          if (d < 1e-4) { // dead-on overlap: split along a deterministic axis
            const ax = ((u.tx + o.ty) % 2) * 2 - 1, az = ((u.ty + o.tx) % 2) * 2 - 1;
            const l = Math.hypot(ax, az); nx = ax / l; nz = az / l;
          } else { nx = dx / d; nz = dz / d; }
          // each of the pair sees the other and steps back its own half
          const overlap = (r - d) * 0.5 * push;
          this.nudge(u, -nx * overlap, -nz * overlap);
        }
      }
    }
  }

  /** Shift a unit if the destination isn't water or inside a building/site. */
  private nudge(u: Unit, dx: number, dz: number): void {
    const W = this.world.W, H = this.world.H;
    const radius = 0.3 * (u.mesh.scale.x || 1);
    const nxp = Math.max(-W / 2 + radius, Math.min(W / 2 - radius, u.mesh.position.x + dx));
    const nzp = Math.max(-H / 2 + radius, Math.min(H / 2 - radius, u.mesh.position.z + dz));
    const tx = Math.max(0, Math.min(W - 1, Math.round(nxp + W / 2 - 0.5)));
    const ty = Math.max(0, Math.min(H - 1, Math.round(nzp + H / 2 - 0.5)));
    const t = this.world.tiles[ty][tx];
    if (t.type !== 'grass' || t.b || t.site || t.dep) return;
    u.mesh.position.x = nxp; u.mesh.position.z = nzp;
    u.tx = tx; u.ty = ty;
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
    u.foeB = null;
    u.path = null;
  }

  /** Order a whole selection: attacks converge on the foe, moves fan out into a
   *  loose formation so the squad doesn't pile onto a single tile. */
  orderGroup(units: Unit[], type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null, formation: Formation = 'grid'): void {
    if (type === 'attack' && foe) {
      for (const u of units) this.orderUnit(u, 'attack', foe.tx, foe.ty, foe);
      return;
    }
    const spots = formationSpots(x, y, units.length, formation, units.map(u => ({ x: u.tx, y: u.ty })), (tx, ty) => {
      const t = this.world.T(tx, ty);
      return !!t && t.type === 'grass' && !t.b && !t.site && !t.dep;
    });
    for (let i = 0; i < units.length; i++) {
      const s = spots[Math.min(i, spots.length - 1)];
      this.orderUnit(units[i], type, s.x, s.y);
    }
  }

  /** Plant (or move) a military building's rally flag — freshly trained fighters
   *  march there on their own. */
  setRally(b: Building, x: number, y: number): void {
    if (!b.def.military || b.removed) return;
    b.rally = { x, y };
    if (!b.rallyMesh) b.rallyMesh = this.view.createFlag();
    b.rallyMesh.position.set(this.world.wx(x), 0, this.world.wz(y));
    this.toast('Rally point set — trained fighters will muster there');
    this.sfx('click');
  }

  /** Scatter `count` fighters of a kind around a world point (sandbox/level spawner). */
  spawnSquad(kind: UnitKind, count: number, worldX: number, worldZ: number, faction?: Faction): Unit[] {
    const W = this.world.W, H = this.world.H;
    const cx = Math.max(2, Math.min(W - 3, Math.floor(worldX + W / 2)));
    const cy = Math.max(2, Math.min(H - 3, Math.floor(worldZ + H / 2)));
    const out: Unit[] = [];
    const tryTile = (x: number, y: number): void => {
      if (out.length >= count || this.units.length >= MAX_UNITS) return; // cap for perf
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep) return;
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
  /** Sim time the armed muster-triggered wave lands at (null = not armed yet). */
  private waveArmT: number | null = null;
  /** Extra seconds granted to the level's hard timer (waves with bonusTime). */
  bonusTime = 0;

  /** Configure and spawn a level's enemy presence (called by main after init). */
  setEnemies(setup: EnemySetup | null): void {
    this.enemy = setup;
    this.waveIdx = 0; this.waves = []; this.commanderT = 0; this.camps = [];
    this.waveArmT = null; this.bonusTime = 0;
    if (!setup) return;
    if (setup.wild) for (const w of setup.wild) this.spawnWild(w.kind, w.count);
    if (setup.camps) for (const c of setup.camps) for (let i = 0; i < c.count; i++) this.spawnStronghold('banditcamp', c.guards);
    if (setup.keep) { const camp = this.spawnStronghold('enemycastle', setup.keep.guards); if (camp && setup.towers) for (let i = 0; i < setup.towers; i++) this.spawnTowerNear(camp); }
    if (setup.boss) this.spawnBoss(setup.boss);
  }

  /** Player-faction fighters currently alive (arming muster-triggered raids). */
  private playerFighters(): number {
    let n = 0;
    for (const u of this.units) if (!u.dead && u.faction === 'player' && u.dmg > 0) n++;
    return n;
  }

  /**
   * The next scheduled raid wave for the HUD countdown: seconds until it lands
   * plus its size, or (for a muster-triggered raid that hasn't armed yet) a
   * label telling the player what will provoke it.
   */
  nextWave(): { in: number; count: number; label?: string } | null {
    const w = this.enemy?.waves;
    if (!w || this.waveIdx >= w.length) return null;
    const def = w[this.waveIdx];
    if (def.at !== undefined) return { in: Math.max(0, def.at - this.elapsed), count: def.count };
    if (this.waveArmT !== null) return { in: Math.max(0, this.waveArmT - this.elapsed), count: def.count };
    return { in: Infinity, count: def.count, label: `Raiders are watching — mustering ${def.whenArmy ?? 1} fighters will provoke them` };
  }

  private combatDirector(sdt: number): void {
    if (!this.enemy) return;
    // launch scheduled raid waves at the castle. Waves are sequential: the
    // head wave launches on its trigger (a timestamp, or the player's muster
    // reaching size + a grace delay), then the next takes its place.
    const w = this.enemy.waves;
    while (w && this.waveIdx < w.length) {
      const def = w[this.waveIdx];
      let launch = false;
      if (def.at !== undefined) launch = this.elapsed >= def.at;
      else if (this.waveArmT !== null) launch = this.elapsed >= this.waveArmT;
      else if (this.playerFighters() >= (def.whenArmy ?? 1)) {
        this.waveArmT = this.elapsed + (def.delay ?? 45);
        this.toast('Your muster has been spotted — raiders are gathering!', 'err');
        this.sfx('error');
      }
      if (!launch) break;
      this.waveIdx++;
      this.waveArmT = null;
      if (def.bonusTime) { this.bonusTime += def.bonusTime; this.toast(`+${def.bonusTime}s on the clock for the fight ahead`); }
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
  }

  /** Every tower (any faction) looses arrows at the nearest hostile fighter in range. */
  private towerFire(sdt: number): void {
    for (const b of this.buildings) {
      const tw = b.def.tower;
      if (!tw || b.removed || !b.active) continue;
      b.prog += sdt;
      if (b.prog < tw.rate) continue;
      const c = this.buildingCenter(b);
      let best: Unit | null = null, bd = tw.range * tw.range;
      this.forUnitsNear(b.x, b.y, Math.ceil(tw.range) + 2, u => {
        if (u.dead || !this.hostile(b.faction, u.faction) || u.dmg <= 0) return;
        const dx = u.mesh.position.x - c.x, dz = u.mesh.position.z - c.z, d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = u; }
      });
      if (!best) continue; // stay drawn until something wanders into range
      b.prog = 0;
      this.fireArrow(null, b.faction, c.x, 2.1, c.z, best, tw.dmg);
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

  /** Extra wild presence from a level mutator (e.g. Wolf Country's packs). */
  spawnMutatorWild(kind: UnitKind, count: number): void { this.spawnWild(kind, count); }

  /** Scatter wild beasts across the map, well clear of the starting settlement
   *  so nobody is in a fight before they've trained a single unit. */
  private spawnWild(kind: UnitKind, count: number): void {
    const W = this.world.W, H = this.world.H, cx = W / 2, cy = H / 2;
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      const x = 2 + Math.floor(rnd() * (W - 4)), y = 2 + Math.floor(rnd() * (H - 4));
      if (Math.abs(x - cx) < 12 && Math.abs(y - cy) < 12) continue;
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep) continue;
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
        if (this.areaClear(x, y)) { const t = this.placeBuilding('enemywatchtower', x, y, true, 0, 'enemy'); t.active = true; return; }
      }
    }
  }

  private spawnBoss(kind: UnitKind): void {
    // on frontier maps the boss broods in the walled-off enemy quarter and
    // stays there — the player picks when to march in and start that fight
    const ez = this.world.enemyZone;
    if (ez) {
      this.spawnSquad(kind, 1, this.world.wx(ez.x), this.world.wz(ez.y), UNITS[kind].faction);
      this.toast(`The ${UNITS[kind].name} broods in its mountain lair — muster before you march`, 'err');
      return;
    }
    const e = this.randomEdge();
    const squad = this.spawnSquad(kind, 1, e.x, e.z, UNITS[kind].faction);
    const castle = this.store;
    for (const u of squad) { u.raider = true; if (castle) this.orderUnit(u, 'attackMove', castle.x + 1, castle.y + 1); }
    this.toast(`The ${UNITS[kind].name} descends upon Het Gooi!`, 'err');
  }

  private areaClear(tx: number, ty: number): boolean {
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) {
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep || t.road) return false;
    }
    return true;
  }

  private findStrongholdSpot(): { x: number; y: number } | null {
    const W = this.world.W, H = this.world.H, cx = W / 2, cy = H / 2;
    // frontier maps: strongholds live inside the walled-off enemy quarter
    const ez = this.world.enemyZone;
    if (ez) {
      for (let tries = 0; tries < 400; tries++) {
        const x = ez.x + Math.floor((rnd() * 2 - 1) * ez.r), y = ez.y + Math.floor((rnd() * 2 - 1) * ez.r);
        if (x < 2 || y < 2 || x > W - 4 || y > H - 4) continue;
        if (Math.hypot(x - ez.x, y - ez.y) > ez.r) continue;
        if (this.areaClear(x, y)) return { x, y };
      }
      // the quarter can be waterlogged on a wet seed — fall through to anywhere
    }
    for (let tries = 0; tries < 400; tries++) {
      const x = 2 + Math.floor(rnd() * (W - 5)), y = 2 + Math.floor(rnd() * (H - 5));
      if (Math.abs(x - cx) < 12 && Math.abs(y - cy) < 12) continue; // keep clear of the player's start
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
  private taxT = 0;

  update(sdt: number): void {
    this.elapsed += sdt;
    this.buildUnitHash(); // shared by all proximity queries this tick
    this.dispatchT += sdt;
    if (this.dispatchT > 0.45) { this.dispatchT = 0; this.dispatch(); }
    // the Taxman mutator collects on the minute
    const tax = this.mods.taxPerMin();
    if (tax > 0) {
      this.taxT += sdt;
      if (this.taxT >= 60) { this.taxT -= 60; this.onGold(-tax); this.toast(`The Taxman collects ${tax} gold`, 'err'); }
    }
    const hungerRate = this.mods.hungerRate();
    for (const u of this.units) {
      if (u.dead) continue;
      u.hunger = Math.max(0, u.hunger - sdt * 100 / 600 * hungerRate);
      if (this.isFighter(u)) this.combatUpdate(u, sdt);
      else if (u.role === 'serf') this.serfUpdate(u, sdt);
      else if (u.role === 'laborer') this.laborerUpdate(u, sdt);
      else if (u.role === 'villager' && !u.home) this.villagerStroll(u, sdt);
      else this.workerUpdate(u, sdt);
    }
    this.separate(sdt);
    this.updateProjectiles(sdt);
    this.updateFlames(sdt);
    this.sweepDead();
    this.growthUpdate(sdt);
    this.serveTaverns(sdt);
    this.trainQueues(sdt);
    this.staffBuildings();
    this.combatDirector(sdt);
    this.towerFire(sdt); // towers watch on every level, with or without a director
    this.fieldT += sdt;
    if (this.fieldT > 0.5) { this.fieldT = 0; this.fieldRecolor(); }
  }

  /** Queue a unit at a barracks/guild hall, paying its own cost from the store. */
  trainUnit(b: Building, kind: string): boolean {
    const spec = b.def.military ?? b.def.trainer;
    const t = spec?.units.find(s => s.kind === kind);
    if (!t || !b.active) return false;
    const store = this.store;
    if (!store || !store.stock) return false;
    for (const k in t.cost) if ((store.stock[k] || 0) < (t.cost as any)[k]) { this.toast('Not enough ' + ITEMS[k as keyof typeof ITEMS].name.toLowerCase() + ' to train a ' + unitLabel(kind).toLowerCase(), 'err'); this.sfx('error'); return false; }
    for (const k in t.cost) store.stock[k] -= (t.cost as any)[k];
    (b.trainQ ||= []).push(kind);
    this.sfx('click');
    return true;
  }

  /** Cancel a queued training order by index, refunding its cost to the store. */
  cancelTrain(b: Building, index: number): void {
    if (!b.trainQ || index < 0 || index >= b.trainQ.length) return;
    const spec = b.def.military ?? b.def.trainer;
    const t = spec?.units.find(s => s.kind === b.trainQ![index]);
    b.trainQ.splice(index, 1);
    if (index === 0) b.prog = 0;           // scrap progress on the in-flight unit
    if (t && this.store?.stock) for (const k in t.cost) this.store.stock[k] = (this.store.stock[k] || 0) + (t.cost as any)[k];
    this.sfx('click');
  }

  /** Spawn a civilian worker (serf / laborer / villager) at a tile. */
  private spawnCivilian(role: string, tile: { x: number; y: number }): Unit {
    if (role === 'serf') return this.spawnUnit('serf', 0xd8c49a, tile);
    if (role === 'laborer') { const u = this.spawnUnit('laborer', 0xc97b3d, tile); u.roleName = 'Builder'; return u; }
    const u = this.spawnUnit('villager', 0xcdbb8f, tile); u.roleName = 'Villager'; u.status = 'Awaiting a post'; return u;
  }

  /** Barracks & guild halls turn their player-built queue into units over time. */
  private trainQueues(sdt: number): void {
    for (const b of this.buildings) {
      const spec = b.def.military ?? b.def.trainer;
      if (!spec || !b.active) continue;
      if (!b.trainQ || !b.trainQ.length) { b.prog = 0; continue; }
      const head = spec.units.find(s => s.kind === b.trainQ![0]);
      const time = (head?.time ?? 6) * this.mods.trainTime(b.trainQ[0]);
      b.prog += sdt / time;
      if (b.prog >= 1) {
        b.prog = 0;
        const kind = b.trainQ.shift()!;
        const d = doorTile(b);
        if ((UNITS as any)[kind]) {
          const u = this.spawnFighter(kind as UnitKind, { x: d.x, y: d.y }, 'player');
          if (b.rally) this.orderUnit(u, 'attackMove', b.rally.x, b.rally.y); // muster at the flag
        } else this.spawnCivilian(kind, { x: d.x, y: d.y });
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
      // tavern tithe: the taproom pays out per meal served
      const tithe = this.mods.goldPerMeal();
      if (tithe > 0 && fed.length) { this.onGold(tithe * fed.length); this.sfx('coin'); }
    }
  }
}
