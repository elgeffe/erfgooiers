import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, nextHarmonyIndex, selectProgression } from './Audio';

describe('soundtrack harmony selection', () => {
  it('keeps the selected progression stable until an explicit reroll', () => {
    const progressions = ['first', 'second', 'third'];
    expect(selectProgression(progressions, 1)).toBe('second');
    expect(selectProgression(progressions, 1)).toBe('second');
    expect(selectProgression(progressions, 4)).toBe('second');
  });

  it('rerolls to a different harmony identity when alternatives exist', () => {
    expect(nextHarmonyIndex(0, 5, () => 0)).toBe(1);
    expect(nextHarmonyIndex(2, 5, () => 0.999)).toBe(1);
    expect(nextHarmonyIndex(0, 1, () => 0.5)).toBe(0);
  });

  it('does not reroll during level, biome, or mute-independent score changes', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.4);
    try {
      const engine = new AudioEngine();
      engine.rerollHarmony();
      expect(random).toHaveBeenCalledTimes(1);

      engine.setLevel(1);
      engine.setBiome('gooi');
      engine.setLevel(5);
      engine.setBiome('winter');
      expect(random).toHaveBeenCalledTimes(1);

      engine.rerollHarmony();
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });
});
