/**
 * Tensor v2 self-play: train one universal phase-aware policy against the whole
 * Classic ladder, and evaluate it honestly (docs/tensor-retrain-plan.md, stages
 * 0 and 3-5).
 *
 *   tsx tools/selfplay/tensorV2.ts baseline [seedsPerOpponent]
 *   tsx tools/selfplay/tensorV2.ts train [generations] [gamesPerGen]
 *   tsx tools/selfplay/tensorV2.ts eval [seedsPerOpponent] [checkpoint]
 *
 * What makes this different from the v1 trainer, point by point from the plan:
 *
 *   • MULTI-OPPONENT. One policy is trained against a mixture of Easy, Hard and
 *     Godlike on a curriculum, not three opponent-specific models.
 *   • BOTH ORIENTATIONS. Every seed is played from each spawn corner, so a
 *     result can never be an artifact of which corner the arena favours.
 *   • DECISIVE OUTCOME as the elite signal — win/loss/draw at the training
 *     horizon. The economic margin is recorded, but only as a diagnostic and as
 *     a tie-break when a generation produced too few decisive games; v1's
 *     five-minute margin reward was measured to prefer fast starts over wins.
 *   • PER-PHASE credit. A match contributes its decision rows to the phase MPS
 *     that drew them, so a good late-game is not reinforced into the opening.
 *   • DIVERSITY GUARDS. The imitation anchor stays in every batch, identical
 *     elite rows are capped, and the archive keeps behaviourally distinct
 *     checkpoints so a winner-only loop cannot collapse to one line.
 *   • DISJOINT SEEDS. Training, tuning and the final campaign draw from ranges
 *     that never overlap, so the reported number is not the training number.
 *
 * Matches fan across cores with the same child-process pool the v1 trainer uses
 * (worker threads inherit tsx's transform but not its resolver, so a spawned tsx
 * child is the reliable pool unit).
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
import { PLAYER_IDS, type PlayerId } from '../../src/types';
import {
  deserializeMPS, fitStepScaled, serializeMPS, type MPS,
} from '../../src/ai/tensor/mps';
import { anchorRows, loadV2Model, priorV2Model, type TensorV2Model } from '../../src/ai/tensor/modelV2';
import { decodeBundle, PHASE_INTENTS, type IntentId } from '../../src/ai/tensor/plan';
import type { Phase } from '../../src/ai/tensor/phase';

const PHASES: readonly Phase[] = ['opening', 'midgame', 'lategame'];
const OPPONENTS = ['classic-easy', 'classic-hard', 'classic-godlike'] as const;
type Opponent = (typeof OPPONENTS)[number];

/** Training horizon. Long enough that most games reach an elimination — the
 *  elite signal is the OUTCOME, so a horizon that ends every game in a draw
 *  would leave nothing to learn from. */
const TRAIN_SECONDS = 1200;
/** Campaign horizon. The arena's own hard timer caps it in practice. */
const EVAL_SECONDS = 2400;

/** Seed ranges that never overlap: training draws far above tuning, and the
 *  final campaign owns a fixed block neither of them can reach. */
const SEEDS = {
  test: (i: number): number => 9_000 + i,          // 9 000 … 9 999   held out
  tune: (i: number): number => 50_000 + i,         // 50 000 … 59 999 checkpoint selection
  train: (rng: Rng): number => 200_000 + rng.int(1 << 28),
};

const TMP = join('target', 'selfplay', '.tensor2');
const ARCHIVE = join('target', 'selfplay', 'tensor2-archive');
const CHECKPOINT = join('target', 'selfplay', 'tensor2-checkpoint.json');
const TAG = '@R ';

interface MatchJob {
  seed: number;
  opponent: Opponent;
  /** Which seat the tensor policy takes — every seed is played from both. */
  seat: PlayerId;
  seconds: number;
}

interface MatchResult {
  seed: number;
  opponent: Opponent;
  seat: PlayerId;
  /** 1 win, 0.5 draw, 0 loss — the match score the campaign reports. */
  score: number;
  decisive: boolean;
  /** Economic/army lead at the end. Diagnostic and tie-break only. */
  margin: number;
  simSeconds: number;
  rejected: number;
  commands: number;
  cpuMsMax: number;
  /** Decision rows by phase: the raw clamped-context + sampled-intent slots. */
  rows: Record<Phase, number[][]>;
  /** Intents drawn this match, for entropy and collapse reporting. */
  intents: IntentId[];
  identity: string;
  /** Phase the seat reached, and whether it ever entered recovery. */
  reachedPhase: Phase;
}

