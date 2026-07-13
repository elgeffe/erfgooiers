import type { Unit } from '../types';
import type { World } from '../world/World';

/** Coarse 8x8-tile index rebuilt once per fixed tick and shared by combat,
 * towers, pickups, and projectile splash queries. */
export class UnitSpatialIndex {
  private columns = 0;
  private readonly cells = new Map<number, Unit[]>();

  constructor(private readonly world: World, private readonly units: readonly Unit[]) {}

  rebuild(): void {
    this.cells.clear();
    this.columns = (this.world.W >> 3) + 2;
    for (const unit of this.units) {
      if (unit.dead) continue;
      const key = (unit.ty >> 3) * this.columns + (unit.tx >> 3);
      let cell = this.cells.get(key);
      if (!cell) { cell = []; this.cells.set(key, cell); }
      cell.push(unit);
    }
  }

  visitNear(tileX: number, tileY: number, radius: number, visit: (unit: Unit) => void): void {
    const firstColumn = Math.max(0, tileX - radius) >> 3;
    const lastColumn = Math.max(0, tileX + radius) >> 3;
    const firstRow = Math.max(0, tileY - radius) >> 3;
    const lastRow = Math.max(0, tileY + radius) >> 3;
    for (let row = firstRow; row <= lastRow; row++) for (let column = firstColumn; column <= lastColumn; column++) {
      const cell = this.cells.get(row * this.columns + column);
      if (!cell) continue;
      for (const unit of cell) visit(unit);
    }
  }
}
