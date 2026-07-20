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
 */

/** One core A⁽ᵗ⁾ indexed [left bond i][physical action a][right bond j]. */
export type Core = number[][][];

export interface MPS {
  /** Number of decision slots. */
  L: number;
  /** Physical dimension = size of the action vocabulary. */
  d: number;
  /** Bond dimensions, length L+1; bond[0] = bond[L] = 1 (open boundaries). */
  bond: number[];
  /** One core per slot; cores[t] has shape bond[t] × d × bond[t+1]. */
  cores: Core[];
}

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
  const bond = Array.from({ length: L + 1 }, (_, t) => (t === 0 || t === L ? 1 : chi));
  const cores: Core[] = [];
  for (let t = 0; t < L; t++) {
    const li = bond[t], rj = bond[t + 1];
    cores.push(makeCore(li, d, rj, (i, _a, j) => 0.1 + 0.05 * rng.next() + (i === j ? 0.3 : 0)));
  }
  const mps: MPS = { L, d, bond, cores };
  normalize(mps);
  return mps;
}

/** Deep clone — training works on copies so a step can be accepted or rejected. */
export function cloneMPS(mps: MPS): MPS {
  return { L: mps.L, d: mps.d, bond: mps.bond.slice(), cores: mps.cores.map(c => c.map(row => row.map(col => col.slice()))) };
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

/** Right Born environments R[t] (bond[t] × bond[t]); R[0][0][0] = Z = ⟨ψ|ψ⟩. */
function rightEnvs(mps: MPS): number[][][] {
  const R: number[][][] = new Array(mps.L + 1);
  R[mps.L] = [[1]];
  for (let t = mps.L - 1; t >= 0; t--) {
    const A = mps.cores[t], li = mps.bond[t], rj = mps.bond[t + 1], Rn = R[t + 1];
    const cur = zeros2(li, li);
    for (let i = 0; i < li; i++) for (let ip = 0; ip < li; ip++) {
      let acc = 0;
      for (let a = 0; a < mps.d; a++) {
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
      for (let a = 0; a < mps.d; a++) {
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
  const R = rightEnvs(mps);
  const seq: number[] = [];
  let u = [1]; // prefix amplitude vector, dim bond[t]
  for (let t = 0; t < mps.L; t++) {
    const A = mps.cores[t], li = mps.bond[t], rj = mps.bond[t + 1], Rn = R[t + 1];
    const ws: number[][] = [];
    const weights = zeros(mps.d);
    for (let a = 0; a < mps.d; a++) {
      const w = zeros(rj);
      for (let i = 0; i < li; i++) {
        const ui = u[i]; if (ui === 0) continue;
        const row = A[i][a];
        for (let j = 0; j < rj; j++) w[j] += ui * row[j];
      }
      let acc = 0;
      for (let j = 0; j < rj; j++) { const Rj = Rn[j]; const wj = w[j]; for (let jp = 0; jp < rj; jp++) acc += wj * Rj[jp] * w[jp]; }
      ws.push(w);
      weights[a] = acc > 0 ? acc : 0; // R is a Gram matrix ⇒ acc ≥ 0 up to rounding
    }
    let total = 0; for (let a = 0; a < mps.d; a++) total += weights[a];
    let pick = mps.d - 1;
    if (total > 0) {
      let roll = rng.next() * total;
      for (let a = 0; a < mps.d; a++) { roll -= weights[a]; if (roll <= 0) { pick = a; break; } }
    } else {
      pick = rng.int(mps.d);
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
  const out = zeros(mps.d);
  for (let a = 0; a < mps.d; a++) {
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
  const grad: Core[] = mps.cores.map((c, t) => makeCore(mps.bond[t], mps.d, mps.bond[t + 1], () => 0));
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
    for (let i = 0; i < li; i++) for (let a = 0; a < mps.d; a++) {
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
    for (let i = 0; i < mps.bond[t]; i++) for (let a = 0; a < mps.d; a++) {
      const cj = c[i][a], gj = g[i][a];
      for (let j = 0; j < mps.bond[t + 1]; j++) cj[j] += lr * gj[j];
    }
  }
  normalize(mps);
  return meanLL;
}

export interface SerializedMPS { L: number; d: number; bond: number[]; cores: number[][]; }

/** Flatten to JSON-friendly arrays (one flat number[] per core, row-major). */
export function serializeMPS(mps: MPS): SerializedMPS {
  const cores = mps.cores.map((core, t) => {
    const li = mps.bond[t], rj = mps.bond[t + 1], flat: number[] = [];
    for (let i = 0; i < li; i++) for (let a = 0; a < mps.d; a++) for (let j = 0; j < rj; j++) flat.push(core[i][a][j]);
    return flat;
  });
  return { L: mps.L, d: mps.d, bond: mps.bond.slice(), cores };
}

export function deserializeMPS(s: SerializedMPS): MPS {
  const cores: Core[] = s.cores.map((flat, t) => {
    const li = s.bond[t], rj = s.bond[t + 1];
    let k = 0;
    return makeCore(li, s.d, rj, () => flat[k++]);
  });
  return { L: s.L, d: s.d, bond: s.bond.slice(), cores };
}
