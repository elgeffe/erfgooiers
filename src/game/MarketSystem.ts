import type * as THREE from 'three';
import { ITEMS, MARKET_VALUES } from '../data/items';
import type { Building, ItemKey, OwnerId } from '../types';

export const MAX_MARKET_ORDERS = 3;
/** Seconds between scheduled trader visits. */
export const MARKET_VISIT_INTERVAL = 180;

interface MarketCaravan {
  mesh: THREE.Group;
  market: Building;
  state: 'arriving' | 'trading' | 'leaving';
  /** World-space waypoints from off-map to the halt outside the market.
   *  Followed forward when arriving, backward when leaving. */
  route: { x: number; z: number }[];
  routeI: number;
  wait: number;
  loaded: boolean; // has it taken on cargo at the market yet?
}

export interface MarketPort {
  buildings(): readonly Building[];
  worldWidth(): number;
  buildingCenter(building: Building): { x: number; z: number };
  /** A walkable route from the map edge to just outside the market's door
   *  (world coords), or null when the market is sealed in — the caravan then
   *  rolls the old straight line rather than not coming at all. */
  caravanRoute(building: Building): { x: number; z: number }[] | null;
  createCaravan(): THREE.Group;
  remove(mesh: THREE.Object3D): void;
  sfx(name: string): void;
  toast(message: string, owner?: OwnerId): void;
  /** Pay the market's proceeds straight into the owner's global coin stock. */
  depositCoin(building: Building, amount: number): void;
}

/** Neutral export caravans and the physical market inventory they consume. A
 *  market can export up to three goods at once; the caravan follows the road
 *  network (well, walkable ground) in from the map edge, halts outside the
 *  building, loads whatever is ready, and the coin lands directly in the
 *  owner's global stock — no serf pickup. */
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

  /** Coin one full caravan visit earns at current orders. */
  incomePerVisit(building: Building): number {
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
      building.marketTimer = Math.max(0, (building.marketTimer ?? MARKET_VISIT_INTERVAL) - dt);
      if (building.marketTimer > 0 || this.caravansInTransit(building)) continue;
      if (!(building.marketOrders?.length)) { building.marketTimer = MARKET_VISIT_INTERVAL; continue; }
      // wait for something to sell; re-check soon rather than idling a full cycle
      if (this.readyTotal(building) <= 0) { building.marketTimer = 5; continue; }
      building.marketTimer = MARKET_VISIT_INTERVAL;
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
        if (caravan.wait <= 0) { caravan.state = 'leaving'; caravan.routeI = caravan.route.length - 2; }
        continue;
      }
      // follow the route: forward while arriving, backward while leaving
      const leaving = caravan.state === 'leaving';
      let step = dt * 3;
      while (step > 0) {
        const target = caravan.route[caravan.routeI];
        if (!target) break;
        const dx = target.x - caravan.mesh.position.x, dz = target.z - caravan.mesh.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance > 0.02) caravan.mesh.rotation.y = Math.atan2(dx, dz);
        if (distance > step) {
          caravan.mesh.position.x += dx / distance * step;
          caravan.mesh.position.z += dz / distance * step;
          step = 0;
          break;
        }
        caravan.mesh.position.set(target.x, 0, target.z);
        step -= distance;
        caravan.routeI += leaving ? -1 : 1;
        if (leaving && caravan.routeI < 0) break;
        if (!leaving && caravan.routeI >= caravan.route.length) break;
      }
      if (leaving && caravan.routeI < 0) {
        this.port.remove(caravan.mesh);
        this.caravans.splice(i, 1);
        continue;
      }
      if (!leaving && caravan.routeI >= caravan.route.length) {
        // halted outside the market: load every ordered good, then trade
        if (!caravan.loaded) this.loadCaravan(caravan);
        caravan.state = 'trading';
        caravan.wait = 2.5;
      }
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
    // walk the real ground route in from the edge (no more driving through
    // buildings); a sealed-in market falls back to the old straight line
    let route = this.port.caravanRoute(market);
    if (!route || route.length < 2) {
      const edgeX = center.x < 0 ? -this.port.worldWidth() / 2 - 2 : this.port.worldWidth() / 2 + 2;
      const parkX = center.x + Math.sign(edgeX - center.x || 1) * 1.6;
      route = [{ x: edgeX, z: center.z }, { x: parkX, z: center.z }];
    }
    const mesh = this.port.createCaravan();
    mesh.position.set(route[0].x, 0, route[0].z);
    const cargo = mesh.getObjectByName('cargo');
    if (cargo) cargo.visible = false;
    this.caravans.push({ mesh, market, state: 'arriving', route, routeI: 1, wait: 0, loaded: false });
  }
}
