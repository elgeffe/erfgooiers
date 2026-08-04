import type { AIProfile } from '../../data/aiProfiles';
import type { BuildingKey } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { sampleConditional } from '../tensor/mps';
import {
  BUNDLE_LENGTH, CONTEXT_LENGTH, IDENTITIES, PHASE_INTENTS,
  decodeBundle, encodeEvidence,
  type IntentId, type KnownCategory, type StrategicObservation, type StrategyIdentity,
} from '../tensor/plan';
import { advancePhase, initialPhase, openingComplete, type Phase, type PhaseState } from '../tensor/phase';
import { loadV2Model, priorV2Model, type LoadedV2Model, type TensorV2Model } from '../tensor/modelV2';
import {
  SiteWatch, affordable, dominantEnemyCategory, fieldPlots, placeBuilding, staffEconomy, trainFighter,
} from './execution';
import {
  nextArmsLineBuild, nextCoinLineBuild, nextFoodLineBuild, nextStoneLineBuild,
  nextTimberLineBuild, plannedBuildingCounts,
} from './classicPlan';
import type { MacroPolicy, PolicyContext } from './types';
import type { AIView } from '../perception';

/**
 * Tensor v2: the phase-aware, probabilistic, ADAPTIVE macro policy from
 * docs/tensor-retrain-plan.md.
 *
 * Where v1 (`tensor.ts`, still committed and unchanged) sampled one fixed
 * 22-token opening at match start and could never revise it, v2 works like a
 * player does:
 *
 *   1. It draws a latent strategy identity `z` once — a coherent bias (boom,
 *      tech, contest the map, apply pressure), not a script.
 *   2. It detects the strategy PHASE from observable milestones (`phase.ts`).
 *   3. For the active phase it clamps an MPS's context slots to a discretized,
 *      fair observation — including what it REMEMBERS having scouted and how
 *      stale that memory is — and samples a short bundle of strategic intents
 *      conditionally. Different match, different bundle: that is the adaptation
 *      v1 structurally could not do.
 *   4. It replans when the bundle finishes, when a bounded interval elapses, or
 *      when something meaningful happens (a new sighting, a threat, a phase
 *      change) — but never before a minimum commitment window, so the plan
 *      cannot flap.
 *   5. A deterministic recovery overlay pre-empts all of it when the economy is
 *      actually broken. Starving workers are not a strategic choice to sample.
 *
 * Everything the bundle asks for is actuated through `execution.ts`, the same
 * mechanics the Classic benchmark uses, and every command goes through the same
 * validated seam. The model chooses WHAT to pursue and WHEN; it gets no extra
 * information, no cheaper buildings, and no larger action budget.
 */

/** Never revise a plan sooner than this — the anti-flap commitment window. */
const MIN_COMMITMENT = 25;
/** Revise at least this often even when nothing has visibly happened. */
const REPLAN_INTERVAL = 90;
/** Give up on a single intent that cannot make progress and move down the queue. */
const INTENT_PATIENCE = 40;

/** Per-phase ceilings on how deep each production line may grow. An `expand:X`
 *  intent asks for ONE more line, up to the ceiling for the current phase, so a
 *  bundle that repeats an intent compounds instead of no-opping. */
/** Per-phase ceilings on how deep each production line may grow. An `expand:X`
 *  intent asks for ONE more line, up to the ceiling for the current phase, so a
 *  bundle that repeats an intent compounds instead of no-opping. The ceilings
 *  allow real growth beyond the shared opening, which is where the model's
 *  economic choices actually bite. */
const CEILINGS: Record<Phase, Record<LineId, number>> = {
  opening: { timber: 1, stone: 1, coin: 1, food: 1, arms: 1 },
  midgame: { timber: 2, stone: 3, coin: 2, food: 2, arms: 1 },
  lategame: { timber: 2, stone: 4, coin: 3, food: 2, arms: 2 },
};


type LineId = 'timber' | 'stone' | 'coin' | 'food' | 'arms';

