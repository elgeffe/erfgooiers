import type { BuildingKey } from '../../types';
import type { UnitKind } from '../../data/units';
import type { Phase } from './phase';

/**
 * ══ Tensor v1 — the opening alphabet ══════════════════════════════════════
 *
 * The strategy alphabet the MPS speaks: one symbol per macro *intent*. A sampled
 * plan is a length-{@link PLAN_LENGTH} sequence of these symbols — a correlated
 * opening the tensor network draws as a whole, not a per-slot independent guess.
 *
 * Two symbol families plus a pacing token:
 *   • build:KEY  — raise one of that building (the ORDER of these is the opening)
 *   • train:KIND — a vote for that unit in the army mix (aggregated into weights)
 *   • econ       — "let the economy breathe"; grow whatever producer is scarcest
 *
 * The vocabulary is deliberately compact (d ≈ this list) so the cores stay tiny
 * and the self-play search is tractable, while still spanning the full economy,
 * the weapon/armour chain, cavalry/siege/priests, and roads.
 */
export type Intent =
  | { kind: 'build'; key: BuildingKey }
  | { kind: 'train'; unit: UnitKind }
  | { kind: 'econ' };

/** The ordered action vocabulary. Index in this array = physical index in the
 *  MPS, so it must stay STABLE once a model is trained against it. */
export const ACTIONS: Intent[] = [
  // economy & coin chain
  { kind: 'build', key: 'woodcutter' },
  { kind: 'build', key: 'sawmill' },
  { kind: 'build', key: 'forester' },
  { kind: 'build', key: 'quarry' },
  { kind: 'build', key: 'goldmine' },
  { kind: 'build', key: 'coalmine' },
  { kind: 'build', key: 'mint' },
  // food chain
  { kind: 'build', key: 'farm' },
  { kind: 'build', key: 'mill' },
  { kind: 'build', key: 'bakery' },
  { kind: 'build', key: 'tavern' },
  // war economy
  { kind: 'build', key: 'barracks' },
  { kind: 'build', key: 'ironmine' },
  { kind: 'build', key: 'smithy' },
  { kind: 'build', key: 'armory' },
  { kind: 'build', key: 'stable' },
  { kind: 'build', key: 'engineer' },
  { kind: 'build', key: 'monastery' },
  // army composition votes
  { kind: 'train', unit: 'soldier' },
  { kind: 'train', unit: 'archer' },
  { kind: 'train', unit: 'pikeman' },
  { kind: 'train', unit: 'knight' },
  { kind: 'train', unit: 'lancer' },
  // pacing
  { kind: 'econ' },
];

export const ACTION_DIM = ACTIONS.length;
export const PLAN_LENGTH = 22;
export const BOND_DIM = 4;

/** The building each unit kind is trained at — a plan that votes for a unit but
 *  never builds its trainer is voting for nothing, so the decoder can tell. */
export const TRAINER_OF: Partial<Record<UnitKind, BuildingKey>> = {
  soldier: 'barracks', archer: 'barracks', pikeman: 'barracks',
  knight: 'barracks', lancer: 'stable', horseknight: 'stable',
  horsearcher: 'stable', priest: 'monastery', onager: 'engineer', trebuchet: 'engineer',
};

export interface DecodedPlan {
  /** Buildings to raise, in the order the plan named them (repeats allowed). */
  buildOrder: BuildingKey[];
  /** Army-composition weights = how many times each unit was voted for. */
  unitWeights: Partial<Record<UnitKind, number>>;
  /** Number of `econ` pacing tokens — a plan's appetite for economy over rush. */
  econ: number;
}

/** Turn a raw action-index sequence into an executable plan. */
export function decodePlan(seq: number[]): DecodedPlan {
  const buildOrder: BuildingKey[] = [];
  const unitWeights: Partial<Record<UnitKind, number>> = {};
  let econ = 0;
  for (const idx of seq) {
    const action = ACTIONS[idx];
    if (!action) continue;
    if (action.kind === 'build') buildOrder.push(action.key);
    else if (action.kind === 'train') unitWeights[action.unit] = (unitWeights[action.unit] ?? 0) + 1;
    else econ++;
  }
  return { buildOrder, unitWeights, econ };
}

