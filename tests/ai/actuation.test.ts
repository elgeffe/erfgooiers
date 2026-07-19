import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/rng';
import { makeSkirmishGame } from '../../src/game/testHarness';
import { findPath } from '../../src/engine/pathfinding';
import { doorTile } from '../../src/game/util';
import { perceive } from '../../src/ai/perception';
import { findBuildingSpot, planPlots } from '../../src/ai/actuation';
import { applyGameCommand } from '../../src/game/commands';

describe('AI placement search', () => {
  it('finds legal, reachable, own-half spots the validator accepts', () => {
    const { game, world } = makeSkirmishGame(1000);
    const rng = new Rng(1);
    const view = perceive(game, world, 'p1');
    const enemy = game.storeFor('p2');
    const home = game.storeFor('p1');
    const homeDoor = doorTile(home);
    for (const key of ['woodcutter', 'quarry', 'goldmine', 'barracks', 'farm'] as const) {
      const spot = findBuildingSpot(game, world, view, key, rng, { x: home.x + 7, y: home.y });
      expect(spot, `no spot found for ${key}`).not.toBeNull();
      expect(game.canPlace(key, spot!.x, spot!.y, spot!.rot)).toBe(true);
      // the placement seam accepts it as a site
      const before = game.sites.length;
      const result = applyGameCommand(game, 'p1', { type: 'placeBuilding', key, x: spot!.x, y: spot!.y, rot: spot!.rot });
      expect(result.ok).toBe(true);
      expect(game.sites.length).toBe(before + 1);
      // never in the rival's half, and always walkable from the own castle
      const own = Math.max(Math.abs(spot!.x - home.x), Math.abs(spot!.y - home.y));
      const rival = Math.max(Math.abs(spot!.x - enemy.x), Math.abs(spot!.y - enemy.y));
      expect(own).toBeLessThanOrEqual(rival);
      expect(findPath(world, homeDoor.x, homeDoor.y, doorTile(spot!).x, doorTile(spot!).y, 'p1')).not.toBeNull();
    }
  });

  it('plans only plot cells the sim itself accepts', () => {
    const { game, world } = makeSkirmishGame(1000);
    const rng = new Rng(2);
    const view = perceive(game, world, 'p1');
    const home = game.storeFor('p1');
    const spot = findBuildingSpot(game, world, view, 'farm', rng, { x: home.x + 7, y: home.y });
    expect(spot).not.toBeNull();
    const farm = game.placeBuilding('farm', spot!.x, spot!.y, true, spot!.rot, 'player', 'p1');
    const cells = planPlots(game, farm);
    expect(cells.length).toBeGreaterThanOrEqual(6);
    const result = applyGameCommand(game, 'p1', { type: 'placePlots', buildingId: farm.id, cells });
    expect(result.ok).toBe(true);
    expect(farm.fieldsList.length).toBe(cells.length);
  });
});

describe('skirmish economy ownership', () => {
  it("a mint's coin lands in its OWNER's castle, not the primary store", () => {
    const { game } = makeSkirmishGame(1000);
    const enemyStore = game.storeFor('p2');
    const mint = game.placeBuilding('mint', enemyStore.x + 4, enemyStore.y + 4, true, 0, 'player', 'p2');
    mint.working = true;
    mint.prog = 2; // recipe complete on the next worker tick
    const worker = game.spawnUnit('minter', 0xd4af37, { x: mint.x, y: mint.y }, 'p2');
    worker.home = mint;
    mint.worker = worker;
    worker.wstate = 'home';
    const p1Before = game.storeFor('p1').stock!.coin ?? 0;
    const p2Before = game.storeFor('p2').stock!.coin ?? 0;
    game.update(1 / 20);
    expect(game.storeFor('p2').stock!.coin).toBe(p2Before + 1);
    expect(game.storeFor('p1').stock!.coin).toBe(p1Before);
  });
});
