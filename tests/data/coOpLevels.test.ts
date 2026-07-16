import { describe, expect, it } from 'vitest';
import { EXPEDITION_DIFFICULTY, EXPEDITION_LEVELS, expeditionLevelFor } from '../../src/data/coOpLevels';

describe('expedition levels', () => {
  it('spans four levels with team-wide objectives only', () => {
    expect(EXPEDITION_LEVELS.length).toBe(4);
    for (const level of EXPEDITION_LEVELS) {
      // per-player `stock` objectives cannot aggregate across two private economies
      for (const o of level.objectives) expect(o.kind).not.toBe('stock');
      expect(level.hardTimer).toBeGreaterThan(level.timeTarget);
      expect(level.world.w).toBeGreaterThanOrEqual(72); // room for two settlements
    }
  });

  it('clamps level lookups like the solo table', () => {
    expect(expeditionLevelFor(0).index).toBe(1);
    expect(expeditionLevelFor(99).index).toBe(4);
  });

  it('difficulty presets scale pressure through timers and Modifiers specs', () => {
    expect(EXPEDITION_DIFFICULTY.journey.timerMult).toBeGreaterThan(EXPEDITION_DIFFICULTY.veldheer.timerMult);
    expect(EXPEDITION_DIFFICULTY.erfgooiers.specs.length).toBe(0);
    expect(EXPEDITION_DIFFICULTY.veldheer.specs.length).toBeGreaterThan(0);
  });
});
