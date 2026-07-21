import { describe, expect, it } from 'vitest';
import { applyGameCommand } from '../../src/game/commands';
import { makeTestGame, tick, tickUntil } from '../../src/game/testHarness';

describe('building repair as a physical job', () => {
  it('opens a repair order instead of mending instantly', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    store.hp = Math.round(store.maxHp * 0.3);
    const hurt = store.hp;

    const result = applyGameCommand(game, 'p1', { type: 'repair', buildingId: store.id });
    expect(result.ok).toBe(true);
    expect(store.repair).toBeTruthy();
    expect(store.hp).toBe(hurt); // no instant heal — the crew has not even started
    expect(store.repair!.needs).toEqual(game.repairCost(store));

    // a second order on the same building is refused while one is open
    expect(applyGameCommand(game, 'p1', { type: 'repair', buildingId: store.id }).ok).toBe(false);
  });

  it('refuses repair on another player\'s building and on healthy ones', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p2');
    store.hp = Math.round(store.maxHp * 0.5);
    expect(applyGameCommand(game, 'p1', { type: 'repair', buildingId: store.id }).ok).toBe(false);
    const own = game.storeFor('p1');
    expect(applyGameCommand(game, 'p1', { type: 'repair', buildingId: own.id }).ok).toBe(false);
  });

  it('serfs haul the materials, then a builder mends the building over time', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    store.hp = Math.round(store.maxHp * 0.3);
    applyGameCommand(game, 'p1', { type: 'repair', buildingId: store.id });
    const repair = store.repair!;
    const cost = game.repairCost(store);

    // the castle's own stock covers the bill (default kit: timber 16, stone 10)
    for (const item in cost) expect(store.stock![item]).toBeGreaterThanOrEqual(cost[item]);

    expect(tickUntil(game, () => repair.ready, 120)).toBe(true);
    for (const item in cost) expect(repair.delivered[item]).toBe(cost[item]);

    // materials landed but health has not jumped — the builder works it away
    expect(store.hp).toBeLessThan(store.maxHp);
    expect(tickUntil(game, () => store.hp >= store.maxHp, 300)).toBe(true);
    expect(store.repair).toBeUndefined();
  });

  it('repair speed follows the repairTime modifier, far slower than a click', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    store.hp = Math.round(store.maxHp * 0.3);
    applyGameCommand(game, 'p1', { type: 'repair', buildingId: store.id });
    tick(game, 10); // hauling + builder walk; nowhere near a full mend yet
    expect(store.hp).toBeLessThan(store.maxHp);
  });
});