/** Index of an intent in the vocabulary (for authoring expert sequences). */
function ix(match: (a: Intent) => boolean): number {
  const i = ACTIONS.findIndex(match);
  if (i < 0) throw new Error('unknown intent in expert plan');
  return i;
}
const B = (key: BuildingKey): number => ix(a => a.kind === 'build' && a.key === key);
const T = (unit: UnitKind): number => ix(a => a.kind === 'train' && a.unit === unit);
const ECON = ix(a => a.kind === 'econ');

/**
 * Expert openings for imitation PRE-training — the human build order from
 * docs/skirmish-ai-design.md (wood → timber → quarry → gold → coal → mint →
 * food → tavern → barracks → iron+coal → weapons/armour), with a few legitimate
 * variations so the prior samples a spread rather than one rigid line. Self-play
 * refinement then reshapes this into whatever actually beats Godlike.
 */
export function expertPlans(): number[][] {
  const base = [
    B('woodcutter'), B('sawmill'), B('quarry'), B('goldmine'), B('coalmine'), B('mint'),
    B('farm'), B('mill'), B('bakery'), B('tavern'),
    B('barracks'), T('archer'), B('ironmine'), B('coalmine'), B('smithy'),
    T('soldier'), B('armory'), T('knight'), B('stable'), T('lancer'), T('pikeman'), ECON,
  ];
  const forester = [
    B('woodcutter'), B('sawmill'), B('forester'), B('quarry'), B('goldmine'), B('coalmine'),
    B('mint'), B('farm'), B('mill'), B('bakery'),
    B('barracks'), T('archer'), T('soldier'), B('ironmine'), B('smithy'),
    B('coalmine'), B('armory'), T('knight'), B('tavern'), T('pikeman'), B('stable'), T('lancer'),
  ];
  const earlyBarracks = [
    B('woodcutter'), B('sawmill'), B('quarry'), B('goldmine'), B('coalmine'), B('mint'),
    B('barracks'), T('archer'), T('archer'), B('farm'),
    B('mill'), B('bakery'), B('ironmine'), B('coalmine'), B('smithy'),
    T('soldier'), T('pikeman'), B('armory'), T('knight'), B('tavern'), ECON, ECON,
  ];
  return [base, forester, earlyBarracks];
}

/**
 * ══ Tensor v2 — the phase-aware strategic vocabulary ══════════════════════
 *
 * Everything above is the v1 alphabet: a flat sequence of build/train symbols
 * sampled once at match start. It stays exactly as it is, because the committed
 * `model.ts` artifact is indexed against it — reading a v1 model through a
 * changed alphabet would silently play a different strategy (the plan is
 * explicit about this: "v1 model indices must remain readable as v1").
 *
 * v2 speaks a different language. The model no longer picks buildings; it picks
 * short bundles of strategic INTENT — what to pursue and when — which a shared
 * deterministic executor turns into supplier-first construction, legal
 * placement, staffing and unit quotas. That split is what keeps the comparison
 * with Classic fair: both sides get the same proven logistics, and only the
 * strategy differs.
 *
 * The slot layout of a v2 MPS is CONTEXT first, ACTIONS second:
 *
 *   [ identity | economy … sighting age ] [ intent × BUNDLE_LENGTH ]
 *     └─ clamped to the observation ──┘     └─ sampled conditionally ─┘
 *
 * Sampling with the context slots clamped is what makes the policy adaptive:
 * the same model produces a different bundle when the observation changes.
 */

export const INTENT_VOCAB_VERSION = 2;

