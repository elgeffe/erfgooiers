import { Rng } from '../engine/rng';
import { findPath } from '../engine/pathfinding';
import { doorTile } from '../game/util';
import { applyGameCommand, type CommandResult } from '../game/commands';
import type { Game } from '../game/Game';
import type { World } from '../world/World';
import type { GameCommand } from '../net/protocol';
import type { Coord, PlayerId } from '../types';
import type { AIProfile } from '../data/aiProfiles';
import { perceive, type AIView } from './perception';
import { Tactics } from './tactics';
import { ClassicMacro } from './strategy/classic';
import { IdleMacro } from './strategy/idle';
import { RandomMacro } from './strategy/random';
import type { MacroPolicy, PolicyContext } from './strategy/types';

/**
 * One CPU seat: owns decision cadence, the action budget, and the seeded rng.
 * The controller is a headless *player* — it reads the sim through perception,
 * decides through the profile's policy + tactics, and writes only GameCommands
 * through the same validated seam as a human. Identical in the browser, in
 * Node self-play, and (later) behind the host sequencer.
 *
 * Determinism: every decision is a pure function of (sim state, this seat's
 * seeded rng), so `seed + command log` replays bit-identically. Wall-clock
 * time is measured for the CPU-budget stats but never influences a decision.
 */

export interface AIEvent {
  elapsed: number;
  owner: PlayerId;
  type: 'command' | 'fumble' | 'pass';
  command?: GameCommand['type'];
  ok?: boolean;
  reason?: string;
}

export interface AIStats {
  commands: number;
  rejected: number;
  /** Commands dropped by the APM budget (re-planned on a later pass). */
  throttled: number;
  macroPasses: number;
  tacticsPasses: number;
  fumbles: number;
  cpuMsTotal: number;
  cpuMsMax: number;
  firstAttackAt: number | null;
}

export interface AIControllerOptions {
  game: Game;
  world: World;
  playerId: PlayerId;
  profile: AIProfile;
  /** Seat seed — derive from the match seed so replays re-derive decisions. */
  seed: number;
  /** Command sink; defaults to applying directly (local play & self-play). */
  submit?: (command: GameCommand) => CommandResult;
  onEvent?: (event: AIEvent) => void;
}

export class AIController {
  readonly playerId: PlayerId;
  readonly profile: AIProfile;
  readonly stats: AIStats = {
    commands: 0, rejected: 0, throttled: 0,
    macroPasses: 0, tacticsPasses: 0, fumbles: 0,
    cpuMsTotal: 0, cpuMsMax: 0, firstAttackAt: null,
  };

  private readonly game: Game;
  private readonly world: World;
  private readonly rng: Rng;
  private readonly submit: (command: GameCommand) => CommandResult;
  private readonly onEvent?: (event: AIEvent) => void;
  private readonly macro: MacroPolicy | null;
  private readonly tactics: Tactics | null;
  private macroT: number;
  private tacticsT: number;
  private tokens: number;
  private view: AIView | null = null;
  private done = false;

  constructor(options: AIControllerOptions) {
    this.game = options.game;
    this.world = options.world;
    this.playerId = options.playerId;
    this.profile = options.profile;
    this.rng = new Rng(options.seed);
    this.submit = options.submit ?? (command => applyGameCommand(this.game, this.playerId, command));
    this.onEvent = options.onEvent;
    const policy = this.profile.policy;
    this.macro = policy === 'classic' ? new ClassicMacro() : policy === 'random' ? new RandomMacro() : policy === 'idle' ? new IdleMacro() : null;
    this.tactics = policy === 'classic' ? new Tactics() : null;
    // start out of phase so two seats never think on the same tick, and the
    // opening varies between seeds — deterministically per seed
    this.macroT = -this.rng.range(0, this.profile.macroPeriod);
    this.tacticsT = -this.rng.range(0, this.profile.tacticsPeriod);
    this.tokens = Math.max(1, this.profile.apm / 6);
  }

