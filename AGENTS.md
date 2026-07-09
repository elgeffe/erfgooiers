# AGENTS.md — Erfgooiers

Guidance for AI coding agents working in this repository. Read this before making
changes. For the product/design vision and the phased plan, see [ROADMAP.md](ROADMAP.md);
this file covers *how the code is organized and how to work in it*.

## What this is

A browser **roguelite economy builder** set in Het Gooi, built with **TypeScript +
Three.js** and bundled by **Vite**. A run is a sequence of short, data-driven levels
with a shop between each. It is a Settlers-style logistics sim: every good is physically
carried between buildings by worker units — nothing teleports.

## Commands

```bash
npm install      # install dependencies
npm run dev      # Vite dev server with HMR
npm run build    # tsc --noEmit (typecheck) THEN vite build — use this to verify changes
npm run preview  # serve the production build
```

There is no test suite. **Always run `npm run build` after changes** — it typechecks the
whole project (`tsc --noEmit`) and then bundles. Treat a clean build as the bar for done.

## Architecture

Composition root is [src/main.ts](src/main.ts): it owns the run lifecycle state machine
(`menu → heroSelect → playing → shop → summary`), builds the persistent session objects
once, and rebuilds each level via `startLevel()` / `disposeLevel()`.

| Area | File | Responsibility |
|---|---|---|
| Entry / lifecycle | [src/main.ts](src/main.ts) | State machine, fixed-timestep loop, screen wiring |
| Simulation | [src/game/Game.ts](src/game/Game.ts) | Buildings, sites, units, serf logistics dispatch, production. No DOM, minimal Three.js |
| Modifiers | [src/game/Modifiers.ts](src/game/Modifiers.ts) | The single source of tunables (speeds, times, costs). Every buff/perk/mutator goes through here |
| Objectives | [src/game/Objectives.ts](src/game/Objectives.ts) | Level goal tracking (`stock` / `produce` / `produceMulti` / `collect`) |
| Run/save state | [src/game/RunState.ts](src/game/RunState.ts), [src/game/SaveGame.ts](src/game/SaveGame.ts) | Run + meta state, versioned `localStorage` persistence |
| World | [src/world/World.ts](src/world/World.ts) | Procedural tile map + generation + spatial queries. Holds no Three.js |
| Rendering | [src/render/View.ts](src/render/View.ts), [src/render/models.ts](src/render/models.ts) | Three.js scene, camera, meshes. `View` is asked for/handed meshes by `Game` |
| Input | [src/input/Controls.ts](src/input/Controls.ts) | Camera pan/zoom, placement/road/demolish modes, selection, click-to-collect gold |
| UI (DOM) | [src/ui/UI.ts](src/ui/UI.ts), [src/ui/Shop.ts](src/ui/Shop.ts) | Resource bar, objective card, build menu, inspector, shop |
| Audio | [src/audio/Audio.ts](src/audio/Audio.ts) | Procedural sound effects + per-level mood |
| Data tables | [src/data/](src/data/) | `items.ts`, `buildings.ts`, `levels.ts`, `upgrades.ts` — content lives here |
| Tunable constants | [src/constants.ts](src/constants.ts) | Defaults (map size, walk speed, build time, road stone cost) |
| Types | [src/types.ts](src/types.ts) | Shared interfaces + the `ItemKey` / `BuildingKey` unions |

### Layering rules (keep these clean)

- `World` is pure tile state — **no Three.js imports**.
- `Game` is the sim — **no DOM, no scene bookkeeping** beyond requesting/removing meshes
  from `View`. It emits `toast` / `onSelect` / `onGold` / `sfx` callbacks that `main.ts` wires.
- `UI` and `Shop` are the only DOM owners (plus screen `<div>`s in [index.html](index.html)).

## Core conventions

- **Data over code.** Levels, buildings, items, upgrades are tables in `src/data/`.
  Adding content (a new good, a new production chain, a new level) should mean editing
  data tables + their `ItemKey`/`BuildingKey` unions in [src/types.ts](src/types.ts) — *not*
  special-casing `Game.ts`. If you find yourself branching on a specific building key in
  the sim, prefer expressing it as a generic `BuildingDef` field instead.
- **The modifier system is sacred.** Every buff/perk/mutator/ascension goes through
  [Modifiers](src/game/Modifiers.ts). The sim consults `mods.unitSpeed(u)`,
  `mods.buildTime()`, `mods.gatherTime(def)`, `mods.recipeTime(def)`,
  `mods.buildingCost(def)`, etc. — never raw constants. Upgrades are pure `ModifierSpec`
  data. If a feature can't be a modifier, extend `Modifiers`; don't hard-code.
