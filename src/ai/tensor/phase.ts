import type { BuildingKey } from '../../types';
import type { AIView } from '../perception';

/**
 * The Tensor v2 phase detector (docs/tensor-retrain-plan.md, "Strategy phases").
 *
 * Phases are gameplay MILESTONES, not merely timers: a policy that switches to
 * late-game strategy because a clock ticked over will happily commit an army it
 * never built. Every read here comes from `AIView`, so the detector sits inside
 * the same fairness boundary as every other policy input — nothing hidden, no
 * peeking at the rival's economy through the fog.
 *
 * Two properties the plan calls for explicitly, both of which this module owns:
 *
 *   • MONOTONIC. Phases only ever advance. A raid that razes the bakery must not
 *     drop a late-game army back into an opening build order; that is what the
 *     recovery overlay is for.
 *   • PURE. `advancePhase` is a function of (previous state, view, events) with
 *     no clock, no rng and no sim access, so the transition table is directly
 *     unit-testable — see tests/ai/tensor-phase.test.ts.
 *
 * The two facts a single snapshot genuinely cannot see — "we have launched a
 * wave" and "these sites have been stalled a while" — arrive as {@link PhaseEvents}
 * from the policy, which owns those clocks.
 */

export type Phase = 'opening' | 'midgame' | 'lategame';

export interface PhaseState {
  phase: Phase;
  /** Sim-seconds at which the current phase began (the commitment clock's base). */
  since: number;
  /** Recovery overlay: fix the economy before resuming the phase plan. */
  recovery: boolean;
}

/** Facts the policy tracks over time and hands to the otherwise pure detector. */
export interface PhaseEvents {
  /** This seat has launched its first real wave (its own "first major attack"). */
  committed?: boolean;
  /** Construction sites the policy's own watch clock has seen stall. */
  stalledSites?: number;
}

/** Time caps stop a deadlocked economy from freezing the policy in one phase.
 *  They are a FALLBACK: the milestone tests below decide the ordinary game. */
export const OPENING_TIME_CAP = 420;
export const MIDGAME_TIME_CAP = 1020;
/** Standing fighters that count as a fieldable army for the late-game test. */
export const FIELD_ARMY = 18;
/** Hostile fighters in/around the base that count as a major wave landing. */
export const MAJOR_WAVE = 10;

/** Recovery is HYSTERETIC — it latches on at the first threshold and only lets
 *  go at the healthier second one, so a policy cannot flap in and out of repair
 *  mode while a single starving serf oscillates around a limit. */
const RECOVERY_ON = { hunger: 32, unstaffed: 3, stalled: 2, castleHp: 0.6 };
const RECOVERY_OFF = { hunger: 55, unstaffed: 1, stalled: 0, castleHp: 0.85 };

export function initialPhase(elapsed = 0): PhaseState {
  return { phase: 'opening', since: elapsed, recovery: false };
}

/** Standing, active buildings of a key that also have the worker they need.
 *  An unstaffed sawmill is a decoration, not a timber industry. */
function staffed(view: AIView, key: BuildingKey): number {
  let count = 0;
  for (const building of view.buildings) {
    if (building.key !== key || !building.active) continue;
    if (building.def.worker && !building.worker) continue;
    count++;
  }
  return count;
}

function anyStaffed(view: AIView, keys: BuildingKey[]): boolean {
  return keys.some(key => staffed(view, key) > 0);
}

/** The observable milestones behind the phase transitions — exported so tests
 *  and the trainer's diagnostics can assert on the reason, not just the phase. */
export interface Milestones {
  /** Trunks are being felled AND sawn: the whole timber chain is running. */
  timber: boolean;
  stone: boolean;
  coin: boolean;
  /** A staple food industry — bread, or a coastal/meat substitute. */
  food: boolean;
  /** A tavern: where that food actually reaches a worker. Bread in a warehouse
   *  feeds nobody, so an opening without this one is not finished. */
  foodService: boolean;
  /** First military production is online. */
  military: boolean;
  /** Cavalry, siege or support capability — the late-game strategic layer. */
  advancedMilitary: boolean;
  /** A field army worth committing. */
  fieldArmy: boolean;
  /** A major hostile force is in the base or standing in view. */
  majorAttack: boolean;
}

export function milestones(view: AIView): Milestones {
  return {
    timber: staffed(view, 'woodcutter') > 0 && staffed(view, 'sawmill') > 0,
    stone: staffed(view, 'quarry') > 0,
    coin: staffed(view, 'mint') > 0,
    food: anyStaffed(view, ['bakery', 'butcher', 'fishery', 'clamdigger']),
    foodService: staffed(view, 'tavern') > 0,
    military: staffed(view, 'barracks') > 0,
    advancedMilitary: anyStaffed(view, ['stable', 'engineer', 'monastery']),
    fieldArmy: view.armySize >= FIELD_ARMY,
    majorAttack: view.threats.length >= MAJOR_WAVE || view.enemyArmySize >= MAJOR_WAVE,
  };
}

/** Has the opening done its job — a staffed core economy plus a way to make
 *  fighters? Every producer in the list is a supplier something later needs. */
export function openingComplete(view: AIView): boolean {
  const m = milestones(view);
  return m.timber && m.stone && m.coin && m.food && m.foodService && m.military;
}

/** Is the match in its decisive stage: a wave has been thrown by either side, or
 *  this seat holds an advanced arm AND an army big enough to use it? */
export function lategameReached(view: AIView, events: PhaseEvents): boolean {
  const m = milestones(view);
  if (events.committed || m.majorAttack) return true;
  return m.advancedMilitary && m.fieldArmy;
}

/** Does the base need repairing before any strategy is worth pursuing? */
export function needsRecovery(view: AIView, events: PhaseEvents, already: boolean): boolean {
  const limits = already ? RECOVERY_OFF : RECOVERY_ON;
  const castle = view.store;
  const castleHurt = !!castle && castle.maxHp > 0 && castle.hp / castle.maxHp < limits.castleHp;
  // A worker gap only counts while no villager is standing by to fill it — a
  // freshly finished building with a villager walking over is not a crisis.
  const workerGap = view.workers.unstaffed > limits.unstaffed && view.workers.freeVillagers === 0;
  return view.averageWorkerHunger < limits.hunger
    || workerGap
    || (events.stalledSites ?? 0) > limits.stalled
    || castleHurt;
}

/**
 * The transition itself. Advances at most ONE phase per call: a snapshot that
 * satisfies both tests still passes through mid-game, so a policy never skips
 * the plan bundle that gets it a mid-game economy.
 */
export function advancePhase(previous: PhaseState, view: AIView, events: PhaseEvents = {}): PhaseState {
  const recovery = needsRecovery(view, events, previous.recovery);
  const held = previous.phase;
  let phase = held;

  if (held === 'opening') {
    if (openingComplete(view) || view.elapsed >= OPENING_TIME_CAP) phase = 'midgame';
  } else if (held === 'midgame') {
    if (lategameReached(view, events) || view.elapsed >= MIDGAME_TIME_CAP) phase = 'lategame';
  }

  if (phase === held) {
    return recovery === previous.recovery ? previous : { ...previous, recovery };
  }
  return { phase, since: view.elapsed, recovery };
}
