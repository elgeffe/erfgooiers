import type * as THREE from 'three';
import { ITEMS, MARKET_VALUES } from '../data/items';
import type { Building, ItemKey, OwnerId } from '../types';

export const MAX_MARKET_ORDERS = 3;

interface MarketCaravan {
  mesh: THREE.Group;
  market: Building;
  state: 'arriving' | 'trading' | 'leaving';
  edgeX: number;
  edgeZ: number;
  parkX: number;   // where it halts, just outside the market footprint
  parkZ: number;
  wait: number;
  loaded: boolean; // has it taken on cargo at the market yet?
}

export interface MarketPort {
  buildings(): readonly Building[];
  worldWidth(): number;
  buildingCenter(building: Building): { x: number; z: number };
  createCaravan(): THREE.Group;
  remove(mesh: THREE.Object3D): void;
  sfx(name: string): void;
  toast(message: string, owner?: OwnerId): void;
  /** Pay the market's proceeds straight into the owner's global coin stock. */
  depositCoin(building: Building, amount: number): void;
}

/** Neutral export caravans and the physical market inventory they consume. A
 *  market can export up to three goods at once; the caravan halts just outside
 *  the building, loads whatever is ready (rolling in empty, leaving laden), and
 *  the coin lands directly in the owner's global stock — no serf pickup. */
export class MarketSystem {
  private readonly caravans: MarketCaravan[] = [];

  constructor(private readonly port: MarketPort) {}

  /** Replace a market's export list (deduped, valid goods only, capped at 3). */
  configure(building: Building, orders: { item: ItemKey; amount: number }[]): void {
    if (building.key !== 'market' || building.faction !== 'player' || building.removed) return;
    const seen = new Set<ItemKey>();
    const clean: { item: ItemKey; amount: number }[] = [];
    for (const o of orders) {
      if (MARKET_VALUES[o.item] === undefined || seen.has(o.item)) continue;
      const amount = Math.max(0, Math.min(50, Number.isFinite(o.amount) ? Math.round(o.amount) : 0));
      if (amount <= 0) continue;
      seen.add(o.item);
      clean.push({ item: o.item, amount });
      if (clean.length >= MAX_MARKET_ORDERS) break;
    }
    building.marketOrders = clean;
  }

  incomePerMinute(building: Building): number {
    return (building.marketOrders ?? []).reduce((sum, o) => sum + (MARKET_VALUES[o.item] ?? 0) * o.amount, 0);
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

  /** Goods currently sitting in the market that its export orders can sell. */
  private readyTotal(building: Building): number {
    return (building.marketOrders ?? []).reduce((sum, o) => sum + Math.min(o.amount, building.inp[o.item] || 0), 0);
  }

  update(dt: number): void {
    for (const building of this.port.buildings()) {
      if (building.key !== 'market' || building.faction !== 'player' || !building.active || building.removed) continue;
      building.marketTimer = Math.max(0, (building.marketTimer ?? 60) - dt);
      if (building.marketTimer > 0 || this.caravansInTransit(building)) continue;
      if (!(building.marketOrders?.length)) { building.marketTimer = 60; continue; }
      // wait for something to sell; re-check soon rather than idling a full minute
      if (this.readyTotal(building) <= 0) { building.marketTimer = 5; continue; }
      building.marketTimer = 60;
      this.spawnCaravan(building);
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
      const targetX = caravan.state === 'arriving' ? caravan.parkX : caravan.edgeX;
      const targetZ = caravan.state === 'arriving' ? caravan.parkZ : caravan.edgeZ;
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
      // arrived at the parking spot outside the market: load every ordered good
      if (!caravan.loaded) this.loadCaravan(caravan);
      caravan.state = 'trading';
      caravan.wait = 2.5;
    }
  }

  /** Take on cargo at the market: deduct each order's goods, pay the coin
   *  straight into the owner's stock, and reveal the laden crates. */
  private loadCaravan(caravan: MarketCaravan): void {
    const market = caravan.market;
    let earned = 0;
    const parts: string[] = [];
    for (const order of market.marketOrders ?? []) {
      const sold = Math.min(order.amount, market.inp[order.item] || 0);
      if (sold <= 0) continue;
      market.inp[order.item] -= sold;
      earned += sold * (MARKET_VALUES[order.item] ?? 0);
      parts.push(`${sold} ${ITEMS[order.item].name.toLowerCase()}`);
    }
    caravan.loaded = true;
    if (earned > 0) {
      const cargo = caravan.mesh.getObjectByName('cargo');
      if (cargo) cargo.visible = true; // rolled in empty, leaves laden
      this.port.depositCoin(market, earned);
      this.port.sfx('coin');
      this.port.toast(`Market sold ${parts.join(', ')} (+${earned} coin)`, market.owner);
    }
  }

  private spawnCaravan(market: Building): void {
    const center = this.port.buildingCenter(market);
    const edgeX = center.x < 0 ? -this.port.worldWidth() / 2 - 2 : this.port.worldWidth() / 2 + 2;
    // halt ~1.6 tiles from the market centre on the approach side, so the
    // trader sits just outside the building rather than driving into its mesh
    const parkX = center.x + Math.sign(edgeX - center.x || 1) * 1.6;
    const mesh = this.port.createCaravan();
    mesh.position.set(edgeX, 0, center.z);
    const cargo = mesh.getObjectByName('cargo');
    if (cargo) cargo.visible = false;
    this.caravans.push({ mesh, market, state: 'arriving', edgeX, edgeZ: center.z, parkX, parkZ: center.z, wait: 0, loaded: false });
  }
}
