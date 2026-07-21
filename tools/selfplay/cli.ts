import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_PROFILES } from '../../src/data/aiProfiles';
import { runSelfPlayMatch, type SelfPlayResult } from '../../src/ai/selfplay';
import { resimulateReplay, serializeReplay } from '../../src/game/replay';
import { SKIRMISH_LEVEL } from '../../src/data/skirmishLevels';
import type { PlayerId } from '../../src/types';

/**
 * Phase 2 evaluation instrument: batch AI-vs-AI skirmishes across seeds, at
 * max speed, with structured logs — the thing that makes "Godlike beats Hard"
 * a measured claim instead of vibes.
 *
 *   npm run selfplay -- --pair classic-hard:idle --seeds 10
 *
 * Flags:
 *   --pair a:b         profile ids per seat (repeatable; seats alternate per seed)
 *   --seeds N          matches per pair (default 3)
 *   --base-seed N      first match seed (default 1000; seed increments per match)
 *   --max-minutes N    sim-minutes before a draw (default: level hard timer)
 *   --out DIR          output dir (default target/selfplay/run-<stamp>)
 *   --replays          write per-match replay JSON
 *   --events           write per-match AI decision NDJSON
 *   --check-replays    re-simulate every replay and verify the fingerprint
 *   --list             list profile ids and exit
 */

