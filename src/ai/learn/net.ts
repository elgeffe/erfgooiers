import type { Rng } from '../../engine/rng';

/**
 * A small dense neural network in plain TypeScript — the function approximator
 * the tensor policy does not have.
 *
 * Why hand-rolled rather than a framework: this has to run in the browser
 * inside a deterministic fixed-step simulation, in a project with two runtime
 * dependencies. A forward pass is a hundred lines of arithmetic, the training
 * loop another hundred, and every number is an ordinary JS double — so a
 * replay re-simulates bit-identically, which no WASM/SIMD backend guarantees.
 *
 * What it is FOR (docs/tensor-retrain-plan.md's successor question): the MPS
 * policy learns from one win/loss bit shared across ~30 decisions per match,
 * which is why 14 generations of self-play moved nothing measurable. A value
 * head V(s) → P(win) gives every decision its own target, turning one bit per
 * match into thirty — and, if it predicts well early, lets training truncate
 * matches instead of playing them out, which is the real throughput unlock.
 *
 * The gradient is checked against finite differences in tests/ai/net.test.ts,
 * the same discipline the MPS gradient is held to.
 */

/** One dense layer: `w[out][in]` and a bias per output. */
export interface Layer {
  w: number[][];
  b: number[];
}

export type Activation = 'tanh' | 'relu' | 'linear';

export interface MLP {
  layers: Layer[];
  /** Activation applied after every layer except the last. */
  hidden: Activation;
  /** Applied to the final layer; 'linear' leaves logits alone. */
  output: Activation;
}

function activate(x: number, kind: Activation): number {
  if (kind === 'tanh') return Math.tanh(x);
  if (kind === 'relu') return x > 0 ? x : 0;
  return x;
}

/** d/dx of the activation, written in terms of its OUTPUT y (cheaper, and what
 *  backprop already has to hand). */
