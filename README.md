# Erfgooiers

Erfgooiers is a browser roguelite economy builder set in Het Gooi. Build short-lived
Settlers-style settlements, route physical goods through production chains, survive
raids, and turn the resulting economy into an army. A run spans ten procedural levels
with shops and contract choices between them; defeat ends the run, while Heritage
unlocks persist.

## Current game

- Ten data-driven levels: four economy scenarios, a defense, a hunt, three frontier
  assaults, and a dragon boss.
- Physical logistics: serfs carry every input, output, and construction material.
- Food, timber, stone, coin, wine, meat, fish, and iron/weapon/armor production chains.
- Soldier, pikeman, archer, and knight training; anti-cavalry counters; enemy camps, keeps, towers, waves, wildlife,
  demons, and a dragon.
- Box selection, double-click type selection, control groups, attack-move, rally points,
  and grid/line/column/wedge formations.
- Run upgrades, hero rule sets, cursed/elite contracts, Heritage unlocks, and three
  Ascension tiers.
- Seeded procedural maps, versioned local saves, sandbox mode, procedural audio, a
  minimap, distinct building models, and ambient wildlife/scenery.

“Hero” currently means the rule set chosen at the start of a run. A physical,
commandable hero unit and equipment interactions are planned; see [ROADMAP.md](ROADMAP.md).

## Run locally

Requires a current Node.js release with npm.

```bash
npm install
npm run dev
```

Vite prints the local URL. Other useful commands:

```bash
npm test       # Vitest unit tests
npm run build  # TypeScript typecheck, then production bundle
npm run preview
```

## Deploy to itch.io

The `Deploy to itch.io` GitHub Actions workflow can be started manually from the
repository's Actions tab. Before running it:

1. Create the itch.io project under the `elgeffe` account.
2. Add its Butler API key as a repository Actions secret named `BUTLER_API_KEY`.
3. Run the workflow, changing the default `erfgooiers` project slug if necessary.

The workflow tests and builds the game with relative assets, then pushes `dist` to
the project's `html5` channel. After the first upload, set the itch.io project kind to
HTML and mark that upload as playable in the browser.

## Controls

| Action | Control |
|---|---|
| Pan camera | WASD, arrow keys, or right/middle drag |
| Zoom | Mouse wheel |
| Place building | Choose a build card, then left-click |
| Rotate placement | R or the on-screen rotate button |
| Paint roads/plots | Select the tool, then click-drag |
| Select fighters | Left-drag a box |
| Select visible units of one type | Double-click a fighter |
| Move / attack-move | Right-click terrain |
| Attack a target | Right-click an enemy |
| Set formation | Formation picker shown for multi-selection |
| Save / recall squad | Shift+1–5 / 1–5 |
| Set barracks rally point | Select barracks, then right-click terrain |
| Pause | Space |
| Cancel tool | Escape |

## Technology and structure

The game uses TypeScript, Three.js, Vite, and Vitest. Simulation runs at a fixed 20 Hz;
rendering and ambience run independently. Fresh run seeds come from Web Crypto when
available, while each level is replayable through separated deterministic world,
simulation, and cosmetic RNG streams.

Key areas:

- `src/main.ts` — lifecycle and screen composition
- `src/game/` — simulation, objectives, modifiers, run/save state
- `src/world/` — procedural tile world with no rendering dependency
- `src/render/` — Three.js view, model builders, effects, and ambience
- `src/input/` — camera, placement, selection, formations, and orders
- `src/ui/` — HUD, shop, icons, and menus
- `src/data/` — buildings, items, levels, units, heroes, upgrades, and mutators
- `src/engine/` — RNG, pathfinding, and pure formation layout

Contributor and agent conventions live in [AGENTS.md](AGENTS.md). Product direction and
remaining milestones live in [ROADMAP.md](ROADMAP.md). The first multiplayer slice is
documented in [docs/co-op-design.md](docs/co-op-design.md): a host-authoritative four-level
two-player PvE Expedition with independent economies connected by physical trade, invites,
and direct WebRTC play. The GitHub Pages build uses encrypted manual invite/join codes and
explicit host admission, so it needs no application or relay server. The existing Node room
service and public browser are retained but disabled for a later server-backed mode. Direct
play uses public STUN only for route discovery and may not connect through strict symmetric
NATs, because browser-only mode deliberately has no TURN relay. Share codes are compressed
before encryption to keep the manual exchange compact. Host and guest separately share and
compare a six-digit verification code before admission to detect a substituted response.
The physical hauling contract,
including demand priorities,
reservations, and storage fallback, is documented in
[docs/logistics-engine.md](docs/logistics-engine.md).
