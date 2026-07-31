import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/rng';
import { sampleConditional } from '../../src/ai/tensor/mps';
import { loadV2Model, priorV2Model } from '../../src/ai/tensor/modelV2';
import {
  BUNDLE_LENGTH, CONTEXT_LENGTH, CONTEXT_SLOTS, INTENT_VOCAB_VERSION, PHASE_INTENTS,
  decodeBundle, encodeEvidence, phaseSlotDims,
  type IntentId, type StrategicObservation,
} from '../../src/ai/tensor/plan';
import type { Phase } from '../../src/ai/tensor/phase';

/**
 * The adaptation the whole v2 rebuild exists for: the SAME model, given a
 * different fair observation, has to draw a different strategic answer. These
 * assertions are on the sampled distribution rather than on one draw — the
 * policy is deliberately probabilistic, so "usually pikes against cavalry" is
 * the honest claim, not "always".
 */

const model = loadV2Model(priorV2Model());

const NEUTRAL: StrategicObservation = {
  identity: 'boom', producers: 8, army: 6, advanced: 0,
  enemyArmy: 0, enemyCategory: 'unknown', enemyFortified: 0, threats: 0, sightingAge: Infinity,
};

/** How often each intent shows up in N bundles drawn for one observation. */
function intentRates(phase: Phase, over: Partial<StrategicObservation>, draws = 300): Map<IntentId, number> {
  const rng = new Rng(4242);
  const evidence = encodeEvidence({ ...NEUTRAL, ...over });
  const counts = new Map<IntentId, number>();
  for (let n = 0; n < draws; n++) {
    const seq = sampleConditional(model.phases[phase], evidence, rng);
    for (const intent of new Set(decodeBundle(phase, seq))) {
      counts.set(intent, (counts.get(intent) ?? 0) + 1);
    }
  }
  for (const [intent, count] of counts) counts.set(intent, count / draws);
  return counts;
}

const rate = (rates: Map<IntentId, number>, intent: IntentId): number => rates.get(intent) ?? 0;

describe('Tensor v2 model format', () => {
  it('carries its vocabulary version and the exact slot shape of every phase', () => {
    const raw = priorV2Model();
    expect(raw.version).toBe(2);
    expect(raw.vocab).toBe(INTENT_VOCAB_VERSION);
    for (const phase of ['opening', 'midgame', 'lategame'] as Phase[]) {
      const expected = phaseSlotDims(phase);
      expect(expected).toHaveLength(CONTEXT_LENGTH + BUNDLE_LENGTH);
      expect(model.phases[phase].dims).toEqual(expected);
      // the action slots speak that phase's alphabet, not one shared one
      expect(expected.slice(CONTEXT_LENGTH)).toEqual(
        new Array(BUNDLE_LENGTH).fill(PHASE_INTENTS[phase].length),
      );
    }
  });

  it('refuses a checkpoint written against a different vocabulary or shape', () => {
    const raw = priorV2Model();
    expect(() => loadV2Model({ ...raw, vocab: 99 })).toThrow(/vocabulary/);
    const bent = structuredClone(raw);
    bent.phases.opening.bond = bent.phases.opening.bond.slice(0, -1);
    bent.phases.opening.L -= 1;
    expect(() => loadV2Model(bent)).toThrow(/slot shape/);
  });

  it('builds the prior once, deterministically', () => {
    expect(priorV2Model()).toBe(priorV2Model()); // memoized, not refitted per seat
    const evidence = encodeEvidence(NEUTRAL);
    const first = sampleConditional(model.phases['midgame'], evidence, new Rng(7));
    const again = sampleConditional(loadV2Model(priorV2Model()).phases['midgame'], evidence, new Rng(7));
    expect(again).toEqual(first);
  });

  it('every context slot is clamped and every action slot is left free', () => {
    const evidence = encodeEvidence(NEUTRAL);
    expect(evidence.slice(CONTEXT_LENGTH)).toEqual(new Array(BUNDLE_LENGTH).fill(null));
    evidence.slice(0, CONTEXT_LENGTH).forEach((value, slot) => {
      expect(value).not.toBeNull();
      expect(value).toBeLessThan(CONTEXT_SLOTS[slot].buckets.length);
    });
  });
});

