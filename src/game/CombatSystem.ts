import { UNITS, type UnitKind } from '../data/units';
import { fieldPath } from '../engine/flowfield';
import { simRng } from '../engine/rng';
import type { Building, Coord, Faction, OwnerId, Unit } from '../types';
import type { World } from '../world/World';
import type { CombatTargeting } from './CombatTargeting';
import type { UnitMovement } from './UnitMovement';

const rnd = () => simRng.next();

interface CombatPorts {
  visitUnitsNear: (x: number, y: number, radius: number, visit: (unit: Unit) => void) => void;
  advanceOrder: (unit: Unit) => boolean;
  buildingCenter: (building: Building) => { x: number; z: number };
  attackUnit: (attacker: Unit, target: Unit) => void;
  attackBuilding: (attacker: Unit, target: Building) => void;
  fireArrow: (shooter: Unit, from: OwnerId, x: number, y: number, z: number, target: Unit, damage: number) => void;
  fireRock: (shooter: Unit, from: OwnerId, x: number, y: number, z: number, endX: number, endZ: number, damage: number, radius: number) => void;
  fireFlame: (shooter: Unit, from: OwnerId, x: number, y: number, z: number, endX: number, endZ: number, damage: number) => void;
  sfx: (name: string) => void;
}

/** Per-fighter combat state machine, including support, pursuit, and siege movement. */
export class CombatSystem {
  private pathBudget = 0;
  private flowBudget = 0;

  constructor(
    private readonly world: World,
    private readonly targeting: CombatTargeting,
    private readonly movement: UnitMovement,
    private readonly ports: CombatPorts,
  ) {}

  beginTick(): void {
    this.pathBudget = 28;
    this.flowBudget = 160;
  }

