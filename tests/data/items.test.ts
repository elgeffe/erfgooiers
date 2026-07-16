import { describe, expect, it } from 'vitest';
import { ITEMS, MARKET_VALUES } from '../../src/data/items';

describe('market values', () => {
  it('prices every physical resource except coin at a positive finite value', () => {
    expect(Object.keys(MARKET_VALUES).sort()).toEqual(Object.keys(ITEMS).filter(k => k !== 'coin').sort());
    for (const value of Object.values(MARKET_VALUES)) expect(Number.isFinite(value) && value! > 0).toBe(true);
  });
});
