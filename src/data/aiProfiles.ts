import type { UnitKind } from './units';

/**
 * CPU-player profiles for skirmish: difficulty × policy as data, per the plan
 * in docs/skirmish-ai-design.md. Stances were removed — three difficulty
 * PERSONAS replace the nine difficulty×stance permutations, which keeps the
 * training/evaluation matrix small. Every knob here is a human-plausible
 * lever — reaction time, action budget, plan quality, appetite — never a
 * resource multiplier or rule exemption: all difficulties play through the
 * same validated command seam as a human (`applyGameCommand`).
 *
 * The personas:
 * - EASY: a defensive, slow homesteader. Guards its patch behind towers,
 *   blunders often, and only rarely wanders over to bother you.
 * - HARD: a defensive fortress-builder with a slow fuse. Quicker hands than
 *   Easy, walls and towers early, sits on its hoard building a real military
 *   through the midgame — then breaks out late with one big combined wave.
 * - GODLIKE: the pro. Fields a fast raid party that pesters your
 *   infrastructure from the opening, walls up and counters what it scouts
 *   meanwhile, and plans a large, diverse late-game army for the kill.
 */
export type AIDifficulty = 'easy' | 'hard' | 'godlike';
export type AIPolicyKind = 'idle' | 'random' | 'classic' | 'tensor';

export interface AIProfile {
  id: string;
  name: string;
  desc: string;
  policy: AIPolicyKind;
  difficulty: AIDifficulty;

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
  /** Endless-expansion depth (0 = openings only, higher = more copies of every
   *  producer and the full military spread). This is what stops a strong
   *  economy from plateauing: Godlike keeps compounding producers and fielding
   *  a diverse army long after the opening build order is done. Easy = 0. */
  expansion: number;
  /** Unfinished construction sites allowed at once (overreach guard). */
  maxPendingSites: number;
  /** Never spend the last coins on workers: keep this buffer for the army. */
  workerReserveCoin: number;
  /** Watchtowers wanted on the home approach. */
  towers: number;
  /** Fortification RINGS around the castle (0–2): layered square curtains
   *  with gates toward the enemy and the rear, planned by the shared
   *  fortification planner. Gates keep the owner's serfs and armies flowing,
   *  so the baileys between rings stay working ground. */
  walls: number;

  // ---- army shape ----
  /** Stop training fighters beyond this standing-army size. */
  armyCap: number;
  /** Training weights among the affordable fighter kinds. */
  unitMix: Partial<Record<UnitKind, number>>;

  // ---- tactics ----
  /** Launch an attack once this many fighters stand mustered. Under fog this
   *  is the whole story — an unscouted rival never lowers the bar. */
  attackArmy: number;
  /** Commitment: minimum seconds between launched attacks (no plan-flapping).
   *  The late-game personas keep this LONG: fewer, bigger, better waves. */
  minAttackInterval: number;
  /** Abort the attack when the squad falls below this fraction of launch size. */
  retreatRatio: number;
  /** Ring the town bell (workers shelter, castle fires faster) under siege. */
  useBell: boolean;
  /** Reactivity to the rival's army composition (0..1): a better player scouts
   *  what the enemy fields and trains counters (pikemen vs cavalry, durable
   *  melee vs archers, archers vs melee). 0 = a fixed shopping list. */
  counter: number;
  /** Fraction of the army held home as a standing garrison during attacks. */
  homeGuard: number;
  /** Fighters per harassment raid between attacks (0 = never raids). Raids
   *  double as scouting under fog — they are how the bot sees anything. */
  raidSize: number;
  /** Seconds between harassment raids. */
  raidInterval: number;
}

const DIFFICULTY_BASE: Record<AIDifficulty, Omit<AIProfile, 'id' | 'name' | 'desc' | 'policy' | 'difficulty'>> = {
  // The defensive, slow homesteader: it stays a small settlement (no endless
  // expansion) but bolsters DEFENCE — a ring of towers and a defensive unit
  // mix (spearwall + archers, no cavalry) — and only rarely counter-punches.
  // Blunders one pass in five.
  easy: {
    macroPeriod: 6, tacticsPeriod: 2, reactionDelay: 5, apm: 10, errorRate: 0.2,
    econScale: 0.85, expansion: 0, maxPendingSites: 2, workerReserveCoin: 2, towers: 4, walls: 0,
    armyCap: 18, unitMix: { soldier: 3, pikeman: 2, archer: 3 },
    attackArmy: 14, minAttackInterval: 240, retreatRatio: 0.3, useBell: true,
    counter: 0, homeGuard: 0.35, raidSize: 0, raidInterval: 1e9,
  },
  // The defensive-but-mobile tier with a slow fuse: quicker cadence and cleaner
  // play than Easy. It runs the mid-game resource BOOM (expansion 2 opens the
  // weapons + armour + priest spread and keeps multiplying the coin engine),
  // hoards a big army of infantry + archers + knights + priests behind a ring
  // of TOWERS (no walls — the impregnable curtain is Godlike's alone), then
  // breaks out LATE with one hard wave. (No cavalry — a simpler roster.)
  hard: {
    macroPeriod: 2.5, tacticsPeriod: 1, reactionDelay: 2, apm: 40, errorRate: 0.03,
    econScale: 1, expansion: 2, maxPendingSites: 5, workerReserveCoin: 3, towers: 3, walls: 0,
    armyCap: 50, unitMix: { soldier: 3, archer: 2, pikeman: 1, knight: 2, trebuchet: 1, priest: 1 },
    attackArmy: 30, minAttackInterval: 190, retreatRatio: 0.5, useBell: true,
    counter: 0.6, homeGuard: 0.3, raidSize: 0, raidInterval: 1e9,
  },
  // The pro: a fast raid party pesters the rival's infrastructure (and
  // scouts through the fog) from the opening, walls and towers rise at home
  // meanwhile, the deepest economy compounds (expansion 3 — it contests the
  // map's central resources and never stops multiplying producers), and the
  // kill arrives late as a large, counter-picked DEMOLITION army: infantry +
  // knights + archers + priests, spearheaded by SIEGE that out-ranges the
  // rival's towers and cracks its storehouse. (No cavalry — simpler roster.)
  godlike: {
    macroPeriod: 1.2, tacticsPeriod: 0.5, reactionDelay: 0.6, apm: 66, errorRate: 0,
    // expansion 3 is the deepest economy — the pro contests the map's central
    // ore and never stops compounding producers. It edges Hard on execution
    // (cadence, APM, reactions, counter, early raids) and army cap; towers 3
    // gives defensive parity. NOTE: vs Hard's turtle this is still a close,
    // slightly-losing matchup in self-play — an aggressive-vs-turtle archetype
    // clash left as a known playtest/balance item, not a regression.
    // walls 0 for now — the AI's wall line was weak and gateless; disabled
    // until the fortification planner is reworked (tracked as a follow-up)
    econScale: 1, expansion: 3, maxPendingSites: 7, workerReserveCoin: 3, towers: 3, walls: 0,
    // onagers wreck the enemy line in the field clash (anti-personnel splash),
    // trebuchets (structureMult 4) then break the walls and storehouse — the
    // demolition core, so they're weighted highest of the siege pair
    armyCap: 75, unitMix: { soldier: 3, archer: 3, pikeman: 2, knight: 3, onager: 2, trebuchet: 3, priest: 1 },
    attackArmy: 30, minAttackInterval: 150, retreatRatio: 0.55, useBell: true,
    counter: 1, homeGuard: 0.25, raidSize: 6, raidInterval: 90,
  },
};

