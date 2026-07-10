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
- Soldier, archer, and knight training; enemy camps, keeps, towers, waves, wildlife,
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
remaining milestones live in [ROADMAP.md](ROADMAP.md).
