import { describe, expect, it } from 'vitest';
import { formationSpots } from './formations';

const open = () => true;

describe('formationSpots', () => {
  it('returns distinct usable destinations for every shape', () => {
    for (const shape of ['box', 'line', 'split'] as const) {
      const spots = formationSpots(10, 10, 8, shape, [{ x: 0, y: 10 }], open);
      expect(spots).toHaveLength(8);
      expect(new Set(spots.map(p => `${p.x},${p.y}`)).size).toBe(8);
    }
  });

  it('holds shape at huge counts: every slot distinct, ranks bounded', () => {
    for (const shape of ['box', 'line', 'split'] as const) {
      const spots = formationSpots(100, 100, 200, shape, [{ x: 0, y: 100 }], open);
      expect(spots).toHaveLength(200);
      expect(new Set(spots.map(p => `${p.x},${p.y}`)).size).toBe(200);
      // nothing may end up absurdly far from the click point
      for (const p of spots) expect(Math.hypot(p.x - 100, p.y - 100)).toBeLessThan(60);
    }
  });

  it('caps the line at three ranks, spread across travel', () => {
    // approaching from the west (-x): ranks stack along x, width along y
    const line = formationSpots(50, 50, 60, 'line', [{ x: 0, y: 50 }], open);
    const xs = new Set(line.map(p => p.x));
    expect(xs.size).toBeLessThanOrEqual(3);
    const ys = new Set(line.map(p => p.y));
    expect(ys.size).toBeGreaterThanOrEqual(20);
  });

  it('split forms two groups with a gap between them', () => {
    const spots = formationSpots(50, 50, 40, 'split', [{ x: 0, y: 50 }], open);
    const left = spots.filter(p => p.y < 50), right = spots.filter(p => p.y > 50);
    expect(left.length).toBeGreaterThanOrEqual(15);
    expect(right.length).toBeGreaterThanOrEqual(15);
    // the middle stays clear
    expect(spots.filter(p => Math.abs(p.y - 50) <= 1).length).toBe(0);
  });

  it('fills blocked planned slots from nearby free tiles', () => {
    const spots = formationSpots(5, 5, 4, 'box', [{ x: 0, y: 5 }], (x, y) => !(x === 5 && y === 5));
    expect(spots).toHaveLength(4);
    expect(spots).not.toContainEqual({ x: 5, y: 5 });
  });

  it('an explicit facing overrides the origin-derived direction', () => {
    // the army approaches from the west, but the drag aims it north (-y):
    // the line must spread across x and stack its ranks along y
    const spots = formationSpots(50, 50, 30, 'line', [{ x: 0, y: 50 }], open, { x: 0, y: -1 });
    const xs = new Set(spots.map(p => p.x));
    expect(xs.size).toBeGreaterThanOrEqual(10);
    // front rank first: smallest y (furthest north) leads
    for (let i = 1; i < spots.length; i++) expect(spots[i].y).toBeGreaterThanOrEqual(spots[i - 1].y);
    // a zero-length facing falls back to the origin-derived direction
    const fallback = formationSpots(50, 50, 30, 'line', [{ x: 0, y: 50 }], open, { x: 0, y: 0 });
    expect(fallback).toEqual(formationSpots(50, 50, 30, 'line', [{ x: 0, y: 50 }], open));
  });

  it('orders spots front rank first, along the direction of travel', () => {
    // approaching from the west (-x): the army faces +x, so the front rank
    // (largest x) must come back before deeper ranks (smaller x)
    for (const shape of ['box', 'line', 'split'] as const) {
      const spots = formationSpots(50, 50, 30, shape, [{ x: 0, y: 50 }], open);
      const depths = spots.map(p => p.x);
      // non-increasing x: each spot is at or behind the previous one
      for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeLessThanOrEqual(depths[i - 1]);
    }
  });
});
