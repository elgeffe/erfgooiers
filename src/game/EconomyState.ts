import type { Building, PlayerId, Site, Unit } from '../types';
import type { Modifiers } from './Modifiers';

export type WorkerMetrics = Record<'serf' | 'villager' | 'builder', {
  count: number;
  status: 'good' | 'warn' | 'bad';
  note: string;
  /** How many more of this pool are needed right now (villagers: unstaffed buildings). */
  deficit: number;
}>;

/** Stock accounting and read-only workforce health metrics. */
export class EconomyState {
  constructor(
    private readonly buildings: readonly Building[],
    private readonly sites: readonly Site[],
    private readonly units: readonly Unit[],
    private readonly mods: Modifiers,
    private readonly storeFor: (owner: PlayerId) => Building,
    private readonly localPlayerId: PlayerId,
  ) {}

  stockTotal(): number {
    let total = 0;
    for (const store of this.stores()) for (const item in store.stock!) total += store.stock![item];
    return total;
  }

  wellFedWorkers(): number {
    let total = 0;
    for (const unit of this.units) if (!unit.dead && unit.faction === 'player' && unit.dmg === 0 && unit.hunger >= 66) total++;
    return total;
  }

  countItem(item: string, owner: PlayerId): number {
    const breakdown = this.itemBreakdown(item, owner);
    return breakdown.store + breakdown.buildings + breakdown.carried;
  }

  stores(owner?: PlayerId): Building[] {
    return this.buildings.filter(building => building.def.store && !building.removed && (!owner || building.owner === owner));
  }

  nearestStore(from: { x: number; y: number; owner?: unknown }): Building {
    const owner = from.owner === 'p1' || from.owner === 'p2' ? from.owner : this.localPlayerId;
    let best = this.storeFor(owner);
    let bestDistance = 1e9;
    for (const store of this.stores(owner)) {
      const distance = Math.abs(store.x - from.x) + Math.abs(store.y - from.y);
      if (distance < bestDistance) { bestDistance = distance; best = store; }
    }
    return best;
  }

  takeStock(item: string, amount: number, owner?: PlayerId): boolean {
    const stores = this.stores(owner);
    let available = 0;
    for (const store of stores) available += store.stock![item] || 0;
    if (available < amount) return false;
    for (const store of stores) {
      const taken = Math.min(amount, store.stock![item] || 0);
      store.stock![item] = (store.stock![item] || 0) - taken;
      amount -= taken;
      if (amount <= 0) break;
    }
    return true;
  }

  storeTotal(item: string, owner?: PlayerId): number {
    let total = 0;
    for (const store of this.stores(owner)) total += store.stock![item] || 0;
    return total;
  }

  itemBreakdown(item: string, owner: PlayerId): { store: number; buildings: number; carried: number } {
    let buildings = 0, carried = 0;
    for (const building of this.buildings) if (building.owner === owner && !building.def.store) buildings += (building.inp[item] || 0) + (building.out[item] || 0);
    for (const unit of this.units) if (unit.owner === owner && unit.carrying === item) carried++;
    return { store: this.storeTotal(item, owner), buildings, carried };
  }

  workerMetrics(): WorkerMetrics {
    let serfs = 0, idleSerfs = 0, villagers = 0, idleVillagers = 0, builders = 0;
    for (const unit of this.units) {
      if (unit.dead || unit.faction !== 'player') continue;
      if (unit.role === 'serf') { serfs++; if (!unit.task && !unit.collect) idleSerfs++; }
      else if (unit.role === 'villager') { villagers++; if (!unit.home) idleVillagers++; }
      else if (unit.role === 'laborer') builders++;
    }
    const carryCap = this.mods.carryCap();
    let haulLoad = 0;
    for (const site of this.sites) for (const item in site.needs) haulLoad += Math.max(0, site.needs[item] - (site.delivered[item] || 0) - (site.incoming[item] || 0));
    for (const building of this.buildings) {
      if (building.removed || !building.active) continue;
      if (building.def.recipe) for (const item in this.mods.recipeInputs(building.def)) if ((building.inp[item] || 0) + (building.incoming[item] || 0) < carryCap) haulLoad++;
      if (!building.def.store) for (const item in building.out) if (building.out[item] > 0) haulLoad++;
    }
    const serfStatus = (serfs === 0 && haulLoad > 0) || haulLoad > serfs * 2 ? 'bad' : haulLoad > 0 && idleSerfs === 0 ? 'warn' : 'good';
    let unstaffed = 0;
    for (const building of this.buildings) if (!building.removed && building.faction === 'player' && building.def.worker && !building.worker) unstaffed++;
    const villagerStatus = unstaffed > 0 ? 'bad' : idleVillagers === 0 ? 'warn' : 'good';
    const openSites = this.sites.length;
    const builderStatus = (builders === 0 && openSites > 0) || openSites > builders ? 'bad' : openSites === builders && openSites > 0 ? 'warn' : 'good';
    return {
      serf: { count: serfs, status: serfStatus, deficit: Math.max(0, haulLoad - serfs), note: haulLoad === 0 ? 'All caught up' : `${haulLoad} deliver${haulLoad === 1 ? 'y' : 'ies'} waiting` },
      villager: { count: villagers, status: villagerStatus, deficit: unstaffed, note: unstaffed > 0 ? `${unstaffed} building${unstaffed === 1 ? '' : 's'} unstaffed` : idleVillagers === 0 ? 'None spare' : `${idleVillagers} ready to post` },
      builder: { count: builders, status: builderStatus, deficit: Math.max(0, openSites - builders), note: openSites === 0 ? 'No sites pending' : `${openSites} site${openSites === 1 ? '' : 's'} to raise` },
    };
  }
}
