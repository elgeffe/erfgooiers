import { aiProfile } from '../data/aiProfiles';
import { UNITS, type UnitKind } from '../data/units';
import { applyGameCommand } from '../game/commands';
import { gameplayFingerprintHash, makeSkirmishGame } from '../game/testHarness';
import { ReplayRecorder, TICK_SECONDS, skirmishWinner, type Replay, type SkirmishOutcome } from '../game/replay';
import { PLAYER_IDS, type BuildingKey, type PlayerId } from '../types';
import { AIController, type AIEvent, type AIStats } from './AIController';

/**
 * The headless AI-vs-AI match: two controllers on the real skirmish sim at
 * maximum speed. Pure of Node/DOM concerns so the vitest suite runs it
 * directly; tools/selfplay wraps it with a CLI, files and tournament reports.
 */

export interface MatchSeatSample {
  army: number;
  workers: number;
  buildings: number;
  sites: number;
  /** Standing structures and unfinished sites, split by kind for build-order diagnosis. */
  buildingsByKey: Partial<Record<BuildingKey, number>>;
  sitesByKey: Partial<Record<BuildingKey, number>>;
  /** The fighting roster and civilian workforce at this instant. */
  armyByKind: Partial<Record<UnitKind, number>>;
  workersByRole: Record<string, number>;
  coin: number;
  timber: number;
  stone: number;
  trunk: number;
  goldore: number;
  coal: number;
  iron: number;
  weapon: number;
  armor: number;
  bread: number;
  castleHp: number;
  castleMaxHp: number;
  /** Mean empty-tile gap to each non-wall placement's nearest neighbour. */
  meanNearestBuildingGap: number;
}

export interface MatchSample {
  t: number;
  seats: Record<PlayerId, MatchSeatSample>;
}

export interface SelfPlayOptions {
  seed: number;
  /** AIProfile ids for each seat. */
  p1: string;
  p2: string;
  /** Sim-seconds before the match is called a draw (default: level hard timer). */
  maxSeconds?: number;
  /** Metric sampling cadence in sim-seconds (default 15). */
  sampleEvery?: number;
  onEvent?: (event: AIEvent) => void;
}

export interface SelfPlayResult {
  seed: number;
  p1: string;
  p2: string;
  outcome: SkirmishOutcome;
  /** End-state hash — replay re-simulation must land on the same value. */
  fingerprint: string;
  wallMs: number;
  stats: Record<PlayerId, AIStats>;
  samples: MatchSample[];
  /** Exact end state; unlike periodic samples this is always taken on the final tick. */
  final: MatchSample;
  replay: Replay;
}

export function runSelfPlayMatch(options: SelfPlayOptions): SelfPlayResult {
  const { seed } = options;
  const profiles: Record<PlayerId, string> = { p1: options.p1, p2: options.p2 };
  const { game, world, level } = makeSkirmishGame(seed);
  const recorder = new ReplayRecorder(seed, level.name, PLAYER_IDS.map(id => ({ id, kind: 'ai', profile: profiles[id] })));

  let tick = 0;
  const controllers = PLAYER_IDS.map((playerId, seat) => new AIController({
    game, world, playerId,
    profile: aiProfile(profiles[playerId]),
    // distinct per-seat streams derived from the match seed — replayable, and
    // adding a seat can never reshape another seat's decisions
    seed: (seed ^ (seat + 1) * 0x9e3779b9) >>> 0,
    submit: command => {
      recorder.record(tick, playerId, command);
      return applyGameCommand(game, playerId, command);
    },
    onEvent: options.onEvent,
  }));

  const maxTicks = Math.round((options.maxSeconds ?? level.hardTimer) / TICK_SECONDS);
  const sampleEvery = options.sampleEvery ?? 15;
  const samples: MatchSample[] = [];
  let nextSampleAt = 0;
  let reason: SkirmishOutcome['reason'] = 'timeout';
  const t0 = performance.now();
  let ticksRun = 0;
  for (tick = 0; tick < maxTicks; tick++) {
    for (const controller of controllers) controller.tick(TICK_SECONDS);
    game.update(TICK_SECONDS);
    ticksRun++;
    if (game.elapsed >= nextSampleAt) {
      nextSampleAt += sampleEvery;
      samples.push(sample(game));
    }
    if (game.eliminated.size) { reason = 'storehouse'; break; }
  }
  const wallMs = performance.now() - t0;

  const outcome: SkirmishOutcome = { winner: skirmishWinner(game), ticks: ticksRun, reason };
  return {
    seed, p1: options.p1, p2: options.p2,
    outcome,
    fingerprint: gameplayFingerprintHash(game),
    wallMs,
    stats: { p1: controllers[0].stats, p2: controllers[1].stats },
    samples,
    final: sample(game),
    replay: recorder.finish(outcome),
  };
}

