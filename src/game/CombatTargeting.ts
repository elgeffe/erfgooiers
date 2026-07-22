import type { Building, Coord, OwnerId, Unit } from '../types';
import type { World } from '../world/World';
import { buildingFootprint, buildingFootprintCenter } from '../engine/buildingFootprint';
import { doorTile } from './util';

interface CombatTargetingPorts {
  buildings: () => readonly Building[];
  visitUnitsNear: (x: number, y: number, radius: number, visit: (unit: Unit) => void) => void;
  hostile: (left: OwnerId, right: OwnerId) => boolean;
  buildingCenter: (building: Building) => { x: number; z: number };
}

/** Deterministic target acquisition and siege approach selection. */
export class CombatTargeting {
  constructor(
    private readonly world: World,
    private readonly ports: CombatTargetingPorts,
  ) {}

  acquireUnit(unit: Unit, aggro: number): Unit | null {
    let best: Unit | null = null;
    let bestDistance = aggro * aggro;
    this.ports.visitUnitsNear(unit.tx, unit.ty, Math.ceil(aggro) + 1, candidate => {
      if (candidate.dead || candidate === unit || !this.ports.hostile(unit.owner, candidate.owner)) return;
      const dx = candidate.tx - unit.tx;
      const dy = candidate.ty - unit.ty;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    });
    return best;
  }

  acquireBuilding(unit: Unit): Building | null {
    if (unit.faction !== 'player' && !unit.raider) return null;
    const range = unit.faction === 'player' ? 18 : 1e9;
    let best: Building | null = null;
    let bestDistance = range * range;
    for (const building of this.ports.buildings()) {
      if (building.removed || !this.ports.hostile(unit.owner, building.owner)) continue;
      const center = this.ports.buildingCenter(building);
      const dx = center.x - unit.mesh.position.x;
      const dz = center.z - unit.mesh.position.z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = building;
      }
    }
    return best;
  }

  siegeTile(unit: Unit, building: Building): Coord {
    let best: Coord | null = null;
    let bestDistance = 1e9;
    const size = buildingFootprint(building.def, building.rot);
    const center = buildingFootprintCenter(building);
    const unitSideDistance = building.def.bulwark
      ? Math.hypot(center.x - unit.tx, center.y - unit.ty)
      : Infinity;
    for (let y = building.y - 1; y <= building.y + size.height; y++) {
      for (let x = building.x - 1; x <= building.x + size.width; x++) {
        if (x >= building.x && x < building.x + size.width && y >= building.y && y < building.y + size.height) continue;
        if (!this.world.passable(x, y)) continue;
        if (Math.hypot(x - unit.tx, y - unit.ty) > unitSideDistance) continue;
        const salt = ((x * 31 + y * 17 + unit.tx * 7 + unit.ty * 3) % 5) * 0.8;
        const distance = Math.hypot(x - unit.tx, y - unit.ty) + salt;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }
    return best ?? doorTile(building);
  }
}
