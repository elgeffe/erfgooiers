import * as THREE from 'three';
import { ITEMS } from '../data/items';
import { findPath } from '../engine/pathfinding';
import type { Unit } from '../types';
import type { World } from '../world/World';
import type { Modifiers } from './Modifiers';

/** Path assignment and per-tick movement for ground and flying units. */
export class UnitMovement {
  constructor(
    private readonly world: World,
    private readonly mods: Modifiers,
  ) {}

  setCarrying(unit: Unit, item: string | null): void {
    unit.carrying = item;
    unit.itemMesh.visible = !!item;
    if (item) (unit.itemMesh.material as THREE.MeshLambertMaterial).color.setHex(ITEMS[item as keyof typeof ITEMS].hex);
  }

  sendTo(unit: Unit, x: number, y: number): boolean {
    const path = findPath(this.world, unit.tx, unit.ty, x, y, unit.faction);
    if (path === null) {
      unit.path = null;
      return false;
    }
    unit.path = path;
    unit.pathI = 0;
    return true;
  }

  moveGround(unit: Unit, dt: number): boolean {
    if (!unit.path || unit.pathI >= unit.path.length) {
      unit.path = null;
      return true;
    }
    const node = unit.path[unit.pathI];
    const targetX = this.world.wx(node.x);
    const targetZ = this.world.wz(node.y);
    const position = unit.mesh.position;
    const tile = this.world.T(unit.tx, unit.ty);
    const offRoad = unit.faction === 'player' ? this.mods.offRoadMult() : 1;
    const speed = this.mods.unitSpeed(unit) * (tile?.road ? 1.3 : offRoad);
    const dx = targetX - position.x;
    const dz = targetZ - position.z;
    const distance = Math.hypot(dx, dz);
    const step = speed * dt;
    if (distance <= step) {
      position.x = targetX;
      position.z = targetZ;
      unit.tx = node.x;
      unit.ty = node.y;
      unit.pathI++;
      if (unit.pathI >= unit.path.length) {
        unit.path = null;
        return true;
      }
    } else {
      const amount = step / distance;
      position.x += dx * amount;
      position.z += dz * amount;
      unit.mesh.rotation.y = Math.atan2(dx, dz);
      unit.bob += dt * 10;
      unit.mesh.position.y = Math.abs(Math.sin(unit.bob)) * 0.045;
      this.syncTile(unit);
    }
    return false;
  }

  moveFlying(unit: Unit, dt: number, worldX: number, worldZ: number): boolean {
    const position = unit.mesh.position;
    const dx = worldX - position.x;
    const dz = worldZ - position.z;
    const distance = Math.hypot(dx, dz);
    const step = this.mods.unitSpeed(unit) * dt;
    if (distance > 0.01) unit.mesh.rotation.y = Math.atan2(dx, dz);
    if (distance <= step) {
      position.x = worldX;
      position.z = worldZ;
    } else {
      position.x += dx / distance * step;
      position.z += dz / distance * step;
    }
    this.syncTile(unit);
    return distance <= step;
  }

  animateFlight(unit: Unit, dt: number): void {
    unit.bob += dt * 5;
    unit.mesh.position.y = 0.45 + Math.sin(unit.bob * 0.8) * 0.12;
    const wings = unit.mesh.userData.wings as THREE.Object3D[] | undefined;
    if (wings) {
      for (const wing of wings) {
        wing.rotation.x = (wing.userData.flapBase as number)
          + (wing.userData.flapSign as number) * Math.sin(unit.bob) * 0.4;
      }
    }
  }

  private syncTile(unit: Unit): void {
    unit.tx = Math.max(0, Math.min(this.world.W - 1, Math.round(unit.mesh.position.x + this.world.W / 2 - 0.5)));
    unit.ty = Math.max(0, Math.min(this.world.H - 1, Math.round(unit.mesh.position.z + this.world.H / 2 - 0.5)));
  }
}
