# AGENTS.md — Erfgooiers

Guidance for coding agents working in this repository. Read this before changing code.
Use [README.md](README.md) for the player/developer overview and
[ROADMAP.md](ROADMAP.md) for product status and future work.

## Project

Erfgooiers is a TypeScript + Three.js browser roguelite, bundled with Vite. It combines
a Settlers-style physical logistics simulation with light RTS combat across ten short,
procedurally generated levels. Shops, contracts, cards, hero rule sets, and gold persist
within a run; Heritage unlocks and Ascension progress persist between runs.

## Commands

```bash
npm install
npm run dev      # Vite development server
npm test         # Vitest unit suite
npm run build    # tsc --noEmit, then Vite production bundle
npm run preview
```

After code changes, run both `npm test` and `npm run build`. A passing test suite plus a
clean production build is the completion bar. Vite's current large-chunk advisory is a
non-failing warning, not permission to skip validation.

## Architecture

`src/main.ts` is the composition root. It owns the lifecycle
`menu → heroSelect → playing → shop → summary`, creates persistent UI/view/input/audio
objects once, and rebuilds level-scoped `World` and `Game` instances.

| Area | Primary files | Responsibility |
|---|---|---|
| Lifecycle | `src/main.ts` | Screens, run transitions, level setup/teardown, fixed-step loop |
| Simulation | `src/game/Game.ts`, `src/game/*System.ts` | `Game` facade/fixed tick plus focused economy, worker, combat, placement, order, encounter, and training systems; no DOM |
| Rules | `src/game/Modifiers.ts` | All tunable run/meta/hero/mutator effects |
| Objectives | `src/game/Objectives.ts` | Economy and combat objective progress |
| Run/save | `src/game/RunState.ts`, `SaveGame.ts` | Run/meta state and versioned persistence |
| World | `src/world/World.ts` | Procedural tile state and spatial queries; no Three.js |
| Engine | `src/engine/` | RNG, pathfinding, pure formation layout |
| View | `src/render/View.ts` | Three.js scene, camera, world lifecycle, minimap, ambience |
| Models | `src/render/modelCore.ts`, `*Models.ts`, `models.ts` | Shared render primitives plus focused scenery, unit, building, and fauna builders; compatibility barrel |
| Input | `src/input/Controls.ts` | Camera, placement, selection, groups, formations, orders |
| HUD/shop | `src/ui/UI.ts`, `Shop.ts`, `icons.ts` | DOM HUD, inspectors, shop, shared SVG icons |
| Audio | `src/audio/Audio.ts` | Procedural SFX and music/mood |
| Content | `src/data/` | Items, buildings, levels, units, heroes, cards, mutators, meta |
| Skirmish AI | `src/ai/` | Headless CPU players: perception, policies, tactics, placement, controller |
| Shared types | `src/types.ts` | Cross-layer data contracts and key unions |

### Layer boundaries

- `World` is pure tile state. Never import Three.js, DOM, UI, or audio there.
- `Game` owns simulation state and tick ordering; focused systems in `src/game/` own
  subsystem behavior. They may ask `View` to create/remove meshes, but they do not
  manipulate the DOM or own scene bookkeeping.
- `View` and the render model modules own Three.js representation. Visual branching by
  `BuildingKey`/unit kind is allowed here; gameplay branching is not.
- `UI`/`Shop` own content DOM. `Controls` may manage input-only overlays such as the
  placement hint, selection rectangle, and formation picker.
- `main.ts` wires callbacks (`toast`, `onSelect`, `onGold`, `sfx`, death effects) and is
  the only place that coordinates run lifecycle concerns.

## Core conventions

### Data over simulation branches

Items, buildings, levels, units, upgrades, heroes, meta upgrades, and mutators belong in
`src/data/`. New content should normally require data plus a key union—not a special case
in `Game.ts`. If simulation behavior is genuinely new, add a generic definition field
and teach the simulation that field once.

Building identity is the `BuildingKey` from the `DEFS` record. Pass that key to rendering;
do not duplicate it in `BuildingDef` as a separate style/id field.

### Modifiers are the rule gateway

Every card, hero rule, curse, Heritage bonus, and Ascension stat adjustment flows through
`Modifiers`. The simulation calls methods such as `unitSpeed`, `buildTime`, `gatherTime`,
`recipeTime`, `buildingCost`, `combatMult`, and `trainTime`. Extend `Modifiers` for a new
tunable rather than reading upgrade ids inside the simulation.

