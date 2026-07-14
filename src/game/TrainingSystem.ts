import { ITEMS } from '../data/items';
import { UNITS, type UnitKind } from '../data/units';
import type { Building, Coord, ItemKey, OwnerId, PlayerId, Unit } from '../types';
import type { Modifiers } from './Modifiers';
import { doorTile, unitLabel } from './util';

interface TrainingPorts {
  buildings: () => readonly Building[];
  units: () => Unit[];
  storeFor: (owner: PlayerId) => Building;
  storeTotal: (item: string, owner: PlayerId) => number;
  takeStock: (item: string, amount: number, owner: PlayerId) => boolean;
  spawnUnit: (role: string, color: number, tile: Coord, owner: PlayerId) => Unit;
  spawnFighter: (kind: UnitKind, tile: Coord, owner: PlayerId) => Unit;
  pathTo: (unit: Unit, x: number, y: number) => Coord[] | null;
  orderAttackMove: (unit: Unit, x: number, y: number) => void;
  removeUnit: (unit: Unit) => void;
  onTrain: () => void;
  onGold: (amount: number) => void;
  toast: (message: string, cls?: string, owner?: OwnerId) => void;
  sfx: (name: string) => void;
}

/** Training queues and the civilian services operated by staffed buildings. */
export class TrainingSystem {
  constructor(
    private readonly mods: Modifiers,
    private readonly ports: TrainingPorts,
  ) {}

  trainUnit(building: Building, kind: string): boolean {
    const spec = building.def.military ?? building.def.trainer;
    const training = spec?.units.find(unit => unit.kind === kind);
    if (!training || !building.active) return false;
    if (building.owner !== 'p1' && building.owner !== 'p2') return false;
    if (!this.ports.storeFor(building.owner).stock) return false;
    const cost = this.mods.unitCost(kind, training.cost);
    for (const item in cost) {
      const amount = cost[item as ItemKey] ?? 0;
      if (this.ports.storeTotal(item, building.owner) < amount) {
        this.ports.toast(`Not enough ${ITEMS[item as ItemKey].name.toLowerCase()} to train a ${unitLabel(kind).toLowerCase()}`, 'err', building.owner);
        this.ports.sfx('error');
        return false;
      }
    }
    for (const item in cost) {
      this.ports.takeStock(item, cost[item as ItemKey] ?? 0, building.owner);
    }
    (building.trainQ ||= []).push(kind);
    this.ports.sfx('click');
    return true;
  }

  cancelTrain(building: Building, index: number): void {
    if (!building.trainQ || index < 0 || index >= building.trainQ.length) return;
    const spec = building.def.military ?? building.def.trainer;
    const kind = building.trainQ[index];
    const training = spec?.units.find(unit => unit.kind === kind);
    building.trainQ.splice(index, 1);
    if (index === 0) building.prog = 0;
    if (training && (building.owner === 'p1' || building.owner === 'p2')) {
      const store = this.ports.storeFor(building.owner);
      const cost = this.mods.unitCost(kind, training.cost);
      for (const item in cost) {
        const amount = cost[item as ItemKey] ?? 0;
        store.stock![item] = (store.stock![item] || 0) + amount;
      }
    }
    this.ports.sfx('click');
  }

  spawnCivilian(role: string, tile: Coord, owner: PlayerId): Unit {
    if (role === 'serf') return this.ports.spawnUnit('serf', 0xd8c49a, tile, owner);
    if (role === 'laborer') {
      const unit = this.ports.spawnUnit('laborer', 0xc97b3d, tile, owner);
      unit.roleName = 'Builder';
      unit.anchor = { x: tile.x, y: tile.y };
      return unit;
    }
    const unit = this.ports.spawnUnit('villager', 0xcdbb8f, tile, owner);
    unit.roleName = 'Villager';
    unit.status = 'Awaiting a post';
    return unit;
  }

  updateQueues(dt: number): void {
    for (const building of this.ports.buildings()) {
      const spec = building.def.military ?? building.def.trainer;
      if (!spec || !building.active) continue;
      if (!building.trainQ || !building.trainQ.length) {
        building.prog = 0;
        continue;
      }
      const head = spec.units.find(unit => unit.kind === building.trainQ![0]);
      const time = (head?.time ?? 6) * this.mods.trainTime(building.trainQ[0]);
      building.prog += dt / time;
      if (building.prog < 1) continue;

      building.prog = 0;
      const kind = building.trainQ.shift()!;
      const tile = doorTile(building);
      const owner = building.owner === 'p2' ? 'p2' : 'p1';
      if (kind in UNITS) {
        const unit = this.ports.spawnFighter(kind as UnitKind, tile, owner);
        this.ports.onTrain();
        if (building.rally) this.ports.orderAttackMove(unit, building.rally.x, building.rally.y);
      } else {
        this.spawnCivilian(kind, tile, owner);
      }
      this.ports.sfx('build');
    }
  }

  staffBuildings(): void {
    for (const building of this.ports.buildings()) {
      if (building.removed || !building.def.worker || building.worker || building.faction !== 'player') continue;
      let best: Unit | null = null;
      let bestPath: Coord[] | null = null;
      let bestDistance = 1e9;
      const door = doorTile(building);
      for (const unit of this.ports.units()) {
        if (unit.dead || unit.owner !== building.owner || unit.role !== 'villager' || unit.home) continue;
        const distance = Math.abs(unit.tx - building.x) + Math.abs(unit.ty - building.y);
        if (distance < bestDistance) {
          const path = this.ports.pathTo(unit, door.x, door.y);
          if (path === null) continue;
          bestDistance = distance;
          best = unit;
          bestPath = path;
        }
      }
      if (!best) continue;

      const tile = { x: best.tx, y: best.ty };
      this.ports.removeUnit(best);
      const owner = building.owner === 'p2' ? 'p2' : 'p1';
      const unit = this.ports.spawnUnit(building.def.worker.toLowerCase(), building.def.wcolor!, tile, owner);
      unit.home = building;
      unit.wstate = 'goHome';
      unit.roleName = building.def.worker;
      unit.path = bestPath;
      unit.pathI = 0;
      building.worker = unit;
    }
  }

  serveTaverns(dt: number): void {
    for (const building of this.ports.buildings()) {
      const tavern = building.def.tavern;
      if (!tavern || !building.active) continue;
      building.prog += dt / tavern.time;
      if (building.prog < 1) continue;
      building.prog = 0;
      const eaters = this.ports.units()
        .filter(unit => unit.owner === building.owner && unit.faction === 'player' && !(unit.role in UNITS) && unit.hunger < 90)
        .sort((left, right) => left.hunger - right.hunger)
        .slice(0, tavern.capacity);
      const fed: Unit[] = [];
      for (const unit of eaters) {
        const food = tavern.foods.find(item => (building.inp[item] || 0) > 0);
        if (!food) break;
        building.inp[food]--;
        unit.hunger = 100;
        fed.push(unit);
      }
      building.fedUnits = fed;
      const tithe = this.mods.goldPerMeal();
      if (tithe > 0 && fed.length) {
        this.ports.onGold(tithe * fed.length);
        this.ports.sfx('coin');
      }
    }
  }
}
