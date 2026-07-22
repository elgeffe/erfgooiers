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

  it('godlike waits for a siege-backed premium roster while hard fields a conventional wave', () => {
    // Villagers and the common production opening now precede luxury military
    // buildings. Against a passive seat, Godlike should therefore hold for its
    // deliberately larger combined-arms force. The 18-minute horizon includes
    // its paced fourth perimeter tower and second trebuchet.
    const godlike = runSelfPlayMatch({ seed: 1000, p1: 'classic-godlike', p2: 'idle', maxSeconds: 1080 });
    const hard = runSelfPlayMatch({ seed: 1000, p1: 'classic-hard', p2: 'idle', maxSeconds: 1080 });
    const firstGodlike = godlike.stats.p1.firstAttackAt;
    expect(firstGodlike).not.toBeNull();
    const firstHard = hard.stats.p1.firstAttackAt;
    expect(firstHard).not.toBeNull();
    expect(firstGodlike!).toBeGreaterThan(firstHard!);

    const trained = (result: typeof godlike): string[] => result.replay.commands.flatMap(entry =>
      entry.playerId === 'p1' && entry.command.type === 'queueTraining' ? [entry.command.unit] : []);
    const godlikeRoster = trained(godlike);
    const hardRoster = trained(hard);
    const mounted = new Set(['lancer', 'horsearcher', 'horseknight']);
    const advancedSupport = new Set(['trebuchet', 'onager', 'priest']);
    expect(godlikeRoster.filter(kind => kind === 'trebuchet')).toHaveLength(2);
    expect(godlikeRoster.some(kind => mounted.has(kind))).toBe(true);
    expect(hardRoster.some(kind => advancedSupport.has(kind))).toBe(false);

    const placed = (result: typeof godlike): string[] => result.replay.commands.flatMap(entry =>
      entry.playerId === 'p1' && entry.command.type === 'placeBuilding' ? [entry.command.key] : []);
    const wallKeys = new Set(['woodwall', 'woodgate', 'wall', 'gate']);
    expect(placed(godlike).some(key => wallKeys.has(key))).toBe(false);
    expect(placed(hard).some(key => wallKeys.has(key))).toBe(false);
    expect(placed(godlike).filter(key => key === 'stonetower').length).toBeGreaterThanOrEqual(4);
    expect(placed(hard).filter(key => key === 'watchtower').length).toBeGreaterThanOrEqual(3);
  }, 240_000);
});
