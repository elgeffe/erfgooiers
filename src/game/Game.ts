import * as THREE from 'three';
import { ROAD_STONE_COST, PLOT_RANGE, BASE_SPEED, MAX_UNITS } from '../constants';
import { DEFS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { UNITS, formationRank, type UnitKind } from '../data/units';
import type { EnemySetup } from '../data/levels';
import { simRng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import { buildFlowField, fieldPath, type FlowField } from '../engine/flowfield';
import { formationSpots } from '../engine/formations';
import type { World } from '../world/World';
import type { View } from '../render/View';
import { PLAYER_IDS, type Building, type BuildingKey, type Coord, type Faction, type Formation, type ItemKey, type OwnerId, type PlayerId, type Site, type Unit, type UnitOrder } from '../types';
import { buildingEntranceTiles, doorTile } from './util';
import { Modifiers } from './Modifiers';
import type { Objective } from './Objectives';
import { canControl, ownerForFaction } from './ownership';
import { TradeSystem } from './TradeSystem';
import { EncounterDirector } from './EncounterDirector';
import { ProjectileSystem } from './ProjectileSystem';
import { MarketSystem } from './MarketSystem';
import { SeparationSystem } from './SeparationSystem';
import { UnitSpatialIndex } from './UnitSpatialIndex';
import { DamageSystem } from './DamageSystem';
import { EnemySpawner } from './EnemySpawner';
import { TrainingSystem } from './TrainingSystem';
import type { TradeHistoryEntry, TradeRequest, TradeShipment } from './trade';
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
  private dispatchT = 0;
  private fieldT = 0;
  private roadWarnT = 0;
  private plotWarnT = 0;
  private nextEntityId = 1;
  private readonly trade: TradeSystem;
  private readonly encounters: EncounterDirector;
  private readonly projectileSystem: ProjectileSystem;
  private readonly marketSystem: MarketSystem;
  private readonly separationSystem: SeparationSystem;
  private readonly unitSpatialIndex: UnitSpatialIndex;
  private readonly damageSystem: DamageSystem;
  private readonly enemySpawner: EnemySpawner;
  private readonly trainingSystem: TrainingSystem;
  readonly tradeRequests: TradeRequest[];
  readonly tradeShipments: TradeShipment[];
  readonly tradeHistory: TradeHistoryEntry[];

  constructor(
    private readonly world: World,
    private readonly view: View,
    readonly mods: Modifiers = new Modifiers(),
    readonly localPlayerId: PlayerId = 'p1',
  ) {
    this.trade = new TradeSystem({
      localPlayerId,
      now: () => this.elapsed,
      entityById: id => this.entityById(id),
      stores: owner => this.stores(owner),
      pathLength: (from, to) => findPath(this.world, from.x, from.y, to.x, to.y)?.length ?? null,
      spawnCarrier: (owner, at) => this.spawnUnit('carrier', 0x9a7b52, at, owner),
      setCarrying: (unit, item) => this.setCarrying(unit, item),
      despawnCarrier: unit => {
        const index = this.units.indexOf(unit);
        if (index >= 0) { this.view.remove(unit.mesh); this.units.splice(index, 1); }
        if (this.selected === unit) this.select(null);
      },
      sendTo: (unit, destination) => this.sendTo(unit, destination.x, destination.y),
      moveUnit: (unit, dt) => { this.moveUnit(unit, dt); },
      toast: (message, cls) => this.toast(message, cls),
      sfx: name => this.sfx(name),
    });
    this.tradeRequests = this.trade.requests;
    this.tradeShipments = this.trade.shipments;
    this.tradeHistory = this.trade.history;
    this.enemySpawner = new EnemySpawner(this.world, {
      buildings: () => this.buildings,
      units: () => this.units,
      playerStore: owner => this.playerStores.get(owner) ?? null,
      primaryStore: () => this.store ?? null,
      spawnFighter: (kind, tile, faction) => this.spawnFighter(kind, tile, faction),
      spawnSquad: (kind, count, x, z, faction) => this.spawnSquad(kind, count, x, z, faction),
      placeBuilding: (key, x, y, rotation) => this.placeBuilding(key, x, y, true, rotation, 'enemy'),
      orderAttackMove: (unit, x, y) => this.orderUnit(unit, 'attackMove', x, y),
      toast: (message, cls) => this.toast(message, cls),
    });
    this.encounters = new EncounterDirector({
      now: () => this.elapsed,
      enemyZones: () => this.world.enemyZones,
      garrisonMult: () => this.garrisonMult,
      deferBoss: () => this.deferBoss,
      resetPlacement: () => this.enemySpawner.resetPlacement(),
      spawnWild: (kind, count) => this.spawnWild(kind, count),
      spawnBoss: (kind, fromEdge, zone) => this.spawnBoss(kind, fromEdge, zone),
      spawnStronghold: (key, guards, kinds, zone) => this.spawnStronghold(key, guards, kinds, zone),
      spawnCampNear: (x, y, guards, kinds) => this.spawnCampNear(x, y, guards, kinds),
      fortifyStronghold: building => this.fortifyStronghold(building),
      spawnTowerNear: building => this.spawnTowerNear(building),
      spawnRaid: (kind, count, from) => this.spawnRaid(kind, count, from),
      summonWave: (kind, count) => this.summonWave(kind, count),
      playerFighters: () => this.playerFighters(),
      enemyStructuresLeft: () => this.enemyStructuresLeft(),
      onWaveCleared: () => this.objective?.onWaveCleared(),
      toast: (message, cls) => this.toast(message, cls),
      sfx: name => this.sfx(name),
    });
    this.projectileSystem = new ProjectileSystem({
      worldSize: () => ({ width: this.world.W, height: this.world.H }),
      buildings: () => this.buildings,
      createArrow: () => this.view.createArrow(),
      createRock: () => this.view.createRock(),
      createFireball: () => this.view.createFireball(),
      createFlame: () => this.view.createFlame(),
      remove: mesh => this.view.remove(mesh),
      sfx: name => this.sfx(name),
      forUnitsNear: (x, y, radius, visit) => this.forUnitsNear(x, y, radius, visit),
      hostile: (from, to) => this.hostile(from, to),
      hurtUnit: (shooter, target, damage) => this.hurtUnit(shooter, target, damage),
      buildingCenter: building => this.buildingCenter(building),
      hurtBuilding: (building, damage, x, z) => {
        building.hp -= damage;
        this.onHurt(x, z, building.faction);
        if (building.hp <= 0) this.destroyBuilding(building);
      },
      onHurt: (x, z, faction) => this.onHurt(x, z, faction),
    });
    this.marketSystem = new MarketSystem({
      buildings: () => this.buildings,
      worldWidth: () => this.world.W,
      buildingCenter: building => this.buildingCenter(building),
      createCaravan: () => this.view.createTraderCaravan(),
      remove: mesh => this.view.remove(mesh),
      sfx: name => this.sfx(name),
      toast: message => this.toast(message),
    });
    this.separationSystem = new SeparationSystem(this.world, this.units);
    this.unitSpatialIndex = new UnitSpatialIndex(this.world, this.units);
    this.damageSystem = new DamageSystem({
      units: () => this.units,
      playerStore: owner => this.playerStores.get(owner) ?? null,
      buildingCenter: building => this.buildingCenter(building),
      removeBuilding: building => this.removeBuilding(building),
      onHurt: (x, z, faction) => this.onHurt(x, z, faction),
      onDeath: (x, z, faction, color, role, scale) => this.onDeath(x, z, faction, color, role, scale),
      onKill: unit => this.onKill(unit),
      onObjectiveKill: (role, faction) => this.objective?.onKill(role, faction),
      onStructureDestroyed: faction => this.objective?.onStructureDestroyed(faction),
      markDefeat: () => { this.defeat = true; },
      toast: (message, cls) => this.toast(message, cls),
      sfx: name => this.sfx(name),
    });
    this.trainingSystem = new TrainingSystem(this.mods, {
      buildings: () => this.buildings,
      units: () => this.units,
      storeFor: owner => this.storeFor(owner),
      storeTotal: (item, owner) => this.storeTotal(item, owner),
      takeStock: (item, amount, owner) => this.takeStock(item, amount, owner),
      spawnUnit: (role, color, tile, owner) => this.spawnUnit(role, color, tile, owner),
      spawnFighter: (kind, tile, owner) => this.spawnFighter(kind, tile, 'player', owner),
      orderAttackMove: (unit, x, y) => this.orderUnit(unit, 'attackMove', x, y),
      removeUnit: unit => {
        this.view.remove(unit.mesh);
        this.units.splice(this.units.indexOf(unit), 1);
        if (this.selected === unit) this.select(null);
      },
      onTrain: () => this.objective?.onTrain(),
      onGold: amount => this.onGold(amount),
      toast: (message, cls) => this.toast(message, cls),
      sfx: name => this.sfx(name),
    });
  }

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
    b.rally = s.rally;
    b.rallyMesh = s.rallyMesh;
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
      if (!u.path && (u.tx !== d.x || u.ty !== d.y)) { if (!this.sendTo(u, d.x, d.y)) u.timer = 1; }
      if (u.path) this.moveUnit(u, dt);
      // Commit staffing on the arrival tick. Waiting until the next update lets
      // crowd separation push the worker off the door before this check, which
      // can trap specialists in a permanent move-in/repath loop.
      if (!u.path && u.tx === d.x && u.ty === d.y) {
        u.wstate = 'home'; b.active = true; u.status = 'At work';
        this.toast(b.def.name + ' is now staffed');
        return;
      }
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
    if (s.rallyMesh) this.view.remove(s.rallyMesh);
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
    this.marketSystem.removeBuilding(b);
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
  private buildUnitHash(): void {
    this.unitSpatialIndex.rebuild();
  }

  /** Visit live units whose tick-start tile is within ~r tiles of (tx, ty). */
  private forUnitsNear(tx: number, ty: number, r: number, fn: (o: Unit) => void): void {
    this.unitSpatialIndex.visitNear(tx, ty, r, fn);
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
    this.damageSystem.hurtUnit(source, victim, dmg);
  }

  private attack(attacker: Unit, foe: Unit): void {
    this.damageSystem.attackUnit(attacker, foe);
  }

  /** The strike sound a melee unit makes, chosen by what it is: light blades
   *  ring, heavy cavalry and knights clang, the shambling undead land wet
   *  blunt thuds, beasts snap and bite, demons rake. Archers and siege loose
   *  projectiles (their own sounds) so they swing silently here. */
  private meleeSfx(u: Unit): 'sword' | 'clang' | 'maul' | 'bite' | 'claw' | null {
    return this.damageSystem.meleeSound(u);
  }

  private combatUpdate(u: Unit, dt: number): void {
    const def = UNITS[u.role as UnitKind];
    // Explicit targets complete as soon as they fall, including support-unit
    // orders. Advancing in a loop also skips targets destroyed earlier in the
    // same tick.
    while (u.order && (
      (u.order.type === 'attack' && (!u.order.foe || u.order.foe.dead)) ||
      (u.order.building?.removed ?? false)
    )) this.advanceOrder(u);
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
      if (u.order?.type === 'attack' && def.standoff && d < def.standoff) {
        this.retreatFrom(u, foe, def.standoff, dt);
      } else if (d <= reach) {
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
    const orderedFoe = u.order?.type === 'attack' && u.order.foe && !u.order.foe.dead ? u.order.foe : null;
    if (orderedFoe) {
      const standoff = UNITS[u.role as UnitKind].standoff ?? heal.range;
      const d = this.unitDist(u, orderedFoe);
      if (d < standoff) this.retreatFrom(u, orderedFoe, standoff, dt);
      else if (d > standoff + 0.75) {
        if (!u.path && this.pathBudget > 0) {
          this.pathBudget--;
          this.sendTo(u, orderedFoe.tx, orderedFoe.ty);
        }
        if (u.path) this.moveUnit(u, dt); else this.groundPose(u, false);
        this.faceUnit(u, orderedFoe);
        u.status = 'Following at a safe distance';
      } else {
        u.path = null;
        this.faceUnit(u, orderedFoe);
        this.groundPose(u, false);
        u.status = 'Holding at a safe distance';
      }
      return;
    }
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

  /** Back away from an explicitly ordered foe until the unit reaches its
   *  preferred range. Existing safe retreat paths are reused; chase paths
   *  ending beside the foe are discarded immediately. */
  private retreatFrom(u: Unit, foe: Unit, standoff: number, dt: number): void {
    const fx = foe.mesh.position.x, fz = foe.mesh.position.z;
    const endpoint = u.path?.[u.path.length - 1];
    if (endpoint && Math.hypot(this.world.wx(endpoint.x) - fx, this.world.wz(endpoint.y) - fz) < standoff) u.path = null;

    if (!u.path && this.pathBudget > 0) {
      let dx = u.mesh.position.x - fx, dz = u.mesh.position.z - fz;
      let len = Math.hypot(dx, dz);
      if (len < 1e-4) {
        dx = ((u.id + foe.id) & 1) ? 1 : -1;
        dz = ((u.id ^ foe.id) & 1) ? 1 : -1;
        len = Math.hypot(dx, dz);
      }
      const idealX = fx + dx / len * (standoff + 0.75);
      const idealZ = fz + dz / len * (standoff + 0.75);
      const baseX = Math.round(idealX + this.world.W / 2 - 0.5);
      const baseY = Math.round(idealZ + this.world.H / 2 - 0.5);
      const currentDistance = this.unitDist(u, foe);
      let best: Coord | null = null, bestScore = Infinity;
      for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
        const x = baseX + ox, y = baseY + oy;
        if (!this.world.passable(x, y, u.faction)) continue;
        const wx = this.world.wx(x), wz = this.world.wz(y);
        const safety = Math.hypot(wx - fx, wz - fz);
        if (safety <= currentDistance + 0.2) continue;
        const score = Math.hypot(wx - idealX, wz - idealZ) + Math.abs(safety - standoff) * 0.15;
        if (score < bestScore) { bestScore = score; best = { x, y }; }
      }
      if (best) {
        this.pathBudget--;
        this.sendTo(u, best.x, best.y);
      }
    }
    if (u.path) this.moveUnit(u, dt); else this.groundPose(u, false);
    this.faceUnit(u, foe);
    u.status = 'Keeping distance';
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
    this.damageSystem.attackBuilding(u, b);
  }

  private destroyBuilding(b: Building): void {
    this.damageSystem.destroyBuilding(b);
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
  /** Loose an arrow at a unit; damage lands when the arrow does. */
  private fireArrow(shooter: Unit | null, from: Faction, x: number, y: number, z: number, target: Unit, dmg: number): void {
    this.projectileSystem.fireArrow(shooter, from, x, y, z, target, dmg);
  }

  /** Heave an onager rock at a ground point; it splashes over `radius` tiles
   *  where it lands. Unlike an arrow it does not home — it batters whatever is
   *  still standing in the target cluster when it comes down. */
  private fireRock(shooter: Unit | null, from: Faction, x: number, y: number, z: number, ex: number, ez: number, dmg: number, radius: number): void {
    this.projectileSystem.fireRock(shooter, from, x, y, z, ex, ez, dmg, radius);
  }

  /** Spit a gob of dragon fire at a ground point; it splashes where it lands. */
  private fireFlame(shooter: Unit | null, from: Faction, x: number, y: number, z: number, ex: number, ez: number, dmg: number): void {
    this.projectileSystem.fireFlame(shooter, from, x, y, z, ex, ez, dmg);
  }

  private updateProjectiles(sdt: number): void {
    this.projectileSystem.update(sdt);
  }

  // =====================================================================
  //  Separation — units softly shoulder each other aside, never stacking
  // =====================================================================
  private separate(dt: number): void {
    this.separationSystem.update(dt);
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
  /** Ask the ally for goods, delivered to one of your own storehouses. */
  requestTrade(owner: PlayerId, item: string, amount: number, destinationId: number): boolean {
    return this.trade.request(owner, item, amount, destinationId);
  }

  /** The requester cancels their ask; the ally declines it. */
  cancelTradeRequest(actor: PlayerId, requestId: string): boolean {
    return this.trade.cancelRequest(actor, requestId);
  }

  /** Confirm a send: reserve the goods and dispatch a cart to the ally. */
  sendTrade(owner: PlayerId, item: string, amount: number, sourceId: number, destinationId: number, requestId?: string): boolean {
    return this.trade.send(owner, item, amount, sourceId, destinationId, requestId);
  }

  /** Cancel before dispatch; a moving cart is recalled physically. */
  cancelTradeShipment(actor: PlayerId, shipmentId: string): boolean {
    return this.trade.cancelShipment(actor, shipmentId);
  }

  /** Advance every active shipment: loading, the outward haul, or the recall. */
  private updateTrade(sdt: number): void {
    this.trade.update(sdt);
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
  setRally(b: Building | Site, x: number, y: number): void {
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
  /** Extra seconds granted to the level's hard timer (waves with bonusTime). */
  get bonusTime(): number { return this.encounters.bonusTime; }
  /** Stretches wave timers & grace delays (higher ascensions get more prep). */
  get prepMult(): number { return this.encounters.prepMult; }
  set prepMult(value: number) { this.encounters.prepMult = value; }

  /** Configure and spawn a level's enemy presence (called by main after init). */
  setEnemies(setup: EnemySetup | null): void {
    this.encounters.configure(setup);
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
    return this.encounters.nextWave();
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

  /** A raid squad from a map edge (or a camp), ordered to march on a castle. */
  private spawnRaid(kind: UnitKind, count: number, from: 'edge' | 'camp'): Unit[] {
    return this.enemySpawner.spawnRaid(kind, count, from);
  }

  /** Extra wild presence from a level mutator (e.g. Wolf Country's packs). */
  spawnMutatorWild(kind: UnitKind, count: number): void { this.spawnWild(kind, count); }

  /** Sandbox wave console: a raid of any size from the map edge, marching on
   *  the castle. Returns how many actually spawned. */
  summonWave(kind: UnitKind, count: number): number {
    return this.spawnRaid(kind, count, 'edge').length;
  }

  /** Queue a sandbox wave `delay` sim-seconds from now (0 = at once). */
  scheduleWave(kind: UnitKind, count: number, delay: number): void {
    this.encounters.scheduleWave(kind, count, delay);
  }

  /** Seconds until the earliest scheduled sandbox wave, or null. */
  nextScheduledWave(): { in: number; count: number } | null {
    return this.encounters.nextScheduledWave();
  }

  /** Scatter wild beasts across the map's OUTER band, far from the starting
   *  settlement — hunting them is a deliberate expedition, never an ambush. */
  private spawnWild(kind: UnitKind, count: number): void {
    this.enemySpawner.spawnWild(kind, count);
  }

  /** Extra weight on stronghold garrisons at higher ascensions (set by main). */
  get garrisonMult(): number { return this.enemySpawner.garrisonMult; }
  set garrisonMult(value: number) { this.enemySpawner.garrisonMult = value; }

  /** Place an enemy stronghold away from the centre and post guards around it.
   *  `kinds` mixes the garrison round-robin; the default is all bandits. */
  private spawnStronghold(
    key: BuildingKey, guards: number, kinds: UnitKind[] = ['bandit'],
    zone?: World['enemyZones'][number],
  ): Building | null {
    return this.enemySpawner.spawnStronghold(key, guards, kinds, zone);
  }

  /** A camp as close as the ground allows to a given tile (frontier passes):
   *  the camp building may sit just off the gap, but its garrison stands ON
   *  the pass so nothing slips through without a fight. */
  private spawnCampNear(px: number, py: number, guards: number, kinds: UnitKind[]): void {
    this.enemySpawner.spawnCampNear(px, py, guards, kinds);
  }

  /** Ring a keep with walls and one barred gate facing the player's town.
   *  Terrain that refuses a segment simply leaves a rough gap. */
  private fortifyStronghold(b: Building): void {
    this.enemySpawner.fortifyStronghold(b);
  }

  private spawnTowerNear(b: Building): void {
    this.enemySpawner.spawnTowerNear(b);
  }

  /** Boss health multiplier for the run's difficulty tier (set by main). */
  get bossHpMult(): number { return this.enemySpawner.bossHpMult; }
  set bossHpMult(value: number) { this.enemySpawner.bossHpMult = value; }

  /** The dragon level's two-phase fight (set by main for higher ascensions):
   *  the boss is held back until every enemy encampment and fortress has been
   *  razed, then it reveals itself and sweeps in from the map edge. */
  deferBoss = false;

  /** Standing enemy garrison structures — camps, keeps and their towers. The
   *  deferred boss and the clear-all objective wait for this to reach zero.
   *  Walls & gates don't count: they're fortifications to breach, not
   *  strongholds to raze. */
  enemyStructuresLeft(): number {
    return this.enemySpawner.enemyStructuresLeft();
  }

  /** Living hostile units on the map (clear-all objective). */
  hostileUnitsLeft(): number {
    return this.enemySpawner.hostileUnitsLeft();
  }

  /** True while the level still has scheduled raid waves yet to launch. */
  scheduledWavesPending(): boolean {
    return this.encounters.scheduledWavesPending();
  }

  private spawnBoss(
    kind: UnitKind, fromEdge = false,
    zone: World['enemyZones'][number] | null = fromEdge ? null : this.world.enemyZone,
  ): void {
    this.enemySpawner.spawnBoss(kind, fromEdge, zone);
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
    this.marketSystem.configure(b, item, amount);
  }

  /** Projected income at one scheduled trader visit per minute. */
  marketIncomePerMinute(b: Building): number {
    return this.marketSystem.incomePerMinute(b);
  }

  marketCaravansInTransit(b: Building): number {
    return this.marketSystem.caravansInTransit(b);
  }

  private updateMarkets(dt: number): void {
    this.marketSystem.update(dt);
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
    this.sweepDead();
    this.growthUpdate(sdt);
    this.serveTaverns(sdt);
    this.trainQueues(sdt);
    this.staffBuildings();
    this.encounters.update(sdt);
    this.pickupScanT += sdt;
    if (this.pickupScanT > 0.3 && this.pickups.length) { this.pickupScanT = 0; this.collectPickups(); }
    this.towerFire(sdt); // towers watch on every level, with or without a director
    this.fieldT += sdt;
    if (this.fieldT > 0.5) { this.fieldT = 0; this.fieldRecolor(); }
  }

  /** Queue a unit at a barracks/guild hall, paying its own cost from the store. */
  trainUnit(b: Building, kind: string): boolean {
    return this.trainingSystem.trainUnit(b, kind);
  }

  /** Cancel a queued training order by index, refunding its cost to the store. */
  cancelTrain(b: Building, index: number): void {
    this.trainingSystem.cancelTrain(b, index);
  }

  /** Spawn a civilian worker (serf / laborer / villager) at a tile. */
  private spawnCivilian(role: string, tile: { x: number; y: number }, owner: PlayerId = this.localPlayerId): Unit {
    return this.trainingSystem.spawnCivilian(role, tile, owner);
  }

  /** Barracks & guild halls turn their player-built queue into units over time. */
  private trainQueues(sdt: number): void {
    this.trainingSystem.updateQueues(sdt);
  }

  /** Send an idle villager to become the specialist of each unstaffed building. */
  private staffBuildings(): void {
    this.trainingSystem.staffBuildings();
  }

  /** Taverns burn food on a timer to refill the hunger of workers, up to capacity. */
  private serveTaverns(sdt: number): void {
    this.trainingSystem.serveTaverns(sdt);
  }
}
