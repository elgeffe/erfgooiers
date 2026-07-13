import { BASE_SPEED, MAX_UNITS } from '../constants';
import { UNITS, type UnitKind } from '../data/units';
import { simRng } from '../engine/rng';
import type { View } from '../render/View';
import type { Building, Faction, OwnerId, PlayerId, Unit } from '../types';
import type { World } from '../world/World';
import type { Modifiers } from './Modifiers';
import { ownerForFaction } from './ownership';
import { doorTile } from './util';

interface UnitFactoryPorts {
  nextId: () => number;
  storeFor: (owner: PlayerId) => Building;
  primaryStore: () => Building;
  registerHero: (heroId: string, roleName: string, owner: PlayerId, unit: Unit) => void;
}

/** Creates units and deterministic level/sandbox spawn layouts. */
export class UnitFactory {
  constructor(
    private readonly world: World,
    private readonly view: View,
    private readonly mods: Modifiers,
    private readonly units: Unit[],
    private readonly localPlayerId: PlayerId,
    private readonly ports: UnitFactoryPorts,
  ) {}

  spawnUnit(role: string, colorHex: number, tile: { x: number; y: number }, owner: PlayerId): Unit {
    const { group, itemMesh } = this.view.createUnit(colorHex, role, tile.x, tile.y);
    const unit: Unit = {
      id: this.ports.nextId(), owner, role, roleName: role[0].toUpperCase() + role.slice(1), colorHex, mesh: group, itemMesh,
      tx: tile.x, ty: tile.y, path: null, pathI: 0, task: null, carrying: null, collect: null,
      home: null, wstate: 'idle', timer: 0, target: null, hunger: 70 + simRng.next() * 30, bob: 0, status: 'Idle',
      faction: 'player', spd: BASE_SPEED, hp: 20, maxHp: 20, dmg: 0, range: 0, atkCd: 1, atkTimer: 0,
      dead: false, raider: false, foe: null, foeB: null, order: null, orderQueue: [], obeyT: 0, special: 0,
      anchor: null, lungeT: 0, hpBar: null, sepI: 0,
    };
    this.units.push(unit);
    return unit;
  }

  spawnHero(heroId: string, roleName: string, owner: PlayerId): Unit {
    const def = UNITS.hero;
    const door = doorTile(this.ports.storeFor(owner));
    let tile = { x: door.x, y: door.y + 1 };
    if (!this.world.passable(tile.x, tile.y)) {
      for (let radius = 1; radius < 5 && !this.world.passable(tile.x, tile.y); radius++)
        for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++)
          if (this.world.passable(door.x + dx, door.y + dy)) tile = { x: door.x + dx, y: door.y + dy };
    }
    const { group, itemMesh } = this.view.createHero(heroId, tile.x, tile.y);
    const hp = Math.round(def.hp * this.mods.combatMult('hp', 'hero'));
    const unit: Unit = {
      id: this.ports.nextId(), owner, role: 'hero', roleName, colorHex: def.color, mesh: group, itemMesh,
      tx: tile.x, ty: tile.y, path: null, pathI: 0, task: null, carrying: null, collect: null,
      home: null, wstate: 'idle', timer: 0, target: null, hunger: 100, bob: 0, status: 'Ready to ride',
      faction: 'player', spd: def.speed * this.mods.combatMult('speed', 'hero'), hp, maxHp: hp,
      dmg: def.dmg * this.mods.combatMult('damage', 'hero'), range: def.range, atkCd: def.atkCd, atkTimer: 0,
      dead: false, raider: false, foe: null, foeB: null, order: null, orderQueue: [], obeyT: 0, special: 0,
      anchor: null, lungeT: 0, hpBar: null, sepI: 0,
    };
    this.units.push(unit);
    this.ports.registerHero(heroId, roleName, owner, unit);
    return unit;
  }

  spawnFighter(kind: UnitKind, tile: { x: number; y: number }, faction?: Faction, owner?: OwnerId): Unit {
    const def = UNITS[kind];
    const unitFaction = faction ?? def.faction;
    const unitOwner = owner ?? ownerForFaction(unitFaction, this.localPlayerId);
    const unit = this.spawnUnit(kind, def.color, tile, unitOwner === 'p2' ? 'p2' : 'p1');
    unit.roleName = def.name;
    unit.faction = unitFaction;
    unit.owner = unitOwner;
    unit.spd = def.speed * this.mods.combatMult('speed', kind);
    unit.maxHp = unit.hp = Math.round(def.hp * this.mods.combatMult('hp', kind));
    unit.dmg = def.dmg * this.mods.combatMult('damage', kind);
    unit.range = def.range * this.mods.combatMult('range', kind);
    unit.atkCd = def.atkCd;
    unit.hunger = 100;
    unit.status = def.name;
    unit.anchor = { x: tile.x, y: tile.y };
    unit.mesh.scale.setScalar(def.scale);
    return unit;
  }

  spawnStartArmy(groups: { kind: UnitKind; count: number }[]): Unit[] {
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    if (total <= 0) return [];
    const store = this.ports.primaryStore();
    const door = doorTile(store);
    const [dirX, dirY] = [[0, 1], [-1, 0], [0, -1], [1, 0]][store.rot || 0];
    const columns = Math.max(4, Math.ceil(Math.sqrt(total * 1.8)));
    const result: Unit[] = [];
    const queue: UnitKind[] = [];
    for (const group of groups) for (let index = 0; index < group.count; index++) queue.push(group.kind);
    const tryTile = (x: number, y: number): void => {
      if (!queue.length || this.units.length >= MAX_UNITS) return;
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep || tile.tree || tile.field) return;
      result.push(this.spawnFighter(queue.shift()!, { x, y }, 'player'));
    };
    for (let rank = 0; queue.length && rank < 40; rank++) {
      const x = door.x + dirX * (2 + rank), y = door.y + dirY * (2 + rank);
      for (let column = 0; queue.length && column < columns; column++) {
        const offset = (column % 2 === 0 ? 1 : -1) * Math.ceil(column / 2);
        tryTile(x + (dirY !== 0 ? offset : 0), y + (dirX !== 0 ? offset : 0));
      }
    }
    for (const kind of queue.splice(0)) result.push(...this.spawnSquad(kind, 1, this.world.wx(door.x) + dirX * 2, this.world.wz(door.y) + dirY * 2, 'player'));
    for (const unit of result) unit.mesh.rotation.y = Math.atan2(dirX, dirY);
    return result;
  }

  spawnSquad(kind: UnitKind, count: number, worldX: number, worldZ: number, faction?: Faction): Unit[] {
    const centerX = Math.max(2, Math.min(this.world.W - 3, Math.floor(worldX + this.world.W / 2)));
    const centerY = Math.max(2, Math.min(this.world.H - 3, Math.floor(worldZ + this.world.H / 2)));
    const result: Unit[] = [];
    const tryTile = (x: number, y: number): void => {
      if (result.length >= count || this.units.length >= MAX_UNITS) return;
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep) return;
      result.push(this.spawnFighter(kind, { x, y }, faction));
    };
    tryTile(centerX, centerY);
    for (let radius = 1; radius < 14 && result.length < count; radius++)
      for (let dx = -radius; dx <= radius && result.length < count; dx++)
        for (let dy = -radius; dy <= radius && result.length < count; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          tryTile(centerX + dx, centerY + dy);
        }
    return result;
  }
}
