import { describe, expect, it } from 'vitest';
import { damageMultiplier } from './units';

describe('unit counters', () => {
  it('gives pikemen their mounted-target bonus only against riders', () => {
    expect(damageMultiplier('pikeman', 'horseknight')).toBe(2.5);
    expect(damageMultiplier('pikeman', 'horsearcher')).toBe(2.5);
    expect(damageMultiplier('pikeman', 'hero')).toBe(2.5);
    expect(damageMultiplier('pikeman', 'soldier')).toBe(1);
    expect(damageMultiplier('soldier', 'horseknight')).toBe(1);
  });
});
