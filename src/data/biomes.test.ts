import { describe, expect, it } from 'vitest';
import { BIOMES, campaignBiome } from './biomes';
import { LEVELS } from './levels';
import { MAX_ASCENSION } from '../game/RunState';
import { DEFS } from './buildings';
import type { BuildingKey, ItemKey } from '../types';

describe('campaignBiome', () => {
  it('keeps the economy arc (levels 1-4) in Het Gooi at every tier', () => {
    for (let a = 0; a <= MAX_ASCENSION; a++) {
      for (let lvl = 1; lvl <= 4; lvl++) expect(campaignBiome(a, lvl)).toBe('gooi');
    }
  });

  it('stays home at Normal, and marches the ladder as tiers stack', () => {
    for (let lvl = 1; lvl <= 10; lvl++) expect(campaignBiome(0, lvl)).toBe('gooi');
    // each row is the combat arc (levels 5..10) at one ascension tier
    const journey: Record<number, string[]> = {
      1: ['polder', 'ardennes', 'ardennes', 'ardennes', 'ardennes', 'ardennes'],
      2: ['polder', 'ardennes', 'seaside', 'blackforest', 'blackforest', 'blackforest'],
      3: ['polder', 'island', 'seaside', 'blackforest', 'alps', 'alps'],
      // Grim: winter claims the whole combat arc (5-9); the finale stays high
      4: ['winter', 'winter', 'winter', 'winter', 'winter', 'alps'],
      5: ['winter', 'winter', 'winter', 'winter', 'winter', 'hell'],
    };
    for (const [a, biomes] of Object.entries(journey)) {
      for (let i = 0; i < 6; i++) expect(campaignBiome(Number(a), 5 + i), `A${a} level ${5 + i}`).toBe(biomes[i]);
    }
  });

  it('never sends a level into a biome that forbids its objective chain', () => {
    // which buildings produce (or gather) each item, following recipe inputs
    const producers = (item: ItemKey): BuildingKey[] =>
      (Object.keys(DEFS) as BuildingKey[]).filter(k => DEFS[k].gather?.out === item || DEFS[k].recipe?.out === item);
    const chainBuildable = (item: ItemKey, banned: Set<BuildingKey>): boolean =>
      producers(item).some(k => !banned.has(k) &&
        Object.keys(DEFS[k].recipe?.inp ?? {}).every(inp => chainBuildable(inp as ItemKey, banned)));

    for (let a = 0; a <= MAX_ASCENSION; a++) {
      for (const level of LEVELS) {
        const biome = BIOMES[campaignBiome(a, level.index)];
        const banned = new Set<BuildingKey>(biome.disabledBuildings);
        if (!biome.gen.coast) for (const k of Object.keys(DEFS) as BuildingKey[]) if (DEFS[k].coastal) banned.add(k);
        for (const obj of level.objectives) {
          const items: ItemKey[] =
            obj.kind === 'produce' ? [obj.item]
              : obj.kind === 'produceMulti' || obj.kind === 'produceTrain' || obj.kind === 'stock' ? obj.reqs.map(r => r.item)
                : [];
          for (const item of items) {
            expect(chainBuildable(item, banned), `A${a} level ${level.index} (${biome.key}): ${item}`).toBe(true);
          }
        }
      }
    }
  });
});
