# Pushing Erfgooiers to the Limit — Massive Tactical Sandbox, Tight Strategic Runs

The goal: **one simulation, two experiences.**

- **Sandbox** becomes an Age-of-Empires-style *tactical* theatre: massive maps,
  multiple AI lords, standing armies, sieges, walls, scouting — a game you lose
  because your army was in the wrong place.
- **Runs** stay (and get sharper as) a *strategic* roguelite: small deterministic
  maps, brutal clocks, draft decisions in the shop — a game you lose because you
  built the wrong economy three levels ago.

Both are the same `Game`/`World`/`Modifiers` sim. Everything below is framed as
what the sandbox needs on top, what the runs need trimmed down, and what the
engine must survive.

---

## 1. What "massive with tactical gameplay" means for the sandbox

### 1.1 Map & population scale

| Today | Target |
|---|---|
| 48–100 tiles/side | 128 / 160 / 192 ("Continental") |
| ~30–60 units typical, 11k hard cap | 400–800 living units routine, 2000 in battles |
| one player + scripted enemies | 1–3 AI lords with **real economies** |

### 1.2 The tactical toolkit (player-facing)

- **Walls, gates & towers as a defensive line.** Buildable palisade → stone wall
  progression, 1×1 segments drag-placed like roads; gates that open for your
  faction. Watchtowers snap onto walls. This is the single biggest unlock for
  tactical play: chokepoints become *player-made*, not just worldgen passes.
- **Stances & smarter orders.** Per-squad stance (aggressive / hold ground /
  no-attack), patrol routes, waypoint queues (shift-click), and a proper
  *retreat* order. Formations exist (grid/line/column/wedge) — stances make
  them matter.
- **Counters, not just stats.** A light rock-paper-scissors layer: spears/lancers
  bonus vs cavalry, cavalry bonus vs siege & archers, siege bonus vs buildings &
  massed infantry (splash), towers weak to trebuchets. Expressed as
  `bonusVs: Partial<Record<UnitClass, number>>` on `UnitDef` — pure data.
- **Garrisoning everywhere.** The castle bell was step one. Next: garrison
  fighters in towers/keeps (adds arrows), villagers in any stone building;
  ungarrison ejects at the door.
- **Scouting & fog of war.** Explored/visible/hidden tri-state per tile, revealed
  by unit sight radii. Cheap at our fidelity: a per-chunk alpha overlay on the
  ground mesh + hiding enemy meshes outside vision. The minimap becomes an
  actual intelligence tool (already draws units & alerts).
- **Attack alerts + minimap pings** ("your quarry is under attack!") with a
  hotkey to jump to the last event (space in AOE).
- **AI lords.** Each AI runs the same economy sim: serfs, production chains,
  training queues. Behaviour = a simple state machine per lord (expand → arm →
  raid → siege) with personalities (turtler, rusher, boomer). They should lose
  fights they deserve to lose — no cheating resources at normal difficulty.
- **Victory conditions for sandbox:** conquest (raze all keeps), wonder-style
  ("hold 3 relic sites for 10 min"), or endless. Chosen on the setup screen.

### 1.3 Engine program (what must be true to survive it)

Ordered so each step unlocks the next; perf budget: 20 tps sim + 60 fps render
with 800 units on a 160² map, mid-range laptop.

1. **Instanced unit rendering.** Units are already baked single meshes; move to
   `InstancedMesh` per (role, palette) with per-instance matrix + color. 800
   units ≈ a dozen draw calls instead of 800. Corpses likewise.
2. **Flow-field / hierarchical pathfinding.** Per-unit A* dies around ~200
   simultaneous movers on 160². Group orders should compute **one** flow field
   per destination (or HPA* clusters aligned to the existing 8×8 chunks) and let
   the squad share it. Keep A* for lone units.
3. **Sim LOD ("off-screen thrift").** Far-from-camera units update hunger &
   position at 1/4 tick rate; combat always full rate. The spatial hash already
   exists to partition this.
4. **Chunked everything.** Scenery chunks exist; extend to ground recolors and
   minimap redraws (dirty-chunk only). Deposit/tree lookups per chunk instead of
   full-map scans in `growthUpdate`.
5. **Worker-thread sim (stretch).** The sim is already DOM-free by design
   (AGENTS layering rules pay off) — move `Game.update` into a Web Worker with a
   command/event queue if tick cost exceeds ~8 ms.

### 1.4 Sandbox setup screen grows

Size tiers up to Continental, AI lord count & personality, victory condition,
starting age (bare start vs. established town), reveal-map toggle, unit cap.

---

## 2. What "tighter strategic gameplay" means for runs

Runs deliberately do NOT get the full tactical toolkit. Their identity is
*decisions under a clock*, and the tactical layer stays simple enough that the
strategic layer (what to build, what to buy, which contract to sign) dominates.

- **Small maps stay small.** 36–76 tiles is right. The frontier pass IS the
  tactical puzzle; you don't out-micro it, you out-produce it.
- **Sharper decision points, less busywork.**
  - Contracts keep growing as the run's "map": add rare *opportunity* contracts
    (double reward, no curse, but a nastier objective).
  - One **battle plan** choice before each combat level (e.g. "towers cost −2
    stone" vs "start with +2 lancers" vs "+90 s clock") — a mini-draft that makes
    army composition a strategic, not tactical, decision.
  - Cap sim speed at 3× but make *waiting* rarer: tighter timeTargets, richer
    speed bonuses (the reckoning already rewards this).
- **Counters apply, micro doesn't.** The same bonus table works in runs, but
  stances/patrols stay sandbox-only. Composition + positioning before the fight
  is the skill.
- **Legible defeat.** Every loss should point at a decision: the summary should
  name the proximate cause ("castle fell to the 2nd wave — no towers stood") —
  data we already have via `onDefeat` reasons; extend with a one-line coroner.
- **Determinism guard.** Runs must stay seed-reproducible (replays, dailies
  later). The sandbox may relax this; runs never do. A "daily contract" (fixed
  seed, global leaderboard-of-honour screenshot) becomes possible for free.

---

## 3. Sequencing (proposed)

| Phase | Sandbox | Runs | Engine |
|---|---|---|---|
| S1 | walls/gates, garrisons in towers | counter table applies | instanced units |
| S2 | stances, waypoints, alerts, 128² maps | battle-plan pick before combat levels | flow fields |
| S3 | fog of war, 1 AI lord, conquest victory | defeat coroner, opportunity contracts | sim LOD, chunked scans |
| S4 | 3 AI lords + personalities, 192² Continental, wonder victory | daily contract | worker-thread sim if needed |

Each phase ships playable; nothing depends on a later phase to feel complete.

---

## 4. Non-goals (for now)

- Naval units, trade carts between AI lords, diplomacy trees — fun, but each is
  its own project; park until S4 lands.
- Multiplayer. The deterministic sim makes lockstep *possible* later; do not pay
  for it before the single-player scale program is done.
- Realistic elevation/terrain height. The board aesthetic is flat-with-props;
  hills stay visual (biomes) and strategic (impassable ridges), not ballistic.
