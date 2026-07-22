import { describe, expect, it } from 'vitest';
import { DEFS } from '../../src/data/buildings';
import { buildingEntranceTiles } from '../../src/game/util';

describe('buildingEntranceTiles', () => {
  it('gives walls no entrances', () => {
    expect(buildingEntranceTiles({ x: 5, y: 5, def: DEFS.wall })).toEqual([]);
    expect(buildingEntranceTiles({ x: 5, y: 5, def: DEFS.woodwall })).toEqual([]);
    expect(buildingEntranceTiles({ x: 5, y: 5, def: DEFS.enemywall })).toEqual([]);
  });
  it('gives gates two entrances on both opposite faces', () => {
    expect(buildingEntranceTiles({ x: 5, y: 5, rot: 0, def: DEFS.gate })).toEqual([
      { x: 5, y: 4 }, { x: 6, y: 4 }, { x: 5, y: 7 }, { x: 6, y: 7 },
    ]);
    expect(buildingEntranceTiles({ x: 5, y: 5, rot: 0, def: DEFS.woodgate })).toEqual([
      { x: 5, y: 4 }, { x: 6, y: 4 }, { x: 5, y: 7 }, { x: 6, y: 7 },
    ]);
    expect(buildingEntranceTiles({ x: 5, y: 5, rot: 1, def: DEFS.gate })).toEqual([
      { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 7, y: 5 }, { x: 7, y: 6 },
    ]);
  });
  it('keeps a normal building single-fronted', () => {
    expect(buildingEntranceTiles({ x: 5, y: 5, rot: 0, def: DEFS.bakery })).toEqual([{ x: 5, y: 7 }]);
  });
});