  /** Advance the seat by one sim step. Call once per tick, before game.update. */
  tick(dt: number): void {
    if (this.done) return;
    this.tokens = Math.min(Math.max(1, this.profile.apm / 4), this.tokens + dt * this.profile.apm / 60);
    this.macroT += dt;
    this.tacticsT += dt;
    const runMacro = this.macro && this.macroT >= this.profile.macroPeriod;
    const runTactics = this.tactics && this.tacticsT >= this.profile.tacticsPeriod;
    if (!runMacro && !runTactics) return;

    const t0 = performance.now();
    this.view = perceive(this.game, this.world, this.playerId);
    if (this.view.eliminated || (!this.view.store && this.view.elapsed > 1)) { this.done = true; return; }
    const ctx: PolicyContext = {
      game: this.game, world: this.world, view: this.view,
      profile: this.profile, rng: this.rng, approach: this.approach(this.view),
    };
    if (runTactics) {
      this.tacticsT = 0;
      this.stats.tacticsPasses++;
      this.dispatch(this.tactics!.step(ctx));
      this.stats.firstAttackAt = this.tactics!.firstAttackAt;
    }
    if (runMacro) {
      this.macroT = 0;
      this.stats.macroPasses++;
      if (this.profile.errorRate > 0 && this.rng.next() < this.profile.errorRate) {
        this.stats.fumbles++;
        this.onEvent?.({ elapsed: this.view.elapsed, owner: this.playerId, type: 'fumble' });
      } else {
        this.dispatch(this.macro!.plan(ctx));
      }
    }
    const cost = performance.now() - t0;
    this.stats.cpuMsTotal += cost;
    if (cost > this.stats.cpuMsMax) this.stats.cpuMsMax = cost;
  }

  private dispatch(commands: GameCommand[]): void {
    for (const command of commands) {
      if (this.tokens < 1) {
        this.stats.throttled += commands.length - commands.indexOf(command);
        return;
      }
      this.tokens -= 1;
      const result = this.submit(command);
      this.stats.commands++;
      if (!result.ok) this.stats.rejected++;
      this.onEvent?.({
        elapsed: this.view?.elapsed ?? 0, owner: this.playerId, type: 'command',
        command: command.type, ok: result.ok, reason: result.reason,
      });
    }
  }

  private approachCache: { at: number; point: Coord } | null = null;

  /** The muster ground: a walkable, path-REACHABLE tile pushed from home
   *  toward the rival. An unreachable muster (a lake between the castles)
   *  strands the whole army in failing path searches, so each candidate is
   *  verified with a real path from the castle door. Cached on a slow clock —
   *  terrain doesn't move. */
  private approach(view: AIView): Coord {
    const store = view.store;
    if (!store) return { x: Math.floor(this.world.W / 2), y: Math.floor(this.world.H / 2) };
    if (this.approachCache && view.elapsed - this.approachCache.at < 20) return this.approachCache.point;
    const target = view.enemyStore ?? { x: Math.floor(this.world.W / 2), y: Math.floor(this.world.H / 2) };
    const from = doorTile(store);
    const dx = target.x - store.x, dy = target.y - store.y;
    const length = Math.hypot(dx, dy) || 1;
    let point: Coord = from;
    for (const distance of [7, 5, 3, 2]) {
      const base: Coord = {
        x: Math.round(store.x + (dx / length) * distance),
        y: Math.round(store.y + 1 + (dy / length) * distance),
      };
      const candidate = this.walkableNear(base);
      if (candidate && findPath(this.world, from.x, from.y, candidate.x, candidate.y, this.playerId)) {
        point = candidate;
        break;
      }
    }
    this.approachCache = { at: view.elapsed, point };
    return point;
  }

  private walkableNear(base: Coord): Coord | null {
    for (let radius = 0; radius <= 3; radius++) {
      for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
        const x = base.x + ox, y = base.y + oy;
        if (x > 0 && y > 0 && x < this.world.W - 1 && y < this.world.H - 1 && this.world.passable(x, y, this.playerId)) {
          return { x, y };
        }
      }
    }
    return null;
  }
}
