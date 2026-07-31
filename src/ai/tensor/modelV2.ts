import { Rng } from '../../engine/rng';
import {
  deserializeMPS, fitStepScaled, randomMPSWithDims, serializeMPS,
  type MPS, type SerializedMPS,
} from './mps';
import {
  BUNDLE_LENGTH, CONTEXT_SLOTS, INTENT_VOCAB_VERSION, PHASE_INTENTS, V2_BOND_DIM,
  phaseSlotDims, type IntentId, type StrategicObservation,
} from './plan';
import type { Phase } from './phase';
import { PRIOR_V2_MODEL } from './modelV2Data';

/**
 * The Tensor v2 checkpoint format, and the imitation PRIOR the runtime starts
 * from until self-play produces a trained one.
 *
 * Versioning matters here for a specific reason from docs/tensor-retrain-plan.md:
 * a model is just numbers indexed against an alphabet, so reading a checkpoint
 * through the wrong vocabulary silently plays a different strategy. Every v2
 * checkpoint therefore carries its vocabulary version and per-phase slot shape,
 * and `loadV2Model` refuses anything that does not match the code it is being
 * loaded into. The committed v1 artifact (`model.ts`) is untouched by all of
 * this — it stays readable as v1, exactly as the plan requires.
 *
 * The prior is an IMITATION ANCHOR, not a trained policy: a set of coherent
 * expert demonstrations, one per (context, strategic answer) pair, fitted into
 * each phase's MPS. It gives the runtime a sound supplier-first foundation and
 * the adaptive reflexes a competent player has — scout when blind, pikemen
 * against cavalry, siege against fortifications, defend when a wave lands —
 * without pretending to be the outcome of the training campaign the plan
 * specifies. Self-play is expected to replace `phases` wholesale; the plan's
 * promotion criteria decide whether the result ever ships as the Tensor seat.
 */

export interface TensorV2Model {
  version: 2;
  /** The intent vocabulary these cores are indexed against. */
  vocab: number;
  /** Provenance: 'prior' until a trained checkpoint replaces it. */
  origin: string;
  phases: Record<Phase, SerializedMPS>;
}

export interface LoadedV2Model {
  vocab: number;
  origin: string;
  phases: Record<Phase, MPS>;
}

const PHASES: readonly Phase[] = ['opening', 'midgame', 'lategame'];

/** Read a checkpoint, refusing one written against a different alphabet or a
 *  different slot layout rather than letting it play something unintended. */
export function loadV2Model(model: TensorV2Model): LoadedV2Model {
  if (model.vocab !== INTENT_VOCAB_VERSION) {
    throw new Error(`Tensor v2 model speaks vocabulary ${model.vocab}, runtime speaks ${INTENT_VOCAB_VERSION}`);
  }
  const phases = {} as Record<Phase, MPS>;
  for (const phase of PHASES) {
    const mps = deserializeMPS(model.phases[phase]);
    const expected = phaseSlotDims(phase);
    if (mps.L !== expected.length || expected.some((dim, t) => mps.dims[t] !== dim)) {
      throw new Error(`Tensor v2 model has the wrong slot shape for the ${phase} phase`);
    }
    phases[phase] = mps;
  }
  return { vocab: model.vocab, origin: model.origin, phases };
}

/**
 * One expert demonstration: "in a match that looks like THIS, a good player
 * pursues THESE next". Only the observation fields that matter to the lesson
 * are written; the rest fall back to a neutral mid-match reading, so a demo
 * says what it means and nothing more.
 */
interface Demo {
  when: Partial<StrategicObservation>;
  intents: IntentId[];
}

const NEUTRAL: StrategicObservation = {
  identity: 'boom', producers: 6, army: 4, advanced: 0,
  enemyArmy: 0, enemyCategory: 'unknown', enemyFortified: 0, threats: 0, sightingAge: Infinity,
};

/**
 * The opening: supplier-first economy, coloured by the strategy identity, with
 * the two reflexes that matter this early — answer a rush, and answer scouted
 * cavalry with pikes rather than more archers.
 */