export type IntentId =
  // economy — grow a specific supplier line
  | 'expand:timber' | 'expand:stone' | 'expand:coin' | 'expand:food' | 'expand:arms'
  // map & defence
  | 'defend:home' | 'contest:resource' | 'recover:economy'
  // composition — what the army should be made of
  | 'army:ranged' | 'army:anti-mounted' | 'army:mounted' | 'army:siege-support'
  // tempo — how hard to push and when
  | 'boom' | 'scout' | 'raid' | 'commit' | 'regroup';

/**
 * The intents each phase may draw. Deliberately NOT one shared alphabet: an
 * opening bundle that can sample `commit` wastes slots on an army that does not
 * exist, and a late-game bundle that cannot sample siege or a home guard cannot
 * make the end-game choices Godlike makes. Order is the physical index, so each
 * list must stay STABLE once a v2 checkpoint is trained against it.
 */
export const PHASE_INTENTS: Record<Phase, readonly IntentId[]> = {
  opening: [
    'expand:timber', 'expand:stone', 'expand:coin', 'expand:food', 'expand:arms',
    'defend:home', 'army:ranged', 'army:anti-mounted', 'boom', 'scout',
  ],
  midgame: [
    'expand:timber', 'expand:stone', 'expand:coin', 'expand:food', 'expand:arms',
    'defend:home', 'contest:resource',
    'army:ranged', 'army:anti-mounted', 'army:mounted', 'army:siege-support',
    'boom', 'scout', 'raid',
  ],
  lategame: [
    'expand:coin', 'expand:food', 'expand:arms',
    'defend:home', 'contest:resource',
    'army:ranged', 'army:anti-mounted', 'army:mounted', 'army:siege-support',
    'scout', 'raid', 'commit', 'regroup',
  ],
};

/** Strategic intents per sampled bundle. The plan's window is four to eight:
 *  long enough for the MPS's correlations to mean something, short enough that
 *  a bundle finishes while its observation is still true. */
export const BUNDLE_LENGTH = 6;
export const V2_BOND_DIM = 4;

/** The latent strategy identity `z`, drawn once per match: a coherent bias, not
 *  a script. It is a clamped context slot, so it colours every later bundle. */
export type StrategyIdentity = 'boom' | 'tech' | 'contest' | 'pressure';
export const IDENTITIES: readonly StrategyIdentity[] = ['boom', 'tech', 'contest', 'pressure'];

/** What this seat believes about the rival's army — 'unknown' is a real answer
 *  under fog, and a meaningful input, not a licence to guess. */
export type KnownCategory = 'unknown' | 'melee' | 'ranged' | 'mounted';

/**
 * The fair observation the context slots are cut from. Every field is either
 * visible in `AIView` now or remembered from something this seat once saw —
 * see `src/ai/strategy/tensor.ts` for how memory is maintained.
 */
export interface StrategicObservation {
  identity: StrategyIdentity;
  /** Staffed production buildings: the depth of the economy actually running. */
  producers: number;
  /** Own standing fighters. */
  army: number;
  /** Own stable/engineer/monastery count — the advanced arms available. */
  advanced: number;
  /** Best known rival army size: what is visible now, else what was last seen. */
  enemyArmy: number;
  /** Dominant known rival composition. */
  enemyCategory: KnownCategory;
  /** Known rival towers plus curtain — what an assault would have to break. */
  enemyFortified: number;
  /** Hostile fighters standing among our own buildings. */
  threats: number;
  /** Sim-seconds since the rival's army was last seen (Infinity = never). */
  sightingAge: number;
}

/** One clamped context slot: a coarse discretization of the observation. */
export interface ContextSlot {
  id: string;
  /** The observation fields this slot reads. Naming them lets the trainer tell
   *  which slots a demonstration actually speaks about, so a lesson binds to
   *  the context it is about and marginalises over the rest. */
  reads: readonly (keyof StrategicObservation)[];
  /** Bucket labels, low to high. Length is the slot's physical dimension. */
  buckets: readonly string[];
  /** Which bucket an observation falls in. */
  encode: (observation: StrategicObservation) => number;
}

/** Beyond this, a remembered sighting is not worth conditioning on. */
export const MEMORY_HORIZON = 240;