- **Determinism.** Three named RNG streams in [src/engine/rng.ts](src/engine/rng.ts):
  `worldRng` (generation), `simRng` (gameplay events), `uiRng` (cosmetics). A run seed +
  level index must fully determine a level's map and play. **Never** pull gameplay
  randomness from `worldRng`/`uiRng`, and don't reorder sim iteration — future lockstep
  multiplayer depends on it.
- **Fixed-timestep sim.** `Game.update(dt)` runs at 20 ticks/s via an accumulator in
  `main.ts`; rendering is real-time and independent. `simSpeed` (0/1/3) scales the sim,
  and `simSpeed === 0` is the pause state.
- **Short levels are a feature.** When in doubt, cut scope, not run scope.

## Content recipes

### Add an item
1. Add the key to the `ItemKey` union in [src/types.ts](src/types.ts).
2. Add a def (name, hex color) to `ITEMS` in [src/data/items.ts](src/data/items.ts), and
   add it to `RES_SHOWN` if it should appear in the resource bar.
3. If the storehouse should track it from zero, add it to the `store.stock` init object in
   `Game.init()`.

### Add a building / production chain
1. Add the key to the `BuildingKey` union in [src/types.ts](src/types.ts).
2. Add a `BuildingDef` to `DEFS` in [src/data/buildings.ts](src/data/buildings.ts) and list
   it under a tab in `MENU_CATEGORIES` (the bottom build menu groups buildings by goal;
   roads & demolish are always shown). Buildings are either:
   - **gatherers** (`gather: { node, out, time, range }`) — a specialist walks to a map
     node (`tree`/`stone`/`gold`/`coal`/`iron`/`field`) and returns a good. `fields: true` gives
     the building farm-style crop plots and the `field` node.
   - **producers** (`recipe: { inp, out, time }`) — consume input goods (serfs deliver
     them) and emit an output good.
3. Reuse an existing `ModelKind` (`cottage`/`windmill`/`farm`/`barn`/`mine`) for rendering —
   no new 3D model is needed for new content. `worker` + `wcolor` name/color the specialist.
4. The serf **dispatch** in `Game.ts` is generic: it routes any recipe input from the
   nearest source and hauls any output to the store. New chains work without sim changes.

### Add / change a level
Edit the `LEVELS` table in [src/data/levels.ts](src/data/levels.ts). Each level is
`{ objective variants, world-gen params, starting kit, soft/hard timers, reward }`.
- Objectives: `stock` (hold N now), `produce` (count N production events),
  `produceMulti` (several products at once), `collect` (gold piles). Multiple entries in
  `objectives[]` are picked from deterministically per run.
- **Map difficulty** is driven by world params. Note: only **water**, deposits, roads,
  fields and buildings block placement — trees and decoration do *not* (placing a building
  clears them). So `waterScale` is the main lever for "less buildable space"; raise it on
  later levels to tighten the map. The central build zone is always kept clear.

## Current state

Phase 1's economy roguelite is complete (10 data-driven levels, escalating production
arc, gold + shop, hard-timer fail → Heritage), and the combat layer is in: levels 5–10
are Defend/Hunt/Military/Boss levels. Combat lives in `Game.ts` (fighter behaviors,
projectiles, separation, towers, training) with unit archetypes in
[src/data/units.ts](src/data/units.ts). The military economy runs iron → weaponsmith/
armorer → barracks (soldier/archer/knight, per-unit costs), plus a buildable watchtower.
Player control: box-select, right-click orders with formation spread, control groups
(Shift+1–5 / 1–5), barracks rally flags. Pathfinding is 8-directional A* with
line-of-sight smoothing ([src/engine/pathfinding.ts](src/engine/pathfinding.ts)); units
soft-collide so they never stack. The hero and deeper meta-progression are still to
come — see [ROADMAP.md](ROADMAP.md).

## Guardrails checklist (before you commit)

- [ ] `npm run build` is clean (typecheck + bundle).
- [ ] New content lives in `src/data/` + type unions, not in sim branches.
- [ ] Any new buff/tunable goes through `Modifiers`.
- [ ] No gameplay randomness outside `simRng`; sim iteration order unchanged.
- [ ] `World` stays Three.js-free; `Game` stays DOM-free.
- [ ] Don't add features, refactors, comments or error handling beyond what was asked.
