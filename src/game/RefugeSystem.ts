import { simRng } from '../engine/rng';
import type { Building, OwnerId, PlayerId, Site, Unit } from '../types';
import type { World } from '../world/World';
import type { UnitMovement } from './UnitMovement';
import { doorTile } from './util';

interface RefugePorts {
  units: () => readonly Unit[];
  storeFor: (owner: PlayerId) => Building;
  isFighter: (unit: Unit) => boolean;
  cancelTask: (unit: Unit) => void;
  toast: (message: string, cls?: string, owner?: OwnerId) => void;
  sfx: (name: string) => void;
}

/** Castle-bell state and worker movement into and out of refuge. */
export class RefugeSystem {
  private readonly activeOwners = new Set<PlayerId>();

  constructor(
    private readonly world: World,
    private readonly movement: UnitMovement,
    private readonly ports: RefugePorts,
  ) {}

  active(owner: PlayerId): boolean { return this.activeOwners.has(owner); }

  set(owner: PlayerId, active: boolean): void {
    if (this.active(owner) !== active) this.toggle(owner);
  }

  toggle(owner: PlayerId): void {
    if (this.active(owner)) this.activeOwners.delete(owner); else this.activeOwners.add(owner);
    const active = this.active(owner);
    this.ports.sfx('bell');
    if (active) {
      this.ports.toast('The bell tolls — workers run for the castle!', 'err', owner);
      for (const unit of this.ports.units()) {
        if (unit.dead || unit.owner !== owner || unit.faction !== 'player' || this.ports.isFighter(unit) || unit.role === 'carrier') continue;
        if (unit.task) this.ports.cancelTask(unit);
        const site = unit.target as Site | null;
        if (site?.isSite && site.builder === unit) site.builder = null;
        unit.path = null; unit.target = null; unit.mesh.visible = true; unit.wstate = 'toRefuge';
      }
      return;
    }
    this.ports.toast('The bell falls silent — back to work', undefined, owner);
    const door = doorTile(this.ports.storeFor(owner));
    for (const unit of this.ports.units()) {
      if (unit.dead || unit.owner !== owner || unit.faction !== 'player' || this.ports.isFighter(unit)) continue;
      if (unit.wstate !== 'refuge' && unit.wstate !== 'toRefuge') continue;
      unit.mesh.visible = true;
      unit.mesh.position.set(
        this.world.wx(door.x) + (simRng.next() - 0.5) * 0.8,
        0,
        this.world.wz(door.y) + (simRng.next() - 0.5) * 0.8,
      );
      unit.tx = door.x; unit.ty = door.y; unit.path = null; unit.target = null;
      unit.wstate = unit.home ? 'goHome' : 'idle';
      unit.status = 'Idle';
    }
  }

  updateUnit(unit: Unit, dt: number): void {
    if (unit.wstate === 'refuge') { unit.mesh.visible = false; return; }
    const owner = unit.owner === 'p2' ? 'p2' : 'p1';
    const door = doorTile(this.ports.storeFor(owner));
    if (unit.tx === door.x && unit.ty === door.y && !unit.path) {
      unit.wstate = 'refuge'; unit.mesh.visible = false; unit.status = 'Sheltering in the castle';
      return;
    }
    unit.status = 'Running for the castle';
    if (!unit.path && !this.movement.sendTo(unit, door.x, door.y)) { unit.mesh.position.y = 0; return; }
    this.movement.moveGround(unit, dt);
  }
}
