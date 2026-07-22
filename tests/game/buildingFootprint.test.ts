import { describe, expect, it } from 'vitest';
import { DEFS } from '../../src/data/buildings';
import { buildingFootprint, buildingFootprintCenter, buildingFootprintTiles } from '../../src/engine/buildingFootprint';
import { makeOpenBattleGame } from '../../src/game/testHarness';

describe('rotated building footprints', () => {
  it('rotates wooden walls and gates between 2x1 and 1x2', () => {
    expect(buildingFootprint(DEFS.woodwall, 0)).toEqual({ width: 2, height: 1 });
    expect(buildingFootprint(DEFS.woodwall, 1)).toEqual({ width: 1, height: 2 });
    expect(buildingFootprintCenter({ x: 8, y: 9, rot: 0, def: DEFS.woodwall })).toEqual({ x: 8.5, y: 9 });
    expect(buildingFootprintCenter({ x: 8, y: 9, rot: 1, def: DEFS.woodwall })).toEqual({ x: 8, y: 9.5 });
    expect(buildingFootprintTiles({ x: 8, y: 9, rot: 3, def: DEFS.woodgate })).toEqual([
      { x: 8, y: 9 }, { x: 8, y: 10 },
    ]);
  });

  it('occupies and clears only the two rotated tiles in the world', () => {
    const { game, world } = makeOpenBattleGame();
    const wall = game.placeBuilding('woodwall', 20, 20, true, 0, 'player', 'p1');
    expect(world.T(20, 20)?.b).toBe(wall);
    expect(world.T(21, 20)?.b).toBe(wall);
    expect(world.T(20, 21)?.b).toBeNull();
    expect(game.canPlace('woodwall', 20, 21, 0)).toBe(true);

    game.demolishAt(20, 20, false, 'p1');
    expect(world.T(20, 20)?.b).toBeNull();
    expect(world.T(21, 20)?.b).toBeNull();

    const gate = game.placeBuilding('woodgate', 20, 20, true, 1, 'player', 'p1');
    expect(world.T(20, 20)?.b).toBe(gate);
    expect(world.T(20, 21)?.b).toBe(gate);
    expect(world.T(21, 20)?.b).toBeNull();
    expect(world.passable(20, 21, 'p1')).toBe(true);
    expect(world.passable(20, 21, 'enemy')).toBe(false);
  });
});
