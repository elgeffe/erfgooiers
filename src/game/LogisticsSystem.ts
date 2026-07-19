import { ITEMS } from '../data/items';
import { PLAYER_IDS, type Building, type OwnerId, type PlayerId, type Site, type Unit } from '../types';
import type { Modifiers } from './Modifiers';
import { doorTile } from './util';

interface LogisticsPorts {
  buildings: () => readonly Building[];
  sites: () => readonly Site[];
  units: () => readonly Unit[];
  nearestStore: (from: Building) => Building;
  storeFor: (owner: PlayerId) => Building;
  setCarrying: (unit: Unit, item: string | null) => void;
  sendTo: (unit: Unit, x: number, y: number) => boolean;
  moveUnit: (unit: Unit, dt: number) => boolean;
}

interface Demand {
  pri: number;
  to: Building | Site;
  item: string;
  from?: Building;
}

/** Assigns physical deliveries and advances serfs through their current task. */
export class LogisticsSystem {
  constructor(
    private readonly modsFor: (owner: OwnerId) => Modifiers,
    private readonly ports: LogisticsPorts,
  ) {}

  dispatch(): void {
    for (const owner of PLAYER_IDS) this.dispatchOwner(owner);
  }

  updateSerf(unit: Unit, dt: number): void {
    const task = unit.task;
    if (!task) {
      unit.status = 'Idle';
      return;
    }
    if (task.phase === 'pickup') {
      const door = doorTile(task.from);
      if (unit.tx === door.x && unit.ty === door.y && !unit.path) {
        this.ports.setCarrying(unit, task.item);
        task.phase = 'deliver';
        unit.status = `Carrying ${ITEMS[task.item as keyof typeof ITEMS].name} → ${task.to.name}`;
      } else if (!unit.path && !this.ports.sendTo(unit, door.x, door.y)) {
        this.cancelTask(unit);
        return;
      }
    }
    if (task.phase === 'deliver') {
      const door = doorTile(task.to);
      if (unit.tx === door.x && unit.ty === door.y && !unit.path) {
        if (task.to.isSite) {
          task.to.incoming[task.item]--;
          task.to.delivered[task.item]++;
          this.checkSiteReady(task.to);
        } else if (task.to.def.store) {
          task.to.stock![task.item] = (task.to.stock![task.item] || 0) + 1;
        } else {
          task.to.incoming[task.item]--;
          task.to.inp[task.item] = (task.to.inp[task.item] || 0) + 1;
        }
        this.ports.setCarrying(unit, null);
        unit.task = null;
        unit.status = 'Idle';
      } else if (!unit.path && unit.carrying && !this.ports.sendTo(unit, door.x, door.y)) {
        this.cancelTask(unit);
        return;
      }
    }
    if (unit.path) this.ports.moveUnit(unit, dt);
    else unit.mesh.position.y = 0;
  }

  cancelTask(unit: Unit): void {
    const task = unit.task;
    if (!task) return;
    if (task.phase === 'pickup' && !task.from.removed) {
      if (task.from.def && task.from.def.store) task.from.stock![task.item]++;
      else task.from.out[task.item]++;
    }
    if (task.to.isSite) task.to.incoming[task.item] = Math.max(0, (task.to.incoming[task.item] || 0) - 1);
    else if (task.to.def && !task.to.def.store) task.to.incoming[task.item] = Math.max(0, (task.to.incoming[task.item] || 0) - 1);
    if (unit.carrying && (unit.owner === 'p1' || unit.owner === 'p2')) {
      const store = this.ports.storeFor(unit.owner);
      store.stock![unit.carrying] = (store.stock![unit.carrying] || 0) + 1;
    }
    this.ports.setCarrying(unit, null);
    unit.task = null;
    unit.status = 'Idle';
  }

