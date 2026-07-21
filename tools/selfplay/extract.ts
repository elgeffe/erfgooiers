import { mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AI_PROFILES } from '../../src/data/aiProfiles';
import { runSelfPlayMatch } from '../../src/ai/selfplay';
import { parseReplay } from '../../src/game/replay';
import { extractDataset, datasetToJsonl, FEATURE_NAMES } from '../../src/ai/dataset';

/**
 * Phase 3 dataset builder, run on bot-vs-bot data. Either generates fresh
 * self-play matches or reads existing replay JSON, then re-simulates each and
 * writes one labelled JSONL row per seat per snapshot: the perception features
 * at tick T → that seat's next macro action. This is the exit-bar's "dataset
 * extraction works", and the training-set format a learned macro policy uses.
 *
 *   npm run extract -- --pairs classic-hard:classic-hard --seeds 20
 *   npm run extract -- --replays target/selfplay/run-.../  --out target/dataset.jsonl
 *
 * Flags:
 *   --pairs a:b,...   generate matches for these pairings (default hard vs hard)
 *   --seeds N         matches per pairing when generating (default 10)
 *   --base-seed N     first seed (default 8000)
 *   --replays PATH    instead of generating, read replay .json file or directory
 *   --every N         snapshot cadence in sim-seconds (default 20)
 *   --horizon N       look-ahead for the next macro action, sim-seconds (default 60)
 *   --out PATH        output JSONL (default target/selfplay/dataset.jsonl)
 *   --max-minutes N   draw cap when generating (default 30)
 */

interface Options {
  pairs: [string, string][]; seeds: number; baseSeed: number;
  replays: string | null; every: number; horizon: number; out: string; maxMinutes: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    pairs: [['classic-hard', 'classic-hard']], seeds: 10, baseSeed: 8000,
    replays: null, every: 20, horizon: 60, out: join('target', 'selfplay', 'dataset.jsonl'), maxMinutes: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--pairs') opts.pairs = next().split(',').map(p => { const [a, b] = p.split(':'); if (!a || !b) throw new Error('--pairs expects a:b'); return [a, b] as [string, string]; });
    else if (arg === '--seeds') opts.seeds = Number(next());
    else if (arg === '--base-seed') opts.baseSeed = Number(next());
    else if (arg === '--replays') opts.replays = next();
    else if (arg === '--every') opts.every = Number(next());
    else if (arg === '--horizon') opts.horizon = Number(next());
    else if (arg === '--out') opts.out = next();
    else if (arg === '--max-minutes') opts.maxMinutes = Number(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.replays) for (const [a, b] of opts.pairs) for (const id of [a, b]) {
    if (!AI_PROFILES[id]) throw new Error(`Unknown profile '${id}'`);
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, '');
  let rows = 0, matches = 0;
  const labelCounts = new Map<string, number>();
  const record = (jsonl: string, n: number): void => {
    if (n) appendFileSync(opts.out, jsonl);
    rows += n;
  };

  if (opts.replays) {
    const path = opts.replays;
    const files = readdirSync(path, { withFileTypes: true }).some(d => d.isFile())
      ? readdirSync(path).filter(f => f.endsWith('.replay.json') || f.endsWith('.json')).map(f => join(path, f))
      : [path];
    for (const file of files) {
      const replay = parseReplay(readFileSync(file, 'utf8'));
      const data = extractDataset(replay, { everySeconds: opts.every, horizonSeconds: opts.horizon });
      for (const r of data) labelCounts.set(r.label, (labelCounts.get(r.label) ?? 0) + 1);
      record(datasetToJsonl(data), data.length);
      matches++;
    }
  } else {
    for (const [a, b] of opts.pairs) {
      for (let i = 0; i < opts.seeds; i++) {
        const seed = opts.baseSeed + i;
        const aSeat = i % 2 === 0;
        const result = runSelfPlayMatch({ seed, p1: aSeat ? a : b, p2: aSeat ? b : a, maxSeconds: opts.maxMinutes * 60 });
        const data = extractDataset(result.replay, { everySeconds: opts.every, horizonSeconds: opts.horizon });
        for (const r of data) labelCounts.set(r.label, (labelCounts.get(r.label) ?? 0) + 1);
        record(datasetToJsonl(data), data.length);
        matches++;
        process.stdout.write(`  ${a} vs ${b} seed ${seed}: ${data.length} rows\n`);
      }
    }
  }

  console.log(`\n${rows} rows from ${matches} match(es) → ${opts.out}`);
  console.log(`${FEATURE_NAMES.length} features per row: ${FEATURE_NAMES.join(', ')}`);
  console.log('label distribution (next macro action):');
  for (const [label, count] of [...labelCounts].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${label.padEnd(20)} ${count}  (${(100 * count / Math.max(1, rows)).toFixed(1)}%)`);
  }
}

main();
