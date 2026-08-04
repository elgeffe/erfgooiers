/**
 * The value function: can a small network predict who wins, and how early?
 *
 *   tsx tools/selfplay/valueNet.ts collect [matches] [out.jsonl]
 *   tsx tools/selfplay/valueNet.ts train [rows.jsonl]
 *
 * This is the missing piece behind the Tensor v2 negative result. That policy
 * learns from ONE win/loss bit shared across ~30 decisions per match, so
 * fourteen generations of self-play moved +1.5% ±6.1% — indistinguishable from
 * noise. A value head gives every decision its own target.
 *
 * Two payoffs, in order of certainty:
 *
 *   1. CREDIT ASSIGNMENT. V(s) turns one bit per match into one target per
 *      decision, which is the prerequisite for any advantage-weighted update.
 *   2. THROUGHPUT. If V predicts the winner accurately at eight minutes, then
 *      training matches can stop there and bootstrap the rest instead of playing
 *      out twenty. At ~40 s a match on four cores, that is the difference
 *      between 350 and ~1000 matches an hour — and sample count, not algorithm,
 *      is what the campaign showed to be binding.
 *
 * The accuracy-by-minute table `train` prints is therefore the actual
 * experimental result here, not the trained weights.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Rng } from '../../src/engine/rng';
import { makeSkirmishGame } from '../../src/game/testHarness';
import { AIController } from '../../src/ai/AIController';
import { TensorMacroV2 } from '../../src/ai/strategy/tensorV2';
import { aiProfile } from '../../src/data/aiProfiles';
import { applyGameCommand } from '../../src/game/commands';
import { skirmishWinner, TICK_SECONDS } from '../../src/game/replay';
import { perceive } from '../../src/ai/perception';
import { PLAYER_IDS, type PlayerId } from '../../src/types';
import { featureVector, FEATURE_COUNT, FEATURE_NAMES } from '../../src/ai/learn/features';
import {
  adamState, adamStep, backward, forward, forwardAll, randomMLP, serializeMLP,
  sigmoid, zeroGrad, type MLP,
} from '../../src/ai/learn/net';

const OPPONENTS = ['classic-easy', 'classic-hard', 'classic-godlike'] as const;
type Opponent = (typeof OPPONENTS)[number];

/** Sample the state this often (sim-seconds). Finer than the decision cadence
 *  would only add near-duplicate rows; coarser wastes matches. */
const SAMPLE_EVERY = 30;
const MATCH_SECONDS = 2400;
const TMP = join('target', 'selfplay', '.value');
const TAG = '@V ';

interface Row {
  /** Minute of the match, kept out of the feature vector's normalisation. */
  t: number;
  x: number[];
  /** 1 the sampled seat went on to win, 0 lost, 0.5 drew. */
  y: number;
  opponent: Opponent;
  seed: number;
  seat: PlayerId;
}

interface Job { seed: number; opponent: Opponent; seat: PlayerId; }

// ---- collection ----

function playAndLog(job: Job): Row[] {
  const { seed, opponent, seat } = job;
  const { game, world, level } = makeSkirmishGame(seed);
  const macro = new TensorMacroV2();
  const rival: PlayerId = seat === 'p1' ? 'p2' : 'p1';
  const profiles = { [seat]: 'tensor2', [rival]: opponent } as Record<PlayerId, string>;
  const controllers = PLAYER_IDS.map((playerId, index) => new AIController({
    game, world, playerId,
    profile: aiProfile(profiles[playerId]),
    seed: (seed ^ (index + 1) * 0x9e3779b9) >>> 0,
    macro: playerId === seat ? macro : undefined,
    submit: command => applyGameCommand(game, playerId, command),
  }));

  const rows: Omit<Row, 'y'>[] = [];
  const maxTicks = Math.round(Math.min(MATCH_SECONDS, level.hardTimer) / TICK_SECONDS);
  let nextSample = 60;
  for (let tick = 0; tick < maxTicks; tick++) {
    for (const controller of controllers) controller.tick(TICK_SECONDS);
    game.update(TICK_SECONDS);
    if (game.elapsed >= nextSample) {
      nextSample += SAMPLE_EVERY;
      const view = perceive(game, world, seat);
      if (view.store) {
        const state = macro.state;
        rows.push({
          t: game.elapsed / 60, seed, opponent, seat,
          x: featureVector(game, view, { phase: state.phase, recovery: state.recovery }),
        });
      }
    }
    if (game.eliminated.size) break;
  }
  const winner = skirmishWinner(game);
  const y = winner === seat ? 1 : winner === rival ? 0 : 0.5;
  return rows.map(row => ({ ...row, y }));
}

