import { describe, expect, it } from 'vitest';
import { World, diagonalSpawns } from '../../src/world/World';
import type { BiomeKey } from '../../src/data/biomes';
import { SKIRMISH_LEVEL } from '../../src/data/skirmishLevels';

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