// ---- one match ----

function playMatch(model: TensorV2Model, job: MatchJob): MatchResult {
  const { seed, opponent, seat, seconds } = job;
  const { game, world, level } = makeSkirmishGame(seed);
  const macro = new TensorMacroV2(model);
  const rival: PlayerId = seat === 'p1' ? 'p2' : 'p1';
  const profiles: Record<PlayerId, string> = { [seat]: 'tensor2', [rival]: opponent } as Record<PlayerId, string>;

  const controllers = PLAYER_IDS.map((playerId, index) => new AIController({
    game, world, playerId,
    profile: aiProfile(profiles[playerId]),
    seed: (seed ^ (index + 1) * 0x9e3779b9) >>> 0,
    macro: playerId === seat ? macro : undefined,
    submit: command => applyGameCommand(game, playerId, command),
  }));
  const own = controllers[PLAYER_IDS.indexOf(seat)];

  const maxTicks = Math.round(Math.min(seconds, level.hardTimer) / TICK_SECONDS);
  for (let tick = 0; tick < maxTicks; tick++) {
    for (const controller of controllers) controller.tick(TICK_SECONDS);
    game.update(TICK_SECONDS);
    if (game.eliminated.size) break;
  }

  const winner = skirmishWinner(game);
  const strength = (id: PlayerId): number => {
    let army = 0, buildings = 0;
    for (const unit of game.units) if (!unit.dead && unit.owner === id && unit.dmg > 0) army++;
    for (const building of game.buildings) if (!building.removed && building.owner === id) buildings++;
    const coin = game.playerStores.get(id)?.stock?.coin ?? 0;
    return army * 2 + buildings + coin * 0.05;
  };

  const rows = { opening: [], midgame: [], lategame: [] } as Record<Phase, number[][]>;
  for (const entry of macro.drawn) rows[entry.phase].push(entry.seq);

  return {
    seed, opponent, seat,
    score: winner === seat ? 1 : winner === rival ? 0 : 0.5,
    decisive: !!winner,
    margin: strength(seat) - strength(rival),
    simSeconds: game.elapsed,
    rejected: own.stats.rejected,
    commands: own.stats.commands,
    cpuMsMax: own.stats.cpuMsMax,
    rows,
    intents: macro.drawn.flatMap(entry => entry.intents),
    identity: macro.state.identity ?? 'none',
    reachedPhase: macro.state.phase,
  };
}

// ---- parallel batch ----

