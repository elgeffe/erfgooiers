import { describe, expect, it } from 'vitest';
import { runSelfPlayMatch } from '../../src/ai/selfplay';
import { resimulateReplay } from '../../src/game/replay';

/**
 * The Phase 0/1 exit bars from docs/skirmish-ai-design.md, as regression
 * tests: a full headless match runs, records, and re-simulates identically
 * (the determinism contract), and the Classic baseline actually plays fair —
 * zero rejected commands over a whole game, bounded CPU per decision pass.
 *
 * Seeds & horizons are pinned small so the suite stays fast; the full
 * tournament evidence lives in `npm run selfplay` (docs/skirmish-ai-design.md).
 */

describe('headless self-play', () => {
  it('replay of a bounded classic-vs-random match re-simulates to the identical outcome', () => {
    const result = runSelfPlayMatch({ seed: 7, p1: 'classic-hard', p2: 'random', maxSeconds: 120 });
    expect(result.replay.commands.length).toBeGreaterThan(10);
    const check = resimulateReplay(result.replay);
    expect(check.outcome).toEqual(result.outcome);
    expect(check.fingerprint).toBe(result.fingerprint);
  }, 120_000);

  it('classic plays a long scenario without one rejected command, inside budget', () => {
    const result = runSelfPlayMatch({ seed: 1000, p1: 'classic-hard', p2: 'idle', maxSeconds: 240 });
    for (const seat of ['p1', 'p2'] as const) {
      expect(result.stats[seat].rejected).toBe(0);
    }
    const stats = result.stats.p1;
    expect(stats.commands).toBeGreaterThan(20);
    // amortized decision cost must stay far below the 2 ms/tick budget:
    // passes fire every ~1-2.5 s of sim time, so per-tick cost is tiny
    const passes = stats.macroPasses + stats.tacticsPasses;
    expect(stats.cpuMsTotal / Math.max(1, passes)).toBeLessThan(2);
    // APM ceiling respected: never more commands than the budget allows
    const minutes = result.outcome.ticks / 20 / 60;
    expect(stats.commands).toBeLessThanOrEqual(Math.ceil(minutes * 30) + 8);
  }, 120_000);

  it('the idle seat never acts, and two idle seats draw at the horizon', () => {
    const result = runSelfPlayMatch({ seed: 42, p1: 'idle', p2: 'idle', maxSeconds: 60 });
    expect(result.replay.commands.length).toBe(0);
    expect(result.outcome).toEqual({ winner: null, ticks: 60 * 20, reason: 'timeout' });
  }, 60_000);

  it('same seed, same profiles → bit-identical match; different seed diverges', () => {
    const a = runSelfPlayMatch({ seed: 11, p1: 'classic-easy', p2: 'random', maxSeconds: 120 });
    const b = runSelfPlayMatch({ seed: 11, p1: 'classic-easy', p2: 'random', maxSeconds: 120 });
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.replay.commands).toEqual(a.replay.commands);
    const c = runSelfPlayMatch({ seed: 12, p1: 'classic-easy', p2: 'random', maxSeconds: 120 });
    expect(c.fingerprint).not.toBe(a.fingerprint);
  }, 120_000);

  it('godlike opens with early raids while hard sits on its slow fuse', () => {
    // This window crosses Godlike's deterministic first raid while remaining
    // well short of Hard's late breakout, so the assertion stops at the
    // behavior boundary instead of simulating both matches to completion.
    const godlike = runSelfPlayMatch({ seed: 1000, p1: 'classic-godlike', p2: 'idle', maxSeconds: 420 });
    const hard = runSelfPlayMatch({ seed: 1000, p1: 'classic-hard', p2: 'idle', maxSeconds: 420 });
    // the pro persona's raids ARE its first aggression, and they come early
    const firstGodlike = godlike.stats.p1.firstAttackAt;
    expect(firstGodlike).not.toBeNull();
    // the fortress persona either hasn't marched yet, or marched later
    const firstHard = hard.stats.p1.firstAttackAt;
    if (firstHard !== null) expect(firstGodlike!).toBeLessThan(firstHard);
  }, 240_000);
});
