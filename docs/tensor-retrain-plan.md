# Tensor retrain — win-aligned reward on the new baseline (task outline)

_Drafted July 2026. NOT started — awaiting the owner's go after they playtest the
new baseline (fog of war, physical repair, three difficulty personas)._

## Why retrain

Two things changed under the committed model's feet:

1. **The baseline moved.** `classic-godlike` is now the pro persona (early
   6-fighter raids every 90 s + walls + late diverse army), all matches run
   under **fog of war** (perception filtered per seat; raids double as
   scouting), and both seats can **repair** (castle first). Every number in
   [tensor-strategy-poc.md](tensor-strategy-poc.md) was measured against the
   old stance-era Godlike with full visibility — the committed model's ~25%
   held-out win rate is stale and must be re-measured before anything else.
2. **The diagnosed misalignment stands.** The spike's finding: refining on the
   5-minute economy/army **margin** rewards *early starts*, not *winning* —
   refinement halved the win rate. The current model therefore encodes a good
   opening ("early start wins"); the retrain must stack **win-strategy** on top
   of it instead of drifting away from it.

## The plan (in order, each step cheap to abort)

1. **Re-baseline (no training).** `npm run tensor:eval -- 40` against the new
   `classic-godlike` under fog. Record the number in the PoC doc — it is the
   honest starting point, and if fog/raids already changed it materially that
   is itself a finding.
2. **Win-aligned reward** (the core change, `tools/selfplay/tensor.ts`):
   - Two-stage scoring per generation to keep decisive games affordable:
     play the batch at the short horizon as today, then **replay only the
     top-K by margin to a decisive horizon** (~1200–1500 s, eliminations
     happen) and select the elite by **actual wins** at that horizon.
   - Margin stays only as the tiebreaker/filter, never the optimization
     target. `TRAIN_SECONDS` for the decisive stage becomes a flag so the
     budget can be tuned per machine.
3. **Protect the early-start prior.** Start refinement from the committed
   model (not from scratch), keep the imitation anchor in every fit batch,
   and keep the existing baseline-guard (refined model is only committed if
   it beats its own starting point on held-out seeds). This is what "win-strat
   ON TOP of the current early start wins" means operationally.
4. **Run + evaluate.** ~10–15 generations × 16–24 games across all cores;
   held-out eval on the disjoint 9000+ seed block at the 25-min horizon vs
   `classic-godlike`. The pre-registered bar is unchanged: **≥ 50%** held-out
   win rate earns a product-ladder slot; anything less is recorded honestly in
   the PoC doc with the new curves.
5. **Stretch (only if 2–4 shows a rising win curve):** state-conditioned bias
   on the next-slot distribution (a few perception features), and a bond
   dimension χ sweep — the two deferred items the PoC doc already names.

## Budget & risks

- Decisive games are ~5× slower than 5-minute games; the two-stage scoring
  keeps a generation to minutes on commodity cores rather than hours.
- Fog changes what the tensor seat *sees* but not what it *samples* (the plan
  is open-loop); the shared tactics layer (raids, repairs, fog-aware launch
  threshold) is where the new baseline bites. Expect the re-baseline (step 1)
  to move before any training does.
- Kill criteria per the reality-check discipline: if the win-aligned elite
  selection still shows no rising held-out trend after the budgeted
  generations, stop, keep the guard-protected best model, and record the
  negative result.
