import { describe, expect, it } from 'vitest';
import { RARITY_WEIGHT, UPGRADES, cardUnlocked, unlockLabel } from '../../src/data/upgrades';

describe('achievement-gated cards', () => {
  it('gates cards on any lifetime stat, treating missing stats as zero', () => {
    const card = UPGRADES.find(u => u.id === 'royal-charter')!;
    expect(card.rarity).toBe('legendary');
    expect(cardUnlocked(card, {})).toBe(false);
    expect(cardUnlocked(card, { wins: 1 })).toBe(false);
    expect(cardUnlocked(card, { wins: 2 })).toBe(true);
  });

  it('describes every gate in plain words', () => {
    for (const u of UPGRADES) {
      if (!u.unlockAt) continue;
      const label = unlockLabel(u.unlockAt);
      expect(label.length).toBeGreaterThan(4);
    }
    expect(unlockLabel({ stat: 'bestLevel', n: 5 })).toBe('Reach level 5 in a single run');
    expect(unlockLabel({ stat: 'wins', n: 1 })).toBe('Win a run');
  });

  it('offers legendaries rarer than rares, and every rarity has a weight', () => {
    expect(RARITY_WEIGHT.legendary).toBeLessThan(RARITY_WEIGHT.rare);
    for (const u of UPGRADES) expect(RARITY_WEIGHT[u.rarity]).toBeGreaterThan(0);
  });

  it('every achievement card is unique so the scoreboard grind stays meaningful', () => {
    for (const u of UPGRADES) if (u.unlockAt && (u.rarity === 'rare' || u.rarity === 'legendary')) expect(u.unique).toBe(true);
  });
});
