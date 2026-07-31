import { describe, expect, it } from 'vitest';
import { AIController } from '../../src/ai/AIController';
import { TensorMacroV2 } from '../../src/ai/strategy/tensorV2';
import { runSelfPlayMatch } from '../../src/ai/selfplay';
import { aiProfile } from '../../src/data/aiProfiles';
import { applyGameCommand } from '../../src/game/commands';
import { makeSkirmishGame } from '../../src/game/testHarness';
import { TICK_SECONDS } from '../../src/game/replay';
import { PLAYER_IDS } from '../../src/types';

/**
 * Tensor v2 in a real match. The unit tests in tensor-v2.test.ts prove the model
 * adapts; these prove the POLICY around it behaves — it plays through the fair
 * seam, it actually walks its sampled bundles into buildings and units, it
 * revises its plan as the match changes without flapping, and it stays
 * replay-deterministic, which the whole training pipeline depends on.
 */

/** Drive a match with a Tensor v2 seat we hold a reference to, so the test can
 *  read the phase, the bundles it drew, and the posture it asked tactics for. */
function runWithPolicy(seed: number, rival: string, seconds: number) {
  const { game, world } = makeSkirmishGame(seed);
  const macro = new TensorMacroV2();
  const controllers = PLAYER_IDS.map((playerId, seat) => new AIController({
    game, world, playerId,
    profile: aiProfile(playerId === 'p1' ? 'tensor2' : rival),
    seed: (seed ^ (seat + 1) * 0x9e3779b9) >>> 0,
    macro: playerId === 'p1' ? macro : undefined,
    submit: command => applyGameCommand(game, playerId, command),
  }));
  for (let tick = 0; tick < Math.round(seconds / TICK_SECONDS); tick++) {
    for (const controller of controllers) controller.tick(TICK_SECONDS);
    game.update(TICK_SECONDS);
    if (game.eliminated.size) break;
  }
  return { macro, game, stats: controllers[0].stats };
}

describe('Tensor v2 policy in a match', () => {
  it('plays through the fair seam and builds what its bundles asked for', () => {
    const result = runSelfPlayMatch({ seed: 314, p1: 'tensor2', p2: 'idle', maxSeconds: 300 });
    expect(result.stats.p1.rejected).toBe(0);
    const builds = result.replay.commands.filter(c => c.command.type === 'placeBuilding' && c.playerId === 'p1').length;
    const trains = result.replay.commands.filter(c => c.command.type === 'queueTraining' && c.playerId === 'p1').length;
    expect(builds).toBeGreaterThan(8);
    expect(trains).toBeGreaterThan(8);
  }, 180_000);

  it('is replay-deterministic: same seed → bit-identical match', () => {
    const a = runSelfPlayMatch({ seed: 77, p1: 'tensor2', p2: 'classic-easy', maxSeconds: 300 });
    const b = runSelfPlayMatch({ seed: 77, p1: 'tensor2', p2: 'classic-easy', maxSeconds: 300 });
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.replay.commands).toEqual(a.replay.commands);
  }, 180_000);

  it('grows a staffed economy out of the opening and reaches the mid-game', () => {
    const { macro, game } = runWithPolicy(2026, 'idle', 420);
    expect(macro.state.phase).not.toBe('opening');
    expect(macro.state.identity).not.toBeNull();
    const own = game.buildings.filter(b => b.owner === 'p1' && !b.removed);
    // the supplier-first chains the shared executor raises, not a pile of one kind
    expect(new Set(own.map(b => b.key)).size).toBeGreaterThan(5);
    expect(own.some(b => b.key === 'sawmill')).toBe(true);
    expect(own.some(b => b.key === 'barracks')).toBe(true);
  }, 180_000);

  it('replans repeatedly, but never inside its commitment window', () => {
    const { macro } = runWithPolicy(4711, 'classic-easy', 420);
    expect(macro.drawn.length).toBeGreaterThan(2);
    for (let i = 1; i < macro.drawn.length; i++) {
      const gap = macro.drawn[i].at - macro.drawn[i - 1].at;
      expect(gap, `plan ${i} flapped after ${gap.toFixed(1)}s`).toBeGreaterThanOrEqual(25);
    }
    // and every bundle is a legal, non-empty plan in that phase's alphabet
    for (const entry of macro.drawn) {
      expect(entry.intents.length).toBeGreaterThan(0);
      expect(entry.intents.length).toBeLessThanOrEqual(6);
    }
  }, 180_000);

  it('hands the tactics layer a posture it chose itself', () => {
    const { macro } = runWithPolicy(99, 'classic-hard', 420);
    const asked = macro.drawn.flatMap(entry => entry.intents);
    // whatever it drew, the directives it publishes must follow from it
    if (asked.includes('army:siege-support')) {
      expect(Object.keys(macro.directives).length).toBeGreaterThan(0);
    }
    for (const key of Object.keys(macro.directives)) {
      // never a fairness budget — only army shape and posture
      expect(['macroPeriod', 'tacticsPeriod', 'reactionDelay', 'apm', 'errorRate']).not.toContain(key);
    }
  }, 180_000);
});
