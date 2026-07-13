import { describe, expect, it } from 'vitest';
import { World, type WorldParams } from './World';
import { BIOMES, type BiomeKey } from '../data/biomes';

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

describe('Biome worldgen', () => {
  it('keeps the build zone clear and the chains viable in every biome', () => {
    for (const biome of Object.keys(BIOMES) as BiomeKey[]) {
      const w = new World({ seed: 4242, ...PARAMS, biome });
      const cx = Math.floor(w.W / 2), cy = Math.floor(w.H / 2);
      for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
        expect(w.tiles[y][x].type, `${biome} centre ${x},${y}`).toBe('grass');
      }
      let trees = 0;
      const ore = { stone: 0, gold: 0, coal: 0, iron: 0 };
      for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
        const t = w.tiles[y][x];
        if (t.tree) trees++;
        if (t.dep) ore[t.dep.kind]++;
      }
      expect(trees, `${biome} trees`).toBeGreaterThanOrEqual(14);
      for (const k of ['stone', 'gold', 'coal', 'iron'] as const) {
        expect(ore[k], `${biome} ${k}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('island maps are ringed by fishable sea', () => {
    for (const seed of [7, 31337]) {
      const w = new World({ seed, ...PARAMS, biome: 'island' });
      for (const [x, y] of [[0, 0], [w.W - 1, 0], [0, w.H - 1], [w.W - 1, w.H - 1]]) {
        expect(w.tiles[y][x].type).toBe('water');
        expect(w.tiles[y][x].lake).toBe(true);
      }
    }
  });

  it('seaside maps record their coast direction, and the sea lies that way', () => {
    for (const seed of [7, 31337]) {
      const w = new World({ seed, ...PARAMS, biome: 'seaside' });
      expect(w.coastDir).not.toBeNull();
      const cd = w.coastDir!;
      const ex = cd.x > 0 ? w.W - 1 : cd.x < 0 ? 0 : Math.floor(w.W / 2);
      const ey = cd.y > 0 ? w.H - 1 : cd.y < 0 ? 0 : Math.floor(w.H / 2);
      expect(w.tiles[ey][ex].type).toBe('water');
      expect(w.tiles[ey][ex].lake).toBe(true);
    }
  });

  it('inland biomes claim no coast', () => {
    const w = new World({ seed: 7, ...PARAMS, biome: 'gooi' });
    expect(w.coastDir).toBeNull();
  });

  it('keeps the enemy quarter reachable on delta frontier maps', () => {
    // level 7 plays in the Zeeland Delta with a frontier arc from Very Hard up:
    // the sea and river must never seal the pass into the enemy's corner
    for (const seed of [1, 7, 42, 31337, 987654]) {
      const w = new World({ seed, w: 64, h: 64, treeStands: 11, oreVeins: 9, waterScale: 1.0, meadows: 6, mountains: 2, ruins: 2, frontier: true, biome: 'seaside' });
      expect(w.enemyZone).not.toBeNull();
      const ez = w.enemyZone!;
      // BFS over passable tiles from the map centre
      const seen = new Set<number>();
      const queue: [number, number][] = [[Math.floor(w.W / 2), Math.floor(w.H / 2)]];
      seen.add(queue[0][1] * w.W + queue[0][0]);
      let reached = false;
      while (queue.length && !reached) {
        const [x, y] = queue.shift()!;
        if (Math.hypot(x - ez.x, y - ez.y) <= ez.r) { reached = true; break; }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, id = ny * w.W + nx;
          if (seen.has(id) || !w.passable(nx, ny)) continue;
          seen.add(id); queue.push([nx, ny]);
        }
      }
      expect(reached, `seed ${seed}`).toBe(true);
    }
  });

});
