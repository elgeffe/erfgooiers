import type * as THREE from 'three';
import type { Building, Faction, OwnerId, Unit } from '../types';
import { factionForOwner } from './ownership';

interface Projectile {
  mesh: THREE.Object3D;
  sx: number; sy: number; sz: number;
  ex: number; ey: number; ez: number;
  t: number; dur: number; arc: number;
  from: OwnerId; shooter: Unit | null; target: Unit | null;
  dmg: number; kind: 'arrow' | 'fire' | 'rock'; radius?: number;
}

/** Combat and view operations required when a projectile lands. */
export interface ProjectilePort {
  worldSize(): { width: number; height: number };
  buildings(): readonly Building[];
  createArrow(): THREE.Object3D;
  createRock(): THREE.Object3D;
  createFireball(): THREE.Object3D;
  createFlame(): THREE.Object3D;
  createHealGlow(): THREE.Object3D;
  remove(mesh: THREE.Object3D): void;
  sfx(name: string): void;
  forUnitsNear(x: number, y: number, radius: number, visit: (unit: Unit) => void): void;
  hostile(from: OwnerId, to: OwnerId): boolean;
  hurtUnit(shooter: Unit | null, target: Unit, damage: number): void;
  buildingCenter(building: Building): { x: number; z: number };
  hurtBuilding(building: Building, damage: number, x: number, z: number): void;
  onHurt(x: number, z: number, faction: Faction): void;
}

/** Fixed-step projectile flight, impact resolution, and transient flames. */
export class ProjectileSystem {
  private readonly projectiles: Projectile[] = [];
  private readonly flames: { mesh: THREE.Object3D; life: number; max: number }[] = [];
  private readonly healGlows: { mesh: THREE.Object3D; life: number; max: number; baseY: number }[] = [];

  constructor(private readonly port: ProjectilePort) {}

  /** A green healing mote that rises off a mended unit and fades. */
  healGlow(x: number, z: number): void {
    const mesh = this.port.createHealGlow();
    const baseY = 0.9;
    mesh.position.set(x, baseY, z);
    this.healGlows.push({ mesh, life: 1, max: 1, baseY });
  }

  fireArrow(shooter: Unit | null, from: OwnerId, x: number, y: number, z: number, target: Unit, damage: number): void {
    const tx = target.mesh.position.x, tz = target.mesh.position.z;
    const distance = Math.hypot(tx - x, tz - z);
    const mesh = this.port.createArrow();
    mesh.position.set(x, y, z);
    this.port.sfx('arrow');
    this.projectiles.push({
      mesh, sx: x, sy: y, sz: z, ex: tx, ey: 0.35, ez: tz,
      t: 0, dur: Math.max(0.16, distance / 11), arc: Math.min(1.3, 0.15 + distance * 0.08),
      from, shooter, target, dmg: damage, kind: 'arrow',
    });
  }

  fireRock(shooter: Unit | null, from: OwnerId, x: number, y: number, z: number, ex: number, ez: number, damage: number, radius: number): void {
    const distance = Math.hypot(ex - x, ez - z);
    const mesh = this.port.createRock();
    mesh.position.set(x, y, z);
    this.port.sfx('arrow');
    this.projectiles.push({
      mesh, sx: x, sy: y, sz: z, ex, ey: 0.1, ez,
      t: 0, dur: Math.max(0.3, distance / 9), arc: Math.min(2.2, 0.6 + distance * 0.12),
      from, shooter, target: null, dmg: damage, kind: 'rock', radius,
    });
  }

  fireFlame(shooter: Unit | null, from: OwnerId, x: number, y: number, z: number, ex: number, ez: number, damage: number): void {
    const distance = Math.hypot(ex - x, ez - z);
    const mesh = this.port.createFireball();
    mesh.position.set(x, y, z);
    this.projectiles.push({
      mesh, sx: x, sy: y, sz: z, ex, ey: 0.1, ez,
      t: 0, dur: Math.max(0.25, distance / 8), arc: 0.5,
      from, shooter, target: null, dmg: damage, kind: 'fire',
    });
  }

  update(dt: number): void {
    this.updateProjectiles(dt);
    this.updateFlames(dt);
    this.updateHealGlows(dt);
  }

