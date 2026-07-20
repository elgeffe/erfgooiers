# Tensor-network strategy generator — a proof-of-concept spike

_Recorded July 2026. A Phase 3 research spike, run under the fail-fast discipline
of [tensor-networks-for-logistics.md](tensor-networks-for-logistics.md)._

## Why this is the RIGHT place for a tensor network

The earlier [reality check](tensor-networks-for-logistics.md) argued — correctly
— *against* tensor networks for **logistics**: serf routing is a low-dimensional
matching-plus-A\* problem with strong classical baselines, and a tensor method
there would add opacity and a determinism headache for no measured win. But that
same document drew the line precisely (§2): the genuine combinatorial explosion
lives not in stepping many agents but in **"optimizing many coupled decisions
over a long horizon."** That is exactly strategy selection — *which* buildings,
in *which* order, feeding *which* army — the problem the skirmish AI's whole
"backward planning" section is about.

And the value surface there really is an exponential tensor. Score a full plan by
its choice at each of `L` decision slots and you have a tensor
`T[a₀, a₁, …, a_{L-1}]` with `dᴸ` entries. A **Matrix Product State** (MPS, a.k.a.
tensor train) factors that exponential object into `L` small cores of bond
dimension `χ`, keeping the *correlations* between decisions (a smithy implies an
iron mine soon) without ever materialising the full tensor — the same model class
(and the same TN-GEO generative-optimisation idea) the reality-check doc cites
from the 2026 TSP preprint, now aimed at the domain it said was combinatorial.

The conceptual pay-off the human asked for: because the MPS is a *generative*
model, you don't read off one argmax "optimal" plan — you **sample** it, and it
returns a spread of correlated, good-enough plans. That is the Pareto front of
strategies, represented explicitly and drawn from on demand.

## What was built

All of it plays through the exact same fair seam as the Classic baseline — the
`MacroPolicy` interface, `perceive()` for observations, `applyGameCommand` for
every action — so a win is a win of *strategy*, never of information or reflex.

| Piece | File | What it is |
|---|---|---|
| MPS Born machine | `src/ai/tensor/mps.ts` | Amplitude, partition `Z` via left/right environments, **exact** ancestral sampling, analytic mean-log-likelihood gradient (finite-difference-checked), fit step, (de)serialisation |
| Strategy alphabet | `src/ai/tensor/plan.ts` | The `d`-symbol vocabulary (`build:X` / `train:Y` / `econ`), the plan decoder, and the human expert openings used for the imitation prior |
| Committed model | `src/ai/tensor/model.ts` | The trained cores (auto-generated), imported by the controller so the policy runs out of the box and reproduces |
| Policy | `src/ai/strategy/tensor.ts` | `TensorMacro`: samples ONE plan per game from the seat's seeded rng, then executes it — reusing `findBuildingSpot`/`planPlots` for legal placement and staffing/army training |
| Seat wiring | `src/ai/AIController.ts`, `src/data/aiProfiles.ts` | The `tensor` policy kind + the `tensor` profile (Godlike cadence/APM/counter, so only the *macro strategy* differs) |
| Trainer / evaluator | `tools/selfplay/tensor.ts`, `tools/selfplay/tensorModel.ts` | Imitation pretrain, then generator-enhanced self-play refinement vs Godlike (fanned across cores), and the held-out evaluator |

### How the network learns (generator-enhanced cross-entropy / TN-GEO)

1. **Imitation prior.** Fit the MPS to the human expert openings (the
   `wood → timber → quarry → gold → coal → mint → food → barracks → weapons/armour`
   build order, plus legitimate variants) so it samples a sensible spread before
   any self-play. This is one gradient routine — the same one used for refinement.
2. **Self-play refinement.** Each generation: sample a batch of whole plans from
   the current MPS, play each vs `classic-godlike-balanced`, keep the **elite**
   (the plans that won, or — since a lead often shows before a 60-min elimination
   — the top plans by an army/economy **margin**), refit the MPS toward the elite
   with a few gradient steps, and keep a light imitation anchor in the batch so
   the distribution can't collapse onto one degenerate line. Repeat.
3. **Honest evaluation.** Measure the final model on a **held-out** seed block
   (disjoint from every training seed) at the **full 60-minute timer**, where
   matches actually resolve to a winner.

Reproduce:

```
tsx tools/selfplay/tensorModel.ts        # regenerate the imitation prior → model.ts
npm run tensor:train -- 10 20            # 10 generations × 20 games, refine → model.ts
npm run tensor:eval -- 40                # held-out win rate vs Godlike, full timer
```

## Pre-registered success bar (set BEFORE the run)

Per the reality-check doc's rule — *"no runtime integration unless the tensor
method wins by enough to repay its complexity"* — the bar was fixed in advance:

- **Primary.** The trained tensor policy wins **≥ 50%** vs `classic-godlike-balanced`
  on the held-out seeds — parity-or-better with the strongest hand-crafted bot,
  earned through the fair seam. (Godlike beats Hard only ~50–59%, so parity with
  Godlike is a real bar for a near-from-scratch generative policy.)
- **Novelty.** The learned opening is legibly *different* from Classic's script —
  evidence the network *found* something, not merely imitated.
- **Efficiency.** Training in minutes on commodity cores; inference is one
  sampling pass per game (negligible), and the policy is replay-deterministic.
- **Honesty.** Missing the bar is a *reported* result, not a hidden one.

## Result

<!-- RESULTS -->
_Populated by the committed training run; see the meta block in
`src/ai/tensor/model.ts` and the reproduce commands above._

## What this does and does not show

It does **not** claim tensor networks beat hand-tuning at RTS strategy in
general — one spike on one map against one baseline can't. What it shows is
narrower and real: the coupled-decision layer the reality-check doc flagged as
the genuinely combinatorial one **can** be represented as a small tensor network,
trained by self-play through the fair seam, and made to *play* — and it gives, by
construction, the sampled Pareto-front-of-plans behaviour that a single scripted
build order cannot. Whether it clears the bar is answered in the Result section;
either way the machinery (and the honest measurement) is the deliverable.

## If it clears the bar — where next

- Condition the cores on coarse perception (a few features), turning the open-loop
  plan into a state-reactive policy — a tensor-train value/policy over a compressed
  state, the natural Phase 3 bridge to the learned track.
- Grow the bond dimension `χ` and the vocabulary; measure the win-rate/`χ` curve
  (does more correlation capacity actually buy strength, or saturate — the honest
  low-rank question the reality-check doc insists on).
- Feed the same `src/ai/dataset.ts` replay features in as an imitation signal on
  top of self-play (behaviour cloning → policy improvement).
