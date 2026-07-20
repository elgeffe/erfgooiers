import { describe, it, expect } from 'vitest';
import { Rng } from '../../src/engine/rng';
import {
  randomMPS, cloneMPS, amplitude, partition, normalize, logProb, sample, marginal,
  meanLogLikGrad, fitStep, serializeMPS, deserializeMPS, type MPS,
} from '../../src/ai/tensor/mps';

/** Enumerate every length-L sequence over an alphabet of size d. */
function allSeqs(L: number, d: number): number[][] {
  let acc: number[][] = [[]];
  for (let t = 0; t < L; t++) {
    const next: number[][] = [];
    for (const s of acc) for (let a = 0; a < d; a++) next.push([...s, a]);
    acc = next;
  }
  return acc;
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
});
