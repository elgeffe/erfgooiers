# Classic baseline convergence — July 2026

This note records the small, deterministic convergence gate used for the 2026-07
Classic AI refactor. It is a regression smoke test, not the statistically broad
Phase 2 acceptance campaign. Matchups were run **sequentially**: Easy vs Hard
first, then Hard vs Godlike only after the first gate passed. Seats alternate by
seed to expose corner bias.

## Result

| Higher tier | Lower tier | Seeds | Wins | Losses | Draws | Rejected |
|---|---|---:|---:|---:|---:|---:|
| Classic Hard | Classic Easy | 6200–6205 | 6 | 0 | 0 | 0 |
| Classic Godlike | Classic Hard | 7200–7205 | 6 | 0 | 0 | 0 |

The Godlike gate averaged 13.6 simulated minutes, issued 2,642 commands with
zero throttles, and verified all six recorded replays by deterministic
re-simulation. Every win ended by destroying the opponent's 2,000-HP castle.

Reproduce the same two gates, in order:

```bash
npm run campaign -- --seeds 6 --base-seed 6200 --max-minutes 20 --pairs classic-hard:classic-easy
npm run selfplay -- --pair classic-godlike:classic-hard --seeds 6 --base-seed 7200 --max-minutes 20 --out target/selfplay/final-godlike-hard --replays --check-replays
```

## What changed

- The common opening is sequential and supplier-first. Timber remains exactly
  woodcutter:sawmill 1:1; each mint adds gold + dedicated coal first; each
  smithy/armory pair adds iron + separate coal first.
- Civilian staffing precedes routine military spending. Builders remain a late
  luxury, serf growth yields coin capacity while mobilizing, and exact army-cap
  quotas preserve advanced-unit slots without leaving the early barracks army
  under strength.
- The placement search covers a wider bounded radius and gives ordinary 2×2
  buildings three-tile lanes. Dependency anchors preserve function: foresters
  must overlap an uncovered woodcutter, mines follow their deposits, and
  Godlike can guard distinct contested extractors with forward stone towers.
- Godlike reserves a ten-timber purchase while required trebuchets are missing,
  then prioritizes structural siege and priests. Siege/support no longer distort
  counter-composition reads.
- Superseded by the tower calibration: Classic no longer places walls or gates.
  Hard covers its home perimeter with wooden watchtowers; Godlike uses stone
  watchtowers and adds two remote resource outposts.
- Attack waves clear visible defenders and arrow towers before focusing the
  castle. Godlike stages mounted flankers off-axis and holds siege/healers behind
  the main line until contact. An undersized counterattack does not consume the
  next scheduled wave-growth step.

## Diagnoses that mattered

Two remaining draws demonstrated why profile-only tuning was insufficient:

1. On seed 7205, a 33-unit counterstroke reduced Hard's former 2,500-HP castle
   to 439 HP. It was incorrectly counted as Godlike's full first wave, raising
   the unseen second-wave target to 52; Godlike ended with 50 units while the
   castle repaired. Correct wave bookkeeping makes the rebuilt 44-unit,
   siege-backed force launch.
2. On seed 7202, settlement spreading placed the sole forester 13–14 tiles from
   both woodcutters, outside their nine-tile ecosystem. Horse archers spent every
   timber trickle, so the Engineer never accumulated ten timber. Anchored
   forestry plus the siege reserve changed the same seed from a timeout with no
   advanced support into a 12.1-minute win with two trebuchets and two priests.

Lowering attack thresholds or removing the siege requirement did not solve the
second seed safely; those probes either preserved the draw or made Godlike lose.
The converged fix therefore repairs the production dependency instead of
overfitting combat numbers.

## Remaining acceptance work

- Human playtest all three personas for readability, pacing and counterplay.
- Run the sequential ladder over at least 100 fresh seeds per adjacent matchup.
- Re-baseline and retrain the tensor policy: its published measurements predate
  this materially stronger Classic opponent.
