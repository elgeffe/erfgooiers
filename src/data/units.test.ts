import { describe, expect, it } from 'vitest';
import { UNITS, damageMultiplier, formationRank, isCommandableRole } from './units';

describe('unit counters', () => {
  it('gives pikemen their mounted-target bonus only against riders', () => {
    expect(damageMultiplier('pikeman', 'horseknight')).toBe(2.5);
    expect(damageMultiplier('pikeman', 'horsearcher')).toBe(2.5);
    expect(damageMultiplier('pikeman', 'hero')).toBe(2.5);
    expect(damageMultiplier('pikeman', 'soldier')).toBe(1);
    expect(damageMultiplier('soldier', 'horseknight')).toBe(1);
  });

  it('treats economy roles outside UNITS as untagged instead of crashing', () => {
    expect(damageMultiplier('pikeman', 'serf' as never)).toBe(1);
    expect(damageMultiplier('serf' as never, 'horseknight')).toBe(1);
  });
});

describe('priest support role', () => {
  it('is commandable, heals, and forms behind siege', () => {
    expect(isCommandableRole('priest')).toBe(true);
    expect(UNITS.priest.heal).toEqual({ range: 4.5, amount: 8, rate: 1.5 });
    expect(formationRank('priest')).toBeGreaterThan(formationRank('trebuchet'));
  });
});
