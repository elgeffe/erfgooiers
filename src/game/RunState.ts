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
export const MAX_ASCENSION = 5;

/** Tier display names: sensible at first, increasingly honest about the absurdity. */
export const ASCENSION_NAMES = [
  'Normal',
  'Hard',
  'Very Hard',
  'Absurd — the Erfgooiers Weep',
  'Grim — the Long Winter',
  'Infernal — the Gates of Hell',
];

/** What each tier adds (cumulative), for the hero-select picker. */
export const ASCENSION_DESCS = [
  'The base game, at home in Het Gooi',
  'Hard · One fewer shop ware — and the march leaves home: the Polder at level 5, the Ardennes beyond',
  'Very Hard · Timers 15% shorter, and the opening level demands a whole economy (timber + bread) — level 7 follows the Delta coast (clams!), and the Black Forest swallows 8+ (no farmland under the canopy)',
  'Absurd · Every level cursed and every economy goal swells by half — the hunt crosses to Texel, and the run ends among the peaks of the Alps',
  'Grim · Armies thinner still, and the opening level adds coin to its ledger — winter freezes level 9 (no farmland under the snow)',
  'Infernal · The thinnest army of all — and the dragon waits at the gates of Hell (nothing grows, nothing swims)',
];

/** How many wares the between-level shop rolls at this tier. */
export function ascensionShopSlots(a: number): number { return a >= 1 ? 2 : 3; }

/** Multiplier on every level's hard timer at this tier. */
export function ascensionTimerMult(a: number): number { return a >= 2 ? 0.85 : 1; }

/** Does this tier force at least one curse onto every contract? */
export function ascensionForcesCurse(a: number): boolean { return a >= 3; }

/** Fraction of a demolished building's cost returned to the castle: the
 *  beginner tier refunds everything, mid tiers half, the final tiers nothing. */
export function ascensionDemolishRefund(a: number): number { return [1, 0.5, 0.5, 0.5, 0, 0][Math.min(MAX_ASCENSION, Math.max(0, a))]; }

/** Higher tiers grant a smaller default army… */
export function ascensionArmyMult(a: number): number { return [1, 0.65, 0.45, 0.3, 0.25, 0.2][Math.min(MAX_ASCENSION, Math.max(0, a))]; }
/** …but more prep: enemy wave timers & grace delays stretch by this factor. */
export function ascensionPrepMult(a: number): number { return [1, 1.5, 2, 2.5, 2.75, 3][Math.min(MAX_ASCENSION, Math.max(0, a))]; }

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
  tutorials: boolean;           // onboarding aids active this run (Normal tier only)
  playerName: string;           // speedrun scoreboard: who runs (typed at run start)
  playerTitle: string;          // …and under which epithet ("the Brave", …)
  timeSeconds: number;          // summed sim time of every cleared level so far
  levelTimes: number[];         // sim seconds per cleared level, in order (speedrun splits)
}

/** One finished victorious run on the speedrun scoreboard. */
export interface ScoreEntry {
  name: string;          // typed at run start
  title: string;         // chosen epithet ("the Brave", …)
  ascension: number;     // tier the run was won at
  timeSeconds: number;   // summed sim time of all ten cleared levels
  hero: string | null;
  date: number;          // Date.now() at the win
  levelTimes?: number[]; // per-level splits; absent on runs recorded before split tracking
}

/** Epithets offered at run start — pick your legend. */
export const PLAYER_TITLES = [
  'the Brave', 'the Wise', 'the Stout', 'the Drunkard', 'the Gamer',
  'the Swift', 'the Cunning', 'the Bold', 'the Grim', 'the Golden',
  'the Restless', 'the Humble',
];

/** Scoreboard order: highest tier first, fastest time within a tier. */
export function compareScores(a: ScoreEntry, b: ScoreEntry): number {
  return b.ascension - a.ascension || a.timeSeconds - b.timeSeconds;
}

/** Personal-best split per level across every run that recorded splits:
 *  `[i]` is the fastest time anyone on this save cleared level `i+1` in,
 *  or null when no recorded run has a split for that level. */
export function bestLevelTimes(scores: ScoreEntry[]): (number | null)[] {
  const best: (number | null)[] = Array.from({ length: RUN_LEVELS }, () => null);
  for (const s of scores) {
    if (!s.levelTimes) continue;
    for (let i = 0; i < Math.min(s.levelTimes.length, RUN_LEVELS); i++) {
      const t = s.levelTimes[i];
      if (best[i] === null || t < best[i]!) best[i] = t;
    }
  }
  return best;
}

export function formatRunTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Meta-progress that persists across all runs forever. */
export interface MetaState {
  heritage: number;             // meta currency ("Erfgoed")
  unlocks: string[];            // global unlock ids
  activeGlobalBuff: string | null; // at most one owned META_UPGRADE affects runs
  ascension: number;            // highest ascension tier unlocked (0..MAX_ASCENSION)
  tutorialSeen: boolean;        // first-run flag — cleared once the player has begun a run
  stats: { runs: number; levelsCleared: number; bestLevel: number; wins: number };
  scores: ScoreEntry[];         // speedrun scoreboard (victorious runs, best first)
}

export function newRun(seed: number, ascension = 0, tutorials = true): RunState {
  return { runSeed: seed >>> 0, levelIndex: 1, gold: 0, upgrades: [], mutators: [], rewardMult: 1, objectiveIdx: null, hero: null, equipment: [null, null, null], ascension, tutorials, playerName: '', playerTitle: '', timeSeconds: 0, levelTimes: [] };
}

export function newMeta(): MetaState {
  return { heritage: 0, unlocks: [], activeGlobalBuff: null, ascension: 0, tutorialSeen: false, stats: { runs: 0, levelsCleared: 0, bestLevel: 0, wins: 0 }, scores: [] };
}

/** The deterministic map seed for the run's current level. */
export function currentLevelSeed(run: RunState): number {
  return levelSeed(run.runSeed, run.levelIndex);
}