const OPENING_DEMOS: Demo[] = [
  { when: { identity: 'boom', producers: 1 }, intents: ['expand:timber', 'expand:coin', 'expand:food', 'boom', 'expand:stone', 'expand:arms'] },
  { when: { identity: 'tech', producers: 1 }, intents: ['expand:timber', 'expand:stone', 'expand:coin', 'expand:food', 'expand:arms', 'defend:home'] },
  { when: { identity: 'contest', producers: 1 }, intents: ['expand:timber', 'expand:coin', 'scout', 'expand:stone', 'expand:food', 'expand:arms'] },
  { when: { identity: 'pressure', producers: 1 }, intents: ['expand:timber', 'expand:coin', 'expand:arms', 'army:ranged', 'expand:food', 'scout'] },
  { when: { identity: 'boom', producers: 6 }, intents: ['expand:coin', 'expand:food', 'boom', 'expand:arms', 'expand:timber', 'defend:home'] },
  { when: { identity: 'pressure', producers: 6 }, intents: ['expand:arms', 'army:ranged', 'expand:coin', 'scout', 'expand:food', 'expand:timber'] },
  // a wave in the base during the opening is an emergency, whatever z says
  { when: { threats: 9, enemyArmy: 9 }, intents: ['defend:home', 'army:ranged', 'expand:food', 'expand:arms', 'defend:home', 'expand:coin'] },
  { when: { threats: 3, enemyArmy: 4 }, intents: ['defend:home', 'army:ranged', 'expand:arms', 'expand:food', 'expand:coin', 'expand:timber'] },
  // scouted cavalry: pikes, not more archers
  { when: { enemyCategory: 'mounted', enemyArmy: 6, sightingAge: 10 }, intents: ['army:anti-mounted', 'expand:arms', 'army:anti-mounted', 'expand:food', 'defend:home', 'expand:coin'] },
  { when: { enemyCategory: 'mounted', enemyArmy: 12, sightingAge: 10 }, intents: ['army:anti-mounted', 'defend:home', 'army:anti-mounted', 'expand:arms', 'expand:coin', 'expand:timber'] },
  { when: { enemyCategory: 'ranged', enemyArmy: 6, sightingAge: 10 }, intents: ['army:ranged', 'expand:arms', 'expand:coin', 'expand:food', 'defend:home', 'expand:timber'] },
];

/** The mid-game: expansion versus defence, tech path, counter-composition, and
 *  the scouting that earns the information all of that depends on. */
const MIDGAME_DEMOS: Demo[] = [
  { when: { identity: 'boom', producers: 10 }, intents: ['boom', 'expand:coin', 'expand:food', 'expand:timber', 'expand:arms', 'army:ranged'] },
  { when: { identity: 'tech', producers: 10 }, intents: ['expand:arms', 'army:siege-support', 'expand:coin', 'defend:home', 'army:ranged', 'expand:stone'] },
  { when: { identity: 'contest', producers: 10 }, intents: ['contest:resource', 'scout', 'expand:coin', 'army:mounted', 'expand:arms', 'raid'] },
  { when: { identity: 'pressure', producers: 10 }, intents: ['army:ranged', 'expand:arms', 'raid', 'army:mounted', 'expand:coin', 'scout'] },
  // blind: not having seen the rival in a long time is a reason to look
  { when: { sightingAge: Infinity, army: 10 }, intents: ['scout', 'expand:coin', 'army:ranged', 'expand:arms', 'boom', 'defend:home'] },
  // what the scout brings back changes the answer
  { when: { enemyCategory: 'mounted', enemyArmy: 12, sightingAge: 10 }, intents: ['army:anti-mounted', 'expand:arms', 'army:anti-mounted', 'expand:coin', 'defend:home', 'expand:stone'] },
  { when: { enemyCategory: 'mounted', enemyArmy: 20, sightingAge: 10 }, intents: ['army:anti-mounted', 'defend:home', 'army:anti-mounted', 'expand:arms', 'army:ranged', 'expand:coin'] },
  { when: { enemyCategory: 'ranged', enemyArmy: 12, sightingAge: 10 }, intents: ['army:mounted', 'expand:arms', 'army:ranged', 'expand:coin', 'raid', 'scout'] },
  { when: { enemyCategory: 'melee', enemyArmy: 12, sightingAge: 10 }, intents: ['army:ranged', 'expand:arms', 'defend:home', 'expand:coin', 'army:anti-mounted', 'boom'] },
  { when: { enemyFortified: 5, sightingAge: 20 }, intents: ['army:siege-support', 'expand:arms', 'army:siege-support', 'army:ranged', 'expand:coin', 'contest:resource'] },
  { when: { enemyFortified: 2, sightingAge: 20 }, intents: ['army:siege-support', 'expand:arms', 'army:siege-support', 'expand:coin', 'scout', 'army:ranged'] },
  { when: { threats: 10, enemyArmy: 14 }, intents: ['defend:home', 'army:anti-mounted', 'army:ranged', 'expand:arms', 'defend:home', 'expand:food'] },
];

