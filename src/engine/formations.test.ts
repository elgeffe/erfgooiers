import { describe, expect, it } from 'vitest';
import { formationSpots } from './formations';

const open = () => true;

describe('formationSpots', () => {
  it('returns distinct usable destinations for every shape', () => {
    for (const shape of ['grid', 'line', 'column', 'wedge'] as const) {
      const spots = formationSpots(10, 10, 8, shape, [{ x: 0, y: 10 }], open);
      expect(spots).toHaveLength(8);
      expect(new Set(spots.map(p => `${p.x},${p.y}`)).size).toBe(8);
    }
  });

  it('orients line across travel and column along travel', () => {
    const line = formationSpots(10, 10, 5, 'line', [{ x: 0, y: 10 }], open);
    expect(new Set(line.map(p => p.x))).toEqual(new Set([10]));
    const column = formationSpots(10, 10, 5, 'column', [{ x: 0, y: 10 }], open);
    expect(new Set(column.map(p => p.y))).toEqual(new Set([10]));
  });

  it('fills blocked planned slots from nearby free tiles', () => {
    const spots = formationSpots(5, 5, 4, 'grid', [{ x: 0, y: 5 }], (x, y) => !(x === 5 && y === 5));
    expect(spots).toHaveLength(4);
    expect(spots).not.toContainEqual({ x: 5, y: 5 });
  });
});
