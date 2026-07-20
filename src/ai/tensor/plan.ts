import type { BuildingKey } from '../../types';
import type { UnitKind } from '../../data/units';

/**
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
