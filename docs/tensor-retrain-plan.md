# Tensor v2 rebuild — phase-aware, probabilistic, adaptive strategy

_Written July 2026. Status: design plan; implementation has not started._

## Decision

Rebuild the experimental tensor policy as **Tensor v2**, rather than merely
running more generations on the committed Tensor v1 opening model.

Tensor v2's goal is one fair, replay-deterministic policy that beats each
current Classic persona (`classic-easy`, `classic-hard`, and
`classic-godlike`) on held-out skirmish seeds. It must make coherent choices in
the opening, mid-game, and late-game, and react only to information available
through `perception.ts` under fog of war.

The target is a **hierarchical conditional MPS policy**:

```text
sample strategy identity z once per match
                |
     +----------+----------+
     |                     |
opening MPS          mid-game MPS          late-game MPS
     |                     |                     |
short strategic plan conditioned on current fair observation + remembered sightings
```

Sampling makes the policy probabilistic and preserves a spread of viable,
correlated strategic lines. Conditioning on the current observation, and
resampling at bounded decision windows, makes it adaptive. Sampling a whole
plan only once does **not** make a policy adaptive.

## Why Tensor v1 must be rebuilt

Tensor v1 is a useful proof of the MPS machinery, but it is structurally an
opening generator:

- `TensorMacro` samples one fixed 22-token sequence at match start, executes
  its build order, and then falls back to generic expansion. It cannot revise a
  chosen strategy when scouting reveals an army or an attack breaks a supply
  chain.
- Its action vocabulary has building choices and a small set of unit votes. It
  cannot directly choose the full late-game strategic layer: defence/outposts,
  siege/support priorities, wave commitment, recovery, or target posture.
- Its trainer plays only `classic-godlike`, keeps a winner only through a
  5-minute economy/army margin, and assigns one sampled plan to one seed. That
  reward was measured to prefer early starts over eventual wins.
- The Tensor profile has a different static late-game envelope from Godlike.
  In particular, its current army cap, siege/support requirements, flank size,
  and attack thresholds do not let the model make a like-for-like end-game
  strategic choice.

The current [Tensor proof of concept](tensor-strategy-poc.md) remains the
record for v1. This document supersedes its old retraining-only outline.

## Strategy phases

Phases are gameplay milestones, not only timers. They are monotonic so a model
does not oscillate between strategies. A recovery overlay may intervene in any
phase.

| Phase | Start / end condition | Strategic decisions |
|---|---|---|
| Opening | Match start until staffed timber, stone, coin, staple food, and first military production are online; a time cap prevents deadlock | Supplier-first production order, first defence, early economy/pressure posture, initial army family |
| Mid-game | Core economy works until a major wave has launched or advanced military infrastructure plus a fieldable army is ready | Expansion versus defence, tower/outpost choices, scouting/raids, arms capacity, counter-composition, tech path |
| Late-game | First major attack, or advanced cavalry/siege/support capability plus the field army threshold | Siege/healer quotas, flank and home guard, wave size, repair/rebuild, commit versus regroup |
| Recovery overlay | Any phase when starvation, worker gaps, stalled sites, lost supply lines, or castle damage cross a threshold | Repair the economy/base before resuming the phase plan |

The phase detector must be pure and directly unit-tested. It may use a time
fallback, but it must primarily read state visible to the AI seat.

## Tensor v2 policy design

### 1. Strategy identity and bounded replanning

At match start, sample a small latent strategy identity `z`. It represents a
coherent bias such as economic boom, defensive tech, map contest, or pressure.
It is not a hard script.

For the active phase, condition an MPS on:

- the phase;
- a compressed, fair observation of the own economy and army;
- visible enemy state and remembered last-seen state;
- the current strategy identity and recent strategic decisions.

It then samples a short option bundle (roughly four to eight strategic intents),
not an entire match. The policy replans only when an option bundle completes,
after a bounded interval, or after a meaningful event: a new scout sighting,
threat, major loss, completed tech building, or attack resolution. A minimum
commitment window stops plan-flapping.

### 2. Strategic intent vocabulary

