import { UNITS, damageMultiplier, structureDamage, type UnitKind } from '../data/units';
import { simRng } from '../engine/rng';
import type { Building, Faction, OwnerId, PlayerId, Unit } from '../types';

const random = () => simRng.next();

export interface DamagePort {
  units(): readonly Unit[];
  playerStore(owner: PlayerId): Building | null;
  buildingCenter(building: Building): { x: number; z: number };
  removeBuilding(building: Building): void;
  onHurt(x: number, z: number, faction: Faction): void;
  onDeath(x: number, z: number, faction: Faction, color: number, role: string, scale: number): void;
  onKill(unit: Unit): void;
  onObjectiveKill(role: string, faction: Faction): void;
  onStructureDestroyed(faction: Faction): void;
  markDefeat(): void;
  toast(message: string, cls?: string, owner?: OwnerId): void;
  sfx(name: string): void;
}

/** Unit and structure damage, retaliation, death events, and castle defeat. */
export class DamageSystem {
  constructor(private readonly port: DamagePort) {}

  hurtUnit(source: Unit | null, victim: Unit, damage: number): void {
    victim.hp -= damage;
    this.port.onHurt(victim.mesh.position.x, victim.mesh.position.z, victim.faction);
    if (source && !source.dead && !victim.foe && this.hostile(victim.faction, source.faction)) victim.foe = source;
    if (victim.hp <= 0) this.killUnit(victim);
  }

  attackUnit(attacker: Unit, target: Unit): void {
    attacker.lungeT = 0.22;
    const sound = this.meleeSound(attacker);
    if (sound) this.port.sfx(sound);
    const multiplier = damageMultiplier(attacker.role as UnitKind, target.role as UnitKind);
    this.hurtUnit(attacker, target, attacker.dmg * multiplier);
  }

  meleeSound(unit: Unit): 'sword' | 'clang' | 'maul' | 'bite' | 'claw' | null {
    const definition = UNITS[unit.role as UnitKind];
    if (!definition || definition.arrows) return null;
    if (definition.model === 'beast' || definition.model === 'wolf' || definition.model === 'dragon') return 'bite';
    if (definition.model === 'demon') return 'claw';
    switch (unit.role) {
      case 'zombie': case 'brute': return 'maul';
      case 'knight': case 'horseknight': case 'hero': case 'lancer': case 'orc': return 'clang';
      default: return 'sword';
    }
  }

  attackBuilding(attacker: Unit, building: Building): void {
    const sound = this.meleeSound(attacker);
    if (sound) this.port.sfx(sound);
    building.hp -= structureDamage(attacker.role as UnitKind, attacker.dmg);
    const center = this.port.buildingCenter(building);
    this.port.onHurt(center.x, center.z, building.faction);
    if (building.hp <= 0) this.destroyBuilding(building);
  }

  destroyBuilding(building: Building): void {
    if (building.removed) return;
    const center = this.port.buildingCenter(building);
    for (let i = 0; i < 4; i++) {
      this.port.onDeath(center.x + (random() - 0.5) * 1.4, center.z + (random() - 0.5) * 1.4, building.faction, building.def.roof, 'serf', 1);
    }
    if (!building.def.bulwark) this.port.onStructureDestroyed(building.faction);
    for (const unit of this.port.units()) if (unit.foeB === building) unit.foeB = null;
    const castle = (building.owner === 'p1' || building.owner === 'p2') && this.port.playerStore(building.owner) === building;
    this.port.removeBuilding(building);
    // A player's own building falling is their news alone; an enemy stronghold
    // going down is a shared win, so it carries no owner and shows to both.
    this.port.toast(building.def.name + (building.faction === 'player' ? ' has fallen!' : ' destroyed!'), 'err',
      building.faction === 'player' ? building.owner : undefined);
    if (castle) this.port.markDefeat();
  }

  private killUnit(unit: Unit): void {
    if (unit.dead) return;
    unit.dead = true;
    this.port.onDeath(unit.mesh.position.x, unit.mesh.position.z, unit.faction, unit.colorHex, unit.role, unit.mesh.scale.x || 1);
    this.port.onKill(unit);
    this.port.onObjectiveKill(unit.role, unit.faction);
    for (const other of this.port.units()) if (other.foe === unit) other.foe = null;
  }

  private hostile(a: Faction, b: Faction): boolean {
    if (a === b) return false;
    return a === 'player' ? b !== 'player' : b === 'player';
  }
}
