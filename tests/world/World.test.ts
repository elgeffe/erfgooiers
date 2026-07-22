import { describe, expect, it } from 'vitest';
import { World, diagonalSpawns, type WorldParams } from '../../src/world/World';
import { BIOMES, type BiomeKey } from '../../src/data/biomes';
import { SKIRMISH_LEVEL } from '../../src/data/skirmishLevels';

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
      for (const k of ['stone', 'gold', 'iron'] as const) expect(ore[k]).toBeGreaterThanOrEqual(6);
      expect(ore.coal).toBeGreaterThanOrEqual(12);
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

describe('Arena worldgen', () => {
  it('keeps water off both corner spawn build zones on every seed and biome', () => {
    // seaside/island coasts and the wandering lake all must clear the corners
    const biomes: BiomeKey[] = ['gooi', 'seaside', 'polder', 'island'];
    for (const biome of biomes) for (let seed = 1; seed <= 12; seed++) {
      const world = new World({ seed: seed * 7919, ...SKIRMISH_LEVEL.world, biome });
      for (const spawn of diagonalSpawns(world.W, world.H)) {
        for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
          if (Math.hypot(dx, dy) > 10) continue;
          const tile = world.T(spawn.x + dx, spawn.y + dy);
          expect(tile?.type, `${biome} seed ${seed * 7919} water at ${spawn.x + dx},${spawn.y + dy}`).not.toBe('water');
        }
      }
    }
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
      for (const k of ['stone', 'gold', 'iron'] as const) {
        expect(ore[k], `${biome} ${k}`).toBeGreaterThanOrEqual(6);
      }
      expect(ore.coal, `${biome} coal`).toBeGreaterThanOrEqual(12);
    }
  });

  it('retains every ore minimum after clearing a corner castle apron and frontier paths', () => {
    for (const seed of [1, 7, 42, 1260, 31337, 987654]) {
      const w = new World({
        seed, w: 64, h: 64, treeStands: 11, oreVeins: 5, waterScale: 1.2,
        meadows: 6, mountains: 2, frontier: true, biome: 'seaside',
      });
      const ore = { stone: 0, gold: 0, coal: 0, iron: 0 };
      for (const row of w.tiles) for (const tile of row) if (tile.dep) ore[tile.dep.kind]++;
      expect(ore.stone, `seed ${seed} stone`).toBeGreaterThanOrEqual(6);
      expect(ore.gold, `seed ${seed} gold`).toBeGreaterThanOrEqual(6);
      expect(ore.coal, `seed ${seed} coal`).toBeGreaterThanOrEqual(12);
      expect(ore.iron, `seed ${seed} iron`).toBeGreaterThanOrEqual(6);
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
      // BFS over passable tiles from the campaign's (possibly offset) castle
      const seen = new Set<number>();
      const queue: [number, number][] = [[w.playerStart.x + 1, w.playerStart.y + 1]];
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

  it('builds the dragon lair as four broad-mouthed stages away from the castle', () => {
    for (const seed of [1, 7, 42, 31337]) {
      const w = new World({
        seed, w: 86, h: 86, treeStands: 16, oreVeins: 13, waterScale: 1.1,
        meadows: 7, goldPiles: 9, mountains: 4, frontier: true, lairStages: 4,
      });
      expect(w.enemyZones).toHaveLength(4);
      const start = { x: w.playerStart.x + 1, y: w.playerStart.y + 1 };
      const depths = w.enemyZones.map(z => Math.hypot(z.x - start.x, z.y - start.y));
      expect(depths[0]).toBeGreaterThan(25);
      for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeGreaterThan(depths[i - 1] + 10);
      expect(depths[3]).toBeGreaterThan(Math.min(w.W, w.H) * 0.85);

      for (const zone of w.enemyZones) {
        for (let y = zone.pass.y - 2; y <= zone.pass.y + 2; y++) {
          for (let x = zone.pass.x - 2; x <= zone.pass.x + 2; x++) {
            expect(w.T(x, y)?.type, `seed ${seed}, mouth ${zone.pass.x},${zone.pass.y}`).toBe('grass');
          }
        }
      }
    }
  });

});
