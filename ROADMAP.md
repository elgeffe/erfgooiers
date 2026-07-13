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
  plots, production timing, and configurable physically supplied surplus-export markets
  with neutral caravans and hauled coin proceeds.
- Objectives: stock, produce, multi-produce, collect, survive, slay, and destroy.
- Gold rewards, speed bonuses, five-card run inventory, rarity, shops, drafts, rerolls,
  and hero-exclusive cards.
- Contract choice between safe, cursed, and elite versions of the next level.
- Heritage shop, permanent upgrades, unlockable hero rule sets, lifetime statistics,
  and Ascension A1–A3.

### Combat and control

- Player infantry, cavalry, siege engines, and monastery-trained healing priests; bandits,
  boars, wolves, orcs, trolls, demons, undead, and a dragon.
- Unit/building HP, melee and ranged combat, projectiles, towers, training queues,
  rallies, enemy waves, camps, commanders, strongholds, and boss behavior.
- Eight-directional A* with line-of-sight smoothing and deterministic soft separation.
- Box select, visible-type double-click select, minimap selection highlighting,
  right-click orders, 360-degree hold-to-aim, attack-move, five control groups, and four formations.

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

### 5. Two-player real-time co-op Expeditions

Co-op is the first multiplayer target: a dedicated four-level Expedition with much
larger maps, multi-front objectives, and its own difficulty presets. Two allied players
each own a settlement, workers, resources, production chains, army, hero, gold, cards,
and shop while sharing the map, enemies, objectives, and Expedition outcome. The host
is authoritative for networking, while a small WebSocket room service provides
host/invite, public server browsing, relay, presence, checkpoints, and reconnects.

Shipped (first playable slice):

- Versioned gameplay commands with stable entity IDs; singleplayer and co-op share one
  command-application path with per-player ownership validation.
- The Node room service (rooms, invites, public browser, relay, presence, reconnect
  credentials, seat reclaim) plus the main-menu Host / Join by invite / Server browser /
  Lobby flow and the in-game Multiplayer panel.
- Two fully separate player economies on one map: stores, workers, dispatch, training,
  bells, roads, demolition, and player-scoped HUD.
- The Trade tab with requests and physical, interceptable cart shipments — reserve on
  send, deliver on arrival, recall physically, lose cargo with the cart.
- Four data-driven Expedition levels with three difficulty presets (Journey /
  Erfgooiers / Veldheer) routed through `Modifiers`; both-ready lobbies auto-start from
  a shared seed, raids target either castle, defeat ends the run for both, and a
  disconnected peer freezes rather than drifting.
- Fixed `1x` speed, strict ownership, shared team victory, and no host migration.

Still to build before co-op is release-ready:

- Canonical fingerprints plus render-free checkpoints/replay so a drifted or rejoining
  guest is corrected mid-level (today a mid-level rejoin waits for the next level and
  long sessions rely on both sims staying in step).
- Tick-aligned command application under measured latency/jitter (commands currently
  apply on receipt in server order).
- Per-player heroes, shops, cards, contracts, participation rewards, and co-op resume
  saves; scale difficulty through fronts and logistics before HP inflation.

The staged architecture, protocol, recovery model, security boundaries, risks, and exit
criteria are documented in [docs/co-op-design.md](docs/co-op-design.md).

## Future

- Async daily/seed leaderboards and friend score races.
- Additional heroes, cards, buildings, enemies, biomes, and Ascension tiers.
- Competitive/asynchronous multiplayer remains future work after co-op; see
  [docs/multiplayer-design.md](docs/multiplayer-design.md).

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