const LINE_OF: Partial<Record<IntentId, LineId>> = {
  'expand:timber': 'timber', 'expand:stone': 'stone', 'expand:coin': 'coin',
  'expand:food': 'food', 'expand:arms': 'arms',
};

/** Army composition asked for by each `army:*` intent. Several may be active at
 *  once, in which case their weights add — a bundle that votes twice for the
 *  same arm really does want twice as much of it. */
const COMPOSITIONS: Record<string, Record<string, number>> = {
  'army:ranged': { archer: 4, soldier: 3, knight: 1 },
  'army:anti-mounted': { pikeman: 5, soldier: 2, archer: 1 },
  'army:mounted': { lancer: 3, horsearcher: 2, horseknight: 2, soldier: 1 },
  'army:siege-support': { trebuchet: 2, onager: 2, priest: 2, soldier: 2, archer: 1 },
};

/** With no composition vote at all, field the balanced army a sane player would. */
const DEFAULT_COMPOSITION: Record<string, number> = { soldier: 3, archer: 3, pikeman: 1, knight: 1 };

/** The trainer each composition needs before it can produce anything. */
const TRAINER_FOR: Record<string, BuildingKey> = {
  'army:ranged': 'barracks', 'army:anti-mounted': 'barracks',
  'army:mounted': 'stable', 'army:siege-support': 'engineer',
};

/**
 * The next step of the supplier-first core economy: paired timber, stone, the
 * coin engine, a staple food chain with a tavern to serve it, and military
 * production. These are exactly the milestones `phase.ts` uses to decide the
 * opening is over, raised through the same shared line planners Classic uses.
 */
function foundationKey(planned: ReturnType<typeof plannedBuildingCounts>): BuildingKey | null {
  return nextTimberLineBuild(planned, 1)
    ?? nextStoneLineBuild(planned, 1)
    ?? nextCoinLineBuild(planned, 1)
    ?? nextFoodLineBuild(planned, 1)
    // the tavern is where bread becomes a fed worker — not an optional extra
    ?? ((planned.tavern ?? 0) < 1 ? 'tavern' : null)
    ?? ((planned.barracks ?? 0) < 1 ? 'barracks' : null);
}

const isComposition = (intent: IntentId): boolean => intent.startsWith('army:');
const isTempo = (intent: IntentId): boolean =>
  intent === 'boom' || intent === 'scout' || intent === 'raid' || intent === 'commit' || intent === 'regroup';

/** What this seat has seen of the rival, and when. Updated ONLY from `AIView`,
 *  so under fog it holds a genuine last-known picture rather than the truth. */
interface EnemyMemory {
  army: number;
  category: KnownCategory;
  fortified: number;
  seenAt: number;
}

export class TensorMacroV2 implements MacroPolicy {
  private readonly model: LoadedV2Model;
  private readonly blockedUntil = new Map<BuildingKey, number>();
  private readonly sites = new SiteWatch();

  private identity: StrategyIdentity | null = null;
  private phase: PhaseState = initialPhase();
  private memory: EnemyMemory = { army: 0, category: 'unknown', fortified: 0, seenAt: -Infinity };

  /** The strategic intents drawn for the current window. */
  private bundle: IntentId[] = [];
  /** The build asks of the bundle, in the order the model named them. */
  private queue: { intent: IntentId; target: number; since: number }[] = [];
  private cursor = 0;
  private plannedAt = -Infinity;
  private lastThreatAt = -Infinity;
  private lastArmy = 0;
  /** Set once the model asks to commit — the phase detector's "first attack". */
  private hasCommitted = false;

  /** Late-game posture the tactics layer should adopt, chosen by the POLICY
   *  rather than fixed profile defaults (the plan is explicit that Tensor must
   *  be able to make a like-for-like end-game choice). */
  directives: Partial<AIProfile> = {};