function sample(game: Parameters<typeof gameplayFingerprintHash>[0]): MatchSample {
  const seats = {} as Record<PlayerId, MatchSeatSample>;
  for (const playerId of PLAYER_IDS) {
    let army = 0, workers = 0, buildings = 0, sites = 0;
    const armyByKind: Partial<Record<UnitKind, number>> = {};
    const workersByRole: Record<string, number> = {};
    for (const unit of game.units) {
      if (unit.dead || unit.owner !== playerId) continue;
      if (unit.role in UNITS) {
        army++;
        const kind = unit.role as UnitKind;
        armyByKind[kind] = (armyByKind[kind] ?? 0) + 1;
      } else {
        workers++;
        workersByRole[unit.role] = (workersByRole[unit.role] ?? 0) + 1;
      }
    }
    const buildingsByKey: Partial<Record<BuildingKey, number>> = {};
    const sitesByKey: Partial<Record<BuildingKey, number>> = {};
    const placements: { x: number; y: number }[] = [];
    for (const building of game.buildings) {
      if (building.removed || building.owner !== playerId) continue;
      buildings++;
      buildingsByKey[building.key] = (buildingsByKey[building.key] ?? 0) + 1;
      if (!building.def.bulwark) placements.push(building);
    }
    for (const site of game.sites) {
      if (site.removed || site.owner !== playerId) continue;
      sites++;
      sitesByKey[site.key] = (sitesByKey[site.key] ?? 0) + 1;
      if (!site.def.bulwark) placements.push(site);
    }
    const castle = game.playerStores.get(playerId);
    const stock = castle?.stock ?? {};
    seats[playerId] = {
      army, workers, buildings, sites,
      buildingsByKey, sitesByKey, armyByKind, workersByRole,
      coin: stock.coin ?? 0, timber: stock.timber ?? 0, stone: stock.stone ?? 0,
      trunk: stock.trunk ?? 0, goldore: stock.goldore ?? 0, coal: stock.coal ?? 0, iron: stock.iron ?? 0,
      weapon: stock.weapon ?? 0, armor: stock.armor ?? 0, bread: stock.bread ?? 0,
      castleHp: castle?.hp ?? 0, castleMaxHp: castle?.maxHp ?? 0,
      meanNearestBuildingGap: meanNearestBuildingGap(placements),
    };
  }
  return { t: Math.round(game.elapsed), seats };
}

/** Placement density in open tiles between 2x2 footprints. Continuous wall and
 * gate runs are deliberately excluded by the caller: zero-gap masonry is good,
 * while zero-gap production buildings are the congestion this metric exposes. */
function meanNearestBuildingGap(placements: { x: number; y: number }[]): number {
  if (placements.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < placements.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < placements.length; j++) {
      if (i === j) continue;
      const distance = Math.max(
        Math.abs(placements[i].x - placements[j].x),
        Math.abs(placements[i].y - placements[j].y),
      );
      nearest = Math.min(nearest, Math.max(0, distance - 2));
    }
    total += nearest;
  }
  return Math.round(total / placements.length * 100) / 100;
}
