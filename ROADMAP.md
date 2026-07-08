# Erfgooiers — Roguelite Roadmap

A browser roguelite economy builder. Each **run** starts from nothing: no buildings, no
upgrades, a fresh randomly generated map. You clear a sequence of short **levels** —
economic objectives at first, military ones later — buying upgrades and hero equipment
in a **shop** between levels. Defeat ends the run; you keep only **meta-progress**
(global unlocks) for the next attempt.

This document is both the design reference and the implementation guide. Decisions
already made are marked ✔; open questions are marked ❓.

---

## 1. The core game loop

```
 MAIN MENU ──► HERO SELECT ──► LEVEL 1 ──► SHOP ──► LEVEL 2 ──► SHOP ──► … ──► LEVEL 10 (boss)
                                  │                                              │
                                  └──────────── objective failed / castle lost ──┤
                                                                                 ▼
                                                     RUN SUMMARY ──► meta-currency + unlocks ──► MAIN MENU
```

✔ **Failure model: full run reset.** Failing a level objective (or losing your
castle/hero in military levels) ends the run. The next run starts at level 1 on a new
map. Only meta-currency and global unlocks persist. This keeps early levels relevant —
you replay them with different heroes, drafts, and shop builds.

✔ **Run length: 30–60 minutes.** Early levels are 3–5 minutes, late levels 10–15.
A run is 10 levels; level 10 is a boss. Nothing should ever feel like a 3-hour city
you're afraid to lose.

✔ **Combat: light RTS.** Train soldiers, drag-select or click groups, send them at
targets; units auto-fight in range. No micro abilities. Strategy lives in the economy
and army composition, not in APM.

✔ **Hero: click-to-command.** One instructable hero spawns at your castle. Select,
then click to move / attack / pick up gold / interact. Chosen at run start; carries
equipment bought in the shop.

### Per-level flow

1. **Brief** — objective card: what to achieve, the (soft) time target, the reward.
2. **Play** — fresh generated map; you start with a castle, a small starting kit
   (scaled-down as levels get harder — later levels give more, because objectives need more),
   your hero, and whatever *run upgrades* you've bought.
3. **Resolve** — objective met → gold reward (+ speed bonus) → shop. Objective failed
   (hard timer expired, castle destroyed, hero dead with no revive) → run over.

### What carries over between levels *within* a run

| Carries over | Reset every level |
|---|---|
| Hero + equipped items | The map |
| Gold (shop currency) | All buildings & roads |
| Run upgrades (shop + drafts) | Resource stockpiles (except a defined starting kit) |
| Army? ❓ see §8 | Serfs/workers (respawned from starting kit) |

Rebuilding the economy from scratch each level *is the game* — run upgrades make each
rebuild faster and weirder, which is where the roguelite variety comes from.

---

## 2. Progression layers & currencies

Two currencies, strictly separated — this is the standard roguelite split and it works:

| | **Gold** (in-run) | **Heritage** (meta) — *"Erfgoed"* |
|---|---|---|
| Earned by | Level rewards, speed bonuses, gold piles on the map (hero picks up), selling at the mint | Finishing runs: per level cleared, bonus for bosses/first-clears |
| Spent on | Shop: run upgrades, hero equipment, army units | Global unlock tree between runs |
| On run end | **Lost** | **Kept forever** |

### Run upgrades (bought with gold, lost on run end)

Examples — all implemented as *modifiers*, see §9 Phase 1:

- **Economy:** +20% serf walk speed · serfs carry 2 items · +1 laborer · buildings cost −1 timber ·
  fields grow 30% faster · roads are free · start each level with +4 bread
- **Hero equipment (slots: weapon / boots / trinket):** Boots of Het Gooi (+10% hero speed,
  aura: nearby serfs +15%) · Standard Bearer (soldiers near hero +20% damage) ·
  Golden Sickle (hero can harvest fields) · Lantern (reveals gold piles on the minimap)
- **Military:** soldiers train 25% faster · +10 castle HP · start each level with 2 soldiers

### Global unlocks (bought with Heritage, permanent)

Deliberately mild — meta-progress should *widen options*, not trivialize levels:

- New heroes (see §3), new shop items entering the pool, new building types
- Starting kit +1 serf / +2 timber (small, capped)
- "Reroll the shop once per visit", "drafts offer 4 choices instead of 3"
- Difficulty ascensions after the first win (harder timers, stronger enemies, new mutators)

