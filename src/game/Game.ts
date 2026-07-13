import * as THREE from 'three';
import { ROAD_STONE_COST, PLOT_RANGE, BASE_SPEED, MAX_UNITS } from '../constants';
import { DEFS } from '../data/buildings';
import { ITEMS, MARKET_VALUES } from '../data/items';
import { UNITS, damageMultiplier, formationRank, structureDamage, type UnitKind } from '../data/units';
import type { EnemySetup } from '../data/levels';
import { simRng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import { buildFlowField, fieldPath, type FlowField } from '../engine/flowfield';
import { formationSpots } from '../engine/formations';
import type { World } from '../world/World';
import type { View } from '../render/View';
import { PLAYER_IDS, type Building, type BuildingKey, type Coord, type Faction, type Formation, type ItemKey, type OwnerId, type PlayerId, type Site, type Unit, type UnitOrder } from '../types';
import { buildingEntranceTiles, doorTile, unitLabel } from './util';
import { Modifiers } from './Modifiers';
import type { Objective } from './Objectives';
import { canControl, ownerForFaction } from './ownership';
import { TRADE, tradeEta, tradeLoadTime, tradePartner, tradeShipmentActive, type TradeHistoryEntry, type TradeRequest, type TradeShipment } from './trade';
import { applyGameCommand } from './commands';
import type { GameCommand } from '../net/protocol';

// Gameplay events use the sim stream (reseeded per level), never worldgen/cosmetic.
const rnd = () => simRng.next();

/** Selections at or above this size share one flow field per order instead of
 *  running one global A* per unit. Below it the flood costs more than it saves. */
const FLOW_FIELD_MIN_UNITS = 8;

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
  readonly playerStores = new Map<PlayerId, Building>();
  readonly playerGuilds = new Map<PlayerId, Building>();
  readonly playerHeroes = new Map<PlayerId, Unit>();
  selected: any = null;
  simSpeed = 1;
  /** The run's mounted hero on this level (null in sandbox / before spawn). */
  heroUnit: Unit | null = null;
  /** Seconds until a fallen hero rides back out of the castle (0 = alive/none). */
  heroRespawnT = 0;
  private heroId: string | null = null;
  private heroName = 'Hero';

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
  /** Decorative traders are not Units, so combat cannot target or kill them. */
  private readonly caravans: { mesh: THREE.Group; market: Building; item: ItemKey; amount: number; state: 'arriving' | 'trading' | 'leaving'; edgeX: number; edgeZ: number; wait: number }[] = [];
  private dispatchT = 0;
  private fieldT = 0;
  private roadWarnT = 0;
  private plotWarnT = 0;
  private nextEntityId = 1;

  constructor(
    private readonly world: World,
    private readonly view: View,
    readonly mods: Modifiers = new Modifiers(),
    readonly localPlayerId: PlayerId = 'p1',
  ) {}

  entityById(id: number): Building | Site | Unit | null {
    return this.buildings.find(entity => entity.id === id)
      ?? this.sites.find(entity => entity.id === id)
      ?? this.units.find(entity => entity.id === id)
      ?? null;
  }

  /**
   * Input-side boundary: UI and Controls submit gameplay intents here rather
   * than mutating the sim directly. Singleplayer applies immediately; co-op
   * (main.ts) swaps this sink for the host-ordered relay so both peers apply
   * the same accepted command stream.
   */
  submitCommand: (command: GameCommand) => void = command => {
    applyGameCommand(this, this.localPlayerId, command);
  };

  ownedByLocal(entity: { owner: OwnerId }): boolean {
    return canControl(this.localPlayerId, entity.owner);
  }

  // =====================================================================
  //  Setup
  // =====================================================================
  init(kit: StartKit = DEFAULT_KIT): void {
    this.indexPickups();
    const { x: cx, y: cy } = this.world.playerStart;
    this.initSettlement(this.localPlayerId, kit, cx, cy);
    this.store = this.playerStores.get(this.localPlayerId)!;
    this.guild = this.playerGuilds.get(this.localPlayerId)!;
  }

  /** Two deterministic allied starts with fully separate ownership and stock. */
  initCoOp(p1Kit: StartKit = DEFAULT_KIT, p2Kit: StartKit = DEFAULT_KIT): void {
    this.indexPickups();
    const { W, H } = this.world;
    const cy = Math.floor(H / 2) - 1;
    this.initSettlement('p1', p1Kit, Math.max(3, Math.floor(W * 0.28) - 1), cy);
    this.initSettlement('p2', p2Kit, Math.min(W - 6, Math.floor(W * 0.72) - 1), cy);
    this.store = this.playerStores.get('p1')!;
    this.guild = this.playerGuilds.get('p1')!;
  }

  storeFor(owner: PlayerId): Building {
    const store = this.playerStores.get(owner);
    if (!store) throw new Error(`No store exists for ${owner}`);
    return store;
  }

  private indexPickups(): void {
    if (this.pickups.length) return;
    const { W, H } = this.world;
    const tiles = this.world.tiles;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tiles[y][x].pickup) this.pickups.push({ x, y });
  }

  private initSettlement(owner: PlayerId, kit: StartKit, cx: number, cy: number): void {
    const tiles = this.world.tiles;
    for (let y = cy - 1; y < cy + 5; y++) for (let x = cx - 2; x < cx + 5; x++) {
      const t = this.world.T(x, y); if (!t) continue;
      if (t.tree) this.removeTree(x, y);
      if (t.dep) this.removeDep(x, y);
      if (t.deco) this.removeDeco(x, y);
      t.type = 'grass'; this.view.refreshTile(x, y);
    }
    const store = this.placeBuilding('storehouse', cx, cy, true, 0, 'player', owner);
    this.playerStores.set(owner, store);
    // base kit stock, then run-upgrade start bonuses on top
    store.stock = Object.fromEntries(Object.keys(ITEMS).map(key => [key, kit.stock[key] ?? 0]));
    const bonus = this.mods.startStock();
    for (const k in bonus) store.stock[k] = (store.stock[k] || 0) + (bonus as Record<string, number>)[k];
    const d = doorTile(store);
    const serfs = kit.serfs + this.mods.extraSerfs();
    const laborers = kit.laborers + this.mods.extraLaborers();
    for (let i = 0; i < serfs; i++) this.spawnUnit('serf', 0xd8c49a, { x: d.x - 2 + (i % 4), y: d.y + Math.floor(i / 4) }, owner);
    for (let i = 0; i < laborers; i++) {
      const u = this.spawnUnit('laborer', 0xc97b3d, { x: d.x + 2 + (i % 3), y: d.y + Math.floor(i / 3) }, owner);
      u.roleName = 'Builder';
      u.anchor = { x: u.tx, y: u.ty };
    }
    // the Guild Hall trains the villagers who staff your buildings (separate from storage)
    const guild = this.placeBuilding('guildhall', cx + 3, cy, true, 0, 'player', owner);
    this.playerGuilds.set(owner, guild);
    const gd = doorTile(guild);
    const villagers = kit.villagers ?? DEFAULT_KIT.villagers ?? 4;
    for (let i = 0; i < villagers; i++) this.spawnCivilian('villager', { x: gd.x - 1 + (i % 4), y: gd.y + 1 + Math.floor(i / 4) }, owner);
  }

  // =====================================================================
  //  Buildings / sites
  // =====================================================================
  placeBuilding(
    key: BuildingKey, tx: number, ty: number, instant = false, rot = 0,
    faction: Faction = 'player', owner: OwnerId = ownerForFaction(faction, this.localPlayerId),
  ): Building {
    const def = DEFS[key];
    const mesh = this.view.createBuildingMesh(key, def);
    mesh.rotation.y = -rot * Math.PI / 2;
    mesh.position.set(this.world.wx(tx) + 0.5, 0, this.world.wz(ty) + 0.5);
    this.view.add(mesh);
    const facMult = faction === 'player' ? (def.store ? this.mods.castleHpMult() : 1) : (this.mods.buildingHpMult(faction) || 1);
    const maxHp = Math.round((def.hp ?? 100) * facMult);
    const b: Building = {
      id: this.nextEntityId++, owner,
      key, def, x: tx, y: ty, rot, active: false, inp: {}, out: {}, incoming: {},
      prog: 0, working: false, worker: null, fieldsList: [], mesh, name: def.name,
      faction, hp: maxHp, maxHp,
    };
    if (def.store) b.stock = {};   // player-built storehouses start empty
    if (key === 'market') { b.marketItem = 'timber'; b.marketAmount = 0; b.marketTimer = 60; }
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
  placePlot(tx: number, ty: number, b: Building, owner: PlayerId = this.localPlayerId): void {
    if (b.removed || b.owner !== owner || !b.def.fields) return;
    const t = this.world.T(tx, ty);
    if (!t || t.type !== 'grass' || t.b || t.site || t.road || t.field || t.dep || t.tree?.dense) return;
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

  placeSite(key: BuildingKey, tx: number, ty: number, rot = 0, owner: PlayerId = this.localPlayerId): Site {
    const def = DEFS[key];
    const { group, frame } = this.view.createScaffold(key, def);
    frame.rotation.y = -rot * Math.PI / 2;
    group.position.set(this.world.wx(tx) + 0.5, 0, this.world.wz(ty) + 0.5);
    this.view.add(group);
    const s: Site = {
      id: this.nextEntityId++, owner,
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
    const b = this.placeBuilding(s.key, s.x, s.y, false, s.rot, 'player', s.owner);
    this.toast(s.def.name + ' completed');
    this.sfx('build');
    // worker buildings stay unstaffed until a trained villager reports in (staffBuildings)
    if (!s.def.worker) b.active = true;
    if (this.selected === s) this.select(b);
  }

  // =====================================================================
  //  Units
  // =====================================================================
  spawnUnit(role: string, colorHex: number, tile: { x: number; y: number }, owner: PlayerId = this.localPlayerId): Unit {
    const { group, itemMesh } = this.view.createUnit(colorHex, role, tile.x, tile.y);
    const u: Unit = {
      id: this.nextEntityId++, owner,
      role, roleName: role[0].toUpperCase() + role.slice(1), colorHex, mesh: group, itemMesh,
      tx: tile.x, ty: tile.y, path: null, pathI: 0, task: null, carrying: null, collect: null,
      home: null, wstate: 'idle', timer: 0, target: null, hunger: 70 + rnd() * 30, bob: 0, status: 'Idle',
      faction: 'player', spd: BASE_SPEED, hp: 20, maxHp: 20, dmg: 0, range: 0, atkCd: 1, atkTimer: 0,
      dead: false, raider: false, foe: null, foeB: null, order: null, orderQueue: [], obeyT: 0, special: 0, anchor: null, lungeT: 0, hpBar: null, sepI: 0,
    };
    this.units.push(u);
    return u;
  }

  /** Spawn the run's mounted hero near the castle gate: a controllable player
   *  fighter with a per-hero look. Box-select or click it like any soldier. */
  spawnHero(heroId: string, roleName: string, owner: PlayerId = this.localPlayerId): Unit {
    this.heroId = heroId;
    this.heroName = roleName;
    const def = UNITS.hero;
    const d = doorTile(this.storeFor(owner));
    let tile = { x: d.x, y: d.y + 1 };
    if (!this.world.passable(tile.x, tile.y)) {
      for (let r = 1; r < 5 && !this.world.passable(tile.x, tile.y); r++)
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++)
          if (this.world.passable(d.x + dx, d.y + dy)) { tile = { x: d.x + dx, y: d.y + dy }; }
    }
    const { group, itemMesh } = this.view.createHero(heroId, tile.x, tile.y);
    const u: Unit = {
      id: this.nextEntityId++, owner,
      role: 'hero', roleName, colorHex: def.color, mesh: group, itemMesh,
      tx: tile.x, ty: tile.y, path: null, pathI: 0, task: null, carrying: null, collect: null,
      home: null, wstate: 'idle', timer: 0, target: null, hunger: 100, bob: 0, status: 'Ready to ride',
      faction: 'player', spd: def.speed * this.mods.combatMult('speed', 'hero'),
      hp: Math.round(def.hp * this.mods.combatMult('hp', 'hero')),
      maxHp: Math.round(def.hp * this.mods.combatMult('hp', 'hero')),
      dmg: def.dmg * this.mods.combatMult('damage', 'hero'),
      range: def.range, atkCd: def.atkCd, atkTimer: 0,
      dead: false, raider: false, foe: null, foeB: null, order: null, orderQueue: [], obeyT: 0, special: 0, anchor: null, lungeT: 0, hpBar: null, sepI: 0,
    };
    this.units.push(u);
    this.playerHeroes.set(owner, u);
    if (owner === this.localPlayerId) this.heroUnit = u;
    return u;
  }

  /** Spawn a combat unit (player soldier/archer, or enemy/wild fighter) from its def. */
  spawnFighter(kind: UnitKind, tile: { x: number; y: number }, faction?: Faction, owner?: OwnerId): Unit {
    const def = UNITS[kind];
    const fac = faction ?? def.faction;
    const unitOwner = owner ?? ownerForFaction(fac, this.localPlayerId);
    const u = this.spawnUnit(kind, def.color, tile, unitOwner === 'p2' ? 'p2' : 'p1');
    u.roleName = def.name;
    u.faction = fac;
    u.owner = unitOwner;
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
    const p = findPath(this.world, u.tx, u.ty, x, y, u.faction);
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
    for (const owner of PLAYER_IDS) this.dispatchOwner(owner);
  }

  private dispatchOwner(owner: PlayerId): void {
    let idle = this.units.filter(u => u.owner === owner && u.role === 'serf' && !u.task && !u.collect);
    if (!idle.length) return;
    const carryCap = this.mods.carryCap(), outCap = this.mods.outCap();
    const demands: any[] = [];
    for (const s of this.sites) {
      if (s.owner !== owner) continue;
      for (const it in s.needs) {
        const rem = s.needs[it] - (s.delivered[it] || 0) - (s.incoming[it] || 0);
        for (let i = 0; i < rem; i++) demands.push({ pri: s.priority ? -1 : 0, to: s, item: it });
      }
    }
    for (const b of this.buildings) {
      if (b.owner !== owner || !b.active || !b.def.recipe) continue;
      for (const it in this.mods.recipeInputs(b.def)) {
        const have = (b.inp[it] || 0) + (b.incoming[it] || 0);
        if (have < carryCap) demands.push({ pri: b.priority ? 0.75 : 1, to: b, item: it });
      }
    }
    for (const b of this.buildings) {
      if (b.owner !== owner || !b.active || !b.def.tavern) continue;
      const tv = b.def.tavern;
      const total = tv.foods.reduce((s, f) => s + (b.inp[f] || 0) + (b.incoming[f] || 0), 0);
      if (total >= tv.capacity) continue;
      for (const it of tv.foods) {
        const have = (b.inp[it] || 0) + (b.incoming[it] || 0);
        if (have < 2) demands.push({ pri: 1, to: b, item: it });
      }
    }
    // Commercial exports are deliberately lower priority than construction
    // and production inputs. Serfs must physically stock the market before a
    // caravan can buy anything.
    for (const b of this.buildings) {
      if (!b.active || b.key !== 'market' || b.faction !== 'player') continue;
      const item = b.marketItem ?? 'timber', target = b.marketAmount ?? 0;
      const missing = target - (b.inp[item] || 0) - (b.incoming[item] || 0);
      for (let i = 0; i < missing; i++) demands.push({ pri: 1.5, to: b, item });
    }
    for (const b of this.buildings) {
      if (b.owner !== owner || !b.active || b.def.store) continue;
      for (const it in b.out) {
        if (b.out[it] > 0) {
          const wanted = demands.some(d => d.item === it);
          // A producer at (or nearing) the output cap has STOPPED working —
          // draining it un-halts production, but an outstanding consumer for
          // this item must receive it directly. Creating a storage task here
          // used to reserve the item before the consumer demand ran, causing
          // full coal/gold mines to send goods to the castle ahead of a mint.
          // Urgent drains beat unrelated input top-ups so a capped producer
          // cannot starve forever. `wanted` remains the stronger item-specific
          // rule: output never goes to storage while any destination wants it.
          if (!wanted && b.out[it] >= outCap - 1) demands.push({ pri: b.priority ? 0.4 : 0.5, to: this.nearestStore(b), item: it, from: b });
          else if (!wanted) demands.push({ pri: 2, to: this.nearestStore(b), item: it, from: b });
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
          if (b.owner !== owner || b === d.to) continue;
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
    if (u.carrying && (u.owner === 'p1' || u.owner === 'p2')) {
      const store = this.storeFor(u.owner);
      store.stock![u.carrying] = (store.stock![u.carrying] || 0) + 1;
    }
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
      if (s.owner !== u.owner || !s.ready) return false;
      if (s.builder && (s.builder.dead || s.builder.target !== s)) s.builder = null;
      return !s.builder;
    };
    let target: Site | null = null;
    for (const s of this.sites) { if (claimable(s) && s.priority) { target = s; break; } }
    if (!target) for (const s of this.sites) { if (claimable(s)) { target = s; break; } }
    if (target) { target.builder = u; u.target = target; u.wstate = 'build'; u.path = null; }
    // nothing to build: stroll about instead of standing as a fixed obstacle
    else this.wander(u, dt, 'Strolling', 'Idle');
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
      if (g.node === 'tree') ok = !!(t.tree && t.tree.growth >= 1 && !t.tree.reserved && !t.tree.dense);
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
        if (b.prog >= 1) {
          b.prog = 0; b.working = false;
          const out = def.recipe.out;
          if (def.recipe.globalOutput) this.store.stock![out] = (this.store.stock![out] || 0) + 1;
          else b.out[out] = (b.out[out] || 0) + 1;
          this.objective?.onProduce(out, this.mods.objectiveWeight(out));
        }
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
      const owner = u.owner === 'p2' ? 'p2' : 'p1';
      const g = this.playerGuilds.get(owner) ?? this.storeFor(owner), cx = g.x + 1, cy = g.y + 1;
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
    for (const st of this.stores()) { const stock = st.stock!; for (const k in stock) n += stock[k]; }
    return n;
  }

  /** Player workers (non-fighters) currently well fed — the tavern tally. */
  wellFedWorkers(): number {
    let n = 0;
    for (const u of this.units) if (!u.dead && u.faction === 'player' && u.dmg === 0 && u.hunger >= 66) n++;
    return n;
  }

  countItem(item: string, owner: PlayerId = this.localPlayerId): number {
    const d = this.itemBreakdown(item, owner);
    return d.store + d.buildings + d.carried;
  }

  /**
   * Live health of the three logistics labour pools — serfs (hauling), villagers
   * (staffing buildings) and builders (raising sites). Each reports the pool
   * size, a one-line demand read-out and a traffic-light status the workers panel
   * colours in and the toggle badges as a persistent shortage warning. */
  workerMetrics(): Record<'serf' | 'villager' | 'builder', { count: number; status: 'good' | 'warn' | 'bad'; note: string }> {
    let serfs = 0, idleSerfs = 0, villagers = 0, idleVillagers = 0, builders = 0;
    for (const u of this.units) {
      if (u.dead || u.faction !== 'player') continue;
      if (u.role === 'serf') { serfs++; if (!u.task && !u.collect) idleSerfs++; }
      else if (u.role === 'villager') { villagers++; if (!u.home) idleVillagers++; }
      else if (u.role === 'laborer') builders++;
    }

    // Serfs: count outstanding haul demands (sites awaiting materials, producers
    // hungry for inputs or backed up with output nobody has fetched).
    const carryCap = this.mods.carryCap();
    let haulLoad = 0;
    for (const s of this.sites) for (const it in s.needs) haulLoad += Math.max(0, s.needs[it] - (s.delivered[it] || 0) - (s.incoming[it] || 0));
    for (const b of this.buildings) {
      if (b.removed || !b.active) continue;
      if (b.def.recipe) for (const it in this.mods.recipeInputs(b.def)) if (((b.inp[it] || 0) + (b.incoming[it] || 0)) < carryCap) haulLoad++;
      if (!b.def.store) for (const it in b.out) if (b.out[it] > 0) haulLoad++;
    }
    const serf = { count: serfs,
      status: (serfs === 0 && haulLoad > 0) || haulLoad > serfs * 2 ? 'bad' : (haulLoad > 0 && idleSerfs === 0) ? 'warn' : 'good',
      note: haulLoad === 0 ? 'All caught up' : `${haulLoad} deliver${haulLoad === 1 ? 'y' : 'ies'} waiting` } as const;

    // Villagers: posts left unstaffed for want of a trained villager.
    let unstaffed = 0;
    for (const b of this.buildings) if (!b.removed && b.faction === 'player' && b.def.worker && !b.worker) unstaffed++;
    const villager = { count: villagers,
      status: unstaffed > 0 ? 'bad' : idleVillagers === 0 ? 'warn' : 'good',
      note: unstaffed > 0 ? `${unstaffed} building${unstaffed === 1 ? '' : 's'} unstaffed` : idleVillagers === 0 ? 'None spare' : `${idleVillagers} ready to post` } as const;

    // Builders: sites in the ground versus hands to raise them.
    const openSites = this.sites.length;
    const builder = { count: builders,
      status: (builders === 0 && openSites > 0) || openSites > builders ? 'bad' : openSites === builders && openSites > 0 ? 'warn' : 'good',
      note: openSites === 0 ? 'No sites pending' : `${openSites} site${openSites === 1 ? '' : 's'} to raise` } as const;

    return { serf, villager, builder };
  }

  /** Every standing storage building (the castle plus any built storehouses). */
  stores(owner?: PlayerId): Building[] {
    return this.buildings.filter(b => b.def.store && !b.removed && (!owner || b.owner === owner));
  }

  /** The closest storage building to a producer (surplus hauls go here). */
  private nearestStore(from: { x: number; y: number }): Building {
    const owner = 'owner' in from && (from.owner === 'p1' || from.owner === 'p2') ? from.owner : this.localPlayerId;
    let best = this.storeFor(owner), bd = 1e9;
    for (const st of this.stores(owner)) {
      const d = Math.abs(st.x - from.x) + Math.abs(st.y - from.y);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  /** Spend `n` of an item across all storehouses (castle first). False = short. */
  private takeStock(item: string, n: number, owner?: PlayerId): boolean {
    const sts = this.stores(owner);
    let have = 0;
    for (const st of sts) have += st.stock![item] || 0;
    if (have < n) return false;
    for (const st of sts) {
      const take = Math.min(n, st.stock![item] || 0);
      st.stock![item] = (st.stock![item] || 0) - take;
      n -= take;
      if (n <= 0) break;
    }
    return true;
  }

  /** Total of an item sitting in storehouses. */
  private storeTotal(item: string, owner?: PlayerId): number {
    let n = 0;
    for (const st of this.stores(owner)) n += st.stock![item] || 0;
    return n;
  }

  /** Where an item currently sits: storehouses vs. building inventories vs. in transit. */
  itemBreakdown(item: string, owner: PlayerId = this.localPlayerId): { store: number; buildings: number; carried: number } {
    let buildings = 0, carried = 0;
    for (const b of this.buildings) { if (b.owner === owner && !b.def.store) buildings += (b.inp[item] || 0) + (b.out[item] || 0); }
    for (const u of this.units) if (u.owner === owner && u.carrying === item) carried++;
    return { store: this.storeTotal(item, owner), buildings, carried };
  }

  /** Read-only precheck used by Controls to batch road cells worth sending. */
  canPaintRoadAt(tx: number, ty: number): boolean {
    const t = this.world.T(tx, ty);
    return !!t && t.type === 'grass' && !t.b && !t.site && !t.road && !t.field && !t.dep && !t.tree?.dense;
  }

  /** Read-only precheck used by Controls to batch plot cells worth sending. */
  canPlotAt(tx: number, ty: number): boolean {
    const t = this.world.T(tx, ty);
    return !!t && t.type === 'grass' && !t.b && !t.site && !t.road && !t.field && !t.dep && !t.tree?.dense;
  }

  /** Would a demolish command at this tile do anything for this player? */
  demolishableAt(tx: number, ty: number, dragOnly: boolean, owner: PlayerId = this.localPlayerId): boolean {
    const t = this.world.T(tx, ty);
    if (!t) return false;
    if (t.road) return t.roadOwner === owner;
    if (t.field) return t.field.farm.owner === owner;
    if (dragOnly) return false;
    return !!t.b || !!t.site; // clicks go through so the sim can toast the reason
  }

  canPlace(key: BuildingKey, tx: number, ty: number, rot: number): boolean {
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) {
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep || t.road || t.field) return false;
      if (t.tree?.dense) return false;    // old-growth is not for clearing
    }
    return buildingEntranceTiles({ x: tx, y: ty, rot, def: DEFS[key] })
      .every(d => this.world.passable(d.x, d.y));
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

  /** Buildings this map's biome forbids (mirrored by the build menu): the
   *  biome's own bans, plus coastal-only chains anywhere without a sea. */
  disabledBuildings(): BuildingKey[] {
    const banned = [...this.world.biome.disabledBuildings];
    if (!this.world.biome.gen.coast) {
      for (const key in DEFS) if (DEFS[key as BuildingKey].coastal) banned.push(key as BuildingKey);
    }
    return banned;
  }

  tryPlace(key: BuildingKey, tx: number, ty: number, rot: number, owner: PlayerId = this.localPlayerId): void {
    if (this.disabledBuildings().includes(key)) {
      this.sfx('error');
      this.toast(`No ${DEFS[key].name.toLowerCase()} can be raised in ${this.world.biome.name}`, 'err');
      return;
    }
    if (!this.canPlace(key, tx, ty, rot)) { this.sfx('error'); this.toast('Cannot build here — the entrance tile must be clear too', 'err'); return; }
    const def = DEFS[key];
    if (key === 'quarry' && !this.depositInRange('stone', tx, ty, 9)) { this.toast('No stone deposits in range — build near the grey rocks', 'err'); return; }
    if (key === 'goldmine' && !this.depositInRange('gold', tx, ty, 9)) { this.toast('No gold deposits in range', 'err'); return; }
    if (key === 'coalmine' && !this.depositInRange('coal', tx, ty, 9)) { this.toast('No coal deposits in range', 'err'); return; }
    if (key === 'ironmine' && !this.depositInRange('iron', tx, ty, 9)) { this.toast('No iron deposits in range — build near the rusty rocks', 'err'); return; }
    if (def.gather?.node === 'fish' && !this.lakeInRange(tx, ty, def.gather.range)) { this.toast('No open water in range — build on the shore', 'err'); return; }
    if (key === 'woodcutter' && !this.nearTree(tx, ty, 9)) this.toast('Warning: few trees nearby', 'err');
    const cost = this.mods.buildingCost(def);
    for (const k in cost) { if (this.countItem(k, owner) < (cost as any)[k]) { this.toast('Not enough ' + ITEMS[k as keyof typeof ITEMS].name + ' in your economy — site will wait', 'err'); break; } }
    this.placeSite(key, tx, ty, rot, owner);
    this.sfx('place');
    this.toast(def.name + ' site placed — serfs will deliver materials');
  }

  paintRoad(tx: number, ty: number, owner: PlayerId = this.localPlayerId): void {
    const t = this.world.T(tx, ty);
    if (!t || t.type !== 'grass' || t.b || t.site || t.road || t.field || t.dep || t.tree?.dense) return;
    const cost = this.mods.roadCost();
    if (cost > 0 && !this.takeStock('stone', cost, owner)) {
      const now = Date.now();
      if (now - this.roadWarnT > 1500) { this.roadWarnT = now; this.toast('Out of stone — quarry more to build roads', 'err'); this.sfx('error'); }
      return;
    }
    if (t.tree) this.removeTree(tx, ty);
    if (t.deco) this.removeDeco(tx, ty);
    t.road = true; t.roadOwner = owner; this.mods.ctx.roadTiles++;
    this.view.refreshTile(tx, ty); this.view.addRoad(tx, ty);
  }

  demolishAt(tx: number, ty: number, dragOnly: boolean, owner: PlayerId = this.localPlayerId): void {
    const t = this.world.T(tx, ty); if (!t) return;
    if (t.road) {
      if (t.roadOwner !== owner) return;
      t.road = false; t.roadOwner = null; this.mods.ctx.roadTiles = Math.max(0, this.mods.ctx.roadTiles - 1);
      const store = this.storeFor(owner); store.stock!['stone'] = (store.stock!['stone'] || 0) + this.mods.roadCost();
      this.view.refreshTile(tx, ty); this.view.removeRoad(tx, ty); return;
    }
    if (t.field) {
      if (t.field.farm.owner !== owner) return;
      const list = t.field.farm.fieldsList, i = list.findIndex(f => f.x === tx && f.y === ty);
      if (i >= 0) list.splice(i, 1);
      this.view.removeMeshes(t.field.meshes); t.field = null; this.view.refreshTile(tx, ty); return;
    }
    if (dragOnly) return;
    if (t.b) {
      const b = t.b; // removeBuilding clears the tile — keep the reference
      if (this.playerStores.get(owner) === b) { this.toast('The castle cannot be demolished', 'err'); return; }
      if (b.faction !== 'player') { this.toast('Enemy strongholds must be destroyed in battle', 'err'); return; }
      if (b.owner !== owner) { this.toast("You cannot demolish your ally's building", 'err'); return; }
      this.sfx('demolish'); this.removeBuilding(b); this.toast(b.def.name + ' demolished'); return;
    }
    if (t.site) { if (t.site.owner !== owner) return; this.sfx('demolish'); this.removeSite(t.site); return; }
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
    for (let i = this.caravans.length - 1; i >= 0; i--) if (this.caravans[i].market === b) {
      this.view.remove(this.caravans[i].mesh);
      this.caravans.splice(i, 1);
    }
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
    for (const b of this.buildings) out.push(...buildingEntranceTiles(b));
    for (const s of this.sites) out.push(...buildingEntranceTiles(s));
    return out;
  }

  /** Click-select a building/site at a tile (used by Controls). Gold piles are
   *  no longer clicked up — a unit must walk over to fetch them. */
  selectAt(tx: number, ty: number): void {
    const t = this.world.tiles[ty][tx];
    if (t.pickup) {
      const now = Date.now();
      if (now - this.pickupHintT > 2500) {
        this.pickupHintT = now;
        this.toast('Send a unit (or your hero) to the gold pile to collect it');
      }
      return;
    }
    if (t.b) this.select(t.b);
    else if (t.site) this.select(t.site);
    else this.select(null);
  }
  private pickupHintT = 0;
  private pickupScanT = 0;

  /** A unit reached a gold pile; only that unit's owner banks the gold. */
  collectGoldAt(tx: number, ty: number, owner: PlayerId = this.localPlayerId, by?: Unit): void {
    const t = this.world.T(tx, ty);
    if (!t || !t.pickup) return;
    const gain = Math.max(1, Math.round(t.pickup.gold * this.mods.goldMult()));
    this.view.removeMeshes(t.pickup.meshes);
    t.pickup = null;
    const i = this.pickups.findIndex(p => p.x === tx && p.y === ty);
    if (i >= 0) this.pickups.splice(i, 1);
    this.objective?.onCollect();
    if (owner !== this.localPlayerId) return; // gold and fanfare are personal
    this.onGold(gain);
    this.sfx('coin');
    this.toast(`${by ? by.roleName : 'A unit'} collected a gold pile (+${gain} gold)`);
  }

  /** Any player unit standing by a gold pile picks it up — no clicking. Runs a
   *  few times a second over the (short) pickup list via the spatial hash. */
  private collectPickups(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      let taker: Unit | null = null;
      this.forUnitsNear(p.x, p.y, 2, u => {
        if (taker || u.dead || u.faction !== 'player') return;
        const dx = u.mesh.position.x - this.world.wx(p.x), dz = u.mesh.position.z - this.world.wz(p.y);
        if (dx * dx + dz * dz <= 1.1 * 1.1) taker = u;
      });
      const collector = taker as Unit | null;
      if (collector) this.collectGoldAt(p.x, p.y, collector.owner === 'p2' ? 'p2' : 'p1', collector);
    }
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
    const s = this.meleeSfx(attacker);
    if (s) this.sfx(s);
    const mult = damageMultiplier(attacker.role as UnitKind, foe.role as UnitKind);
    this.hurtUnit(attacker, foe, attacker.dmg * mult);
  }

  /** The strike sound a melee unit makes, chosen by what it is: light blades
   *  ring, heavy cavalry and knights clang, the shambling undead land wet
   *  blunt thuds, beasts snap and bite, demons rake. Archers and siege loose
   *  projectiles (their own sounds) so they swing silently here. */
  private meleeSfx(u: Unit): 'sword' | 'clang' | 'maul' | 'bite' | 'claw' | null {
    const def = UNITS[u.role as UnitKind];
    if (!def || def.arrows) return null;
    if (def.model === 'beast' || def.model === 'wolf' || def.model === 'dragon') return 'bite';
    if (def.model === 'demon') return 'claw';
    switch (u.role) {
      case 'zombie': case 'brute': return 'maul';
      case 'knight': case 'horseknight': case 'hero': case 'lancer': case 'orc': return 'clang';
      default: return 'sword';
    }
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
    if (def.heal) { this.supportUpdate(u, def.heal, dt); return; }
    const flying = !!def.flying;
    u.atkTimer = Math.max(0, u.atkTimer - dt);
    if (u.lungeT > 0) u.lungeT = Math.max(0, u.lungeT - dt);
    if (flying) this.animateFlight(u, dt);
    if (def.fire) this.fireVolley(u, dt);

    // leash: a chase that strays too far from home is abandoned. Wild beasts use
    // their own short leash; hostile camp guards, now that they spot you from far
    // off, get a generous one so they defend their camp instead of emptying it to
    // chase a lone worker across the map. Raiders (marching on the castle) never leash.
    const leash = u.faction === 'wild' ? def.leash
      : (u.faction === 'enemy' && !u.raider && u.anchor ? (def.leash ?? 18) : undefined);
    if (leash && u.anchor) {
      const da = Math.hypot(u.tx - u.anchor.x, u.ty - u.anchor.y);
      if (u.wstate === 'leash') {
        if (da < 3) {
          u.wstate = 'idle';
          u.path = null; // FIX: Wipe the return path cleanly
        }
        else {
          if (!u.path) this.sendTo(u, u.anchor.x, u.anchor.y);
          this.moveUnit(u, dt);
          u.status = 'Heading home';
          return;
        }
      } else if (da > leash) { u.wstate = 'leash'; u.foe = null; u.path = null; return; }
    }

    if (u.obeyT > 0) {
      u.obeyT = Math.max(0, u.obeyT - dt);
      // while obeying a fresh move order, drop any current fight entirely
      if (u.order && u.order.type !== 'attack') { u.foe = null; u.foeB = null; }
    }
    // Explicit targets complete as soon as they fall, including the final order.
    // Advancing in a loop also skips targets destroyed earlier in the same tick.
    while (u.order && (
      (u.order.type === 'attack' && (!u.order.foe || u.order.foe.dead)) ||
      (u.order.building?.removed ?? false)
    )) this.advanceOrder(u);
    const orderedBuilding = u.order?.building && !u.order.building.removed ? u.order.building : null;
    // Retaliation and ambient aggro may not steal an explicit focus target.
    let foe = u.order?.type === 'attack' ? u.order.foe : (orderedBuilding ? null : u.foe);
    if (foe && foe.dead) foe = null;
    // pure 'move' orders don't auto-seek (lets you march past enemies); an
    // attack-move only re-engages once the obey window has passed
    const canSeek = (!u.order || u.order.type !== 'move') && u.obeyT <= 0;
    // wild beasts that hold ground are short-sighted: YOU choose when the fight
    // starts by walking up to them. Hostile *units* (bandits, orcs, the undead —
    // even camp guards) stay fully alert and pick you up at their real aggro
    // range. Raiders and player units always keep their full awareness.
    const aggro = u.faction === 'wild' && !u.raider ? Math.min(def.aggro, 4.5) : def.aggro;
    // A locked structure target comes from an explicit siege order or from the
    // unreachable-guard fallback below. Keep battering that structure instead
    // of reacquiring the same guard on the next tick and oscillating forever.
    if (!foe && canSeek && !u.foeB) foe = this.acquireTarget(u, aggro);
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
          if (def.splash) this.fireRock(u, u.faction, u.mesh.position.x, 0.6, u.mesh.position.z, foe.mesh.position.x, foe.mesh.position.z, u.dmg, def.splash);
          else if (def.arrows) this.fireArrow(u, u.faction, u.mesh.position.x, 0.6, u.mesh.position.z, foe, u.dmg);
          else this.attack(u, foe);
        }
      } else if (flying) {
        this.moveFlying(u, dt, foe.mesh.position.x, foe.mesh.position.z);
      } else {
        // chase — throttle A* so hundreds of pursuers don't re-path every tick;
        // charging beasts (boars) put on a burst of speed
        if (!u.path) {
          u.timer -= dt;
          if (u.timer <= 0 && this.pathBudget > 0) {
            this.pathBudget--;
            const reached = this.sendTo(u, foe.tx, foe.ty);
            u.timer = 0.4 + rnd() * 0.35;
            // the foe is walled in (a garrison behind stronghold ramparts):
            // don't mill about forever — batter down what stands in the way
            if (!reached) {
              const bt = this.buildingTargetFor(u);
              if (bt) { u.foe = null; u.foeB = bt; return; }
            }
          }
        }
        this.moveUnit(u, def.charge ? dt * def.charge : dt);
        u.status = 'Fighting';
      }
      return;
    }

    // no unit foe: go for a hostile building (the castle for raiders & the dragon,
    // camps for the player army)
    // a live foeB that differs from the ordered target is the rampart the
    // order is stuck behind (set in siegeBlocked when the ring proves
    // unreachable): batter it down first, then resume the ordered siege
    let bt = u.foeB && !u.foeB.removed ? u.foeB : orderedBuilding;
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
        if (!u.path) {
          u.timer -= dt;
          if (u.timer <= 0) {
            // an ordered host marches on the ring via its shared flow field;
            // an empty descent means the ring is reached — drop the field and
            // let the salted per-unit spread below take over the final shuffle.
            // A null descent means the ring is walled off from this unit's
            // ground entirely — don't fall through to a doomed global search.
            const field = u.order?.building === bt ? u.order.field : null;
            if (field) {
              if (this.flowBudget > 0) {
                this.flowBudget--;
                const p = fieldPath(this.world, field, u.tx, u.ty, undefined, undefined, u.faction);
                if (p === null) { u.order!.field = null; this.siegeBlocked(u, bt); }
                else if (p.length) { u.path = p; u.pathI = 0; u.timer = 0.5 + rnd() * 0.4; }
                else u.order!.field = null;
              }
            } else if (this.pathBudget > 0) {
              this.pathBudget--;
              const s = this.siegeTile(u, bt);
              if (this.sendTo(u, s.x, s.y)) u.timer = 0.5 + rnd() * 0.4;
              else this.siegeBlocked(u, bt);
            }
          }
        }
        this.moveUnit(u, dt);
      }
      return;
    }

    // no foe: follow a move/attack-move order, wander near home, or hold
    if (u.order && (u.order.type === 'move' || u.order.type === 'attackMove')) {
      if (flying) {
        if (this.moveFlying(u, dt, this.world.wx(u.order.x), this.world.wz(u.order.y))) this.advanceOrder(u);
        return;
      }
      if (!u.path) {
        if (u.tx === u.order.x && u.ty === u.order.y) { this.advanceOrder(u); }
        // group orders descend their shared flow field (cheap, own budget);
        // solo orders and units the field can't serve run a budgeted A* —
        // either way a freshly ordered horde sets off staggered over a few
        // ticks instead of freezing the sim on one
        else if (u.order.field) {
          if (this.flowBudget > 0) {
            this.flowBudget--;
            const p = fieldPath(this.world, u.order.field, u.tx, u.ty, u.order.x, u.order.y, u.faction);
            if (p?.length) { u.path = p; u.pathI = 0; }
            else u.order.field = null;
          }
        }
        else if (this.pathBudget > 0) {
          this.pathBudget--;
          if (!this.sendTo(u, u.order.x, u.order.y)) this.advanceOrder(u);
        }
      }
      if (u.path) this.moveUnit(u, dt); else this.groundPose(u, flying);
    } else if (def.wander) {
      this.wander(u, dt);
    } else {
      this.groundPose(u, flying);
    }
  }

  private supportUpdate(u: Unit, heal: { range: number; amount: number; rate: number }, dt: number): void {
    u.atkTimer = Math.max(0, u.atkTimer - dt);
    if (u.atkTimer <= 0) {
      let target: Unit | null = null, ratio = 1;
      this.forUnitsNear(u.tx, u.ty, Math.ceil(heal.range) + 1, o => {
        if (o === u || o.dead || o.faction !== u.faction || o.hp >= o.maxHp) return;
        const dx = o.tx - u.tx, dy = o.ty - u.ty;
        if (dx * dx + dy * dy > heal.range * heal.range) return;
        const r = o.hp / o.maxHp;
        if (r < ratio) { ratio = r; target = o; }
      });
      if (target) {
        const ally = target as Unit;
        ally.hp = Math.min(ally.maxHp, ally.hp + heal.amount);
        u.atkTimer = heal.rate;
        u.status = `Healing ${ally.roleName}`;
      } else u.status = 'Tending the company';
    }
    u.foe = null; u.foeB = null;
    if (u.order) {
      if (u.tx === u.order.x && u.ty === u.order.y) this.advanceOrder(u);
      else if (!u.path && u.order.field) {
        if (this.flowBudget > 0) {
          this.flowBudget--;
          const p = fieldPath(this.world, u.order.field, u.tx, u.ty, u.order.x, u.order.y, u.faction);
          if (p?.length) { u.path = p; u.pathI = 0; }
          else u.order.field = null;
        }
      }
      else if (!u.path && this.pathBudget > 0) {
        this.pathBudget--;
        if (!this.sendTo(u, u.order.x, u.order.y)) this.advanceOrder(u);
      }
      if (u.path) this.moveUnit(u, dt); else this.groundPose(u, false);
    } else this.groundPose(u, false);
  }

  /** Resting pose between swings: melee units hop into each attack, fliers hover. */
  private groundPose(u: Unit, flying: boolean): void {
    if (flying) return; // animateFlight owns the y of a flier
    u.mesh.position.y = u.lungeT > 0 ? Math.sin((1 - u.lungeT / 0.22) * Math.PI) * 0.12 : 0;
  }

  /** Idle beasts, camp guards & off-duty builders amble around their anchor. */
  private wander(u: Unit, dt: number, moving = 'Roaming', resting = 'Grazing'): void {
    if (u.path) { this.moveUnit(u, dt); u.status = moving; return; }
    u.mesh.position.y = 0;
    u.status = resting;
    u.timer -= dt;
    if (u.timer > 0) return;
    u.timer = 4 + rnd() * 7;
    const a = u.anchor ?? { x: u.tx, y: u.ty };
    for (let tries = 0; tries < 6; tries++) {
      const x = a.x + Math.round((rnd() - 0.5) * 4), y = a.y + Math.round((rnd() - 0.5) * 4);
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
    // fortifications are battered from the unit's own side: a ring tile beyond
    // a wall is the far side of the very obstacle being attacked, and marching
    // there is a guaranteed failed full-map search
    const du = b.def.bulwark ? Math.hypot(b.x + 0.5 - u.tx, b.y + 0.5 - u.ty) : Infinity;
    for (let y = b.y - 1; y <= b.y + 2; y++) for (let x = b.x - 1; x <= b.x + 2; x++) {
      if (x >= b.x && x <= b.x + 1 && y >= b.y && y <= b.y + 1) continue;
      if (!this.world.passable(x, y)) continue;
      if (Math.hypot(x - u.tx, y - u.ty) > du) continue;
      const salt = ((x * 31 + y * 17 + u.tx * 7 + u.ty * 3) % 5) * 0.8;
      const dd = Math.hypot(x - u.tx, y - u.ty) + salt;
      if (dd < bd) { bd = dd; best = { x, y } }
    }
    return best ?? doorTile(b);
  }

  /** A siege target nobody can path to is walled in (a keep behind ramparts).
   *  Swing at the nearest hostile structure instead — foeB overrides the
   *  ordered target until the rampart falls — rather than letting every
   *  besieger re-run a doomed full-map search twice a second (the pathfinder
   *  storm that froze big chained sieges on fortified keeps). With nothing
   *  nearby to batter, back off and retry lazily. */
  private siegeBlocked(u: Unit, bt: Building): void {
    const blocker = this.buildingTargetFor(u);
    if (blocker && blocker !== bt) { u.foeB = blocker; return; }
    u.timer = 3 + rnd() * 2;
  }

  private attackBuilding(u: Unit, b: Building): void {
    const s = this.meleeSfx(u);
    if (s) this.sfx(s);
    b.hp -= structureDamage(u.role as UnitKind, u.dmg);
    this.onHurt(this.buildingCenter(b).x, this.buildingCenter(b).z, b.faction);
    if (b.hp <= 0) this.destroyBuilding(b);
  }

  private destroyBuilding(b: Building): void {
    if (b.removed) return;
    const c = this.buildingCenter(b);
    for (let i = 0; i < 4; i++) this.onDeath(c.x + (rnd() - 0.5) * 1.4, c.z + (rnd() - 0.5) * 1.4, b.faction, b.def.roof, 'serf', 1);
    // walls & gates are fortifications, not strongholds — no objective credit
    if (!b.def.bulwark) this.objective?.onStructureDestroyed(b.faction);
    for (const o of this.units) if (o.foeB === b) o.foeB = null;
    const isCastle = (b.owner === 'p1' || b.owner === 'p2') && this.playerStores.get(b.owner) === b;
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
    dmg: number; kind: 'arrow' | 'fire' | 'rock'; radius?: number;
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

  /** Heave an onager rock at a ground point; it splashes over `radius` tiles
   *  where it lands. Unlike an arrow it does not home — it batters whatever is
   *  still standing in the target cluster when it comes down. */
  private fireRock(shooter: Unit | null, from: Faction, x: number, y: number, z: number, ex: number, ez: number, dmg: number, radius: number): void {
    const dist = Math.hypot(ex - x, ez - z);
    const mesh = this.view.createRock();
    mesh.position.set(x, y, z);
    this.sfx('arrow');
    this.projectiles.push({
      mesh, sx: x, sy: y, sz: z, ex, ey: 0.1, ez,
      t: 0, dur: Math.max(0.3, dist / 9), arc: Math.min(2.2, 0.6 + dist * 0.12),
      from, shooter, target: null, dmg, kind: 'rock', radius,
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

  private impact(p: { ex: number; ez: number; from: Faction; shooter: Unit | null; target: Unit | null; dmg: number; kind: 'arrow' | 'fire' | 'rock'; radius?: number }): void {
    const W = this.world.W, H = this.world.H;
    const itx = Math.max(0, Math.min(W - 1, Math.round(p.ex + W / 2 - 0.5)));
    const ity = Math.max(0, Math.min(H - 1, Math.round(p.ez + H / 2 - 0.5)));
    if (p.kind === 'rock') {
      // splash: batter hostile units & buildings within the blast radius (no fire)
      const rad = p.radius ?? 1.6, rad2 = rad * rad, cells = Math.ceil(rad) + 2;
      this.forUnitsNear(itx, ity, cells, o => {
        if (o.dead || !this.hostile(p.from, o.faction)) return;
        const dx = o.mesh.position.x - p.ex, dz = o.mesh.position.z - p.ez;
        if (dx * dx + dz * dz <= rad2) this.hurtUnit(p.shooter, o, p.dmg);
      });
      for (const b of this.buildings) {
        if (b.removed || !this.hostile(p.from, b.faction)) continue;
        const c = this.buildingCenter(b);
        const dx = c.x - p.ex, dz = c.z - p.ez;
        if (dx * dx + dz * dz <= (rad + 0.4) * (rad + 0.4)) { b.hp -= p.dmg; this.onHurt(c.x, c.z, b.faction); if (b.hp <= 0) this.destroyBuilding(b); }
      }
      this.onHurt(p.ex, p.ez, p.from === 'player' ? 'enemy' : 'player');
      return;
    }
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
      u.sepI = list.length;            // stamp the crowd index on the unit itself…
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
          // Resolve each pair once and push both participants. The old loop
          // evaluated every overlap twice, dominating large moving armies.
          // …and compare the stamped indices — no per-pair Map lookups in the
          // hottest loop of the sim.
          if (o.sepI <= u.sepI) continue;
          // Logistics traffic may pass through itself and through builders.
          // Builders spend long stretches planted on a site's single door
          // tile; treating that stationary worker as a solid body repeatedly
          // shoved passing serfs off their route.
          if (u.role === 'serf' && (o.role === 'serf' || o.role === 'laborer')) continue;
          if (o.role === 'serf' && u.role === 'laborer') continue;
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
          // split the correction evenly between the pair
          const overlap = (r - d) * 0.5 * push;
          const allied = u.faction === o.faction;
          const uMarching = allied && this.isFormationMarching(u);
          const oMarching = allied && this.isFormationMarching(o);
          if (uMarching || oMarching) {
            // Friendly units already holding a slot must not become a wall for
            // the rest of their formation. Keep the holder planted and put
            // the full sideways correction on the marcher. For two marchers,
            // retain the normal half correction on each. nudgeMarching strips
            // only the backwards component, so dense traffic may flow around
            // or through a knot but can never overpower forward movement.
            if (uMarching) this.nudgeMarching(u, -nx * overlap * (oMarching ? 1 : 2), -nz * overlap * (oMarching ? 1 : 2));
            if (oMarching) this.nudgeMarching(o, nx * overlap * (uMarching ? 1 : 2), nz * overlap * (uMarching ? 1 : 2));
          } else {
            this.nudge(u, -nx * overlap, -nz * overlap);
            this.nudge(o, nx * overlap, nz * overlap);
          }
        }
      }
    }
  }

  /** A path-backed player formation order is traffic, rather than a unit
   *  fighting or standing its ground. Kept deliberately narrow so combat
   *  crowd pressure and ordinary worker separation retain their old feel. */
  private isFormationMarching(u: Unit): boolean {
    return u.faction === 'player' && !!u.path && !!u.order
      && (u.order.type === 'move' || u.order.type === 'attackMove');
  }

  /** Apply separation to a formation marcher without ever moving it away
   *  from its next waypoint. This is scalar and allocation-free because it
   *  runs inside the hottest crowd loop. */
  private nudgeMarching(u: Unit, dx: number, dz: number): void {
    const node = u.path?.[u.pathI];
    if (!node) { this.nudge(u, dx, dz); return; }
    const px = this.world.wx(node.x) - u.mesh.position.x;
    const pz = this.world.wz(node.y) - u.mesh.position.z;
    const l2 = px * px + pz * pz;
    if (l2 > 1e-8) {
      const backwards = (dx * px + dz * pz) / l2;
      if (backwards < 0) { dx -= backwards * px; dz -= backwards * pz; }
    }
    this.nudge(u, dx, dz);
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

  // =====================================================================
  //  The castle bell — ring it and every non-combat worker drops what they
  //  are doing and shelters inside the castle (AOE town-bell style); ring
  //  again to send them back out.
  // =====================================================================
  private readonly bells = new Set<PlayerId>();
  get bell(): boolean { return this.bells.has(this.localPlayerId); }

  /** Command-path bell control: apply the requested state if it differs. */
  setBell(owner: PlayerId, active: boolean): void {
    if (this.bells.has(owner) !== active) this.toggleBell(owner);
  }

  toggleBell(owner: PlayerId = this.localPlayerId): void {
    if (this.bells.has(owner)) this.bells.delete(owner); else this.bells.add(owner);
    const active = this.bells.has(owner);
    this.sfx('bell');
    if (active) {
      this.toast('The bell tolls — workers run for the castle!', 'err');
      for (const u of this.units) {
        if (u.dead || u.owner !== owner || u.faction !== 'player' || this.isFighter(u) || u.role === 'carrier') continue;
        if (u.task) this.cancelTask(u);
        const site = u.target as Site | null;
        if (site && site.isSite && site.builder === u) site.builder = null;
        u.path = null; u.target = null;
        u.mesh.visible = true;
        u.wstate = 'toRefuge';
      }
    } else {
      this.toast('The bell falls silent — back to work');
      const d = doorTile(this.storeFor(owner));
      for (const u of this.units) {
        if (u.dead || u.owner !== owner || u.faction !== 'player' || this.isFighter(u)) continue;
        if (u.wstate !== 'refuge' && u.wstate !== 'toRefuge') continue;
        u.mesh.visible = true;
        u.mesh.position.set(this.world.wx(d.x) + (rnd() - 0.5) * 0.8, 0, this.world.wz(d.y) + (rnd() - 0.5) * 0.8);
        u.tx = d.x; u.ty = d.y;
        u.path = null; u.target = null;
        u.wstate = u.home ? 'goHome' : 'idle';
        u.status = 'Idle';
      }
    }
  }

  /** While the bell tolls: run for the castle door, then vanish inside. */
  private refugeUpdate(u: Unit, dt: number): void {
    if (u.wstate === 'refuge') { u.mesh.visible = false; return; }
    const owner = u.owner === 'p2' ? 'p2' : 'p1';
    const d = doorTile(this.storeFor(owner));
    if (u.tx === d.x && u.ty === d.y && !u.path) {
      u.wstate = 'refuge'; u.mesh.visible = false; u.status = 'Sheltering in the castle';
      return;
    }
    u.status = 'Running for the castle';
    if (!u.path) { if (!this.sendTo(u, d.x, d.y)) { u.mesh.position.y = 0; return; } }
    this.moveUnit(u, dt);
  }

  // =====================================================================
  //  Trade — the only way goods cross between the two allied economies.
  //  A confirmed send reserves the goods at once, loads a visible carrier
  //  at the sender's storehouse and walks it to the ally's store. Goods
  //  arrive only when the cart does; a slain cart's cargo is lost on the
  //  road. Requests transfer nothing — they are a visible ask.
  // =====================================================================
  readonly tradeRequests: TradeRequest[] = [];
  readonly tradeShipments: TradeShipment[] = [];
  readonly tradeHistory: TradeHistoryEntry[] = [];
  private tradeSeq = 0;

  private tradeLog(kind: TradeHistoryEntry['kind'], text: string): void {
    this.tradeHistory.unshift({ at: this.elapsed, kind, text });
    if (this.tradeHistory.length > TRADE.historyCap) this.tradeHistory.length = TRADE.historyCap;
  }

  /** A standing storehouse by entity id owned by `owner`, or null. */
  private storeById(id: number, owner: PlayerId): Building | null {
    const b = this.entityById(id);
    if (!b || !('def' in b) || b.isSite || !b.def.store || b.removed || b.owner !== owner) return null;
    return b as Building;
  }

  /** Ask the ally for goods, delivered to one of your own storehouses. */
  requestTrade(owner: PlayerId, item: string, amount: number, destinationId: number): boolean {
    if (!Number.isInteger(amount) || amount <= 0 || !(item in ITEMS)) return false;
    if (!this.storeById(destinationId, owner)) { if (owner === this.localPlayerId) this.toast('Choose one of your own storehouses for the delivery', 'err'); return false; }
    const r: TradeRequest = {
      id: `t${++this.tradeSeq}`, from: owner, item: item as ItemKey,
      amount, destinationId, status: 'open', at: this.elapsed,
    };
    this.tradeRequests.unshift(r);
    this.tradeLog('requested', `${owner === this.localPlayerId ? 'You' : 'Your ally'} requested ${amount} ${ITEMS[r.item].name.toLowerCase()}`);
    if (owner !== this.localPlayerId) { this.toast(`Your ally asks for ${amount} ${ITEMS[r.item].name.toLowerCase()} — open the Trade tab`, 'err'); this.sfx('click'); }
    return true;
  }

  /** The requester cancels their ask; the ally declines it. */
  cancelTradeRequest(actor: PlayerId, requestId: string): boolean {
    const r = this.tradeRequests.find(req => req.id === requestId && req.status === 'open');
    if (!r) return false;
    r.status = r.from === actor ? 'cancelled' : 'declined';
    this.tradeLog(r.status, `Request for ${r.amount} ${ITEMS[r.item].name.toLowerCase()} ${r.status}`);
    return true;
  }

  /** Confirm a send: reserve the goods and dispatch a cart to the ally. */
  sendTrade(owner: PlayerId, item: string, amount: number, sourceId: number, destinationId: number, requestId?: string): boolean {
    const local = owner === this.localPlayerId;
    if (!Number.isInteger(amount) || amount <= 0 || !(item in ITEMS)) return false;
    const source = this.storeById(sourceId, owner);
    const dest = this.storeById(destinationId, tradePartner(owner));
    if (!source || !dest) { if (local) this.toast('Trade needs your storehouse and a standing allied storehouse', 'err'); return false; }
    const send = Math.min(amount, source.stock![item] || 0);
    if (send <= 0) { if (local) { this.toast('Not enough ' + ITEMS[item as keyof typeof ITEMS].name.toLowerCase() + ' in that storehouse', 'err'); this.sfx('error'); } return false; }
    const sd = doorTile(source), dd = doorTile(dest);
    const path = findPath(this.world, sd.x, sd.y, dd.x, dd.y);
    if (!path) { if (local) { this.toast("No land route to your ally's storehouse", 'err'); this.sfx('error'); } return false; }
    source.stock![item] = (source.stock![item] || 0) - send;
    const u = this.spawnUnit('carrier', 0x9a7b52, sd, owner);
    u.roleName = 'Carrier';
    u.status = 'Loading the cart';
    u.hp = u.maxHp = TRADE.carrierHp;
    u.spd = BASE_SPEED * TRADE.carrierSpeedMult;
    this.setCarrying(u, item);
    const s: TradeShipment = {
      id: `t${++this.tradeSeq}`, from: owner, to: tradePartner(owner),
      item: item as ItemKey, amount: send, sourceId, destinationId,
      phase: 'loading', loadT: tradeLoadTime(send), eta: tradeEta(path.length, BASE_SPEED),
      carrier: u, requestId, at: this.elapsed,
    };
    this.tradeShipments.unshift(s);
    if (requestId) {
      const r = this.tradeRequests.find(req => req.id === requestId && req.status === 'open' && req.from === s.to);
      if (r) { r.status = 'fulfilled'; s.destinationId = this.storeById(r.destinationId, s.to) ? r.destinationId : s.destinationId; }
    }
    if (local) this.toast(`Cart loading — ${send} ${ITEMS[s.item].name.toLowerCase()} bound for your ally`);
    else this.toast(`Your ally is sending ${send} ${ITEMS[s.item].name.toLowerCase()}`);
    this.sfx('place');
    return true;
  }

  /** Cancel before dispatch; a moving cart is recalled physically. */
  cancelTradeShipment(actor: PlayerId, shipmentId: string): boolean {
    const s = this.tradeShipments.find(sh => sh.id === shipmentId && sh.from === actor);
    if (!s || !tradeShipmentActive(s)) return false;
    if (s.phase === 'loading') {
      this.refundShipment(s);
      s.phase = 'recalled';
      this.despawnCarrier(s);
      this.tradeLog('recalled', `Shipment of ${s.amount} ${ITEMS[s.item].name.toLowerCase()} cancelled before departure`);
      return true;
    }
    if (s.phase === 'enroute') {
      s.phase = 'returning';
      if (s.carrier) { s.carrier.path = null; s.carrier.status = 'Recalled — turning the cart around'; }
      if (actor === this.localPlayerId) this.toast('Shipment recalled — the cart turns for home');
      return true;
    }
    return false;
  }

  /** Return a shipment's cargo to the sender's stores (source first). */
  private refundShipment(s: TradeShipment): void {
    const source = this.storeById(s.sourceId, s.from) ?? this.stores(s.from)[0] ?? null;
    if (!source) { this.tradeLog('lost', `${s.amount} ${ITEMS[s.item].name.toLowerCase()} had nowhere to return to`); return; }
    source.stock![s.item] = (source.stock![s.item] || 0) + s.amount;
  }

  private despawnCarrier(s: TradeShipment): void {
    const u = s.carrier;
    s.carrier = null;
    if (!u) return;
    const i = this.units.indexOf(u);
    if (i >= 0) { this.view.remove(u.mesh); this.units.splice(i, 1); }
    if (this.selected === u) this.select(null);
  }

  /** Advance every active shipment: loading, the outward haul, or the recall. */
  private updateTrade(sdt: number): void {
    for (const s of this.tradeShipments) {
      if (!tradeShipmentActive(s)) continue;
      const u = s.carrier;
      if (!u || u.dead) {
        s.phase = 'lost';
        s.carrier = null;
        this.tradeLog('lost', `A caravan was lost with ${s.amount} ${ITEMS[s.item].name.toLowerCase()}`);
        this.toast(`A trade caravan was ambushed — ${s.amount} ${ITEMS[s.item].name.toLowerCase()} lost`, 'err');
        continue;
      }
      if (s.phase === 'loading') {
        s.loadT -= sdt;
        u.mesh.position.y = 0;
        if (s.loadT <= 0) { s.phase = 'enroute'; u.status = `Hauling ${ITEMS[s.item].name.toLowerCase()} to the ally`; }
        continue;
      }
      if (s.phase === 'enroute') {
        const dest = this.storeById(s.destinationId, s.to);
        if (!dest) {
          // the destination fell or was demolished mid-haul — turn for home
          s.phase = 'returning';
          u.path = null;
          u.status = 'Destination gone — returning';
          continue;
        }
        const d = doorTile(dest);
        if (u.tx === d.x && u.ty === d.y && !u.path) {
          dest.stock![s.item] = (dest.stock![s.item] || 0) + s.amount;
          s.phase = 'delivered';
          this.tradeLog('delivered', `${s.amount} ${ITEMS[s.item].name.toLowerCase()} delivered to ${s.to === this.localPlayerId ? 'you' : 'your ally'}`);
          this.toast(s.to === this.localPlayerId
            ? `Trade arrived: ${s.amount} ${ITEMS[s.item].name.toLowerCase()} from your ally`
            : `Your shipment of ${s.amount} ${ITEMS[s.item].name.toLowerCase()} was delivered`);
          this.sfx('coin');
          this.despawnCarrier(s);
          continue;
        }
        this.walkCarrier(u, d, sdt);
        continue;
      }
      // returning: walk back to the source (or any surviving own store) and unload
      const home = this.storeById(s.sourceId, s.from) ?? this.stores(s.from)[0] ?? null;
      if (!home) {
        s.phase = 'lost';
        this.tradeLog('lost', `${s.amount} ${ITEMS[s.item].name.toLowerCase()} had nowhere to return to`);
        this.despawnCarrier(s);
        continue;
      }
      const hd = doorTile(home);
      if (u.tx === hd.x && u.ty === hd.y && !u.path) {
        home.stock![s.item] = (home.stock![s.item] || 0) + s.amount;
        s.phase = 'recalled';
        this.tradeLog('recalled', `${s.amount} ${ITEMS[s.item].name.toLowerCase()} returned to the storehouse`);
        if (s.from === this.localPlayerId) this.toast('Recalled shipment unloaded back into your storehouse');
        this.despawnCarrier(s);
        continue;
      }
      this.walkCarrier(u, hd, sdt);
    }
  }

  /** Carrier movement: re-path on a throttle when blocked, then walk. */
  private walkCarrier(u: Unit, d: Coord, sdt: number): void {
    if (!u.path) {
      u.timer -= sdt;
      if (u.timer <= 0) { u.timer = 1; this.sendTo(u, d.x, d.y); }
    }
    if (u.path) this.moveUnit(u, sdt); else u.mesh.position.y = 0;
  }

  /** Toggle priority on a construction site (materials & builders go there
   *  first) or a production building (serfs feed & empty it first). */
  togglePriority(s: Site | Building): void {
    s.priority = !s.priority;
    this.sfx('click');
    this.toast(s.priority ? s.def.name + ' prioritized' : s.def.name + ' no longer prioritized');
  }

  /** Issue a command to a unit (used by Controls for hero/army orders). With
   *  `queue`, the command is appended behind whatever the unit is already doing
   *  (shift-click chaining) instead of replacing it. */
  orderUnit(u: Unit, type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null, queue = false, field: FlowField | null = null): void {
    if (UNITS[u.role as UnitKind]?.heal && type === 'attack') { type = 'attackMove'; foe = null; }
    this.queueOrder(u, { type, x, y, foe, building: null, field }, queue);
  }

  /** Store or activate one fully resolved order. Entity references stay inside
   *  the simulation; the network command carries only stable entity ids. */
  private queueOrder(u: Unit, o: UnitOrder, queue: boolean): void {
    if (queue && (u.order || u.orderQueue.length)) { u.orderQueue.push(o); return; }
    u.orderQueue.length = 0;
    this.applyOrder(u, o);
  }

  /** Make an order the unit's active command, breaking off any current fight. */
  private applyOrder(u: Unit, o: UnitOrder): void {
    u.order = o;
    u.foe = o.type === 'attack' ? o.foe : null;
    u.foeB = o.building && !o.building.removed ? o.building : null;
    u.path = null;
    u.timer = 0;
    u.obeyT = o.type === 'attack' || o.building ? 0 : 2.5;
    // A player command always cancels an old AI return-home state. Player
    // fighters never leash; anchors are only meaningful to wild/enemy guards.
    if (u.faction === 'player' && u.wstate === 'leash') u.wstate = 'idle';
  }

  /** Current command done: pull the next chained order into effect, if any.
   *  Returns true when a queued order took over, false when the queue is empty
   *  (leaving `order` cleared exactly as the old `u.order = null` did). */
  private advanceOrder(u: Unit): boolean {
    const next = u.orderQueue.shift();
    if (!next) {
      u.order = null;
      u.path = null;
      u.foe = null;
      u.foeB = null;
      u.obeyT = 0;
      return false;
    }
    this.applyOrder(u, next);
    return true;
  }

  /** Ground a formation may stand on (shared by orders and the drag preview).
   *  Must stay in lock-step with World.passable: a spot the pathfinder can't
   *  reach (a dense thicket reads as open grass here) makes sendTo fail, and
   *  that unit silently drops its order instead of marching — the root of
   *  "not all of my units moved" on big, wooded selections. */
  private readonly formationGround = (tx: number, ty: number): boolean => {
    const t = this.world.T(tx, ty);
    return !!t && t.type === 'grass' && !t.b && !t.site && !t.dep && !t.tree?.dense;
  };

  /** The tiles a selection would occupy — the right-drag aim preview. `facing`
   *  is the continuous drag direction. */
  formationPreview(units: Unit[], x: number, y: number, formation: Formation, facing: { x: number; y: number }): Coord[] {
    return formationSpots(x, y, units.length, formation, units.map(u => ({ x: u.tx, y: u.ty })), this.formationGround, facing);
  }

  /** Order a whole selection: attacks converge on the foe, moves fan out into a
   *  loose formation so the squad doesn't pile onto a single tile. An explicit
   *  `facing` (from the drag-to-aim gesture) overrides the marching direction. */
  orderGroup(units: Unit[], type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null, formation: Formation = 'box', facing?: { x: number; y: number }, queue = false): void {
    if (type === 'attack' && foe) {
      for (const u of units) this.orderUnit(u, 'attack', foe.tx, foe.ty, foe, queue);
      return;
    }
    const spots = formationSpots(x, y, units.length, formation, units.map(u => ({ x: u.tx, y: u.ty })), this.formationGround, facing);
    // one flood serves the whole selection — each unit descends it for its
    // path instead of running its own full-map A* (see engine/flowfield.ts)
    const field = units.length >= FLOW_FIELD_MIN_UNITS ? buildFlowField(this.world, spots, units[0].faction) : null;
    // spots come back front rank first; march the army in battle order so
    // melee take the leading tiles and ranged/cavalry/siege fall in behind.
    // Stable sort keeps each rank's own order (and same-rank kinds together).
    const ordered = units
      .map((u, i) => ({ u, i, r: formationRank(u.role) }))
      .sort((a, b) => a.r - b.r || a.i - b.i);
    for (let i = 0; i < ordered.length; i++) {
      // If terrain truly cannot provide enough ground, excess units hold their
      // current unique tiles rather than all collapsing onto the final slot.
      const s = spots[i] ?? { x: ordered[i].u.tx, y: ordered[i].u.ty };
      this.orderUnit(ordered[i].u, type, s.x, s.y, null, queue, field);
    }
  }

  /** The standing building on a tile, or null (Controls asks before ordering). */
  buildingAt(tx: number, ty: number): Building | null {
    const t = this.world.T(tx, ty);
    return t && t.b && !t.b.removed ? t.b : null;
  }

  /** Order a selection to raze a hostile building: everyone marches on its
   *  walls and locks it as their siege target (no waiting for auto-acquire). */
  orderGroupAttackBuilding(units: Unit[], b: Building, queue = false): void {
    if (b.removed) return;
    const assigned = units.map(u => ({ u, s: this.siegeTile(u, b) }));
    // the siege ring is a handful of tiles shared by the whole host: seed one
    // flow field from it and let every besieger descend that instead of A*-ing
    const ring = new Map<string, Coord>();
    for (const { s } of assigned) ring.set(`${s.x},${s.y}`, s);
    const field = units.length >= FLOW_FIELD_MIN_UNITS ? buildFlowField(this.world, [...ring.values()], units[0].faction) : null;
    for (const { u, s } of assigned) {
      // Support units accompany the army but do not hold a structure target
      // they cannot damage. Every fighter retains the exact target even while
      // this order waits behind earlier Shift-chained commands.
      if (UNITS[u.role as UnitKind]?.heal) this.orderUnit(u, 'attackMove', s.x, s.y, null, queue, field);
      else this.queueOrder(u, { type: 'attackMove', x: s.x, y: s.y, foe: null, building: b, field }, queue);
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

  /**
   * Muster the level's granted army OUTSIDE the castle: a tidy parade grid on
   * the open ground in front of the gate, ranks extending away from the walls
   * as the army grows. Blocked tiles dent a rank locally (tryTile skips them);
   * anything that can't fit in the parade ground falls back to a ring spawn.
   */
  spawnStartArmy(groups: { kind: UnitKind; count: number }[]): Unit[] {
    const total = groups.reduce((s, g) => s + g.count, 0);
    if (total <= 0) return [];
    const d = doorTile(this.store);
    // march direction: straight out through the castle's door side
    // (rot 0 = south, 1 = west, 2 = north, 3 = east — see doorTile)
    const [dirX, dirY] = [[0, 1], [-1, 0], [0, -1], [1, 0]][this.store.rot || 0];
    const cols = Math.max(4, Math.ceil(Math.sqrt(total * 1.8)));
    const out: Unit[] = [];
    const queue: UnitKind[] = [];
    for (const g of groups) for (let i = 0; i < g.count; i++) queue.push(g.kind);
    const tryTile = (x: number, y: number): void => {
      if (!queue.length || this.units.length >= MAX_UNITS) return;
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep || t.tree || t.field) return;
      out.push(this.spawnFighter(queue.shift()!, { x, y }, 'player'));
    };
    // first rank stands two tiles clear of the door; each following rank steps
    // one further from the castle
    for (let rank = 0; queue.length && rank < 40; rank++) {
      const rx = d.x + dirX * (2 + rank), ry = d.y + dirY * (2 + rank);
      for (let c = 0; queue.length && c < cols; c++) {
        const off = (c % 2 === 0 ? 1 : -1) * Math.ceil(c / 2); // centre-out
        tryTile(rx + (dirY !== 0 ? off : 0), ry + (dirX !== 0 ? off : 0));
      }
    }
    // whatever the parade ground couldn't hold spawns around the door instead
    for (const kind of queue.splice(0)) {
      const spare = this.spawnSquad(kind, 1, this.world.wx(d.x) + dirX * 2, this.world.wz(d.y) + dirY * 2, 'player');
      out.push(...spare);
    }
    // face the ranks away from the castle, toward the field
    for (const u of out) u.mesh.rotation.y = Math.atan2(dirX, dirY);
    return out;
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
  /** Stretches wave timers & grace delays (higher ascensions get more prep). */
  prepMult = 1;

  /** Configure and spawn a level's enemy presence (called by main after init). */
  setEnemies(setup: EnemySetup | null): void {
    this.enemy = setup;
    this.waveIdx = 0; this.waves = []; this.commanderT = 0; this.camps = [];
    this.waveArmT = null; this.bonusTime = 0;
    if (!setup) return;
    // the commander's first raid gets extra grace beyond its usual cadence
    if (setup.commander) this.commanderT = -setup.commander.every * 0.75;
    if (setup.wild) for (const w of setup.wild) this.spawnWild(w.kind, w.count);
    if (setup.stages) {
      for (let i = 0; i < setup.stages.length; i++) {
        const stage = setup.stages[i];
        const zone = this.world.enemyZones[Math.min(i, this.world.enemyZones.length - 1)];
        if ('boss' in stage) {
          this.spawnBoss(stage.boss, false, zone ?? null);
          continue;
        }
        const key: BuildingKey = stage.structure === 'camp' ? 'banditcamp' : 'enemycastle';
        const stronghold = this.spawnStronghold(key, stage.guards, stage.kinds, zone);
        if (!stronghold) continue;
        if (stage.structure === 'walledFortress') this.fortifyStronghold(stronghold);
        for (let t = 0; t < (stage.towers ?? 0); t++) this.spawnTowerNear(stronghold);
      }
    // gate garrisons: a camp planted ON each frontier pass — the enemy position
    // that must fall before the army can travel through into the walled quarter
    } else if (setup.gatecamps) {
      for (const ez of this.world.enemyZones) {
        const total = Math.round(setup.gatecamps.guards * this.garrisonMult);
        this.spawnCampNear(ez.pass.x, ez.pass.y, total, setup.gatecamps.kinds ?? ['bandit']);
      }
    }
    if (!setup.stages && setup.camps) for (const c of setup.camps) for (let i = 0; i < c.count; i++) this.spawnStronghold('banditcamp', c.guards, c.kinds);
    if (!setup.stages && setup.keep) {
      const camp = this.spawnStronghold('enemycastle', setup.keep.guards, setup.keep.kinds);
      if (camp && setup.towers) for (let i = 0; i < setup.towers; i++) this.spawnTowerNear(camp);
      if (camp && setup.keep.fortified) this.fortifyStronghold(camp);
    }
    // several fortified castles — each a walled keep ringed with watchtowers,
    // dealt round-robin into the map's walled corners / mountain pockets
    // (spawnStronghold already scales the garrison by garrisonMult)
    if (!setup.stages && setup.strongholds) {
      const s = setup.strongholds;
      for (let i = 0; i < s.count; i++) {
        const keep = this.spawnStronghold('enemycastle', s.guards, s.kinds);
        if (!keep) continue;
        this.fortifyStronghold(keep);
        for (let t = 0; t < (s.towers ?? 2); t++) this.spawnTowerNear(keep);
      }
    }
    this.pendingBoss = null;
    if (setup.boss) {
      if (this.deferBoss && this.enemyStructuresLeft() > 0) {
        this.pendingBoss = setup.boss;
        this.toast(`Raze every enemy stronghold first — only then will the ${UNITS[setup.boss].name} reveal itself`, 'err');
      } else this.spawnBoss(setup.boss);
    }
  }

  /** Player-faction fighters currently alive (arming muster-triggered raids). */
  private playerFighters(): number {
    let n = 0;
    // the ever-present hero doesn't count toward muster-triggered raids
    for (const u of this.units) if (!u.dead && u.faction === 'player' && u.dmg > 0 && u.role !== 'hero') n++;
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
    if (def.at !== undefined) return { in: Math.max(0, def.at * this.prepMult - this.elapsed), count: def.count };
    if (this.waveArmT !== null) return { in: Math.max(0, this.waveArmT - this.elapsed), count: def.count };
    return { in: Infinity, count: def.count, label: `Raiders are watching — mustering ${def.whenArmy ?? 1} fighters will provoke them` };
  }

  private combatDirector(sdt: number): void {
    if (!this.enemy) return;
    // two-phase boss: once the whole enemy garrison is razed, the held-back
    // dragon reveals itself and sweeps in from the edge for the final fight
    if (this.pendingBoss && this.enemyStructuresLeft() === 0) {
      const kind = this.pendingBoss; this.pendingBoss = null;
      this.spawnBoss(kind, true);
    }
    // launch scheduled raid waves at the castle. Waves are sequential: the
    // head wave launches on its trigger (a timestamp, or the player's muster
    // reaching size + a grace delay), then the next takes its place.
    const w = this.enemy.waves;
    while (w && this.waveIdx < w.length) {
      const def = w[this.waveIdx];
      let launch = false;
      if (def.at !== undefined) launch = this.elapsed >= def.at * this.prepMult;
      else if (this.waveArmT !== null) launch = this.elapsed >= this.waveArmT;
      else if (this.playerFighters() >= (def.whenArmy ?? 1)) {
        this.waveArmT = this.elapsed + (def.delay ?? 45) * this.prepMult;
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
    // the enemy commander sends fresh squads on a timer — but reinforcements
    // that muster "from camp" dry up once every camp and keep has been razed,
    // so a cleared map stays cleared (and the clear-all objective can be won)
    const cmd = this.enemy.commander;
    if (cmd && (cmd.from !== 'camp' || this.enemyStructuresLeft() > 0)) {
      this.commanderT += sdt;
      if (this.commanderT >= cmd.every) { this.commanderT = 0; this.spawnRaid(cmd.kind, cmd.count, cmd.from ?? 'camp'); }
    }
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

  /** In co-op, raids pick one of the two standing castles (deterministically). */
  private raidTarget(): Building | null {
    const targets: Building[] = [];
    for (const id of PLAYER_IDS) { const b = this.playerStores.get(id); if (b && !b.removed) targets.push(b); }
    if (!targets.length) return this.store ?? null;
    return targets.length === 1 ? targets[0] : targets[Math.floor(rnd() * targets.length)];
  }

  /** A raid squad from a map edge (or a camp), ordered to march on a castle. */
  private spawnRaid(kind: UnitKind, count: number, from: 'edge' | 'camp'): Unit[] {
    let ox: number, oz: number;
    if (from === 'camp' && this.camps.length) { const c = this.camps[Math.floor(rnd() * this.camps.length)]; ox = this.world.wx(c.x); oz = this.world.wz(c.y); }
    else { const e = this.randomEdge(); ox = e.x; oz = e.z; }
    const squad = this.spawnSquad(kind, count, ox, oz, 'enemy');
    const castle = this.raidTarget();
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

  /** Sandbox wave console: a raid of any size from the map edge, marching on
   *  the castle. Returns how many actually spawned. */
  summonWave(kind: UnitKind, count: number): number {
    return this.spawnRaid(kind, count, 'edge').length;
  }

  /** Sandbox waves put on a timer: each entry marches when the sim clock hits
   *  its hour. Works with or without a level enemy director. */
  private readonly pendingWaves: { kind: UnitKind; count: number; at: number }[] = [];

  /** Queue a sandbox wave `delay` sim-seconds from now (0 = at once). */
  scheduleWave(kind: UnitKind, count: number, delay: number): void {
    if (delay <= 0) { this.summonWave(kind, count); return; }
    this.pendingWaves.push({ kind, count, at: this.elapsed + delay });
    this.pendingWaves.sort((a, b) => a.at - b.at);
  }

  /** Seconds until the earliest scheduled sandbox wave, or null. */
  nextScheduledWave(): { in: number; count: number } | null {
    const w = this.pendingWaves[0];
    return w ? { in: Math.max(0, w.at - this.elapsed), count: w.count } : null;
  }

  private launchPendingWaves(): void {
    while (this.pendingWaves.length && this.elapsed >= this.pendingWaves[0].at) {
      const w = this.pendingWaves.shift()!;
      const n = this.summonWave(w.kind, w.count);
      if (n) { this.toast(`The scheduled wave marches — ${n} ${unitLabel(w.kind).toLowerCase()}${n > 1 ? 's' : ''}!`, 'err'); this.sfx('error'); }
    }
  }

  /** Scatter wild beasts across the map's OUTER band, far from the starting
   *  settlement — hunting them is a deliberate expedition, never an ambush. */
  private spawnWild(kind: UnitKind, count: number): void {
    const W = this.world.W, H = this.world.H, cx = W / 2, cy = H / 2;
    const keep = Math.max(15, Math.floor(Math.min(W, H) * 0.32));
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      const x = 2 + Math.floor(rnd() * (W - 4)), y = 2 + Math.floor(rnd() * (H - 4));
      if (Math.hypot(x - cx, y - cy) < keep) continue;
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep) continue;
      this.spawnFighter(kind, { x, y }, 'wild'); placed++;
    }
  }

  /** Extra weight on stronghold garrisons at higher ascensions (set by main). */
  garrisonMult = 1;

  /** Place an enemy stronghold away from the centre and post guards around it.
   *  `kinds` mixes the garrison round-robin; the default is all bandits. */
  private spawnStronghold(
    key: BuildingKey, guards: number, kinds: UnitKind[] = ['bandit'],
    zone?: World['enemyZones'][number],
  ): Building | null {
    const spot = this.findStrongholdSpot(zone);
    if (!spot) return null;
    const b = this.placeBuilding(key, spot.x, spot.y, true, 0, 'enemy');
    b.active = true;
    this.camps.push(b);
    const total = Math.round(guards * this.garrisonMult);
    const per = new Map<UnitKind, number>();
    for (let i = 0; i < total; i++) { const k = kinds[i % kinds.length]; per.set(k, (per.get(k) ?? 0) + 1); }
    for (const [k, n] of per) this.spawnSquad(k, n, this.world.wx(spot.x), this.world.wz(spot.y), 'enemy');
    return b;
  }

  /** A camp as close as the ground allows to a given tile (frontier passes):
   *  the camp building may sit just off the gap, but its garrison stands ON
   *  the pass so nothing slips through without a fight. */
  private spawnCampNear(px: number, py: number, guards: number, kinds: UnitKind[]): void {
    let spot: { x: number; y: number } | null = null;
    outer: for (let r = 0; r < 8 && !spot; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (this.areaClear(px + dx, py + dy)) { spot = { x: px + dx, y: py + dy }; break outer; }
      }
    }
    if (spot) {
      const b = this.placeBuilding('banditcamp', spot.x, spot.y, true, 0, 'enemy');
      b.active = true;
      this.camps.push(b);
    }
    const per = new Map<UnitKind, number>();
    for (let i = 0; i < guards; i++) { const k = kinds[i % kinds.length]; per.set(k, (per.get(k) ?? 0) + 1); }
    for (const [k, n] of per) this.spawnSquad(k, n, this.world.wx(px), this.world.wz(py), 'enemy');
  }

  /** Ring a keep with walls and one barred gate facing the player's town.
   *  Terrain that refuses a segment simply leaves a rough gap. */
  private fortifyStronghold(b: Building): void {
    const cx = this.store?.x ?? this.world.playerStart.x, cy = this.store?.y ?? this.world.playerStart.y;
    const dirx = cx - b.x, diry = cy - b.y;
    const side = Math.abs(dirx) > Math.abs(diry) ? (dirx > 0 ? 'e' : 'w') : (diry > 0 ? 's' : 'n');
    const R = 4;
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
      if (Math.abs(dx) !== R && Math.abs(dy) !== R) continue; // perimeter only
      const gate = (side === 'e' && dx === R && dy === 0) || (side === 'w' && dx === -R && dy === 0)
        || (side === 's' && dy === R && dx === 0) || (side === 'n' && dy === -R && dx === 0);
      const x = b.x + dx, y = b.y + dy;
      if (!this.areaClear(x, y)) continue;
      const rot = gate && (side === 'e' || side === 'w') ? 1 : 0;
      const w = this.placeBuilding(gate ? 'enemygate' : 'enemywall', x, y, true, rot, 'enemy');
      w.active = true;
    }
  }

  private spawnTowerNear(b: Building): void {
    for (let r = 3; r < 8; r++) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
        const x = b.x + dx, y = b.y + dy;
        if (this.areaClear(x, y)) { const t = this.placeBuilding('enemywatchtower', x, y, true, 0, 'enemy'); t.active = true; return; }
      }
    }
  }

  /** Boss health multiplier for the run's difficulty tier (set by main). */
  bossHpMult = 1;

  /** The dragon level's two-phase fight (set by main for higher ascensions):
   *  the boss is held back until every enemy encampment and fortress has been
   *  razed, then it reveals itself and sweeps in from the map edge. */
  deferBoss = false;
  private pendingBoss: UnitKind | null = null;

  /** Standing enemy garrison structures — camps, keeps and their towers. The
   *  deferred boss and the clear-all objective wait for this to reach zero.
   *  Walls & gates don't count: they're fortifications to breach, not
   *  strongholds to raze. */
  enemyStructuresLeft(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.removed || b.faction !== 'enemy') continue;
      if (b.key === 'banditcamp' || b.key === 'enemycastle' || b.key === 'enemywatchtower') n++;
    }
    return n;
  }

  /** Living hostile units on the map (clear-all objective). */
  hostileUnitsLeft(): number {
    let n = 0;
    for (const u of this.units) if (!u.dead && u.faction !== 'player') n++;
    return n;
  }

  /** True while the level still has scheduled raid waves yet to launch. */
  scheduledWavesPending(): boolean {
    const w = this.enemy?.waves;
    return !!w && this.waveIdx < w.length;
  }

  private spawnBoss(
    kind: UnitKind, fromEdge = false,
    zone: World['enemyZones'][number] | null = fromEdge ? null : this.world.enemyZone,
  ): void {
    // on frontier maps the boss broods in the walled-off enemy quarter and
    // stays there — the player picks when to march in and start that fight.
    // `fromEdge` overrides that (the deferred two-phase reveal): the boss
    // sweeps in from the map edge and bears down on the town.
    const ez = fromEdge ? null : zone;
    if (ez) {
      const squad = this.spawnSquad(kind, 1, this.world.wx(ez.x), this.world.wz(ez.y), UNITS[kind].faction);
      for (const u of squad) u.hp = u.maxHp = Math.round(u.maxHp * this.bossHpMult);
      this.toast(`The ${UNITS[kind].name} broods in its mountain lair — muster before you march`, 'err');
      return;
    }
    const e = this.randomEdge();
    const squad = this.spawnSquad(kind, 1, e.x, e.z, UNITS[kind].faction);
    const castle = this.raidTarget();
    for (const u of squad) {
      u.hp = u.maxHp = Math.round(u.maxHp * this.bossHpMult);
      u.raider = true; if (castle) this.orderUnit(u, 'attackMove', castle.x + 1, castle.y + 1);
    }
    this.toast(`The ${UNITS[kind].name} descends upon Het Gooi!`, 'err');
  }

  private areaClear(tx: number, ty: number): boolean {
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) {
      const t = this.world.T(x, y);
      if (!t || t.type !== 'grass' || t.b || t.site || t.dep || t.road) return false;
    }
    return true;
  }

  /** Deals strongholds round-robin across the map's walled enemy quarters. */
  private zoneIdx = 0;
  /** Tiles an army can walk to from the town centre (lazy, one BFS per level). */
  private reachMask: Uint8Array | null = null;
  private reachable(x: number, y: number): boolean {
    const W = this.world.W, H = this.world.H;
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (!this.reachMask) {
      // Reachable *for a besieging army*: enemy buildings can be razed, so
      // they don't wall ground off. Gate garrisons planted ON a frontier pass
      // used to plug the strict walk-mask, marking the whole quarter behind
      // them unreachable — every stronghold then fell back to random ground in
      // the player's half of the map, right next to the castle.
      const walk = (tx: number, ty: number): boolean => {
        if (this.world.passable(tx, ty)) return true;
        const t = this.world.T(tx, ty);
        return !!t && t.type === 'grass' && !!t.b && t.b.faction !== 'player' && !t.dep && !t.tree?.dense;
      };
      const seen = new Uint8Array(W * H);
      const qx: number[] = [], qy: number[] = [];
      const cx = this.world.playerStart.x + 1, cy = this.world.playerStart.y + 1;
      // seed at the first walkable tile near the centre (the castle sits on it)
      outer: for (let r = 1; r < 10; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (this.world.passable(cx + dx, cy + dy)) { qx.push(cx + dx); qy.push(cy + dy); seen[(cy + dy) * W + cx + dx] = 1; break outer; }
      }
      for (let i = 0; i < qx.length; i++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx[i] + dx, ny = qy[i] + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx]) continue;
          if (!walk(nx, ny)) continue;
          seen[ny * W + nx] = 1; qx.push(nx); qy.push(ny);
        }
      }
      this.reachMask = seen;
    }
    return !!this.reachMask[y * W + x];
  }

  private findStrongholdSpot(targetZone?: World['enemyZones'][number]): { x: number; y: number } | null {
    const W = this.world.W, H = this.world.H;
    const cx = this.world.playerStart.x + 1, cy = this.world.playerStart.y + 1;
    const spaced = (x: number, y: number) => this.camps.every(c => Math.hypot(c.x - x, c.y - y) >= 6);
    // a keep no army can walk to is no objective: demand a reachable doorstep
    const open = (x: number, y: number): boolean => {
      if (!this.areaClear(x, y) || !spaced(x, y)) return false;
      for (let oy = -1; oy <= 2; oy++) for (let ox = -1; ox <= 2; ox++) {
        if ((ox === -1 || ox === 2 || oy === -1 || oy === 2) && this.reachable(x + ox, y + oy)) return true;
      }
      return false;
    };
    // frontier maps: strongholds live inside the walled-off enemy quarters
    // (dealt round-robin when several corners are walled), crowning the
    // deepest ground in the corner rather than lining the pass
    const zones = this.world.enemyZones;
    const ez = targetZone ?? (zones.length ? zones[this.zoneIdx++ % zones.length] : null);
    if (ez) {
      let best: { x: number; y: number } | null = null, bd = -1;
      for (let tries = 0; tries < 500; tries++) {
        const x = ez.x + Math.floor((rnd() * 2 - 1) * ez.r), y = ez.y + Math.floor((rnd() * 2 - 1) * ez.r);
        if (x < 2 || y < 2 || x > W - 4 || y > H - 4) continue;
        if (Math.hypot(x - ez.x, y - ez.y) > ez.r) continue;
        if (!open(x, y)) continue;
        // Staged routes already encode depth in their zone order, so keep each
        // structure near the pocket's roomy centre. Legacy corner quarters
        // still crown their deepest ground as before.
        const score = targetZone ? -Math.hypot(x - ez.x, y - ez.y) : Math.hypot(x - cx, y - cy);
        if (score > bd || !best) { bd = score; best = { x, y }; }
      }
      if (best) return best;
      // the quarter can be waterlogged on a wet seed — fall through to anywhere
    }
    // prefer walk-reachable ground; only settle for anywhere if none exists.
    // Keep WELL clear of the player's start (scaled to the map — a flat 12
    // tiles put fallback camps in the middle of the town on big maps) and take
    // the farthest candidate rather than the first, so a fallback camp still
    // reads as frontier trouble, never a squatter beside the castle.
    const clear = Math.max(12, Math.round(Math.min(W, H) * 0.22));
    for (const anywhere of [false, true]) {
      let best: { x: number; y: number } | null = null, bd = -1;
      for (let tries = 0; tries < 400; tries++) {
        const x = 2 + Math.floor(rnd() * (W - 5)), y = 2 + Math.floor(rnd() * (H - 5));
        const d = Math.hypot(x - cx, y - cy);
        if (d < clear) continue; // keep clear of the player's start
        if (!(anywhere ? this.areaClear(x, y) : open(x, y))) continue;
        if (d > bd) { bd = d; best = { x, y }; }
      }
      if (best) return best;
    }
    return null;
  }

  /** Remove units flagged dead this tick (deferred so combat iteration stays stable). */
  private sweepDead(): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (!u.dead) continue;
      // the hero always returns: a fresh horse is saddled at the castle
      if (u === this.heroUnit) {
        this.heroUnit = null;
        this.heroRespawnT = 45;
        this.toast(`${this.heroName} has fallen — they will ride again in 45s`, 'err');
      }
      // a slain specialist reopens their post: the building idles until
      // staffBuildings sends the next free villager to move in
      if (u.home && u.home.worker === u) {
        u.home.worker = null;
        u.home.active = false;
        u.home.working = false;
        this.toast(`The ${u.home.def.name}'s ${u.roleName.toLowerCase()} was slain — a new villager is needed`, 'err');
      }
      if (this.selected === u) this.select(null);
      this.view.remove(u.mesh);
      this.units.splice(i, 1);
    }
  }

  // =====================================================================
  //  Simulation tick (already scaled by sim speed)
  // =====================================================================
  private taxT = 0;

  /** Configure how many units of one surplus resource this market offers per visit. */
  configureMarket(b: Building, item: ItemKey, amount: number): void {
    if (b.key !== 'market' || b.faction !== 'player' || b.removed || MARKET_VALUES[item] === undefined) return;
    b.marketItem = item;
    b.marketAmount = Math.max(0, Math.min(50, Number.isFinite(amount) ? Math.round(amount) : 0));
  }

  /** Projected income at one scheduled trader visit per minute. */
  marketIncomePerMinute(b: Building): number {
    return (MARKET_VALUES[b.marketItem ?? 'timber'] ?? 0) * (b.marketAmount ?? 0);
  }

  marketCaravansInTransit(b: Building): number {
    let n = 0;
    for (const c of this.caravans) if (c.market === b) n++;
    return n;
  }

  private spawnMarketCaravan(b: Building, item: ItemKey, amount: number): void {
    const centre = this.buildingCenter(b);
    const edgeX = centre.x < 0 ? -this.world.W / 2 - 2 : this.world.W / 2 + 2;
    const mesh = this.view.createTraderCaravan();
    mesh.position.set(edgeX, 0, centre.z);
    this.caravans.push({ mesh, market: b, item, amount, state: 'arriving', edgeX, edgeZ: centre.z, wait: 0 });
  }

  private updateMarkets(dt: number): void {
    for (const b of this.buildings) {
      if (b.key !== 'market' || b.faction !== 'player' || !b.active || b.removed) continue;
      b.marketTimer = Math.max(0, (b.marketTimer ?? 60) - dt);
      if (b.marketTimer > 0 || this.marketCaravansInTransit(b)) continue;
      const item = b.marketItem ?? 'timber';
      const amount = b.marketAmount ?? 0;
      if (amount <= 0) { b.marketTimer = 60; continue; }
      if ((b.inp[item] || 0) < amount) { b.marketTimer = 5; continue; }
      b.marketTimer = 60;
      this.spawnMarketCaravan(b, item, amount);
    }

    for (let i = this.caravans.length - 1; i >= 0; i--) {
      const c = this.caravans[i];
      if (c.market.removed) { this.view.remove(c.mesh); this.caravans.splice(i, 1); continue; }
      if (c.state === 'trading') {
        c.wait -= dt;
        if (c.wait <= 0) c.state = 'leaving';
        continue;
      }
      const centre = this.buildingCenter(c.market);
      const tx = c.state === 'arriving' ? centre.x : c.edgeX;
      const tz = c.state === 'arriving' ? centre.z : c.edgeZ;
      const dx = tx - c.mesh.position.x, dz = tz - c.mesh.position.z;
      const dist = Math.hypot(dx, dz), step = dt * 3;
      if (dist > 0.01) c.mesh.rotation.y = Math.atan2(dx, dz);
      if (dist > step) {
        c.mesh.position.x += dx / dist * step;
        c.mesh.position.z += dz / dist * step;
        continue;
      }
      c.mesh.position.set(tx, 0, tz);
      if (c.state === 'leaving') { this.view.remove(c.mesh); this.caravans.splice(i, 1); continue; }

      const item = c.item;
      const sold = Math.min(c.amount, c.market.inp[item] || 0);
      if (sold > 0) {
        c.market.inp[item] -= sold;
        const earned = sold * (MARKET_VALUES[item] ?? 0);
        // Coin starts at the market as output. The normal dispatcher sends a
        // serf to carry each coin back to the nearest storehouse.
        c.market.out.coin = (c.market.out.coin || 0) + earned;
        this.sfx('coin');
        this.toast(`Market exported ${sold} ${ITEMS[item].name.toLowerCase()} (+${earned} coin)`);
      }
      c.state = 'trading'; c.wait = 2.5;
    }
  }

  /** Order-following A* searches allowed this tick (see combatUpdate). At 20
   *  ticks/s this streams ~560 fresh paths a second — a thousand-strong army
   *  is fully under way within two seconds, with no single-tick freeze. */
  private pathBudget = 0;

  /** Flow-field descents allowed this tick. A descent is O(path length) —
   *  ~50× cheaper than a full A* — so group orders get a far bigger budget:
   *  at 20 ticks/s a 300-strong host is fully under way within 0.1 s. */
  private flowBudget = 0;

  update(sdt: number): void {
    this.elapsed += sdt;
    this.pathBudget = 28;
    this.flowBudget = 160;
    this.buildUnitHash(); // shared by all proximity queries this tick
    this.updateMarkets(sdt);
    this.dispatchT += sdt;
    if (this.dispatchT > 0.45) { this.dispatchT = 0; this.dispatch(); }
    // the Taxman mutator collects on the minute
    const tax = this.mods.taxPerMin();
    if (tax > 0) {
      this.taxT += sdt;
      if (this.taxT >= 60) { this.taxT -= 60; this.onGold(-tax); this.toast(`The Taxman collects ${tax} gold`, 'err'); }
    }
    // a fallen hero rides back out once their timer runs down
    if (this.heroRespawnT > 0 && this.heroId) {
      this.heroRespawnT -= sdt;
      if (this.heroRespawnT <= 0) {
        this.heroRespawnT = 0;
        this.spawnHero(this.heroId, this.heroName);
        this.toast(`${this.heroName} rides again!`);
        this.sfx('build');
      }
    }
    const hungerRate = this.mods.hungerRate();
    for (const u of this.units) {
      if (u.dead) continue;
      u.hunger = Math.max(0, u.hunger - sdt * 100 / 600 * hungerRate);
      if (this.isFighter(u)) this.combatUpdate(u, sdt);
      else if (u.role === 'carrier') continue; // trade carts are driven by updateTrade
      else if ((u.owner === 'p1' || u.owner === 'p2') && this.bells.has(u.owner) && u.faction === 'player') this.refugeUpdate(u, sdt);
      else if (u.role === 'serf') this.serfUpdate(u, sdt);
      else if (u.role === 'laborer') this.laborerUpdate(u, sdt);
      else if (u.role === 'villager' && !u.home) this.villagerStroll(u, sdt);
      else this.workerUpdate(u, sdt);
    }
    this.updateTrade(sdt);
    this.separate(sdt);
    this.updateProjectiles(sdt);
    this.updateFlames(sdt);
    this.sweepDead();
    this.growthUpdate(sdt);
    this.serveTaverns(sdt);
    this.trainQueues(sdt);
    this.staffBuildings();
    this.combatDirector(sdt);
    this.launchPendingWaves();
    this.pickupScanT += sdt;
    if (this.pickupScanT > 0.3 && this.pickups.length) { this.pickupScanT = 0; this.collectPickups(); }
    this.towerFire(sdt); // towers watch on every level, with or without a director
    this.fieldT += sdt;
    if (this.fieldT > 0.5) { this.fieldT = 0; this.fieldRecolor(); }
  }

  /** Queue a unit at a barracks/guild hall, paying its own cost from the store. */
  trainUnit(b: Building, kind: string): boolean {
    const spec = b.def.military ?? b.def.trainer;
    const t = spec?.units.find(s => s.kind === kind);
    if (!t || !b.active) return false;
    if (b.owner !== 'p1' && b.owner !== 'p2') return false;
    if (!this.playerStores.get(b.owner)?.stock) return false;
    for (const k in t.cost) if (this.storeTotal(k, b.owner) < (t.cost as any)[k]) { this.toast('Not enough ' + ITEMS[k as keyof typeof ITEMS].name.toLowerCase() + ' to train a ' + unitLabel(kind).toLowerCase(), 'err'); this.sfx('error'); return false; }
    for (const k in t.cost) this.takeStock(k, (t.cost as any)[k], b.owner);
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
    if (t && (b.owner === 'p1' || b.owner === 'p2')) {
      const store = this.storeFor(b.owner);
      for (const k in t.cost) store.stock![k] = (store.stock![k] || 0) + (t.cost as any)[k];
    }
    this.sfx('click');
  }

  /** Spawn a civilian worker (serf / laborer / villager) at a tile. */
  private spawnCivilian(role: string, tile: { x: number; y: number }, owner: PlayerId = this.localPlayerId): Unit {
    if (role === 'serf') return this.spawnUnit('serf', 0xd8c49a, tile, owner);
    if (role === 'laborer') { const u = this.spawnUnit('laborer', 0xc97b3d, tile, owner); u.roleName = 'Builder'; u.anchor = { x: tile.x, y: tile.y }; return u; }
    const u = this.spawnUnit('villager', 0xcdbb8f, tile, owner); u.roleName = 'Villager'; u.status = 'Awaiting a post'; return u;
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
          const owner = b.owner === 'p2' ? 'p2' : 'p1';
          const u = this.spawnFighter(kind as UnitKind, { x: d.x, y: d.y }, 'player', owner);
          this.objective?.onTrain(); // military drill counts toward produceTrain goals
          if (b.rally) this.orderUnit(u, 'attackMove', b.rally.x, b.rally.y); // muster at the flag
        } else this.spawnCivilian(kind, { x: d.x, y: d.y }, b.owner === 'p2' ? 'p2' : 'p1');
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
        if (u.dead || u.owner !== b.owner || u.role !== 'villager' || u.home) continue;
        const dd = Math.abs(u.tx - b.x) + Math.abs(u.ty - b.y);
        if (dd < bd) { bd = dd; best = u; }
      }
      if (!best) continue;
      const tile = { x: best.tx, y: best.ty };
      this.view.remove(best.mesh); this.units.splice(this.units.indexOf(best), 1);
      if (this.selected === best) this.select(null);
      const def = b.def;
      const u = this.spawnUnit(def.worker!.toLowerCase(), def.wcolor!, tile, b.owner === 'p2' ? 'p2' : 'p1');
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
        .filter(u => u.owner === b.owner && u.faction === 'player' && !this.isFighter(u) && u.hunger < 90)
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
