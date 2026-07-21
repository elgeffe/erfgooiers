import { applyGameCommand } from '../game/commands';
import { makeSkirmishGame } from '../game/testHarness';
import { TICK_SECONDS } from '../game/replay';
import type { Replay } from '../game/replay';
import type { Game } from '../game/Game';
import type { BuildingKey } from '../types';
import type { GameCommand } from '../net/protocol';
import type { PlayerId } from '../types';
import { economyStock, perceive, type AIView } from './perception';

/**
 * The Phase 3 dataset builder, exercised on bot-vs-bot replays here (the plan
 * in docs/skirmish-ai-design.md). Because the sim is deterministic, a replay
 * (seed + command log) re-simulates exactly, so features can be snapshotted at
 * ANY cadence after the fact without the recorder having stored them. Each row
 * is (features observed at tick T by a seat) → (that seat's NEXT macro action),
 * the supervised target an imitation/behaviour-cloning policy learns.
 *
 * Kept pure of Node/DOM (only the sim + perception) so the vitest suite builds
 * datasets directly and a future learned policy reuses the exact feature space.
 */

// The observation vector: interpretable, compact, and — crucially — the SAME
// features every policy (classic, learned, experimental) can read, so a model
// trained on these rows drops in behind the existing AIProfile interface.
export const FEATURE_NAMES = [
  't_min',                                   // sim minutes elapsed
  'own_buildings', 'own_sites', 'own_army', 'own_serfs', 'own_free_villagers', 'own_unstaffed',
  'worker_hunger',                           // mean, 0..1
  'enemy_army', 'enemy_bulwarks', 'threats',
  'coin', 'timber', 'stone', 'bread', 'weapon', 'goldore', 'coal', 'iron',
  'has_woodcutter', 'has_quarry', 'has_goldmine', 'has_mint', 'has_barracks', 'has_smithy', 'has_market',
] as const;

export type FeatureRow = Record<(typeof FEATURE_NAMES)[number], number>;

/** The observation a policy sees: a flat, numeric snapshot of one seat's view.
 *  Reads stocks through `economyStock`, so it stays inside perception's
 *  information boundary (fog-filtered when the match ran under fog). */
export function featureRow(game: Game, view: AIView): FeatureRow {
  const owner = view.owner;
  const stock = (item: string): number => economyStock(game, owner, item);
  const has = (key: BuildingKey): number => (view.built[key] ?? 0) > 0 ? 1 : 0;
  return {
    t_min: Math.round((view.elapsed / 60) * 100) / 100,
    own_buildings: view.buildings.length,
    own_sites: view.sites.length,
    own_army: view.armySize,
    own_serfs: view.workers.serfs,
    own_free_villagers: view.workers.freeVillagers,
    own_unstaffed: view.workers.unstaffed,
    worker_hunger: Math.round(view.averageWorkerHunger) / 100,
    enemy_army: view.enemyArmySize,
    enemy_bulwarks: view.enemyBulwarks.length,
    threats: view.threats.length,
    coin: stock('coin'), timber: stock('timber'), stone: stock('stone'), bread: stock('bread'),
    weapon: stock('weapon'), goldore: stock('goldore'), coal: stock('coal'), iron: stock('iron'),
    has_woodcutter: has('woodcutter'), has_quarry: has('quarry'), has_goldmine: has('goldmine'),
    has_mint: has('mint'), has_barracks: has('barracks'), has_smithy: has('smithy'), has_market: has('market'),
  };
}

/** The supervised target: the macro *intent* of a command, as a short label.
 *  Micro (unit orders, rally, bell, market config) is deliberately excluded —
 *  the macro policy is what a learned model replaces. `idle` means the seat
 *  issued no macro command before the horizon. */
export function macroLabel(command: GameCommand | null): string {
  if (!command) return 'idle';
  if (command.type === 'placeBuilding') return `build:${command.key}`;
  if (command.type === 'queueTraining') return `train:${command.unit}`;
  if (command.type === 'placePlots') return 'plots';
  return 'other';
}

const MACRO_TYPES = new Set<GameCommand['type']>(['placeBuilding', 'queueTraining', 'placePlots']);

export interface DatasetRow {
  seed: number;
  tick: number;
  seat: PlayerId;
  features: FeatureRow;
  label: string;
}

export interface ExtractOptions {
  /** Snapshot cadence in sim-seconds (default 20). */
  everySeconds?: number;
  /** How far ahead (sim-seconds) to look for the seat's next macro action (default 60). */
  horizonSeconds?: number;
}

/**
 * Re-simulate a replay and emit one labelled row per seat per snapshot. The
 * label is the seat's next macro command within the look-ahead horizon, so a
 * row captures "in this state, this player chose to build/train X next".
 */
export function extractDataset(replay: Replay, options: ExtractOptions = {}): DatasetRow[] {
  if (!replay.outcome) throw new Error('Replay has no outcome — cannot bound extraction');
  const everyTicks = Math.max(1, Math.round((options.everySeconds ?? 20) / TICK_SECONDS));
  const horizonTicks = Math.round((options.horizonSeconds ?? 60) / TICK_SECONDS);
  const seats = replay.players.map(p => p.id);

  // index each seat's macro commands by tick for O(1) look-ahead
  const macroByTick = new Map<PlayerId, { tick: number; command: GameCommand }[]>();
  for (const id of seats) macroByTick.set(id, []);
  for (const entry of replay.commands) {
    if (MACRO_TYPES.has(entry.command.type)) macroByTick.get(entry.playerId)?.push({ tick: entry.tick, command: entry.command });
  }
  const nextMacro = (seat: PlayerId, fromTick: number): GameCommand | null => {
    for (const m of macroByTick.get(seat) ?? []) {
      if (m.tick >= fromTick && m.tick < fromTick + horizonTicks) return m.command;
    }
    return null;
  };

  const { game, world } = makeSkirmishGame(replay.seed);
  const rows: DatasetRow[] = [];
  let next = 0;
  for (let tick = 0; tick < replay.outcome.ticks; tick++) {
    while (next < replay.commands.length && replay.commands[next].tick === tick) {
      const entry = replay.commands[next++];
      applyGameCommand(game, entry.playerId, entry.command);
    }
    if (tick % everyTicks === 0) {
      for (const seat of seats) {
        if (game.eliminated.has(seat)) continue;
        const view = perceive(game, world, seat);
        if (!view.store) continue;
        rows.push({ seed: replay.seed, tick, seat, features: featureRow(game, view), label: macroLabel(nextMacro(seat, tick)) });
      }
    }
    game.update(TICK_SECONDS);
  }
  return rows;
}

/** Serialize dataset rows as flat JSONL (features spread to top-level columns). */
export function datasetToJsonl(rows: DatasetRow[]): string {
  return rows.map(row => JSON.stringify({ seed: row.seed, tick: row.tick, seat: row.seat, ...row.features, label: row.label })).join('\n') + (rows.length ? '\n' : '');
}
