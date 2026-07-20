/**
 * The tensor-network strategy spike: train and evaluate the MPS generative
 * policy against the Classic baseline, all headless and fanned across cores.
 *
 *   tsx tools/selfplay/tensorModel.ts               # (re)generate imitation prior
 *   tsx tools/selfplay/tensor.ts train [gens] [N]   # TN-GEO self-play refinement
 *   tsx tools/selfplay/tensor.ts eval [N]           # held-out win rate vs Godlike
 *
 * The loop is generator-enhanced cross-entropy (the spirit of the TN-GEO paper
 * cited in docs/tensor-networks-for-logistics.md): sample whole plans from the
 * MPS, play each vs Godlike, keep the winners, refit the MPS toward them, repeat.
 * Nothing here can cheat — every match runs through the same AIController seam a
 * human plays, and the tensor seat only swaps its macro for the in-training model.
 *
 * Matches are fanned across CPU cores exactly like tools/selfplay/campaign.ts:
 * each generation writes the current model to a temp JSON, shards the seeds, and
 * spawns tsx worker children (worker threads only inherit tsx's transform, not
 * its extensionless resolver, so a child process through the tsx binary is the
 * reliable pool unit).
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
import { TensorMacro } from '../../src/ai/strategy/tensor';
import { aiProfile } from '../../src/data/aiProfiles';
import { applyGameCommand } from '../../src/game/commands';
import { skirmishWinner, TICK_SECONDS } from '../../src/game/replay';
import { PLAYER_IDS, type PlayerId } from '../../src/types';
import { fitStep, serializeMPS, deserializeMPS, type MPS, type SerializedMPS } from '../../src/ai/tensor/mps';
import { expertPlans, ACTIONS } from '../../src/ai/tensor/plan';
import { pretrain, loadModelMPS, writeModel, MODEL_PATH } from './tensorModel';

const OPPONENT = 'classic-godlike-balanced';
/** Cap match length while training so a generation is cheap. The dense `margin`
 *  reward (economic + military lead) makes an opening's quality visible well
 *  before an elimination, and late-game ticks with big armies are far too slow
 *  to sample hundreds of. The final win rate is then measured on decisive games. */
const TRAIN_SECONDS = 300;
/** Decisive-but-bounded horizon for the held-out win rate (most games resolve
 *  by here; the full 60-min timer is too slow to evaluate many of). */
const EVAL_SECONDS = 1500;
const TMP = join('target', 'selfplay', '.tensor');
const TAG = '@R ';

interface MatchResult { win: boolean; margin: number; seq: number[]; }

/** Play the in-training model (seat p1) vs the opponent (seat p2), headless, and
 *  return the outcome plus the plan the tensor seat sampled — the feedback the
 *  generator-enhanced loop reinforces. */
function playMatch(mps: MPS, seed: number, maxSeconds: number): MatchResult {
  const { game, world, level } = makeSkirmishGame(seed);
  const tensorMacro = new TensorMacro(serializeMPS(mps));
  const profiles: Record<PlayerId, string> = { p1: 'tensor', p2: OPPONENT };
  const controllers = PLAYER_IDS.map((playerId, seat) => new AIController({
    game, world, playerId,
    profile: aiProfile(profiles[playerId]),
    seed: (seed ^ (seat + 1) * 0x9e3779b9) >>> 0,
    macro: playerId === 'p1' ? tensorMacro : undefined,
    submit: command => applyGameCommand(game, playerId, command),
  }));

  const maxTicks = Math.round(Math.min(maxSeconds, level.hardTimer) / TICK_SECONDS);
  for (let tick = 0; tick < maxTicks; tick++) {
    for (const controller of controllers) controller.tick(TICK_SECONDS);
    game.update(TICK_SECONDS);
    if (game.eliminated.size) break;
  }
  const winner = skirmishWinner(game);
  const score = (id: PlayerId): number => {
    let army = 0, buildings = 0;
    for (const unit of game.units) if (!unit.dead && unit.owner === id && unit.dmg > 0) army++;
    for (const b of game.buildings) if (!b.removed && b.owner === id) buildings++;
    const coin = game.playerStores.get(id)?.stock?.coin ?? 0;
    return army * 2 + buildings + coin * 0.05;
  };
  const margin = score('p1') - score('p2') + (winner === 'p1' ? 1000 : winner === 'p2' ? -1000 : 0);
  return { win: winner === 'p1', margin, seq: tensorMacro.sampledSeq ?? [] };
}