describe('Tensor v2 adaptation scenarios', () => {
  it('answers scouted cavalry with anti-mounted production', () => {
    const cavalry = intentRates('midgame', { enemyCategory: 'mounted', enemyArmy: 12, sightingAge: 10 });
    const infantry = intentRates('midgame', { enemyCategory: 'melee', enemyArmy: 12, sightingAge: 10 });
    expect(rate(cavalry, 'army:anti-mounted')).toBeGreaterThan(0.5);
    expect(rate(cavalry, 'army:anti-mounted')).toBeGreaterThan(rate(infantry, 'army:anti-mounted'));
  });

  it('answers a fortified rival with siege and support', () => {
    const fortified = intentRates('midgame', { enemyFortified: 5, sightingAge: 20 });
    const open = intentRates('midgame', { enemyFortified: 0, sightingAge: 20 });
    expect(rate(fortified, 'army:siege-support')).toBeGreaterThan(0.5);
    expect(rate(fortified, 'army:siege-support')).toBeGreaterThan(rate(open, 'army:siege-support'));
  });

  it('answers a wave in the base with defence, in every phase', () => {
    for (const phase of ['opening', 'midgame', 'lategame'] as Phase[]) {
      const attacked = intentRates(phase, { threats: 10, enemyArmy: 14 });
      const calm = intentRates(phase, { threats: 0 });
      expect(rate(attacked, 'defend:home'), `${phase} ignored a wave`).toBeGreaterThan(0.5);
      expect(rate(attacked, 'defend:home')).toBeGreaterThan(rate(calm, 'defend:home'));
    }
  });

  it('goes looking when it has not seen the rival for a long time', () => {
    const blind = intentRates('midgame', { sightingAge: Infinity, army: 10 });
    const informed = intentRates('midgame', { sightingAge: 10, enemyArmy: 12, enemyCategory: 'melee', army: 10 });
    expect(rate(blind, 'scout')).toBeGreaterThan(rate(informed, 'scout'));
  });

  it('opens on the economy and only commits in the late game', () => {
    const opening = intentRates('opening', { producers: 1, army: 0 });
    const economy: IntentId[] = ['expand:timber', 'expand:coin', 'expand:food', 'expand:stone', 'expand:arms'];
    expect(economy.some(intent => rate(opening, intent) > 0.6)).toBe(true);
    // 'commit' is not even in the opening or mid-game alphabet
    expect(PHASE_INTENTS.opening).not.toContain('commit');
    expect(PHASE_INTENTS.midgame).not.toContain('commit');
    const late = intentRates('lategame', { identity: 'pressure', army: 24, advanced: 1 });
    expect(rate(late, 'commit')).toBeGreaterThan(0.3);
  });

  it('keeps a spread of strategies rather than collapsing onto one line', () => {
    const rng = new Rng(2024);
    const evidence = encodeEvidence(NEUTRAL);
    const seen = new Set<string>();
    for (let n = 0; n < 300; n++) {
      seen.add(decodeBundle('midgame', sampleConditional(model.phases['midgame'], evidence, rng)).join('>'));
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('the strategy identity colours the plan it draws', () => {
    // Identity sits at the far end of the chain on purpose: `z` is a soft bias
    // over a whole match, not a reflex, and the near slots must be free to
    // overrule it. So the bar here is that it MOVES the distribution and points
    // the right way — not that it dominates it.
    const boom = intentRates('midgame', { identity: 'boom', producers: 10 });
    const pressure = intentRates('midgame', { identity: 'pressure', producers: 10 });
    const intents = new Set([...boom.keys(), ...pressure.keys()]);
    const shift = [...intents].reduce((sum, intent) => sum + Math.abs(rate(boom, intent) - rate(pressure, intent)), 0);
    expect(shift).toBeGreaterThan(0.2);
    expect(rate(boom, 'boom')).toBeGreaterThan(rate(pressure, 'boom'));
    expect(rate(pressure, 'raid') + rate(pressure, 'army:ranged'))
      .toBeGreaterThan(rate(boom, 'raid') + rate(boom, 'army:ranged'));
  });
});