---

## 3. Heroes

- Hero **selection screen** at run start. Ship with 2–3; unlock more with Heritage.
- Spawns at the castle each level. Click-to-command: move, attack, pick up gold piles,
  interact with map objects (chests, shrines ❓).
- 3 equipment slots (weapon / boots / trinket) filled from the shop. Equipment is the
  hero's identity within a run — think "equipping +10% walk speed".
- Each hero has one **innate perk** that pushes a different playstyle:

| Hero | Innate perk | Pushes you toward |
|---|---|---|
| **The Reeve** | Serfs within 6 tiles of the hero work 20% faster | Economy rushing, hero positioning |
| **The Captain** | Soldiers cost 25% less; hero fights well | Early aggression on military levels |
| **The Pedlar** | +25% gold from all sources; starts with 30 gold | Shop-heavy builds |

- If the hero dies (military levels): respawns at the castle after 30s. If the castle is
  gone too — run over.

---

## 4. Levels & objectives

Levels are data-driven: `objective + map parameters + enemy setup + reward`. The 10-level
arc for v1 (tune numbers in playtesting; timings are *targets*, hard timers sit ~40% above):

| Lvl | Type | Objective (example) | New pressure | Target time |
|---|---|---|---|---|
| 1 | Economy | Stock 8 timber + 4 stone | Tutorialized, tiny map | 3 min |
| 2 | Economy | Bake 6 bread | Full farm→mill→bakery chain | 4 min |
| 3 | Collection | Hero collects 5 gold piles scattered on the map | Map exploration, hero use | 4 min |
| 4 | Economy | Mint 5 coins | Gold+coal chain; deposits are scarce | 6 min |
| 5 | **Defend** | Survive 2 raid waves on your castle | First combat (defensive) | 6 min |
| 6 | Military | Destroy 2 bandit camps | First offense; barracks needed | 8 min |
| 7 | Economy+ | Deliver 20 bread to a caravan **while** raiders harass | Split attention | 8 min |
| 8 | Military | Raid a fortified village (towers) | Bigger army check | 10 min |
| 9 | Military | Destroy the enemy castle (they expand & counterattack) | Full RTS mirror-lite | 12 min |
| 10 | **Boss** | Slay the Dragon of Het Gooi (attacks buildings, must be lured/tanked) | Everything at once | 12 min |

Design rules:

- **Every level has a fail state.** Economy levels use a hard timer (generous early,
  tight later). Military levels fail on castle loss. "The enemy defeats you if you lack
  the skill or the upgrades" — that's the timer and the raids doing their job.
- **Soft timer = bonus gold.** Finish under target time → +50% gold. Rewards speed
  without punishing learners.
- **Map generation scales with the level** (see §9 Phase 0): size, resource density,
  water coverage, enemy camp count are all per-level parameters on top of the seed.
