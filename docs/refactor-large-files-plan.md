The four files that most need refactoring are clear, but “most urgent” and “best first step” differ.

| Priority | File | Lines | Approx. tokens | Assessment |
|---:|---|---:|---:|---|
| 1 | [Game.ts](C:/Users/jeffk/Projects/erfgooiers/src/game/Game.ts:50) | 3,117 | 39k | Highest need; many tightly coupled simulation systems |
| 2 | [models.ts](C:/Users/jeffk/Projects/erfgooiers/src/render/models.ts:1) | 2,620 | 40k | Best first refactor; strong natural boundaries and relatively low risk |
| 3 | [main.ts](C:/Users/jeffk/Projects/erfgooiers/src/main.ts:38) | 1,486 | 18k | Overloaded composition root with 27 imports and many UI flows |
| 4 | [View.ts](C:/Users/jeffk/Projects/erfgooiers/src/render/View.ts:31) | 1,664 | 21k | Renderer, terrain, ambience, overlays, and quality management combined |

My recommended execution order:

1. Split `models.ts` mechanically into:

   - `modelCore.ts`
   - `sceneryModels.ts`
   - `unitModels.ts`
   - `buildingModels.ts`
   - `faunaModels.ts`
   - Keep `models.ts` as a small compatibility barrel.

   Target: every implementation file below 900 lines, with no public API changes.

2. Refactor `Game.ts` incrementally:

   - Split `Game.test.ts` by combat, economy, and encounters.
   - Extract `TradeSystem` first because dedicated trade tests already exist.
   - Extract `EncounterDirector` second.
   - Then consider `ProjectileSystem`, `CombatSystem`, and `SettlementSystem`.
   - Keep `Game` as the public facade and `update()` as the deterministic orchestrator.

   This must preserve RNG calls, iteration order, command APIs, and co-op parity exactly.

3. Extract from `View.ts`:

   - `Ambience` owning clouds, wildlife, birds, fish, pigs, and whale lifecycle.
   - `TerrainRenderer` owning ground geometry, chunks, roads, crops, and scenery refresh.

   Keep `View` as the API used by `Game` and `Controls`. Target: 700–800 lines.

4. Reduce `main.ts` without violating its lifecycle ownership:

   - Pure level-planning/enemy-scaling policy.
   - Co-op screen/controller.
   - Sandbox setup and tools.
   - Settings/session chrome.

   Keep level transitions, object composition, and the fixed-step loop in `main.ts`. Target: 500–650 lines.

Sub-agent workflow:

- Render agent owns the `models.ts` split.
- Simulation agent owns `Game` tests and systems.
- Lifecycle agent owns `main.ts` and UI extractions.
- Primary agent integrates and checks architecture/determinism.
- Agents should not edit the same facade concurrently.
- Every extraction is behavior-neutral, followed by `npm test` and `npm run build`; visual changes also get a browser smoke test.

I recommend the balanced route: `models.ts` first for an immediate AI-context win, then the tested `Game.ts` pilot, followed by `View.ts` and `main.ts`.

Alternatives are:

- **Game-first:** addresses the worst file immediately, but carries the highest regression risk.
- **Quick context cleanup:** `models.ts` → `View.ts` → `main.ts`, postponing the difficult simulation split.

My vote is the balanced route. No files were changed, and the existing `docs/feedback.md` modification remains untouched.

Agreed: `Game.ts` should be handled serially by me, without sub-agents. The safest approach is to lock current behavior before moving any implementation.

## Regression-prevention strategy

1. Add characterization tests first.

Existing coverage is strong for logistics, formations, commands, trade, and co-op parity. Important gaps are:

- Exact enemy-wave timing and spawn order
- Projectile/flame damage and death timing
- `update()` subsystem ordering
- Training, staffing, tavern, and market updates
- Bell/refuge behavior
- Entity ID and seeded spawn determinism

2. Add a deterministic simulation fingerprint.

A canonical scripted game would run for fixed tick counts and record gameplay state, sorted by entity ID:

- Buildings, sites, units, ownership and HP
- Stock, inputs, outputs and training queues
- Unit positions, states, targets and orders
- Wave status, elapsed time, objective progress and defeat state

The current result becomes a checked-in golden baseline. Unlike the existing peer-sync test—which only proves two copies of the new code agree—this detects changes from today’s behavior.

3. Preserve `Game` as the facade.

Existing callers should continue using the same methods and arrays. Extracted systems receive narrow interfaces instead of importing `Game`, preventing cycles and limiting what each system can mutate.

4. Extract one system per change.

Recommended order:

1. Split `Game.test.ts` into navigable test files.
2. Add golden deterministic scenarios.
3. Extract `TradeSystem`—already well covered.
4. Extract `EncounterDirector`.
5. Extract `ProjectileSystem`.
6. Extract `CombatSystem`.
7. Extract settlement/logistics and market/training last.

Each extraction gets its own reviewable commit-sized diff. No balance changes, cleanup, renaming, or formatting churn mixed into moves.

5. Treat determinism as an API.

During extraction we must preserve:

- `Game.update()` phase order
- Array iteration order
- Entity ID allocation order
- `simRng` call count and order
- Deferred death cleanup timing
- Command application order
- Floating-point operation order where practical

6. Run gates after every extraction.

Each slice must pass:

```text
npm test
npm run build
deterministic golden scenarios
```

Combat/director changes also get a browser smoke test covering economy, training, group combat, a wave, and level completion.

## Stop conditions

If an extraction changes the golden result, we stop and explain the exact difference. We only update a golden baseline for an intentional gameplay change—not to make an unexplained refactor failure disappear.

I would begin with guardrail tests only. Once those establish the current baseline, the first production move would be `TradeSystem`; it is the lowest-risk way to prove the subsystem/facade pattern before touching combat.