  /**
   * Every bundle drawn this match. `seq` is the RAW slot sequence — clamped
   * context followed by sampled intents — which is exactly the training row the
   * self-play trainer reinforces when this match is won, so the decision and the
   * thing that gets learned from it are literally the same object.
   */
  readonly drawn: {
    at: number; phase: Phase; identity: StrategyIdentity; intents: IntentId[]; seq: number[];
  }[] = [];

  constructor(model: TensorV2Model = priorV2Model()) {
    this.model = loadV2Model(model);
  }

  plan(ctx: PolicyContext): GameCommand[] {
    const { view, rng } = ctx;
    if (!view.store) return [];
    this.identity ??= IDENTITIES[rng.int(IDENTITIES.length)];
    if (view.threats.length) this.lastThreatAt = view.elapsed;

    const sighted = this.remember(view);
    const previous = this.phase;
    this.phase = advancePhase(this.phase, view, {
      committed: this.hasCommitted,
      stalledSites: this.sites.stalled,
    });

    if (this.shouldReplan(view, previous, sighted)) this.replan(ctx);
    this.directives = this.posture(ctx);

    const commands: GameCommand[] = [];
    const rescue = this.sites.step(view);
    if (rescue) commands.push(rescue);
    const plots = fieldPlots(ctx);
    if (plots) commands.push(plots);
    const civilian = staffEconomy(ctx);
    if (civilian) commands.push(civilian);
    const build = this.nextBuild(ctx);
    if (build) commands.push(build);
    const fighter = trainFighter(ctx, this.composition(), civilian ? 1 : 0);
    if (fighter) commands.push(fighter);

    this.lastArmy = view.armySize;
    return commands;
  }

  // ---- fair memory ----

  /** Fold what is visible NOW into the remembered picture. Nothing here reads
   *  hidden state: an unseen rival simply leaves the memory ageing. Returns
   *  whether this pass learned something that justifies rethinking. */
  private remember(view: AIView): boolean {
    const dominant = dominantEnemyCategory(view.enemyArmyByKind);
    const fortified = view.enemyTowers.length + view.enemyBulwarks.length;
    let news = false;
    if (view.enemyArmySize > 0 || fortified > 0) {
      const category: KnownCategory = dominant ? dominant.cat : this.memory.category;
      news = category !== this.memory.category
        || view.enemyArmySize >= this.memory.army * 1.5 + 3
        || fortified > this.memory.fortified;
      this.memory = {
        army: Math.max(view.enemyArmySize, news ? 0 : this.memory.army),
        category,
        fortified: Math.max(fortified, this.memory.fortified),
        seenAt: view.elapsed,
      };
    }
    return news;
  }

  private observe(view: AIView): StrategicObservation {
    let producers = 0, advanced = 0;
    for (const building of view.buildings) {
      if (!building.active) continue;
      if (building.def.gather || building.def.recipe) {
        if (!building.def.worker || building.worker) producers++;
      }
      if (building.key === 'stable' || building.key === 'engineer' || building.key === 'monastery') advanced++;
    }
    // Report the memory as it stands, ageing included. Deciding when a sighting
    // has gone cold belongs to the context slot, so the policy and the model
    // cannot disagree about what counts as "seen".
    return {
      identity: this.identity!,
      producers,
      army: view.armySize,
      advanced,
      enemyArmy: Math.max(view.enemyArmySize, this.memory.army),
      enemyCategory: this.memory.category,
      enemyFortified: this.memory.fortified,
      threats: view.threats.length,
      sightingAge: view.elapsed - this.memory.seenAt,
    };
  }

  // ---- bounded replanning ----

  private shouldReplan(view: AIView, previous: PhaseState, sighted: boolean): boolean {
    if (!this.bundle.length) return true;
    const held = view.elapsed - this.plannedAt;
    // The commitment window gates EVERY trigger, including a bundle that
    // finished early. Without that a short bundle — or one the executor
    // satisfies immediately — would redraw on the very next pass, which is
    // plan-flapping dressed up as adaptation.
    if (held < MIN_COMMITMENT) return false;
    if (held >= REPLAN_INTERVAL) return true;
    if (this.cursor >= this.queue.length) return true;       // the bundle is done
    if (previous.phase !== this.phase.phase) return true;
    if (previous.recovery !== this.phase.recovery) return true;
    if (sighted) return true;
    if (view.threats.length && view.elapsed - this.lastThreatAt <= 1) return true;
    return view.armySize < this.lastArmy * 0.6;              // the army was broken
  }

