import { PLOT_RANGE } from '../constants';
import { DEFS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { DIRS } from '../engine/pathfinding';
import { simRng } from '../engine/rng';
import { buildingFootprintCenter, buildingFootprintTiles } from '../engine/buildingFootprint';
import type { View } from '../render/View';
import type { Building, BuildingKey, Coord, Faction, OwnerId, PlayerId, Site, Unit } from '../types';
import type { World } from '../world/World';
import type { MarketSystem } from './MarketSystem';
import type { Modifiers } from './Modifiers';
import { buildingEntranceTiles } from './util';

// Doorway-seal check: only doorways within SEAL_SCAN tiles of the new footprint
// are flooded; a door counts as escaped once the flood reaches ESCAPE tiles from
// the footprint centre (the wider map) or CAP tiles are visited. ESCAPE sits
// outside SEAL_SCAN so a door at the scan edge still has room to prove an escape.
const SEAL_SCAN = 5, ESCAPE = 9, CAP = 400;

interface PlacementPorts {
  nextId: () => number;
  countItem: (item: string, owner: PlayerId) => number;
  takeStock: (item: string, amount: number, owner: PlayerId) => boolean;
  storeFor: (owner: PlayerId) => Building;
  playerStore: (owner: PlayerId) => Building | null;
  /** Co-op only: the preset colour a player's buildings are painted with (undefined in single player). */
  playerColor: (owner: OwnerId) => number | undefined;
  cancelTask: (unit: Unit) => void;
  checkSiteReady: (site: Site) => void;
  select: (value: unknown) => void;
  selected: () => unknown;
  toast: (message: string, cls?: string, owner?: OwnerId) => void;
  sfx: (name: string) => void;
  spawnVillager: (tile: Coord, owner: PlayerId) => void;
}

/** Owns building/site representation and all player placement mutations. */
export class PlacementSystem {
  private roadWarnT = 0;
  private plotWarnT = 0;

  /** Fraction of a demolished building's cost returned to the castle.
   *  Set per level from the run's ascension tier (1 = full, 0 = nothing). */
  demolishRefundRate = 1;

  /** Easier runs hand a demolished building's posted worker back as a fresh
   *  villager; harder ascensions lose them. Set per level like the rate above. */
  returnWorkerOnDemolish = true;

  constructor(
    private readonly world: World,
    private readonly view: View,
    private readonly modsFor: (owner: OwnerId) => Modifiers,
    private readonly buildings: Building[],
    private readonly sites: Site[],
    private readonly units: Unit[],
    private readonly markets: MarketSystem,
    private readonly localPlayerId: PlayerId,
    private readonly ports: PlacementPorts,
  ) {}

  placeBuilding(key: BuildingKey, tx: number, ty: number, instant: boolean, rot: number, faction: Faction, owner: OwnerId): Building {
    const def = DEFS[key];
    const mesh = this.view.createBuildingMesh(key, def, faction === 'player' ? this.ports.playerColor(owner) : undefined);
    mesh.rotation.y = -rot * Math.PI / 2;
    const center = buildingFootprintCenter({ x: tx, y: ty, rot, def });
    mesh.position.set(this.world.wx(center.x), 0, this.world.wz(center.y));
    this.view.add(mesh);
    const factionMultiplier = faction === 'player' ? (def.store ? this.modsFor(owner).castleHpMult() : 1) : (this.modsFor(owner).buildingHpMult(faction) || 1);
    const maxHp = Math.round((def.hp ?? 100) * factionMultiplier);
    const building: Building = {
      id: this.ports.nextId(), owner, key, def, x: tx, y: ty, rot, active: false,
      inp: {}, out: {}, incoming: {}, prog: 0, working: false, worker: null,
      fieldsList: [], mesh, name: def.name, faction, hp: maxHp, maxHp,
    };
    if (def.store) building.stock = {};
    if (key === 'market') { building.marketOrders = []; building.marketTimer = 60; }
    for (const { x, y } of buildingFootprintTiles(building)) {
      const tile = this.world.tiles[y][x];
      tile.b = building;
      if (tile.tree) this.removeTree(x, y);
      if (tile.deco) this.removeDecoration(x, y);
    }
    this.buildings.push(building);
    if (instant) building.active = true;
    // The "wants plots" crystal is a prompt to its owner, so only the player who
    // placed the building sees it — in co-op the ally's fields carry no marker.
    if (def.fields && owner === this.localPlayerId) {
      const marker = this.view.createPlotMarker();
      marker.userData.dynamic = true;
      marker.position.y = 2.4;
      marker.visible = false;
      mesh.add(marker);
      mesh.userData.plotMarker = marker;
    }
    return building;
  }

  placePlot(tx: number, ty: number, building: Building, owner: PlayerId): void {
    if (building.removed || building.owner !== owner || !building.def.fields) return;
    const tile = this.world.T(tx, ty);
    if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.road || tile.field || tile.dep || tile.tree?.dense) return;
    // A plot on a doorway would sit on the tile the building's serfs and
    // worker walk through — keep every entrance clear of crops.
    if (this.entranceTileKeys().has(`${tx},${ty}`)) return;
    if (building.fieldsList.length >= (building.def.plots ?? 8)) {
      const now = Date.now();
      if (now - this.plotWarnT > 1500) {
        this.plotWarnT = now; this.ports.toast(`${building.name} has no room for more plots`, 'err', owner); this.ports.sfx('error');
      }
      return;
    }
    if (Math.hypot(tx - (building.x + 0.5), ty - (building.y + 0.5)) > PLOT_RANGE) {
      const now = Date.now();
      if (now - this.plotWarnT > 1500) {
        this.plotWarnT = now; this.ports.toast(`Too far — plots must sit within ${PLOT_RANGE} tiles of the ${building.name}`, 'err', owner); this.ports.sfx('error');
      }
      return;
    }
    if (tile.deco) this.removeDecoration(tx, ty);
    tile.field = { farm: building, growth: simRng.next() * 0.4, meshes: [] };
    building.fieldsList.push({ x: tx, y: ty });
    this.view.refreshTile(tx, ty);
    this.view.addFieldCrop(tx, ty, tile.field);
  }

  removeTree(x: number, y: number): void {
    const tile = this.world.tiles[y][x];
    if (tile.tree) { this.view.removeMeshes(tile.tree.meshes); tile.tree = null; this.view.dirtyTile(x, y); }
  }

  removeDeposit(x: number, y: number): void {
    const tile = this.world.tiles[y][x];
    if (tile.dep) { this.view.removeMeshes(tile.dep.meshes); tile.dep = null; this.view.dirtyTile(x, y); }
  }

  removeDecoration(x: number, y: number): void {
    const tile = this.world.tiles[y][x];
    if (tile.deco) { this.view.removeMeshes(tile.deco.meshes); tile.deco = null; this.view.dirtyTile(x, y); }
  }

  placeSite(key: BuildingKey, tx: number, ty: number, rot: number, owner: PlayerId): Site {
    const def = DEFS[key];
    const { group, frame } = this.view.createScaffold(key, def, this.ports.playerColor(owner));
    group.rotation.y = -rot * Math.PI / 2;
    const center = buildingFootprintCenter({ x: tx, y: ty, rot, def });
    group.position.set(this.world.wx(center.x), 0, this.world.wz(center.y));
    this.view.add(group);
    const site: Site = {
      id: this.ports.nextId(), owner, key, def, x: tx, y: ty, rot,
      needs: this.modsFor(owner).buildingCost(def) as Record<string, number>, delivered: {}, incoming: {},
      progress: 0, ready: false, builder: null, mesh: group, frame, isSite: true, name: `${def.name} (site)`,
    };
    for (const item in site.needs) { site.delivered[item] = 0; site.incoming[item] = 0; }
    for (const { x, y } of buildingFootprintTiles(site)) {
      const tile = this.world.tiles[y][x];
      tile.site = site;
      if (tile.tree) this.removeTree(x, y);
      if (tile.deco) this.removeDecoration(x, y);
    }
    this.sites.push(site);
    this.ports.checkSiteReady(site);
    return site;
  }

  completeSite(site: Site): void {
    for (const { x, y } of buildingFootprintTiles(site)) this.world.tiles[y][x].site = null;
    this.view.remove(site.mesh);
    this.sites.splice(this.sites.indexOf(site), 1);
    const building = this.placeBuilding(site.key, site.x, site.y, false, site.rot, 'player', site.owner);
    building.rally = site.rally;
    building.rallyMesh = site.rallyMesh;
    this.ports.toast(`${site.def.name} completed`, undefined, site.owner);
    this.ports.sfx('build');
    if (!site.def.worker) building.active = true;
    if (this.ports.selected() === site) this.ports.select(building);
  }

  canPaintRoadAt(tx: number, ty: number): boolean { return this.openGround(tx, ty); }
  canPlotAt(tx: number, ty: number): boolean {
    return this.openGround(tx, ty) && !this.entranceTileKeys().has(`${tx},${ty}`);
  }

  /** The full per-farm plot test the paint cursor turns red on: open ground
   *  and entrance rules plus this farm's plot cap and reach. */
  canPlotFor(building: Building, tx: number, ty: number): boolean {
    return !building.removed
      && building.fieldsList.length < (building.def.plots ?? 8)
      && Math.hypot(tx - (building.x + 0.5), ty - (building.y + 0.5)) <= PLOT_RANGE
      && this.canPlotAt(tx, ty);
  }

  /** The building or site a demolish click at this tile would remove, if the
   *  local player may actually demolish it (own, not the castle, not enemy). */
  demolishTargetAt(tx: number, ty: number, owner: PlayerId): Building | Site | null {
    const tile = this.world.T(tx, ty);
    if (!tile) return null;
    const b = tile.b;
    if (b && b.faction === 'player' && b.owner === owner && this.ports.playerStore(owner) !== b) return b;
    if (tile.site && tile.site.owner === owner) return tile.site;
    return null;
  }

  /** Goods returned when `target` is demolished: a building refunds its cost
   *  and a site the materials already delivered, both scaled by the level's
   *  refund rate and rounded down. Empty means nothing comes back. */
  demolishRefund(target: Building | Site): Record<string, number> {
    const source = (target as Site).isSite
      ? (target as Site).delivered
      : this.modsFor(target.owner).buildingCost(target.def) as Record<string, number>;
    const refund: Record<string, number> = {};
    for (const item in source) {
      const amount = Math.floor((source[item] || 0) * this.demolishRefundRate);
      if (amount > 0) refund[item] = amount;
    }
    return refund;
  }

  /** Credit a demolish refund to the owner's castle stock. */
  private payRefund(target: Building | Site): string {
    const refund = this.demolishRefund(target);
    const store = this.ports.playerStore(target.owner as PlayerId);
    if (!store?.stock) return '';
    let note = '';
    for (const item in refund) {
      store.stock[item] = (store.stock[item] || 0) + refund[item];
      note += `${note ? ', ' : ''}${refund[item]} ${ITEMS[item as keyof typeof ITEMS]?.name.toLowerCase() ?? item}`;
    }
    return note;
  }

  demolishableAt(tx: number, ty: number, dragOnly: boolean, owner: PlayerId): boolean {
    const tile = this.world.T(tx, ty);
    if (!tile) return false;
    if (tile.road) return tile.roadOwner === owner;
    if (tile.field) return tile.field.farm.owner === owner;
    if (dragOnly) return false;
    return !!tile.b || !!tile.site;
  }

  canPlace(key: BuildingKey, tx: number, ty: number, rot: number): boolean {
    // A neighbour's doorway must stay walkable, so the new footprint may not
    // cover an existing building's or site's entrance tile — otherwise the
    // neighbour is sealed in and its serfs can never reach it.
    const blockedEntrances = this.entranceTileKeys();
    const pending = { x: tx, y: ty, rot, def: DEFS[key] };
    const footprint = new Set<string>();
    for (const { x, y } of buildingFootprintTiles(pending)) {
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep || tile.road || tile.field || tile.tree?.dense) return false;
      if (blockedEntrances.has(`${x},${y}`)) return false;
      footprint.add(`${x},${y}`);
    }
    // The new building's own entrance tiles must be walkable (passable() rejects
    // occupied tiles, so an entrance can never land on another building), and
    // they may not coincide with a neighbour's doorway — two green squares
    // sharing a tile would leave both buildings fighting over one approach.
    for (const tile of buildingEntranceTiles({ x: tx, y: ty, rot, def: DEFS[key] })) {
      if (!this.world.passable(tile.x, tile.y)) return false;
      if (blockedEntrances.has(`${tile.x},${tile.y}`)) return false;
    }
    // Covering a doorway is rejected above, but a building set down sideways can
    // still wall off the corridor a doorway opens onto without touching the door
    // tile itself. Reject placements that would seal any neighbouring doorway in.
    const center = buildingFootprintCenter(pending);
    return !this.sealsNeighbourDoorway(footprint, center.x, center.y);
  }

  /** True if the pending footprint would trap a nearby building/site doorway,
   *  leaving its owner's serfs unable to walk out to open ground. */
  private sealsNeighbourDoorway(footprint: Set<string>, cx: number, cy: number): boolean {
    // Only doorways close enough that the new footprint could plug their escape
    // corridor are worth flooding — anything further can't be walled in by a
    // single footprint. Chebyshev distance from its centre keeps this cheap.
    for (const b of [...this.buildings, ...this.sites]) {
      for (const door of buildingEntranceTiles(b)) {
        if (footprint.has(`${door.x},${door.y}`)) continue;
        if (Math.max(Math.abs(door.x - cx), Math.abs(door.y - cy)) > SEAL_SCAN) continue;
        if (!this.doorwayEscapes(door, footprint, b.owner, cx, cy)) return true;
      }
    }
    return false;
  }

  /** Flood out from a doorway across walkable tiles (treating the pending
   *  footprint as solid). Escaping the local pocket — reaching the edge of a
   *  box around the new footprint, or a large connected area — means the door
   *  still reaches the wider map. A flood that exhausts inside the pocket is
   *  sealed. */
  private doorwayEscapes(start: Coord, footprint: Set<string>, mover: OwnerId, cx: number, cy: number): boolean {
    const walkable = (x: number, y: number) => !footprint.has(`${x},${y}`) && this.world.passable(x, y, mover);
    if (!walkable(start.x, start.y)) return true; // door already blocked — handled by other checks
    const seen = new Set<string>([`${start.x},${start.y}`]);
    const queue: Coord[] = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.size > CAP) return true;
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (seen.has(`${nx},${ny}`) || !walkable(nx, ny)) continue;
        // Serfs cannot cut corners: a diagonal step needs both shoulders clear.
        if (dx !== 0 && dy !== 0 && (!walkable(cur.x + dx, cur.y) || !walkable(cur.x, cur.y + dy))) continue;
        if (Math.abs(nx - cx) > ESCAPE || Math.abs(ny - cy) > ESCAPE) return true;
        seen.add(`${nx},${ny}`);
        queue.push({ x: nx, y: ny });
      }
    }
    return false;
  }

  /** "x,y" keys of every tile that is a doorway of a standing building or site. */
  private entranceTileKeys(): Set<string> {
    const keys = new Set<string>();
    for (const building of this.buildings) for (const tile of buildingEntranceTiles(building)) keys.add(`${tile.x},${tile.y}`);
    for (const site of this.sites) for (const tile of buildingEntranceTiles(site)) keys.add(`${tile.x},${tile.y}`);
    return keys;
  }

  disabledBuildings(): BuildingKey[] {
    const banned = [...this.world.biome.disabledBuildings];
    if (!this.world.biome.gen.coast) for (const key in DEFS) if (DEFS[key as BuildingKey].coastal) banned.push(key as BuildingKey);
    return banned;
  }

  /** Exact non-geometric workability gate shared by placement execution and AI
   * validation. Resource caches may suggest a mine after its last node is
   * exhausted; this always reads live world state. */
  canWorkBuildingAt(key: BuildingKey, tx: number, ty: number): boolean {
    if (key === 'quarry') return this.depositInRange('stone', tx, ty, 9);
    if (key === 'goldmine') return this.depositInRange('gold', tx, ty, 9);
    if (key === 'coalmine') return this.depositInRange('coal', tx, ty, 9);
    if (key === 'ironmine') return this.depositInRange('iron', tx, ty, 9);
    const def = DEFS[key];
    if (def.gather?.node === 'fish') return this.fishingSpotInRange(tx, ty, def.gather.range);
    return true;
  }

  tryPlace(key: BuildingKey, tx: number, ty: number, rot: number, owner: PlayerId): boolean {
    if (this.disabledBuildings().includes(key)) {
      this.ports.sfx('error');
      this.ports.toast(`No ${DEFS[key].name.toLowerCase()} can be raised in ${this.world.biome.name}`, 'err', owner);
      return false;
    }
    if (!this.canPlace(key, tx, ty, rot)) {
      this.ports.sfx('error'); this.ports.toast("Cannot build here — don't cover or seal off another building's doorway", 'err', owner); return false;
    }
    const def = DEFS[key];
    // Mines and quarries must stand within reach of live deposits — their
    // miners gather from those tiles, so a site out of range could never work.
    if (!this.canWorkBuildingAt(key, tx, ty)) {
      const message = key === 'quarry' ? 'No stone deposits in range — build near the grey rocks'
        : key === 'goldmine' ? 'No gold deposits in range'
          : key === 'coalmine' ? 'No coal deposits in range'
            : key === 'ironmine' ? 'No iron deposits in range — build near the rusty rocks'
              : 'No open water in range — build on the shore';
      this.ports.toast(message, 'err', owner);
      return false;
    }
    if (key === 'woodcutter' && !this.nearTree(tx, ty, 9)) this.ports.toast('Warning: few trees nearby', 'err', owner);
    const cost = this.modsFor(owner).buildingCost(def) as Record<string, number>;
    for (const item in cost) {
      if (this.ports.countItem(item, owner) < cost[item]) {
        this.ports.toast(`Not enough ${ITEMS[item as keyof typeof ITEMS].name} in your economy — site will wait`, 'err', owner);
        break;
      }
    }
    this.placeSite(key, tx, ty, rot, owner);
    this.ports.sfx('place');
    this.ports.toast(`${def.name} site placed — serfs will deliver materials`, undefined, owner);
    return true;
  }

  paintRoad(tx: number, ty: number, owner: PlayerId): void {
    if (!this.openGround(tx, ty)) return;
    const tile = this.world.T(tx, ty)!;
    const cost = this.modsFor(owner).roadCost();
    if (cost > 0 && !this.ports.takeStock('stone', cost, owner)) {
      const now = Date.now();
      if (now - this.roadWarnT > 1500) {
        this.roadWarnT = now; this.ports.toast('Out of stone — quarry more to build roads', 'err', owner); this.ports.sfx('error');
      }
      return;
    }
    if (tile.tree) this.removeTree(tx, ty);
    if (tile.deco) this.removeDecoration(tx, ty);
    tile.road = true;
    tile.roadOwner = owner;
    this.modsFor(owner).ctx.roadTiles++;
    this.view.refreshTile(tx, ty);
    this.view.addRoad(tx, ty);
  }

  demolishAt(tx: number, ty: number, dragOnly: boolean, owner: PlayerId): void {
    const tile = this.world.T(tx, ty);
    if (!tile) return;
    if (tile.road) {
      if (tile.roadOwner !== owner) return;
      tile.road = false; tile.roadOwner = null; this.modsFor(owner).ctx.roadTiles = Math.max(0, this.modsFor(owner).ctx.roadTiles - 1);
      const store = this.ports.storeFor(owner);
      store.stock!.stone = (store.stock!.stone || 0) + this.modsFor(owner).roadCost();
      this.view.refreshTile(tx, ty); this.view.removeRoad(tx, ty); return;
    }
    if (tile.field) {
      if (tile.field.farm.owner !== owner) return;
      const fields = tile.field.farm.fieldsList;
      const index = fields.findIndex(field => field.x === tx && field.y === ty);
      if (index >= 0) fields.splice(index, 1);
      this.view.removeMeshes(tile.field.meshes); tile.field = null; this.view.refreshTile(tx, ty); return;
    }
    if (dragOnly) return;
    if (tile.b) {
      const building = tile.b;
      if (this.ports.playerStore(owner) === building) { this.ports.toast('The castle cannot be demolished', 'err', owner); return; }
      if (building.faction !== 'player') { this.ports.toast('Enemy strongholds must be destroyed in battle', 'err', owner); return; }
      if (building.owner !== owner) { this.ports.toast("You cannot demolish your ally's building", 'err', owner); return; }
      this.ports.sfx('demolish');
      const hadWorker = !!building.worker;
      const note = this.payRefund(building);
      this.removeBuilding(building);
      let workerNote = '';
      if (hadWorker && this.returnWorkerOnDemolish) {
        const door = buildingEntranceTiles(building)[0] ?? { x: building.x, y: building.y };
        this.ports.spawnVillager(door, owner);
        workerNote = ' · the worker rejoins your villagers';
      } else if (hadWorker) {
        workerNote = ' · the worker is lost';
      }
      this.ports.toast(`${building.def.name} demolished${note ? ` — recovered ${note}` : ''}${workerNote}`, undefined, owner);
      return;
    }
    if (tile.site && tile.site.owner === owner) {
      this.ports.sfx('demolish');
      this.payRefund(tile.site);
      this.removeSite(tile.site);
    }
  }

  removeSite(site: Site): void {
    site.removed = true;
    for (const unit of this.units) if (unit.task && (unit.task.to === site || unit.task.from === site)) this.ports.cancelTask(unit);
    if (site.builder) { site.builder.wstate = 'idle'; site.builder.target = null; site.builder.status = 'Idle'; }
    for (const { x, y } of buildingFootprintTiles(site)) this.world.tiles[y][x].site = null;
    if (site.rallyMesh) this.view.remove(site.rallyMesh);
    this.view.remove(site.mesh);
    this.sites.splice(this.sites.indexOf(site), 1);
    if (this.ports.selected() === site) this.ports.select(null);
    this.ports.toast(`${site.def.name} site removed`, undefined, site.owner);
  }

  removeBuilding(building: Building): void {
    building.removed = true;
    for (const unit of this.units) if (unit.task && (unit.task.to === building || unit.task.from === building)) this.ports.cancelTask(unit);
    const mender = building.repair?.builder;
    if (mender) { mender.wstate = 'idle'; mender.target = null; mender.status = 'Idle'; }
    building.repair = undefined;
    if (building.worker) {
      const worker = building.worker;
      this.view.remove(worker.mesh);
      this.units.splice(this.units.indexOf(worker), 1);
      if (this.ports.selected() === worker) this.ports.select(null);
    }
    for (const field of building.fieldsList) {
      const tile = this.world.tiles[field.y][field.x];
      if (tile.field) { this.view.removeMeshes(tile.field.meshes); tile.field = null; this.view.refreshTile(field.x, field.y); }
    }
    for (const { x, y } of buildingFootprintTiles(building)) this.world.tiles[y][x].b = null;
    if (building.rallyMesh) this.view.remove(building.rallyMesh);
    this.markets.removeBuilding(building);
    this.view.remove(building.mesh);
    this.buildings.splice(this.buildings.indexOf(building), 1);
    if (this.ports.selected() === building) this.ports.select(null);
  }

  private openGround(tx: number, ty: number): boolean {
    const tile = this.world.T(tx, ty);
    return !!tile && tile.type === 'grass' && !tile.b && !tile.site && !tile.road && !tile.field && !tile.dep && !tile.tree?.dense;
  }

  /** A live deposit of `kind` within the miner's working box that can actually
   *  be worked: the miner stands on an orthogonal side tile to dig, so a rock
   *  walled in on all four sides must not satisfy placement. */
  private depositInRange(kind: string, tx: number, ty: number, range: number): boolean {
    for (let y = Math.max(0, ty - range); y <= Math.min(this.world.H - 1, ty + 1 + range); y++)
      for (let x = Math.max(0, tx - range); x <= Math.min(this.world.W - 1, tx + 1 + range); x++) {
        const deposit = this.world.tiles[y][x].dep;
        if (!deposit || deposit.kind !== kind || deposit.amt <= 0) continue;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
          if (this.world.passable(x + ox, y + oy)) return true;
      }
    return false;
  }

  private nearTree(tx: number, ty: number, range: number): boolean {
    for (let y = Math.max(0, ty - range); y <= Math.min(this.world.H - 1, ty + 1 + range); y++)
      for (let x = Math.max(0, tx - range); x <= Math.min(this.world.W - 1, tx + 1 + range); x++)
        if (this.world.tiles[y][x].tree) return true;
    return false;
  }

  /** Can a fisher actually work from here? Mirror the worker's node search: a
   *  clear shore tile (grass, not the fishery's own 2×2 footprint) that touches
   *  open water. Merely having water in range is not enough — if the only water
   *  is deep beyond the shore, the fisher can never reach a fishing spot. */
  private fishingSpotInRange(tx: number, ty: number, range: number): boolean {
    for (let y = Math.max(0, ty - range); y <= Math.min(this.world.H - 1, ty + 1 + range); y++)
      for (let x = Math.max(0, tx - range); x <= Math.min(this.world.W - 1, tx + 1 + range); x++) {
        if (x >= tx && x <= tx + 1 && y >= ty && y <= ty + 1) continue; // the fishery's own footprint
        const tile = this.world.tiles[y][x];
        if (tile.type !== 'grass' || tile.b || tile.site || tile.tree || tile.dep || tile.road || tile.field) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.world.T(x + dx, y + dy)?.type === 'water')) return true;
      }
    return false;
  }
}
