import { DEFS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { UNITS, type UnitKind } from '../data/units';
import type { EnemySetup } from '../data/levels';
import { findPath } from '../engine/pathfinding';
import type { FlowField } from '../engine/flowfield';
import type { World } from '../world/World';
import type { View } from '../render/View';
import { type Building, type BuildingKey, type Coord, type Faction, type Formation, type ItemKey, type OwnerId, type PlayerId, type Site, type Unit, PLAYER_IDS } from '../types';
import { doorTile } from './util';
import { Modifiers, type ModifierSpec } from './Modifiers';
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
import { LogisticsSystem } from './LogisticsSystem';
import { WorkerSystem } from './WorkerSystem';
import { UnitMovement } from './UnitMovement';
import { CombatTargeting } from './CombatTargeting';
import { CombatSystem } from './CombatSystem';
import { PlacementSystem } from './PlacementSystem';
import { OrderSystem } from './OrderSystem';
import { RefugeSystem } from './RefugeSystem';
import { EconomyState, type WorkerMetrics } from './EconomyState';
import { UnitFactory } from './UnitFactory';
import { InteractionSystem } from './InteractionSystem';
import type { TradeHistoryEntry, TradeRequest, TradeShipment } from './trade';
import { applyGameCommand } from './commands';
import type { GameCommand } from '../net/protocol';

/** Selections at or above this size share one flow field per order instead of
 *  running one global A* per unit. Below it the flood costs more than it saves. */
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
  /** Co-op only: each player's chosen preset building colour (empty in single player). */
  readonly playerColors = new Map<PlayerId, number>();
  selected: any = null;
  simSpeed = 1;
  /** Buildings the first-ascension onboarding has not unlocked yet on this
   *  level (empty on every other tier and in sandbox/co-op). Placement is
   *  refused for these; the UI greys their cards out. */
  lockedBuildings = new Set<BuildingKey>();
  /** The local player's mounted hero on this level (null in sandbox / before spawn). */
  get heroUnit(): Unit | null { return this.playerHeroes.get(this.localPlayerId) ?? null; }
  /** Seconds until the local player's fallen hero rides back out (0 = alive/none). */
  get heroRespawnT(): number { return this.heroRespawn.get(this.localPlayerId) ?? 0; }
  /** Per-player hero identity and respawn timers. Co-op runs two heroes at once,
   *  so death and respawn are tracked per owner and resolved identically on both
   *  peers — never off the single local hero, which would desync. */
  private readonly heroIdentity = new Map<PlayerId, { id: string; name: string }>();
  private readonly heroRespawn = new Map<PlayerId, number>();

  /** Sim seconds elapsed this level (drives the hard timer & speed bonus). */
  elapsed = 0;
  /** The level's objective tracker, or null (e.g. debug/sandbox). */
  objective: Objective | null = null;
  /** Set true when the castle is razed (or later, the hero dies) — main ends the run. */
  defeat = false;
  /**
   * Diplomacy as data: owners on different teams are hostile. The solo/co-op
   * default keeps every player seat on one team against enemy+wild (who share
   * a side, matching the old faction rule). Skirmish gives each player their
   * own team; supporting more seats or team games later is only more entries.
   */
  private teams: Record<OwnerId, number> = { p1: 0, p2: 0, enemy: 1, wild: 1 };
  /** True when at least two player seats are mutually hostile (PvP skirmish). */
  pvp = false;
  /** Player seats whose castle has fallen. In PvP main resolves win/lose off
   *  this instead of the shared `defeat` flag — identical on both peers. */
  readonly eliminated = new Set<PlayerId>();

  setTeams(teams: Record<OwnerId, number>): void {
    this.teams = { ...teams };
    this.pvp = PLAYER_IDS.some(a => PLAYER_IDS.some(b => a !== b && this.hostileOwners(a, b)));
  }

  /** Are two owners hostile? The single diplomacy predicate for every combat system. */
  hostileOwners(a: OwnerId, b: OwnerId): boolean {
    return this.teams[a] !== this.teams[b];
  }

  toast: (msg: string, cls?: string) => void = () => {};
  /**
   * Route a toast, but in co-op suppress notifications about the *other*
   * player's assets so each player only sees events for their own settlement.
   * An undefined (or enemy/wild) owner is a shared event — a raid, a level
   * message — and always shows. In single player the local id is always the
   * acting owner, so nothing is ever dropped.
   */
  private emitToast(msg: string, cls?: string, owner?: OwnerId): void {
    if ((owner === 'p1' || owner === 'p2') && owner !== this.localPlayerId) return;
    this.toast(msg, cls);
  }
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

  private dispatchT = 0;
  private fieldT = 0;
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
  private readonly logisticsSystem: LogisticsSystem;
  private readonly workerSystem: WorkerSystem;
  private readonly unitMovement: UnitMovement;
  private readonly combatTargeting: CombatTargeting;
  private readonly combatSystem: CombatSystem;
  private readonly placementSystem: PlacementSystem;
  private readonly orderSystem: OrderSystem;
  private readonly refugeSystem: RefugeSystem;
  private readonly economyState: EconomyState;
  private readonly unitFactory: UnitFactory;
  private readonly interactionSystem: InteractionSystem;
  readonly tradeRequests: TradeRequest[];
  readonly tradeShipments: TradeShipment[];
  readonly tradeHistory: TradeHistoryEntry[];

  /** Per-player rule sets in co-op (difficulty base + that player's hero). Empty
   *  in single player, where every owner resolves to the shared `mods`. */
  private readonly playerMods = new Map<PlayerId, Modifiers>();

  /** The rule set governing an owner's economy, units, and buildings. In co-op
   *  each player has their own so one player's hero never buffs the other; enemy
   *  and wild factions (and all of single player) use the shared base. */
  modsFor(owner: OwnerId): Modifiers {
    const own = this.playerMods.get(owner as PlayerId);
    return own ?? this.mods;
  }

  /** Install a player's co-op rule set. Its ctx is shared with the base so
   *  road-derived bonuses stay consistent across the two rule sets. */
  setPlayerMods(owner: PlayerId, specs: ModifierSpec[]): void {
    this.playerMods.set(owner, new Modifiers(specs, this.mods.ctx));
  }

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
      setCarrying: (unit, item) => this.unitMovement.setCarrying(unit, item),
      despawnCarrier: unit => {
        const index = this.units.indexOf(unit);
        if (index >= 0) { this.view.remove(unit.mesh); this.units.splice(index, 1); }
        if (this.selected === unit) this.select(null);
      },
      sendTo: (unit, destination) => this.unitMovement.sendTo(unit, destination.x, destination.y),
      moveUnit: (unit, dt) => { this.unitMovement.moveGround(unit, dt); },
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
      fortifyStronghold: (building, innerTowers) => this.fortifyStronghold(building, innerTowers),
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
      hostile: (from, to) => this.hostileOwners(from, to),
      hurtUnit: (shooter, target, damage) => this.damageSystem.hurtUnit(shooter, target, damage),
      buildingCenter: building => this.buildingCenter(building),
      hurtBuilding: (building, damage, x, z) => {
        building.hp -= damage;
        this.onHurt(x, z, building.faction);
        if (building.hp <= 0) this.damageSystem.destroyBuilding(building);
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
      toast: (message, owner) => this.emitToast(message, undefined, owner),
      depositCoin: (building, amount) => {
        // markets are always player-owned; pay into that player's castle stock
        const store = this.playerStores.get(building.owner as PlayerId) ?? this.store;
        if (store.stock) store.stock.coin = (store.stock.coin || 0) + amount;
      },
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
      hostile: (a, b) => this.hostileOwners(a, b),
      onCastleLost: owner => { this.eliminated.add(owner); if (!this.pvp) this.defeat = true; },
      toast: (message, cls, owner) => this.emitToast(message, cls, owner),
      sfx: name => this.sfx(name),
    });
    this.trainingSystem = new TrainingSystem(owner => this.modsFor(owner), {
      buildings: () => this.buildings,
      units: () => this.units,
      storeFor: owner => this.storeFor(owner),
      storeTotal: (item, owner) => this.storeTotal(item, owner),
      takeStock: (item, amount, owner) => this.takeStock(item, amount, owner),
      spawnUnit: (role, color, tile, owner) => this.spawnUnit(role, color, tile, owner),
      spawnFighter: (kind, tile, owner) => this.spawnFighter(kind, tile, 'player', owner),
      pathTo: (unit, x, y) => findPath(this.world, unit.tx, unit.ty, x, y, unit.faction),
      orderAttackMove: (unit, x, y) => this.orderUnit(unit, 'attackMove', x, y),
      removeUnit: unit => {
        this.view.remove(unit.mesh);
        this.units.splice(this.units.indexOf(unit), 1);
        if (this.selected === unit) this.select(null);
      },
      onTrain: () => this.objective?.onTrain(),
      onGold: amount => this.onGold(amount),
      toast: (message, cls, owner) => this.emitToast(message, cls, owner),
      sfx: name => this.sfx(name),
    });
    this.logisticsSystem = new LogisticsSystem(owner => this.modsFor(owner), {
      buildings: () => this.buildings,
      sites: () => this.sites,
      units: () => this.units,
      nearestStore: building => this.nearestStore(building),
      storeFor: owner => this.storeFor(owner),
      setCarrying: (unit, item) => this.unitMovement.setCarrying(unit, item),
      sendTo: (unit, x, y) => this.unitMovement.sendTo(unit, x, y),
      moveUnit: (unit, dt) => this.unitMovement.moveGround(unit, dt),
    });
    this.workerSystem = new WorkerSystem(this.world, this.view, owner => this.modsFor(owner), {
      buildings: () => this.buildings,
      sites: () => this.sites,
      guildFor: owner => this.playerGuilds.get(owner) ?? null,
      storeFor: owner => this.storeFor(owner),
      primaryStore: () => this.store,
      sendTo: (unit, x, y) => this.unitMovement.sendTo(unit, x, y),
      moveUnit: (unit, dt) => this.unitMovement.moveGround(unit, dt),
      completeSite: site => this.completeSite(site),
      wander: (unit, dt, moving, resting) => this.unitMovement.wander(unit, dt, moving, resting),
      removeTree: (x, y) => this.removeTree(x, y),
      removeDeposit: (x, y) => this.removeDep(x, y),
      removeDecoration: (x, y) => this.removeDeco(x, y),
      setCarrying: (unit, item) => this.unitMovement.setCarrying(unit, item),
      onProduce: (item, amount) => this.objective?.onProduce(item, amount),
      toast: (message, owner) => this.emitToast(message, undefined, owner),
      sfx: name => this.sfx(name),
    });
    this.unitMovement = new UnitMovement(this.world, owner => this.modsFor(owner));
    this.combatTargeting = new CombatTargeting(this.world, {
      buildings: () => this.buildings,
      visitUnitsNear: (x, y, radius, visit) => this.forUnitsNear(x, y, radius, visit),
      hostile: (left, right) => this.hostileOwners(left, right),
      buildingCenter: building => this.buildingCenter(building),
    });
    this.combatSystem = new CombatSystem(this.world, this.combatTargeting, this.unitMovement, {
      visitUnitsNear: (x, y, radius, visit) => this.forUnitsNear(x, y, radius, visit),
      advanceOrder: unit => this.orderSystem.advanceOrder(unit),
      buildingCenter: building => this.buildingCenter(building),
      attackUnit: (attacker, target) => this.damageSystem.attackUnit(attacker, target),
      attackBuilding: (attacker, target) => this.damageSystem.attackBuilding(attacker, target),
      fireArrow: (shooter, from, x, y, z, target, damage) => this.projectileSystem.fireArrow(shooter, from, x, y, z, target, damage),
      fireRock: (shooter, from, x, y, z, endX, endZ, damage, radius) => this.projectileSystem.fireRock(shooter, from, x, y, z, endX, endZ, damage, radius),
      fireFlame: (shooter, from, x, y, z, endX, endZ, damage) => this.projectileSystem.fireFlame(shooter, from, x, y, z, endX, endZ, damage),
      sfx: name => this.sfx(name),
    });
    this.placementSystem = new PlacementSystem(
      this.world, this.view, owner => this.modsFor(owner), this.buildings, this.sites, this.units, this.marketSystem, this.localPlayerId,
      {
        nextId: () => this.nextEntityId++,
        countItem: (item, owner) => this.countItem(item, owner),
        takeStock: (item, amount, owner) => this.takeStock(item, amount, owner),
        storeFor: owner => this.storeFor(owner),
        playerStore: owner => this.playerStores.get(owner) ?? null,
        playerColor: owner => (owner === 'p1' || owner === 'p2') ? this.playerColors.get(owner) : undefined,
        cancelTask: unit => this.logisticsSystem.cancelTask(unit),
        checkSiteReady: site => this.logisticsSystem.checkSiteReady(site),
        select: value => this.select(value),
        selected: () => this.selected,
        toast: (message, cls, owner) => this.emitToast(message, cls, owner),
        sfx: name => this.sfx(name),
      },
    );
    this.orderSystem = new OrderSystem(this.world, this.view, {
      siegeTile: (unit, building) => this.combatTargeting.siegeTile(unit, building),
      toast: (message, owner) => this.emitToast(message, undefined, owner),
      sfx: name => this.sfx(name),
    });
    this.refugeSystem = new RefugeSystem(this.world, this.unitMovement, {
      units: () => this.units,
      storeFor: owner => this.storeFor(owner),
      isFighter: unit => this.isFighter(unit),
      cancelTask: unit => this.logisticsSystem.cancelTask(unit),
      toast: (message, cls, owner) => this.emitToast(message, cls, owner),
      sfx: name => this.sfx(name),
    });
    this.economyState = new EconomyState(this.buildings, this.sites, this.units, owner => this.modsFor(owner), owner => this.storeFor(owner), this.localPlayerId);
    this.unitFactory = new UnitFactory(this.world, this.view, owner => this.modsFor(owner), this.units, this.localPlayerId, {
      nextId: () => this.nextEntityId++,
      storeFor: owner => this.storeFor(owner),
      primaryStore: () => this.store,
      registerHero: (heroId, roleName, owner, unit) => {
        this.playerHeroes.set(owner, unit);
        this.heroIdentity.set(owner, { id: heroId, name: roleName });
      },
      playerColor: owner => (owner === 'p1' || owner === 'p2') ? this.playerColors.get(owner) : undefined,
    });
    this.interactionSystem = new InteractionSystem(
      this.world, this.view, owner => this.modsFor(owner), this.buildings, this.sites, this.units, this.localPlayerId,
      {
        visitUnitsNear: (x, y, radius, visit) => this.forUnitsNear(x, y, radius, visit),
        select: value => this.select(value),
        onCollect: () => this.objective?.onCollect(),
        onGold: amount => this.onGold(amount),
        toast: message => this.toast(message),
        sfx: name => this.sfx(name),
      },
    );
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
    this.interactionSystem.indexPickups();
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
    const ownerMods = this.modsFor(owner);
    const bonus = ownerMods.startStock();
    for (const k in bonus) store.stock[k] = (store.stock[k] || 0) + (bonus as Record<string, number>)[k];
    const d = doorTile(store);
    const serfs = kit.serfs + ownerMods.extraSerfs();
    const laborers = kit.laborers + ownerMods.extraLaborers();
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
    return this.placementSystem.placeBuilding(key, tx, ty, instant, rot, faction, owner);
  }

  placePlot(tx: number, ty: number, b: Building, owner: PlayerId = this.localPlayerId): void {
    this.placementSystem.placePlot(tx, ty, b, owner);
  }

  removeTree(x: number, y: number): void { this.placementSystem.removeTree(x, y); }
  removeDep(x: number, y: number): void { this.placementSystem.removeDeposit(x, y); }
  removeDeco(x: number, y: number): void { this.placementSystem.removeDecoration(x, y); }

  placeSite(key: BuildingKey, tx: number, ty: number, rot = 0, owner: PlayerId = this.localPlayerId): Site {
    return this.placementSystem.placeSite(key, tx, ty, rot, owner);
  }

  private completeSite(s: Site): void {
    this.placementSystem.completeSite(s);
  }
  // =====================================================================
  //  Units
  // =====================================================================
  spawnUnit(role: string, colorHex: number, tile: { x: number; y: number }, owner: PlayerId = this.localPlayerId): Unit {
    return this.unitFactory.spawnUnit(role, colorHex, tile, owner);
  }

  spawnHero(heroId: string, roleName: string, owner: PlayerId = this.localPlayerId): Unit {
    return this.unitFactory.spawnHero(heroId, roleName, owner);
  }

  spawnFighter(kind: UnitKind, tile: { x: number; y: number }, faction?: Faction, owner?: OwnerId): Unit {
    return this.unitFactory.spawnFighter(kind, tile, faction, owner);
  }

  private sendTo(unit: Unit, x: number, y: number): boolean {
    return this.unitMovement.sendTo(unit, x, y);
  }

  private workerUpdate(unit: Unit, dt: number): void {
    this.workerSystem.updateWorker(unit, dt);
  }

  // =====================================================================
  //  Queries & placement
  // =====================================================================
  stockTotal(): number { return this.economyState.stockTotal(); }
  wellFedWorkers(): number { return this.economyState.wellFedWorkers(); }

  countItem(item: string, owner: PlayerId = this.localPlayerId): number {
    return this.economyState.countItem(item, owner);
  }

  workerMetrics(): WorkerMetrics {
    return this.economyState.workerMetrics();
  }

  stores(owner?: PlayerId): Building[] {
    return this.economyState.stores(owner);
  }

  private nearestStore(from: { x: number; y: number }): Building {
    return this.economyState.nearestStore(from);
  }

  private takeStock(item: string, amount: number, owner?: PlayerId): boolean {
    return this.economyState.takeStock(item, amount, owner);
  }

  private storeTotal(item: string, owner?: PlayerId): number {
    return this.economyState.storeTotal(item, owner);
  }

  itemBreakdown(item: string, owner: PlayerId = this.localPlayerId): { store: number; buildings: number; carried: number } {
    return this.economyState.itemBreakdown(item, owner);
  }

  canPaintRoadAt(tx: number, ty: number): boolean {
    return this.placementSystem.canPaintRoadAt(tx, ty);
  }

  canPlotAt(tx: number, ty: number): boolean {
    return this.placementSystem.canPlotAt(tx, ty);
  }

  demolishableAt(tx: number, ty: number, dragOnly: boolean, owner: PlayerId = this.localPlayerId): boolean {
    return this.placementSystem.demolishableAt(tx, ty, dragOnly, owner);
  }

  canPlace(key: BuildingKey, tx: number, ty: number, rot: number): boolean {
    return this.placementSystem.canPlace(key, tx, ty, rot);
  }

  disabledBuildings(): BuildingKey[] {
    return this.placementSystem.disabledBuildings();
  }

  tryPlace(key: BuildingKey, tx: number, ty: number, rot: number, owner: PlayerId = this.localPlayerId): void {
    if (this.lockedBuildings.has(key)) {
      this.sfx('error');
      this.toast(`${DEFS[key].name} unlocks on a later level`, 'err');
      return;
    }
    this.placementSystem.tryPlace(key, tx, ty, rot, owner);
  }

  paintRoad(tx: number, ty: number, owner: PlayerId = this.localPlayerId): void {
    this.placementSystem.paintRoad(tx, ty, owner);
  }

  demolishAt(tx: number, ty: number, dragOnly: boolean, owner: PlayerId = this.localPlayerId): void {
    this.placementSystem.demolishAt(tx, ty, dragOnly, owner);
  }

  private removeBuilding(building: Building): void {
    this.placementSystem.removeBuilding(building);
  }

  select(obj: any): void { this.selected = obj; this.onSelect(obj); }

  pickUnit(worldX: number, worldZ: number, radius = 0.6): Unit | null {
    return this.interactionSystem.pickUnit(worldX, worldZ, radius);
  }

  entranceTiles(): Coord[] {
    return this.interactionSystem.entranceTiles();
  }

  selectAt(tx: number, ty: number): void {
    this.interactionSystem.selectAt(tx, ty);
  }

  collectGoldAt(tx: number, ty: number, owner: PlayerId = this.localPlayerId, collector?: Unit): void {
    this.interactionSystem.collectGoldAt(tx, ty, owner, collector);
  }

  // =====================================================================
  //  Combat
  // =====================================================================
  /** True for units that run the combat behavior (soldiers, bandits, boars, dragon…). */
  private isFighter(u: Unit): boolean { return (UNITS as any)[u.role] !== undefined; }

  private forUnitsNear(tx: number, ty: number, radius: number, visit: (unit: Unit) => void): void {
    this.unitSpatialIndex.visitNear(tx, ty, radius, visit);
  }

  private buildingCenter(b: Building): { x: number; z: number } {
    return { x: this.world.wx(b.x) + 0.5, z: this.world.wz(b.y) + 0.5 };
  }

  private fireArrow(shooter: Unit | null, from: OwnerId, x: number, y: number, z: number, target: Unit, damage: number): void {
    this.projectileSystem.fireArrow(shooter, from, x, y, z, target, damage);
  }

  private fireRock(shooter: Unit | null, from: OwnerId, x: number, y: number, z: number, endX: number, endZ: number, damage: number, radius: number): void {
    this.projectileSystem.fireRock(shooter, from, x, y, z, endX, endZ, damage, radius);
  }

  private separate(dt: number): void {
    this.separationSystem.update(dt);
  }

  get bell(): boolean { return this.refugeSystem.active(this.localPlayerId); }

  setBell(owner: PlayerId, active: boolean): void {
    this.refugeSystem.set(owner, active);
  }

  toggleBell(owner: PlayerId = this.localPlayerId): void {
    this.refugeSystem.toggle(owner);
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

  togglePriority(target: Site | Building): void {
    this.orderSystem.togglePriority(target);
  }

  orderUnit(unit: Unit, type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null, queue = false, field: FlowField | null = null): void {
    this.orderSystem.orderUnit(unit, type, x, y, foe, queue, field);
  }

  formationPreview(units: Unit[], x: number, y: number, formation: Formation, facing: Coord): Coord[] {
    return this.orderSystem.formationPreview(units, x, y, formation, facing);
  }

  orderGroup(units: Unit[], type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null, formation: Formation = 'box', facing?: Coord, queue = false): void {
    this.orderSystem.orderGroup(units, type, x, y, foe, formation, facing, queue);
  }

  buildingAt(tx: number, ty: number): Building | null {
    return this.orderSystem.buildingAt(tx, ty);
  }

  orderGroupAttackBuilding(units: Unit[], building: Building, queue = false): void {
    this.orderSystem.orderGroupAttackBuilding(units, building, queue);
  }

  setRally(target: Building | Site, x: number, y: number): void {
    this.orderSystem.setRally(target, x, y);
  }

  spawnStartArmy(groups: { kind: UnitKind; count: number }[]): Unit[] {
    return this.unitFactory.spawnStartArmy(groups);
  }

  spawnSquad(kind: UnitKind, count: number, worldX: number, worldZ: number, faction?: Faction, owner?: OwnerId): Unit[] {
    return this.unitFactory.spawnSquad(kind, count, worldX, worldZ, faction, owner);
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
        if (u.dead || !this.hostileOwners(b.owner, u.owner) || u.dmg <= 0) return;
        const dx = u.mesh.position.x - c.x, dz = u.mesh.position.z - c.z, d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = u; }
      });
      if (!best) continue; // stay drawn until something wanders into range
      b.prog = 0;
      this.fireArrow(null, b.owner, c.x, 2.1, c.z, best, tw.dmg);
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
  private fortifyStronghold(b: Building, innerTowers?: number): void {
    this.enemySpawner.fortifyStronghold(b, innerTowers);
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
      // the hero always returns: a fresh horse is saddled at the castle. Co-op
      // tracks each player's hero separately so both peers resolve the same
      // death/respawn regardless of which hero is local.
      if ((u.owner === 'p1' || u.owner === 'p2') && this.playerHeroes.get(u.owner) === u) {
        this.playerHeroes.delete(u.owner);
        this.heroRespawn.set(u.owner, 45);
        const name = this.heroIdentity.get(u.owner)?.name ?? 'The hero';
        this.emitToast(`${name} has fallen — they will ride again in 45s`, 'err', u.owner);
      }
      // a slain specialist reopens their post: the building idles until
      // staffBuildings sends the next free villager to move in
      if (u.home && u.home.worker === u) {
        u.home.worker = null;
        u.home.active = false;
        u.home.working = false;
        this.emitToast(`The ${u.home.def.name}'s ${u.roleName.toLowerCase()} was slain — a new villager is needed`, 'err', u.owner);
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

  /** Set a market's export list (up to three surplus goods sold per visit). */
  configureMarket(b: Building, orders: { item: ItemKey; amount: number }[]): void {
    this.marketSystem.configure(b, orders);
  }

  /** Projected income at one scheduled trader visit per minute. */
  marketIncomePerMinute(b: Building): number {
    return this.marketSystem.incomePerMinute(b);
  }

  marketCaravansInTransit(b: Building): number {
    return this.marketSystem.caravansInTransit(b);
  }

  update(sdt: number): void {
    this.elapsed += sdt;
    this.combatSystem.beginTick();
    this.unitSpatialIndex.rebuild();
    this.marketSystem.update(sdt);
    this.dispatchT += sdt;
    if (this.dispatchT > 0.45) { this.dispatchT = 0; this.logisticsSystem.dispatch(); }
    // the Taxman mutator collects on the minute
    const tax = this.mods.taxPerMin();
    if (tax > 0) {
      this.taxT += sdt;
      if (this.taxT >= 60) { this.taxT -= 60; this.onGold(-tax); this.toast(`The Taxman collects ${tax} gold`, 'err'); }
    }
    // a fallen hero rides back out once their timer runs down — resolved per
    // player in a fixed order so both co-op peers respawn identically
    for (const owner of PLAYER_IDS) {
      const remaining = this.heroRespawn.get(owner);
      if (remaining === undefined) continue;
      const next = remaining - sdt;
      if (next > 0) { this.heroRespawn.set(owner, next); continue; }
      this.heroRespawn.delete(owner);
      const identity = this.heroIdentity.get(owner);
      if (identity) {
        this.spawnHero(identity.id, identity.name, owner);
        this.emitToast(`${identity.name} rides again!`, undefined, owner);
        if (owner === this.localPlayerId) this.sfx('build');
      }
    }
    const hungerRate = this.mods.hungerRate();
    for (const u of this.units) {
      if (u.dead) continue;
      u.hunger = Math.max(0, u.hunger - sdt * 100 / 600 * hungerRate);
      if (this.isFighter(u)) this.combatSystem.update(u, sdt);
      else if (u.role === 'carrier') continue; // trade carts are driven by updateTrade
      else if ((u.owner === 'p1' || u.owner === 'p2') && this.refugeSystem.active(u.owner) && u.faction === 'player') this.refugeSystem.updateUnit(u, sdt);
      else if (u.role === 'serf') this.logisticsSystem.updateSerf(u, sdt);
      else if (u.role === 'laborer') this.workerSystem.updateLaborer(u, sdt);
      else if (u.role === 'villager' && !u.home) this.workerSystem.updateVillager(u, sdt);
      else this.workerSystem.updateWorker(u, sdt);
    }
    this.trade.update(sdt);
    this.separationSystem.update(sdt);
    this.projectileSystem.update(sdt);
    this.sweepDead();
    this.workerSystem.updateGrowth(sdt);
    this.trainingSystem.serveTaverns(sdt);
    this.trainingSystem.updateQueues(sdt);
    this.trainingSystem.staffBuildings();
    this.encounters.update(sdt);
    this.interactionSystem.update(sdt);
    this.towerFire(sdt); // towers watch on every level, with or without a director
    this.fieldT += sdt;
    if (this.fieldT > 0.5) { this.fieldT = 0; this.workerSystem.recolorFields(); }
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

}
