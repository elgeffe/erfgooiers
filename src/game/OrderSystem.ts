import { UNITS, formationRank, type UnitKind } from '../data/units';
import { buildFlowField, type FlowField } from '../engine/flowfield';
import { formationSpots } from '../engine/formations';
import type { View } from '../render/View';
import type { Building, Coord, Formation, OwnerId, Site, Unit, UnitOrder } from '../types';
import type { World } from '../world/World';

const FLOW_FIELD_MIN_UNITS = 8;

interface OrderPorts {
  siegeTile: (unit: Unit, building: Building) => Coord;
  toast: (message: string, owner?: OwnerId) => void;
  sfx: (name: string) => void;
}

/** Unit commands, command queues, formations, siege orders, and rally points. */
export class OrderSystem {
  constructor(
    private readonly world: World,
    private readonly view: View,
    private readonly ports: OrderPorts,
  ) {}

  togglePriority(target: Site | Building): void {
    target.priority = !target.priority;
    this.ports.sfx('click');
    this.ports.toast(target.priority ? `${target.def.name} prioritized` : `${target.def.name} no longer prioritized`, target.owner);
  }

  orderUnit(unit: Unit, type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null = null, queue = false, field: FlowField | null = null): void {
    this.queueOrder(unit, { type, x, y, foe, building: null, field }, queue);
  }

  queueOrder(unit: Unit, order: UnitOrder, queue: boolean): void {
    if (queue && (unit.order || unit.orderQueue.length)) { unit.orderQueue.push(order); return; }
    unit.orderQueue.length = 0;
    this.applyOrder(unit, order);
  }

  advanceOrder(unit: Unit): boolean {
    const next = unit.orderQueue.shift();
    if (!next) {
      unit.order = null; unit.path = null; unit.foe = null; unit.foeB = null; unit.obeyT = 0;
      return false;
    }
    this.applyOrder(unit, next);
    return true;
  }

  formationPreview(units: Unit[], x: number, y: number, formation: Formation, facing: Coord): Coord[] {
    return formationSpots(x, y, units.length, formation, units.map(unit => ({ x: unit.tx, y: unit.ty })), this.formationGround, facing);
  }

  orderGroup(units: Unit[], type: 'move' | 'attack' | 'attackMove', x: number, y: number, foe: Unit | null, formation: Formation, facing: Coord | undefined, queue: boolean): void {
    if (type === 'attack' && foe) {
      for (const unit of units) this.orderUnit(unit, 'attack', foe.tx, foe.ty, foe, queue);
      return;
    }
    const spots = formationSpots(x, y, units.length, formation, units.map(unit => ({ x: unit.tx, y: unit.ty })), this.formationGround, facing);
    const field = units.length >= FLOW_FIELD_MIN_UNITS ? buildFlowField(this.world, spots, units[0].owner) : null;
    const ordered = units
      .map((unit, index) => ({ unit, index, rank: formationRank(unit.role) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index);
    for (let index = 0; index < ordered.length; index++) {
      const unit = ordered[index].unit;
      const spot = spots[index] ?? { x: unit.tx, y: unit.ty };
      this.orderUnit(unit, type, spot.x, spot.y, null, queue, field);
    }
  }

  buildingAt(tx: number, ty: number): Building | null {
    const tile = this.world.T(tx, ty);
    return tile?.b && !tile.b.removed ? tile.b : null;
  }

  orderGroupAttackBuilding(units: Unit[], building: Building, queue: boolean): void {
    if (building.removed) return;
    const assigned = units.map(unit => ({ unit, spot: this.ports.siegeTile(unit, building) }));
    const ring = new Map<string, Coord>();
    for (const { spot } of assigned) ring.set(`${spot.x},${spot.y}`, spot);
    const field = units.length >= FLOW_FIELD_MIN_UNITS ? buildFlowField(this.world, [...ring.values()], units[0].owner) : null;
    for (const { unit, spot } of assigned) {
      if (UNITS[unit.role as UnitKind]?.heal) this.orderUnit(unit, 'attackMove', spot.x, spot.y, null, queue, field);
      else this.queueOrder(unit, { type: 'attackMove', x: spot.x, y: spot.y, foe: null, building, field }, queue);
    }
  }

  setRally(target: Building | Site, x: number, y: number): void {
    if (!target.def.military || target.removed) return;
    target.rally = { x, y };
    // every muster building (barracks, stable, engineer, monastery) flies the
    // same purple rally pennant so its spawn point reads apart from order flags
    if (!target.rallyMesh) target.rallyMesh = this.view.createFlag(0x8a4fbf);
    target.rallyMesh.position.set(this.world.wx(x), 0, this.world.wz(y));
    this.ports.toast('Rally point set — trained fighters will muster there', target.owner);
    this.ports.sfx('click');
  }

  private applyOrder(unit: Unit, order: UnitOrder): void {
    unit.order = order;
    unit.foe = order.type === 'attack' ? order.foe : null;
    unit.foeB = order.building && !order.building.removed ? order.building : null;
    unit.path = null;
    unit.timer = 0;
    unit.obeyT = order.type === 'attack' || order.building ? 0 : 2.5;
    if (unit.faction === 'player' && unit.wstate === 'leash') unit.wstate = 'idle';
  }

  private readonly formationGround = (tx: number, ty: number): boolean => {
    const tile = this.world.T(tx, ty);
    return !!tile && tile.type === 'grass' && !tile.b && !tile.site && !tile.dep && !tile.tree?.dense;
  };
}
