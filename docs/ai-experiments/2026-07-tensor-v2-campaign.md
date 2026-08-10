# Tensor v2 — self-play training and held-out campaign

_July 2026. **Negative result: not promoted.** The trained checkpoint is preserved
at `tools/selfplay/checkpoints/tensor2-gen10.json`; the shipped `tensor2` seat
keeps running the untrained imitation prior, and `tensor` (v1) is untouched._

This is the experiment report [`docs/tensor-retrain-plan.md`](../tensor-retrain-plan.md)
asks for. It records what was run, what came out, and why the policy was not
promoted.

## What was run

| stage | detail |
|---|---|
| Trainer | `tools/selfplay/tensorV2.ts` — multi-opponent, both seat orientations, decisive outcome as the elite signal, per-phase credit, curriculum, imitation anchor, row-multiplicity cap |
| Training | 14 generations × ~24 matches, 1200 s horizon, curriculum Easy → Hard → Godlike-heavy (55/30/15) with rehearsal. 79.4 min wall on 4 cores |
| Selection | Fixed tuning block (seeds 50 000+, 24 matches, all three personas), scored every 3rd generation |
| Campaign | 40 held-out seeds (9 000+) × 2 seat orientations × 3 personas = **240 matches per model**, 2400 s horizon |
| Comparison | The untrained prior played the **same 240 seed/seat/opponent triples**, enabling a paired test |

Training, tuning and campaign seeds come from disjoint ranges. No number below
is a training number.

## Result

Independent per-model summaries:

| opponent | prior | trained (gen 10) |
|---|---|---|
| classic-easy | 100.0% ±0.0% (W80/D0/L0) | 97.5% ±2.4% (W76/D4/L0) |
| classic-hard | 58.1% ±10.5% (W44/D5/L31) | 58.1% ±10.2% (W42/D9/L29) |
| classic-godlike | 36.9% ±10.1% (W26/D7/L47) | 43.8% ±10.7% (W33/D4/L43) |
| **all** | **65.0% ±5.9%** | **66.5% ±5.7%** |

Because both models played identical seeds and seats, the **paired** comparison
is the one that matters — it removes map and matchup variance entirely:

| opponent | paired delta (trained − prior) | pairs better/worse | verdict |
|---|---|---|---|
| classic-easy | **−2.5% ± 2.4%** | 0 / 4 | significantly **worse** |
| classic-hard | +0.0% ± 12.3% | 17 / 17 | no effect |
| classic-godlike | +6.9% ± 13.1% | 20 / 14 | not significant |
| **all** | **+1.5% ± 6.1%** | 37 / 35 | not significant |

**Self-play refinement did not improve the policy.** The only statistically
significant effect over 240 paired matches is a small regression against Easy:
four matches the prior won and the trained model did not. The apparent Godlike
gain is inside its own confidence band, and the overall 37/35 split of
better-versus-worse pairs is a coin flip.

## Promotion decision

Against the plan's criteria:

1. **Beat each persona, CI above 50% — FAILED.** Godlike is 43.8% (a genuine
   loss), and Hard's lower bound is 47.9%, so it is not significantly above even.
   Only Easy clears the bar.
2. **Zero rejected commands, fair information — PASSED.** 0 rejected commands in
   all 480 campaign matches, across both models. The policy structurally cannot
   cheat: it actuates through the same validated command seam as a human.
3. **Adaptation scenarios and no strategy collapse — PASSED.** The scenario tests
   pass, intent entropy held at 3.64–3.75 bits through every generation, and the
   sampled strategy identity stayed evenly spread (boom 25% / contest 24% /
   pressure 26% / tech 25%) in the campaign.
4. **CPU and model-size budget — PASSED.** Worst-case controller pass 92.8 ms
   (prior 66.9 ms); the checkpoint is ~80 KB, comparable to the committed v1
   artifact.
5. **Reproduced from a frozen checkpoint — PASSED.** The campaign ran from the
   committed checkpoint file, and matches are replay-deterministic.

Criterion 1 is the promotion gate and it failed, so **Tensor v2 is not promoted**.
The plan pre-registered this outcome: "If the v2 policy does not show an
improving held-out curve after the agreed generation and capacity budget, stop
the experiment, preserve v1, and record a negative result."

Since the prior is at least as strong as the trained checkpoint everywhere and
strictly better against Easy, the shipped `tensor2` seat keeps the prior.

## What was learned

- **The gap to Godlike is not a missing capability.** The obvious hypothesis was
  that Tensor v2 never reaches the advanced military layer. Instrumenting five
  Godlike matches refutes it: the policy builds stables, engineer workshops and
  monasteries at Godlike's own rate, out-builds it on smithies, armories and
  quarries, and fields more soldiers, pikemen, knights and priests. It reaches
  the late game in 100% of campaign matches. Godlike is simply a strong
  opponent, and no structural handicap explains the deficit.
- **The training signal is too weak per generation to move a policy this size.**
  Generation batches of 12–24 matches produce scores swinging between 33% and
  67% — dominated by seed variance. Reward-weighted refitting on 4–8 elite
  matches per generation cannot distinguish a better strategy from a luckier
  map, which is why 14 generations of it net out to noise.
- **Rehearsal share matters more than expected.** Dropping Easy to 15% of the
  curriculum was enough to lose four previously-won Easy matches. A universal
  policy needs a heavier anti-forgetting weight than the curriculum used here.
- **Checkpoint selection earned its keep.** The best tuning score came at
  generation 10 (56.3%), not the final generation (54.2%). Naively keeping the
  last model would have shipped a worse policy.

## If the experiment is resumed

The infrastructure is complete and reusable; the missing ingredient is
statistical power, not machinery.

1. Raise matches per generation by an order of magnitude (200+, not 24) so the
   elite set reflects strategy rather than map luck; this is a compute decision,
   not a code change.
2. Weight the anti-forgetting rehearsal higher, or score elites per-opponent so
   an Easy regression cannot be paid for with a Godlike coin-flip.
3. Consider making the update paired as well — evaluate a candidate and the
   incumbent on the same seeds and accept only on a significant paired gain,
   which is exactly the test that exposed this run as noise.