function playBatch(model: TensorV2Model, jobs: MatchJob[], workers: number): Promise<MatchResult[]> {
  if (!jobs.length) return Promise.resolve([]);
  mkdirSync(TMP, { recursive: true });
  const modelPath = join(TMP, `model-${process.pid}.json`);
  writeFileSync(modelPath, JSON.stringify(model));
  const shardCount = Math.max(1, Math.min(workers, jobs.length));
  const shards: MatchJob[][] = Array.from({ length: shardCount }, () => []);
  jobs.forEach((job, i) => shards[i % shardCount].push(job));
  const selfPath = fileURLToPath(import.meta.url);
  const tsxBin = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
  const results: MatchResult[] = [];

  return Promise.all(shards.map((shard, index) => new Promise<void>((resolve, reject) => {
    const shardFile = join(TMP, `jobs-${process.pid}-${index}.json`);
    writeFileSync(shardFile, JSON.stringify(shard));
    const child = spawn(tsxBin, [selfPath, '--shard', modelPath, shardFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    createInterface({ input: child.stdout! }).on('line', line => {
      if (line.startsWith(TAG)) results.push(JSON.parse(line.slice(TAG.length)) as MatchResult);
    });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker ${index} exited ${code}`))));
  }))).then(() => results);
}

function runShard(modelPath: string, shardFile: string): void {
  const model = JSON.parse(readFileSync(modelPath, 'utf8')) as TensorV2Model;
  const jobs = JSON.parse(readFileSync(shardFile, 'utf8')) as MatchJob[];
  for (const job of jobs) process.stdout.write(TAG + JSON.stringify(playMatch(model, job)) + '\n');
}

// ---- reporting ----

interface Summary {
  matches: number;
  score: number;
  wins: number;
  draws: number;
  losses: number;
  /** Half-width of the 95% confidence interval on the match score. */
  ci: number;
  rejected: number;
  decisiveFrac: number;
  cpuMsMax: number;
}

function summarise(results: MatchResult[]): Summary {
  const n = Math.max(1, results.length);
  const score = results.reduce((sum, r) => sum + r.score, 0) / n;
  // Normal-approximation interval on the mean match score (draws count a half),
  // which is the quantity the promotion bar is written against.
  const variance = results.reduce((sum, r) => sum + (r.score - score) ** 2, 0) / Math.max(1, n - 1);
  return {
    matches: results.length,
    score,
    wins: results.filter(r => r.score === 1).length,
    draws: results.filter(r => r.score === 0.5).length,
    losses: results.filter(r => r.score === 0).length,
    ci: 1.96 * Math.sqrt(variance / n),
    rejected: results.reduce((sum, r) => sum + r.rejected, 0),
    decisiveFrac: results.filter(r => r.decisive).length / n,
    cpuMsMax: results.reduce((max, r) => Math.max(max, r.cpuMsMax), 0),
  };
}

function line(label: string, s: Summary): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return `  ${label.padEnd(18)} score ${pct(s.score)} ±${pct(s.ci)}  `
    + `(W${s.wins}/D${s.draws}/L${s.losses} of ${s.matches})  decisive ${pct(s.decisiveFrac)}  rejected ${s.rejected}`;
}

/** Shannon entropy over the intents a batch of matches drew — the collapse
 *  detector the plan asks for: one line played over and over reads near zero. */
function intentEntropy(results: MatchResult[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const result of results) for (const intent of result.intents) {
    counts.set(intent, (counts.get(intent) ?? 0) + 1);
    total++;
  }
  if (!total) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function jobsFor(opponents: readonly Opponent[], seeds: number[], seconds: number): MatchJob[] {
  const jobs: MatchJob[] = [];
  for (const opponent of opponents) for (const seed of seeds) for (const seat of PLAYER_IDS) {
    jobs.push({ seed, opponent, seat, seconds });
  }
  return jobs;
}

async function campaign(
  model: TensorV2Model, seeds: number[], seconds: number, workers: number, label: string,
): Promise<Record<Opponent, Summary> & { all: Summary; entropy: number }> {
  const results = await playBatch(model, jobsFor(OPPONENTS, seeds, seconds), workers);
  const byOpponent = {} as Record<Opponent, Summary>;
  for (const opponent of OPPONENTS) byOpponent[opponent] = summarise(results.filter(r => r.opponent === opponent));
  const out = { ...byOpponent, all: summarise(results), entropy: intentEntropy(results) };
  process.stdout.write(`${label}\n`);
  for (const opponent of OPPONENTS) process.stdout.write(line(opponent, byOpponent[opponent]) + '\n');
  process.stdout.write(line('ALL', out.all) + `  intent entropy ${out.entropy.toFixed(2)} bits\n`);
  return out;
}

// ---- training ----

/** How much of each generation's batch is drawn from Easy / Hard / Godlike.
 *  Infrastructure is validated against Easy first, then Hard is introduced, and
 *  Godlike takes the largest share while the earlier two stay in rehearsal —
 *  the anti-forgetting curriculum the plan specifies. */
function curriculum(generation: number, total: number): Record<Opponent, number> {
  const progress = total <= 1 ? 1 : generation / (total - 1);
  if (progress < 0.25) return { 'classic-easy': 0.6, 'classic-hard': 0.3, 'classic-godlike': 0.1 };
  if (progress < 0.5) return { 'classic-easy': 0.25, 'classic-hard': 0.45, 'classic-godlike': 0.3 };
  return { 'classic-easy': 0.15, 'classic-hard': 0.3, 'classic-godlike': 0.55 };
}

/** Cap how many times one identical row may appear in a refit batch. Without
 *  it a single lucky line, replayed by every winning match, becomes the whole
 *  gradient and the distribution collapses onto it. */
const ROW_MULTIPLICITY_CAP = 3;

/** Phases whose decisions self-play may rewrite. Empty means all of them. */
const LEARN_PHASES: readonly Phase[] = ['lategame'];

function capRepeats(rows: number[][]): number[][] {
  const seen = new Map<string, number>();
  const out: number[][] = [];
  for (const row of rows) {
    const key = row.join(',');
    const count = seen.get(key) ?? 0;
    if (count >= ROW_MULTIPLICITY_CAP) continue;
    seen.set(key, count + 1);
    out.push(row);
  }
  return out;
}

interface TrainOptions {
  generations: number;
  gamesPerGen: number;
  workers: number;
  /** Gradient steps per phase per generation. */
  steps: number;
  /** Trust-region step size for the refit. */
  step: number;
  /** Re-score on the tuning seeds every N generations (it costs a batch). */
  tuneEvery: number;
}

async function train(start: TensorV2Model, options: TrainOptions): Promise<{
  best: TensorV2Model; curve: { generation: number; score: number; decisive: number; entropy: number }[];
}> {
  const { generations, gamesPerGen, workers, steps, step } = options;
  const loaded = loadV2Model(start);
  const live = {} as Record<Phase, MPS>;
  for (const phase of PHASES) live[phase] = loaded.phases[phase];
  const anchors = {} as Record<Phase, number[][]>;
  for (const phase of PHASES) anchors[phase] = anchorRows(phase);

  const rng = new Rng(0x7E2504);
  const curve: { generation: number; score: number; decisive: number; entropy: number }[] = [];
  mkdirSync(ARCHIVE, { recursive: true });

  const snapshot = (origin: string): TensorV2Model => ({
    version: 2, vocab: start.vocab, origin,
    phases: Object.fromEntries(PHASES.map(phase => [phase, serializeMPS(live[phase])])) as TensorV2Model['phases'],
  });

  // Tuning set: a small fixed block, disjoint from both training and the final
  // campaign, used only to decide WHICH checkpoint to carry forward.
  const tuneSeeds = Array.from({ length: 4 }, (_, i) => SEEDS.tune(i));
  let bestModel = snapshot('prior');
  let bestScore = -1;

  for (let generation = 0; generation < generations; generation++) {
    const mix = curriculum(generation, generations);
    const jobs: MatchJob[] = [];
    for (const opponent of OPPONENTS) {
      const count = Math.max(1, Math.round(gamesPerGen * mix[opponent] / 2)); // ×2 seats below
      for (let i = 0; i < count; i++) {
        const seed = SEEDS.train(rng);
        for (const seat of PLAYER_IDS) jobs.push({ seed, opponent, seat, seconds: TRAIN_SECONDS });
      }
    }
    const model = snapshot(`gen-${generation}`);
    const t0 = Date.now();
    const results = await playBatch(model, jobs, workers);
    const summary = summarise(results);

    // Elite = the matches this policy actually WON. Only when a generation is
    // too thin on wins does the margin break the tie, and even then it is a
    // fallback for having a gradient at all, never the optimisation target.
    let elite = results.filter(r => r.score === 1);
    const wanted = Math.max(4, Math.round(results.length * 0.2));
    if (elite.length < wanted) {
      const rest = results.filter(r => r.score !== 1).sort((a, b) => b.margin - a.margin);
      elite = [...elite, ...rest.slice(0, wanted - elite.length)];
    }

    for (const phase of PHASES) {
      // LEARN ONLY WHERE THE OUTCOME MEANS SOMETHING. The value function
      // (docs/ai-experiments/2026-07-value-function.md) measures the winner as
      // unpredictable before minute 12 — below the majority-class floor, in
      // both the pre-hero and hero eras — and 86-96% predictable after it.
      // Reinforcing opening and mid-game decisions with a match outcome that is
      // nearly independent of them is how fourteen generations produced noise;
      // those phases keep the imitation prior, which plays them competently.
      if (LEARN_PHASES.length && !LEARN_PHASES.includes(phase)) continue;
      const won = capRepeats(elite.flatMap(r => r.rows[phase]));
      if (won.length < 3) continue;                       // nothing worth learning from
      const batch = [...won, ...anchors[phase]];
      for (let s = 0; s < steps; s++) fitStepScaled(live[phase], batch, step);
    }

    const entropy = intentEntropy(results);
    curve.push({
      generation, score: Math.round(summary.score * 1000) / 1000,
      decisive: Math.round(summary.decisiveFrac * 100) / 100,
      entropy: Math.round(entropy * 100) / 100,
    });
    process.stdout.write(
      `  gen ${String(generation + 1).padStart(2)}/${generations}  `
      + `train score ${(summary.score * 100).toFixed(1)}%  (W${summary.wins}/D${summary.draws}/L${summary.losses})  `
      + `elite ${elite.length}  entropy ${entropy.toFixed(2)}  [${((Date.now() - t0) / 1000).toFixed(0)}s]\n`);

    // Archive and select on the TUNING seeds, never on the training batch: a
    // generation that got easy seeds must not be crowned for it. Scoring costs a
    // whole batch, so it runs on a cadence rather than every generation.
    const candidate = snapshot(`gen-${generation + 1}`);
    writeFileSync(join(ARCHIVE, `gen-${generation + 1}.json`), JSON.stringify(candidate));
    const last = generation === generations - 1;
    if (last || (generation + 1) % options.tuneEvery === 0) {
      const tune = await playBatch(candidate, jobsFor(OPPONENTS, tuneSeeds, TRAIN_SECONDS), workers);
      const tuneScore = summarise(tune).score;
      process.stdout.write(`      tune score ${(tuneScore * 100).toFixed(1)}%${tuneScore > bestScore ? '  ← new best' : ''}\n`);
      if (tuneScore > bestScore) {
        bestScore = tuneScore;
        bestModel = candidate;
        // Persist the leader as we go: a run that is interrupted must not lose
        // the best policy it already found.
        writeFileSync(CHECKPOINT, JSON.stringify(bestModel));
      }
    }
    writeFileSync(join(ARCHIVE, 'curve.json'), JSON.stringify(curve, null, 2));
  }
  return { best: bestModel, curve };
}

// ---- CLI ----

function loadCheckpoint(path: string): TensorV2Model {
  return JSON.parse(readFileSync(path, 'utf8')) as TensorV2Model;
}

async function main(): Promise<void> {
  const workers = Number(process.env.TENSOR2_WORKERS ?? availableParallelism());
  const command = process.argv[2] ?? 'baseline';

  if (command === 'baseline') {
    const n = Number(process.argv[3] ?? 8);
    const seeds = Array.from({ length: n }, (_, i) => SEEDS.test(i));
    const t0 = Date.now();
    await campaign(priorV2Model(), seeds, EVAL_SECONDS, workers,
      `Tensor v2 PRIOR — held-out baseline, ${n} seeds × 2 seats × 3 opponents:`);
    process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s]\n`);
    return;
  }

  if (command === 'train') {
    const generations = Number(process.argv[3] ?? 10);
    const gamesPerGen = Number(process.argv[4] ?? 16);
    process.stdout.write(
      `Tensor v2 self-play: ${generations} generations × ~${gamesPerGen * 2} matches `
      + `(both seats, curriculum over the Classic ladder) · ${workers} workers\n`);
    const t0 = Date.now();
    const start = existsSync(CHECKPOINT) && process.argv.includes('--resume')
      ? loadCheckpoint(CHECKPOINT) : priorV2Model();
    const tuneEvery = Number(process.env.TENSOR2_TUNE_EVERY ?? 3);
    const { best, curve } = await train(start, { generations, gamesPerGen, workers, steps: 8, step: 0.02, tuneEvery });
    writeFileSync(CHECKPOINT, JSON.stringify(best));
    writeFileSync(join(ARCHIVE, 'curve.json'), JSON.stringify(curve, null, 2));
    process.stdout.write(`\nbest checkpoint → ${CHECKPOINT}  [${((Date.now() - t0) / 60000).toFixed(1)} min]\n`);
    return;
  }

  if (command === 'sweep') {
    // A RESTART-SAFE campaign. The eval command holds every result in memory and
    // prints once at the end, so a container reclaim mid-run loses the lot. This
    // walks the held-out block in small chunks instead, appending each chunk's
    // raw matches to a JSONL file and skipping chunks already recorded — so an
    // interrupted campaign resumes exactly where it stopped.
    const total = Number(process.argv[3] ?? 40);
    const chunk = Number(process.argv[4] ?? 5);
    const path = process.argv[5] ?? join(ARCHIVE, 'sweep.jsonl');
    const checkpoint = process.argv[6] && process.argv[6] !== '-' ? process.argv[6] : undefined;
    const only = process.argv[7] as Opponent | undefined;
    const field = only ? [only] : OPPONENTS;
    const model = checkpoint ? loadCheckpoint(checkpoint) : priorV2Model();
    mkdirSync(ARCHIVE, { recursive: true });

    const done = new Set<string>();
    if (existsSync(path)) {
      for (const raw of readFileSync(path, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        const row = JSON.parse(raw) as MatchResult;
        done.add(`${row.seed}|${row.opponent}|${row.seat}`);
      }
    }
    process.stdout.write(`sweep [${model.origin}] → ${path}  (${done.size} matches already recorded)\n`);

    for (let start = 0; start < total; start += chunk) {
      const seeds = Array.from({ length: Math.min(chunk, total - start) }, (_, i) => SEEDS.test(start + i));
      const jobs = jobsFor(field, seeds, EVAL_SECONDS)
        .filter(job => !done.has(`${job.seed}|${job.opponent}|${job.seat}`));
      if (!jobs.length) continue;
      const t0 = Date.now();
      const results = await playBatch(model, jobs, workers);
      // Drop the bulky decision rows: the sweep file is an outcome record, and
      // the rows would multiply its size for no analysis this stage needs.
      const lines = results.map(r => JSON.stringify({ ...r, rows: undefined })).join('\n');
      writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + lines + '\n');
      const s = summarise(results);
      process.stdout.write(
        `  seeds ${start}-${start + seeds.length - 1}: score ${(s.score * 100).toFixed(1)}%  `
        + `(W${s.wins}/D${s.draws}/L${s.losses})  [${((Date.now() - t0) / 1000).toFixed(0)}s]\n`);
    }

    // Final tally over everything recorded, including earlier interrupted runs.
    const all: MatchResult[] = readFileSync(path, 'utf8').split('\n')
      .filter(raw => raw.trim()).map(raw => JSON.parse(raw) as MatchResult);
    process.stdout.write(`\nSWEEP COMPLETE [${model.origin}] — ${all.length} matches\n`);
    for (const opponent of field) {
      process.stdout.write(line(opponent, summarise(all.filter(r => r.opponent === opponent))) + '\n');
    }
    process.stdout.write(line('ALL', summarise(all)) + `  intent entropy ${intentEntropy(all).toFixed(2)} bits\n`);
    return;
  }

  if (command === 'eval') {
    const n = Number(process.argv[3] ?? 24);
    const path = process.argv[4];
    const model = path ? loadCheckpoint(path) : (existsSync(CHECKPOINT) ? loadCheckpoint(CHECKPOINT) : priorV2Model());
    const seeds = Array.from({ length: n }, (_, i) => SEEDS.test(i));
    const t0 = Date.now();
    const out = await campaign(model, seeds, EVAL_SECONDS, workers,
      `Tensor v2 [${model.origin}] — held-out campaign, ${n} seeds × 2 seats × 3 opponents:`);
    // The promotion bar, checked mechanically so it cannot be talked around.
    const beatsAll = OPPONENTS.every(opponent => out[opponent].score - out[opponent].ci > 0.5);
    const clean = out.all.rejected === 0;
    process.stdout.write(
      `\npromotion: beats every persona with the CI above 50% → ${beatsAll ? 'YES' : 'NO'}; `
      + `zero rejected commands → ${clean ? 'YES' : 'NO'}\n`);
    writeFileSync(join(ARCHIVE, 'campaign.json'), JSON.stringify(out, null, 2));
    process.stdout.write(`[${((Date.now() - t0) / 60000).toFixed(1)} min]\n`);
    return;
  }

  process.stderr.write(`unknown command '${command}' — use baseline | train | eval\n`);
  process.exit(1);
}

const shardFlag = process.argv.indexOf('--shard');
if (shardFlag >= 0) {
  runShard(process.argv[shardFlag + 1], process.argv[shardFlag + 2]);
} else {
  main().catch(error => { console.error(error); process.exit(1); });
}

/** Re-exported for the tests: the intent alphabet a phase can draw. */
export const phaseAlphabet = (phase: Phase): readonly IntentId[] => PHASE_INTENTS[phase];
export { decodeBundle, deserializeMPS };
