import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/rng';
import { makeSkirmishGame } from '../../src/game/testHarness';
import { findPath } from '../../src/engine/pathfinding';
import { doorTile } from '../../src/game/util';
import { perceive } from '../../src/ai/perception';
import { findBuildingSpot, planPlots } from '../../src/ai/actuation';
import { applyGameCommand } from '../../src/game/commands';
import type { Coord } from '../../src/types';

const footprintGap = (a: Coord, b: Coord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) - 2;
const chebyshev = (a: Coord, b: Coord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe('AI placement search', () => {
  it('finds legal, reachable, own-half spots the validator accepts', () => {
    const { game, world } = makeSkirmishGame(1000);
    const rng = new Rng(1);
    const enemy = game.storeFor('p2');
    const home = game.storeFor('p1');
    const homeDoor = doorTile(home);
    for (const key of ['woodcutter', 'quarry', 'goldmine', 'barracks', 'farm'] as const) {
      // Sites placed earlier in this loop are part of the next decision. A stale
      // view would hide them from the spacing and resource-reservation policy.
      const view = perceive(game, world, 'p1');
      const spot = findBuildingSpot(game, world, view, key, rng, { x: home.x + 7, y: home.y });
      expect(spot, `no spot found for ${key}`).not.toBeNull();
      expect(game.canPlace(key, spot!.x, spot!.y, spot!.rot)).toBe(true);
      const wantedGap = key === 'farm' ? 4 : key === 'quarry' || key === 'goldmine' ? 1 : 3;
      const nearest = Math.min(...[...view.buildings, ...view.sites].map(building => footprintGap(spot!, building)));
      expect(nearest, `${key} was packed too tightly`).toBeGreaterThanOrEqual(wantedGap);
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

  it('samples outer rings without exceeding the exact-placement budget', () => {
    const { game, world } = makeSkirmishGame(1000);
    const view = perceive(game, world, 'p1');
    const home = game.storeFor('p1');
    const originalCanPlace = game.canPlace.bind(game);
    let exactCalls = 0;
    game.canPlace = (key, x, y, rot) => { exactCalls++; return originalCanPlace(key, x, y, rot); };

    const spot = findBuildingSpot(game, world, view, 'barracks', new Rng(1), { x: home.x + 7, y: home.y });
    expect(spot).not.toBeNull();
    const nearest = Math.min(...view.buildings.map(building => footprintGap(spot!, building)));
    expect(nearest).toBeGreaterThanOrEqual(3);
    // The old first-20 search stopped on radius three; a two-tile gap around
    // the starting castle requires looking at least one ring farther out.
    expect(Math.max(Math.abs(spot!.x - home.x), Math.abs(spot!.y - home.y))).toBeGreaterThanOrEqual(4);
    expect(exactCalls).toBeLessThanOrEqual(112); // (20 + 6 + 2) candidates x four rotations
  });

  it('honours an explicit anchor for a forward defensive building', () => {
    const { game, world } = makeSkirmishGame(1000);
    const view = perceive(game, world, 'p1');
    const home = game.storeFor('p1');
    const approach = { x: home.x + 7, y: home.y };
    const override = {
      x: Math.round(home.x + (Math.floor(world.W / 2) - home.x) * 0.55),
      y: Math.round(home.y + (Math.floor(world.H / 2) - home.y) * 0.55),
    };

    const spot = findBuildingSpot(game, world, view, 'stonetower', new Rng(81), approach, 46, override);

    expect(spot).not.toBeNull();
    expect(game.canPlace('stonetower', spot!.x, spot!.y, spot!.rot)).toBe(true);
    expect(chebyshev(spot!, override)).toBeLessThanOrEqual(8);
    expect(chebyshev(spot!, override)).toBeLessThan(chebyshev(spot!, home));
    expect(chebyshev(spot!, override)).toBeLessThan(chebyshev(spot!, approach));
    expect(findPath(world, doorTile(home).x, doorTile(home).y, doorTile(spot!).x, doorTile(spot!).y, 'p1')).not.toBeNull();
  });

  it('can constrain a dependent building to its producer working radius', () => {
    const { game, world } = makeSkirmishGame(1000);
    const view = perceive(game, world, 'p1');
    const home = game.storeFor('p1');
    const woodcutter = { x: home.x + 12, y: home.y + 5 };
    const spot = findBuildingSpot(
      game, world, view, 'forester', new Rng(19),
      { x: home.x + 7, y: home.y }, 46, woodcutter, 9,
    );

    expect(spot).not.toBeNull();
    expect(chebyshev(spot!, woodcutter)).toBeLessThanOrEqual(9);
    expect(game.canPlace('forester', spot!.x, spot!.y, spot!.rot)).toBe(true);
  });

  it('keeps broad lanes through a growing ordinary settlement', () => {
    const { game, world } = makeSkirmishGame(1000);
    const home = game.storeFor('p1');
    const rng = new Rng(99);
    for (const key of ['sawmill', 'mill', 'bakery', 'mint', 'barracks', 'stable', 'engineer', 'monastery'] as const) {
      const view = perceive(game, world, 'p1');
      const spot = findBuildingSpot(game, world, view, key, rng, { x: home.x + 7, y: home.y }, 46);
      expect(spot, `no spot found for ${key}`).not.toBeNull();
      const nearest = Math.min(...[...view.buildings, ...view.sites].map(building => footprintGap(spot!, building)));
      expect(nearest, `${key} narrowed an existing lane`).toBeGreaterThanOrEqual(3);
      expect(game.canPlace(key, spot!.x, spot!.y, spot!.rot)).toBe(true);
      game.placeBuilding(key, spot!.x, spot!.y, true, spot!.rot, 'player', 'p1');
    }
  });

  it('is deterministic across identical placement sequences', () => {
    const sequence = (): { x: number; y: number; rot: number }[] => {
      const { game, world } = makeSkirmishGame(1701);
      const rng = new Rng(77);
      const home = game.storeFor('p1');
      const spots: { x: number; y: number; rot: number }[] = [];
      for (const key of ['woodcutter', 'sawmill', 'quarry', 'farm', 'barracks'] as const) {
        const view = perceive(game, world, 'p1');
        const spot = findBuildingSpot(game, world, view, key, rng, { x: home.x + 7, y: home.y });
        expect(spot).not.toBeNull();
        spots.push(spot!);
        game.placeBuilding(key, spot!.x, spot!.y, true, spot!.rot, 'player', 'p1');
      }
      return spots;
    };
    expect(sequence()).toEqual(sequence());
  });

  it('places a fishery only where a reachable open shore can be worked', () => {
    const { game, world } = makeSkirmishGame(1000);
    const view = perceive(game, world, 'p1');
    const home = game.storeFor('p1');
    const spot = findBuildingSpot(game, world, view, 'fishery', new Rng(9), { x: home.x + 7, y: home.y });
    expect(spot).not.toBeNull();
    const before = game.sites.length;
    applyGameCommand(game, 'p1', { type: 'placeBuilding', key: 'fishery', x: spot!.x, y: spot!.y, rot: spot!.rot });
    expect(game.sites.length).toBe(before + 1); // exact sim shore validator accepted it
    expect(findPath(world, doorTile(home).x, doorTile(home).y, doorTile(spot!).x, doorTile(spot!).y, 'p1')).not.toBeNull();
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
