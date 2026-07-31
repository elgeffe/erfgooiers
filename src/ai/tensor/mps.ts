import type { Rng } from '../../engine/rng';

/**
 * A Born-machine Matrix Product State (MPS / "tensor train") over a fixed-length
 * sequence of discrete choices — the generative tensor network the skirmish
 * research spike uses to represent a distribution over whole build-order/army
 * plans (see docs/tensor-strategy-poc.md).
 *
 * Why a tensor network here at all: the "how good is this plan" tensor is
 * indexed by (action at slot 0, action at slot 1, ..., action at slot L-1) and
 * so has d^L entries — the combinatorial explosion the reality-check doc
 * (docs/tensor-networks-for-logistics.md) says genuinely lives in *coupled
 * long-horizon decisions* (as opposed to logistics, where it does not). The MPS
 * factors that exponential tensor into L small cores of bond dimension χ,
 * capturing correlations between decisions (a smithy wants an iron mine soon)
 * without ever materialising the full tensor.
 *
 * Born machine: it stores an amplitude ψ(a) = A⁽⁰⁾_{a₀} A⁽¹⁾_{a₁} … A⁽ᴸ⁻¹⁾_{a_{L-1}}
 * (a product of per-slot matrices) and defines the probability of a plan as
 * P(a) = ψ(a)² / Z, with Z = Σ_a ψ(a)² = ⟨ψ|ψ⟩. This is exactly the model class
 * of Han et al. 2018 and the TN-GEO optimiser cited in the reality-check doc.
 *
 * Everything here is plain real-number linear algebra on small nested arrays:
 * cores are tiny (χ ≈ 4, d ≈ 24), so clarity beats micro-optimisation. Sampling
 * is EXACT (ancestral, via cached right environments) and the training gradient
 * is the analytic mean-log-likelihood gradient, pinned by a finite-difference
 * test so a derivation slip can't hide.
 *
 * Tensor v2 adds two things on top, both from docs/tensor-retrain-plan.md:
 *   • PER-SLOT physical dimensions, so one chain can carry discretized context
 *     slots (four buckets of economy) and action slots (fourteen intents) side
 *     by side instead of padding everything to one alphabet;
 *   • CONDITIONAL sampling with clamped slots — fix the context to what the
 *     match actually looks like and draw only the strategic suffix. This is
 *     what makes the policy adaptive rather than a one-shot opening generator.
 * v1 models stay readable: a serialized model without `dims` is a uniform-`d`
 * chain, and every v1 entry point behaves exactly as before.
 */

/** One core A⁽ᵗ⁾ indexed [left bond i][physical action a][right bond j]. */
export type Core = number[][][];

export interface MPS {
  /** Number of decision slots. */
  L: number;
  /** Largest physical dimension — the uniform alphabet size for a v1 chain. */
  d: number;
  /** Physical dimension of each slot (length L); uniform `d` for a v1 chain. */
  dims: number[];
  /** Bond dimensions, length L+1; bond[0] = bond[L] = 1 (open boundaries). */
  bond: number[];
  /** One core per slot; cores[t] has shape bond[t] × dims[t] × bond[t+1]. */
  cores: Core[];
}

/** Evidence for conditional sampling: a value clamps its slot, `null` leaves it
 *  free to be drawn. Shorter arrays leave the remaining slots free. */
export type Evidence = readonly (number | null)[];

function zeros(n: number): number[] { return new Array(n).fill(0); }
function zeros2(a: number, b: number): number[][] { return Array.from({ length: a }, () => zeros(b)); }

/** A fresh core of the given shape filled by `fill(i,a,j)`. */
function makeCore(li: number, d: number, rj: number, fill: (i: number, a: number, j: number) => number): Core {
  return Array.from({ length: li }, (_, i) => Array.from({ length: d }, (_, a) => Array.from({ length: rj }, (_, j) => fill(i, a, j))));
}

/**
 * A random MPS with the requested shape. Cores are seeded small and positive
 * with a slightly stronger diagonal bond channel, so an untrained model samples
 * a broad-but-not-degenerate distribution and training has signal to sharpen.
 */