  private updateHealGlows(dt: number): void {
    for (let i = this.healGlows.length - 1; i >= 0; i--) {
      const glow = this.healGlows[i];
      glow.life -= dt;
      if (glow.life <= 0) {
        this.port.remove(glow.mesh);
        this.healGlows.splice(i, 1);
        continue;
      }
      const remaining = glow.life / glow.max;
      const t = 1 - remaining;
      glow.mesh.position.y = glow.baseY + t * 0.9;
      // A quick pop-in, then a gentle grow as it fades.
      glow.mesh.scale.setScalar(0.6 + Math.min(1, t * 5) * 0.5 + t * 0.35);
      glow.mesh.traverse((object: any) => {
        if (object.material && object.material.transparent) {
          object.material.opacity = (object.userData.baseOpacity ??= object.material.opacity) * remaining;
        }
      });
    }
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      if (projectile.target && !projectile.target.dead) {
        projectile.ex = projectile.target.mesh.position.x;
        projectile.ez = projectile.target.mesh.position.z;
      }
      projectile.t += dt;
      const progress = Math.min(1, projectile.t / projectile.dur);
      const x = projectile.sx + (projectile.ex - projectile.sx) * progress;
      const z = projectile.sz + (projectile.ez - projectile.sz) * progress;
      const y = projectile.sy + (projectile.ey - projectile.sy) * progress + Math.sin(progress * Math.PI) * projectile.arc;
      const dx = x - projectile.mesh.position.x, dy = y - projectile.mesh.position.y, dz = z - projectile.mesh.position.z;
      if (dx || dz) {
        projectile.mesh.rotation.y = Math.atan2(dx, dz);
        projectile.mesh.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz));
      }
      projectile.mesh.position.set(x, y, z);
      if (progress < 1) continue;
      this.port.remove(projectile.mesh);
      this.projectiles.splice(i, 1);
      this.impact(projectile);
    }
  }

  private impact(projectile: Projectile): void {
    const { width, height } = this.port.worldSize();
    const tileX = Math.max(0, Math.min(width - 1, Math.round(projectile.ex + width / 2 - 0.5)));
    const tileY = Math.max(0, Math.min(height - 1, Math.round(projectile.ez + height / 2 - 0.5)));
    if (projectile.kind === 'rock') {
      const radius = projectile.radius ?? 1.6, radius2 = radius * radius, cells = Math.ceil(radius) + 2;
      this.port.forUnitsNear(tileX, tileY, cells, unit => {
        if (unit.dead || !this.port.hostile(projectile.from, unit.owner)) return;
        const dx = unit.mesh.position.x - projectile.ex, dz = unit.mesh.position.z - projectile.ez;
        if (dx * dx + dz * dz <= radius2) this.port.hurtUnit(projectile.shooter, unit, projectile.dmg);
      });
      for (const building of this.port.buildings()) {
        if (building.removed || !this.port.hostile(projectile.from, building.owner)) continue;
        const center = this.port.buildingCenter(building);
        const dx = center.x - projectile.ex, dz = center.z - projectile.ez;
        if (dx * dx + dz * dz <= (radius + 0.4) * (radius + 0.4)) {
          this.port.hurtBuilding(building, projectile.dmg, center.x, center.z);
        }
      }
      this.port.onHurt(projectile.ex, projectile.ez, factionForOwner(projectile.from) === 'player' ? 'enemy' : 'player');
      return;
    }
    if (projectile.kind === 'fire') {
      this.port.forUnitsNear(tileX, tileY, 4, unit => {
        if (unit.dead || !this.port.hostile(projectile.from, unit.owner)) return;
        const dx = unit.mesh.position.x - projectile.ex, dz = unit.mesh.position.z - projectile.ez;
        if (dx * dx + dz * dz <= 1.3 * 1.3) this.port.hurtUnit(projectile.shooter, unit, projectile.dmg);
      });
      for (const building of this.port.buildings()) {
        if (building.removed || !this.port.hostile(projectile.from, building.owner)) continue;
        const center = this.port.buildingCenter(building);
        const dx = center.x - projectile.ex, dz = center.z - projectile.ez;
        if (dx * dx + dz * dz <= 1.7 * 1.7) this.port.hurtBuilding(building, projectile.dmg, center.x, center.z);
      }
      const mesh = this.port.createFlame();
      mesh.position.set(projectile.ex, 0, projectile.ez);
      this.flames.push({ mesh, life: 1.1, max: 1.1 });
      return;
    }
    if (projectile.target && !projectile.target.dead
      && Math.hypot(projectile.target.mesh.position.x - projectile.ex, projectile.target.mesh.position.z - projectile.ez) < 0.7) {
      this.port.hurtUnit(projectile.shooter, projectile.target, projectile.dmg);
      return;
    }
    let best: Unit | null = null, bestDistance = 0.6 * 0.6;
    this.port.forUnitsNear(tileX, tileY, 3, unit => {
      if (unit.dead || !this.port.hostile(projectile.from, unit.owner)) return;
      const dx = unit.mesh.position.x - projectile.ex, dz = unit.mesh.position.z - projectile.ez, distance = dx * dx + dz * dz;
      if (distance < bestDistance) { bestDistance = distance; best = unit; }
    });
    if (best) this.port.hurtUnit(projectile.shooter, best as Unit, projectile.dmg);
  }

  private updateFlames(dt: number): void {
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const flame = this.flames[i];
      flame.life -= dt;
      if (flame.life <= 0) {
        this.port.remove(flame.mesh);
        this.flames.splice(i, 1);
        continue;
      }
      const remaining = flame.life / flame.max;
      flame.mesh.scale.setScalar(0.6 + 0.7 * Math.sin(Math.min(1, (1 - remaining) * 3) * Math.PI * 0.5));
      flame.mesh.traverse((object: any) => {
        if (object.material && object.material.transparent) object.material.opacity = 0.9 * remaining;
      });
    }
  }
}
