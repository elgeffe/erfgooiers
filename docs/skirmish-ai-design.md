# Skirmish AI — solo vs CPU, difficulty ladder, and experimental agents

Status: **Phases 0–2 implemented; the balance pass is the open work** (July 2026).
The `src/ai/` layer (perception → classic strategy → tactics → actuation behind
`AIController`), the `idle`/`random` seam-provers, `src/data/aiProfiles.ts`,
replay record/re-simulate (`src/game/replay.ts`), the browser **Skirmish vs CPU**
menu mode (play, or spectate CPU-vs-CPU), and the `npm run selfplay` tournament
runner all exist. Phase 2's evaluation instruments are built: `npm run campaign`
fans a fixed adjacency ladder across all cores and writes a reproducible
win-rate matrix + report; `npm run extract` (`src/ai/dataset.ts`) re-simulates
replays into labelled JSONL (perception features → next macro action), the
Phase 3 dataset format. Co-op/skirmish/vs-CPU share one multiplayer session
model in `main.ts` (seats × mode × transport). The **research track has its first
spike**: a tensor-network (Matrix Product State) strategy generator that samples
whole build-order/army plans and is trained by generator-enhanced self-play
against the Godlike baseline — the `tensor` policy/profile, `src/ai/tensor/`,
`npm run tensor:train`/`tensor:eval`, documented with a pre-registered win bar in
[tensor-strategy-poc.md](tensor-strategy-poc.md). The rest of Phases 3+
(state-conditioned learned/adaptive AI, online seats) remain unimplemented.