Rule sets are per-owner. Systems never hold a single `Modifiers`; they resolve one through
`Game.modsFor(owner)`. In single player every owner (and enemy/wild) maps to the one shared
`mods`. In co-op each player gets their own `Modifiers` (difficulty base + that player's
hero) via `setPlayerMods`, so one player's hero never buffs the other; enemy/wild fall back
to the base. Always resolve by the acting entity's owner (`building.owner`, `unit.owner`,
`site.owner`) — this is intrinsic and identical on both peers, so it stays deterministic.
Combat stats bake at spawn, so `spawnFighter`/`spawnSquad` must be given the real owner.

### Determinism

`src/engine/rng.ts` has three seeded streams:

- `worldRng` — map generation only;
- `simRng` — gameplay events only;
- `uiRng` — cosmetic layout only.

Web Crypto chooses an unpredictable fresh run seed, with a xorshift fallback. After that,
run seed + level index fixes the named streams. Do not use cryptographic entropy or
`Math.random()` for gameplay. Do not reorder simulation iteration casually; future
replays/lockstep depend on stable order.

### Fixed timestep

`Game.update(dt)` runs at 20 ticks per second through the accumulator in `main.ts`.
Rendering, camera movement, clouds, wildlife, and other ambience are real-time. Simulation
speed is 0/1/3; zero is pause.

### DRY and separation of concerns

- Derive repeated content sets from their source table (for example, empty stock derives
  from `ITEMS`) instead of maintaining parallel key lists.
- Extract logic when it is pure/testable, has a stable API, or has multiple consumers.
  `engine/formations.ts` is the model: no Game/View dependency and direct tests.
- `Game.ts` is the stable simulation facade and tick orchestrator. Extend an existing
  focused system when behavior belongs there; extract another system only when it has a
  cohesive responsibility and a narrow port API. Likely future seams outside simulation
  remain ambience lifecycle and building model builders.
- Avoid framework, ECS, dependency-injection, or state-library migrations without a
  demonstrated feature, correctness, or profiling need.

## Content recipes

### Add an item

1. Add its key to `ItemKey` in `src/types.ts`.
2. Add its definition to `ITEMS` in `src/data/items.ts`.
3. Add it to `RES_SHOWN` if it belongs in the top resource bar.
4. Add a resource pictogram in `src/ui/icons.ts`.

Storehouse zero-stock initialization derives from `ITEMS`; do not add another manual list.

### Add a building or production chain

1. Add a `BuildingKey`.
2. Add a `BuildingDef` in `src/data/buildings.ts` and place it in `MENU_CATEGORIES`.
3. Use generic `gather`, `recipe`, `fields`, `tavern`, `military`, or `tower` data.
4. Choose a fallback `ModelKind`. For a unique silhouette, add a render-only
   `BuildingKey` case in `makeBuilding`/`buildingModels.ts`; keep it out of `Game.ts`.
5. Add its build-menu icon mapping in `src/ui/icons.ts` when it produces a new resource
   or needs a special non-resource mark.

The generic serf dispatcher routes recipe inputs, outputs, and construction materials.

To iterate on a building's mesh, use the standalone model viewer instead of
placing it in-game: `npm run dev` then open `model-viewer.html?model=<key>`. It
renders one model with the game's lights/camera and reports any parts poking
past the 2×2 tile footprint. See the `render-model` skill for the headless
screenshot workflow.

### Add or change a level

Edit `src/data/levels.ts`: objective variants, world parameters, kit, timers, reward,
enemy setup, and starting army are data. Objective variants currently support `stock`,
`produce`, `produceMulti`, `collect`, `survive`, `slay`, and `destroy`. Contract selection
chooses variants deterministically.

Map difficulty comes mainly from dimensions, water, mountains/frontiers, deposits,
enemy placement, and timers. Trees/decorations are cleared by construction; they are not
hard placement pressure.

## Current product state

- The ten-level economy/combat run, boss, shop, contracts, saves, Heritage shop,
  unlockable hero rule sets, mutators, and Ascension A1–A3 are playable.
