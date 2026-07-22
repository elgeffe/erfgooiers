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
  // The owner's chosen co-op colour (undefined in single player), used to tint
  // ownership markers so each player's units read at a glance.
  playerColor: (owner: OwnerId) => number | undefined;
}

/** Creates units and deterministic level/sandbox spawn layouts. */
export class UnitFactory {
  /** Soft ceiling on live units. Single player lowers it from the settings'
   *  performance cap; co-op always keeps the shared MAX_UNITS so both peers
   *  gate spawns identically. */
  unitCap = MAX_UNITS;

  constructor(
    private readonly world: World,
    private readonly view: View,
    private readonly modsFor: (owner: OwnerId) => Modifiers,
    private readonly units: Unit[],
    private readonly localPlayerId: PlayerId,
    private readonly ports: UnitFactoryPorts,
  ) {}

  spawnUnit(role: string, colorHex: number, tile: { x: number; y: number }, owner: PlayerId, faction: Faction = 'player'): Unit {
    // In co-op the owner's colour tints ownership markers: a worker's hat, a
    // soldier's plate & shield. Only player units carry it; enemies and single
    // player (no colour registered) keep their role palettes.
    const teamHex = faction === 'player' ? this.ports.playerColor(owner) : undefined;
    const { group, itemMesh } = this.view.createUnit(colorHex, role, tile.x, tile.y, faction, teamHex);
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
    const mods = this.modsFor(owner);
    const hp = Math.round(def.hp * mods.combatMult('hp', 'hero'));
    const unit: Unit = {
      id: this.ports.nextId(), owner, role: 'hero', roleName, colorHex: def.color, mesh: group, itemMesh,
      tx: tile.x, ty: tile.y, path: null, pathI: 0, task: null, carrying: null, collect: null,
      home: null, wstate: 'idle', timer: 0, target: null, hunger: 100, bob: 0, status: 'Ready to ride',
      faction: 'player', spd: def.speed * mods.combatMult('speed', 'hero'), hp, maxHp: hp,
      dmg: def.dmg * mods.combatMult('damage', 'hero'), range: def.range, atkCd: def.atkCd, atkTimer: 0,
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
    // Military outfits take the owner's co-op colour so it's clear whose army is
    // whose; single player and enemies fall back to the kind's own colour.
    const teamHex = unitFaction === 'player' ? this.ports.playerColor(unitOwner) : undefined;
    const unit = this.spawnUnit(kind, teamHex ?? def.color, tile, unitOwner === 'p2' ? 'p2' : 'p1', unitFaction);
    unit.roleName = def.name;
    unit.faction = unitFaction;
    unit.owner = unitOwner;
    const mods = this.modsFor(unitOwner);
    unit.spd = def.speed * mods.combatMult('speed', kind, unitFaction);
    unit.maxHp = unit.hp = Math.round(def.hp * mods.combatMult('hp', kind, unitFaction));
    unit.dmg = def.dmg * mods.combatMult('damage', kind, unitFaction);
    unit.range = def.range * mods.combatMult('range', kind, unitFaction);
    unit.atkCd = def.atkCd;
    unit.hunger = 100;
    unit.status = def.name;
    unit.anchor = { x: tile.x, y: tile.y };
    unit.mesh.scale.setScalar(def.scale);
    return unit;
  }

  /** Parade the granted warband in ranks on open ground WELL in front of the
   *  owner's castle gate — a garrison stands guard on the approach, it does
   *  not crowd the keep's doorstep. */
  spawnStartArmy(groups: { kind: UnitKind; count: number }[], owner: PlayerId = this.localPlayerId): Unit[] {
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    if (total <= 0) return [];
    const store = this.ports.storeFor(owner);
    const door = doorTile(store);
    const [dirX, dirY] = [[0, 1], [-1, 0], [0, -1], [1, 0]][store.rot || 0];
    const columns = Math.max(4, Math.ceil(Math.sqrt(total * 1.8)));
    const FRONT = 6; // tiles of open ground between the gate and the first rank
    const result: Unit[] = [];
    const queue: UnitKind[] = [];
    for (const group of groups) for (let index = 0; index < group.count; index++) queue.push(group.kind);
    const tryTile = (x: number, y: number): void => {
      if (!queue.length || this.units.length >= this.unitCap) return;
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep || tile.tree || tile.field) return;
      result.push(this.spawnFighter(queue.shift()!, { x, y }, 'player', owner));
    };
    for (let rank = 0; queue.length && rank < 40; rank++) {
      const x = door.x + dirX * (FRONT + rank), y = door.y + dirY * (FRONT + rank);
      for (let column = 0; queue.length && column < columns; column++) {
        const offset = (column % 2 === 0 ? 1 : -1) * Math.ceil(column / 2);
        tryTile(x + (dirY !== 0 ? offset : 0), y + (dirX !== 0 ? offset : 0));
      }
    }
    for (const kind of queue.splice(0)) result.push(...this.spawnSquad(kind, 1, this.world.wx(door.x + dirX * FRONT), this.world.wz(door.y + dirY * FRONT), 'player', owner));
    for (const unit of result) unit.mesh.rotation.y = Math.atan2(dirX, dirY);
    return result;
  }

  spawnSquad(kind: UnitKind, count: number, worldX: number, worldZ: number, faction?: Faction, owner?: OwnerId): Unit[] {
    const centerX = Math.max(2, Math.min(this.world.W - 3, Math.floor(worldX + this.world.W / 2)));
    const centerY = Math.max(2, Math.min(this.world.H - 3, Math.floor(worldZ + this.world.H / 2)));
    const result: Unit[] = [];
    const tryTile = (x: number, y: number): void => {
      if (result.length >= count || this.units.length >= this.unitCap) return;
      const tile = this.world.T(x, y);
      if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep) return;
      // owner must be set at spawn so combat stats bake from the right player's
      // rule set (and identically on both co-op peers, not the local seat's).
      result.push(this.spawnFighter(kind, { x, y }, faction, owner));
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