  private dispatchOwner(owner: PlayerId): void {
    let idle = this.ports.units().filter(unit => unit.owner === owner && unit.role === 'serf' && !unit.task && !unit.collect);
    if (!idle.length) return;
    const carryCap = this.modsFor(owner).carryCap();
    const outCap = this.modsFor(owner).outCap();
    const demands: Demand[] = [];

    for (const site of this.ports.sites()) {
      if (site.owner !== owner) continue;
      for (const item in site.needs) {
        const remaining = site.needs[item] - (site.delivered[item] || 0) - (site.incoming[item] || 0);
        for (let i = 0; i < remaining; i++) demands.push({ pri: site.priority ? -1 : 0, to: site, item });
      }
    }
    for (const building of this.ports.buildings()) {
      if (building.owner !== owner || !building.active || !building.def.recipe) continue;
      for (const item in this.modsFor(owner).recipeInputs(building.def)) {
        const have = (building.inp[item] || 0) + (building.incoming[item] || 0);
        if (have < carryCap) demands.push({ pri: building.priority ? 0.75 : 1, to: building, item });
      }
    }
    for (const building of this.ports.buildings()) {
      if (building.owner !== owner || !building.active || !building.def.tavern) continue;
      const tavern = building.def.tavern;
      const total = tavern.foods.reduce((sum, item) => sum + (building.inp[item] || 0) + (building.incoming[item] || 0), 0);
      if (total >= tavern.capacity) continue;
      for (const item of tavern.foods) {
        const have = (building.inp[item] || 0) + (building.incoming[item] || 0);
        if (have < 2) demands.push({ pri: 1, to: building, item });
      }
    }
    for (const building of this.ports.buildings()) {
      // own markets only: a serf stocking another owner's stalls would gift
      // that owner the sale — an exploit in skirmish, a leak in co-op
      if (building.owner !== owner || !building.active || building.key !== 'market' || building.faction !== 'player') continue;
      for (const order of building.marketOrders ?? []) {
        const missing = order.amount - (building.inp[order.item] || 0) - (building.incoming[order.item] || 0);
        // a priority-flagged market outranks routine industry feeding: exports
        // may be the settlement's only coin income (no gold veins in reach)
        for (let i = 0; i < missing; i++) demands.push({ pri: building.priority ? 0.6 : 1.5, to: building, item: order.item });
      }
    }
    for (const building of this.ports.buildings()) {
      if (building.owner !== owner || !building.active || building.def.store) continue;
      for (const item in building.out) {
        if (building.out[item] <= 0) continue;
        const wanted = demands.some(demand => demand.item === item);
        if (!wanted && building.out[item] >= outCap - 1) {
          demands.push({ pri: building.priority ? 0.4 : 0.5, to: this.ports.nearestStore(building), item, from: building });
        } else if (!wanted) {
          demands.push({ pri: 2, to: this.ports.nearestStore(building), item, from: building });
        }
      }
    }

    demands.sort((left, right) => left.pri - right.pri);
    for (const demand of demands) {
      if (!idle.length) break;
      let from: Building | null = null;
      if (demand.from) {
        if (demand.from.out[demand.item] > 0) from = demand.from;
      } else {
        let best: Building | null = null;
        let bestDistance = 1e9;
        for (const building of this.ports.buildings()) {
          if (building.owner !== owner || building === demand.to) continue;
          const available = building.def.store ? (building.stock![demand.item] || 0) : (building.out[demand.item] || 0);
          if (available <= 0) continue;
          const distance = this.buildingDistance(building, demand.to) + (building.def.store ? 0.5 : 0);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = building;
          }
        }
        from = best;
      }
      if (!from) continue;

      let serf: Unit | null = null;
      let bestDistance = 1e9;
      const door = doorTile(from);
      for (const unit of idle) {
        const distance = Math.abs(unit.tx - door.x) + Math.abs(unit.ty - door.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          serf = unit;
        }
      }
      if (!serf) continue;
      if (from.def.store) from.stock![demand.item]--;
      else from.out[demand.item]--;
      if (demand.to.isSite) demand.to.incoming[demand.item] = (demand.to.incoming[demand.item] || 0) + 1;
      else if (!demand.to.def.store) demand.to.incoming[demand.item] = (demand.to.incoming[demand.item] || 0) + 1;
      serf.task = { from, to: demand.to, item: demand.item, phase: 'pickup' };
      serf.status = `Fetching ${ITEMS[demand.item as keyof typeof ITEMS].name}`;
      idle = idle.filter(unit => unit !== serf);
    }
  }

  checkSiteReady(site: Site): void {
    for (const item in site.needs) if ((site.delivered[item] || 0) < site.needs[item]) return;
    site.ready = true;
    site.frame.visible = true;
    site.frame.scale.set(1, 0.05, 1);
  }

  private buildingDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
    return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
  }
}