export function randomMPS(L: number, d: number, chi: number, rng: Rng): MPS {
  return randomMPSWithDims(new Array(L).fill(d), chi, rng);
}

/** As {@link randomMPS}, but with a per-slot alphabet — the v2 shape, where
 *  context slots and action slots have different physical dimensions. */
export function randomMPSWithDims(dims: number[], chi: number, rng: Rng): MPS {
  const L = dims.length;
  const bond = Array.from({ length: L + 1 }, (_, t) => (t === 0 || t === L ? 1 : chi));
  const cores: Core[] = [];
  for (let t = 0; t < L; t++) {
    const li = bond[t], rj = bond[t + 1];
    cores.push(makeCore(li, dims[t], rj, (i, _a, j) => 0.1 + 0.05 * rng.next() + (i === j ? 0.3 : 0)));
  }
  const mps: MPS = { L, d: Math.max(...dims), dims: dims.slice(), bond, cores };
  normalize(mps);
  return mps;
}

/** Deep clone — training works on copies so a step can be accepted or rejected. */
export function cloneMPS(mps: MPS): MPS {
  return {
    L: mps.L, d: mps.d, dims: mps.dims.slice(), bond: mps.bond.slice(),
    cores: mps.cores.map(c => c.map(row => row.map(col => col.slice()))),
  };
}

/** Prefix amplitude vectors P[t] (dim bond[t]) for one sequence; P[L][0] = ψ(a). */
function prefixVecs(mps: MPS, seq: number[]): number[][] {
  const P: number[][] = [[1]];
  for (let t = 0; t < mps.L; t++) {
    const A = mps.cores[t], a = seq[t], prev = P[t];
    const next = zeros(mps.bond[t + 1]);
    for (let i = 0; i < mps.bond[t]; i++) {
      const w = prev[i]; if (w === 0) continue;
      const row = A[i][a];
      for (let j = 0; j < mps.bond[t + 1]; j++) next[j] += w * row[j];
    }
    P.push(next);
  }
  return P;
}

/** Suffix amplitude vectors S[t] (dim bond[t]); S[t][i] completes ψ from slot t. */
function suffixVecs(mps: MPS, seq: number[]): number[][] {
  const S: number[][] = new Array(mps.L + 1);
  S[mps.L] = [1];
  for (let t = mps.L - 1; t >= 0; t--) {
    const A = mps.cores[t], a = seq[t], nxt = S[t + 1];
    const cur = zeros(mps.bond[t]);
    for (let i = 0; i < mps.bond[t]; i++) {
      const row = A[i][a]; let acc = 0;
      for (let j = 0; j < mps.bond[t + 1]; j++) acc += row[j] * nxt[j];
      cur[i] = acc;
    }
    S[t] = cur;
  }
  return S;
}

/** Raw amplitude ψ(a) (unnormalised). */
export function amplitude(mps: MPS, seq: number[]): number {
  return prefixVecs(mps, seq)[mps.L][0];
}

/**
 * Right Born environments R[t] (bond[t] × bond[t]); R[0][0][0] = Z = ⟨ψ|ψ⟩.
 *
 * With `evidence`, a clamped slot contributes only its fixed value, so R sums
 * over the completions CONSISTENT WITH THE EVIDENCE and R[0][0][0] becomes the
 * conditional partition function. That is what lets the sampler condition on
 * evidence lying anywhere in the chain, not merely on a clamped prefix.
 */
function rightEnvs(mps: MPS, evidence?: Evidence): number[][][] {
  const R: number[][][] = new Array(mps.L + 1);
  R[mps.L] = [[1]];
  for (let t = mps.L - 1; t >= 0; t--) {
    const A = mps.cores[t], li = mps.bond[t], rj = mps.bond[t + 1], Rn = R[t + 1];
    const clamp = evidence?.[t];
    const from = clamp == null ? 0 : clamp;
    const upto = clamp == null ? mps.dims[t] : clamp + 1;
    const cur = zeros2(li, li);
    for (let i = 0; i < li; i++) for (let ip = 0; ip < li; ip++) {
      let acc = 0;
      for (let a = from; a < upto; a++) {
        const ri = A[i][a], rip = A[ip][a];
        for (let j = 0; j < rj; j++) {
          const rij = ri[j]; if (rij === 0) continue;
          const Rj = Rn[j];
          for (let jp = 0; jp < rj; jp++) acc += rij * rip[jp] * Rj[jp];
        }
      }
      cur[i][ip] = acc;
    }
    R[t] = cur;
  }
  return R;
}

