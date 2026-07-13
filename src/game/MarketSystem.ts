import type * as THREE from 'three';
import { ITEMS, MARKET_VALUES } from '../data/items';
import type { Building, ItemKey } from '../types';

interface MarketCaravan {
  mesh: THREE.Group;
  market: Building;
  item: ItemKey;
  amount: number;
  state: 'arriving' | 'trading' | 'leaving';
  edgeX: number;
  edgeZ: number;
  wait: number;
}

export interface MarketPort {
  buildings(): readonly Building[];
  worldWidth(): number;
  buildingCenter(building: Building): { x: number; z: number };
  createCaravan(): THREE.Group;
  remove(mesh: THREE.Object3D): void;
  sfx(name: string): void;
  toast(message: string): void;
}

/** Neutral export caravans and the physical market inventory they consume. */
export class MarketSystem {
  private readonly caravans: MarketCaravan[] = [];

  constructor(private readonly port: MarketPort) {}

  configure(building: Building, item: ItemKey, amount: number): void {
    if (building.key !== 'market' || building.faction !== 'player' || building.removed || MARKET_VALUES[item] === undefined) return;
    building.marketItem = item;
    building.marketAmount = Math.max(0, Math.min(50, Number.isFinite(amount) ? Math.round(amount) : 0));
  }

  incomePerMinute(building: Building): number {
    return (MARKET_VALUES[building.marketItem ?? 'timber'] ?? 0) * (building.marketAmount ?? 0);
  }

  caravansInTransit(building: Building): number {
    let count = 0;
    for (const caravan of this.caravans) if (caravan.market === building) count++;
    return count;
  }

  removeBuilding(building: Building): void {
    for (let i = this.caravans.length - 1; i >= 0; i--) {
      if (this.caravans[i].market !== building) continue;
      this.port.remove(this.caravans[i].mesh);
      this.caravans.splice(i, 1);
    }
  }

  update(dt: number): void {
    for (const building of this.port.buildings()) {
      if (building.key !== 'market' || building.faction !== 'player' || !building.active || building.removed) continue;
      building.marketTimer = Math.max(0, (building.marketTimer ?? 60) - dt);
      if (building.marketTimer > 0 || this.caravansInTransit(building)) continue;
      const item = building.marketItem ?? 'timber';
      const amount = building.marketAmount ?? 0;
      if (amount <= 0) { building.marketTimer = 60; continue; }
      if ((building.inp[item] || 0) < amount) { building.marketTimer = 5; continue; }
      building.marketTimer = 60;
      this.spawnCaravan(building, item, amount);
    }

    for (let i = this.caravans.length - 1; i >= 0; i--) {
      const caravan = this.caravans[i];
      if (caravan.market.removed) {
        this.port.remove(caravan.mesh);
        this.caravans.splice(i, 1);
        continue;
      }
      if (caravan.state === 'trading') {
        caravan.wait -= dt;
        if (caravan.wait <= 0) caravan.state = 'leaving';
        continue;
      }
      const center = this.port.buildingCenter(caravan.market);
      const targetX = caravan.state === 'arriving' ? center.x : caravan.edgeX;
      const targetZ = caravan.state === 'arriving' ? center.z : caravan.edgeZ;
      const dx = targetX - caravan.mesh.position.x, dz = targetZ - caravan.mesh.position.z;
      const distance = Math.hypot(dx, dz), step = dt * 3;
      if (distance > 0.01) caravan.mesh.rotation.y = Math.atan2(dx, dz);
      if (distance > step) {
        caravan.mesh.position.x += dx / distance * step;
        caravan.mesh.position.z += dz / distance * step;
        continue;
      }
      caravan.mesh.position.set(targetX, 0, targetZ);
      if (caravan.state === 'leaving') {
        this.port.remove(caravan.mesh);
        this.caravans.splice(i, 1);
        continue;
      }
      const sold = Math.min(caravan.amount, caravan.market.inp[caravan.item] || 0);
      if (sold > 0) {
        caravan.market.inp[caravan.item] -= sold;
        const earned = sold * (MARKET_VALUES[caravan.item] ?? 0);
        caravan.market.out.coin = (caravan.market.out.coin || 0) + earned;
        this.port.sfx('coin');
        this.port.toast(`Market exported ${sold} ${ITEMS[caravan.item].name.toLowerCase()} (+${earned} coin)`);
      }
      caravan.state = 'trading';
      caravan.wait = 2.5;
    }
  }

  private spawnCaravan(market: Building, item: ItemKey, amount: number): void {
    const center = this.port.buildingCenter(market);
    const edgeX = center.x < 0 ? -this.port.worldWidth() / 2 - 2 : this.port.worldWidth() / 2 + 2;
    const mesh = this.port.createCaravan();
    mesh.position.set(edgeX, 0, center.z);
    this.caravans.push({ mesh, market, item, amount, state: 'arriving', edgeX, edgeZ: center.z, wait: 0 });
  }
}
