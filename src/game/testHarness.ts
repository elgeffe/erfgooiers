import * as THREE from 'three';
import { World } from '../world/World';
import { simRng, uiRng } from '../engine/rng';
import { Modifiers } from './Modifiers';
import { Game } from './Game';
import type { View } from '../render/View';
import type { Building, PlayerId, Unit, UnitOrder } from '../types';

/**
 * Headless test double for the View: the simulation only ever asks it to
 * create/remove meshes, so plain THREE objects with no renderer are enough.
 * Unit groups must sit at real world coordinates — movement math reads them.
 */
export function stubView(world: World): View {
  const unit = () => ({
    group: new THREE.Group(),
    itemMesh: new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshLambertMaterial()),
  });
  const at = (g: THREE.Object3D, x: number, y: number) => { g.position.set(world.wx(x), 0, world.wz(y)); return g; };
  const view = {
    add() {}, remove() {}, removeMeshes() {},
    refreshTile() {}, dirtyTile() {},
    addRoad() {}, removeRoad() {},
    addFieldCrop() {}, scaleFieldCrop() {}, treeMatured() {}, addTree() {},
    createBuildingMesh: () => new THREE.Group(),
    createScaffold: () => ({ group: new THREE.Group(), frame: new THREE.Group() }),
    createPlotMarker: () => new THREE.Group(),
    createFlag: () => new THREE.Group(),
    createArrow: () => new THREE.Group(),
    createRock: () => new THREE.Group(),
    createFireball: () => new THREE.Group(),
    createFlame: () => new THREE.Group(),
    createUnit: (_c: number, _r: string, x: number, y: number) => { const u = unit(); at(u.group, x, y); return u; },
    createHero: (_id: string, x: number, y: number) => { const u = unit(); at(u.group, x, y); return u; },
  };
  return view as unknown as View;
}

export interface TestGameOptions {
  seed?: number;
  size?: number;
  localPlayerId?: PlayerId;
  coop?: boolean;
}

/** A deterministic, renderer-free Game on a small friendly map. */
export function makeTestGame(options: TestGameOptions = {}): { game: Game; world: World } {
  const seed = options.seed ?? 4242;
  simRng.reseed(seed ^ 0x5bd1e995);
  uiRng.reseed(seed ^ 0x27d4eb2f);
  const size = options.size ?? 48;
  const world = new World({
    seed, w: size, h: size, biome: 'gooi',
    treeStands: 4, oreVeins: 3, waterScale: 0.2, meadows: 2, goldPiles: 2,
  });
  const game = new Game(world, stubView(world), new Modifiers(), options.localPlayerId ?? 'p1');
  if (options.coop ?? true) game.initCoOp(); else game.init();
  return { game, world };
}

/** Step the fixed 20 Hz simulation `seconds` forward. */
export function tick(game: Game, seconds: number): void {
  const steps = Math.round(seconds * 20);
  for (let i = 0; i < steps; i++) game.update(1 / 20);
}

/** Tick until `done` returns true or `maxSeconds` elapse; returns success. */
export function tickUntil(game: Game, done: () => boolean, maxSeconds = 120): boolean {
  const steps = Math.round(maxSeconds * 20);
  for (let i = 0; i < steps; i++) {
    if (done()) return true;
    game.update(1 / 20);
  }
  return done();
}

/** Stable, renderer-free state serialization for behavior-preserving refactors.
 * Arrays stay in entity-id order and unordered stock records are key-sorted, so
 * a hash change means gameplay state or deterministic iteration changed. */
export function gameplayFingerprint(game: Game, includeLocalPresentation = true): string {
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const record = (values: Record<string, number> | undefined): [string, number][] =>
    Object.entries(values ?? {}).filter(([, value]) => value !== 0).sort(([a], [b]) => a.localeCompare(b));
  const ref = (value: unknown): number | null =>
    value && typeof value === 'object' && 'id' in value && typeof value.id === 'number' ? value.id : null;
  const order = (value: UnitOrder | null): unknown => value && ({
    type: value.type, x: value.x, y: value.y, foe: ref(value.foe), building: ref(value.building), field: !!value.field,
  });
  const building = (b: Building): unknown => ({
    id: b.id, key: b.key, owner: b.owner, x: b.x, y: b.y, rot: b.rot,
    active: b.active, hp: round(b.hp), prog: round(b.prog), working: b.working,
    worker: ref(b.worker), inp: record(b.inp), out: record(b.out), incoming: record(b.incoming),
    stock: record(b.stock), trainQ: b.trainQ ?? [], rally: b.rally ?? null,
    priority: !!b.priority, removed: !!b.removed,
    market: b.marketItem ? [b.marketItem, b.marketAmount ?? 0, round(b.marketTimer ?? 0)] : null,
  });
  const unit = (u: Unit): unknown => ({
    id: u.id, owner: u.owner, role: u.role, tx: u.tx, ty: u.ty,
    x: round(u.mesh.position.x), y: round(u.mesh.position.y), z: round(u.mesh.position.z),
    hp: round(u.hp), state: u.wstate, timer: round(u.timer), target: ref(u.target),
    carrying: u.carrying, home: ref(u.home), hunger: round(u.hunger), faction: u.faction,
    atkTimer: round(u.atkTimer), dead: u.dead, raider: u.raider,
    foe: ref(u.foe), foeB: ref(u.foeB), order: order(u.order), queue: u.orderQueue.map(order),
    obeyT: round(u.obeyT), special: round(u.special), anchor: u.anchor,
    task: u.task ? { item: u.task.item, phase: u.task.phase, from: ref(u.task.from), to: ref(u.task.to) } : null,
  });

  return JSON.stringify({
    elapsed: round(game.elapsed), defeat: game.defeat, bonusTime: round(game.bonusTime), prepMult: game.prepMult,
    buildings: [...game.buildings].sort((a, b) => a.id - b.id).map(building),
    sites: [...game.sites].sort((a, b) => a.id - b.id).map(s => ({
      id: s.id, key: s.key, owner: s.owner, x: s.x, y: s.y, rot: s.rot,
      needs: record(s.needs), delivered: record(s.delivered), incoming: record(s.incoming),
      progress: round(s.progress), ready: s.ready, builder: ref(s.builder), priority: !!s.priority, removed: !!s.removed,
    })),
    units: [...game.units].sort((a, b) => a.id - b.id).map(unit),
    tradeRequests: game.tradeRequests.map(r => ({ ...r, at: round(r.at) })),
    tradeShipments: game.tradeShipments.map(s => ({
      id: s.id, from: s.from, to: s.to, item: s.item, amount: s.amount,
      sourceId: s.sourceId, destinationId: s.destinationId, phase: s.phase,
      loadT: round(s.loadT), eta: round(s.eta), carrier: ref(s.carrier), requestId: s.requestId, at: round(s.at),
    })),
    tradeHistory: includeLocalPresentation ? game.tradeHistory.map(h => ({ ...h, at: round(h.at) })) : [],
    nextWave: game.nextWave(), nextScheduledWave: game.nextScheduledWave(),
  });
}

/** Compact golden value for gameplayFingerprint. FNV-1a is intentionally
 * simple and local: this is change detection, not a security primitive. */
export function gameplayFingerprintHash(game: Game): string {
  let hash = 0x811c9dc5;
  for (const codeUnit of gameplayFingerprint(game)) hash = Math.imul(hash ^ codeUnit.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
