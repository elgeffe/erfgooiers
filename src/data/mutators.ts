import { levelSeed } from '../engine/rng';
import type { ModifierSpec } from '../game/Modifiers';
import type { UnitKind } from './units';

/**
 * Level mutators ("curses"): deterministic per-run modifiers stamped on a
 * level and shown before you enter. Each one multiplies the level's gold
 * reward — suffering pays. Stat curses flow through Modifiers like any other
 * effect; a couple carry extra payloads (wild spawns, the Taxman's tick).
 */
export interface MutatorDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** Earliest level this curse may appear on (don't curse the tutorial). */
  minLevel: number;
  /** Gold-reward multiplier for playing under it. */
  rewardMult: number;
  apply?: ModifierSpec[];
  /** Extra wild beasts scattered across the map. */
  spawnWild?: { kind: UnitKind; count: number }[];
}

export const MUTATORS: MutatorDef[] = [
  { id: 'wolf-country', name: 'Wolf Country', desc: 'Wolf packs roam these woods', icon: '🐺',
    minLevel: 3, rewardMult: 1.3,
    spawnWild: [{ kind: 'wolf', count: 6 }] },

  { id: 'drought', name: 'Drought', desc: 'Crops grow 40% slower', icon: '☀️',
    minLevel: 2, rewardMult: 1.2,
    apply: [{ stat: 'fieldGrowth', mult: 0.6 }] },

  { id: 'taxman', name: 'The Taxman', desc: 'Lose 1 gold every minute', icon: '🧾',
    minLevel: 2, rewardMult: 1.25,
    apply: [{ stat: 'taxPerMin', add: 1 }] },

  { id: 'rocky-soil', name: 'Rocky Soil', desc: 'Mining is 30% slower', icon: '🪨',
    minLevel: 2, rewardMult: 1.2,
    apply: [
      { stat: 'gatherTime', mult: 1.3, filter: 'stone' },
      { stat: 'gatherTime', mult: 1.3, filter: 'gold' },
      { stat: 'gatherTime', mult: 1.3, filter: 'coal' },
      { stat: 'gatherTime', mult: 1.3, filter: 'iron' },
    ] },

  { id: 'heavy-clay', name: 'Heavy Clay', desc: 'Serfs haul 20% slower', icon: '🥾',
    minLevel: 2, rewardMult: 1.2,
    apply: [{ stat: 'unitSpeed', mult: 0.8, filter: 'serf' }] },

  { id: 'lean-times', name: 'Lean Times', desc: 'Workers get hungry twice as fast', icon: '🍽️',
    minLevel: 3, rewardMult: 1.25,
    apply: [{ stat: 'hungerRate', mult: 2 }] },

  { id: 'emboldened', name: 'Emboldened Foes', desc: 'Enemies have 30% more health', icon: '💢',
    minLevel: 5, rewardMult: 1.3,
    apply: (['bandit', 'orc', 'troll', 'boar', 'wolf', 'demon', 'dragon'] as const)
      .map(kind => ({ stat: 'combat:hp', mult: 1.3, filter: kind })) },
];

export const MUTATOR_BY_ID: Record<string, MutatorDef> = Object.fromEntries(MUTATORS.map(m => [m.id, m]));

/** Flatten active mutator ids into the ModifierSpecs the level's Modifiers consume. */
export function mutatorSpecsFor(ids: string[]): ModifierSpec[] {
  const out: ModifierSpec[] = [];
  for (const id of ids) { const d = MUTATOR_BY_ID[id]; if (d?.apply) out.push(...d.apply); }
  return out;
}

/** Combined gold-reward multiplier of the active mutators. */
export function mutatorRewardMult(ids: string[]): number {
  let m = 1;
  for (const id of ids) { const d = MUTATOR_BY_ID[id]; if (d) m *= d.rewardMult; }
  return m;
}

/** The curses eligible for a level. */
export function eligibleMutators(levelIndex: number): MutatorDef[] {
  return MUTATORS.filter(m => levelIndex >= m.minLevel);
}

/**
 * Deterministically roll a level's curse from the run seed: none on the
 * opening levels, more likely as the run deepens. Used for a run's first
 * level; between levels the contract picker offers the choice instead.
 */
export function rollMutators(runSeed: number, levelIndex: number): string[] {
  const pool = eligibleMutators(levelIndex);
  if (!pool.length) return [];
  const h = (levelSeed(runSeed, levelIndex) ^ 0x3c6ef372) >>> 0;
  const chance = levelIndex >= 5 ? 70 : 45;
  if ((h >>> 4) % 100 >= chance) return [];
  return [pool[(h >>> 12) % pool.length].id];
}

// =====================================================================
//  Contracts — the run map. After each clear the shop offers a choice of
//  ways to take on the next level: safe, cursed (one curse, more gold) or
//  elite (two curses, much more gold). Deterministic per (run, level), so
//  a reload lands on the same offer. The objective variant differs per
//  contract too, so the choice shapes what you'll build, not just risk.
// =====================================================================
export interface Contract {
  kind: 'safe' | 'cursed' | 'elite';
  name: string;
  mutators: string[];
  rewardMult: number;
  /** Which of the level's objective variants this contract uses. */
  objectiveIdx: number;
  /** Base gold on clear, for display (before speed bonus / gold cards). */
  reward: number;
}

/** The deterministic base objective-variant index for a level (shared with startLevel). */
export function baseObjectiveIdx(runSeed: number, levelIndex: number, nObjectives: number): number {
  return Math.floor((((levelSeed(runSeed, levelIndex) >>> 8) % 9973) / 9973) * nObjectives) % nObjectives;
}

export function contractsFor(runSeed: number, levelIndex: number, nObjectives: number, baseReward: number, forceCurse = false): Contract[] {
  const h = (levelSeed(runSeed, levelIndex) ^ 0x71c92e11) >>> 0;
  const baseObj = baseObjectiveIdx(runSeed, levelIndex, nObjectives);
  const pool = eligibleMutators(levelIndex);
  // ascension 3+: even the "safe" road carries a curse — and pays nothing
  // extra for it, because the constraint is the ascension itself
  const forced = forceCurse && pool.length ? pool[(h >>> 3) % pool.length] : null;
  const out: Contract[] = [
    forced
      ? { kind: 'safe', name: 'No Rest', mutators: [forced.id], rewardMult: 1, objectiveIdx: baseObj, reward: baseReward }
      : { kind: 'safe', name: 'Quiet Roads', mutators: [], rewardMult: 1, objectiveIdx: baseObj, reward: baseReward },
  ];
  if (pool.length) {
    const m1 = pool[h % pool.length];
    out.push({
      kind: 'cursed', name: 'Cursed Contract', mutators: [m1.id], rewardMult: m1.rewardMult,
      objectiveIdx: (baseObj + 1) % nObjectives, reward: Math.round(baseReward * m1.rewardMult),
    });
    const rest = pool.filter(m => m !== m1);
    if (levelIndex >= 4 && rest.length) {
      const m2 = rest[(h >>> 7) % rest.length];
      const mult = m1.rewardMult * m2.rewardMult * 1.25; // elite premium on top
      out.push({
        kind: 'elite', name: 'Elite Contract', mutators: [m1.id, m2.id], rewardMult: mult,
        objectiveIdx: baseObj, reward: Math.round(baseReward * mult),
      });
    }
  }
  return out;
}