/** The late game: quotas, wave commitment, and the discipline to regroup
 *  instead of feeding an army into a fortified position piecemeal. */
const LATEGAME_DEMOS: Demo[] = [
  { when: { identity: 'boom', army: 24, producers: 14 }, intents: ['expand:coin', 'expand:arms', 'army:ranged', 'army:siege-support', 'commit', 'expand:food'] },
  { when: { identity: 'tech', army: 24, advanced: 2 }, intents: ['army:siege-support', 'army:ranged', 'expand:arms', 'commit', 'defend:home', 'regroup'] },
  { when: { identity: 'contest', army: 24, advanced: 1 }, intents: ['contest:resource', 'army:mounted', 'raid', 'commit', 'army:siege-support', 'regroup'] },
  { when: { identity: 'pressure', army: 24, advanced: 1 }, intents: ['commit', 'army:ranged', 'army:siege-support', 'raid', 'regroup', 'commit'] },
  // a fortified rival is a siege problem, not a bigger-infantry problem
  { when: { enemyFortified: 5, army: 24, sightingAge: 20 }, intents: ['army:siege-support', 'expand:arms', 'army:siege-support', 'army:ranged', 'commit', 'regroup'] },
  { when: { enemyFortified: 2, army: 24, sightingAge: 20 }, intents: ['army:siege-support', 'army:ranged', 'army:siege-support', 'commit', 'expand:arms', 'regroup'] },
  { when: { enemyCategory: 'mounted', enemyArmy: 24, army: 24, sightingAge: 10 }, intents: ['army:anti-mounted', 'army:ranged', 'army:anti-mounted', 'expand:arms', 'commit', 'regroup'] },
  { when: { enemyCategory: 'mounted', enemyArmy: 12, army: 24, sightingAge: 10 }, intents: ['army:anti-mounted', 'expand:arms', 'army:anti-mounted', 'commit', 'defend:home', 'army:ranged'] },
  { when: { enemyCategory: 'ranged', enemyArmy: 24, army: 24, sightingAge: 10 }, intents: ['army:mounted', 'army:siege-support', 'expand:arms', 'commit', 'raid', 'regroup'] },
  // an army that has just been broken regroups before it commits again
  { when: { threats: 12, army: 6, enemyArmy: 24 }, intents: ['defend:home', 'regroup', 'army:ranged', 'expand:arms', 'army:anti-mounted', 'defend:home'] },
  { when: { threats: 12, army: 24, enemyArmy: 20 }, intents: ['defend:home', 'army:ranged', 'army:siege-support', 'regroup', 'expand:arms', 'commit'] },
  { when: { army: 8, advanced: 0, enemyArmy: 4 }, intents: ['expand:arms', 'army:ranged', 'expand:coin', 'regroup', 'army:siege-support', 'defend:home'] },
];

const DEMOS: Record<Phase, Demo[]> = {
  opening: OPENING_DEMOS, midgame: MIDGAME_DEMOS, lategame: LATEGAME_DEMOS,
};

