import { levelSeed } from '../engine/rng';

/** Where the game currently is in the run lifecycle (Phase 0 state machine). */
export type Phase = 'menu' | 'heroSelect' | 'playing' | 'shop' | 'summary';

/** Levels in a full run; level `RUN_LEVELS` is the boss (see ROADMAP §4). */
export const RUN_LEVELS = 10;

// =====================================================================
//  Ascension — post-victory difficulty tiers (ROADMAP Phase 4). Winning a
//  run at tier N unlocks tier N+1; each tier stacks a new constraint on
//  top of the previous ones. Constraints pay nothing extra — the climb is
//  the reward.
// =====================================================================
export const MAX_ASCENSION = 3;

/** Tier display names: sensible at first, increasingly honest about the absurdity. */
export const ASCENSION_NAMES = [
  'Normal',
  'Hard',
  'Very Hard',
  'Absurd — the Erfgooiers Weep',
];

/** What each tier adds (cumulative), for the hero-select picker. */
export const ASCENSION_DESCS = [
  'The base game, at home in Het Gooi',
  'Hard · One fewer shop ware — and levels 5+ cross into the Ardennes (no vineyards this far north)',
  'Very Hard · Timers 15% shorter — and the Black Forest swallows levels 7+ (no farmland under the canopy)',
  'Absurd · Every level cursed — and the run ends among the peaks of the Alps',
];

/** How many wares the between-level shop rolls at this tier. */
export function ascensionShopSlots(a: number): number { return a >= 1 ? 2 : 3; }

/** Multiplier on every level's hard timer at this tier. */
export function ascensionTimerMult(a: number): number { return a >= 2 ? 0.85 : 1; }

/** Does this tier force at least one curse onto every contract? */
export function ascensionForcesCurse(a: number): boolean { return a >= 3; }

/** Everything that carries across levels *within* a single run. */
export interface RunState {
  runSeed: number;              // fixes every level's map: levelSeed(runSeed, i)
  levelIndex: number;           // 1-based current level (1..RUN_LEVELS)
  gold: number;                 // shop currency, lost on run end
  upgrades: string[];           // owned card ids (max MAX_CARDS; applied via Modifiers)
  mutators: string[];           // the current level's active curse ids
  rewardMult: number;           // the chosen contract's gold multiplier (curses + elite)
  objectiveIdx: number | null;  // contract-chosen objective variant (null = seed default)
  hero: string | null;          // chosen run-wide hero rule set
  equipment: (string | null)[]; // reserved weapon / boots / trinket slots
  ascension: number;            // difficulty tier this run is played at (Phase 4)
}

/** Meta-progress that persists across all runs forever. */
export interface MetaState {
  heritage: number;             // meta currency ("Erfgoed")
  unlocks: string[];            // global unlock ids
  ascension: number;            // highest ascension tier unlocked (0..MAX_ASCENSION)
  stats: { runs: number; levelsCleared: number; bestLevel: number; wins: number };
}

export function newRun(seed: number, ascension = 0): RunState {
  return { runSeed: seed >>> 0, levelIndex: 1, gold: 0, upgrades: [], mutators: [], rewardMult: 1, objectiveIdx: null, hero: null, equipment: [null, null, null], ascension };
}

export function newMeta(): MetaState {
  return { heritage: 0, unlocks: [], ascension: 0, stats: { runs: 0, levelsCleared: 0, bestLevel: 0, wins: 0 } };
}

/** The deterministic map seed for the run's current level. */
export function currentLevelSeed(run: RunState): number {
  return levelSeed(run.runSeed, run.levelIndex);
}
