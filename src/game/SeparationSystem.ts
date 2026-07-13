import { UNITS } from '../data/units';
import type { Unit } from '../types';
import type { World } from '../world/World';

/** Deterministic soft collision for workers, fighters, and moving formations. */
export class SeparationSystem {
  constructor(private readonly world: World, private readonly units: readonly Unit[]) {}

  update(dt: number): void {
    const width = this.world.W;
    const cells = new Map<number, Unit[]>();
    const list: Unit[] = [];
    for (const unit of this.units) {
      if (unit.dead || !unit.mesh.visible) continue;
      unit.sepI = list.length;
      list.push(unit);
      const key = unit.ty * width + unit.tx;
      let cell = cells.get(key);
      if (!cell) { cell = []; cells.set(key, cell); }
      cell.push(unit);
    }
    const push = Math.min(1, dt * 6);
    for (const unit of list) {
      if (unit.wstate === 'gather' || unit.wstate === 'build') continue;
      if ((UNITS as Partial<Record<string, { flying?: boolean }>>)[unit.role]?.flying) continue;
      const radius = 0.3 * (unit.mesh.scale.x || 1);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cell = cells.get((unit.ty + oy) * width + (unit.tx + ox));
        if (!cell) continue;
        for (const other of cell) {
          if (other.sepI <= unit.sepI) continue;
          if (unit.role === 'serf' && (other.role === 'serf' || other.role === 'laborer')) continue;
          if (other.role === 'serf' && unit.role === 'laborer') continue;
          const dx = other.mesh.position.x - unit.mesh.position.x;
          const dz = other.mesh.position.z - unit.mesh.position.z;
          const combinedRadius = radius + 0.3 * (other.mesh.scale.x || 1);
          const distance2 = dx * dx + dz * dz;
          if (distance2 >= combinedRadius * combinedRadius) continue;
          let nx: number, nz: number;
          const distance = Math.sqrt(distance2);
          if (distance < 1e-4) {
            const axisX = ((unit.tx + other.ty) % 2) * 2 - 1;
            const axisZ = ((unit.ty + other.tx) % 2) * 2 - 1;
            const length = Math.hypot(axisX, axisZ);
            nx = axisX / length;
            nz = axisZ / length;
          } else {
            nx = dx / distance;
            nz = dz / distance;
          }
          const overlap = (combinedRadius - distance) * 0.5 * push;
          const allied = unit.faction === other.faction;
          const unitMarching = allied && this.isFormationMarching(unit);
          const otherMarching = allied && this.isFormationMarching(other);
          if (unitMarching || otherMarching) {
            if (unitMarching) this.nudgeMarching(unit, -nx * overlap * (otherMarching ? 1 : 2), -nz * overlap * (otherMarching ? 1 : 2));
            if (otherMarching) this.nudgeMarching(other, nx * overlap * (unitMarching ? 1 : 2), nz * overlap * (unitMarching ? 1 : 2));
          } else {
            this.nudge(unit, -nx * overlap, -nz * overlap);
            this.nudge(other, nx * overlap, nz * overlap);
          }
        }
      }
    }
  }

  private isFormationMarching(unit: Unit): boolean {
    return unit.faction === 'player' && !!unit.path && !!unit.order
      && (unit.order.type === 'move' || unit.order.type === 'attackMove');
  }

  private nudgeMarching(unit: Unit, dx: number, dz: number): void {
    const node = unit.path?.[unit.pathI];
    if (!node) { this.nudge(unit, dx, dz); return; }
    const pathX = this.world.wx(node.x) - unit.mesh.position.x;
    const pathZ = this.world.wz(node.y) - unit.mesh.position.z;
    const length2 = pathX * pathX + pathZ * pathZ;
    if (length2 > 1e-8) {
      const backwards = (dx * pathX + dz * pathZ) / length2;
      if (backwards < 0) { dx -= backwards * pathX; dz -= backwards * pathZ; }
    }
    this.nudge(unit, dx, dz);
  }

  private nudge(unit: Unit, dx: number, dz: number): void {
    const width = this.world.W, height = this.world.H;
    const radius = 0.3 * (unit.mesh.scale.x || 1);
    const x = Math.max(-width / 2 + radius, Math.min(width / 2 - radius, unit.mesh.position.x + dx));
    const z = Math.max(-height / 2 + radius, Math.min(height / 2 - radius, unit.mesh.position.z + dz));
    const tileX = Math.max(0, Math.min(width - 1, Math.round(x + width / 2 - 0.5)));
    const tileY = Math.max(0, Math.min(height - 1, Math.round(z + height / 2 - 0.5)));
    const tile = this.world.tiles[tileY][tileX];
    if (tile.type !== 'grass' || tile.b || tile.site || tile.dep) return;
    unit.mesh.position.x = x;
    unit.mesh.position.z = z;
    unit.tx = tileX;
    unit.ty = tileY;
  }
}