// ---- parallel match batch (fan seeds across cores) ----
function playBatch(mps: MPS, seeds: number[], maxSeconds: number, workers: number): Promise<MatchResult[]> {
  if (!seeds.length) return Promise.resolve([]);
  mkdirSync(TMP, { recursive: true });
  const modelPath = join(TMP, 'model.json');
  writeFileSync(modelPath, JSON.stringify(serializeMPS(mps)));
  const n = Math.max(1, Math.min(workers, seeds.length));
  const shards: number[][] = Array.from({ length: n }, () => []);
  seeds.forEach((seed, i) => shards[i % n].push(seed));
  const selfPath = fileURLToPath(import.meta.url);
  const tsxBin = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
  const results: MatchResult[] = [];
  return Promise.all(shards.map((shard, idx) => new Promise<void>((resolve, reject) => {
    const shardFile = join(TMP, `seeds-${idx}.json`);
    writeFileSync(shardFile, JSON.stringify(shard));
    const child = spawn(tsxBin, [selfPath, '--matchshard', modelPath, shardFile, String(maxSeconds)], { stdio: ['ignore', 'pipe', 'inherit'] });
    createInterface({ input: child.stdout! }).on('line', line => {
      if (line.startsWith(TAG)) results.push(JSON.parse(line.slice(TAG.length)) as MatchResult);
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${idx} exited ${code}`)));
  }))).then(() => results);
}

function runMatchShard(modelPath: string, shardFile: string, maxSeconds: number): void {
  const mps = deserializeMPS(JSON.parse(readFileSync(modelPath, 'utf8')) as SerializedMPS);
  const seeds = JSON.parse(readFileSync(shardFile, 'utf8')) as number[];
  for (const seed of seeds) process.stdout.write(TAG + JSON.stringify(playMatch(mps, seed, maxSeconds)) + '\n');
}

async function evaluate(mps: MPS, seeds: number[], maxSeconds: number, workers: number): Promise<{ winRate: number; wins: number }> {
  const results = await playBatch(mps, seeds, maxSeconds, workers);
  const wins = results.filter(r => r.win).length;
  return { winRate: wins / seeds.length, wins };
}

/** The generator-enhanced self-play refinement. */
async function train(generations: number, gamesPerGen: number, workers: number): Promise<{ mps: MPS; curve: number[] }> {
  const mps = existsSync(MODEL_PATH) ? loadModelMPS() : pretrain();
  const curve: number[] = [];
  const rng = new Rng(0xC0FFEE);
  const experts = expertPlans();
  for (let gen = 0; gen < generations; gen++) {
    // training seeds live far from the held-out eval block (9000..) so eval stays honest
    const seeds = Array.from({ length: gamesPerGen }, () => 100000 + rng.int(1 << 29));
    const results = await playBatch(mps, seeds, TRAIN_SECONDS, workers);
    // at the short training cap games rarely reach an elimination, so PROGRESS is
    // read from the dense reward: the share of games the tensor seat leads on the
    // economy/army margin, and the mean margin itself. This is what should climb.
    const leadFrac = results.filter(r => r.margin > 0).length / Math.max(1, results.length);
    const meanMargin = results.reduce((s, r) => s + r.margin, 0) / Math.max(1, results.length);
    curve.push(Math.round(leadFrac * 1000) / 1000);
    // elite = the plans that won outright, else the top by margin so the model
    // still gets a gradient toward its best games (reward-weighted CEM / TN-GEO)
    let elite = results.filter(r => r.win && r.seq.length).map(r => r.seq);
    if (elite.length < Math.max(3, gamesPerGen * 0.2)) {
      elite = [...results].filter(r => r.seq.length).sort((a, b) => b.margin - a.margin)
        .slice(0, Math.max(3, Math.round(gamesPerGen * 0.3))).map(r => r.seq);
    }
    // keep a light imitation anchor in the batch so refinement can't collapse
    // onto one degenerate line and forget the sound opening structure
    const batch = [...elite, ...experts];
    for (let step = 0; step < 6; step++) fitStep(mps, batch, 0.05);
    process.stdout.write(`  gen ${String(gen + 1).padStart(2)}/${generations}: lead ${(leadFrac * 100).toFixed(0)}% · mean margin ${meanMargin.toFixed(1)}  (elite ${elite.length}/${results.length})\n`);
  }
  return { mps, curve };
}

function actionName(idx: number): string {
  const a = ACTIONS[idx];
  return a.kind === 'build' ? `build:${a.key}` : a.kind === 'train' ? `train:${a.unit}` : 'econ';
}

// ---- CLI ----
async function main(): Promise<void> {
  const workers = availableParallelism();
  const cmd = process.argv[2] ?? 'eval';

  if (cmd === 'train') {
    const generations = Number(process.argv[3] ?? 10);
    const gamesPerGen = Number(process.argv[4] ?? 20);
    process.stdout.write(`TN-GEO refinement: ${generations} generations × ${gamesPerGen} games vs ${OPPONENT} · ${workers} workers\n`);
    const t0 = Date.now();
    const { mps, curve } = await train(generations, gamesPerGen, workers);
    const evalN = 24;
    const seeds = Array.from({ length: evalN }, (_, i) => 9000 + i); // held out from training seeds
    // honest metric: decisive games (25-min horizon), disjoint from training seeds
    const { winRate, wins } = await evaluate(mps, seeds, EVAL_SECONDS, workers);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\nheld-out win rate vs Godlike (${evalN} seeds, ${EVAL_SECONDS / 60}min): ${(winRate * 100).toFixed(1)}%  (${wins}/${evalN})  [${secs}s]\n`);
    writeModel(mps, { generatedAt: new Date().toISOString(), method: 'selfplay-generator-enhanced', winRateVsGodlike: winRate, generations, gamesPerGen, curve });
    const example = playMatch(mps, 9999, TRAIN_SECONDS).seq.map(actionName);
    process.stdout.write(`example sampled opening: ${example.slice(0, 12).join(' → ')} …\n`);
  } else if (cmd === 'eval') {
    const n = Number(process.argv[3] ?? 24);
    const seeds = Array.from({ length: n }, (_, i) => 9000 + i);
    const t0 = Date.now();
    const { winRate, wins } = await evaluate(loadModelMPS(), seeds, EVAL_SECONDS, workers);
    process.stdout.write(`committed model win rate vs Godlike (${n} seeds, ${EVAL_SECONDS / 60}min): ${(winRate * 100).toFixed(1)}%  (${wins}/${n})  [${((Date.now() - t0) / 1000).toFixed(0)}s]\n`);
  } else {
    process.stderr.write(`unknown command '${cmd}' — use train | eval (prior via tools/selfplay/tensorModel.ts)\n`);
    process.exit(1);
  }
}

const shardFlag = process.argv.indexOf('--matchshard');
if (shardFlag >= 0) {
  runMatchShard(process.argv[shardFlag + 1], process.argv[shardFlag + 2], Number(process.argv[shardFlag + 3]));
} else {
  main().catch(err => { console.error(err); process.exit(1); });
}