const DIFFICULTY_NAME: Record<AIDifficulty, string> = { easy: 'Easy', hard: 'Hard', godlike: 'Godlike' };
const DIFFICULTY_DESC: Record<AIDifficulty, string> = {
  easy: 'A slow, defensive homesteader — guards its towers and rarely marches.',
  hard: 'A defensive fortress with a slow fuse — builds up, then hits hard late.',
  godlike: 'The pro — early raids pester your economy while a walled, diverse late-game army grows.',
};

function classic(difficulty: AIDifficulty): AIProfile {
  return {
    id: `classic-${difficulty}`,
    name: `Classic ${DIFFICULTY_NAME[difficulty]}`,
    desc: DIFFICULTY_DESC[difficulty],
    policy: 'classic', difficulty,
    ...DIFFICULTY_BASE[difficulty],
  };
}

/** Throwaway seam-proving policies (Phase 0) double as the ladder floor. */
const IDLE: AIProfile = {
  id: 'idle', name: 'Idle', desc: 'Does nothing — proves the seat plumbing.',
  policy: 'idle', difficulty: 'easy',
  macroPeriod: 3600, tacticsPeriod: 3600, reactionDelay: 3600, apm: 0, errorRate: 0,
  econScale: 0, expansion: 0, maxPendingSites: 0, workerReserveCoin: 0, towers: 0, walls: 0,
  armyCap: 0, unitMix: {},
  attackArmy: 1e9, minAttackInterval: 1e9, retreatRatio: 0, useBell: false,
  counter: 0, homeGuard: 0, raidSize: 0, raidInterval: 1e9,
};

const RANDOM: AIProfile = {
  id: 'random', name: 'Random', desc: 'Legal random commands on a slow cadence.',
  policy: 'random', difficulty: 'easy',
  macroPeriod: 5, tacticsPeriod: 5, reactionDelay: 5, apm: 12, errorRate: 0,
  econScale: 1, expansion: 0, maxPendingSites: 3, workerReserveCoin: 0, towers: 0, walls: 0,
  armyCap: 12, unitMix: { soldier: 1, archer: 1 },
  attackArmy: 1e9, minAttackInterval: 1e9, retreatRatio: 0, useBell: false,
  counter: 0, homeGuard: 0, raidSize: 0, raidInterval: 1e9,
};

/**
 * The experimental tensor-network seat (Phase 3 research spike). Its MACRO comes
 * from a sampled MPS plan (src/ai/tensor/), so the econ/expansion knobs here only
 * feed the shared serf-scaling and tactics; cadence, APM, reactions and counter
 * match Godlike so the ONLY variable under test is the generated strategy.
 * See docs/tensor-strategy-poc.md.
 */
const TENSOR: AIProfile = {
  id: 'tensor', name: 'Tensor (MPS)', desc: 'Strategy sampled from a matrix-product-state generator — research spike.',
  policy: 'tensor', difficulty: 'godlike',
  macroPeriod: 1.2, tacticsPeriod: 0.5, reactionDelay: 0.6, apm: 60, errorRate: 0,
  econScale: 1, expansion: 2, maxPendingSites: 5, workerReserveCoin: 3, towers: 1, walls: 0,
  armyCap: 55, unitMix: {}, // the mix comes from the sampled plan, not this table
  attackArmy: 16, minAttackInterval: 80, retreatRatio: 0.55, useBell: true,
  counter: 1, homeGuard: 0.2, raidSize: 5, raidInterval: 150,
};

export const AI_PROFILES: Record<string, AIProfile> = Object.fromEntries([
  IDLE, RANDOM, TENSOR,
  ...(['easy', 'hard', 'godlike'] as const).map(classic),
].map(profile => [profile.id, profile]));

export function aiProfile(id: string): AIProfile {
  const profile = AI_PROFILES[id];
  if (!profile) throw new Error(`Unknown AI profile '${id}' — known: ${Object.keys(AI_PROFILES).join(', ')}`);
  return profile;
}
