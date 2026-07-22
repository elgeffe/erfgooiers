import { describe, expect, it } from 'vitest';
import { World, diagonalSpawns } from '../../src/world/World';
import type { BiomeKey } from '../../src/data/biomes';
import { SKIRMISH_LEVEL } from '../../src/data/skirmishLevels';

describe('Arena worldgen', () => {
  it('keeps a clear castle green and pools industrial ores farther out', () => {
    for (const seed of [1, 7, 42, 31337]) {
      const world = new World({ seed, ...SKIRMISH_LEVEL.world });
      for (const spawn of diagonalSpawns(world.W, world.H)) {
        let clutter = 0;
        const nearby = { coal: 0, gold: 0, iron: 0 };
        const outer = { coal: 0, gold: 0, iron: 0 };
        for (let y = 0; y < world.H; y++) for (let x = 0; x < world.W; x++) {
          const distance = Math.hypot(x - spawn.x, y - spawn.y);
          const tile = world.tiles[y][x];
          if (distance <= 6 && (tile.tree || tile.deco || tile.pickup || (tile.dep && tile.dep.kind !== 'stone'))) clutter++;
          if (tile.dep && tile.dep.kind !== 'stone') {
            if (distance <= 8) nearby[tile.dep.kind]++;
            if (distance > 8 && distance <= 20) outer[tile.dep.kind]++;
          }
        }
        expect(clutter, `seed ${seed} at ${spawn.x},${spawn.y}`).toBe(0);
        expect(nearby).toEqual({ coal: 0, gold: 0, iron: 0 });
        for (const kind of ['coal', 'gold', 'iron'] as const) expect(outer[kind], `seed ${seed} ${kind}`).toBeGreaterThan(0);
      }
    }
  });

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