  update(unit: Unit, dt: number): void {
    const def = UNITS[unit.role as UnitKind];
    while (unit.order && (
      (unit.order.type === 'attack' && (!unit.order.foe || unit.order.foe.dead))
      || (unit.order.building?.removed ?? false)
    )) this.ports.advanceOrder(unit);
    if (def.heal) { this.updateSupport(unit, def.heal, dt); return; }
    const flying = !!def.flying;
    unit.atkTimer = Math.max(0, unit.atkTimer - dt);
    if (unit.lungeT > 0) unit.lungeT = Math.max(0, unit.lungeT - dt);
    if (flying) this.movement.animateFlight(unit, dt);
    if (def.fire) this.fireVolley(unit, dt);

    const leash = unit.faction === 'wild' ? def.leash
      : (unit.faction === 'enemy' && !unit.raider && unit.anchor ? (def.leash ?? 18) : undefined);
    if (leash && unit.anchor) {
      const anchorDistance = Math.hypot(unit.tx - unit.anchor.x, unit.ty - unit.anchor.y);
      if (unit.wstate === 'leash') {
        if (anchorDistance < 3) { unit.wstate = 'idle'; unit.path = null; }
        else {
          if (!unit.path) this.movement.sendTo(unit, unit.anchor.x, unit.anchor.y);
          this.movement.moveGround(unit, dt);
          unit.status = 'Heading home';
          return;
        }
      } else if (anchorDistance > leash) {
        unit.wstate = 'leash'; unit.foe = null; unit.path = null; return;
      }
    }

    if (unit.obeyT > 0) {
      unit.obeyT = Math.max(0, unit.obeyT - dt);
      if (unit.order && unit.order.type !== 'attack') { unit.foe = null; unit.foeB = null; }
    }
    const orderedBuilding = unit.order?.building && !unit.order.building.removed ? unit.order.building : null;
    let foe = unit.order?.type === 'attack' ? unit.order.foe : (orderedBuilding ? null : unit.foe);
    if (foe?.dead) foe = null;
    const canSeek = (!unit.order || unit.order.type !== 'move') && unit.obeyT <= 0;
    const aggro = unit.faction === 'wild' && !unit.raider ? Math.min(def.aggro, 4.5) : def.aggro;
    if (!foe && canSeek && !unit.foeB) foe = this.targeting.acquireUnit(unit, aggro);
    unit.foe = foe;

    if (foe) {
      const reach = unit.range + 0.1 + Math.max(0, (foe.mesh.scale.x || 1) - 1) * 0.4;
      const distance = this.unitDistance(unit, foe);
      if (unit.order?.type === 'attack' && def.standoff && distance < def.standoff) {
        this.retreatFrom(unit, foe, def.standoff, dt);
      } else if (distance <= reach) {
        unit.path = null;
        this.face(unit, foe);
        this.movement.groundPose(unit, flying);
        if (unit.atkTimer <= 0) {
          unit.atkTimer = unit.atkCd;
          if (def.splash) this.ports.fireRock(unit, unit.owner, unit.mesh.position.x, 0.6, unit.mesh.position.z, foe.mesh.position.x, foe.mesh.position.z, unit.dmg, def.splash);
          else if (def.arrows) this.ports.fireArrow(unit, unit.owner, unit.mesh.position.x, 0.6, unit.mesh.position.z, foe, unit.dmg);
          else this.ports.attackUnit(unit, foe);
        }
      } else if (flying) {
        this.movement.moveFlying(unit, dt, foe.mesh.position.x, foe.mesh.position.z);
      } else {
        if (!unit.path) {
          unit.timer -= dt;
          if (unit.timer <= 0 && this.pathBudget > 0) {
            this.pathBudget--;
            const reached = this.movement.sendTo(unit, foe.tx, foe.ty);
            unit.timer = 0.4 + rnd() * 0.35;
            if (!reached) {
              const building = this.targeting.acquireBuilding(unit);
              if (building) { unit.foe = null; unit.foeB = building; return; }
            }
          }
        }
        this.movement.moveGround(unit, def.charge ? dt * def.charge : dt);
        unit.status = 'Fighting';
      }
      return;
    }

    let building = unit.foeB && !unit.foeB.removed ? unit.foeB : orderedBuilding;
    if (building?.removed) building = null;
    if (!building && canSeek) building = this.targeting.acquireBuilding(unit);
    unit.foeB = building;
    if (building) {
      const center = this.ports.buildingCenter(building);
      const dx = center.x - unit.mesh.position.x;
      const dz = center.z - unit.mesh.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= unit.range + 1.15) {
        unit.path = null;
        unit.mesh.rotation.y = Math.atan2(dx, dz);
        this.movement.groundPose(unit, flying);
        if (unit.atkTimer <= 0) {
          unit.atkTimer = unit.atkCd; unit.lungeT = 0.22; this.ports.attackBuilding(unit, building);
        }
      } else if (flying) {
        this.movement.moveFlying(unit, dt, center.x, center.z);
      } else {
        if (!unit.path) {
          unit.timer -= dt;
          if (unit.timer <= 0) {
            const field = unit.order?.building === building ? unit.order.field : null;
            if (field) {
              if (this.flowBudget > 0) {
                this.flowBudget--;
                const path = fieldPath(this.world, field, unit.tx, unit.ty, undefined, undefined, unit.faction);
                if (path === null) { unit.order!.field = null; this.siegeBlocked(unit, building); }
                else if (path.length) { unit.path = path; unit.pathI = 0; unit.timer = 0.5 + rnd() * 0.4; }
                else unit.order!.field = null;
              }
            } else if (this.pathBudget > 0) {
              this.pathBudget--;
              const tile = this.targeting.siegeTile(unit, building);
              if (this.movement.sendTo(unit, tile.x, tile.y)) unit.timer = 0.5 + rnd() * 0.4;
              else this.siegeBlocked(unit, building);
            }
          }
        }
        this.movement.moveGround(unit, dt);
      }
      return;
    }

