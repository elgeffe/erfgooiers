import { describe, expect, it } from 'vitest';
import { perceive } from '../../src/ai/perception';
import { makeSkirmishGame, tick } from '../../src/game/testHarness';

describe('fog of war (information layer)', () => {
  it('with fog off, every tile is visible to every seat', () => {
    const { game, world } = makeSkirmishGame(21, undefined, false);
    expect(game.fogOfWar).toBe(false);
    expect(game.visibleTo('p1', 0, 0)).toBe(true);
    expect(game.visibleTo('p1', world.W - 1, world.H - 1)).toBe(true);
  });

  it('with fog on, a seat sees its own base but not the far corner', () => {
    const { game, world } = makeSkirmishGame(21);
    expect(game.fogOfWar).toBe(true);
    tick(game, 1);
    const own = game.storeFor('p1');
    const rival = game.storeFor('p2');
    expect(game.visibleTo('p1', own.x + 1, own.y + 1)).toBe(true);
    // opposite-corner rival castle is far outside any p1 sight radius
    expect(game.visibleTo('p1', rival.x + 1, rival.y + 1)).toBe(false);
    expect(game.visibleTo('p2', rival.x + 1, rival.y + 1)).toBe(true);
    expect(world.W).toBeGreaterThan(40); // the arena is big enough for the claim above
  });

  it('perception hides the fogged rival army but keeps the known castle', () => {
    const foggy = makeSkirmishGame(33);
    tick(foggy.game, 1);
    const fogged = perceive(foggy.game, foggy.world, 'p1');
    expect(fogged.enemyArmySize).toBe(0);            // rival warband is unseen
    expect(fogged.enemyStore).not.toBeNull();        // spawn corners are map knowledge

    const clear = makeSkirmishGame(33, undefined, false);
    tick(clear.game, 1);
    const seen = perceive(clear.game, clear.world, 'p1');
    expect(seen.enemyArmySize).toBeGreaterThan(0);   // same sim, fog off — army visible
  });

  it('a watchtower extends sight well beyond ordinary building range', () => {
    const { game } = makeSkirmishGame(5);
    const store = game.storeFor('p1');
    // a completed tower far enough from the rest of the base that its ring is its own
    const tower = game.placeBuilding('watchtower', store.x + 2, store.y + 12, true, 0, 'player', 'p1');
    tick(game, 1);
    expect(tower).toBeTruthy();
    const cx = store.x + 3, cy = store.y + 13;
    expect(game.visibleTo('p1', cx, cy + 13)).toBe(true);   // inside tower sight (15)
    expect(game.visibleTo('p1', cx, cy + 20)).toBe(false);  // beyond it
  });

  it('a hostile that walks into sight range becomes visible', () => {
    const { game } = makeSkirmishGame(5);
    const own = game.storeFor('p1');
    const scout = game.units.find(u => u.owner === 'p2' && u.dmg > 0)!;
    expect(game.visibleTo('p1', scout.tx, scout.ty)).toBe(false);
    // teleport the rival soldier next to p1's castle and let the cache refresh
    scout.tx = own.x + 3; scout.ty = own.y + 3;
    tick(game, 1);
    expect(game.visibleTo('p1', scout.tx, scout.ty)).toBe(true);
  });
});
