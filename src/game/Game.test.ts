import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { View } from '../render/View';
import { World } from '../world/World';
import { LEVELS } from '../data/levels';
import { simRng } from '../engine/rng';
import { Game } from './Game';
import { doorTile } from './util';

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
    createArrow: () => new THREE.Group(),
    createRock: () => new THREE.Group(),
    createFireball: () => new THREE.Group(),
    createFlame: () => new THREE.Group(),
    createFlag: () => new THREE.Group(),
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

function openBattleGame(seed = 404, size = 48): { game: Game; world: World } {
  const world = new World({ seed, w: size, h: size, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
  for (const row of world.tiles) for (const t of row) {
    t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; t.deco = null; t.pickup = null;
  }
  const game = new Game(world, headlessView(world));
  game.init({ stock: {}, serfs: 0, laborers: 0, villagers: 0 });
  return { game, world };
}

describe('Game siege orders', () => {
  it('spawns wild animals far from a corner castle rather than the map centre', () => {
    const world = new World({
      seed: 2, w: 64, h: 64, treeStands: 11, oreVeins: 9,
      waterScale: 1, meadows: 6, mountains: 2, frontier: true,
    });
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 0, laborers: 0, villagers: 0 });
    simRng.reseed(2);

    game.setEnemies({ wild: [{ kind: 'wolf', count: 4 }] });
    simRng.reseed(1337); // keep the file's pre-existing shared-stream baseline

    const wolves = game.units.filter(u => u.role === 'wolf');
    const keep = Math.max(15, Math.floor(Math.min(world.W, world.H) * 0.32));
    expect(wolves).toHaveLength(4);
    expect(wolves.every(u => Math.hypot(u.tx - (game.store.x + 1), u.ty - (game.store.y + 1)) >= keep)).toBe(true);
  });

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

  it('retains a Shift-queued tower target for every unit', () => {
    const { game } = openBattleGame(412);
    const decoy = game.placeBuilding('banditcamp', 20, 18, true, 0, 'enemy');
    const tower = game.placeBuilding('enemywatchtower', 30, 24, true, 0, 'enemy');
    tower.hp = tower.maxHp = 1_000_000;
    const guard = game.spawnFighter('bandit', { x: 27, y: 24 }, 'enemy');
    guard.dmg = 0; guard.hp = guard.maxHp = 1_000_000;
    const squad = Array.from({ length: 48 }, (_, i) => {
      const u = game.spawnFighter('soldier', { x: 5 + i % 8, y: 20 + Math.floor(i / 8) }, 'player');
      u.hp = u.maxHp = 1_000_000;
      return u;
    });

    game.orderGroup(squad, 'move', 15, 24, null, 'box');
    game.orderGroupAttackBuilding(squad, tower, true);

    expect(squad.every(u => u.orderQueue[0]?.building === tower)).toBe(true);
    for (let i = 0; i < 500 && squad.some(u => u.order?.building !== tower); i++) game.update(0.05);

    expect(squad.every(u => u.order?.building === tower)).toBe(true);
    expect(squad.every(u => u.foeB === tower)).toBe(true);
    expect(squad.every(u => u.foe !== guard)).toBe(true);
    expect(decoy.removed).not.toBe(true);
  });

  it('continues the chain after a structure falls, then attacks at will', () => {
    const { game } = openBattleGame(413);
    const tower = game.placeBuilding('enemywatchtower', 18, 24, true, 0, 'enemy');
    tower.hp = tower.maxHp = 1;
    const guard = game.spawnFighter('bandit', { x: 28, y: 24 }, 'enemy');
    guard.dmg = 0; guard.hp = guard.maxHp = 1_000;
    const soldier = game.spawnFighter('soldier', { x: 8, y: 24 }, 'player');
    soldier.hp = soldier.maxHp = 1_000;

    game.orderUnit(soldier, 'move', 12, 24);
    game.orderGroupAttackBuilding([soldier], tower, true);
    game.orderUnit(soldier, 'move', 26, 24, null, true);

    for (let i = 0; i < 800 && (soldier.order || guard.hp === guard.maxHp); i++) game.update(0.05);

    expect(tower.removed).toBe(true);
    expect(soldier.order).toBeNull();
    expect(Math.hypot(soldier.tx - 26, soldier.ty - 24)).toBeLessThanOrEqual(1);
    expect(guard.hp).toBeLessThan(guard.maxHp);
  });

  it('marches a large host on one tower via the shared flow field, not per-unit A*', () => {
    const { game } = openBattleGame(414);
    const tower = game.placeBuilding('enemywatchtower', 36, 24, true, 0, 'enemy');
    tower.hp = tower.maxHp = 1_000_000;
    const squad = Array.from({ length: 240 }, (_, i) => {
      const u = game.spawnFighter('soldier', { x: 3 + i % 16, y: 8 + Math.floor(i / 16) }, 'player');
      u.hp = u.maxHp = 1_000_000;
      return u;
    });
    let searches = 0;
    const originalSendTo = (game as any).sendTo.bind(game);
    (game as any).sendTo = (...args: unknown[]) => { searches++; return originalSendTo(...args); };

    game.orderGroupAttackBuilding(squad, tower);
    expect(squad.every(u => u.order?.field)).toBe(true);
    game.update(0.05);
    game.update(0.05);

    // the whole host derives its march from one flood; on open ground the
    // global search only returns for the salted shuffle around the walls
    expect(searches).toBe(0);
    expect(squad.filter(u => u.path).length).toBe(240);
    expect(squad.every(u => u.order?.building === tower && u.foeB === tower)).toBe(true);
  });

  it('diverts a chained siege of a walled keep onto the ramparts instead of storming the pathfinder', () => {
    const { game } = openBattleGame(909, 64);
    const tower = game.placeBuilding('enemywatchtower', 40, 20, true, 0, 'enemy');
    tower.hp = tower.maxHp = 3_000;
    const keep = game.placeBuilding('enemycastle', 48, 40, true, 0, 'enemy');
    keep.hp = keep.maxHp = 1_000_000;
    (game as any).fortifyStronghold(keep); // walls & gate the player cannot pass
    const squad = Array.from({ length: 120 }, (_, i) => {
      const u = game.spawnFighter('horsearcher', { x: 4 + i % 12, y: 10 + Math.floor(i / 12) }, 'player');
      u.hp = u.maxHp = 1_000_000;
      return u;
    });

    game.orderGroupAttackBuilding(squad, tower);
    game.orderGroupAttackBuilding(squad, keep, true);

    let searches = 0;
    const originalSendTo = (game as any).sendTo.bind(game);
    (game as any).sendTo = (...args: unknown[]) => { searches++; return originalSendTo(...args); };

    // Before the fallback, every besieger of the unreachable keep re-ran a
    // failed full-map A* twice a second, forever — the sim froze and the host
    // never breached the walls. Now they batter the ramparts instead: the keep
    // must take damage, on a bounded search diet.
    let reached = false;
    for (let sec = 0; sec < 180 && !reached; sec++) {
      searches = 0;
      for (let i = 0; i < 20; i++) game.update(0.05);
      expect(searches).toBeLessThan(200); // budgeted marches, not a storm
      reached = keep.hp < keep.maxHp - 1_000;
    }
    expect(tower.removed).toBe(true);
    expect(reached).toBe(true);
  }, 60_000);

  it('moves a big formation off one flow field and lands every unit on its slot', () => {
    const { game } = openBattleGame(418);
    const squad = Array.from({ length: 96 }, (_, i) => {
      const u = game.spawnFighter('soldier', { x: 3 + i % 12, y: 3 + Math.floor(i / 12) }, 'player');
      u.hp = u.maxHp = 1_000;
      return u;
    });
    let searches = 0;
    const originalSendTo = (game as any).sendTo.bind(game);
    (game as any).sendTo = (...args: unknown[]) => { searches++; return originalSendTo(...args); };

    game.orderGroup(squad, 'move', 38, 38, null, 'box');
    const targets = new Set(squad.map(u => `${u.order!.x},${u.order!.y}`));
    expect(targets.size).toBe(96); // one exact slot per unit
    game.update(0.05);
    expect(squad.filter(u => u.path).length).toBe(96); // under way on tick one

    for (let i = 0; i < 800 && squad.some(u => u.order); i++) game.update(0.05);

    expect(searches).toBe(0); // never fell back to a global A* on open ground
    expect(squad.every(u => u.order === null)).toBe(true);
    expect(squad.every(u => Math.hypot(u.tx - 38, u.ty - 38) < 14)).toBe(true);
  });

  it('does not let an arrived ally push a formation marcher away from its path', () => {
    const { game, world } = openBattleGame(420);
    const marcher = game.spawnFighter('soldier', { x: 10, y: 10 }, 'player');
    const holder = game.spawnFighter('soldier', { x: 10, y: 10 }, 'player');
    holder.mesh.position.x += 0.2;
    marcher.order = {
      type: 'move', x: 20, y: 10, foe: null, building: null,
    };
    marcher.path = [{ x: 20, y: 10 }];
    marcher.pathI = 0;
    const mx = marcher.mesh.position.x;
    const hx = holder.mesh.position.x;

    (game as any).separate(0.05);

    // The holder keeps its exact formation slot. The marcher may move
    // sideways to avoid it, but crowd pressure may never send it backwards.
    expect(holder.mesh.position.x).toBe(hx);
    expect(marcher.mesh.position.x).toBeGreaterThanOrEqual(mx);
    expect(marcher.mesh.position.x).toBeLessThanOrEqual(world.wx(20));
  });

  it('lets serfs pass through builders without crowd displacement', () => {
    const { game } = openBattleGame(422);
    const serf = game.spawnUnit('serf', 0xffffff, { x: 10, y: 10 });
    const builder = game.spawnUnit('laborer', 0xffffff, { x: 10, y: 10 });
    builder.mesh.position.x += 0.2;
    builder.wstate = 'build';
    const serfPos = serf.mesh.position.clone();
    const builderPos = builder.mesh.position.clone();

    (game as any).separate(0.05);

    expect(serf.mesh.position).toEqual(serfPos);
    expect(builder.mesh.position).toEqual(builderPos);
  });

  it('has an explicitly ordered archer retreat into bow range before firing', () => {
    const { game } = openBattleGame(423);
    const archer = game.spawnFighter('archer', { x: 10, y: 10 }, 'player');
    const foe = game.spawnFighter('bandit', { x: 12, y: 10 }, 'enemy');
    foe.dmg = 0; foe.spd = 0; foe.hp = foe.maxHp = 1_000;

    game.orderUnit(archer, 'attack', foe.tx, foe.ty, foe);
    for (let i = 0; i < 80; i++) game.update(0.05);

    expect(Math.hypot(archer.mesh.position.x - foe.mesh.position.x, archer.mesh.position.z - foe.mesh.position.z)).toBeGreaterThanOrEqual(3.5);
    expect(foe.hp).toBeLessThan(foe.maxHp);
  });

  it('has an ordered priest follow the enemy at a safe healing distance', () => {
    const { game } = openBattleGame(424);
    const priest = game.spawnFighter('priest', { x: 10, y: 10 }, 'player');
    const ally = game.spawnFighter('soldier', { x: 9, y: 11 }, 'player');
    const foe = game.spawnFighter('bandit', { x: 12, y: 10 }, 'enemy');
    ally.hp = 10;
    foe.dmg = 0; foe.spd = 0; foe.hp = foe.maxHp = 1_000;

    game.orderUnit(priest, 'attack', foe.tx, foe.ty, foe);
    for (let i = 0; i < 80; i++) game.update(0.05);

    expect(priest.order?.type).toBe('attack');
    expect(priest.order?.foe).toBe(foe);
    expect(Math.hypot(priest.mesh.position.x - foe.mesh.position.x, priest.mesh.position.z - foe.mesh.position.z)).toBeGreaterThanOrEqual(3.5);
    expect(ally.hp).toBeGreaterThan(10);
  });

  it('turns a 500-plus formation through its old ranks without stranding a group', () => {
    const { game } = openBattleGame(421, 96);
    const squad = Array.from({ length: 520 }, (_, i) => {
      const u = game.spawnFighter('soldier', { x: 4 + i % 26, y: 10 + Math.floor(i / 26) }, 'player');
      u.hp = u.maxHp = 1_000;
      return u;
    });

    game.orderGroup(squad, 'move', 75, 24, null, 'box', { x: 1, y: 0 });
    for (let i = 0; i < 1_200 && squad.some(u => u.order); i++) game.update(0.05);
    expect(squad.every(u => u.order === null)).toBe(true);

    // A right-angle turn sends the rear through ranks that have already
    // reached their new slots—the dense traffic pattern that used to stall.
    game.orderGroup(squad, 'move', 68, 72, null, 'box', { x: 0, y: 1 });
    for (let i = 0; i < 1_200 && squad.some(u => u.order); i++) game.update(0.05);

    expect(squad.every(u => u.order === null)).toBe(true);
    expect(squad.every(u => Math.hypot(u.tx - 68, u.ty - 72) < 24)).toBe(true);
  }, 20_000);

  it('paths small selections with plain A* — no field is built', () => {
    const { game } = openBattleGame(419);
    const pair = [
      game.spawnFighter('soldier', { x: 4, y: 4 }, 'player'),
      game.spawnFighter('soldier', { x: 5, y: 4 }, 'player'),
    ];
    game.orderGroup(pair, 'move', 30, 30, null, 'box');
    expect(pair.every(u => u.order && !u.order.field)).toBe(true);
    for (let i = 0; i < 800 && pair.some(u => u.order); i++) game.update(0.05);
    expect(pair.every(u => Math.hypot(u.tx - 30, u.ty - 30) <= 3)).toBe(true);
  });

  it('chains explicit unit attacks and resumes attack-at-will afterward', () => {
    const { game } = openBattleGame(415);
    const first = game.spawnFighter('bandit', { x: 14, y: 24 }, 'enemy');
    const second = game.spawnFighter('bandit', { x: 17, y: 24 }, 'enemy');
    const ambient = game.spawnFighter('bandit', { x: 20, y: 24 }, 'enemy');
    first.hp = second.hp = 1;
    first.dmg = second.dmg = ambient.dmg = 0;
    ambient.hp = ambient.maxHp = 1_000;
    const soldier = game.spawnFighter('soldier', { x: 10, y: 24 }, 'player');
    soldier.hp = soldier.maxHp = 1_000;

    game.orderGroup([soldier], 'attack', first.tx, first.ty, first);
    game.orderGroup([soldier], 'attack', second.tx, second.ty, second, 'box', undefined, true);
    for (let i = 0; i < 500 && (soldier.order || ambient.hp === ambient.maxHp); i++) game.update(0.05);

    expect(first.dead).toBe(true);
    expect(second.dead).toBe(true);
    expect(soldier.order).toBeNull();
    expect(ambient.hp).toBeLessThan(ambient.maxHp);
  });

  it('never applies an AI home leash to a commanded player fighter', () => {
    const { game } = openBattleGame(416);
    const soldier = game.spawnFighter('soldier', { x: 3, y: 3 }, 'player');
    const enemy = game.spawnFighter('bandit', { x: 38, y: 38 }, 'enemy');
    enemy.dmg = 0;

    game.orderGroup([soldier], 'attack', enemy.tx, enemy.ty, enemy);
    for (let i = 0; i < 20; i++) game.update(0.05);

    expect(soldier.wstate).not.toBe('leash');
    expect(soldier.order?.foe).toBe(enemy);
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

describe('specialist staffing', () => {
  it('activates the building on the exact tick its worker reaches the entrance', () => {
    const { game } = openBattleGame(425, 32);
    const quarry = game.placeBuilding('quarry', 10, 10);
    const door = doorTile(quarry);
    const worker = game.spawnUnit('stonemason', 0x9aa0a3, { x: door.x - 1, y: door.y });
    worker.home = quarry;
    worker.wstate = 'goHome';
    worker.roleName = 'Stonemason';
    quarry.worker = worker;

    expect((game as any).sendTo(worker, door.x, door.y)).toBe(true);
    (game as any).workerUpdate(worker, 1);

    expect(worker.path).toBeNull();
    expect(worker.wstate).toBe('home');
    expect(quarry.active).toBe(true);
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

describe('production-chain routing priority', () => {
  it('deposits completed mint coins directly into spendable global stock', () => {
    const world = new World({ seed: 410, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const game = new Game(world, headlessView(world));
    game.init({ stock: { coin: 0 }, serfs: 0, laborers: 0, villagers: 0 });
    const mint = game.placeBuilding('mint', 7, 10, true);
    const minter = game.spawnUnit('minter', 0xd4af37, { x: 7, y: 10 });
    minter.home = mint;
    mint.worker = minter;
    mint.working = true;
    mint.prog = 0.99;

    game.update(0.1);

    expect(game.store.stock!.coin).toBe(1);
    expect(game.countItem('coin')).toBe(1);
    expect(mint.out.coin || 0).toBe(0);
    expect(mint.working).toBe(false);
    expect(game.trainUnit(game.guild, 'serf')).toBe(true);
    expect(game.store.stock!.coin).toBe(0);
  });

  it('routes capped gold and coal output directly to a waiting mint before storage', () => {
    const world = new World({ seed: 408, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 2, laborers: 0, villagers: 0 });
    const goldMine = game.placeBuilding('goldmine', 5, 5, true);
    const coalMine = game.placeBuilding('coalmine', 9, 5, true);
    const mint = game.placeBuilding('mint', 7, 10, true);
    goldMine.out.goldore = 5;
    coalMine.out.coal = 5;

    game.update(0.5);

    const tasks = game.units.filter(u => u.role === 'serf').map(u => u.task);
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task?.to === mint)).toBe(true);
    expect(tasks.map(task => task?.item).sort()).toEqual(['coal', 'goldore']);
    expect(goldMine.out.goldore).toBe(4);
    expect(coalMine.out.coal).toBe(4);
    expect(game.store.stock!.goldore).toBe(0);
    expect(game.store.stock!.coal).toBe(0);
  });

  it('uses storage as the fallback when no building is waiting for the output', () => {
    const world = new World({ seed: 409, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 1, laborers: 0, villagers: 0 });
    const goldMine = game.placeBuilding('goldmine', 5, 5, true);
    goldMine.out.goldore = 5;

    game.update(0.5);

    const serf = game.units.find(u => u.role === 'serf')!;
    expect(serf.task?.from).toBe(goldMine);
    expect(serf.task?.to).toBe(game.store);
    expect(serf.task?.item).toBe('goldore');
  });

  it('clears an unwanted capped output before unrelated input refills can starve it', () => {
    const world = new World({ seed: 411, w: 32, h: 32, treeStands: 0, oreVeins: 0, waterScale: 0, meadows: 0 });
    for (const row of world.tiles) for (const t of row) { t.type = 'grass'; t.rock = undefined; t.tree = null; t.dep = null; }
    const game = new Game(world, headlessView(world));
    game.init({ stock: { flour: 5 }, serfs: 1, laborers: 0, villagers: 0 });
    const bakery = game.placeBuilding('bakery', 10, 10, true);
    const goldMine = game.placeBuilding('goldmine', 5, 5, true);
    goldMine.out.goldore = 5;

    game.update(0.5);

    const serf = game.units.find(u => u.role === 'serf')!;
    expect(bakery.incoming.flour || 0).toBe(0);
    expect(serf.task?.from).toBe(goldMine);
    expect(serf.task?.to).toBe(game.store);
    expect(serf.task?.item).toBe('goldore');
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

describe('Dragon\u2019s Hoard encounter route', () => {
  it('places a camp, fortress, walled fortress, then dragon in increasing depth', () => {
    const level = LEVELS[9];
    const seed = 424242;
    simRng.reseed(seed ^ 0x5bd1e995);
    const world = new World({ seed, ...level.world, biome: 'gooi' });
    const game = new Game(world, headlessView(world));
    game.init({ stock: {}, serfs: 0, laborers: 0, villagers: 0 });
    game.setEnemies(level.enemies!);

    const camp = game.buildings.find(b => b.key === 'banditcamp')!;
    const keeps = game.buildings.filter(b => b.key === 'enemycastle');
    const dragon = game.units.find(u => u.role === 'dragon')!;
    const depth = (x: number, y: number) => Math.hypot(x - game.store.x, y - game.store.y);

    expect(camp).toBeTruthy();
    expect(keeps).toHaveLength(2);
    keeps.sort((a, b) => depth(a.x, a.y) - depth(b.x, b.y));
    expect(depth(keeps[0].x, keeps[0].y)).toBeGreaterThan(depth(camp.x, camp.y) + 8);
    expect(depth(keeps[1].x, keeps[1].y)).toBeGreaterThan(depth(keeps[0].x, keeps[0].y) + 8);
    expect(depth(dragon.tx, dragon.ty)).toBeGreaterThan(depth(keeps[1].x, keeps[1].y) + 8);
    expect(game.buildings.some(b => b.key === 'enemywall' || b.key === 'enemygate')).toBe(true);
    expect(game.buildings.filter(b => b.key === 'enemywatchtower').length).toBeGreaterThanOrEqual(3);
  });
});
