import { describe, expect, it } from 'vitest';
import { advancesScheduledWave } from '../../src/ai/tactics';

describe('classic AI wave escalation', () => {
  it('does not count an undersized reactive counterattack as a full wave', () => {
    expect(advancesScheduledWave(true, 33, 44)).toBe(false);
  });

  it('advances after scheduled attacks and full-sized counterattacks', () => {
    expect(advancesScheduledWave(false, 36, 44)).toBe(true);
    expect(advancesScheduledWave(true, 44, 44)).toBe(true);
    expect(advancesScheduledWave(true, 50, 44)).toBe(true);
  });
});