The model must choose strategic goals rather than fragile raw placement
commands. Proposed intent families are:

- economy: `expand:timber`, `expand:coin`, `expand:arms`, `expand:food`;
- map and defence: `defend:home`, `contest:resource`, `recover:economy`;
- composition: `army:ranged`, `army:anti-mounted`, `army:mounted`,
  `army:siege-support`;
- tempo: `boom`, `scout`, `raid`, `commit`, `regroup`.

A shared deterministic executor turns an intent into supplier-first construction,
legal placement, staffing, exact unit quotas, and commands through
`applyGameCommand`. This is not a shortcut around strategy: it keeps logistics,
placement legality, action budgets, and information access equally fair for
Classic and Tensor. The tensor policy chooses *what to pursue and when*.

The late-game vocabulary must cover the buildings and units that current
Godlike uses: stone towers/outposts, stable, engineer, monastery, mounted
scouting, siege, and priests.

### 3. Conditional MPS representation

Use a small MPS per phase, with context slots followed by action slots. Context
slots are clamped to discretized observation values; the MPS samples the action
suffix conditionally. Supporting different physical dimensions per slot, or an
equivalent stable encoding, is part of the v2 MPS work.

This preserves the useful tensor property—correlations across a short strategic
sequence—while making the next plan dependent on the actual match state. The
runtime must remain plain TypeScript, deterministic from the match and seat RNG,
and within the project model-size budget.

### 4. Fair observation and memory

Extend the existing dataset/perception feature contract with only data a human
could know:

- staffed production capacity, missing workers, queues, stocks, and stalled
  construction;
- own army composition, advanced buildings, siege/support count, castle health,
  and recent losses;
- visible enemy composition, towers, bulwarks, and threats;
- last-seen enemy composition/buildings plus the elapsed time since sighting;
- known terrain resources, own/visible contest state, and prior wave result.

Memory belongs to the policy and is updated solely from `AIView`; it must never
read hidden simulation state. Under fog, not seeing an enemy is a meaningful
input, not a licence to infer their exact current army.

## Delivery sequence

### 0. Freeze v1 and establish a new baseline

1. Keep the committed v1 artifact intact and version all v2 checkpoints; a
   failed experiment must not replace the playable policy.
2. Generalise `tensor:eval` to select an opponent, use both seat orientations,
   state an explicit fog setting, and report wins, losses, draws, command
   rejections, phase metrics, and decision cost.
3. Re-baseline v1 against Easy, Hard, and Godlike before training. This records
   the post-Classic-refactor starting point rather than comparing against stale
   full-visibility results.

### 1. Build the phase and intent seams

1. Add a pure phase classifier and recovery classifier with focused tests.
2. Extract reusable strategic execution helpers from the successful Classic
   supplier/placement/worker logic. Do not duplicate a weaker second executor in
   Tensor.
3. Define stable, versioned phase intent vocabularies and a Tensor v2 model
   format. v1 model indices must remain readable as v1; do not silently reuse
   them against a changed alphabet.
4. Give the Tensor execution profile Godlike-equivalent cadence, action budget,
   visibility, and rule access. Make late-game posture parameters selected by
   policy directives rather than fixed inferior defaults.

### 2. Implement conditional sampling and runtime adaptation

1. Extend the MPS implementation with conditional/clamped sampling and tests
   for normalization, deterministic sampling, evidence handling, and serialized
   round trips.
2. Implement phase-specific short-plan sampling in `TensorMacro`.
3. Add event-driven replanning with commitment windows and a deterministic
   recovery override.
4. Add scenario tests that demonstrate adaptation: visible cavalry shifts to
   anti-mounted production; visible towers shifts to siege; an early threat
   increases defence; a broken production chain enters recovery.

### 3. Generate phase-labelled training data

1. Generate fresh replays from the improved Classic personas, including mirrors
   and the current difficulty ladder.
2. Extract phase, fair features, strategic intent, observed-opponent memory,
   and eventual match outcome for every decision window.
3. Pretrain each phase MPS from successful, diverse trajectories. Keep a light
   imitation anchor from human/expert openings and successful Classic lines so
   self-play cannot forget the sound supplier-first foundation.

