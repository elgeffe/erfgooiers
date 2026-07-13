import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { View } from '../render/View';
import { World } from '../world/World';
import { Game } from './Game';

function headlessView(world: World, caravan?: { created: number; removed: number }): View {
  const unit = (_color: number, _role: string, x: number, y: number) => {
    const group = new THREE.Group();
    group.position.set(world.wx(x), 0, world.wz(y));
    const itemMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    group.add(itemMesh);
    return { group, itemMesh };
  };
  return {
    createBuildingMesh: () => new THREE.Group(),
    createScaffold: () => ({ group: new THREE.Group(), frame: new THREE.Group() }),
    createUnit: unit,
    add: () => {},
    remove: (mesh: THREE.Object3D) => { if (mesh.userData.traderCaravan && caravan) caravan.removed++; },
    refreshTile: () => {},
    dirtyTile: () => {},
    removeMeshes: () => {},
    createTraderCaravan: () => {
      if (caravan) caravan.created++;
      const mesh = new THREE.Group(); mesh.userData.traderCaravan = true; return mesh;
    },
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

describe('market exports', () => {
  it('has serfs deliver exports and return caravan proceeds to storage', () => {
    const world = new World({ seed: 406, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const caravan = { created: 0, removed: 0 };
    const game = new Game(world, headlessView(world, caravan));
    game.init({ stock: { bread: 10, coin: 0 }, serfs: 4, laborers: 0, villagers: 0 });
    const market = game.placeBuilding('market', 5, 5, true);
    const enemy = game.spawnFighter('bandit', { x: 8, y: 8 }, 'enemy');
    enemy.dmg = 0;
    let runGold = 0; game.onGold = n => { runGold += n; };

    game.configureMarket(market, 'bread', 4);
    expect(game.marketIncomePerMinute(market)).toBe(12);
    for (let i = 0; i < 10; i++) game.update(0.05);
    expect(market.inp.bread || 0).toBe(0);
    expect(market.incoming.bread).toBe(4);
    for (let i = 0; i < 1200 && (market.inp.bread || 0) < 4; i++) game.update(0.05);
    expect(market.inp.bread).toBe(4);
    expect(market.incoming.bread || 0).toBe(0);
    expect(game.store.stock!.bread).toBe(6);

    market.marketTimer = 0.05;
    game.update(0.05);
    expect(caravan.created).toBe(1);
    expect(game.marketCaravansInTransit(market)).toBe(1);
    expect(game.units).toHaveLength(5); // four serfs plus the enemy; caravans are not targetable Units

    for (let i = 0; i < 2400 && game.store.stock!.coin < 12; i++) game.update(0.05);
    expect(game.store.stock!.coin).toBe(12);
    expect(runGold).toBe(0);
    expect(caravan.removed).toBe(1);
    expect(game.marketCaravansInTransit(market)).toBe(0);
  });

  it('waits for delivered stock and sells only the market inventory', () => {
    const world = new World({ seed: 407, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const caravan = { created: 0, removed: 0 };
    const game = new Game(world, headlessView(world, caravan));
    game.init({ stock: { bread: 2, coin: 0 }, serfs: 0, laborers: 0, villagers: 0 });
    const market = game.placeBuilding('market', 5, 5, true);
    game.configureMarket(market, 'bread', 99);
    expect(market.marketAmount).toBe(50);
    game.configureMarket(market, 'coin', 3);
    expect(market.marketItem).toBe('bread');
    market.marketTimer = 0;
    game.update(0.05);
    expect(caravan.created).toBe(0);
    expect(game.store.stock!.bread).toBe(2);

    game.configureMarket(market, 'bread', 2);
    game.store.stock!.bread = 0;
    market.inp.bread = 2;
    market.marketTimer = 0;
    for (let i = 0; i < 240 && caravan.removed === 0; i++) game.update(0.05);
    expect(caravan.created).toBe(1);
    expect(market.inp.bread).toBe(0);
    expect(market.out.coin).toBe(6);
    expect(game.store.stock!.coin).toBe(0); // no serf exists to return the proceeds
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




describe('worker logistics metrics', () => {
  it('reports a healthy pool and flags shortages of villagers and builders', () => {
    const world = new World({ seed: 407, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; t.pickup = null; }
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 3, laborers: 1, villagers: 2 });

    // Idle village, no sites, no producers: every pool is comfortable.
    const calm = game.workerMetrics();
    expect(calm.serf.count).toBe(3);
    expect(calm.serf.status).toBe('good');
    expect(calm.villager.status).toBe('good');
    expect(calm.builder.status).toBe('good');

    // Two open sites with a single builder backs the build pool up.
    game.placeSite("farm", 10, 10);
    game.placeSite("farm", 14, 10);
    expect(game.workerMetrics().builder.status).toBe('bad');
  });
});