  /** Draw the next bundle for the active phase, conditioned on the observation. */
  private replan(ctx: PolicyContext): void {
    const { view, rng } = ctx;
    const phase = this.phase.phase;
    const observation = this.observe(view);
    const evidence = encodeEvidence(observation);
    const drawn = sampleConditional(this.model.phases[phase], evidence, rng);
    const intents = decodeBundle(phase, drawn);

    this.bundle = intents;
    this.queue = [];
    const planned = plannedBuildingCounts(view.built, view.pending);
    for (const intent of intents) {
      if (isComposition(intent) || isTempo(intent)) continue;
      this.queue.push({ intent, target: this.growthTarget(phase, intent, planned), since: view.elapsed });
    }
    // A bundle of nothing but tempo and composition still has to build the
    // trainer its army needs; the ensure-trainer step below covers that.
    this.cursor = 0;
    this.plannedAt = view.elapsed;
    if (intents.includes('commit')) this.hasCommitted = true;
    this.drawn.push({ at: view.elapsed, phase, identity: this.identity!, intents, seq: drawn });
  }

  /** How many lines of a kind this ask is for: one more than stands today,
   *  capped by the phase ceiling. */
  private growthTarget(phase: Phase, intent: IntentId, planned: ReturnType<typeof plannedBuildingCounts>): number {
    const line = LINE_OF[intent];
    if (!line) return 1;
    const p = (key: BuildingKey): number => planned[key] ?? 0;
    const standing = line === 'timber' ? Math.min(p('woodcutter'), p('sawmill'))
      : line === 'stone' ? p('quarry')
        : line === 'coin' ? p('mint')
          : line === 'food' ? Math.min(p('farm'), p('mill'), p('bakery'))
            : Math.max(p('smithy'), p('armory'));
    return Math.min(CEILINGS[phase][line], standing + 1);
  }

  // ---- execution ----

  /**
   * One construction decision per pass. The recovery overlay comes first, then
   * the trainer any active composition needs, then the bundle's build queue —
   * each ask handed to the SHARED supplier-first line planners so the tensor
   * seat raises its chains in the same proven order Classic does.
   */
  private nextBuild(ctx: PolicyContext): GameCommand | null {
    const { view, profile } = ctx;
    if (view.sites.length >= profile.maxPendingSites) return null;
    const planned = plannedBuildingCounts(view.built, view.pending);

    // Repairing a broken economy, and raising the economic base itself, are
    // preconditions rather than strategic choices.
    //
    // The base is the five milestones `phase.ts` reads, not Classic's full
    // COMMON_OPENING. Adopting the latter was tried and MEASURED WORSE — about
    // twenty points of match score on held-out seeds — because its twenty-five
    // stages put the tavern eleventh and the barracks twelfth, so the seat lost
    // the tempo to field an army even though its economy came out ahead. The
    // model needs a base it can afford, not the deepest one available.
    if (this.phase.recovery) {
      const repair = this.tryBuild(ctx, this.recoveryKey(view, planned));
      if (repair) return repair;
    }
    if (!openingComplete(view)) {
      const foundation = this.tryBuild(ctx, foundationKey(planned));
      if (foundation) return foundation;
    }
    const trainer = this.ensureTrainer(ctx);
    if (trainer) return trainer;

    while (this.cursor < this.queue.length) {
      const ask = this.queue[this.cursor];
      const key = this.nextKeyFor(ask.intent, ask.target, planned, ctx);
      if (!key) { this.cursor++; continue; }
      const command = placeBuilding(ctx, key, this.blockedUntil);
      if (command) return command;
      // Unaffordable or unplaceable: save for it, but not forever — a dead
      // income stream must not wedge the whole bundle behind one building.
      if (view.elapsed - ask.since > INTENT_PATIENCE) { this.cursor++; continue; }
      return null;
    }
    return null;
  }