The **1v1 arena** is a 100×88 map with the two players in opposite corners
(`initCoOp`'s `diagonal` layout), each corner worldgen-provisioned with a full
ore spread (coal deepest — it feeds the mint AND every smithy AND armory) plus
a contested gold-and-ore cluster at map centre. `src/game/fortification.ts` is
the shared curtain-wall planner (gates keep baileys working; sieges breach the
nearest gate); walls cost 2 stone so layers are affordable, and the Classic bot
rings its castle only on defensive stances. The Classic macro no longer
plateaus: a tier-scaled `expansion` knob (Easy 0 / Hard 1 / Godlike 2) keeps
compounding producers, chosen by a **producer/consumer balance** model (build
more of a raw miner while the buildings burning its output outnumber it — a
stock snapshot can't tell a healthy ~0 intermediate from a starved one), and
serfs scale with the economy so a sprawling base actually hauls its ore. The
bot also paves roads (after a quarry, funded by a second) and reactively
counters the rival's army composition (graded by tier).

**Known limitation → next session's work.** Godlike now expands endlessly, hauls
its ore, fields a big army (to its cap) with cavalry, and beats Hard — but the
*full* unit roster (knights, siege, priests) stays out of reach, and the ≥80%
tier separation is not met (6-seed and 100-seed campaigns put Hard-vs-Easy
~64–71% and Godlike-vs-Hard ~49–59%). Both trace to the same unsolved problem:
**production-line balance and its backward chain to unit composition.** See
[Backward planning: the open balance problem](#backward-planning-the-open-balance-problem).
Tuning lessons the tournaments established and that the next pass should respect:
tempo beats greed at every tier; construction parallelism beyond the builder
count delays everything; raids into stronger garrisons invite base-razing
counter-chases; the defensive stance sweep stops pursuit suicide; a hidden serf
cap silently starves a big economy's whole weapon chain.

Companion documents: [skirmish-design.md](skirmish-design.md) (the PvP mode this AI
plays), [tensor-networks-for-logistics.md](tensor-networks-for-logistics.md) (the
prior reality check whose fail-fast discipline the research track inherits).

## Backward planning: the open balance problem

The unit-diversity and ladder-separation work left for the next session is one
problem, and it is best attacked **backwards, from the goal**, not forwards from
the economy. The forward approach — "build producers, then see what army falls
out" — is what this pass did, and it kept hitting a moving bottleneck (caps →
coal → iron → hauling → armour), because each fix exposed the next starved
stage. The insight to carry in: **it is a two-way street. The army composition
we want dictates the production lines that must run, which dictate the resources
that must flow and how, which dictates what the map and the economy must
provide.** So plan the chain in reverse:

1. **Target army** — the diverse force each tier should field (e.g. Godlike:
   soldiers + pikemen + archers + knights + cavalry + a little siege + a priest).
2. **→ Production lines** — derive the throughput each unit demands: knights and
   horse-knights need a steady **armour** stream (armory ← iron + coal), which
   competes with weapons (smithy ← iron + coal) and coin (mint ← goldore + coal)
   for the same **coal** and **iron**. The armour chain is the current wall: coal
   and iron are shared inputs the mint and smithies drink first.
3. **→ Resources & logistics** — size the mines, the haulers, and the map
   provisioning to that throughput. A second guild hall (civilian throughput),
   armour-chain over-provisioning, and hauler counts are the levers. The map
   already over-provisions coal per corner; the economy does not yet *convert*
   it fast enough.
4. **→ Levers to shape it** — `aiProfiles` knobs, the `expansionValue`
   producer/consumer model (`src/ai/strategy/classic.ts`), the arena worldgen
   (`src/world/World.ts`), and unit costs/recipes (`src/data/*`). All four
   layers exist to serve the target army; tune them together, backwards from it.

Concrete next steps: (a) a target-composition-driven training/build planner that
reserves armour throughput for knights before the army fills with soldiers;
(b) a second guild hall for the expanding tiers so civilian training keeps pace;
(c) re-run `npm run campaign` at 100+ seeds after each change and commit the
matrix to `docs/ai-experiments/`; (d) only then judge whether the ≥80% ladder
separation is reachable by hand-tuning or needs the Phase 3 learned policy.

## The epic

Skirmish shipped as human-vs-human on the co-op networking stack. This epic adds
**CPU players**, first so a single player can playtest skirmish locally without a
second human, and ultimately as a platform for experimenting with novel game-AI
techniques: simulation-driven tuning, machine-learned policies that adapt to the
player's own recorded games, and a bounded research track into tensor-network and
quantum-inspired methods.

The framing that makes this tractable: **a skirmish match is an optimization problem
in disguise.** The macro game is resource-constrained production scheduling — which
building next, which unit next, when to stop investing in economy and spend the army —
under a shared rule set and a clock. The micro game is a smaller assignment problem
(squads to targets, defenders to threats). An AI player is a policy that maps observed
state to the next command. Handwritten rules, learned models, and exotic optimizers
are then interchangeable *policies* behind one fixed interface, which is what lets us
swap them, race them, and let the player pick one in the skirmish setup.

### Decisions locked in

These were settled with the project owner before this document was written:

1. **Local-only launch first.** "Skirmish vs CPU" starts in a single browser with no
   lobby and no WebRTC. Networked AI seats come later and reuse the same agent.
2. **No cheating at any difficulty.** Easy, Hard, and Godlike all play through the
   same validated command seam as a human. Godlike is *a better player*, not a
   subsidized one. Difficulty comes from policy quality, reaction time, and action
   budget — never from resource multipliers or rule exemptions.
3. **Offline training, in-browser inference.** Learning runs in a Node pipeline on
   the headless sim; shipped models are small exported weights evaluated by plain
   TypeScript. No heavyweight ML runtime in the game bundle.
4. **Replays are local files.** Matches record seed + command log; the player
   downloads JSON and feeds it to the training pipeline. No telemetry infra yet.
5. **Tensor networks / quantum-inspired methods are a research track**, run as
   fail-fast experiments with explicit kill criteria. If they lose to known methods,
   we ship the known methods and keep the writeup.

## Why the existing architecture makes this cheap

The hard parts of an RTS bot substrate already exist in this codebase:

- **One command seam.** Every gameplay mutation flows through `Game.submitCommand` →
  `applyGameCommand(game, playerId, command)` (`src/game/commands.ts`), which
  validates ownership and legality. A bot that emits `GameCommand`s with its own
  `PlayerId` is *structurally incapable* of cheating on actions — the same
  validation that rejects a human's illegal command rejects the bot's.
- **Diplomacy is data.** `Game.setTeams` / `Game.hostileOwners` already make
  "who fights whom" a table. A CPU seat is one more entry.
- **Deterministic sim.** Seeded `simRng`, fixed 20 Hz ticks, stable iteration order.
  A replay is `seed + ordered command log`; re-simulating reproduces the match
  exactly. That is the training-data format for free.
- **Headless execution.** `src/game/testHarness.ts` (`stubView`, `makeTestGame`)
  already runs the full simulation with no renderer and no DOM. The self-play
  pipeline is a Node loop around what the test suite does today, at far faster than
  real time.
- **Symmetric information.** Skirmish currently has no fog of war, so "the AI sees
  everything" is not an advantage — the human sees everything too. If fog ever
  ships, AI perception must be filtered through the same visibility rules as the
  local player's view (see Risks).

## Agent architecture

The bot is **a headless player**, not a game system. It lives in a new `src/ai/`
layer with the same import discipline as `World`: no DOM, no Three.js, no UI — only
`Game` reads and `GameCommand` writes. That constraint is what lets the identical
agent run in the browser (solo skirmish), in Node (self-play training), and behind
the host sequencer (future online seats).

```
        ┌────────────────────────── src/ai/ ──────────────────────────┐
        │                                                             │
Game ──▶ Perception ──▶ Strategy (macro) ──▶ Tactics (micro) ──▶ Actuation ──▶ GameCommands
        │  features      what to build/train    squads, defense,   placement      │
        │  & threat map  when to expand/attack  target selection   search, orders │
        └──────────────────────────────────────────────────────────────────────────┘
                                        ▲
                          AIProfile (difficulty × stance × policy type)
```

- **Perception** (`src/ai/perception.ts`): pure feature extraction from `Game` —
  own/enemy building counts and stocks, army composition, income rates, threat
  vectors (hostile units near own buildings), map control. This is the *only* place
  that reads sim state, and it defines the observation space shared by every policy
  (classic, learned, experimental). What perception may read is the fairness
  boundary for information: today, anything (full visibility); under future fog,
  only what the bot's seat could see.
- **Strategy** (`src/ai/strategy/`): the macro policy. Given features, choose the
  next macro intent: build X, train Y, expand, fortify, mass, attack now. This is
  the layer where classic scripts, learned models, and research-track optimizers
  are interchangeable — one interface, many implementations.
- **Tactics** (`src/ai/tactics.ts`): squad bookkeeping, defense triggers (hostiles
  near home → recall / bell), attack execution (gather, formation, target order),
  retreat thresholds, tower-avoidance. Mostly shared across policies; micro quality
  scales with difficulty.
- **Actuation** (`src/ai/actuation.ts`): turns intents into legal `GameCommand`s.
  The hard part is *placement search*: pick a tile for the next building that the
  validator will accept and that is spatially sane (near resources, inside the
  base, roads reachable). Reuses the same placement legality checks players face.
- **Controller** (`src/ai/AIController.ts`): owns cadence and budgets. Macro
  thinks every ~2 s of sim time, tactics every few ticks, and every decision pass
  has a hard CPU budget so the 20 Hz tick never stalls. All bot randomness comes
  from a dedicated seeded stream (`aiRng`, derived from run seed like the existing
  streams in `src/engine/rng.ts`) — never `Math.random()` — so replays containing
  bot games stay reproducible.

### Profiles: difficulty × stance × policy

`src/data/aiProfiles.ts` — data, per the repo convention, not branches in code:

| Axis | Values | What it changes |
|---|---|---|
| Difficulty | Easy, Hard, Godlike | Reaction latency, action budget (commands/min), planning quality (script tier or search/model strength), micro precision, deliberate error rate on Easy |
| Stance | Defensive, Offensive, Balanced | Build priorities (towers/walls vs barracks), army-size threshold before attacking, expansion appetite, retreat thresholds, harass frequency |
| Policy | Classic, Adaptive (learned), Experimental (research winners) | Which strategy implementation drives the macro layer |

"Exponentially increasing" difficulty is defined *empirically*, not by adjectives:
each tier must beat the tier below in ≥80% of headless matches (Phase 2 makes this
measurable). Because no tier cheats, the levers are all human-plausible: Godlike is
faster, more precise, and strategically sharper; Easy is slow, forgetful, and
over-commits — which is also what makes the ladder feel *human-like* rather than
like a resource-cheat wall.

Human-likeness levers (all difficulties): reaction latency before responding to an
attack, an action budget instead of unbounded APM, commitment to a chosen plan for a
minimum duration (no per-tick strategy flapping), and imperfect micro below Godlike.

### Determinism contract

- **Local solo play**: bot decisions are a pure function of (sim state, `aiRng`).
  Replay = seed + human command log + profile ids; the bot's commands re-derive.
- **Future online seats**: do *not* rely on both peers re-deriving identical bot
  decisions — learned-model float arithmetic across browsers is a desync foot-gun.
  Instead the host runs the bot and sequences its commands through the existing
  host-ordered command channel, exactly like a human player's commands. Bots then
  cost the same network machinery co-op already has, and determinism reduces to the
  already-solved "same ordered commands on both peers".
- **Shipped model inference** should still prefer integer/quantized arithmetic where
  cheap, to keep local replays bit-stable across JS engines.

## Phased plan

Each phase is independently shippable and each exit bar is checkable.

### Phase 0 — Solo harness: play vs *anything* (enables playtesting immediately)

The goal is the plumbing, proven end-to-end with a trivial bot.

- Menu entry **Skirmish vs CPU**: setup screen with difficulty, stance, and AI-type
  pickers (only "Classic" listed at first; the picker exists from day one because
  policy selection is the epic's product surface).
- A local start path: reuse the skirmish branch of `startCoopLevel` (`src/main.ts`)
  without lobby/WebRTC — local player `p1`, bot `p2`, `setTeams({p1:0, p2:1,
  enemy:2, wild:2})`, `submitCommand` applies directly via `applyGameCommand`, and
  the bot controller is ticked from the fixed-step loop.
- Two throwaway policies to prove the seam: **Idle** (does nothing) and **Random**
  (legal random commands on a slow cadence).
- **Replay recording**: capture `{version, seed, level, profiles, heroes, commands:
  [{tick, playerId, command}], outcome}` per match with a download button on the
  end screen. Verify a replay re-simulates to the identical outcome (this becomes a
  regression test).
- Existing `Game.eliminated` / `onSkirmishEnd` flow handles win/lose unchanged.

*Exit bar*: a full local match against the Idle bot can be played, won, recorded,
and deterministically replayed. `PlayerId` stays two-seat; no networking touched.

### Phase 1 — Classic baseline AI (the opponent everything else must beat)

A handwritten, layered, *fair* agent — the permanent benchmark and the guaranteed
fallback if every experiment fails.

- Perception features and threat map (shared by all later policies).
- Macro: stance-parameterized build-order scripts with reactive branches (lost
  workers → rebuild economy; enemy massing → towers/army), driven by a simple
  utility scorer over candidate next-actions rather than a rigid list, so stances
  are weights, not separate code paths.
- Tactics: defense trigger, attack waves at army thresholds, rally/formation use,
  retreat when losing, target priority (army → production → storehouse).
- Actuation: robust placement search near own storehouse/resources.
- Difficulty tiers wired to cadence/budget/error-rate knobs.
- Unit tests in the vitest suite: bot-vs-idle always wins on the skirmish map
  within the hard timer; commands are always accepted (no illegal-command spam);
  per-decision CPU budget held.

*Exit bar*: Classic/Hard reliably defeats Idle and Random, completes full games with
zero rejected commands, and a human playtest says Easy is beatable while learning the
mode and Godlike-tier settings put up a real fight. Tick time impact < 2 ms amortized.

### Phase 2 — Headless self-play, tournaments, and the measured ladder

Turn the test harness into an evaluation instrument. This phase is what makes every
later claim ("Godlike is exponentially harder", "the learned model is better")
falsifiable instead of vibes.

- `tools/selfplay/`: a Node runner that builds a headless skirmish (harness-style
  `stubView`, real `World`/`Game`, real skirmish level), attaches two AI controllers,
  runs at max speed, and emits the same replay JSON as the browser.
- Batch tournaments across seeds: win rate, match length, economy curves
  (time-to-first-soldier, income at 5/10 min), APM actually used.
- Balance pass: tune profile knobs until the ladder separates (each tier ≥80% vs the
  tier below across ≥100 seeded matches) and stances are distinguishable in play
  (offensive attacks measurably earlier, defensive loses fewer buildings).
- Feature/label extraction from replays (re-simulate, snapshot features every N
  ticks) — the dataset builder for Phase 3, exercised here on bot-vs-bot data first.

*Exit bar*: one command reproduces a tournament report from fixed seeds; the
difficulty ladder's win-rate matrix is in the repo; dataset extraction works.

### Phase 3 — Learned and adaptive AI ("Adaptive" appears in the picker)

Offline learning on the Phase 2 pipeline; inference is a small pure-TS forward pass.

- **Imitation first**: from the owner's recorded human replays, train a model to
  predict the human's next macro action from features. Even a modest imitation
  policy gives the bot human-*shaped* openings and timings — the cheapest source of
  "feels human-like".
- **Self-play improvement**: use the imitation/classic policy as a seed and improve
  the macro scorer via self-play tournaments (start with simple, robust methods:
  cross-entropy/evolutionary tuning of the utility weights, or fitted value
  iteration on match outcomes — before reaching for deep RL).
- **Adaptation to the player**: an opponent-model extracts habit features from the
  player's replays (attack timing distribution, unit-mix preference, expansion
  pattern) and conditions the policy — at minimum by selecting/blending
  counter-stance profiles, at best as model inputs. The loop the owner asked for:
  play → download replays → run the pipeline → the shipped "Adaptive" opponent now
  counters your habits.
- Model constraints: weights shipped as JSON under a size budget (≤ ~200 KB),
  forward pass in plain TS (small MLP / linear scorer over the perception features),
  quantized weights for replay stability. No tfjs/ONNX runtime in the bundle.

*Exit bar*: at equal action budgets, the learned macro policy beats Classic/Hard in
≥55–60% of headless matches, and an adaptation demo shows the opponent-model
measurably countering a recorded habit (e.g. pre-building towers before the player's
usual attack window).

### Phase 4 — Research track: tensor networks & quantum-inspired methods (parallel)

Runs alongside Phase 3 once the Phase 2 benchmark exists, under the same discipline
as [tensor-networks-for-logistics.md](tensor-networks-for-logistics.md): offline
first, strong baselines first, explicit kill criteria, and no runtime integration
unless the method *wins by enough to repay its complexity*. Failure is an acceptable,
documented outcome — the fallback (Classic + Phase 3 ML) is already shipped.

Every experiment is registered with: hypothesis, baseline it must beat, metric,
timebox, kill criteria. Candidates, in rough order of promise:

1. **MPS/tensor-train generative model over build orders** (TN-GEO style, cf. the
   TSP preprints in the logistics doc). Openings are sequences over a small discrete
   alphabet with mostly local correlations — the one shape tensor networks have
   actually shown promise on. Train on self-play winners' build orders; sample
   openings, race them against scripted openings in headless tournaments.
   *Kill criteria*: after the timebox, sampled openings don't beat the best scripted
   opening's win rate, or training/sampling can't run in the Node pipeline.
2. **Quantum-inspired annealing for macro planning**: encode "next K macro actions
   under resource/time constraints" as a QUBO/Ising problem and solve with simulated
   annealing / simulated quantum annealing per macro tick (offline prototype first).
   *Kill criteria*: plan quality doesn't beat the utility scorer at equal CPU, or
   per-decision latency can't fit the controller budget.
3. **Shallow search hybrid (MCTS over a coarse abstract forward model)** — not
   quantum, but the strongest known non-NN baseline for this slot; the research
   methods should have to beat this too, not only the scripted bot.
4. **Tensor-train compression of a learned policy** — only relevant if Phase 3 ever
   produces a model too large for the size budget; parked until that exists (same
   conclusion as the logistics reality check: nothing to compress yet).

*Exit bar (per experiment)*: a short writeup in `docs/` with the numbers, and either
(a) promotion to an "Experimental" entry in the AI picker behind the same
`AIProfile` interface, or (b) a recorded negative result. Both count as done.

### Phase 5 — Online AI seats and N-player

When skirmish goes online and N-player (per the plan in skirmish-design.md):

- Host adds CPU players to empty lobby seats; the host's browser runs the
  controllers and sequences their commands through the existing host-ordered
  channel (see Determinism contract) — guests need no AI code at all.
- The `PlayerId` union widening and N spawn points are the same sweep already
  itemized in skirmish-design.md; the AI layer is keyed by `PlayerId` from day one
  so it inherits N-player without changes.
- Mixed team games (humans + CPU allies vs CPU team) are `setTeams` data.

*Exit bar*: a human hosts a lobby, adds a Classic CPU to the second seat, and a
guest spectates/plays the same deterministic match.

## Replay & training data format

One format everywhere (browser recorder, Node self-play, training pipeline):

```jsonc
{
  "version": 1,
  "seed": 123456789,
  "level": "skirmish-border-clash",
  "players": [
    { "id": "p1", "kind": "human", "hero": "reeve" },
    { "id": "p2", "kind": "ai", "profile": "classic-hard-offensive" }
  ],
  "commands": [ { "tick": 412, "playerId": "p1", "command": { "type": "placeBuilding", "...": "..." } } ],
  "outcome": { "winner": "p1", "ticks": 51240, "reason": "storehouse" }
}
```

Because the sim is deterministic, this is a *complete* record: the pipeline
re-simulates it headlessly and extracts feature snapshots at any cadence without the
recorder having stored them. Replays double as desync/regression fixtures — the
Phase 0 "replay reproduces outcome" test guards the determinism contract forever.

## Metrics

- **Strength ladder**: win-rate matrix across tiers/stances/policies on ≥100 seeded
  headless matches; tiers must hold the ≥80% separation.
- **Fairness**: zero commands rejected by `applyGameCommand` in tournaments (a
  rejected bot command is a bug); no sim reads outside `perception.ts`.
- **Performance**: amortized AI cost per sim tick < 2 ms in-browser; no GC spikes
  from decision passes.
- **Human-likeness** (qualitative but recorded): playtest notes per release —
  openings vary between matches, the bot reacts with plausible delay, no
  perfect-information "mind reading" tells, APM within its budget.
- **Adaptation** (Phase 3): a measurable behavioral shift against a recorded habit,
  demonstrated on fixed replays.

## Risks and mitigations

- **Placement search is the hidden iceberg** of Phase 1 — legal, *sensible* building
  placement is most of an RTS bot's perceived competence. Mitigate: invest early,
  score candidate tiles with the same legality checks players face, and cap search
  per decision pass.
- **Determinism vs learned models**: float drift across JS engines. Mitigate:
  quantized/integer inference for shipped models; host-sequenced bot commands
  online so cross-peer replication is never assumed.
- **Fog of war later**: today's full visibility is symmetric; if fog ships, the
  fairness contract requires perception to filter through the bot seat's visibility.
  Keeping all state reads inside `perception.ts` makes that a one-module change.
- **Training data scarcity**: one owner's replays is a small imitation set.
  Mitigate: self-play data dominates; human replays steer style, not the whole
  policy.
- **Research-track scope creep**: the entire point of the experiment registry,
  timeboxes, and kill criteria. The classic + ML fallback ships regardless.
- **Bundle growth**: model size budget enforced in CI once models ship; heavy
  dependencies stay in `tools/`, never in `src/`.

## Proposed file layout

```
src/ai/                     # runtime agents — no DOM, no Three.js, Game-reads + GameCommand-writes only
  AIController.ts           # seat wiring, cadence, action/CPU budgets, aiRng
  perception.ts             # the only module that reads sim state; defines the observation space
  strategy/classic.ts       # Phase 1 utility-scripted macro policy
  strategy/learned.ts       # Phase 3 model-driven macro policy (weights from src/ai/models/)
  tactics.ts                # squads, defense triggers, attacks, retreats
  actuation.ts              # intents → legal GameCommands; placement search
  models/*.json             # exported quantized weights (size-budgeted)
src/data/aiProfiles.ts      # difficulty × stance × policy tables (data, not code branches)
src/game/replay.ts          # record/serialize/re-simulate replays
tools/selfplay/             # Node tournament runner, dataset extraction, training (deps live here)
docs/skirmish-ai-design.md  # this document
docs/ai-experiments/        # research-track writeups, one per experiment (wins and kills alike)
```

## Testing

- Phase 0: replay determinism test (record → re-simulate → identical outcome).
- Phase 1: bot-vs-idle victory within hard timer; zero rejected commands over full
  games; per-pass CPU budget assertions; stance/difficulty knobs alter measured
  behavior (offensive attacks earlier than defensive on the same seed).
- Phase 2+: the tournament runner *is* the integration test; a small fixed-seed
  tournament can run in CI as a smoke check.
- Existing `skirmish.test.ts` diplomacy/elimination coverage applies unchanged —
  the bot is just another owner.