interface CliOptions {
  pairs: [string, string][];
  seeds: number;
  baseSeed: number;
  maxMinutes: number;
  out: string;
  replays: boolean;
  events: boolean;
  checkReplays: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    pairs: [], seeds: 3, baseSeed: 1000,
    maxMinutes: SKIRMISH_LEVEL.hardTimer / 60,
    out: join('target', 'selfplay', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`),
    replays: false, events: false, checkReplays: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--pair') {
      const [a, b] = next().split(':');
      if (!a || !b) throw new Error('--pair expects profileA:profileB');
      options.pairs.push([a, b]);
    } else if (arg === '--seeds') options.seeds = Number(next());
    else if (arg === '--base-seed') options.baseSeed = Number(next());
    else if (arg === '--max-minutes') options.maxMinutes = Number(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--replays') options.replays = true;
    else if (arg === '--events') options.events = true;
    else if (arg === '--check-replays') options.checkReplays = true;
    else if (arg === '--list') {
      for (const profile of Object.values(AI_PROFILES)) console.log(`  ${profile.id.padEnd(28)} ${profile.desc}`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.pairs.length) options.pairs.push(['classic-hard', 'idle']);
  for (const pair of options.pairs) for (const id of pair) {
    if (!AI_PROFILES[id]) throw new Error(`Unknown profile '${id}' — try --list`);
  }
  return options;
}

interface PairTally {
  a: string; b: string;
  matches: number; winsA: number; winsB: number; draws: number;
  simSeconds: number; wallMs: number;
  commands: number; rejected: number; throttled: number;
  cpuMsMax: number; cpuMsTotal: number; passes: number;
  firstAttackA: number[]; firstAttackB: number[];
}

function tallyFor(a: string, b: string): PairTally {
  return {
    a, b, matches: 0, winsA: 0, winsB: 0, draws: 0, simSeconds: 0, wallMs: 0,
    commands: 0, rejected: 0, throttled: 0, cpuMsMax: 0, cpuMsTotal: 0, passes: 0,
    firstAttackA: [], firstAttackB: [],
  };
}

function accumulate(tally: PairTally, result: SelfPlayResult, aSeat: PlayerId): void {
  const bSeat: PlayerId = aSeat === 'p1' ? 'p2' : 'p1';
  tally.matches++;
  if (result.outcome.winner === aSeat) tally.winsA++;
  else if (result.outcome.winner === bSeat) tally.winsB++;
  else tally.draws++;
  tally.simSeconds += result.outcome.ticks / 20;
  tally.wallMs += result.wallMs;
  for (const seat of ['p1', 'p2'] as const) {
    const stats = result.stats[seat];
    tally.commands += stats.commands;
    tally.rejected += stats.rejected;
    tally.throttled += stats.throttled;
    tally.cpuMsTotal += stats.cpuMsTotal;
    tally.passes += stats.macroPasses + stats.tacticsPasses;
    tally.cpuMsMax = Math.max(tally.cpuMsMax, stats.cpuMsMax);
  }
  const first = (seat: PlayerId) => result.stats[seat].firstAttackAt;
  if (first(aSeat) !== null) tally.firstAttackA.push(first(aSeat)!);
  if (first(bSeat) !== null) tally.firstAttackB.push(first(bSeat)!);
}

const mean = (values: number[]): number => values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
const pct = (n: number, of: number): string => of ? `${Math.round(100 * n / of)}%` : '—';
const minutes = (seconds: number): string => `${(seconds / 60).toFixed(1)}m`;

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  console.log(`Self-play tournament → ${options.out}`);
  console.log(`  level "${SKIRMISH_LEVEL.name}" · draw after ${options.maxMinutes} sim-minutes · ${options.seeds} seed(s)/pair\n`);

  const tallies: PairTally[] = [];
  const reportMatches: object[] = [];
  for (const [a, b] of options.pairs) {
    const tally = tallyFor(a, b);
    tallies.push(tally);
    for (let i = 0; i < options.seeds; i++) {
      const seed = options.baseSeed + i;
      // alternate seats per seed so an east/west map bias can't skew the pair
      const aSeat: PlayerId = i % 2 === 0 ? 'p1' : 'p2';
      const p1 = aSeat === 'p1' ? a : b;
      const p2 = aSeat === 'p1' ? b : a;
      const matchId = `${a}-vs-${b}-seed${seed}`;
      const eventsPath = options.events ? join(options.out, `${matchId}.events.ndjson`) : null;
      if (eventsPath) writeFileSync(eventsPath, '');
      const result = runSelfPlayMatch({
        seed, p1, p2,
        maxSeconds: options.maxMinutes * 60,
        onEvent: eventsPath ? event => appendFileSync(eventsPath, JSON.stringify(event) + '\n') : undefined,
      });
      accumulate(tally, result, aSeat);
      const winnerName = result.outcome.winner === null ? 'draw' : result.outcome.winner === aSeat ? a : b;
      const speed = result.outcome.ticks / 20 / (result.wallMs / 1000);
      console.log(
        `  ${matchId}  →  ${winnerName.padEnd(24)} (${result.outcome.reason}, ${minutes(result.outcome.ticks / 20)} sim, `
        + `${(result.wallMs / 1000).toFixed(1)}s wall, ${speed.toFixed(0)}× realtime, `
        + `cmd ${result.stats.p1.commands}/${result.stats.p2.commands}, rej ${result.stats.p1.rejected + result.stats.p2.rejected})`);
      if (options.replays) writeFileSync(join(options.out, `${matchId}.replay.json`), serializeReplay(result.replay));
      if (options.checkReplays) {
        const check = resimulateReplay(result.replay);
        const ok = check.fingerprint === result.fingerprint && check.outcome.winner === result.outcome.winner;
        if (!ok) console.error(`  !! replay divergence on ${matchId}: ${check.fingerprint} != ${result.fingerprint}`);
        else console.log('     replay re-simulation verified ✓');
      }
      reportMatches.push({
        matchId, seed, p1, p2, outcome: result.outcome,
        fingerprint: result.fingerprint, wallMs: Math.round(result.wallMs),
        stats: result.stats, samples: result.samples,
      });
    }
  }

  console.log('\n=== Tournament report ===');
  for (const tally of tallies) {
    console.log(`\n${tally.a}  vs  ${tally.b}   (${tally.matches} matches)`);
    console.log(`  wins: ${tally.winsA} (${pct(tally.winsA, tally.matches)}) / ${tally.winsB} (${pct(tally.winsB, tally.matches)}) · draws ${tally.draws}`);
    console.log(`  avg length ${minutes(tally.simSeconds / Math.max(1, tally.matches))} · avg wall ${(tally.wallMs / Math.max(1, tally.matches) / 1000).toFixed(1)}s`);
    console.log(`  commands ${tally.commands} (rejected ${tally.rejected}, throttled ${tally.throttled})`);
    console.log(`  AI cpu: avg ${(tally.cpuMsTotal / Math.max(1, tally.passes)).toFixed(2)}ms/pass · worst pass ${tally.cpuMsMax.toFixed(1)}ms`);
    if (tally.firstAttackA.length || tally.firstAttackB.length) {
      console.log(`  first attack: ${tally.a} ${minutes(mean(tally.firstAttackA))} · ${tally.b} ${tally.firstAttackB.length ? minutes(mean(tally.firstAttackB)) : '—'}`);
    }
  }
  writeFileSync(join(options.out, 'report.json'), JSON.stringify({
    level: SKIRMISH_LEVEL.name,
    options: { ...options },
    pairs: tallies,
    matches: reportMatches,
  }, null, 2));
  console.log(`\nreport.json written to ${options.out}`);
}

main();
