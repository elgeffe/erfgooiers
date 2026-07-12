import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { View } from '../render/View';
import { World } from '../world/World';
import { Game } from './Game';

function headlessView(world: World): View {
  const unit = (_color: number, _role: string, x: number, y: number) => {
    const group = new THREE.Group();
    group.position.set(world.wx(x), 0, world.wz(y));
    const itemMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    group.add(itemMesh);
    return { group, itemMesh };
  };
  return {
    createBuildingMesh: () => new THREE.Group(),
    createUnit: unit,
    add: () => {},
    remove: () => {},
    refreshTile: () => {},
    dirtyTile: () => {},
    removeMeshes: () => {},
  } as unknown as View;
}

describe('Game siege orders', () => {
  it('keeps attacking the ordered building despite a nearby guard', () => {
    const world = new World({ seed: 404, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    // A controlled open battlefield keeps this regression about target
    // priority rather than procedural terrain.
    for (const row of world.tiles) for (const t of row) {
      t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; t.deco = null; t.pickup = null;
    }
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 0, laborers: 0, villagers: 0 });
    const camp = game.placeBuilding('banditcamp', 5, 5, true, 0, 'enemy');
    const guard = game.spawnFighter('bandit', { x: 8, y: 5 }, 'enemy');
    guard.hp = guard.maxHp = 1_000_000;
    guard.dmg = 0;
    const soldier = game.spawnFighter('soldier', { x: 2, y: 5 }, 'player');
    soldier.dmg = 100;
    soldier.hp = soldier.maxHp = 1_000;

    game.orderGroupAttackBuilding([soldier], camp);
    for (let i = 0; i < 400 && !camp.removed; i++) game.update(0.05);

    expect(camp.removed).toBe(true);
    expect(guard.dead).toBe(false);
  });
});

describe('priest healing', () => {
  it('automatically heals an injured nearby ally without healing enemies', () => {
    const world = new World({ seed: 405, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 0, laborers: 0, villagers: 0 });
    const priest = game.spawnFighter('priest', { x: 5, y: 5 }, 'player');
    const ally = game.spawnFighter('soldier', { x: 6, y: 5 }, 'player');
    const enemy = game.spawnFighter('bandit', { x: 6, y: 6 }, 'enemy');
    ally.hp = 10; ally.dmg = 0; enemy.hp = 10; enemy.dmg = 0;
    game.update(0.05);
    expect(ally.hp).toBe(18);
    expect(enemy.hp).toBe(10);
    expect(priest.foe).toBeNull();
  });
});

describe('serf hauling from storehouse', () => {
  it('hauls resources from the storehouse to a production building', () => {
    const world = new World({ seed: 406, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const game = new Game(world, headlessView(world));
    // Start with 5 flour in store, 1 serf, 0 laborers, 0 villagers
    game.init({ stock: { flour: 5 }, serfs: 1, laborers: 0, villagers: 0 });

    // Place a bakery
    const bakery = game.placeBuilding('bakery', 10, 10, true);
    // Directly staff and activate the bakery
    const worker = game.spawnUnit('baker', 0xf0e6d2, { x: 10, y: 10 });
    worker.home = bakery;
    bakery.worker = worker;
    bakery.active = true;

    // Run the game simulation for a few ticks
    for (let i = 0; i < 200; i++) {
      game.update(0.05);
    }

    const serf = game.units.find(u => u.role === 'serf')!;
    console.log('SERF STATE:', {
      role: serf.role,
      tx: serf.tx,
      ty: serf.ty,
      task: serf.task,
      status: serf.status,
      carrying: serf.carrying,
      path: serf.path,
    });
    console.log('BAKERY STATE:', {
      inp: bakery.inp,
      out: bakery.out,
      working: bakery.working,
      prog: bakery.prog,
      active: bakery.active,
    });

    // Check if the bakery received the flour (or already turned it to bread)
    expect((bakery.inp['flour'] || 0) + (bakery.out['bread'] || 0) + (bakery.working ? 1 : 0)).toBeGreaterThan(0);
  });
});



