import { describe, expect, it } from 'vitest';
import { allocateUnitQuotas, dominantEnemyCategory, counterMultiplier } from '../../src/ai/strategy/classic';

describe('reactive counter-composition', () => {
  it('reads the rival army\'s dominant category, ignoring trivial forces', () => {
    expect(dominantEnemyCategory({})).toBeNull();
    expect(dominantEnemyCategory({ soldier: 2 })).toBeNull(); // too small to counter
    expect(dominantEnemyCategory({ archer: 6, soldier: 2 })).toMatchObject({ cat: 'ranged' });
    expect(dominantEnemyCategory({ soldier: 5, knight: 3 })).toMatchObject({ cat: 'melee' });
    expect(dominantEnemyCategory({ lancer: 4, horseknight: 3, soldier: 1 })).toMatchObject({ cat: 'mounted' });
    const lopsided = dominantEnemyCategory({ archer: 9, soldier: 1 })!;
    expect(lopsided.cat).toBe('ranged');
    expect(lopsided.frac).toBeCloseTo(0.9, 5);
  });

  it('boosts the data-backed counter and dampens the countered unit', () => {
    // vs a cavalry-heavy enemy, pikemen (2.5x bonus vs mounted) get the big boost
    expect(counterMultiplier('pikeman', 'mounted', 1)).toBeGreaterThan(counterMultiplier('soldier', 'mounted', 1));
    expect(counterMultiplier('archer', 'mounted', 1)).toBeLessThan(1); // archers are worst vs cavalry
    // vs an archer-heavy enemy, durable melee closes and soaks; more archers don't help
    expect(counterMultiplier('knight', 'ranged', 1)).toBeGreaterThan(1);
    expect(counterMultiplier('archer', 'ranged', 1)).toBeLessThan(1);
    // vs a melee-heavy enemy, archers kite
    expect(counterMultiplier('archer', 'melee', 1)).toBeGreaterThan(1);
    expect(counterMultiplier('soldier', 'melee', 1)).toBe(1);
    // zero reactivity (Easy) never reweights
    for (const kind of ['pikeman', 'archer', 'knight', 'soldier']) {
      expect(counterMultiplier(kind, 'mounted', 0)).toBe(1);
    }
  });
});

describe('target army quotas', () => {
  it('fills the exact cap while reserving slots for every weighted premium role', () => {
    const quotas = allocateUnitQuotas({
      soldier: 4, archer: 4, pikeman: 1, knight: 2,
      lancer: 2, onager: 2, trebuchet: 3, priest: 2,
    }, 75);

    expect(Object.values(quotas).reduce((sum, count) => sum + count, 0)).toBe(75);
    for (const kind of ['knight', 'lancer', 'onager', 'trebuchet', 'priest']) {
      expect(quotas[kind], `${kind} lost its reserved cap slots`).toBeGreaterThan(0);
    }
  });

  it('is deterministic at tied remainders', () => {
    const weights = { soldier: 1, archer: 1, pikeman: 1 };
    expect(allocateUnitQuotas(weights, 5)).toEqual(allocateUnitQuotas(weights, 5));
    expect(allocateUnitQuotas(weights, 5)).toEqual({ archer: 2, pikeman: 2, soldier: 1 });
  });
});