/** Left Born environments E[t] (bond[t] × bond[t]); E[L][0][0] = Z. */
function leftEnvs(mps: MPS): number[][][] {
  const E: number[][][] = new Array(mps.L + 1);
  E[0] = [[1]];
  for (let t = 0; t < mps.L; t++) {
    const A = mps.cores[t], li = mps.bond[t], rj = mps.bond[t + 1], Ep = E[t];
    const cur = zeros2(rj, rj);
    for (let j = 0; j < rj; j++) for (let jp = 0; jp < rj; jp++) {
      let acc = 0;
      for (let a = 0; a < mps.dims[t]; a++) {
        for (let i = 0; i < li; i++) {
          const aij = A[i][a][j]; if (aij === 0) continue;
          const Ei = Ep[i];
          for (let ip = 0; ip < li; ip++) acc += Ei[ip] * aij * A[ip][a][jp];
        }
      }
      cur[j][jp] = acc;
    }
    E[t + 1] = cur;
  }
  return E;
}

/** The partition function Z = Σ_a ψ(a)². */
export function partition(mps: MPS): number {
  return rightEnvs(mps)[0][0][0];
}

/** Rescale every core so Z = 1. Leaves the distribution P(a) unchanged (a pure
 *  gauge on the amplitude) but keeps the numbers numerically tame. */
export function normalize(mps: MPS): void {
  const Z = partition(mps);
  if (!(Z > 0) || !Number.isFinite(Z)) return;
  const scale = Math.pow(Z, -1 / (2 * mps.L));
  for (const core of mps.cores) for (const row of core) for (const col of row) {
    for (let j = 0; j < col.length; j++) col[j] *= scale;
  }
}

/** log P(a) = 2·log|ψ(a)| − log Z. */
export function logProb(mps: MPS, seq: number[]): number {
  const amp = Math.abs(amplitude(mps, seq));
  const Z = partition(mps);
  return 2 * Math.log(amp + 1e-300) - Math.log(Z + 1e-300);
}

/**
 * Exact ancestral sample of one plan. Walks slots left→right; the conditional
 * P(aₜ | a_<t) ∝ wᵀ R[t+1] w with w = (prefix)·A⁽ᵗ⁾_{aₜ} is exact because the
 * right environment sums over every completion. Uses only `rng.next()`, so the
 * draw is reproducible from the seat's seeded stream (replay-safe).
 */
export function sample(mps: MPS, rng: Rng): number[] {
  return sampleConditional(mps, [], rng);
}

/**
 * Exact ancestral sample with slots CLAMPED to `evidence` — the v2 draw. The
 * clamped slots are the discretized observation (phase context, army reads,
 * scouting memory); the free slots are the strategic bundle the policy will
 * execute. Because the right environments are built under the same evidence,
 * the free slots are drawn from the true conditional P(free | evidence), so the
 * same model answers differently as the match changes. Still `rng.next()` only,
 * so the draw stays reproducible from the seat's seeded stream.
 */
