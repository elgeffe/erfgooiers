import type { View } from '../render/View';
import type { Building, Coord, PlayerId, Site, Unit } from '../types';
import type { World } from '../world/World';
import type { Modifiers } from './Modifiers';
import { buildingEntranceTiles } from './util';

interface InteractionPorts {
  visitUnitsNear: (x: number, y: number, radius: number, visit: (unit: Unit) => void) => void;
  select: (value: unknown) => void;
  onCollect: () => void;
  onGold: (amount: number) => void;
  toast: (message: string) => void;
  sfx: (name: string) => void;
}

/** Click selection and physical map-pickup collection. */
export class InteractionSystem {
  private readonly pickups: Coord[] = [];
  private pickupHintT = 0;
  private pickupScanT = 0;

  constructor(
    private readonly world: World,
    private readonly view: View,
    private readonly mods: Modifiers,
    private readonly buildings: readonly Building[],
    private readonly sites: readonly Site[],
    private readonly units: readonly Unit[],
    private readonly localPlayerId: PlayerId,
    private readonly ports: InteractionPorts,
  ) {}

  indexPickups(): void {
    if (this.pickups.length) return;
    for (let y = 0; y < this.world.H; y++) for (let x = 0; x < this.world.W; x++)
      if (this.world.tiles[y][x].pickup) this.pickups.push({ x, y });
  }

  pickUnit(worldX: number, worldZ: number, radius = 0.6): Unit | null {
    let best: Unit | null = null;
    let bestDistance = radius * radius;
    for (const unit of this.units) {
      if (!unit.mesh.visible) continue;
      const dx = unit.mesh.position.x - worldX, dz = unit.mesh.position.z - worldZ;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) { bestDistance = distance; best = unit; }
    }
    return best;
  }

  entranceTiles(): Coord[] {
    const result: Coord[] = [];
    for (const building of this.buildings) result.push(...buildingEntranceTiles(building));
    for (const site of this.sites) result.push(...buildingEntranceTiles(site));
    return result;
  }

  selectAt(tx: number, ty: number): void {
    const tile = this.world.tiles[ty][tx];
    if (tile.pickup) {
      const now = Date.now();
      if (now - this.pickupHintT > 2500) {
        this.pickupHintT = now;
        this.ports.toast('Send a unit (or your hero) to the gold pile to collect it');
      }
      return;
    }
    this.ports.select(tile.b ?? tile.site ?? null);
  }

  collectGoldAt(tx: number, ty: number, owner: PlayerId, collector?: Unit): void {
    const tile = this.world.T(tx, ty);
    if (!tile?.pickup) return;
    const gain = Math.max(1, Math.round(tile.pickup.gold * this.mods.goldMult()));
    this.view.removeMeshes(tile.pickup.meshes);
    tile.pickup = null;
    const index = this.pickups.findIndex(pickup => pickup.x === tx && pickup.y === ty);
    if (index >= 0) this.pickups.splice(index, 1);
    this.ports.onCollect();
    if (owner !== this.localPlayerId) return;
    this.ports.onGold(gain);
    this.ports.sfx('coin');
    this.ports.toast(`${collector ? collector.roleName : 'A unit'} collected a gold pile (+${gain} gold)`);
  }

  update(dt: number): void {
    this.pickupScanT += dt;
    if (this.pickupScanT <= 0.3 || !this.pickups.length) return;
    this.pickupScanT = 0;
    for (let index = this.pickups.length - 1; index >= 0; index--) {
      const pickup = this.pickups[index];
      let taker: Unit | null = null;
      this.ports.visitUnitsNear(pickup.x, pickup.y, 2, unit => {
        if (taker || unit.dead || unit.faction !== 'player') return;
        const dx = unit.mesh.position.x - this.world.wx(pickup.x);
        const dz = unit.mesh.position.z - this.world.wz(pickup.y);
        if (dx * dx + dz * dz <= 1.1 * 1.1) taker = unit;
      });
      const collector = taker as Unit | null;
      if (collector) this.collectGoldAt(pickup.x, pickup.y, collector.owner === 'p2' ? 'p2' : 'p1', collector);
    }
  }
}