### 4. Train for winning, not a five-minute lead

1. Train one universal Tensor v2 policy against a mixture of Easy, Hard, and
   Godlike—not three opponent-specific shipped policies.
2. Use a curriculum: first validate infrastructure against Easy, then introduce
   Hard, then give Godlike the largest share while retaining Easy/Hard rehearsal
   and older Tensor checkpoints to prevent catastrophic forgetting.
3. Evaluate candidates on common seed batches and both seat orientations. A
   strategy must prove itself across several seeds; one sampled plan on one map
   is too noisy to reinforce.
4. Use decisive outcome as the elite signal: win/loss/draw at the full training
   horizon. Opening/mid-game scores are diagnostics and may prioritize work, but
   must never become the sole optimization target.
5. To control cost, use multi-fidelity evaluation: cheaply reject invalid or
   hopeless games, fully evaluate all promising candidates **and a stratified
   random/diversity sample**. The random continuation prevents slow tech/late
   strategies from being filtered out only because they trail early.

### 5. Preserve useful strategy diversity

The model is generative, but a winner-only loop can still collapse to one line.
Keep diversity intentionally through:

- an imitation/KL anchor and entropy floor;
- stratified elites across economic, pressure, defensive, and tech styles;
- a small archive of successful, behaviorally distinct checkpoints;
- reporting of action entropy, unique opening/phase bundles, and win rate by
  strategy identity.

The desired result is not random variety. It is a distribution of strategies
that are individually coherent, competitive, and able to adapt after new
information arrives.

## Evaluation and promotion criteria

Training, tuning, and final evaluation must use disjoint seed ranges. The final
campaign uses at least 200 fresh seeds against each Classic persona, with both
seat orientations (400 matches per opponent). Report win, loss, draw, and match
score where a draw counts as one half.

Tensor v2 can be promoted only if all of the following hold:

1. It beats each Classic persona on the held-out campaign: target at least
   55–60% match score, with the paired 95% confidence interval above 50%.
2. It has zero rejected commands, replay-identical results for fixed seeds, and
   no reads outside the perception boundary.
3. It clears the phase-adaptation scenario tests and shows no collapse to a
   single opening/strategy identity.
4. It stays inside the controller CPU budget and the shipped model-size budget.
5. The result is reproduced once from the frozen checkpoint and recorded in
   `tensor-strategy-poc.md` or a successor experiment report.

If the v2 policy does not show an improving held-out curve after the agreed
generation and capacity budget, stop the experiment, preserve v1, and record a
negative result. Passing a short-horizon proxy is not promotion.

## Expected code boundaries

| Area | Planned responsibility |
|---|---|
| `src/ai/tensor/mps.ts` | Conditional MPS representation, clamped sampling, serialization, math tests |
| `src/ai/tensor/plan.ts` | Versioned phase/context/intent vocabulary and decoder |
| `src/ai/strategy/tensor.ts` | Phase state, fair memory, bounded replanning, Tensor directives |
| `src/ai/strategy/` | Shared deterministic strategy executor extracted from proven Classic mechanics |
| `src/ai/perception.ts` | Fair observable facts only; no policy-specific hidden reads |
| `src/ai/dataset.ts` | Phase-labelled, outcome-linked training rows |
| `tools/selfplay/tensor.ts` | Multi-opponent, alternating-seat, decisive, checkpointed trainer/evaluator |
| `tests/ai/` | Tensor math, phase transitions, adaptive scenarios, replay and campaign smoke tests |

The committed `src/ai/tensor/model.ts` remains an auto-generated v1 artifact
until a versioned v2 checkpoint passes the promotion criteria.

## Explicit non-goals

- Do not use the tensor network for pathfinding, hauling, placement legality, or
  other physical logistics; those remain classical deterministic systems.
- Do not give Tensor perfect information, a resource multiplier, or an action
  budget unavailable to the comparison Classic profile.
- Do not add online learning during a live match. Player-specific adaptation
  from recorded replays is a later, separately evaluated extension; Tensor v2
  adapts within a match to fair observations.
