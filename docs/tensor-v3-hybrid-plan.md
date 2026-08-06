# Tensor v3 — a hybrid policy: deterministic where the answer is known, sampled where it is not

_Plan, July 2026. **Step one is done and it overturned the conclusion.** The
ablation the plan opens with found that removing the model from the opening and
mid-game costs nothing, and removing it ENTIRELY gains 11-13 points — so the
premise (deterministic early, sampled late) is confirmed while the architecture
below is the wrong shape. See
[scripted versus sampled](ai-experiments/2026-07-scripted-vs-sampled.md). The
remaining design question is not where to put the model, but whether strategic
variety can be bought without a learned distribution's weak tail._

## The proposition

Every model opens much the same way, and the tensor network only starts to earn
its place later. So split the policy: let a deterministic executor own the
decisions that have a right answer, and let the model own the decisions that
depend on what the rival is doing.

## Why the evidence supports it

Three independent measurements from this project point the same way.

1. **No outcome signal exists early.** The value function
   ([report](ai-experiments/2026-07-value-function.md)) predicts the winner at
   51–64% before minute 8 — *below* the majority-class floor in both the
   pre-hero (63.3% vs 67.6%) and hero eras (51.2% vs 58.7%) — and at 86–96%
   after minute 12. An ablation rules out modelling error: a network trained
   only on early states does no better.
2. **Every late-game change moved the score; every opening change did not.**
   Across six paired A/Bs of 40 matches each, the two that helped were late-game
   deadlocks (+5.0%, +6.2%); the opening rewrite cost −20 points and the tower
   pacing −7.5%.
3. **28.6% of the model's output is economy.** Over 120 campaign matches and
   27 234 sampled intents: `expand:*` and `boom` are 28.6%, composition 33.9%,
   tempo 27.1%, map/defence 10.4%. More than a quarter of the model's capacity,
   and a quarter of every training gradient, is spent on choices whose right
   answer does not depend on the opponent.

The trainer already restricts *learning* to the late game (`LEARN_PHASES`). v3
extends that to *acting*: if a decision cannot be credited, the model should not
be making it.

## The boundary

**Deterministic** — a correct answer exists independent of the rival:

- the core economy chain and supplier-first line planners (`classicPlan.ts`);
- staffing, farm plots, placement legality, road paving, stalled-site rescue;
- the recovery overlay;
- the opening build order.

**Sampled** — the answer depends on what the rival fields:

- army composition (ranged / anti-mounted / mounted / siege-support);
- wave commitment versus regroup, and wave size;
- defence versus map contest investment;
- siege and healer quotas;
- raid and scout tempo.

One caveat with teeth: **the specific deterministic opening matters enormously.**
Swapping the current five-milestone foundation for Classic's full
`COMMON_OPENING` measured ~20 points worse, because its twenty-five stages put
the tavern eleventh and the barracks twelfth and cost the tempo to field an
army. v3 keeps the foundation that is already there. "Deterministic" is not
automatically "better"; it is only better when the fixed answer is a good one.

## Architecture

`TensorMacroV3` behind the same `MacroPolicy` seam, so it A/Bs against v2 on
identical seeds.

- **Two MPSs, not three.** The opening MPS is deleted outright. Mid-game and
  late-game keep one each.
- **A smaller alphabet.** `expand:*` leaves the sampled vocabulary entirely and
  becomes the deterministic planner's business, driven by the existing phase
  ceilings. The late-game alphabet drops from 13 symbols to ~10, and the model's
  parameters concentrate on the choices that move matches.
- **Context unchanged.** The four compressed slots stay — that shape was
  measured, not guessed (a slot more than ~3 positions from the action block
  barely conditions the sample).
- **Model format v3**, refusing v2 checkpoints by vocabulary version, exactly as
  v2 refuses v1.

Net effect: roughly 40% fewer parameters and ~30% fewer sampled decisions per
match, with every remaining one attached to a decision the outcome can actually
credit.

## Training

- All credit flows to the two remaining MPSs, so the effective batch per
  parameter roughly doubles at the same match count.
- **Paired accept/reject.** A candidate replaces the incumbent only on a
  *significant paired gain* over common seeds — not on a raw tuning score. Both
  campaigns so far selected a checkpoint from before the curriculum reached
  Godlike, and later generations drifted worse; this makes the update monotone
  by construction.
- Curriculum, imitation anchor, row-multiplicity cap and disjoint seed ranges
  all carry over unchanged.

## Evaluation, pre-registered

- Paired against the current `tensor2` prior, both seat orientations, held-out
  seeds, all three personas.
- **N ≥ 250 matches per comparison.** Everything at n=40 in this project has
  been noise (±15%); ±5% is the resolution needed to call a 5-point effect.
- Promotion bar unchanged: beat each persona with the paired 95% CI above 50%,
  zero rejected commands, no strategy collapse, inside the CPU budget.

## Do this first — the one-hour experiment that decides it

**Do not refactor before measuring.** Four of the six A/Bs in this project
refuted a hypothesis I was confident in, including two in this plan's own
subject area.

Freeze the opening and mid-game MPSs to the prior and let only the late-game MPS
sample — a config change to the existing v2 policy, no new code — then run a
paired comparison on held-out seeds.

- **Neutral or better** → the opening sampling contributes nothing, and the full
  v3 refactor is justified on variance, model size and training efficiency.
- **Worse** → the early sampling is doing something the measurements have not
  captured, and this plan needs revising before any code moves.

## Honest expected value

**Near-certain:** lower variance, a smaller model, cheaper training, and every
gradient spent on a decision that can be credited.

**Uncertain:** absolute play strength. Concentrating effort where the signal is
does not create signal. The binding constraint measured across two campaigns is
matches per generation, and v3 improves the *efficiency* of each match without
changing how many are affordable.

**Will not fix:** the information limit itself, or the throughput ceiling — the
simulation is 92% of match cost, shrinking the arena is measurably slower, and
early truncation is ruled out.

The strongest honest claim for v3 is that it makes the experiment *cheaper and
sharper*, not that it wins. That is still worth doing: at ±5% resolution with
half the parameters, the next negative result would mean something, and the next
positive one would be believable.

## Risk: predictability

A fully deterministic opening is exploitable by an adaptive opponent. Against
the non-adaptive Classic personas this costs nothing, and against a human it
matters. Mitigation, if it becomes real: keep a handful of hand-authored opening
variants selected by the sampled strategy identity `z` — deterministic per
match, diverse across matches, and free of any learned parameters.
