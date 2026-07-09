import { describe, expect, it } from 'vitest';
import { World, type WorldParams } from './World';

/** Serialize everything gameplay-relevant about a map into one string. */
function mapFingerprint(w: World): string {
  const parts: string[] = [];
  for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
    const t = w.tiles[y][x];
    parts.push(
      t.type, t.lake ? 'L' : '', t.rock ?? '',
      t.tree ? `t${t.tree.kind}:${t.tree.s.toFixed(4)}` : '',
      t.dep ? `d${t.dep.kind}:${t.dep.amt}` : '',
      t.deco ? `c${t.deco.kind}` : '',
      t.pickup ? `p${t.pickup.gold}` : '',
    );
  }
  return parts.join('|');
}

const PARAMS: Omit<WorldParams, 'seed'> = {
  w: 40, h: 40, treeStands: 6, oreVeins: 5, waterScale: 0.8, meadows: 3,
  goldPiles: 3, mountains: 2, ruins: 1,
};

describe('World generation', () => {
  it('is deterministic: same seed → identical map', () => {
    const a = new World({ seed: 987654, ...PARAMS });
    const b = new World({ seed: 987654, ...PARAMS });
    expect(mapFingerprint(a)).toBe(mapFingerprint(b));
  });

  it('differs across seeds', () => {
    const a = new World({ seed: 987654, ...PARAMS });
    const b = new World({ seed: 987655, ...PARAMS });
    expect(mapFingerprint(a)).not.toBe(mapFingerprint(b));
  });

  it('guarantees the timber and ore chains are viable', () => {
    for (const seed of [1, 31337, 2147483645]) {
      const w = new World({ seed, ...PARAMS });
      let trees = 0;
      const ore = { stone: 0, gold: 0, coal: 0, iron: 0 };
      for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
        const t = w.tiles[y][x];
        if (t.tree) trees++;
        if (t.dep) ore[t.dep.kind]++;
      }
      expect(trees).toBeGreaterThanOrEqual(14);
      for (const k of ['stone', 'gold', 'coal', 'iron'] as const) expect(ore[k]).toBeGreaterThanOrEqual(6);
    }
  });

  it('keeps the central build zone clear of water and rock', () => {
    const w = new World({ seed: 555, ...PARAMS });
    const cx = Math.floor(w.W / 2), cy = Math.floor(w.H / 2);
    for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
      expect(w.tiles[y][x].type).toBe('grass');
    }
  });

  it('requests the exact map size', () => {
    const w = new World({ seed: 1, ...PARAMS });
    expect(w.W).toBe(40);
    expect(w.H).toBe(40);
    expect(w.tiles.length).toBe(40);
    expect(w.tiles[0].length).toBe(40);
  });
});
