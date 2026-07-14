import { describe, expect, it } from 'vitest';
import { META_UPGRADES, metaSpecialValue, metaSpecsFor } from './metaUpgrades';

describe('Heritage global blessings', () => {
  it('becomes progressively more expensive by tier', () => {
    expect(META_UPGRADES.map(x => x.tier)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < META_UPGRADES.length; i++) {
      expect(META_UPGRADES[i].cost).toBeGreaterThan(META_UPGRADES[i - 1].cost);
    }
  });

  it('returns effects for only the selected blessing', () => {
    expect(metaSpecsFor('extra-resources')).toEqual([{ stat: 'startTimber', add: 10 }, { stat: 'startStone', add: 10 }]);
    expect(metaSpecsFor('willing-hands')).toEqual([{ stat: 'extraSerf', add: 2 }]);
    expect(metaSpecsFor(null)).toEqual([]);
  });

  it('exposes a special only while that blessing is active', () => {
    expect(metaSpecialValue('war-chest', 'startGold')).toBe(75);
    expect(metaSpecialValue('stout-castle', 'startGold')).toBe(0);
  });
});
