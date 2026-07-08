import { levelSeed } from '../engine/rng';

/** Where the game currently is in the run lifecycle (Phase 0 state machine). */
export type Phase = 'menu' | 'heroSelect' | 'playing' | 'shop' | 'summary';

/** Levels in a full run; level `RUN_LEVELS` is the boss (see ROADMAP §4). */
export const RUN_LEVELS = 10;

/** Everything that carries across levels *within* a single run. */
export interface RunState {
  runSeed: number;              // fixes every level's map: levelSeed(runSeed, i)
  levelIndex: number;           // 1-based current level (1..RUN_LEVELS)
  gold: number;                 // shop currency, lost on run end
  upgrades: string[];           // bought upgrade ids (applied via Modifiers in Phase 1)
  hero: string | null;          // chosen hero id (Phase 2)
  equipment: (string | null)[]; // weapon / boots / trinket (Phase 2)
}

/** Meta-progress that persists across all runs forever. */
export interface MetaState {
  heritage: number;             // meta currency ("Erfgoed")
  unlocks: string[];            // global unlock ids
  stats: { runs: number; levelsCleared: number; bestLevel: number };
}

export function newRun(seed: number): RunState {
  return { runSeed: seed >>> 0, levelIndex: 1, gold: 0, upgrades: [], hero: null, equipment: [null, null, null] };
}

export function newMeta(): MetaState {
  return { heritage: 0, unlocks: [], stats: { runs: 0, levelsCleared: 0, bestLevel: 0 } };
}

/** The deterministic map seed for the run's current level. */
export function currentLevelSeed(run: RunState): number {
  return levelSeed(run.runSeed, run.levelIndex);
}
