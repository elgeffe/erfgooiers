import { describe, expect, it } from 'vitest';
import { runSelfPlayMatch } from '../../src/ai/selfplay';
import { resimulateReplay } from '../../src/game/replay';
import { decodePlan, ACTIONS, ACTION_DIM } from '../../src/ai/tensor/plan';

/**
 * The tensor-network policy must clear the SAME bars the Classic baseline does:
 * it plays through the validated command seam (zero rejected commands over a
 * whole game — it structurally cannot cheat), it actually builds and trains from
 * its sampled plan, and — crucially for the deterministic sim — a sampled plan
 * is a pure function of the seat's seeded rng, so a match re-simulates identically.
 */

describe('tensor MPS policy', () => {
  it('plays a full match through the fair seam with zero rejected commands', () => {
    const result = runSelfPlayMatch({ seed: 314, p1: 'tensor', p2: 'idle', maxSeconds: 480 });
    expect(result.stats.p1.rejected).toBe(0);
    expect(result.stats.p1.commands).toBeGreaterThan(20);
    // it executed its sampled build order and trained an army, not just idled
    const builds = result.replay.commands.filter(c => c.command.type === 'placeBuilding' && c.playerId === 'p1').length;
    const trains = result.replay.commands.filter(c => c.command.type === 'queueTraining' && c.playerId === 'p1').length;
    expect(builds).toBeGreaterThan(5);
    expect(trains).toBeGreaterThan(5);
  }, 120_000);

  it('is replay-deterministic: same seed → bit-identical match', () => {
    const a = runSelfPlayMatch({ seed: 77, p1: 'tensor', p2: 'classic-easy-balanced', maxSeconds: 240 });
    const b = runSelfPlayMatch({ seed: 77, p1: 'tensor', p2: 'classic-easy-balanced', maxSeconds: 240 });
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.replay.commands).toEqual(a.replay.commands);
    // and re-simulating the recorded log lands on the same outcome
    const check = resimulateReplay(a.replay);
    expect(check.fingerprint).toBe(a.fingerprint);
  }, 120_000);

  it('decodes a raw action sequence into an executable plan', () => {
    const build = (key: string) => ACTIONS.findIndex(a => a.kind === 'build' && a.key === key);
    const train = (unit: string) => ACTIONS.findIndex(a => a.kind === 'train' && a.unit === unit);
    const econ = ACTIONS.findIndex(a => a.kind === 'econ');
    const seq = [build('woodcutter'), build('quarry'), train('archer'), train('archer'), econ];
    const plan = decodePlan(seq);
    expect(plan.buildOrder).toEqual(['woodcutter', 'quarry']);
    expect(plan.unitWeights.archer).toBe(2);
    expect(plan.econ).toBe(1);
  });

  it('the model vocabulary covers the whole economy → army chain', () => {
    expect(ACTIONS).toHaveLength(ACTION_DIM);
    for (const key of ['woodcutter', 'mint', 'barracks', 'smithy', 'armory', 'stable'] as const) {
      expect(ACTIONS.some(a => a.kind === 'build' && a.key === key)).toBe(true);
    }
    for (const unit of ['soldier', 'archer', 'knight'] as const) {
      expect(ACTIONS.some(a => a.kind === 'train' && a.unit === unit)).toBe(true);
    }
  });
});
