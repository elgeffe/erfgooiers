import { UNITS, type UnitKind } from '../data/units';
import { PLAYER_IDS, type Building, type BuildingKey, type Coord, type Site, type Unit } from '../types';
import type { PlayerId } from '../types';
import type { Game } from '../game/Game';
import type { World } from '../world/World';

/**
 * Pure feature extraction from the simulation — the ONLY ai/ module that reads
 * `Game`/`World` state, which makes it the fairness boundary for information.
 * Under fog of war (`game.fogOfWar`) every hostile unit and bulwark is
 * filtered by the bot seat's own visibility (`game.visibleTo`), so a CPU seat
 * knows exactly what its assets can see — the same information a human at the
 * screen gets. Two deliberate exceptions, both facts a human also knows on the
 * fixed symmetric arena: the rival castle's location (spawns are known map
 * knowledge) and the map's resource nodes (terrain is not shrouded). Every
 * policy (classic, learned, experimental) shares this observation space.
 */

/** Hostiles this close (tiles, Chebyshev) to an own building count as threats. */
const THREAT_RADIUS = 13;

export interface ResourceMap {
  trees: Coord[];
  stone: Coord[];
  gold: Coord[];
  coal: Coord[];
  iron: Coord[];
}

/** Terrain resources change slowly compared with the tactics cadence. Scanning
 *  every tile twice a second dominated the Classic controller's CPU budget on
 *  huge arenas, so share a deterministic twenty-second snapshot per World.
 *  Placement still validates every selected node, making a recently exhausted
 *  cached deposit harmless. */
const resourceCache = new WeakMap<World, { at: number; map: ResourceMap }>();

export interface AIView {
  elapsed: number;
  owner: PlayerId;
  /** Rival player seats (mutually hostile diplomacy). */
  enemySeats: PlayerId[];
  eliminated: boolean;

  store: Building | null;
  buildings: Building[];
  sites: Site[];
  /** Standing own buildings by key. */
  built: Partial<Record<BuildingKey, number>>;
  /** Own construction sites by key. */
  pending: Partial<Record<BuildingKey, number>>;

  workers: { serfs: number; laborers: number; villagers: number; freeVillagers: number; unstaffed: number };
  averageWorkerHunger: number;

  /** Own live commandable fighters (heroes excluded — the CPU seats run none). */
  army: Unit[];
  armySize: number;

  /** The rival's castle. Kept through fog: on the fixed symmetric arena the
   *  spawn corners are map knowledge a human player has too. */
  enemyStore: Building | null;
  /** VISIBLE rival fighters — under fog, only what this seat's assets see. */
  enemyArmySize: number;
  /** The visible rival army's composition by kind — reads for counter-building
   *  (a better player scouts what to counter). Under fog, raids and towers are
   *  what feed this read. */
  enemyArmyByKind: Partial<Record<UnitKind, number>>;
  /** The rival's standing curtain (walls + gates) — what a siege must breach. */
  enemyBulwarks: Building[];

  /** Hostile fighters standing near own buildings, and their mass centre. */
  threats: Unit[];
  threatCentroid: Coord | null;

  resources: ResourceMap;
}

export function have(view: AIView, key: BuildingKey): number {
  return (view.built[key] ?? 0) + (view.pending[key] ?? 0);
}

/** Goods anywhere in the owner's economy (store + building slots + carried). */
export function economyStock(game: Game, owner: PlayerId, item: string): number {
  return game.countItem(item, owner);
}

/** Goods sitting in the owner's storehouses (what training can actually spend). */
export function storeStock(game: Game, owner: PlayerId, item: string): number {
  let total = 0;
  for (const store of game.stores(owner)) total += store.stock?.[item] ?? 0;
  return total;
}