export function sampleConditional(mps: MPS, evidence: Evidence, rng: Rng): number[] {
  const R = rightEnvs(mps, evidence);
  const seq: number[] = [];
  let u = [1]; // prefix amplitude vector, dim bond[t]
  for (let t = 0; t < mps.L; t++) {
    const A = mps.cores[t], li = mps.bond[t], rj = mps.bond[t + 1], Rn = R[t + 1];
    const dim = mps.dims[t];
    const clamp = evidence[t];
    // the amplitude vector each candidate action would leave behind
    const contract = (a: number): number[] => {
      const w = zeros(rj);
      for (let i = 0; i < li; i++) {
        const ui = u[i]; if (ui === 0) continue;
        const row = A[i][a];
        for (let j = 0; j < rj; j++) w[j] += ui * row[j];
      }
      return w;
    };
    if (clamp != null) { seq.push(clamp); u = contract(clamp); continue; }

    const ws: number[][] = [];
    const weights = zeros(dim);
    for (let a = 0; a < dim; a++) {
      const w = contract(a);
      let acc = 0;
      for (let j = 0; j < rj; j++) { const Rj = Rn[j]; const wj = w[j]; for (let jp = 0; jp < rj; jp++) acc += wj * Rj[jp] * w[jp]; }
      ws.push(w);
      weights[a] = acc > 0 ? acc : 0; // R is a Gram matrix ⇒ acc ≥ 0 up to rounding
    }
    let total = 0; for (let a = 0; a < dim; a++) total += weights[a];
    let pick = dim - 1;
    if (total > 0) {
      let roll = rng.next() * total;
      for (let a = 0; a < dim; a++) { roll -= weights[a]; if (roll <= 0) { pick = a; break; } }
    } else {
      pick = rng.int(dim);
    }
    seq.push(pick);
    u = ws[pick];
  }
  return seq;
}

/** Single-slot marginal distribution P(aₜ = ·) — used only by tests to check
 *  the sampler against ground truth. O(d · L · χ³). */
export function marginal(mps: MPS, slot: number): number[] {
  const E = leftEnvs(mps), R = rightEnvs(mps);
  const li = mps.bond[slot], rj = mps.bond[slot + 1], A = mps.cores[slot];
  const El = E[slot], Rn = R[slot + 1];
  const Z = partition(mps);
  const out = zeros(mps.dims[slot]);
  for (let a = 0; a < mps.dims[slot]; a++) {
    let acc = 0;
    for (let i = 0; i < li; i++) for (let ip = 0; ip < li; ip++) {
      const e = El[i][ip]; if (e === 0) continue;
      for (let j = 0; j < rj; j++) { const aij = A[i][a][j]; if (aij === 0) continue; for (let jp = 0; jp < rj; jp++) acc += e * aij * A[ip][a][jp] * Rn[j][jp]; }
    }
    out[a] = acc / (Z + 1e-300);
  }
  return out;
}

export interface GradResult { grad: Core[]; meanLL: number; }

/**
 * Gradient of the mean log-likelihood (1/N)·Σ log P(aⁿ) over a batch, w.r.t.
 * every core entry. Two analytic pieces:
 *   • data term  +(2/ψ)·prefix_i·suffix_j at the chosen action (per sample), and
 *   • the shared normaliser −(2/Z)·(E[t] · A⁽ᵗ⁾ · R[t+1])  from d(log Z).
 * Both are checked against finite differences in the test suite.
 */
export function meanLogLikGrad(mps: MPS, batch: number[][]): GradResult {
  const grad: Core[] = mps.cores.map((_c, t) => makeCore(mps.bond[t], mps.dims[t], mps.bond[t + 1], () => 0));
  const E = leftEnvs(mps), R = rightEnvs(mps);
  const Z = partition(mps);
  const N = batch.length;
  let meanLL = 0;

  for (const seq of batch) {
    const P = prefixVecs(mps, seq), S = suffixVecs(mps, seq);
    const amp = P[mps.L][0];
    meanLL += 2 * Math.log(Math.abs(amp) + 1e-300);
    const coef = (2 / (amp + (amp >= 0 ? 1e-300 : -1e-300))) / N;
    for (let t = 0; t < mps.L; t++) {
      const a = seq[t], gt = grad[t], pre = P[t], suf = S[t + 1];
      for (let i = 0; i < mps.bond[t]; i++) {
        const pi = pre[i]; if (pi === 0) continue;
        const gi = gt[i][a];
        for (let j = 0; j < mps.bond[t + 1]; j++) gi[j] += coef * pi * suf[j];
      }
    }
  }
  meanLL = meanLL / N - Math.log(Z + 1e-300);

  // shared −d(log Z) term, added once (not per-sample)
  const zc = 2 / (Z + 1e-300);
  for (let t = 0; t < mps.L; t++) {
    const A = mps.cores[t], li = mps.bond[t], rj = mps.bond[t + 1], El = E[t], Rn = R[t + 1], gt = grad[t];
    for (let i = 0; i < li; i++) for (let a = 0; a < mps.dims[t]; a++) {
      const gia = gt[i][a];
      for (let j = 0; j < rj; j++) {
        let env = 0;
        for (let ip = 0; ip < li; ip++) {
          const e = El[i][ip]; if (e === 0) continue;
          const rowp = A[ip][a];
          for (let jp = 0; jp < rj; jp++) env += e * rowp[jp] * Rn[jp][j];
        }
        gia[j] -= zc * env;
      }
    }
  }
  return { grad, meanLL };
}

