# Erfgooiers roadmap

This is the product and technical roadmap for Erfgooiers, a short-run browser roguelite
about physical logistics, production chains, and light RTS combat in Het Gooi.

Status markers: **Shipped**, **In progress**, **Planned**, and **Future**.

## Product pillars

1. **Nothing teleports.** Goods, construction materials, and production inputs move
   through visible workers and routes.
2. **Rebuilding is the run.** Every level starts a fresh settlement; run upgrades make
   each rebuild faster, stranger, or more specialized.
3. **Economy first, combat as the exam.** Army strength should be the consequence of a
   functioning economy rather than high-APM unit micro.
4. **Short levels, meaningful loss.** A full run is ten escalating levels. Gold and run
   cards are lost on defeat; Heritage and unlocks persist.
5. **Seeded and data-driven.** Content lives in tables, and a run seed plus level index
   determines the map and simulation.

## Current run

```text
Menu → hero rule-set selection → level → shop + next contract → … → level 10 boss
                                     ↘ failure → summary → Heritage → menu
```

| Level | Type | Current objective |
|---:|---|---|
| 1 | Economy | Bread or timber production |
| 2 | Economy | Mint the first coins |
| 3 | Economy | Run bakery and winery chains together |
| 4 | Economy | Larger coin plus food/wine economy |
| 5 | Defend | Muster an army and survive two triggered raids |
| 6 | Hunt | Slay boars among roaming wolves |
| 7 | Military | Cross a frontier pass and destroy bandit camps |
| 8 | Military | Assault a fortified village and towers |
| 9 | Military | Break an enemy keep guarded by a demon |
| 10 | Boss | Slay the dragon while late raids arrive |

## Shipped

### Foundations

- Rebuildable `menu → heroSelect → playing → shop → summary` lifecycle.
- Fixed 20 Hz simulation with real-time rendering.
- Versioned run/meta saves in `localStorage`, continue, clear-save, and sandbox flows.
- Web Crypto entropy for fresh run seeds with a PRNG fallback.
- Deterministic `worldRng`, `simRng`, and `uiRng` streams per seeded level.
- Parameterized procedural maps with water, ponds, forests, deposits, meadows,
  mountains, ruins, frontier regions, roads, and fields.

### Economy and roguelite

- Generic gatherer/producer dispatch with physically carried goods.
- Construction sites, laborers, specialist staffing, worker hunger, taverns, roads,
  plots, and production timing.
- Objectives: stock, produce, multi-produce, collect, survive, slay, and destroy.
- Gold rewards, speed bonuses, five-card run inventory, rarity, shops, drafts, rerolls,
  and hero-exclusive cards.
- Contract choice between safe, cursed, and elite versions of the next level.
- Heritage shop, permanent upgrades, unlockable hero rule sets, lifetime statistics,
  and Ascension A1–A3.

### Combat and control

- Player soldiers, archers, and knights; bandits, boars, wolves, orcs, trolls, demons,
  and a dragon.
- Unit/building HP, melee and ranged combat, projectiles, towers, training queues,
  rallies, enemy waves, camps, commanders, strongholds, and boss behavior.
- Eight-directional A* with line-of-sight smoothing and deterministic soft separation.
- Box select, visible-type double-click select, minimap selection highlighting,
  right-click orders, attack-move, five control groups, and four formations.

### Presentation

- Distinct architectural models and build-menu icons for every building.
- Shared resource iconography across the HUD, costs, inventories, and training UI.
- Cel shading, outlines, shadows, health bars, corpses, procedural audio, and adaptive
  renderer quality.
- Ambient fish, pigs, colored cats, pond frogs, meadow wildlife, birds/flocks/eagles,
  layered sparse clouds, and a patchwork horizon landscape.

## In progress: stabilization and architecture

The current architecture is healthy for a project of this size: world state, simulation,
rendering, input, UI, data, and modifiers have explicit boundaries. Focused cleanup has
removed duplicated building visual identities, made stock initialization derive from the
item table, and extracted formation layout into a pure tested engine module.

The two largest implementation files, `Game.ts` and `render/models.ts`, are intentionally
not being split solely by line count. Extract a subsystem only when it has a stable API,
independent tests, or multiple consumers. Likely future seams are:

- combat/enemy director state from `Game.ts`;
- building model builders from general unit/prop models;
- ambience lifecycle from `View.ts`.

These are refactor candidates, not blockers. Avoid a framework or ECS migration unless
profiling or feature work demonstrates a concrete need.

## Planned milestones

### 1. Physical hero and equipment

The current hero selection is a run-wide modifier/archetype choice; it does not spawn a
commandable hero character yet.

- Add a physical hero unit with HP, selection, movement, combat, and castle respawn.
- Give the hero active map work: direct gold pickup and interactables.
- Turn the existing equipment slots into weapon/boots/trinket items with visible UI and
  modifier effects.
- Decide the military-level failure rule when hero and castle are both lost.

### 2. Level and objective depth

- Add hybrid objectives such as deliver-to-caravan, defend-while-producing, and escort.
- Add chests, shrines, and a wandering trader as seeded map interactables.
- Add biome presets rather than only scaling world-generation numbers.
- Tune timers, starting kits, rewards, and enemy counts from recorded playtest results.

### 3. Combat readability and enemy depth

- Improve attack telegraphs, focus-fire feedback, projectile readability, and boss phases.
- Add clearer enemy intent and wave previews without removing surprise.
- Review formation cohesion, path congestion, tower balance, and late-level army costs.
- Extract combat/enemy modules when those behaviors need independent tests.

### 4. Accessibility and polish

- Rebindable controls, UI scaling, reduced motion, color-vision-safe resource cues, and
  keyboard navigation for menus.
- Better tutorialization of staffing, plots, formation controls, and contract risk.
- Performance budgets for large maps and armies; profile before further optimization.
- Daily seeded runs, shareable seed links, achievements, and run-history summaries.

## Future

- Async daily/seed leaderboards and friend score races.
- Additional heroes, cards, buildings, enemies, biomes, and Ascension tiers.
- Co-op only after deterministic simulation order, serialization, and lockstep recovery
  have dedicated tests. Multiplayer is not currently scheduled.

## Open decisions

1. Do any trained units carry between levels, or only through a run card?
2. Should physical hero death cause a timer, a direct fail, or depend on castle state?
3. Which two hybrid objectives best improve levels 3–7 without extending run length?
4. Should daily runs fix the hero and contract path, or only the seed?

## Guardrails

- Content and balance live in `src/data/`; simulation code stays generic.
- Every buff, curse, hero rule, and permanent upgrade flows through `Modifiers`.
- World generation never imports Three.js; simulation never touches the DOM.
- Gameplay randomness uses `simRng`; map generation uses `worldRng`; cosmetic layout
  uses `uiRng`. Fresh entropy chooses a run seed but never replaces seeded simulation.
- Preserve deterministic iteration order and the fixed timestep.
- Prefer tests around extracted pure logic; do not refactor only to reduce line counts.
- Short levels are a feature.