function activateGrad(y: number, kind: Activation): number {
  if (kind === 'tanh') return 1 - y * y;
  if (kind === 'relu') return y > 0 ? 1 : 0;
  return 1;
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * He/Xavier-style initialisation scaled by fan-in, drawn from the seeded stream
 * so a model is reproducible from its seed alone.
 */
export function randomMLP(sizes: number[], rng: Rng, hidden: Activation = 'tanh', output: Activation = 'linear'): MLP {
  const layers: Layer[] = [];
  for (let l = 0; l + 1 < sizes.length; l++) {
    const fanIn = sizes[l], fanOut = sizes[l + 1];
    const scale = Math.sqrt(2 / (fanIn + fanOut));
    layers.push({
      // rng.next() is uniform [0,1); centre it so weights start symmetric
      w: Array.from({ length: fanOut }, () => Array.from({ length: fanIn }, () => (rng.next() * 2 - 1) * scale * 1.7)),
      b: new Array(fanOut).fill(0),
    });
  }
  return { layers, hidden, output };
}

export function cloneMLP(net: MLP): MLP {
  return {
    hidden: net.hidden, output: net.output,
    layers: net.layers.map(layer => ({ w: layer.w.map(row => row.slice()), b: layer.b.slice() })),
  };
}

/** Every layer's post-activation output; `acts[0]` is the input itself. */
export function forwardAll(net: MLP, input: readonly number[]): number[][] {
  const acts: number[][] = [input.slice()];
  for (let l = 0; l < net.layers.length; l++) {
    const layer = net.layers[l];
    const kind = l === net.layers.length - 1 ? net.output : net.hidden;
    const previous = acts[l];
    const out = new Array<number>(layer.b.length);
    for (let o = 0; o < layer.b.length; o++) {
      let sum = layer.b[o];
      const row = layer.w[o];
      for (let i = 0; i < previous.length; i++) sum += row[i] * previous[i];
      out[o] = activate(sum, kind);
    }
    acts.push(out);
  }
  return acts;
}

export function forward(net: MLP, input: readonly number[]): number[] {
  const acts = forwardAll(net, input);
  return acts[acts.length - 1];
}

/** Zero-shaped gradient accumulator matching `net`. */
export function zeroGrad(net: MLP): Layer[] {
  return net.layers.map(layer => ({
    w: layer.w.map(row => new Array<number>(row.length).fill(0)),
    b: new Array<number>(layer.b.length).fill(0),
  }));
}

/**
 * Backpropagate one sample. `dOut` is dLoss/d(network output) — for the value
 * head with a sigmoid and binary cross-entropy that is simply (p − target),
 * which is why the head keeps a LINEAR output and the sigmoid is applied by the
 * caller: the combined gradient is far better conditioned than either alone.
 * Accumulates into `grad` and returns nothing.
 */
export function backward(net: MLP, acts: number[][], dOut: readonly number[], grad: Layer[]): void {
  let delta = dOut.slice();
  for (let l = net.layers.length - 1; l >= 0; l--) {
    const layer = net.layers[l];
    const kind = l === net.layers.length - 1 ? net.output : net.hidden;
    const out = acts[l + 1], previous = acts[l];
    // chain through this layer's activation
    for (let o = 0; o < delta.length; o++) delta[o] *= activateGrad(out[o], kind);
    for (let o = 0; o < layer.b.length; o++) {
      grad[l].b[o] += delta[o];
      const row = grad[l].w[o], d = delta[o];
      for (let i = 0; i < previous.length; i++) row[i] += d * previous[i];
    }
    if (l === 0) break;
    const next = new Array<number>(previous.length).fill(0);
    for (let o = 0; o < layer.b.length; o++) {
      const row = layer.w[o], d = delta[o];
      for (let i = 0; i < previous.length; i++) next[i] += d * row[i];
    }
    delta = next;
  }
}

export interface AdamState {
  m: Layer[];
  v: Layer[];
  t: number;
}

export function adamState(net: MLP): AdamState {
  return { m: zeroGrad(net), v: zeroGrad(net), t: 0 };
}

/**
 * One Adam step. Plain SGD on this data stalls the same way fixed-rate ascent
 * stalled on the long MPS chains — the per-parameter scaling is what makes a
 * hand-rolled trainer converge in a reasonable number of epochs.
 */
export function adamStep(net: MLP, grad: Layer[], state: AdamState, lr: number, weightDecay = 0): void {
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  state.t++;
  const c1 = 1 - Math.pow(b1, state.t), c2 = 1 - Math.pow(b2, state.t);
  for (let l = 0; l < net.layers.length; l++) {
    const layer = net.layers[l], g = grad[l], m = state.m[l], v = state.v[l];
    for (let o = 0; o < layer.b.length; o++) {
      m.b[o] = b1 * m.b[o] + (1 - b1) * g.b[o];
      v.b[o] = b2 * v.b[o] + (1 - b2) * g.b[o] * g.b[o];
      layer.b[o] -= lr * (m.b[o] / c1) / (Math.sqrt(v.b[o] / c2) + eps);
      const row = layer.w[o], gr = g.w[o], mr = m.w[o], vr = v.w[o];
      for (let i = 0; i < row.length; i++) {
        mr[i] = b1 * mr[i] + (1 - b1) * gr[i];
        vr[i] = b2 * vr[i] + (1 - b2) * gr[i] * gr[i];
        row[i] -= lr * ((mr[i] / c1) / (Math.sqrt(vr[i] / c2) + eps) + weightDecay * row[i]);
      }
    }
  }
}

export interface SerializedMLP {
  sizes: number[];
  hidden: Activation;
  output: Activation;
  /** Flat row-major weights per layer, then biases. */
  w: number[][];
  b: number[][];
}

export function serializeMLP(net: MLP): SerializedMLP {
  const sizes = [net.layers[0].w[0].length, ...net.layers.map(layer => layer.b.length)];
  return {
    sizes, hidden: net.hidden, output: net.output,
    w: net.layers.map(layer => layer.w.flat()),
    b: net.layers.map(layer => layer.b.slice()),
  };
}

export function deserializeMLP(s: SerializedMLP): MLP {
  const layers: Layer[] = s.w.map((flat, l) => {
    const fanIn = s.sizes[l], fanOut = s.sizes[l + 1];
    const w: number[][] = [];
    for (let o = 0; o < fanOut; o++) w.push(flat.slice(o * fanIn, (o + 1) * fanIn));
    return { w, b: s.b[l].slice() };
  });
  return { layers, hidden: s.hidden, output: s.output };
}
