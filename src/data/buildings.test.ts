import { describe, expect, it } from 'vitest';
import { MENU_KEYS, lockedBuildingsAt, unlockedBuildingsAt, unlockedResourcesAt } from './buildings';
import { LEVELS } from './levels';

describe('first-ascension building onboarding', () => {
  it('unlocks a growing, cumulative subset each level', () => {
    const sizes = [1, 2, 3, 4, 5].map(l => unlockedBuildingsAt(l).size);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    // never unlocks a building it later relocks
    for (let l = 1; l < 5; l++) {
      const a = unlockedBuildingsAt(l), b = unlockedBuildingsAt(l + 1);
      for (const k of a) expect(b.has(k)).toBe(true);
    }
  });

  it('opens the entire menu from level 5 (the combat arc)', () => {
    expect(unlockedBuildingsAt(5).size).toBe(MENU_KEYS.length);
    expect(lockedBuildingsAt(5)).toHaveLength(0);
    expect(lockedBuildingsAt(10)).toHaveLength(0);
  });

  // the onboarding must never hide a building an economy objective needs
  const critical: Record<number, string[]> = {
    1: ['woodcutter', 'sawmill'],       // produce timber
    2: ['farm', 'mill', 'bakery'],       // produce bread
    3: ['goldmine', 'coalmine', 'mint'], // produce coin
    4: ['vineyard', 'winery', 'ironmine', 'smithy', 'barracks'], // wine + train
  };
  it('unlocks every objective-critical building by its level', () => {
    for (const [level, keys] of Object.entries(critical)) {
      const unlocked = unlockedBuildingsAt(Number(level));
      for (const k of keys) expect(unlocked.has(k as any)).toBe(true);
    }
  });

  it('every locked key is a real, player-buildable menu key', () => {
    for (let l = 1; l <= LEVELS.length; l++) {
      for (const k of lockedBuildingsAt(l)) expect(MENU_KEYS).toContain(k);
    }
  });

  it('surfaces only resources tied to the unlocked buildings', () => {
    // level 1 shows the timber chain basics but not wine, made much later
    const l1 = unlockedResourcesAt(1);
    expect(l1.has('timber')).toBe(true);
    expect(l1.has('trunk')).toBe(true);
    expect(l1.has('coin')).toBe(true);
    expect(l1.has('wine')).toBe(false);
    expect(l1.has('bread')).toBe(false);
    // bread appears once the bakery is unlocked
    expect(unlockedResourcesAt(2).has('bread')).toBe(true);
    // wine once the winery is unlocked
    expect(unlockedResourcesAt(4).has('wine')).toBe(true);
    // and everything is on the table by the combat arc
    expect(unlockedResourcesAt(5).has('armor')).toBe(true);
  });
});