  private tryBuild(ctx: PolicyContext, key: BuildingKey | null): GameCommand | null {
    return key ? placeBuilding(ctx, key, this.blockedUntil) : null;
  }

  /** The one building this intent wants next, or null when it is satisfied. */
  private nextKeyFor(
    intent: IntentId, target: number, planned: ReturnType<typeof plannedBuildingCounts>, ctx: PolicyContext,
  ): BuildingKey | null {
    const { view, profile } = ctx;
    switch (intent) {
      case 'expand:timber': {
        const line = nextTimberLineBuild(planned, target);
        // a forester keeps the woodcutters that already stand in business
        return line ?? ((planned.forester ?? 0) < (planned.woodcutter ?? 0) ? 'forester' : null);
      }
      case 'expand:stone': return nextStoneLineBuild(planned, target);
      case 'expand:coin': return nextCoinLineBuild(planned, target);
      case 'expand:food': {
        const line = nextFoodLineBuild(planned, target);
        return line ?? ((planned.tavern ?? 0) < 1 && (planned.bakery ?? 0) > 0 ? 'tavern' : null);
      }
      case 'expand:arms':
        if ((planned.barracks ?? 0) < 1) return 'barracks';
        return nextArmsLineBuild(planned, target);
      case 'defend:home': {
        const towers = (planned[profile.towerKey] ?? 0);
        return towers < Math.max(1, profile.towers) ? profile.towerKey : null;
      }
      case 'contest:resource':
        // Claim ground away from home: another extractor on the map's deposits,
        // guarded once the ring is up. Placement picks the anchor.
        if ((planned.quarry ?? 0) < CEILINGS[this.phase.phase].stone) return 'quarry';
        if ((planned.goldmine ?? 0) <= (planned.mint ?? 0)) return 'goldmine';
        return (planned.ironmine ?? 0) <= (planned.smithy ?? 0) ? 'ironmine' : null;
      case 'recover:economy':
        return this.recoveryKey(view, planned);
      default:
        return null;
    }
  }

  /** Repair before strategy: the food chain, then the coin engine that hires
   *  the workers, then the timber every other repair is paid for in. */
  private recoveryKey(view: AIView, planned: ReturnType<typeof plannedBuildingCounts>): BuildingKey | null {
    if (view.averageWorkerHunger < 60) {
      // Hungry workers with no tavern are not short of bread; they are short of
      // somewhere to eat it. Serve first, then grow another bread line.
      if ((planned.tavern ?? 0) < 1) return 'tavern';
      const bakeries = planned.bakery ?? 0;
      if ((planned.tavern ?? 0) * 3 < bakeries) return 'tavern';
      const food = nextFoodLineBuild(planned, Math.max(1, Math.min(planned.farm ?? 0, planned.bakery ?? 0) + 1));
      if (food) return food;
    }
    const coin = nextCoinLineBuild(planned, Math.max(1, planned.mint ?? 0));
    if (coin) return coin;
    return nextTimberLineBuild(planned, Math.max(1, planned.woodcutter ?? 0));
  }

  /** Build the trainer an active composition intent needs before its units can
   *  exist. `army:siege-support` wants a monastery too once the workshop stands. */
  private ensureTrainer(ctx: PolicyContext): GameCommand | null {
    const planned = plannedBuildingCounts(ctx.view.built, ctx.view.pending);
    for (const intent of this.bundle) {
      if (!isComposition(intent)) continue;
      const key = TRAINER_FOR[intent];
      if (!key) continue;
      if ((planned[key] ?? 0) < 1) {
        // A stable needs a smithy's weapons; a workshop only needs timber.
        if (key === 'stable' && (planned.smithy ?? 0) < 1) continue;
        if (!affordable(ctx, key)) continue;
        return placeBuilding(ctx, key, this.blockedUntil);
      }
      if (intent === 'army:siege-support' && (planned.monastery ?? 0) < 1 && affordable(ctx, 'monastery')) {
        return placeBuilding(ctx, 'monastery', this.blockedUntil);
      }
    }
    return null;
  }

