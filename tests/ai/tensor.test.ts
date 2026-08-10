import { describe, it, expect } from 'vitest';
import { Rng } from '../../src/engine/rng';
import {
  randomMPS, randomMPSWithDims, cloneMPS, amplitude, partition, normalize, logProb,
  sample, sampleConditional, marginal, meanLogLikGrad, fitStep, serializeMPS,
  deserializeMPS, type Evidence, type MPS,
} from '../../src/ai/tensor/mps';

/** Enumerate every sequence over a per-slot alphabet (a number = uniform). */
function allSeqs(L: number, d: number | number[]): number[][] {
  const dims = typeof d === 'number' ? new Array(L).fill(d) : d;
  let acc: number[][] = [[]];
  for (let t = 0; t < L; t++) {
    const next: number[][] = [];
    for (const s of acc) for (let a = 0; a < dims[t]; a++) next.push([...s, a]);
    acc = next;
  }
  return acc;
}

/** Ground truth: enumerate P(seq | evidence) by brute force over the model. */
function exactConditional(mps: MPS, evidence: Evidence): Map<string, number> {
  const out = new Map<string, number>();
  let total = 0;
  for (const seq of allSeqs(mps.L, mps.dims)) {
    if (seq.some((a, t) => evidence[t] != null && evidence[t] !== a)) continue;
    const p = amplitude(mps, seq) ** 2;
    out.set(seq.join(','), p);
    total += p;
  }
  for (const [key, p] of out) out.set(key, p / total);
  return out;
}