/** One gradient-ascent step on mean log-likelihood over `batch`; renormalises. */
export function fitStep(mps: MPS, batch: number[][], lr: number): number {
  const { grad, meanLL } = meanLogLikGrad(mps, batch);
  for (let t = 0; t < mps.L; t++) {
    const c = mps.cores[t], g = grad[t];
    for (let i = 0; i < mps.bond[t]; i++) for (let a = 0; a < mps.dims[t]; a++) {
      const cj = c[i][a], gj = g[i][a];
      for (let j = 0; j < mps.bond[t + 1]; j++) cj[j] += lr * gj[j];
    }
  }
  normalize(mps);
  return meanLL;
}

/**
 * One TRUST-REGION gradient-ascent step: the gradient is rescaled so the
 * largest single core change is exactly `step`.
 *
 * `fitStep` above takes a fixed multiple of the raw gradient, which is fine for
 * the short v1 chain but stalls badly on the long v2 chains — after
 * normalisation the gradient there is tiny, so a fixed rate crawls and the
 * model settles on one dominant mode instead of learning what the clamped
 * context implies. Rescaling makes progress independent of gradient magnitude,
 * which is what lets a small χ = 4 chain actually represent "this observation
 * implies that strategy". Returns the mean log-likelihood BEFORE the step.
 */
export function fitStepScaled(mps: MPS, batch: number[][], step: number): number {
  const { grad, meanLL } = meanLogLikGrad(mps, batch);
  let peak = 0;
  for (let t = 0; t < mps.L; t++) for (let i = 0; i < mps.bond[t]; i++) for (let a = 0; a < mps.dims[t]; a++) {
    const g = grad[t][i][a];
    for (let j = 0; j < mps.bond[t + 1]; j++) peak = Math.max(peak, Math.abs(g[j]));
  }
  if (!(peak > 0) || !Number.isFinite(peak)) return meanLL;
  const lr = step / peak;
  for (let t = 0; t < mps.L; t++) for (let i = 0; i < mps.bond[t]; i++) for (let a = 0; a < mps.dims[t]; a++) {
    const c = mps.cores[t][i][a], g = grad[t][i][a];
    for (let j = 0; j < mps.bond[t + 1]; j++) c[j] += lr * g[j];
  }
  normalize(mps);
  return meanLL;
}

export interface SerializedMPS {
  L: number;
  d: number;
  /** Per-slot alphabet. Absent in a v1 artifact, which is a uniform-`d` chain. */
  dims?: number[];
  bond: number[];
  cores: number[][];
}

/** Flatten to JSON-friendly arrays (one flat number[] per core, row-major). */
export function serializeMPS(mps: MPS): SerializedMPS {
  const cores = mps.cores.map((core, t) => {
    const li = mps.bond[t], rj = mps.bond[t + 1], flat: number[] = [];
    for (let i = 0; i < li; i++) for (let a = 0; a < mps.dims[t]; a++) for (let j = 0; j < rj; j++) flat.push(core[i][a][j]);
    return flat;
  });
  const uniform = mps.dims.every(dim => dim === mps.d);
  return { L: mps.L, d: mps.d, ...(uniform ? {} : { dims: mps.dims.slice() }), bond: mps.bond.slice(), cores };
}

export function deserializeMPS(s: SerializedMPS): MPS {
  const dims = s.dims ? s.dims.slice() : new Array<number>(s.L).fill(s.d);
  const cores: Core[] = s.cores.map((flat, t) => {
    const li = s.bond[t], rj = s.bond[t + 1];
    let k = 0;
    return makeCore(li, dims[t], rj, () => flat[k++]);
  });
  return { L: s.L, d: Math.max(...dims), dims, bond: s.bond.slice(), cores };
}
