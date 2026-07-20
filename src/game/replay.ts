import { PLAYER_IDS, type PlayerId } from '../types';
import type { GameCommand } from '../net/protocol';
import { applyGameCommand } from './commands';
import { gameplayFingerprintHash, makeSkirmishGame } from './testHarness';
import type { Game } from './Game';

/**
 * Replays: seed + ordered command log = the complete record of a skirmish.
 * Because the sim is deterministic (seeded rng streams, fixed 20 Hz ticks,
 * stable iteration), re-simulating a replay reproduces the match exactly —
 * which makes replays the training-data format, the desync regression
 * fixture, and the local save format all at once (docs/skirmish-ai-design.md).
 */

export const REPLAY_VERSION = 1;
export const TICK_SECONDS = 1 / 20;

export interface ReplayPlayerMeta {
  id: PlayerId;
  kind: 'human' | 'ai';
  /** AI seats: the AIProfile id that drove the seat. */
  profile?: string;
}

export interface ReplayCommand {
  tick: number;
  playerId: PlayerId;
  command: GameCommand;
}

export interface SkirmishOutcome {
  winner: PlayerId | null;
  ticks: number;
  reason: 'storehouse' | 'timeout';
}

export interface Replay {
  version: typeof REPLAY_VERSION;
  seed: number;
  level: string;
  players: ReplayPlayerMeta[];
  commands: ReplayCommand[];
  outcome: SkirmishOutcome | null;
}

/** Winner resolution off Game.eliminated — null is a draw (timeout or mutual). */
export function skirmishWinner(game: Game): PlayerId | null {
  if (!game.eliminated.size) return null;
  const standing = PLAYER_IDS.filter(id => !game.eliminated.has(id));
  return standing.length === 1 ? standing[0] : null;
}

/** Collects the ordered command stream of a live match. */
export class ReplayRecorder {
  readonly commands: ReplayCommand[] = [];
  private outcome: SkirmishOutcome | null = null;

  constructor(
    private readonly seed: number,
    private readonly level: string,
    private readonly players: ReplayPlayerMeta[],
  ) {}

  record(tick: number, playerId: PlayerId, command: GameCommand): void {
    this.commands.push({ tick, playerId, command });
  }

  finish(outcome: SkirmishOutcome): Replay {
    this.outcome = outcome;
    return this.replay();
  }

  replay(): Replay {
    return {
      version: REPLAY_VERSION,
      seed: this.seed,
      level: this.level,
      players: this.players,
      commands: this.commands,
      outcome: this.outcome,
    };
  }
}

export function serializeReplay(replay: Replay): string {
  return JSON.stringify(replay);
}

export function parseReplay(json: string): Replay {
  const replay = JSON.parse(json) as Replay;
  if (replay.version !== REPLAY_VERSION) throw new Error(`Unsupported replay version ${replay.version}`);
  return replay;
}

/**
 * Re-simulate a recorded skirmish headlessly: rebuild the identical world,
 * apply each command right before its recorded tick, run the same number of
 * ticks. Returns the re-derived outcome plus the end-state fingerprint hash —
 * both must match the original run, or determinism has broken.
 */
export function resimulateReplay(replay: Replay): { outcome: SkirmishOutcome; fingerprint: string } {
  if (!replay.outcome) throw new Error('Replay has no outcome — cannot bound the re-simulation');
  const { game } = makeSkirmishGame(replay.seed);
  let next = 0;
  for (let tick = 0; tick < replay.outcome.ticks; tick++) {
    while (next < replay.commands.length && replay.commands[next].tick === tick) {
      const entry = replay.commands[next++];
      applyGameCommand(game, entry.playerId, entry.command);
    }
    game.update(TICK_SECONDS);
  }
  const winner = skirmishWinner(game);
  return {
    outcome: {
      winner,
      ticks: replay.outcome.ticks,
      reason: game.eliminated.size ? 'storehouse' : 'timeout',
    },
    fingerprint: gameplayFingerprintHash(game),
  };
}
