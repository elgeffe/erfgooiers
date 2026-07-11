import * as THREE from 'three';
import { World } from '../world/World';
import { simRng, uiRng } from '../engine/rng';
import { Modifiers } from './Modifiers';
import { Game } from './Game';
import type { View } from '../render/View';
import type { PlayerId } from '../types';

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