- **Random objective variants** per slot (e.g. level 2 is "bake 6 bread" *or* "stock
  10 planks") so runs don't feel scripted.

---

## 5. Combat (light RTS)

Kept deliberately small — the economy is the game; combat is the exam.

- **Units:** Soldier (sword, melee) and Archer (ranged) only, for v1. Trained at the
  **Barracks** for gold + timber (later: iron chain for upgraded troops ❓).
- **Control:** drag-select box + right-click move/attack; attack-move; units auto-acquire
  targets in range. Group all / group military hotkeys. No formations, no abilities.
- **Stats:** HP, damage, range, speed, attack cooldown. That's it. All modifiable by
  run upgrades.
- **Enemies:** bandit camps (static + patrols), raid waves (spawn at map edge, walk to
  castle), enemy castle (trains its own units on a budget-per-minute), bosses (single
  big unit with building-damage AoE and a simple behavior loop).
- **Buildings can be damaged** (only by enemies — no friendly fire, no demolish grief).
  Castle HP is the loss condition on military levels.

---

## 6. The shop (between levels)

- Appears after every cleared level. Offers **5 slots**: ~2 economy upgrades, ~2 hero
  items, ~1 military (weighted by upcoming level type — the shop before a defense level
  should offer swords).
- Prices scale with level. Leaving with unspent gold is fine (it carries), but there's
  no interest — hoarding shouldn't beat spending.
- **One free draft** alongside the shop: pick 1 of 3 minor upgrades, always. Guarantees
  every level-clear feels rewarding even when the shop rolls badly.
- Reroll button (costs gold; one free reroll is a meta unlock).

---

## 7. Difficulty & the "you will lose" curve

- Levels 1–4 are beatable by anyone who understands the economy. Level 5+ starts
  checking run upgrades. Levels 8–10 require a coherent build (economy fast enough to
  fund an army fast enough).
- After the first win: **Ascension 1..N** (shorter timers, +enemy HP, mutators like
  "gold deposits halved" or "serfs eat double"). This is the long-tail difficulty knob,
  not the base run.
- **Catch-up guardrail:** if a run reaches level 6+ and fails, grant bonus Heritage —
  losing late must never feel like a waste of an evening.

---

## 8. Open design questions ❓

Decide during the relevant phase — don't block earlier work on these:

1. **Does the army carry over between levels?** Proposal: no (rebuild like the economy),
   but a "Muster Rolls" run upgrade lets you carry N soldiers. Turning persistence into
   a purchasable is very roguelite.
2. **Map interactables** beyond gold piles: chests (gold), shrines (temporary buff),
   a wandering trader (mini-shop mid-level)? Cheap variety — Phase 5.
3. **Iron/weapon chain** (mine → smelter → smithy → weapons) as a second military
   resource line, or keep soldiers gold-only? Lean gold-only for v1.
4. **Level branching** — after Phase 5, offer a choice of 2 next-level nodes
   (Slay-the-Spire style): e.g. "hard military, big reward" vs "safe economy, small
   reward". Big agency win, cheap to build once levels are data-driven.
5. **Hunger** — the stat ticks today with no effect. Fold it in as: fed serfs +15%
   speed, starving −25%? Makes bread matter on non-bread levels.

---

## 9. Implementation guide

Current state (for orientation): a Settlers-style economy sim in TypeScript + Three.js.
Simulation in `src/game/Game.ts`, tile world + generation in `src/world/World.ts`,
seeded Lehmer RNG in `src/engine/rng.ts`, A* in `src/engine/pathfinding.ts`, rendering
in `src/render/`, DOM UI in `src/ui/UI.ts`, input in `src/input/Controls.ts`, tunables
in `src/constants.ts`. No combat, no win/lose, no save, no hero yet.

Each phase ends in a playable, committable state. **Playtest after every phase.**

### Phase 0 — Foundations (refactor before features)

> Goal: the app can tear down and rebuild a level, deterministically, with a state machine around it.

1. **Split the RNG into named streams** (`src/engine/rng.ts`): `worldRng(seed)` for
   generation, `simRng` for gameplay, `uiRng` for cosmetics. Today one global stream
   means a cosmetic call order change reshapes the map. A run seed + level index must
   fully determine each level's map: `levelSeed = hash(runSeed, levelIndex)`.
2. **Parameterize `World`** (`src/world/World.ts`): constructor takes
   `{ seed, w, h, treeStands, oreVeins, waterScale, ... }` instead of the fixed `W`/`H`
   from `constants.ts` and implicit densities. Keep `constants.ts` values as defaults.
3. **Make the session rebuildable.** Extract everything `main.ts` does once (World →
   View → Game → Controls wiring) into a `startLevel(params)` / `disposeLevel()` pair.
   Verify: two consecutive levels in one browser session with no leaked meshes or
   listeners (watch `renderer.info.memory`).
4. **Game state machine** — new `src/game/RunState.ts`:
   `menu → heroSelect → playing → shop → summary(defeat|victory)`. The render loop and
   `Game.update()` only tick in `playing`. UI screens are plain DOM overlays like the
   existing `UI.ts` toasts/panels.
5. **Fixed-timestep sim.** Decouple `Game.update()` from the render frame (accumulator,
   e.g. 20 ticks/s, interpolate visuals). Determinism pays off for replays, daily seeds,
   and is a hard prerequisite for future lockstep multiplayer.
6. **Persistence scaffold** — `src/game/SaveGame.ts`: versioned JSON in `localStorage`,
   two documents: `meta` (Heritage, unlocks, stats) and `currentRun` (seed, level index,
   gold, upgrades, hero + equipment) so a closed tab resumes at the current level's start.

**Acceptance:** from a menu, start level 1, press a debug "win" button, land in an empty
shop screen, continue to level 2 on a *different* map, reload mid-level-2 and resume at
level 2's start. Same run seed twice → identical maps.

### Phase 1 — The roguelite skeleton (objectives, gold, shop, modifiers)

> Goal: a full winnable/losable 10-level run, economy objectives only. This is the moment the game becomes a game.

1. **Modifier system** — `src/game/Modifiers.ts`. One object the sim consults instead of
   raw constants: `mods.unitSpeed(u)`, `mods.buildTime()`, `mods.carryCap()`,
   `mods.gatherTime(def)`, `mods.recipeTime(def)`, `mods.buildingCost(def)`.
   Replace direct uses of `BASE_SPEED` (`Game.moveUnit`), `BUILD_TIME`
   (`laborerUpdate`), `CARRY_CAP`/`OUT_CAP` (`dispatch`), `def.cost` (`tryPlace`,
   `placeSite`). Upgrades are then pure data: `{ stat: 'unitSpeed', mult: 1.2, filter: 'serf' }`.
   **This one abstraction is what makes every future upgrade a one-liner.**
2. **Objective system** — `src/game/Objectives.ts`: `ObjectiveDef` variants
   `stock {item, n}`, `produce {item, n}` (count production events, not net stock),
   `collect {n}` (gold piles), later `destroy`/`survive`/`deliver`. Evaluated each tick;
   emits progress for the HUD (persistent objective card + progress bar + timer, in `UI.ts`).
3. **Level table** — `src/data/levels.ts`: the §4 table as data — objective (with
   variants), world-gen params, starting kit, hard-timer, gold reward. Levels 5–10 ship
   as economy placeholders until Phase 3 replaces them.
4. **Gold & gold piles.** Run-level `gold` on the run state (not an item in the
   storehouse — shop currency is meta to the map). World gen scatters gold piles
   (new `Tile.pickup`); serfs auto-collect piles near roads/buildings for now
   (hero takes over this job in Phase 2). Level reward + under-target speed bonus on clear.
5. **Shop screen** — `src/ui/Shop.ts` + `src/data/upgrades.ts`: `UpgradeDef`
   `{ id, name, desc, price(level), pool: 'economy'|'hero'|'military', apply: ModifierSpec }`.
   5 weighted slots + the 1-of-3 free draft + reroll. Bought upgrades → run state →
   `Modifiers` rebuilds. Start with ~10 economy upgrades.
6. **Fail state.** Hard timer expiry → `summary(defeat)`; run summary screen (levels
   cleared, goods produced, gold earned, Heritage awarded — even though Heritage has no
   sink until Phase 4, bank it now).

**Acceptance:** a complete run — 10 economy levels, shop between each, upgrades visibly
compound (serfs measurably faster by level 6), timer can kill the run, summary awards
Heritage. **Playtest hard here; pacing problems found now are 10× cheaper than after combat exists.**

### Phase 2 — The hero

> Goal: a hero you command, who makes the economy game more active.

1. **Castle.** Rename/reskin the starting `storehouse` as the **Castle** (`data/buildings.ts`;
   `Game.store` keeps working as the store). It's the hero spawn, and later the thing
   you must not lose.
2. **Hero unit.** Extend the `Unit` roles with `hero`: no auto-dispatch, has HP,
   distinct model/scale in `render/models.ts`. Spawned by `Game.init()` from the run's
   chosen hero def.
3. **Command input** (`input/Controls.ts`): click hero → select (reuse `selectAt`
   pattern; add unit picking, not just tile→building); click ground → path via existing
   `findPath`/`sendTo`; click pickup/interactable → walk + interact. Selection ring +
   destination flag in the View. Hotkey to snap camera to hero.
4. **Gold pickups become hero work** (replaces Phase 1 serf auto-collect): the
   "collection quest" objective (level 3) now means *using* the hero.
5. **Hero select screen** + `src/data/heroes.ts`: the 3 heroes from §3; innate perks are
   ModifierSpecs (The Reeve's aura = a positional filter on `mods.unitSpeed` — the
   modifier system already supports per-unit evaluation).
6. **Equipment**: 3 slots on run state; shop `hero` pool now sells items; equipping
   applies the item's ModifierSpec. Panel in `UI.ts` showing hero + slots.

**Acceptance:** pick The Reeve, park him next to the woodcutters, watch chop times drop;
finish level 3 by collecting piles by hand; buy boots and feel the difference.

### Phase 3 — Combat & military levels

> Goal: levels 5–10 become real. The biggest phase — split it into three checkpoints.

**3a. Damage & enemies exist**
1. `hp/maxHp` on units and buildings; a `CombatSystem` tick in `Game.update`:
   acquire target in range → cooldown attack → damage → death (mesh removal, task
   cancellation via the existing `cancelTask`/`removeBuilding` paths).
2. Enemy faction: `unit.faction: 'player' | 'enemy'`. Bandit camp = enemy building
   spawning a fixed patrol. Wave spawner (edge of map → walk to castle, attack what blocks them).
3. **Level 5 (defend)** works: survive N waves, lose if castle HP hits 0.

**3b. Your army**
4. **Barracks** building; trains Soldier/Archer for gold+timber over time (queue UI on
   the building panel).
5. **Multi-select & orders** (`Controls.ts`): drag-box screen-space select over unit
   meshes; right-click = move / attack-move (attack-move = stop-and-fight anything in
   aggro radius along the path). Rally point on barracks.
6. **Level 6 (destroy camps)** works.

**3c. Smarter opposition & the boss**
7. Enemy castle AI: budget-per-minute → trains units → attack timer sends squads at you.
   Towers (static high-HP archer) for the fortified-village level.
8. **Boss:** one big unit, phase loop (stomp AoE → target buildings → enrage under 30%).
   Telegraph attacks with decals so deaths feel fair.
9. Wire real levels 5–10 in `data/levels.ts`; military shop pool + military run upgrades.

**Acceptance:** full 10-level run with the §4 arc; losing your castle on level 9 ends the
run and it feels like *your* build's fault, not the RNG's.

### Phase 4 — Meta-progression

> Goal: losing still moves you forward; winning unlocks the next challenge.

1. **Heritage payout** formula (per level cleared, boss bonus, late-loss catch-up from §7).
2. **Unlock tree screen** (DOM): heroes, shop-pool items, starting-kit bumps, QoL
   (reroll, 4-choice drafts). Data-driven in `src/data/metaUpgrades.ts`; persisted in `meta` save.
3. **New-player gating:** first run offers a trimmed shop pool; unlocks introduce
   complexity gradually (this is your tutorial strategy — no separate tutorial needed).
4. **Ascension 1–5** after first win: per-ascension mutator list applied as (surprise)
   ModifierSpecs on the enemy/timer side.

### Phase 5 — Fine-tuning & juice

- **Level node choice** (§8.4): pick 1 of 2 generated next levels. Do this early in the
  phase — it's the single biggest agency win left.
- Map interactables: chests, shrines, wandering trader (§8.2).
- Objective variants per slot; 2–3 map biomes as gen presets (marsh: more water; heath:
  fewer trees, more ore).
- **Daily run:** date-derived seed + fixed mutators, local best score.
- Run stats & achievements on the summary screen ("no roads", "pacifist until level 7").
- Sound (chop/hammer/coin/combat ticks, ambient birds), hit flashes, death particles,
  minimap. Hunger effect (§8.5).
- **Balance pass with data:** log level times + fail points (localStorage is fine);
  tune the §4 timer/reward table against real numbers.

### Phase 6 — Future: multiplayer (not scheduled)

Design intent only — decisions above deliberately keep the door open:

- **Cheap first steps (no backend):** shareable run-seed links; async score race on the
  same daily seed.
- **Later, needs a tiny backend:** leaderboards; ghost timelines ("your friend cleared
  level 4 at 12:30").
- **True co-op** (two heroes, shared economy) requires deterministic lockstep — which is
  why Phase 0 insists on fixed timestep + strictly seeded, stream-separated RNG and
  strictly ordered sim iteration. Protect those invariants in code review even before
  multiplayer exists.

---

## 10. Guardrails (read before every phase)

- **Data over code:** levels, upgrades, heroes, enemies are tables in `src/data/`.
  Adding content must never mean touching `Game.ts`.
- **The modifier system is sacred.** Every buff/perk/mutator/ascension goes through
  `Modifiers`. If a feature can't be expressed as one, extend `Modifiers`, don't special-case.
- **Short levels are a feature.** When in doubt, cut level scope, not run scope.
- **Determinism:** same seed → same map, always. New `rnd()` call sites in worldgen must
  use the world stream and note the reproducibility comment in `rng.ts`.
- **Fail forward:** every defeat screen shows Heritage earned and one thing unlocked or
  progressed. Nobody closes the tab on a zero.