- Two-player co-op is playable as a first slice: the published build uses encrypted manual
  WebRTC signaling with explicit host admission and direct browser-to-browser data channels.
  The `server/` relay and public room browser are retained but disabled for a later
  server-backed mode. Co-op has two player-owned economies, a Trade tab with physical cart
  shipments, and a four-level Expedition (`src/data/coOpLevels.ts`).
  Every gameplay mutation flows through `Game.submitCommand` → `src/game/commands.ts`;
  co-op swaps that sink for the host sequencer, so never mutate the sim directly from UI/input
  code. In the lobby each player picks a hero and a preset building colour (`setLoadout`
  message → `RoomPlayer.color`/`hero`); at level start both peers spawn each player's hero and
  warband from the shared room state, `Game.setPlayerMods` installs that player's rule set
  (difficulty base + hero) so their hero perks/banes apply to their economy alone, and
  `Game.playerColors` recolours that player's buildings (roofs, and the timber attachment on
  mines while the mound stays grey) via `makeBuilding`'s `playerColor` argument. Player-scoped
  notifications route through `Game.emitToast(msg, cls, owner)`, which drops the *other*
  player's events so each seat sees only its own; global events (raids, level messages) carry
  no owner and show to both. Checkpoint/replay recovery and per-player shops are not built yet.
- A beta **1v1 Skirmish** mode reuses the whole co-op stack as PvP: the host picks the mode
  in the host form (`RoomSettings.mode: 'skirmish'`), diplomacy is data on the simulation
  (`Game.setTeams`/`Game.hostileOwners`, keyed by entity `owner`), the single symmetric map
  lives in `src/data/skirmishLevels.ts` with no PvE, and the first storehouse to fall ends
  the match via `Game.eliminated` (the shared `defeat` flag stays co-op/solo only). See
  `docs/skirmish-design.md` for the N-player plan and the beta backlog.
- Co-op Expedition, PvP Skirmish, and Skirmish vs CPU are all modes of ONE multiplayer
  system in `main.ts`: a `MultiplayerSession` is a set of seats (local human / remote
  human / CPU) playing a mode (`expedition` | `skirmish`) over a transport (`network`
  relay | `local` browser), and `buildMultiplayerLevel` is the single shared sim
  construction path. New modes/seat kinds extend that session, not a new subsystem.
- A beta **Skirmish vs CPU** mode plays the same skirmish level against a local AI seat
  (or hands both seats to CPUs and spectates):
  `src/ai/` holds the headless agent (perception → strategy → tactics → actuation behind
  `AIController`; only `Game` reads + `GameCommand` writes, so the CPU cannot cheat),
  `src/data/aiProfiles.ts` the difficulty × stance knob table, and `src/game/replay.ts`
  records every match as seed + command log with deterministic re-simulation. Matches run
  on the 1v1 **arena** (`skirmishLevels.ts`): players in opposite corners (`initCoOp`'s
  `diagonal` layout), each corner ore-provisioned with a contested cluster at map centre.
  The Classic macro expands endlessly via a producer/consumer balance model (build more of
  a miner while the buildings burning its output outnumber it) with serfs scaled to the
  economy, paves roads after a quarry, and counters the rival's army mix. Tooling under
  `tools/selfplay/`: `npm run selfplay` races profiles across seeds for win rates,
  `npm run campaign` fans a fixed ladder across cores into a reproducible win-rate matrix,
  and `npm run extract` (`src/ai/dataset.ts`) re-simulates replays into labelled JSONL
  (features → next macro action, the Phase 3 dataset). `docs/skirmish-ai-design.md` tracks
  the phased plan, status, and the open production-line-balance problem.
- A Phase 3 **research spike** adds a tensor-network macro: `src/ai/tensor/` holds a Matrix
  Product State (Born-machine) generative model over whole build-order/army plans, the
  `tensor` policy/profile samples ONE plan per game and executes it through the same seam,
  and `npm run tensor:train`/`tensor:eval` (`tools/selfplay/tensor.ts`) refine it by
  generator-enhanced self-play vs Godlike. The committed cores live in
  `src/ai/tensor/model.ts` (auto-generated). It is a bounded experiment with a
  pre-registered win bar — see `docs/tensor-strategy-poc.md`; the tensor family is
  deliberately NOT used for logistics (`docs/tensor-networks-for-logistics.md`).
- The physical hero unit and functional equipment slots are not implemented yet.
- Combat units include soldiers, archers, knights, and several enemy/wild archetypes.
- Army controls include box/double-click selection, minimap highlighting, groups,
  attack-move, rallies, and grid/line/column/wedge formations.
- Rendering includes unique building architecture/icons, adaptive quality, and ambient
  wildlife, birds, layered sparse clouds, and a distant landscape.

## Before handing off

- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] New balance/content is data-driven.
- [ ] New tunables flow through `Modifiers`.
- [ ] Gameplay randomness uses `simRng`; world generation uses `worldRng`.
- [ ] Deterministic iteration order is preserved.
- [ ] `World` remains Three.js-free and `Game` remains DOM-free.
- [ ] Unrelated user changes are preserved.
- [ ] Documentation is updated when architecture, commands, or shipped status changes.
