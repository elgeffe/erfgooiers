import { UNITS, type UnitKind } from '../data/units';
import { simRng } from '../engine/rng';
import { planFortificationRing, ringTowerSpots, sideToward } from './fortification';
import { PLAYER_IDS, type Building, type BuildingKey, type Faction, type PlayerId, type Unit } from '../types';
import type { World } from '../world/World';

const random = () => simRng.next();
type EnemyZone = World['enemyZones'][number];

export interface EnemySpawnPort {
  buildings(): readonly Building[];
  units(): readonly Unit[];
  playerStore(owner: PlayerId): Building | null;
  primaryStore(): Building | null;
  spawnFighter(kind: UnitKind, tile: { x: number; y: number }, faction: Faction): Unit;
  spawnSquad(kind: UnitKind, count: number, worldX: number, worldZ: number, faction: Faction): Unit[];
  placeBuilding(key: BuildingKey, x: number, y: number, rotation: number): Building;
  orderAttackMove(unit: Unit, x: number, y: number): void;
  toast(message: string, cls?: string): void;
}

/** RNG-sensitive enemy placement and spawning. EncounterDirector owns when
 * encounters happen; this class owns where their entities enter the world. */
export class EnemySpawner {
  garrisonMult = 1;
  bossHpMult = 1;

  private camps: Building[] = [];
  private zoneIdx = 0;
  private reachMask: Uint8Array | null = null;

  constructor(private readonly world: World, private readonly port: EnemySpawnPort) {}

  resetPlacement(): void {
    this.camps = [];
  }

  spawnRaid(kind: UnitKind, count: number, from: 'edge' | 'camp'): Unit[] {
    let originX: number, originZ: number;
    if (from === 'camp' && this.camps.length) {
      const camp = this.camps[Math.floor(random() * this.camps.length)];
      originX = this.world.wx(camp.x);
      originZ = this.world.wz(camp.y);
    } else {
      const edge = this.randomEdge();
      originX = edge.x;
      originZ = edge.z;
    }
    const squad = this.port.spawnSquad(kind, count, originX, originZ, 'enemy');
    const castle = this.raidTarget();
    for (const unit of squad) {
      unit.raider = true;
      if (castle) this.port.orderAttackMove(unit, castle.x + 1, castle.y + 1);
    }
    return squad;
  }

