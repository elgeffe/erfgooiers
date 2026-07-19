import type { UnitKind } from './units';

/**
 * CPU-player profiles for skirmish: difficulty × stance × policy as data, per
 * the plan in docs/skirmish-ai-design.md. Every knob here is a human-plausible
 * lever — reaction time, action budget, plan quality, appetite — never a
 * resource multiplier or rule exemption: all difficulties play through the
 * same validated command seam as a human (`applyGameCommand`).
 */
export type AIDifficulty = 'easy' | 'hard' | 'godlike';
export type AIStance = 'defensive' | 'balanced' | 'offensive';
export type AIPolicyKind = 'idle' | 'random' | 'classic';

export interface AIProfile {
  id: string;
  name: string;
  desc: string;
  policy: AIPolicyKind;
  difficulty: AIDifficulty;
  stance: AIStance;

  // ---- cadence & fairness budgets ----
  /** Seconds between macro (build/train) decision passes. */
  macroPeriod: number;
  /** Seconds between tactics (army) decision passes. */
  tacticsPeriod: number;
  /** Seconds a threat must persist before the bot responds to it. */
  reactionDelay: number;
  /** Hard action budget: commands per minute (a human-like APM ceiling). */
  apm: number;
  /** Chance a macro pass is fumbled entirely — Easy's deliberate blunders. */
  errorRate: number;

  // ---- macro appetite ----
  /** Multiplier on economy building targets (Godlike builds the deeper base). */
  econScale: number;
  /** Unfinished construction sites allowed at once (overreach guard). */
  maxPendingSites: number;
  /** Never spend the last coins on workers: keep this buffer for the army. */
  workerReserveCoin: number;
  /** Watchtowers wanted on the home approach. */
  towers: number;

  // ---- army shape ----
  /** Stop training fighters beyond this standing-army size. */
  armyCap: number;
  /** Training weights among the affordable fighter kinds. */
  unitMix: Partial<Record<UnitKind, number>>;

  // ---- tactics ----
  /** Launch an attack once this many fighters stand mustered. */
  attackArmy: number;
  /** Commitment: minimum seconds between launched attacks (no plan-flapping). */
  minAttackInterval: number;
  /** Abort the attack when the squad falls below this fraction of launch size. */
  retreatRatio: number;
  /** Ring the town bell (workers shelter, castle fires faster) under siege. */
  useBell: boolean;
}

const DIFFICULTY_BASE: Record<AIDifficulty, Omit<AIProfile, 'id' | 'name' | 'desc' | 'policy' | 'stance' | 'difficulty'>> = {
  easy: {
    macroPeriod: 6, tacticsPeriod: 2, reactionDelay: 5, apm: 10, errorRate: 0.2,
    econScale: 0.8, maxPendingSites: 2, workerReserveCoin: 2, towers: 0,
    armyCap: 14, unitMix: { soldier: 2, archer: 2 },
    attackArmy: 7, minAttackInterval: 150, retreatRatio: 0.15, useBell: false,
  },
  hard: {
    macroPeriod: 2.5, tacticsPeriod: 1, reactionDelay: 2, apm: 30, errorRate: 0.03,
    econScale: 1, maxPendingSites: 3, workerReserveCoin: 3, towers: 1,
    armyCap: 24, unitMix: { soldier: 3, archer: 2, pikeman: 1, knight: 1 },
    attackArmy: 12, minAttackInterval: 100, retreatRatio: 0.4, useBell: true,
  },
  godlike: {
    macroPeriod: 1.2, tacticsPeriod: 0.5, reactionDelay: 0.6, apm: 60, errorRate: 0,
    econScale: 1.3, maxPendingSites: 4, workerReserveCoin: 4, towers: 2,
    armyCap: 32, unitMix: { soldier: 3, archer: 2, pikeman: 1, knight: 2 },
    attackArmy: 16, minAttackInterval: 80, retreatRatio: 0.5, useBell: true,
  },
};

/** Stance recolors the same difficulty: weights and thresholds, not code paths. */
function applyStance(base: Omit<AIProfile, 'id' | 'name' | 'desc' | 'policy' | 'stance' | 'difficulty'>, stance: AIStance): typeof base {
  if (stance === 'offensive') {
    return {
      ...base,
      towers: Math.max(0, base.towers - 1),
      attackArmy: Math.max(5, Math.round(base.attackArmy * 0.7)),
      minAttackInterval: Math.round(base.minAttackInterval * 0.75),
      retreatRatio: Math.max(0.1, base.retreatRatio - 0.1),
    };
  }
  if (stance === 'defensive') {
    return {
      ...base,
      towers: base.towers + 2,
      attackArmy: Math.round(base.attackArmy * 1.5),
      minAttackInterval: Math.round(base.minAttackInterval * 1.25),
      retreatRatio: Math.min(0.7, base.retreatRatio + 0.15),
      armyCap: base.armyCap + 4,
    };
  }
  return base;
}

const DIFFICULTY_NAME: Record<AIDifficulty, string> = { easy: 'Easy', hard: 'Hard', godlike: 'Godlike' };
const STANCE_NAME: Record<AIStance, string> = { defensive: 'Defensive', balanced: 'Balanced', offensive: 'Offensive' };

function classic(difficulty: AIDifficulty, stance: AIStance): AIProfile {
  return {
    id: `classic-${difficulty}-${stance}`,
    name: `Classic ${DIFFICULTY_NAME[difficulty]} (${STANCE_NAME[stance]})`,
    desc: 'Handwritten utility-scripted opponent — the permanent benchmark.',
    policy: 'classic', difficulty, stance,
    ...applyStance(DIFFICULTY_BASE[difficulty], stance),
  };
}

/** Throwaway seam-proving policies (Phase 0) double as the ladder floor. */
const IDLE: AIProfile = {
  id: 'idle', name: 'Idle', desc: 'Does nothing — proves the seat plumbing.',
  policy: 'idle', difficulty: 'easy', stance: 'balanced',
  macroPeriod: 3600, tacticsPeriod: 3600, reactionDelay: 3600, apm: 0, errorRate: 0,
  econScale: 0, maxPendingSites: 0, workerReserveCoin: 0, towers: 0,
  armyCap: 0, unitMix: {},
  attackArmy: 1e9, minAttackInterval: 1e9, retreatRatio: 0, useBell: false,
};

const RANDOM: AIProfile = {
  id: 'random', name: 'Random', desc: 'Legal random commands on a slow cadence.',
  policy: 'random', difficulty: 'easy', stance: 'balanced',
  macroPeriod: 5, tacticsPeriod: 5, reactionDelay: 5, apm: 12, errorRate: 0,
  econScale: 1, maxPendingSites: 3, workerReserveCoin: 0, towers: 0,
  armyCap: 12, unitMix: { soldier: 1, archer: 1 },
  attackArmy: 1e9, minAttackInterval: 1e9, retreatRatio: 0, useBell: false,
};

export const AI_PROFILES: Record<string, AIProfile> = Object.fromEntries([
  IDLE, RANDOM,
  ...(['easy', 'hard', 'godlike'] as const).flatMap(difficulty =>
    (['defensive', 'balanced', 'offensive'] as const).map(stance => classic(difficulty, stance))),
].map(profile => [profile.id, profile]));

export function aiProfile(id: string): AIProfile {
  const profile = AI_PROFILES[id];
  if (!profile) throw new Error(`Unknown AI profile '${id}' — known: ${Object.keys(AI_PROFILES).join(', ')}`);
  return profile;
}
