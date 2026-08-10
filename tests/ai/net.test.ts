import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/engine/rng';
import {
  adamState, adamStep, backward, cloneMLP, deserializeMLP, forward, forwardAll,
  randomMLP, serializeMLP, sigmoid, zeroGrad, type MLP,
} from '../../src/ai/learn/net';
import { FEATURE_COUNT, FEATURE_NAMES } from '../../src/ai/learn/features';

/** Binary cross-entropy on a linear output squashed by a sigmoid — exactly the
 *  value head's loss, so the gradient check pins the real training path. */
function bce(net: MLP, x: number[], target: number): number {
  const p = sigmoid(forward(net, x)[0]);
  return -(target * Math.log(p + 1e-12) + (1 - target) * Math.log(1 - p + 1e-12));
}

describe('plain-TS MLP', () => {
  it('backpropagates the value-head loss to within finite-difference error', () => {
    const rng = new Rng(11);
    const net = randomMLP([5, 6, 1], rng);
    const x = [0.3, -0.7, 0.15, 0.9, -0.2];
    const target = 1;

    const acts = forwardAll(net, x);
    const p = sigmoid(acts[acts.length - 1][0]);
    const grad = zeroGrad(net);
    backward(net, acts, [p - target], grad); // d(BCE)/d(logit) = p - y

    const eps = 1e-6;
    let worst = 0;
    for (let l = 0; l < net.layers.length; l++) {
      for (let o = 0; o < net.layers[l].b.length; o++) {
        for (let i = 0; i < net.layers[l].w[o].length; i++) {
          const plus = cloneMLP(net), minus = cloneMLP(net);
          plus.layers[l].w[o][i] += eps; minus.layers[l].w[o][i] -= eps;
          const fd = (bce(plus, x, target) - bce(minus, x, target)) / (2 * eps);
          worst = Math.max(worst, Math.abs(fd - grad[l].w[o][i]));
        }
        const plusB = cloneMLP(net), minusB = cloneMLP(net);
        plusB.layers[l].b[o] += eps; minusB.layers[l].b[o] -= eps;
        const fdB = (bce(plusB, x, target) - bce(minusB, x, target)) / (2 * eps);
        worst = Math.max(worst, Math.abs(fdB - grad[l].b[o]));
      }
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('learns a function a linear model cannot — XOR, the capacity the MPS lacks', () => {
    const rng = new Rng(3);
    const net = randomMLP([2, 8, 1], rng);
    const state = adamState(net);
    const data: [number[], number][] = [
      [[0, 0], 0], [[0, 1], 1], [[1, 0], 1], [[1, 1], 0],
    ];
    for (let epoch = 0; epoch < 900; epoch++) {
      const grad = zeroGrad(net);
      for (const [x, y] of data) {
        const acts = forwardAll(net, x);
        backward(net, acts, [sigmoid(acts[acts.length - 1][0]) - y], grad);
      }
      for (const layer of grad) {
        for (const row of layer.w) for (let i = 0; i < row.length; i++) row[i] /= data.length;
        for (let i = 0; i < layer.b.length; i++) layer.b[i] /= data.length;
      }
      adamStep(net, grad, state, 0.05);
    }
    for (const [x, y] of data) {
      expect(Math.round(sigmoid(forward(net, x)[0]))).toBe(y);
    }
  });

  it('is deterministic from its seed and survives a serialization round trip', () => {
    const a = randomMLP([4, 5, 2], new Rng(7));
    const b = randomMLP([4, 5, 2], new Rng(7));
    const x = [0.1, 0.2, 0.3, 0.4];
    expect(forward(b, x)).toEqual(forward(a, x));

    const round = deserializeMLP(serializeMLP(a));
    expect(forward(round, x)).toEqual(forward(a, x));
    expect(serializeMLP(round)).toEqual(serializeMLP(a));
  });

  it('exposes one named feature per input, so a trained net stays interpretable', () => {
    expect(FEATURE_NAMES).toHaveLength(FEATURE_COUNT);
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_COUNT);
  });
});