  spawnWild(kind: UnitKind, count: number): void {
    const width = this.world.W, height = this.world.H;
    const keep = Math.max(15, Math.floor(Math.min(width, height) * 0.32));
    const homes = PLAYER_IDS
      .map(owner => this.port.playerStore(owner))
      .filter((building): building is Building => !!building && !building.removed)
      .map(building => ({ x: building.x + 1, y: building.y + 1 }));
    if (!homes.length) homes.push({ x: this.world.playerStart.x + 1, y: this.world.playerStart.y + 1 });
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 40) {
      tries++;
      const x = 2 + Math.floor(random() * (width - 4)), y = 2 + Math.floor(random() * (height - 4));
      if (homes.some(home => Math.hypot(x - home.x, y - home.y) < keep)) continue;
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep) continue;
      this.port.spawnFighter(kind, { x, y }, 'wild');
      placed++;
    }
  }

  spawnStronghold(key: BuildingKey, guards: number, kinds: UnitKind[] = ['bandit'], zone?: EnemyZone): Building | null {
    const spot = this.findStrongholdSpot(zone);
    if (!spot) return null;
    const building = this.port.placeBuilding(key, spot.x, spot.y, 0);
    building.active = true;
    this.camps.push(building);
    const total = Math.round(guards * this.garrisonMult);
    const groups = new Map<UnitKind, number>();
    for (let i = 0; i < total; i++) {
      const kind = kinds[i % kinds.length];
      groups.set(kind, (groups.get(kind) ?? 0) + 1);
    }
    for (const [kind, amount] of groups) this.port.spawnSquad(kind, amount, this.world.wx(spot.x), this.world.wz(spot.y), 'enemy');
    return building;
  }

  spawnCampNear(x: number, y: number, guards: number, kinds: UnitKind[]): void {
    let spot: { x: number; y: number } | null = null;
    outer: for (let radius = 0; radius < 8 && !spot; radius++) {
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        if (this.areaClear(x + dx, y + dy)) { spot = { x: x + dx, y: y + dy }; break outer; }
      }
    }
    if (spot) {
      const camp = this.port.placeBuilding('banditcamp', spot.x, spot.y, 0);
      camp.active = true;
      this.camps.push(camp);
    }
    const groups = new Map<UnitKind, number>();
    for (let i = 0; i < guards; i++) {
      const kind = kinds[i % kinds.length];
      groups.set(kind, (groups.get(kind) ?? 0) + 1);
    }
    for (const [kind, amount] of groups) this.port.spawnSquad(kind, amount, this.world.wx(x), this.world.wz(y), 'enemy');
  }

  /** Ring a keep with a curtain wall and one barred gate facing the player's
   *  town. `innerTowers` (used by the level-9 fortress) posts that many
   *  watchtowers just inside the corners of a wider wall, behind the ramparts,
   *  rather than scattering them outside like `spawnTowerNear`. */
  fortifyStronghold(building: Building, innerTowers = 0): void {
    const store = this.port.primaryStore();
    const center = { x: building.x, y: building.y };
    const toward = { x: store?.x ?? this.world.playerStart.x, y: store?.y ?? this.world.playerStart.y };
    // a proper fortress gets a wider curtain so there is room for towers behind it
    const radius = innerTowers > 0 ? 6 : 4;
    // the shared fortification planner draws the curtain; terrain that refuses
    // a segment simply leaves a rough gap, as it always did
    for (const piece of planFortificationRing(center, radius, [sideToward(center, toward)])) {
      if (!this.areaClear(piece.x, piece.y)) continue;
      const wall = this.port.placeBuilding(piece.kind === 'gate' ? 'enemygate' : 'enemywall', piece.x, piece.y, piece.rot);
      wall.active = true;
    }
    // towers stand at the inner corners, just behind the curtain wall
    const corners = ringTowerSpots(center, radius);
    for (let i = 0; i < Math.min(innerTowers, corners.length); i++) {
      if (!this.areaClear(corners[i].x, corners[i].y)) continue;
      const tower = this.port.placeBuilding('enemywatchtower', corners[i].x, corners[i].y, 0);
      tower.active = true;
    }
  }

  spawnTowerNear(building: Building): void {
    for (let radius = 3; radius < 8; radius++) {
      for (const [dx, dy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius]]) {
        const x = building.x + dx, y = building.y + dy;
        if (!this.areaClear(x, y)) continue;
        const tower = this.port.placeBuilding('enemywatchtower', x, y, 0);
        tower.active = true;
        return;
      }
    }
  }

  spawnBoss(kind: UnitKind, fromEdge = false, zone: EnemyZone | null = fromEdge ? null : this.world.enemyZone): void {
    const enemyZone = fromEdge ? null : zone;
    if (enemyZone) {
      const squad = this.port.spawnSquad(kind, 1, this.world.wx(enemyZone.x), this.world.wz(enemyZone.y), UNITS[kind].faction);
      for (const unit of squad) unit.hp = unit.maxHp = Math.round(unit.maxHp * this.bossHpMult);
      this.port.toast(`The ${UNITS[kind].name} broods in its mountain lair — muster before you march`, 'err');
      return;
    }
    const edge = this.randomEdge();
    const squad = this.port.spawnSquad(kind, 1, edge.x, edge.z, UNITS[kind].faction);
    const castle = this.raidTarget();
    for (const unit of squad) {
      unit.hp = unit.maxHp = Math.round(unit.maxHp * this.bossHpMult);
      unit.raider = true;
      if (castle) this.port.orderAttackMove(unit, castle.x + 1, castle.y + 1);
    }
    this.port.toast(`The ${UNITS[kind].name} descends upon Het Gooi!`, 'err');
  }

  enemyStructuresLeft(): number {
    let count = 0;
    for (const building of this.port.buildings()) {
      if (building.removed || building.faction !== 'enemy') continue;
      if (building.key === 'banditcamp' || building.key === 'enemycastle' || building.key === 'enemywatchtower') count++;
    }
    return count;
  }

  hostileUnitsLeft(): number {
    let count = 0;
    for (const unit of this.port.units()) if (!unit.dead && unit.faction !== 'player') count++;
    return count;
  }

  private raidTarget(): Building | null {
    const targets: Building[] = [];
    for (const owner of PLAYER_IDS) {
      const building = this.port.playerStore(owner);
      if (building && !building.removed) targets.push(building);
    }
    if (!targets.length) return this.port.primaryStore();
    return targets.length === 1 ? targets[0] : targets[Math.floor(random() * targets.length)];
  }

  private randomEdge(): { x: number; z: number } {
    const width = this.world.W, height = this.world.H;
    const side = Math.floor(random() * 4);
    let tileX = 1, tileY = 1;
    if (side === 0) { tileX = 1 + Math.floor(random() * (width - 2)); tileY = 1; }
    else if (side === 1) { tileX = 1 + Math.floor(random() * (width - 2)); tileY = height - 2; }
    else if (side === 2) { tileX = 1; tileY = 1 + Math.floor(random() * (height - 2)); }
    else { tileX = width - 2; tileY = 1 + Math.floor(random() * (height - 2)); }
    return { x: this.world.wx(tileX), z: this.world.wz(tileY) };
  }

  private areaClear(tileX: number, tileY: number): boolean {
    for (let y = tileY; y < tileY + 2; y++) for (let x = tileX; x < tileX + 2; x++) {
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep || tile.road) return false;
    }
    return true;
  }

  private reachable(x: number, y: number): boolean {
    const width = this.world.W, height = this.world.H;
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (!this.reachMask) {
      const walk = (tileX: number, tileY: number): boolean => {
        if (this.world.passable(tileX, tileY)) return true;
        const tile = this.world.T(tileX, tileY);
        return !!tile && tile.type === 'grass' && !!tile.b && tile.b.faction !== 'player' && !tile.dep && !tile.tree?.dense;
      };
      const seen = new Uint8Array(width * height);
      const queueX: number[] = [], queueY: number[] = [];
      const centerX = this.world.playerStart.x + 1, centerY = this.world.playerStart.y + 1;
      outer: for (let radius = 1; radius < 10; radius++) for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (this.world.passable(centerX + dx, centerY + dy)) {
          queueX.push(centerX + dx);
          queueY.push(centerY + dy);
          seen[(centerY + dy) * width + centerX + dx] = 1;
          break outer;
        }
      }
      for (let i = 0; i < queueX.length; i++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nextX = queueX[i] + dx, nextY = queueY[i] + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || seen[nextY * width + nextX]) continue;
          if (!walk(nextX, nextY)) continue;
          seen[nextY * width + nextX] = 1;
          queueX.push(nextX);
          queueY.push(nextY);
        }
      }
      this.reachMask = seen;
    }
    return !!this.reachMask[y * width + x];
  }

  private findStrongholdSpot(targetZone?: EnemyZone): { x: number; y: number } | null {
    const width = this.world.W, height = this.world.H;
    const centerX = this.world.playerStart.x + 1, centerY = this.world.playerStart.y + 1;
    const spaced = (x: number, y: number) => this.camps.every(camp => Math.hypot(camp.x - x, camp.y - y) >= 6);
    const open = (x: number, y: number): boolean => {
      if (!this.areaClear(x, y) || !spaced(x, y)) return false;
      for (let offsetY = -1; offsetY <= 2; offsetY++) for (let offsetX = -1; offsetX <= 2; offsetX++) {
        if ((offsetX === -1 || offsetX === 2 || offsetY === -1 || offsetY === 2) && this.reachable(x + offsetX, y + offsetY)) return true;
      }
      return false;
    };
    const zones = this.world.enemyZones;
    const zone = targetZone ?? (zones.length ? zones[this.zoneIdx++ % zones.length] : null);
    if (zone) {
      let best: { x: number; y: number } | null = null, bestDistance = -1;
      for (let tries = 0; tries < 500; tries++) {
        const x = zone.x + Math.floor((random() * 2 - 1) * zone.r), y = zone.y + Math.floor((random() * 2 - 1) * zone.r);
        if (x < 2 || y < 2 || x > width - 4 || y > height - 4) continue;
        if (Math.hypot(x - zone.x, y - zone.y) > zone.r) continue;
        if (!open(x, y)) continue;
        const score = targetZone ? -Math.hypot(x - zone.x, y - zone.y) : Math.hypot(x - centerX, y - centerY);
        if (score > bestDistance || !best) { bestDistance = score; best = { x, y }; }
      }
      if (best) return best;
    }
    const clear = Math.max(12, Math.round(Math.min(width, height) * 0.22));
    for (const anywhere of [false, true]) {
      let best: { x: number; y: number } | null = null, bestDistance = -1;
      for (let tries = 0; tries < 400; tries++) {
        const x = 2 + Math.floor(random() * (width - 5)), y = 2 + Math.floor(random() * (height - 5));
        const distance = Math.hypot(x - centerX, y - centerY);
        if (distance < clear) continue;
        if (!(anywhere ? this.areaClear(x, y) : open(x, y))) continue;
        // Farthest-point spread: score by distance from the nearest existing
        // camp so successive strongholds fan out across the map instead of
        // all crowding whichever corner lies farthest from the player.
        const spread = this.camps.length
          ? Math.min(...this.camps.map(camp => Math.hypot(camp.x - x, camp.y - y)))
          : distance;
        const score = spread + distance * 0.25;
        if (score > bestDistance) { bestDistance = score; best = { x, y }; }
      }
      if (best) return best;
    }
    return null;
  }
}
