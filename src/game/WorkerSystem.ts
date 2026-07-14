import * as THREE from 'three';
import { simRng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import type { View } from '../render/View';
import type { Building, Coord, OwnerId, PlayerId, Site, Unit } from '../types';
import type { World } from '../world/World';
import type { Modifiers } from './Modifiers';
import { doorTile } from './util';

const rnd = () => simRng.next();

/** Grace period (seconds) a worker spends trying to reach its post before it is
 *  snapped in, so a blocked route can never strand it in a permanent "Moving in". */
const MOVE_IN_TIMEOUT = 6;

interface WorkerPorts {
  buildings: () => readonly Building[];
  sites: () => readonly Site[];
  guildFor: (owner: PlayerId) => Building | null;
  storeFor: (owner: PlayerId) => Building;
  primaryStore: () => Building;
  sendTo: (unit: Unit, x: number, y: number) => boolean;
  moveUnit: (unit: Unit, dt: number) => boolean;
  completeSite: (site: Site) => void;
  wander: (unit: Unit, dt: number, moving: string, resting: string) => void;
  removeTree: (x: number, y: number) => void;
  removeDeposit: (x: number, y: number) => void;
  removeDecoration: (x: number, y: number) => void;
  setCarrying: (unit: Unit, item: string | null) => void;
  onProduce: (item: string, amount: number) => void;
  toast: (message: string, owner?: OwnerId) => void;
  sfx: (name: string) => void;
}

interface GatherNode extends Coord {
  depX?: number;
  depY?: number;
}

/** Builder, specialist, villager, crop, and renewable-resource behavior. */
export class WorkerSystem {
  constructor(
    private readonly world: World,
    private readonly view: View,
    private readonly modsFor: (owner: OwnerId) => Modifiers,
    private readonly ports: WorkerPorts,
  ) {}

  updateLaborer(unit: Unit, dt: number): void {
    if (unit.wstate === 'build') {
      const site = unit.target as Site;
      if (!site || this.ports.sites().indexOf(site) < 0) {
        unit.wstate = 'idle';
        unit.target = null;
        return;
      }
      const door = doorTile(site);
      if (unit.tx === door.x && unit.ty === door.y && !unit.path) {
        unit.status = `Building ${site.def.name}`;
        site.progress += dt / this.modsFor(site.owner).buildTime();
        unit.bob += dt * 12;
        unit.mesh.position.y = Math.abs(Math.sin(unit.bob)) * 0.07;
        site.frame.scale.y = Math.max(0.05, site.progress);
        site.frame.position.y = 0;
        if (site.progress >= 1) {
          unit.wstate = 'idle';
          unit.target = null;
          unit.status = 'Idle';
          this.ports.completeSite(site);
        }
      } else if (!unit.path && !this.ports.sendTo(unit, door.x, door.y)) {
        site.builder = null;
        unit.wstate = 'idle';
        unit.target = null;
      }
      if (unit.path) this.ports.moveUnit(unit, dt);
      return;
    }

    unit.status = 'Idle';
    unit.mesh.position.y = 0;
    const claimable = (site: Site): boolean => {
      if (site.owner !== unit.owner || !site.ready) return false;
      if (site.builder && (site.builder.dead || site.builder.target !== site)) site.builder = null;
      return !site.builder;
    };
    let target: Site | null = null;
    for (const site of this.ports.sites()) {
      if (claimable(site) && site.priority) {
        target = site;
        break;
      }
    }
    if (!target) {
      for (const site of this.ports.sites()) {
        if (claimable(site)) {
          target = site;
          break;
        }
      }
    }
    if (target) {
      target.builder = unit;
      unit.target = target;
      unit.wstate = 'build';
      unit.path = null;
    } else {
      this.ports.wander(unit, dt, 'Strolling', 'Idle');
    }
  }

  updateWorker(unit: Unit, dt: number): void {
    const building = unit.home;
    if (!building) return;
    if (unit.wstate === 'goHome') {
      unit.mesh.visible = true;
      const door = doorTile(building);
      const atDoor = unit.tx === door.x && unit.ty === door.y;
      if (!atDoor && !unit.path && !this.ports.sendTo(unit, door.x, door.y)) {
        // The door became unreachable after staffing (a building or wall placed
        // across the route). Give the worker a grace period to re-path, then snap
        // it into its post so no building type can strand it in "Moving in" limbo.
        unit.timer += dt;
        if (unit.timer >= MOVE_IN_TIMEOUT) {
          unit.tx = door.x;
          unit.ty = door.y;
          unit.mesh.position.set(this.world.wx(door.x), 0, this.world.wz(door.y));
        }
      } else {
        unit.timer = 0;
      }
      if (unit.path) this.ports.moveUnit(unit, dt);
      if (!unit.path && unit.tx === door.x && unit.ty === door.y) {
        unit.timer = 0;
        unit.wstate = 'home';
        building.active = true;
        unit.status = 'At work';
        this.ports.toast(`${building.def.name} is now staffed`, building.owner);
        return;
      }
      unit.status = 'Moving in';
      return;
    }

    const def = building.def;
    if (def.recipe) {
      unit.mesh.visible = false;
      unit.mesh.position.y = 0;
      if (building.working) {
        unit.status = 'Working';
        unit.bob += dt * 10;
        unit.mesh.position.y = Math.abs(Math.sin(unit.bob)) * 0.05;
        building.prog += dt / this.modsFor(building.owner).recipeTime(def);
        if (building.prog >= 1) {
          building.prog = 0;
          building.working = false;
          const output = def.recipe.out;
          if (def.recipe.globalOutput) {
            const stock = this.ports.primaryStore().stock!;
            stock[output] = (stock[output] || 0) + 1;
          } else {
            building.out[output] = (building.out[output] || 0) + 1;
          }
          this.ports.onProduce(output, this.modsFor(building.owner).objectiveWeight(output));
        }
      } else {
        unit.status = 'Waiting for materials';
        if (this.outputTotal(building) < this.modsFor(building.owner).outCap()) {
          const inputs = this.modsFor(building.owner).recipeInputs(def);
          const amounts = inputs as Record<string, number | undefined>;
          let canStart = true;
          for (const item in inputs) if ((building.inp[item] || 0) < (amounts[item] ?? 0)) canStart = false;
          if (canStart) {
            for (const item in inputs) building.inp[item] -= amounts[item] ?? 0;
            building.working = true;
            building.prog = 0;
          }
        } else {
          unit.status = 'Output full';
        }
      }
      return;
    }
    if (!def.gather) {
      unit.mesh.visible = false;
      unit.mesh.position.y = 0;
      unit.status = 'Tending';
      return;
    }
    if (unit.wstate === 'home') {
      unit.mesh.visible = false;
      unit.mesh.position.y = 0;
      if (this.outputTotal(building) >= this.modsFor(building.owner).outCap()) {
        unit.status = 'Output full';
        return;
      }
      const node = this.findNode(building);
      if (!node) {
        unit.status = 'No resources in range';
        return;
      }
      unit.target = node;
      if (def.gather.node === 'tree') this.world.tiles[node.y][node.x].tree!.reserved = true;
      unit.wstate = 'toNode';
    }
    if (unit.wstate === 'toNode') {
      unit.mesh.visible = true;
      const node = unit.target as GatherNode;
      if (unit.tx === node.x && unit.ty === node.y && !unit.path) {
        unit.wstate = 'gather';
        unit.timer = this.modsFor(building.owner).gatherTime(def);
      } else if (!unit.path && !this.ports.sendTo(unit, node.x, node.y)) {
        unit.wstate = 'home';
        unit.target = null;
        return;
      }
      if (unit.path) this.ports.moveUnit(unit, dt);
      unit.status = 'Heading out';
      return;
    }
    if (unit.wstate === 'gather') {
      unit.mesh.visible = true;
      unit.status = def.gather.node === 'plant' ? 'Planting' : 'Gathering';
      unit.bob += dt * 11;
      unit.mesh.position.y = Math.abs(Math.sin(unit.bob)) * 0.07;
      unit.timer -= dt;
      if (unit.timer <= 0) this.finishGather(unit, building, unit.target as GatherNode);
      return;
    }
    if (unit.wstate === 'return') {
      unit.mesh.visible = true;
      const door = doorTile(building);
      if (unit.tx === door.x && unit.ty === door.y && !unit.path) {
        if (unit.carrying) {
          building.out[unit.carrying] = (building.out[unit.carrying] || 0) + 1;
          this.ports.onProduce(unit.carrying, this.modsFor(building.owner).objectiveWeight(unit.carrying));
          this.ports.setCarrying(unit, null);
        }
        unit.wstate = 'home';
      } else if (!unit.path && !this.ports.sendTo(unit, door.x, door.y)) {
        unit.wstate = 'home';
        this.ports.setCarrying(unit, null);
      }
      if (unit.path) this.ports.moveUnit(unit, dt);
      unit.status = 'Returning';
    }
  }

  updateVillager(unit: Unit, dt: number): void {
    unit.mesh.visible = true;
    if (unit.wstate !== 'stroll' && unit.wstate !== 'strollWait') {
      unit.wstate = 'strollWait';
      unit.timer = rnd() * 2.5;
    }
    if (unit.wstate === 'strollWait') {
      unit.status = 'Idling in the village';
      unit.mesh.position.y = 0;
      unit.timer -= dt;
      if (unit.timer > 0) return;
      const owner = unit.owner === 'p2' ? 'p2' : 'p1';
      const center = this.ports.guildFor(owner) ?? this.ports.storeFor(owner);
      const cx = center.x + 1;
      const cy = center.y + 1;
      for (let tries = 0; tries < 8; tries++) {
        const x = cx + Math.round((rnd() - 0.5) * 14);
        const y = cy + Math.round((rnd() - 0.5) * 14);
        const tile = this.world.T(x, y);
        if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep) continue;
        if (this.ports.sendTo(unit, x, y)) {
          unit.wstate = 'stroll';
          return;
        }
      }
      unit.timer = 1 + rnd() * 2;
      return;
    }
    unit.status = 'Strolling';
    if (unit.path) this.ports.moveUnit(unit, dt);
    else {
      unit.wstate = 'strollWait';
      unit.timer = 1.5 + rnd() * 3;
    }
  }

  updateGrowth(dt: number): void {
    const { W, H, tiles } = this.world;
    for (const building of this.ports.buildings()) {
      if (!building.def.fields) continue;
      const fieldGrowth = this.modsFor(building.owner).fieldGrowth();
      for (const field of building.fieldsList) {
        const tile = tiles[field.y][field.x];
        if (!tile.field || tile.field.growth >= 1) continue;
        tile.field.growth += dt / 22 * fieldGrowth;
        if (tile.field.growth > 1) tile.field.growth = 1;
        this.view.scaleFieldCrop(tile.field);
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const tile = tiles[y][x];
      if (!tile.tree || tile.tree.growth >= 1) continue;
      tile.tree.growth += dt / 40;
      if (tile.tree.growth >= 1) {
        tile.tree.growth = 1;
        this.view.treeMatured(x, y, tile.tree);
        continue;
      }
      const scale = tile.tree.s * Math.max(0.15, tile.tree.growth);
      const mesh = tile.tree.meshes[0] as THREE.Object3D | undefined;
      if (mesh) mesh.scale.set(scale, scale, scale);
    }
  }

  recolorFields(): void {
    for (const building of this.ports.buildings()) {
      if (building.def.fields) for (const field of building.fieldsList) this.view.refreshTile(field.x, field.y);
    }
  }

  private finishGather(unit: Unit, building: Building, node: GatherNode): void {
    const gather = building.def.gather!;
    const tile = this.world.tiles[node.y][node.x];
    if (gather.node === 'tree') {
      if (tile.tree) {
        if (this.modsFor(building.owner).preserveTrees()) tile.tree.reserved = false;
        else this.ports.removeTree(node.x, node.y);
      }
      this.ports.setCarrying(unit, 'trunk');
      this.ports.sfx('chop');
    } else if (gather.node === 'field') {
      if (tile.field) {
        tile.field.growth = 0;
        this.view.refreshTile(node.x, node.y);
        this.view.scaleFieldCrop(tile.field);
      }
      this.ports.setCarrying(unit, gather.out ?? 'wheat');
      this.ports.sfx('harvest');
    } else if (gather.node === 'plant') {
      if (!tile.tree && !tile.b && !tile.site && !tile.road && !tile.field && !tile.dep) {
        if (tile.deco) this.ports.removeDecoration(node.x, node.y);
        tile.tree = { growth: 0.12, reserved: false, meshes: [], s: 0.85 + rnd() * 0.4, kind: Math.floor(rnd() * 4) };
        this.view.addTree(node.x, node.y, tile.tree);
      }
    } else if (gather.node === 'fish') {
      this.ports.setCarrying(unit, gather.out);
      this.ports.sfx('harvest');
    } else {
      const depositTile = this.world.T(node.depX ?? node.x, node.depY ?? node.y);
      if (depositTile?.dep) {
        depositTile.dep.amt--;
        if (depositTile.dep.amt <= 0) this.ports.removeDeposit(node.depX ?? node.x, node.depY ?? node.y);
      }
      this.ports.setCarrying(unit, gather.out);
    }
    unit.wstate = 'return';
    unit.mesh.position.y = 0;
  }

  private findNode(building: Building): GatherNode | null {
    const gather = building.def.gather!;
    const cx = building.x + 0.5;
    const cy = building.y + 0.5;
    const { W, H, tiles } = this.world;
    let best: GatherNode | null = null;
    let bestDistance = 1e9;
    if (gather.node === 'field') {
      for (const field of building.fieldsList) {
        const tile = tiles[field.y][field.x];
        if (tile.field && tile.field.growth >= 1) {
          const distance = Math.hypot(field.x - cx, field.y - cy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = field;
          }
        }
      }
      return best;
    }
    if (gather.node === 'plant') {
      for (let y = Math.max(0, building.y - gather.range); y <= Math.min(H - 1, building.y + 1 + gather.range); y++) {
        for (let x = Math.max(0, building.x - gather.range); x <= Math.min(W - 1, building.x + 1 + gather.range); x++) {
          const tile = tiles[y][x];
          if (tile.type !== 'grass' || tile.b || tile.site || tile.tree || tile.dep || tile.road || tile.field) continue;
          const distance = Math.hypot(x - cx, y - cy);
          if (distance > 2.2 && distance < bestDistance) {
            bestDistance = distance;
            best = { x, y };
          }
        }
      }
      return best;
    }
    if (gather.node === 'fish') {
      for (let y = Math.max(0, building.y - gather.range); y <= Math.min(H - 1, building.y + 1 + gather.range); y++) {
        for (let x = Math.max(0, building.x - gather.range); x <= Math.min(W - 1, building.x + 1 + gather.range); x++) {
          const tile = tiles[y][x];
          if (tile.type !== 'grass' || tile.b || tile.site || tile.tree || tile.dep || tile.road || tile.field || !this.adjacentWater(x, y)) continue;
          const distance = Math.hypot(x - cx, y - cy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { x, y };
          }
        }
      }
      return best;
    }
    const candidates: { node: GatherNode; distance: number }[] = [];
    for (let y = Math.max(0, building.y - gather.range); y <= Math.min(H - 1, building.y + 1 + gather.range); y++) {
      for (let x = Math.max(0, building.x - gather.range); x <= Math.min(W - 1, building.x + 1 + gather.range); x++) {
        const tile = tiles[y][x];
        const valid = gather.node === 'tree' ? !!(tile.tree && tile.tree.growth >= 1 && !tile.tree.reserved && !tile.tree.dense)
          : gather.node === 'stone' ? !!(tile.dep && tile.dep.kind === 'stone' && tile.dep.amt > 0)
          : gather.node === 'gold' ? !!(tile.dep && tile.dep.kind === 'gold' && tile.dep.amt > 0)
          : gather.node === 'coal' ? !!(tile.dep && tile.dep.kind === 'coal' && tile.dep.amt > 0)
          : gather.node === 'iron' ? !!(tile.dep && tile.dep.kind === 'iron' && tile.dep.amt > 0)
          : false;
        if (!valid) continue;
        if (tile.dep) {
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const sx = x + ox;
            const sy = y + oy;
            if (!this.world.passable(sx, sy)) continue;
            candidates.push({ node: { x: sx, y: sy, depX: x, depY: y }, distance: Math.hypot(sx - cx, sy - cy) });
          }
        } else {
          candidates.push({ node: { x, y }, distance: Math.hypot(x - cx, y - cy) });
        }
      }
    }
    // Pick the nearest node the worker can actually walk to. Selecting purely by
    // distance let a blocked-off nearest deposit (e.g. a mine placed across the
    // route) trap the worker in an endless home->toNode->home loop with nothing
    // gathered, even though a reachable deposit sat further out.
    candidates.sort((a, b) => a.distance - b.distance);
    const from = doorTile(building);
    for (const { node } of candidates) {
      if (findPath(this.world, from.x, from.y, node.x, node.y, building.owner) !== null) return node;
    }
    return null;
  }

  /** Any open water on the four sides — ponds are fishable too, not just the
   *  big `lake`-tagged body, so a fishery on a pond shore actually works. */
  private adjacentWater(x: number, y: number): boolean {
    return this.world.T(x + 1, y)?.type === 'water' || this.world.T(x - 1, y)?.type === 'water'
      || this.world.T(x, y + 1)?.type === 'water' || this.world.T(x, y - 1)?.type === 'water';
  }

  private outputTotal(building: Building): number {
    let total = 0;
    for (const item in building.out) total += building.out[item];
    return total;
  }
}
