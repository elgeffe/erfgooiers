# Scripted versus sampled — the tensor sampler is a net cost

_July 2026. **Decisive, replicated on two disjoint seed blocks.** Switching the
tensor network off gains 10.8% ±8.7% and 13.3% ±8.5% of match score, and
26.2% ±17.5% against Godlike. The deterministic configuration ships as the
`scripted` profile; the sampled one stays selectable._

## The question

The hybrid proposal — deterministic for simple actions, tensor network for
complex ones — needed a boundary. Rather than guess it, ablate: remove the
model from part of the policy and measure what it was contributing.

## Three configurations, identical everything else

Same executor, same directives, same hero, same seeds, same seats, same
opponents. The only variable is how many phases draw a bundle from the MPS
instead of running the modal one.

| | model's role |
|---|---|
| **v2** | samples opening, mid-game and late game |
| **hybrid** | samples the late game only |
| **scripted** | never samples |

## Block 1 — seeds 9000–9019, 120 paired matches

| opponent | v2 | hybrid | scripted | scripted − v2 |
|---|---|---|---|---|
| classic-easy | 98.8% | 100.0% | 97.5% | −1.2% ±4.3% |
| classic-hard | 45.0% | 42.5% | 60.0% | +15.0% ±16.5% |
| classic-godlike | 26.2% | 32.5% | 45.0% | +18.8% ±19.4% |
| **all** | 56.7% | 58.3% | **67.5%** | **+10.8% ±8.7% SIG** (27/13) |

The hybrid arm is the informative middle: removing the model from two of three
phases — 28.6% of everything it draws — cost nothing (+1.7% ±9.3%, 20 better /
18 worse). Removing it entirely gained ten points.

## Block 2 — seeds 9500–9519, fresh, 120 paired matches

Block 1 had a methodological flaw worth stating: the fixed bundles were chosen
from intent frequencies measured on the very seeds they were then scored on.
Aggregate frequencies only, never per-seed outcomes, so the leak is mild — but
an 11-point claim that reverses a project's premise deserves clean seeds.

| opponent | v2 | scripted | delta | better/worse |
|---|---|---|---|---|
| classic-easy | 97.5% | 98.8% | +1.2% ±4.3% | 2/1 |
| classic-hard | 50.0% | 62.5% | +12.5% ±17.5% | 10/6 |
| classic-godlike | 30.0% | **56.2%** | **+26.2% ±17.5% SIG** | 18/4 |
| **all** | 59.2% | **72.5%** | **+13.3% ±8.5% SIG** | 30/11 |

The effect is larger on the clean block, not smaller. Zero rejected commands in
all 480 matches across both blocks.

## Why

The fixed bundles are the prior's **modal** strategy — its most frequently drawn
intents (`expand:arms` 13.6%, `army:ranged` 11.8%, `defend:home` 8.1%,
`expand:coin` 7.2%), deliberately chosen to remove variance rather than
substitute a different plan.

The mode is good. A generative model, by construction, draws from the whole
distribution — so it plays the weaker tail about half the time. Sampling around
a good strategy is a loss unless the distribution is sharp enough that the tail
is also good, and nothing in this project ever made it that sharp.

That single fact retro-explains every earlier result:

- **Three training campaigns produced nothing significant.** Training reshapes
  the distribution, but the problem is that *any* spread around the mode costs.
- **The value function found no early signal.** Without creditable early
  feedback there is nothing to sharpen the distribution *toward*.
- **Four of six strategic A/Bs were coin flips.** They perturbed a policy whose
  variance already dominated the effect being measured.
- **The 33.8% → 45.0% gain against Godlike came from the executor**, not the
  model: two deadlock fixes in code the scripted seat also runs.

## What ships

- **`scripted` — "Strategist"**, a new selectable profile: the whole phase-aware
  machinery (shared executor, policy directives, hero scouting, recovery
  overlay) with the sampler off. The strongest CPU seat measured in this
  project, and the first to put every persona above 50%.
- **`tensor2` keeps sampling**, via `TensorMacroV2(model, SAMPLE_ALL)`. It is
  not deleted, because match score is not the only axis — see below.

## The trade-off worth keeping

| | distinct opening bundles over 120 matches |
|---|---|
| v2 | **25** |
| hybrid | 1 |
| scripted | 1 |

A scripted seat opens identically every match, forever. For a benchmark that is
a virtue; for an opponent somebody plays fifty times it is not. The model buys
25 distinct openings, and this experiment prices that variety at roughly 11–13
points of match score.

The open engineering question is whether the variety can be had cheaply: a
handful of *curated* strong openings selected by the strategy identity `z`
would give diversity without drawing from a distribution's weak tail. That is a
concrete next experiment, and unlike the last three it has a mechanism behind it
rather than a hope.

## Caveats

- n=40 per opponent per block. The overall figures are significant; the
  per-opponent ones mostly are not, apart from Godlike in block 2.
- `scripted` at 56.3% against Godlike clears the promotion bar's *shape* — every
  persona above 50% — but not its letter, since the interval's lower bound is
  42.6%. Confirming it needs the pre-registered 200 seeds per opponent, which is
  now worth spending: for the first time there is a candidate that might pass
  rather than another negative to record.
- The fixed bundles were hand-chosen from the prior's modal behaviour. A better
  script may well exist; this one was built to be a fair control, not an
  optimum.