  /** The army the bundle asked for, as training weights. */
  private composition(): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const intent of this.bundle) {
      const votes = COMPOSITIONS[intent];
      if (!votes) continue;
      for (const kind in votes) weights[kind] = (weights[kind] ?? 0) + votes[kind];
    }
    return Object.keys(weights).length ? weights : { ...DEFAULT_COMPOSITION };
  }

  /**
   * Translate the bundle's tempo and composition intents into the tactics
   * posture. This is the plan's requirement that late-game parameters be
   * SELECTED by the policy: whether to hold a big home guard or commit, how
   * many siege engines and healers a wave must include, whether to detach a
   * mounted flank, and how hard to scout or raid.
   */
  private posture(ctx: PolicyContext): Partial<AIProfile> {
    const { profile } = ctx;
    const has = (intent: IntentId): boolean => this.bundle.includes(intent);
    const directives: Partial<AIProfile> = {};

    // Only demand siege once a workshop actually STANDS. The tactics layer will
    // not launch a wave until `minSiege` engines exist, so asking for siege the
    // economy cannot build blocks every attack for the rest of the match — the
    // exact deadlock that made this policy sit at home and lose to Godlike
    // without ever attacking.
    if (has('army:siege-support')) {
      const engineer = ctx.view.buildings.some(b => b.key === 'engineer' && b.active);
      const monastery = ctx.view.buildings.some(b => b.key === 'monastery' && b.active);
      if (engineer) directives.minSiege = 2;
      if (monastery) directives.minPriests = 1;
    }
    if (has('army:mounted')) directives.flankSize = 6;
    if (has('scout')) { directives.raidSize = Math.max(2, profile.raidSize); directives.raidInterval = 70; }
    if (has('raid')) { directives.raidSize = Math.max(5, profile.raidSize); directives.raidInterval = 100; }
    if (has('defend:home')) directives.homeGuard = 0.35;

    if (has('commit')) {
      directives.attackEnabled = true;
      directives.attackArmy = Math.max(20, Math.round(profile.armyCap * 0.45));
      directives.homeGuard = has('defend:home') ? 0.25 : 0.15;
    } else if (has('regroup')) {
      // Hold: rebuild the wave rather than feed it in piecemeal.
      directives.attackArmy = Math.round(profile.armyCap * 0.8);
      directives.homeGuard = 0.4;
    }
    // A broken economy tempers offensive ambition — but must not forbid it.
    // Setting the threshold above the army cap made attacking arithmetically
    // impossible, so a seat that latched into recovery late in a match simply
    // stopped playing and waited to be killed. Raise the bar and hold more of
    // the army home instead.
    if (this.phase.recovery) {
      directives.attackArmy = Math.round(profile.armyCap * 0.85);
      directives.homeGuard = 0.5;
      directives.raidSize = 0;
      directives.minSiege = 0;
      directives.minPriests = 0;
    }
    return directives;
  }

  // ---- diagnostics (trainer / tests) ----

  /** The phase, overlay and plan this seat currently holds. */
  get state(): { phase: Phase; recovery: boolean; identity: StrategyIdentity | null; bundle: IntentId[] } {
    return {
      phase: this.phase.phase, recovery: this.phase.recovery,
      identity: this.identity, bundle: [...this.bundle],
    };
  }
}

/** Vocabulary sizes, re-exported so the trainer can size its reports without
 *  reaching into the plan module. */
export const V2_SHAPE = {
  contextSlots: CONTEXT_LENGTH,
  bundleLength: BUNDLE_LENGTH,
  intentsPerPhase: Object.fromEntries(
    (Object.keys(PHASE_INTENTS) as Phase[]).map(phase => [phase, PHASE_INTENTS[phase].length]),
  ) as Record<Phase, number>,
};