    if (unit.order && (unit.order.type === 'move' || unit.order.type === 'attackMove')) {
      if (flying) {
        if (this.movement.moveFlying(unit, dt, this.world.wx(unit.order.x), this.world.wz(unit.order.y))) this.ports.advanceOrder(unit);
        return;
      }
      if (!unit.path) {
        if (unit.tx === unit.order.x && unit.ty === unit.order.y) this.ports.advanceOrder(unit);
        else if (unit.order.field) {
          if (this.flowBudget > 0) {
            this.flowBudget--;
            const path = fieldPath(this.world, unit.order.field, unit.tx, unit.ty, unit.order.x, unit.order.y, unit.faction);
            if (path?.length) { unit.path = path; unit.pathI = 0; }
            else unit.order.field = null;
          }
        } else if (this.pathBudget > 0) {
          this.pathBudget--;
          if (!this.movement.sendTo(unit, unit.order.x, unit.order.y)) this.ports.advanceOrder(unit);
        }
      }
      if (unit.path) this.movement.moveGround(unit, dt); else this.movement.groundPose(unit, flying);
    } else if (def.wander) this.movement.wander(unit, dt);
    else this.movement.groundPose(unit, flying);
  }

  private updateSupport(unit: Unit, heal: { range: number; amount: number; rate: number }, dt: number): void {
    unit.atkTimer = Math.max(0, unit.atkTimer - dt);
    if (unit.atkTimer <= 0) {
      let target: Unit | null = null;
      let ratio = 1;
      this.ports.visitUnitsNear(unit.tx, unit.ty, Math.ceil(heal.range) + 1, candidate => {
        if (candidate === unit || candidate.dead || candidate.faction !== unit.faction || candidate.hp >= candidate.maxHp) return;
        const dx = candidate.tx - unit.tx, dy = candidate.ty - unit.ty;
        if (dx * dx + dy * dy > heal.range * heal.range) return;
        const candidateRatio = candidate.hp / candidate.maxHp;
        if (candidateRatio < ratio) { ratio = candidateRatio; target = candidate; }
      });
      if (target) {
        const ally = target as Unit;
        ally.hp = Math.min(ally.maxHp, ally.hp + heal.amount);
        unit.atkTimer = heal.rate;
        unit.status = `Healing ${ally.roleName}`;
      } else unit.status = 'Tending the company';
    }
    unit.foe = null; unit.foeB = null;
    const orderedFoe = unit.order?.type === 'attack' && unit.order.foe && !unit.order.foe.dead ? unit.order.foe : null;
    if (orderedFoe) {
      const standoff = UNITS[unit.role as UnitKind].standoff ?? heal.range;
      const distance = this.unitDistance(unit, orderedFoe);
      if (distance < standoff) this.retreatFrom(unit, orderedFoe, standoff, dt);
      else if (distance > standoff + 0.75) {
        if (!unit.path && this.pathBudget > 0) { this.pathBudget--; this.movement.sendTo(unit, orderedFoe.tx, orderedFoe.ty); }
        if (unit.path) this.movement.moveGround(unit, dt); else this.movement.groundPose(unit, false);
        this.face(unit, orderedFoe);
        unit.status = 'Following at a safe distance';
      } else {
        unit.path = null; this.face(unit, orderedFoe); this.movement.groundPose(unit, false); unit.status = 'Holding at a safe distance';
      }
      return;
    }
    if (unit.order) {
      if (unit.tx === unit.order.x && unit.ty === unit.order.y) this.ports.advanceOrder(unit);
      else if (!unit.path && unit.order.field) {
        if (this.flowBudget > 0) {
          this.flowBudget--;
          const path = fieldPath(this.world, unit.order.field, unit.tx, unit.ty, unit.order.x, unit.order.y, unit.faction);
          if (path?.length) { unit.path = path; unit.pathI = 0; } else unit.order.field = null;
        }
      } else if (!unit.path && this.pathBudget > 0) {
        this.pathBudget--;
        if (!this.movement.sendTo(unit, unit.order.x, unit.order.y)) this.ports.advanceOrder(unit);
      }
      if (unit.path) this.movement.moveGround(unit, dt); else this.movement.groundPose(unit, false);
    } else this.movement.groundPose(unit, false);
  }

  private retreatFrom(unit: Unit, foe: Unit, standoff: number, dt: number): void {
    const foeX = foe.mesh.position.x, foeZ = foe.mesh.position.z;
    const endpoint = unit.path?.[unit.path.length - 1];
    if (endpoint && Math.hypot(this.world.wx(endpoint.x) - foeX, this.world.wz(endpoint.y) - foeZ) < standoff) unit.path = null;
    if (!unit.path && this.pathBudget > 0) {
      let dx = unit.mesh.position.x - foeX, dz = unit.mesh.position.z - foeZ;
      let length = Math.hypot(dx, dz);
      if (length < 1e-4) {
        dx = ((unit.id + foe.id) & 1) ? 1 : -1;
        dz = ((unit.id ^ foe.id) & 1) ? 1 : -1;
        length = Math.hypot(dx, dz);
      }
      const idealX = foeX + dx / length * (standoff + 0.75);
      const idealZ = foeZ + dz / length * (standoff + 0.75);
      const baseX = Math.round(idealX + this.world.W / 2 - 0.5);
      const baseY = Math.round(idealZ + this.world.H / 2 - 0.5);
      const currentDistance = this.unitDistance(unit, foe);
      let best: Coord | null = null, bestScore = Infinity;
      for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
        const x = baseX + ox, y = baseY + oy;
        if (!this.world.passable(x, y, unit.faction)) continue;
        const worldX = this.world.wx(x), worldZ = this.world.wz(y);
        const safety = Math.hypot(worldX - foeX, worldZ - foeZ);
        if (safety <= currentDistance + 0.2) continue;
        const score = Math.hypot(worldX - idealX, worldZ - idealZ) + Math.abs(safety - standoff) * 0.15;
        if (score < bestScore) { bestScore = score; best = { x, y }; }
      }
      if (best) { this.pathBudget--; this.movement.sendTo(unit, best.x, best.y); }
    }
    if (unit.path) this.movement.moveGround(unit, dt); else this.movement.groundPose(unit, false);
    this.face(unit, foe);
    unit.status = 'Keeping distance';
  }

  private siegeBlocked(unit: Unit, target: Building): void {
    const blocker = this.targeting.acquireBuilding(unit);
    if (blocker && blocker !== target) { unit.foeB = blocker; return; }
    unit.timer = 3 + rnd() * 2;
  }

  private fireVolley(unit: Unit, dt: number): void {
    unit.special -= dt;
    if (unit.special > 0) return;
    let targetX: number | null = null, targetZ = 0;
    const foe = unit.foe && !unit.foe.dead ? unit.foe : this.targeting.acquireUnit(unit, 8);
    if (foe) { targetX = foe.mesh.position.x; targetZ = foe.mesh.position.z; }
    else {
      const building = unit.foeB && !unit.foeB.removed ? unit.foeB : null;
      if (building) {
        const center = this.ports.buildingCenter(building);
        if (Math.hypot(center.x - unit.mesh.position.x, center.z - unit.mesh.position.z) < 9) { targetX = center.x; targetZ = center.z; }
      }
    }
    if (targetX === null) { unit.special = 1; return; }
    const x = unit.mesh.position.x, z = unit.mesh.position.z, y = 1.6 * (unit.mesh.scale.y || 1);
    for (let i = 0; i < 5; i++) {
      const angle = rnd() * Math.PI * 2, radius = rnd() * 1.3;
      this.ports.fireFlame(unit, unit.owner, x, y, z, targetX + Math.cos(angle) * radius, targetZ + Math.sin(angle) * radius, 12);
    }
    this.ports.sfx('error');
    unit.special = 5;
  }

  private unitDistance(left: Unit, right: Unit): number {
    return Math.hypot(left.mesh.position.x - right.mesh.position.x, left.mesh.position.z - right.mesh.position.z);
  }

  private face(unit: Unit, foe: Unit): void {
    const dx = foe.mesh.position.x - unit.mesh.position.x, dz = foe.mesh.position.z - unit.mesh.position.z;
    if (dx || dz) unit.mesh.rotation.y = Math.atan2(dx, dz);
  }
}
