import { describe, expect, it } from 'vitest';
import { RUN_LEVELS, bestLevelTimes, compareScores, formatRunTime, newMeta, newRun, type ScoreEntry } from '../../src/game/RunState';

describe('speedrun scoreboard', () => {
  const entry = (ascension: number, timeSeconds: number): ScoreEntry =>
    ({ name: 'Jef', title: 'the Brave', ascension, timeSeconds, hero: null, date: 0 });

  it('orders scores by tier first, then by time', () => {
    const scores = [entry(0, 100), entry(2, 900), entry(2, 400), entry(1, 50)];
    scores.sort(compareScores);
    expect(scores.map(s => [s.ascension, s.timeSeconds])).toEqual([[2, 400], [2, 900], [1, 50], [0, 100]]);
  });

  it('formats run times as m:ss and h:mm:ss', () => {
    expect(formatRunTime(75)).toBe('1:15');
    expect(formatRunTime(3600 + 62)).toBe('1:01:02');
    expect(formatRunTime(0)).toBe('0:00');
  });

  it('new runs and meta carry the scoreboard fields', () => {
    const run = newRun(1);
    expect(run.playerName).toBe('');
    expect(run.timeSeconds).toBe(0);
    expect(run.levelTimes).toEqual([]);
    expect(newMeta().scores).toEqual([]);
  });

  it('finds the personal-best split per level across runs with splits', () => {
    const withSplits = (levelTimes: number[]): ScoreEntry => ({ ...entry(0, 0), levelTimes });
    const best = bestLevelTimes([
      withSplits([120, 90, 300]),
      withSplits([100, 95]),
      entry(0, 500), // pre-split-tracking entry: ignored
    ]);
    expect(best).toHaveLength(RUN_LEVELS);
    expect(best.slice(0, 4)).toEqual([100, 90, 300, null]);
  });

  it('has no best splits when no run recorded any', () => {
    expect(bestLevelTimes([entry(0, 500)])).toEqual(Array.from({ length: RUN_LEVELS }, () => null));
  });
});