function collect(matches: number, out: string, workers: number): Promise<void> {
  mkdirSync(TMP, { recursive: true });
  const rng = new Rng(0x5EEDDA7A);
  const jobs: Job[] = [];
  for (let i = 0; i < matches; i++) {
    // Training data lives in its own seed range, far from the held-out block
    // the policy campaign reports on.
    const seed = 700_000 + rng.int(1 << 26);
    const opponent = OPPONENTS[i % OPPONENTS.length];
    for (const seat of PLAYER_IDS) jobs.push({ seed, opponent, seat });
  }
  const shardCount = Math.max(1, Math.min(workers, jobs.length));
  const shards: Job[][] = Array.from({ length: shardCount }, () => []);
  jobs.forEach((job, i) => shards[i % shardCount].push(job));
  const selfPath = fileURLToPath(import.meta.url);
  const tsxBin = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
  let done = 0;

  return Promise.all(shards.map((shard, index) => new Promise<void>((resolve, reject) => {
    const shardFile = join(TMP, `jobs-${process.pid}-${index}.json`);
    writeFileSync(shardFile, JSON.stringify(shard));
    const child = spawn(tsxBin, [selfPath, '--shard', shardFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    createInterface({ input: child.stdout! }).on('line', line => {
      if (!line.startsWith(TAG)) return;
      appendFileSync(out, line.slice(TAG.length) + '\n');
      if (++done % 20 === 0) process.stdout.write(`  ${done}/${jobs.length} matches logged\n`);
    });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker ${index} exited ${code}`))));
  }))).then(() => undefined);
}

function runShard(shardFile: string): void {
  const jobs = JSON.parse(readFileSync(shardFile, 'utf8')) as Job[];
  for (const job of jobs) {
    const rows = playAndLog(job);
    // one line per match keeps the file small and the append atomic
    process.stdout.write(TAG + JSON.stringify(rows) + '\n');
  }
}

// ---- training ----

function loadRows(path: string): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    for (const row of JSON.parse(line) as Row[]) rows.push(row);
  }
  return rows;
}

/** Split by SEED, never by row: two samples from one match are so correlated
 *  that a row-wise split would report a validation score the model cannot
 *  reproduce on a match it has never seen. */
function splitBySeed(rows: Row[], holdout = 0.2): { train: Row[]; test: Row[] } {
  const seeds = [...new Set(rows.map(row => row.seed))].sort((a, b) => a - b);
  const cut = Math.floor(seeds.length * (1 - holdout));
  const testSeeds = new Set(seeds.slice(cut));
  return {
    train: rows.filter(row => !testSeeds.has(row.seed)),
    test: rows.filter(row => testSeeds.has(row.seed)),
  };
}

function evaluate(net: MLP, rows: Row[]): { loss: number; acc: number; brier: number } {
  let loss = 0, correct = 0, brier = 0, n = 0;
  for (const row of rows) {
    if (row.y === 0.5) continue;            // draws have no side to be right about
    const p = sigmoid(forward(net, row.x)[0]);
    loss += -(row.y * Math.log(p + 1e-12) + (1 - row.y) * Math.log(1 - p + 1e-12));
    brier += (p - row.y) ** 2;
    if ((p >= 0.5 ? 1 : 0) === row.y) correct++;
    n++;
  }
  return { loss: loss / Math.max(1, n), acc: correct / Math.max(1, n), brier: brier / Math.max(1, n) };
}

function train(path: string): void {
  const all = loadRows(path);
  const { train: trainRows, test } = splitBySeed(all);
  process.stdout.write(
    `${all.length} rows from ${new Set(all.map(r => r.seed)).size} seeds  `
    + `(train ${trainRows.length} / held-out ${test.length})\n`);

  const rng = new Rng(0x1CE);
  const net = randomMLP([FEATURE_COUNT, 48, 24, 1], rng, 'tanh', 'linear');
  const state = adamState(net);
  const batchSize = 256;
  const order = trainRows.map((_, i) => i);

  for (let epoch = 0; epoch < 60; epoch++) {
    // deterministic shuffle from the seeded stream
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      const grad = zeroGrad(net);
      for (const index of batch) {
        const row = trainRows[index];
        const acts = forwardAll(net, row.x);
        backward(net, acts, [sigmoid(acts[acts.length - 1][0]) - row.y], grad);
      }
      for (const layer of grad) {
        for (const w of layer.w) for (let i = 0; i < w.length; i++) w[i] /= batch.length;
        for (let i = 0; i < layer.b.length; i++) layer.b[i] /= batch.length;
      }
      adamStep(net, grad, state, 0.004, 1e-5);
    }
    if ((epoch + 1) % 15 === 0) {
      const tr = evaluate(net, trainRows), te = evaluate(net, test);
      process.stdout.write(
        `  epoch ${String(epoch + 1).padStart(2)}  train loss ${tr.loss.toFixed(3)} acc ${(tr.acc * 100).toFixed(1)}%`
        + `   held-out loss ${te.loss.toFixed(3)} acc ${(te.acc * 100).toFixed(1)}% brier ${te.brier.toFixed(3)}\n`);
    }
  }

  // THE result: how early is the outcome already legible?
  process.stdout.write('\nheld-out accuracy by match minute (this decides whether training can truncate):\n');
  for (const [lo, hi] of [[0, 4], [4, 8], [8, 12], [12, 16], [16, 24], [24, 99]] as const) {
    const slice = test.filter(row => row.t >= lo && row.t < hi);
    if (!slice.length) continue;
    const { acc, brier } = evaluate(net, slice);
    const bar = '#'.repeat(Math.round(acc * 40));
    process.stdout.write(`  ${String(lo).padStart(2)}-${String(hi).padStart(2)}m  n=${String(slice.length).padStart(5)}  acc ${(acc * 100).toFixed(1)}%  brier ${brier.toFixed(3)}  ${bar}\n`);
  }

  // A baseline any useful model must beat: predict from the army ratio alone.
  const share = FEATURE_NAMES.indexOf('army_share');
  let naive = 0, naiveN = 0;
  for (const row of test) {
    if (row.y === 0.5) continue;
    if ((row.x[share] >= 0.5 ? 1 : 0) === row.y) naive++;
    naiveN++;
  }
  process.stdout.write(`\nbaseline (army share alone): ${(naive / Math.max(1, naiveN) * 100).toFixed(1)}%\n`);

  const out = join('target', 'selfplay', 'valuenet.json');
  writeFileSync(out, JSON.stringify(serializeMLP(net)));
  process.stdout.write(`value net → ${out}\n`);
}

// ---- CLI ----

async function main(): Promise<void> {
  const workers = Number(process.env.TENSOR2_WORKERS ?? availableParallelism());
  const command = process.argv[2] ?? 'train';
  if (command === 'collect') {
    const matches = Number(process.argv[3] ?? 60);
    const out = process.argv[4] ?? join('target', 'selfplay', 'value-rows.jsonl');
    mkdirSync(join('target', 'selfplay'), { recursive: true });
    if (!existsSync(out)) writeFileSync(out, '');
    const t0 = Date.now();
    process.stdout.write(`collecting ${matches * 2} matches (both seats) across the ladder · ${workers} workers\n`);
    await collect(matches, out, workers);
    process.stdout.write(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min → ${out}\n`);
    return;
  }
  if (command === 'train') {
    train(process.argv[3] ?? join('target', 'selfplay', 'value-rows.jsonl'));
    return;
  }
  process.stderr.write(`unknown command '${command}' — use collect | train\n`);
  process.exit(1);
}

const shardFlag = process.argv.indexOf('--shard');
if (shardFlag >= 0) runShard(process.argv[shardFlag + 1]);
else main().catch(error => { console.error(error); process.exit(1); });