export function perceive(game: Game, world: World, owner: PlayerId): AIView {
  const enemySeats = PLAYER_IDS.filter(seat => seat !== owner && game.hostileOwners(owner, seat));

  const buildings: Building[] = [];
  const built: Partial<Record<BuildingKey, number>> = {};
  const enemyBulwarks: Building[] = [];
  let store: Building | null = null;
  for (const building of game.buildings) {
    if (building.removed) continue;
    if (building.owner !== owner) {
      if (building.def.bulwark && enemySeats.includes(building.owner as PlayerId)
        && game.visibleTo(owner, building.x + 1, building.y + 1)) enemyBulwarks.push(building);
      continue;
    }
    buildings.push(building);
    built[building.key] = (built[building.key] ?? 0) + 1;
    if (building.def.store && !store) store = building;
  }
  store = game.playerStores.get(owner) ?? store;
  if (store?.removed) store = null;

  const sites: Site[] = [];
  const pending: Partial<Record<BuildingKey, number>> = {};
  for (const site of game.sites) {
    if (site.removed || site.owner !== owner) continue;
    sites.push(site);
    pending[site.key] = (pending[site.key] ?? 0) + 1;
  }

  let serfs = 0, laborers = 0, villagers = 0, freeVillagers = 0, unstaffed = 0;
  let workerHunger = 0, workerCount = 0;
  const army: Unit[] = [];
  let enemyArmySize = 0;
  const enemyArmyByKind: Partial<Record<UnitKind, number>> = {};
  const hostiles: Unit[] = [];
  for (const unit of game.units) {
    if (unit.dead) continue;
    if (unit.owner === owner) {
      if (unit.role === 'serf') serfs++;
      else if (unit.role === 'laborer') laborers++;
      else if (unit.role === 'villager') { villagers++; if (!unit.home) freeVillagers++; }
      if (unit.dmg === 0 && unit.faction === 'player') { workerHunger += unit.hunger; workerCount++; }
      if (unit.role in UNITS && unit.role !== 'hero') army.push(unit);
      continue;
    }
    if (!game.hostileOwners(owner, unit.owner) || unit.dmg <= 0) continue;
    if (!game.visibleTo(owner, unit.tx, unit.ty)) continue; // fogged — unseen
    hostiles.push(unit);
    if (enemySeats.includes(unit.owner as PlayerId) && unit.role in UNITS) {
      enemyArmySize++;
      const kind = unit.role as UnitKind;
      enemyArmyByKind[kind] = (enemyArmyByKind[kind] ?? 0) + 1;
    }
  }
  for (const building of buildings) if (building.def.worker && !building.worker) unstaffed++;

  // Threats: hostile fighters near any own building (Chebyshev on tile coords).
  const threats: Unit[] = [];
  let cx = 0, cy = 0;
  for (const hostile of hostiles) {
    for (const building of buildings) {
      const distance = Math.max(Math.abs(hostile.tx - (building.x + 1)), Math.abs(hostile.ty - (building.y + 1)));
      if (distance <= THREAT_RADIUS) { threats.push(hostile); cx += hostile.tx; cy += hostile.ty; break; }
    }
  }
  const threatCentroid = threats.length
    ? { x: Math.round(cx / threats.length), y: Math.round(cy / threats.length) }
    : null;

  const enemySeat = enemySeats[0];
  const enemyStoreRaw = enemySeat ? game.playerStores.get(enemySeat) ?? null : null;
  const enemyStore = enemyStoreRaw && !enemyStoreRaw.removed ? enemyStoreRaw : null;

  return {
    elapsed: game.elapsed, owner, enemySeats,
    eliminated: game.eliminated.has(owner),
    store, buildings, sites, built, pending,
    workers: { serfs, laborers, villagers, freeVillagers, unstaffed },
    averageWorkerHunger: workerCount ? workerHunger / workerCount : 100,
    army, armySize: army.length,
    enemyStore, enemyArmySize, enemyArmyByKind, enemyBulwarks,
    threats, threatCentroid,
    resources: cachedResources(world, game.elapsed),
  };
}

function cachedResources(world: World, elapsed: number): ResourceMap {
  const cached = resourceCache.get(world);
  if (cached && elapsed - cached.at < 20) return cached.map;
  const map = scanResources(world);
  resourceCache.set(world, { at: elapsed, map });
  return map;
}

/** Live map resource nodes. Terrain is not shrouded under fog — deposits are
 *  map knowledge for the human too, so the read stays symmetric. */
function scanResources(world: World): ResourceMap {
  const resources: ResourceMap = { trees: [], stone: [], gold: [], coal: [], iron: [] };
  for (let y = 0; y < world.H; y++) for (let x = 0; x < world.W; x++) {
    const tile = world.tiles[y][x];
    if (tile.tree && !tile.tree.dense) resources.trees.push({ x, y });
    const deposit = tile.dep;
    if (deposit && deposit.amt > 0) resources[deposit.kind].push({ x, y });
  }
  return resources;
}
