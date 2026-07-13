import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX, sandboxLevel } from './levels';

describe('sandbox levels', () => {
  it('keeps bandit camps static unless the player summons a wave', () => {
    const level = sandboxLevel({ ...DEFAULT_SANDBOX, banditCamps: true });

    expect(level.enemies?.camps?.length).toBeGreaterThan(0);
    expect(level.enemies?.commander).toBeUndefined();
    expect(level.enemies?.waves).toBeUndefined();
  });
});
