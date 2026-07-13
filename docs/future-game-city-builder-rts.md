# Future game concept: city-builder logistics RTS

_Concept note recorded 13 July 2026._

## Vision

Build a separate browser game that combines Erfgooiers' physical city-building
and logistics loop with large-scale modern, near-future, science-fiction, First
World War, or Second World War combat.

The long-held inspiration is the pace, clarity, and spectacle of RTS's of the past, reimagined around our own distinctive gameplay loop:
military power is not purchased from an abstract resource counter. It emerges
from a functioning settlement whose workers physically extract, manufacture,
transport, store, fuel, repair, and deliver everything the army needs.

This should be an original game, not a recreation of another game's factions,
units, story, art, maps, or terminology.

## Core fantasy

The player is both city planner and battlefield commander. Roads, railways,
power, industry, housing, food, fuel, ammunition, spare parts, and communications
form a living war economy. A beautifully optimized city can sustain a powerful
front; a severed bridge, bombed refinery, traffic jam, or raided convoy can
collapse it.

Combat and construction continuously affect one another:

- civilian growth creates labor, tax income, research, and industrial capacity;
- factories consume physically delivered inputs and produce real equipment;
- depots, ports, railheads, pipelines, and convoys connect industry to armies;
- units consume fuel and ammunition and require maintenance or replacement;
- terrain, infrastructure, air power, artillery, and supply lines shape the
  battlefield as much as direct unit control;
- captured or destroyed infrastructure changes the economy instead of merely
  changing a score.

The result should retain immediate, readable RTS control while making logistics
and urban planning the strategic heart of the game.

## Possible settings

The engine and loop should remain setting-agnostic until a prototype identifies
the strongest identity:

- **First World War:** rail logistics, artillery supply, trenches, attrition,
  field hospitals, and industrial mobilization;
- **Second World War:** combined arms, fuel constraints, factories, railheads,
  ports, airfields, and mobile fronts;
- **Modern or near-future:** power grids, electronics, drones, precision weapons,
  communications, global trade, and vulnerable high-tech supply chains;
- **Science fiction:** expandable colonies, exotic resources, automated
  logistics, shields, orbital infrastructure, and asymmetric factions.

A fictional modern or near-future setting may offer the best balance: it can
capture the energy of a fast military RTS without inheriting real-world faction
politics or another franchise's intellectual property.

## Why the Erfgooiers foundation fits

Erfgooiers already demonstrates that a deterministic TypeScript simulation can
run physical workers, production chains, pathfinding, formation movement,
combat, procedural worlds, rendering, UI, saves, and multiplayer sequencing at
excellent browser performance. Its data-driven content and separation between
simulation, world, rendering, and UI make the underlying ideas highly adaptable.

Useful foundations include:

- physical source-to-destination hauling and reservations;
- generic recipes, storage, construction, and resource chains;
- deterministic fixed-step simulation and seeded randomness;
- A*, shared flow fields, formations, orders, and spatial indexing;
- scalable Three.js rendering and browser-first deployment;
- command-based simulation mutations suitable for replay or multiplayer work.

The future project should reuse proven concepts and selectively extract generic
engine code. It should not force modern warfare into Erfgooiers' repository or
turn this project into a multi-game framework prematurely.

## First prototype

Create one small vertical slice in its own repository:

1. Build a town with housing, power, a mine or importer, refinery, factory, and
   depot.
2. Physically produce fuel, ammunition, and one vehicle type.
3. Supply a small combined-arms force through trucks or a railhead.
4. Defend the town, then attack an enemy logistics hub.
5. Let destroyed roads, depots, power generation, and convoys visibly affect
   production and combat readiness.

The prototype succeeds if managing the city and disrupting logistics are as fun
and consequential as commanding units. Visual scale, faction count, campaign
structure, setting, and deeper technology can follow only after that loop works.

## Repository boundary

This game will receive its own repository, product identity, roadmap, content,
and visual language. Erfgooiers remains focused on its historical-fantasy
roguelite. Reusable engine pieces should be copied or extracted only when the
new prototype needs them and their shared API is proven by both games.

