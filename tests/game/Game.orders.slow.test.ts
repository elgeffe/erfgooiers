import { describe, expect, it } from 'vitest';
import { World } from '../../src/world/World';
import { simRng } from '../../src/engine/rng';
import { Game } from '../../src/game/Game';
import { makeOpenBattleGame, stubView } from '../../src/game/testHarness';

const openBattleGame = (seed = 404, size = 48) => makeOpenBattleGame(seed, size);

describe('Game siege orders', () => {
  it('spawns wild animals far from a corner castle rather than the map centre', () => {
    const world = new World({
      seed: 2, w: 64, h: 64, treeStands: 11, oreVeins: 9,
      waterScale: 1, meadows: 6, mountains: 2, frontier: true,
    });
    const game = new Game(world, stubView(world));
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
    const game = new Game(world, stubView(world));
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
    // Once the queued move completes, attack-at-will may immediately pull the
    // unit off its exact destination toward the guard. The damaged guard is
    // the behavior under test; a final tile would couple this to target jitter.
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

