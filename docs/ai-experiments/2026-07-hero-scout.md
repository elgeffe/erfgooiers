# The CPU hero — a scout for both seats, and the retrain that followed

_July 2026. The hero is IN and stays in; the hero-era retrain is another
statistically insignificant result, and the prediction that motivated the hero
is refuted._

## Why a hero

The [value function](2026-07-value-function.md) measured an information limit:
under fog a seat's own base looks the same whether the rival is Easy or Godlike,
so nothing it observes encodes the opponent — and the opponent decides the
match. Buying vision with cavalry had already been measured at 10.0% ±18.3%
WORSE: horse archers cost more than the sight returned.

The hero is fast (1.35× base speed), mounted, tough (220 hp) and **free at
spawn**. It was the one source of early vision nobody had to pay for.

## What was built

- `AI_HERO` is `erfgooier` — the only hero with `apply: []`: no boon, no bane,
  no heritage cost, no free warband. Both seats field one and the arena stays
  symmetric. A test pins all four properties, so pointing `AI_HERO` at a special
  hero fails the suite instead of silently tilting the rules.
- Spawned for both seats in the headless harness AND for browser CPU seats,
  which previously carried `hero: null` — otherwise the shipped game would have
  diverged from what self-play trains against.
- `view.hero` is exposed to policies but kept OUT of `army`/`armySize`, so every
  wave threshold, quota and attack trigger still counts trained soldiers only.
- `Tactics.scoutWithHero` rides a circuit to ~72% of the way to the rival castle
  — short of its arrows, over the ground where armies muster — and home again,
  retreating below 55% health or when chased far from base. Shared by Classic
  and Tensor alike.

It works mechanically: the hero survives **96–98%** of a match and dies 2–4
times per 69 sim-minutes. It is not riding into towers.

## The prediction was wrong

The value-function report predicted that earlier scouting would make the early
game more predictable. The hero-era collection repeats the earlier protocol
exactly — same 240 matches, same ladder, same network, same split-by-seed — so
the pre-hero table is a clean control.

| minute | pre-hero | hero-era |
|---|---|---|
| 0–4 | 59.9% | **51.2%** |
| 4–8 | 64.6% | **56.3%** |
| 8–12 | 67.9% | 68.8% |
| 12–16 | 81.2% | 86.4% |
| 16–24 | 93.9% | 85.3% |
| 24+ | 100.0% | 96.3% |

Early accuracy FELL. The class balance shifted too, so the fair comparison is
against the trivial floor:

| | pre-hero | hero-era |
|---|---|---|
| early majority-class floor | 67.6% | 58.7% |
| model on early states | 63.3% | 51.2% |

**The model sits below the trivial floor in both eras.** Early states carry no
usable information whether or not the seat can see its rival. The limit belongs
to the game, not to the AI's blindness, and "scout harder" is struck off the
list of remaining options.

## What the hero did to the balance

The change is symmetric in the rules, but not in its benefit:

| opponent | tensor2, pre-hero | tensor2, hero-era |
|---|---|---|
| classic-easy | 97.5% | 95.0% |
| classic-hard | 62.5% | **44.4%** |
| classic-godlike | 38.1% | 34.4% |
| **all** | **66.0%** | **57.9%** |

A 220 hp mounted fighter is worth more beside Classic's better-organised army
than beside Tensor's. Classic got stronger; the ladder got harder. For the game
that is arguably the point — the CPU opponents improved — but it cost the tensor
seat ground.

## The retrain

Ten generations, 65.6 min, with one evidence-backed change: **self-play may only
rewrite LATE-GAME decisions** (`LEARN_PHASES`), where V is 86–96% accurate,
leaving opening and mid-game on the imitation prior that plays them competently.

The tuning curve peaks at generation 3 (62.5%) and falls away — 56.3%, 56.3%,
47.9% — so the selected checkpoint again predates the curriculum reaching
Godlike weighting.

Held-out campaign, 120 matches, trained against prior on identical seeds:

| opponent | prior | trained | paired delta | |
|---|---|---|---|---|
| classic-easy | 98.8% | 98.8% | +0.0% | — |
| classic-hard | 45.0% | 56.2% | +11.2% ±12.4% | 9 better / 3 worse |
| classic-godlike | 26.2% | 23.8% | −2.5% ±9.9% | 3 / 4 |
| **all** | 56.7% | 59.6% | **+2.9% ±5.4%** | 12 / 7 |

Not significant. The Hard column is the largest positive effect any training run
in this project has produced, and 9-better-to-3-worse is a suggestive split, but
at n=40 per opponent it is not a result — it is the same coin flip the first
campaign warned about.

Zero rejected commands across all 240 campaign matches, entropy 3.68 bits, no
collapse.

## What this settles

Restricting credit to the late game was the strongest remaining hypothesis for
making self-play work here, and it did not rescue it. The constraint is
therefore not only WHICH decisions get credited but **how many matches back each
generation**: ~16 cannot separate a better policy from a luckier map.

That makes the next step a hardware question, not an algorithmic one — and the
throughput routes are now measured rather than assumed:

- The simulation is **92%** of match cost; the AI is 8%. Optimising policy code
  is wasted effort.
- **Shrinking the arena makes training slower**, not faster: 43.2 s/match on
  small versus 28.1 s on the default large, because packing units closer
  multiplies combat (27.5%) and separation (8.4%), the two dominant costs.
- Truncating matches early is ruled out by the value function above.
- Skipping the headless fog presentation pass was worth 3.3% and is banked.

What remains is more cores, or a materially faster combat/logistics
implementation — neither of which is a modelling problem.