/** The action suffix of a demonstration, as physical indices. */
function encodeIntents(phase: Phase, demo: Demo): number[] {
  const vocab = PHASE_INTENTS[phase];
  const actions: number[] = [];
  for (let i = 0; i < BUNDLE_LENGTH; i++) {
    const intent = demo.intents[i % demo.intents.length];
    const index = vocab.indexOf(intent);
    if (index < 0) throw new Error(`Intent '${intent}' is not in the ${phase} vocabulary`);
    actions.push(index);
  }
  return actions;
}

/**
 * Turn one demonstration into `variants` training sequences.
 *
 * A demo only speaks about the observation fields it names — "when the rival
 * fields cavalry, train pikes" says nothing about the coin economy. Fitting it
 * with every other slot pinned to one arbitrary value would teach the model
 * that the lesson also depends on those slots, and a match whose economy read
 * differs would then get a blurred answer. Randomising the unspoken slots binds
 * each lesson to exactly the context it is about, and leaves the rest
 * marginalised out.
 */
function expandDemo(phase: Phase, demo: Demo, variants: number, rng: Rng): number[][] {
  const observation: StrategicObservation = { ...NEUTRAL, ...demo.when };
  const base = CONTEXT_SLOTS.map(slot => slot.encode(observation));
  const spoken = CONTEXT_SLOTS.map(slot => slot.reads.some(field => field in demo.when));
  const actions = encodeIntents(phase, demo);
  const rows: number[][] = [];
  for (let v = 0; v < variants; v++) {
    const context = base.map((value, slot) => (
      spoken[slot] || v === 0 ? value : rng.int(CONTEXT_SLOTS[slot].buckets.length)
    ));
    rows.push([...context, ...actions]);
  }
  return rows;
}

const PRIOR_SEED = 20260731;
const PRIOR_STEPS = 400;
/** Trust-region step size: the largest core change allowed per iteration. */
const PRIOR_STEP = 0.05;
/** Randomised contexts per demonstration (the first keeps the neutral one). */
const PRIOR_VARIANTS = 14;

/**
 * Fit one phase MPS to its demonstrations. Deliberately UNDER-fitted: the point
 * of a prior is a broad distribution that leans the right way, not a lookup
 * table that reproduces ten sequences and nothing else. The plan's diversity
 * requirement starts here — a policy collapsed onto a single line before
 * training has begun has nothing left to explore.
 */
function fitPhase(phase: Phase, rng: Rng): MPS {
  const mps = randomMPSWithDims(phaseSlotDims(phase), V2_BOND_DIM, rng);
  const batch = DEMOS[phase].flatMap(demo => expandDemo(phase, demo, PRIOR_VARIANTS, rng));
  for (let step = 0; step < PRIOR_STEPS; step++) fitStepScaled(mps, batch, PRIOR_STEP);
  return mps;
}

/**
 * Fit the whole prior from the demonstrations above. Deterministic from a fixed
 * seed, but ~1.5s of gradient ascent — far too slow to repeat per seat, per
 * replay and per test, so `tools/selfplay/tensorV2Prior.ts` runs this once and
 * commits the result as `modelV2Data.ts` (the same arrangement v1 uses for its
 * artifact). Call it directly only from that tool or from a test that checks
 * the committed file is still what the demonstrations produce.
 */
export function buildPriorV2Model(): TensorV2Model {
  const rng = new Rng(PRIOR_SEED);
  const phases = {} as Record<Phase, SerializedMPS>;
  for (const phase of PHASES) phases[phase] = serializeMPS(fitPhase(phase, rng));
  return { version: 2, vocab: INTENT_VOCAB_VERSION, origin: 'prior', phases };
}

/** The committed prior every Tensor v2 seat starts from. */
export function priorV2Model(): TensorV2Model {
  return PRIOR_V2_MODEL;
}

/**
 * The demonstration rows for one phase — the IMITATION ANCHOR self-play mixes
 * into every refit. The plan is explicit about why it has to stay in the batch:
 * a winner-only loop forgets the supplier-first foundation and collapses onto a
 * single line, and a policy with one line left has nothing to explore.
 */
export function anchorRows(phase: Phase, variants = 4, seed = PRIOR_SEED): number[][] {
  const rng = new Rng(seed);
  return DEMOS[phase].flatMap(demo => expandDemo(phase, demo, variants, rng));
}
