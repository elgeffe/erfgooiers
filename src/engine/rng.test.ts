import { describe, expect, it } from 'vitest';
import { Rng, levelSeed } from './rng';

describe('Rng', () => {
  it('is reproducible for the same seed', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('diverges for different seeds', () => {
    const a = new Rng(1), b = new Rng(2);
    const sa = Array.from({ length: 8 }, () => a.next());
    const sb = Array.from({ length: 8 }, () => b.next());
    expect(sa).not.toEqual(sb);
  });

  it('reseed restarts the stream exactly', () => {
    const r = new Rng(7);
    const first = [r.next(), r.next(), r.next()];
    r.reseed(7);
    expect([r.next(), r.next(), r.next()]).toEqual(first);
  });

  it('stays in [0, 1) and int/range respect bounds', () => {
    const r = new Rng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    for (let i = 0; i < 200; i++) {
      const n = r.int(5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
      const f = r.range(2, 4);
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThan(4);
    }
  });

  it('handles the degenerate seed 0', () => {
    const r = new Rng(0);
    expect(r.next()).toBeGreaterThanOrEqual(0);
  });
});

describe('levelSeed', () => {
  it('is a pure function of (runSeed, levelIndex)', () => {
    expect(levelSeed(123456, 3)).toBe(levelSeed(123456, 3));
    expect(levelSeed(123456, 3)).not.toBe(levelSeed(123456, 4));
    expect(levelSeed(123456, 3)).not.toBe(levelSeed(123457, 3));
  });

  it('always lands in the Lehmer-safe range [1, 2147483646]', () => {
    for (let run = 1; run < 50; run++) for (let lvl = 1; lvl <= 10; lvl++) {
      const s = levelSeed(run * 48611, lvl);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(2147483646);
    }
  });
});