/**
 * The context, compressed to FOUR slots — and the number is a measured
 * constraint, not a taste.
 *
 * In an MPS the conditional influence of a clamped slot has to travel along the
 * chain to reach the action block, through one bond matrix per slot in between.
 * At the bond dimension this project can afford, a slot three or more positions
 * from the actions barely moves the sampled bundle at all; the nearest three
 * condition it cleanly. A nine-slot context therefore does not describe the
 * match in more detail — it silently throws most of the description away.
 *
 * So each slot below carries a whole family of related facts, ordered with the
 * most decision-relevant last (closest to the actions). Where facts compete for
 * one slot, the more urgent wins: a wave in your base outranks knowing that the
 * rival is also fortified, because it is the fact that must change your plan
 * this minute.
 */
export const CONTEXT_SLOTS: readonly ContextSlot[] = [
  {
    // Weakest conditioning position, and the right one for `z`: an identity is
    // a soft bias over a whole match, not a reflex.
    id: 'identity', reads: ['identity'], buckets: IDENTITIES,
    encode: o => Math.max(0, IDENTITIES.indexOf(o.identity)),
  },
  {
    // How far along this seat itself is: what it can afford to attempt.
    id: 'development', reads: ['producers', 'army', 'advanced'],
    buckets: ['settling', 'established', 'fielding', 'commanding'],
    encode: o => {
      if (o.army >= 20 && o.advanced >= 1) return 3;
      if (o.army >= 8 || o.advanced >= 1) return 2;
      return o.producers >= 5 ? 1 : 0;
    },
  },
  {
    // What is KNOWN of the rival's army. Under fog, an ageing sighting decays
    // back to 'unseen' — not seeing is a real answer, never a licence to guess.
    id: 'enemy-army', reads: ['enemyCategory', 'enemyArmy', 'sightingAge'],
    buckets: ['unseen', 'foot', 'ranged', 'mounted'],
    encode: o => {
      if (o.sightingAge > MEMORY_HORIZON || o.enemyArmy < 1) return 0;
      return o.enemyCategory === 'melee' ? 1 : o.enemyCategory === 'ranged' ? 2 : o.enemyCategory === 'mounted' ? 3 : 0;
    },
  },
  {
    // The most urgent external fact, adjacent to the actions because it is the
    // one most likely to overrule whatever the plan was going to be.
    id: 'pressure', reads: ['threats', 'enemyFortified'],
    buckets: ['quiet', 'fortified', 'raid', 'wave'],
    encode: o => {
      if (o.threats >= 8) return 3;
      if (o.threats >= 1) return 2;
      return o.enemyFortified >= 1 ? 1 : 0;
    },
  },
];

export const CONTEXT_LENGTH = CONTEXT_SLOTS.length;

/** Physical dimension of every slot of a phase's MPS, context then actions. */
export function phaseSlotDims(phase: Phase): number[] {
  const context = CONTEXT_SLOTS.map(slot => slot.buckets.length);
  const actions = new Array(BUNDLE_LENGTH).fill(PHASE_INTENTS[phase].length);
  return [...context, ...actions];
}

/** The clamped prefix for a sample: one bucket index per context slot, then a
 *  free (null) slot per intent the bundle will draw. */
export function encodeEvidence(observation: StrategicObservation): (number | null)[] {
  const context = CONTEXT_SLOTS.map(slot => slot.encode(observation));
  return [...context, ...new Array<number | null>(BUNDLE_LENGTH).fill(null)];
}

/** Read the sampled action suffix back as intents. Unknown indices are dropped
 *  rather than guessed — a corrupt checkpoint must not silently play. */
export function decodeBundle(phase: Phase, seq: number[]): IntentId[] {
  const vocab = PHASE_INTENTS[phase];
  const out: IntentId[] = [];
  for (const index of seq.slice(CONTEXT_LENGTH)) {
    const intent = vocab[index];
    if (intent) out.push(intent);
  }
  return out;
}