describe('MPS Born machine', () => {
  it('normalises to Z = 1 and defines a proper distribution', () => {
    const mps = randomMPS(4, 3, 4, new Rng(11));
    normalize(mps);
    expect(partition(mps)).toBeCloseTo(1, 6);
    // P(a) = ψ(a)²/Z sums to exactly 1 over the whole alphabet
    const Z = partition(mps);
    let total = 0;
    for (const seq of allSeqs(4, 3)) total += amplitude(mps, seq) ** 2 / Z;
    expect(total).toBeCloseTo(1, 6);
  });

  it('logProb matches enumerated probabilities', () => {
    const mps = randomMPS(3, 2, 3, new Rng(7));
    for (const seq of allSeqs(3, 2)) {
      const Z = partition(mps);
      const p = amplitude(mps, seq) ** 2 / Z;
      expect(Math.exp(logProb(mps, seq))).toBeCloseTo(p, 9);
    }
  });

  it('ancestral sampling reproduces the exact single-slot marginals', () => {
    const mps = randomMPS(4, 3, 3, new Rng(3));
    const rng = new Rng(999);
    const N = 20000;
    const counts = [0, 0, 0];
    for (let n = 0; n < N; n++) counts[sample(mps, rng)[1]]++; // slot 1
    const exact = marginal(mps, 1);
    for (let a = 0; a < 3; a++) expect(counts[a] / N).toBeCloseTo(exact[a], 1);
  });

  it('is deterministic: same seed → same plan', () => {
    const mps = randomMPS(6, 4, 4, new Rng(5));
    const a = sample(mps, new Rng(42));
    const b = sample(mps, new Rng(42));
    expect(a).toEqual(b);
  });

  it('analytic mean-log-likelihood gradient matches finite differences', () => {
    const mps = randomMPS(3, 3, 2, new Rng(21));
    const batch = [[0, 1, 2], [2, 0, 1], [1, 1, 0], [0, 2, 2]];
    const { grad } = meanLogLikGrad(mps, batch);
    const meanLL = (m: MPS): number => batch.reduce((s, seq) => s + logProb(m, seq), 0) / batch.length;
    const eps = 1e-5;
    let maxErr = 0;
    for (let t = 0; t < mps.L; t++) {
      for (let i = 0; i < mps.bond[t]; i++) for (let a = 0; a < mps.d; a++) for (let j = 0; j < mps.bond[t + 1]; j++) {
        const plus = cloneMPS(mps), minus = cloneMPS(mps);
        plus.cores[t][i][a][j] += eps; minus.cores[t][i][a][j] -= eps;
        const fd = (meanLL(plus) - meanLL(minus)) / (2 * eps);
        maxErr = Math.max(maxErr, Math.abs(fd - grad[t][i][a][j]));
      }
    }
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('fitStep raises the likelihood of the fitted sequences', () => {
    const mps = randomMPS(5, 4, 4, new Rng(2));
    const target = [[0, 1, 2, 3, 0], [0, 1, 2, 3, 1]]; // a coherent "opening" + a variant
    const before = target.reduce((s, seq) => s + logProb(mps, seq), 0);
    for (let step = 0; step < 60; step++) fitStep(mps, target, 0.2);
    const after = target.reduce((s, seq) => s + logProb(mps, seq), 0);
    expect(after).toBeGreaterThan(before);
    // and the model should now sample the fitted opening prefix often
    const rng = new Rng(1);
    let hits = 0;
    for (let n = 0; n < 400; n++) { const s = sample(mps, rng); if (s[0] === 0 && s[1] === 1 && s[2] === 2) hits++; }
    expect(hits).toBeGreaterThan(200);
  });

  it('serialises and deserialises exactly', () => {
    const mps = randomMPS(5, 4, 3, new Rng(8));
    const round = deserializeMPS(serializeMPS(mps));
    expect(round.bond).toEqual(mps.bond);
    for (const seq of [[0, 1, 2, 3, 0], [3, 3, 3, 3, 3]]) {
      expect(amplitude(round, seq)).toBeCloseTo(amplitude(mps, seq), 12);
    }
  });

  it('reads a v1 artifact (no per-slot dims) as a uniform chain', () => {
    const mps = randomMPS(4, 3, 3, new Rng(4));
    const wire = serializeMPS(mps);
    expect(wire.dims).toBeUndefined(); // a uniform chain still serialises as v1
    const round = deserializeMPS({ L: wire.L, d: wire.d, bond: wire.bond, cores: wire.cores });
    expect(round.dims).toEqual([3, 3, 3, 3]);
    expect(sample(round, new Rng(9))).toEqual(sample(mps, new Rng(9)));
  });
});

describe('Conditional MPS (Tensor v2)', () => {
  /** A v2-shaped chain: clamped context slots, then a sampled action bundle. */
  const dims = [4, 3, 2, 5];

  it('normalises and stays a proper distribution with per-slot alphabets', () => {
    const mps = randomMPSWithDims(dims, 4, new Rng(13));
    expect(partition(mps)).toBeCloseTo(1, 6);
    let total = 0;
    for (const seq of allSeqs(dims.length, dims)) total += amplitude(mps, seq) ** 2;
    expect(total).toBeCloseTo(1, 6);
  });

  it('samples the exact conditional when the evidence is a clamped prefix', () => {
    const mps = randomMPSWithDims(dims, 4, new Rng(17));
    for (let step = 0; step < 40; step++) fitStep(mps, [[1, 2, 0, 3], [1, 2, 1, 4], [0, 0, 0, 0]], 0.25);
    const evidence: Evidence = [1, 2, null, null];
    const exact = exactConditional(mps, evidence);
    const rng = new Rng(77);
    const counts = new Map<string, number>();
    const N = 20000;
    for (let n = 0; n < N; n++) {
      const seq = sampleConditional(mps, evidence, rng);
      expect(seq.slice(0, 2)).toEqual([1, 2]); // the clamp is honoured exactly
      counts.set(seq.join(','), (counts.get(seq.join(',')) ?? 0) + 1);
    }
    for (const [key, p] of exact) expect((counts.get(key) ?? 0) / N).toBeCloseTo(p, 1);
  });

  it('conditions on evidence that sits AFTER a free slot, not just on a prefix', () => {
    const mps = randomMPSWithDims(dims, 4, new Rng(23));
    for (let step = 0; step < 40; step++) fitStep(mps, [[0, 1, 1, 2], [3, 2, 0, 4], [1, 0, 1, 2]], 0.25);
    const evidence: Evidence = [null, null, 1, 2];
    const exact = exactConditional(mps, evidence);
    const rng = new Rng(5);
    const counts = new Map<string, number>();
    const N = 20000;
    for (let n = 0; n < N; n++) {
      const seq = sampleConditional(mps, evidence, rng);
      expect([seq[2], seq[3]]).toEqual([1, 2]);
      counts.set(seq.join(','), (counts.get(seq.join(',')) ?? 0) + 1);
    }
    for (const [key, p] of exact) expect((counts.get(key) ?? 0) / N).toBeCloseTo(p, 1);
  });

  it('different evidence draws a different bundle — the adaptation property', () => {
    const mps = randomMPSWithDims(dims, 4, new Rng(31));
    // two contexts, each correlated with its own strategic answer
    const batch = [[0, 0, 0, 0], [0, 0, 0, 1], [3, 2, 1, 4], [3, 2, 1, 3]];
    for (let step = 0; step < 120; step++) fitStep(mps, batch, 0.3);
    const draw = (context: number[]): number[] => {
      const rng = new Rng(101);
      const tally = [0, 0, 0, 0, 0];
      for (let n = 0; n < 400; n++) tally[sampleConditional(mps, [...context, null, null], rng)[3]]++;
      return tally;
    };
    const quiet = draw([0, 0]), pressed = draw([3, 2]);
    expect(quiet[0] + quiet[1]).toBeGreaterThan(320);
    expect(pressed[3] + pressed[4]).toBeGreaterThan(320);
  });

  it('is deterministic and unchanged by a serialization round trip', () => {
    const mps = randomMPSWithDims(dims, 3, new Rng(41));
    const evidence: Evidence = [2, null, 1, null];
    const first = sampleConditional(mps, evidence, new Rng(64));
    expect(sampleConditional(mps, evidence, new Rng(64))).toEqual(first);
    const wire = serializeMPS(mps);
    expect(wire.dims).toEqual(dims); // a mixed chain must carry its alphabet
    const round = deserializeMPS(wire);
    expect(round.dims).toEqual(dims);
    expect(sampleConditional(round, evidence, new Rng(64))).toEqual(first);
  });

  it('falls back to a legal draw when the evidence has no support at all', () => {
    const mps = randomMPSWithDims([2, 2], 2, new Rng(3));
    for (const core of mps.cores) for (const row of core) row[1] = row[1].map(() => 0); // action 1 impossible
    const seq = sampleConditional(mps, [1, null], new Rng(8));
    expect(seq[0]).toBe(1);
    expect(seq[1]).toBeGreaterThanOrEqual(0);
    expect(seq[1]).toBeLessThan(2);
  });
});
