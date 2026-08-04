# Value function — why outcome-supervised learning stalls on this game

_July 2026. A measured explanation for the Tensor v2 negative result, and a
constraint that applies to any outcome-supervised method here, not just to the
tensor policy._

## The question

Tensor v2's self-play produced +1.5% ±6.1% over fourteen generations — noise.
The suspected cause was credit assignment: the policy learns from ONE win/loss
bit shared across ~30 decisions per match. A value function V(s) → P(win) is the
standard remedy, and it promises a second prize: if the winner is legible early,
training matches can stop at eight minutes and bootstrap the rest instead of
playing out twenty, roughly tripling throughput on the same four cores.

So: **can a model predict the winner from a fair mid-match observation, and how
early?**

## Setup

- 240 matches (120 seeds × both seat orientations) across the full Classic
  ladder, sampled every 30 sim-seconds → **9 889 labelled states**.
- Features: 41 continuous, normalised quantities from the same fog-filtered
  `AIView` every policy reads (`src/ai/learn/features.ts`) — army share, castle
  health both sides, siege/priest/tower counts, stocks, phase.
- Model: 41→48→24→1 MLP, plain TypeScript, Adam, binary cross-entropy
  (`src/ai/learn/net.ts`; gradient pinned against finite differences).
- Split **by seed**, never by row — two samples from one match are far too
  correlated for a row-wise split to mean anything.

## Result

Held-out accuracy, by match minute:

| minute | n | accuracy | Brier |
|---|---|---|---|
| 0–4 | 288 | 59.9% | 0.242 |
| 4–8 | 384 | 64.6% | 0.250 |
| 8–12 | 381 | 67.9% | 0.231 |
| 12–16 | 282 | 81.2% | 0.140 |
| 16–24 | 326 | 93.9% | 0.061 |
| 24+ | 228 | 100.0% | 0.003 |

Overall held-out accuracy 72.9%, against 66.9% for an army-share-only baseline.

**The eight-minute truncation does not work.** At the horizon that would have
paid for itself, labels are ~65% informative — noisier than the signal the
campaign already failed to learn from. Truncation only becomes defensible around
minute 16, by which point the average match (≈19 min) is nearly over, so the
saving is ~20% rather than 3×.

## Why: the information is not in the state

An ablation on states before eight minutes:

| model | accuracy on early states |
|---|---|
| network trained on all states | 63.3% |
| linear model | 60.4% |
| network trained **only** on early states | 63.1% |
| army share alone | 59.5% |
| always predict the majority class | **59.5%** |

Fitting the network exclusively to early states does not help. This is not a
feature-engineering or capacity failure: roughly four points separate the best
model from the trivial baseline, and no architecture recovers what is not there.

Tracing the prediction against the truth by opponent shows the mechanism:

| minute | vs Easy pred/actual | vs Hard | vs Godlike |
|---|---|---|---|
| 0–4 | 66% / 98% | 64% / 62% | 64% / **38%** |
| 4–8 | 74% / 98% | 68% / 62% | 66% / **38%** |
| 8–12 | 77% / 97% | 65% / 63% | 66% / **38%** |
| 12–16 | 83% / 97% | 56% / 62% | 50% / 36% |
| 16–20 | 90% / 96% | 60% / 61% | 46% / 46% |

Against Godlike the model predicts 64–66% for twelve minutes while the seat is
actually losing 38% of the time, and only converges after minute 12.

The reason is fog of war. For the first ten minutes the seat's own base looks
much the same whether the rival is Easy or Godlike — it has not scouted an army
yet. **The early state does not encode the opponent, and the opponent is what
decides the match.** Outcome labels attached to early states are therefore close
to unlearnable by construction.

## What this means

1. **It explains the Tensor v2 result mechanically.** Opening and mid-game
   decisions cannot be credited or blamed by match outcome, because the outcome
   is nearly independent of them given what is observable at the time. The
   failure was not the MPS, the cross-entropy update, or the batch size — all
   three were downstream of an information limit.
2. **It bounds every outcome-supervised method here**, including PPO, AWR and
   offline RL. They differ in how they use the signal, not in whether the signal
   exists. Any of them would learn late-game behaviour and drift in the opening.
3. **It is consistent with the policy A/Bs.** Substituting Godlike's hand-tuned
   unit table for the model's sampled composition — a LATE-game choice — moved
   the score 10 points. Changing the economic opening moved it 20 points the
   wrong way, and paced towers 7.5 points the wrong way. Where signal exists,
   choices matter; where it does not, intervention is a coin flip.
4. **The value function is still worth having** for the late game: 94% accurate
   from minute 16, Brier 0.003 by minute 24. It is a good in-match evaluator and
   a sound basis for advantage-weighting the final third of a match.

## If the work continues

In descending order of expected value:

- **Make the simulator cheaper.** With truncation ruled out, throughput has to
  come from the sim itself — smaller training arenas, profiling the perception
  and pathfinding hot paths, more cores. Sample count remains the binding
  constraint and no algorithm substitutes for it.
- **Learn the late game only.** Restrict advantage-weighted updates to states
  after minute 12, where V is informative, and leave the opening to the
  deterministic executor that already plays it competently.
- **Give the early state something to predict.** If early decisions must be
  learned, they need a target that is actually a consequence of them — a
  learned economy/army strength at minute 12, say — with the caveat that
  optimising a proxy is exactly what made Tensor v1 prefer fast starts to wins.
- **Scout harder.** The information limit is partly self-inflicted: a policy
  that scouted earlier would have a state that encodes the opponent sooner, and
  would both play better and be more learnable. That is a policy change with a
  measurable prediction attached — early-game accuracy should rise.
