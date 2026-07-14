# 1v1 Skirmish (beta) — PvP on the co-op stack

Status: **beta prototype, playable** (July 2026). One symmetric map, destroy the rival
storehouse to win, full visibility, zero PvE. This document records what shipped, the
architecture decisions that keep the door open to more players, and the improvement
backlog for taking Skirmish past beta.

## What shipped in the beta

- **Mode flag**: `RoomSettings.mode` gained `'skirmish'` (`src/net/protocol.ts`). The
  host picks *Co-op Expedition* or *1v1 Skirmish (beta)* in the host form; everything
  else (manual WebRTC handshake, host-sequenced commands, hero/colour loadout, ready
  flow) is the co-op path unchanged.
- **Diplomacy as data**: `Game.teams: Record<OwnerId, number>` plus one predicate,
  `Game.hostileOwners(a, b)` — owners on different teams are hostile. The solo/co-op
  default (`p1:0, p2:0, enemy:1, wild:1`) reproduces the old faction rule exactly;
  `startCoopLevel` arms skirmish with `p1:0, p2:1, enemy:2, wild:2`. Every combat
  system (targeting, projectiles, damage retaliation, tower fire, attack-order
  validation in `commands.ts`) now keys off entity `owner`, not `faction`. Gate
  passability is owner-aware too: pathfinding movers are `OwnerId`s and
  `World.gatePass` (installed by `Game`) lets allies through while walling out
  hostile players — co-op allies still share gates, skirmish rivals do not.
- **Level data**: `src/data/skirmishLevels.ts` defines one `LevelDef` (`Border Clash`)
  with no `enemies` block, so the EncounterDirector spawns nothing. `Game.initCoOp`'s
  existing mirrored spawns (28% / 72% of map width on the mid-axis) provide symmetry.
- **Win/lose**: a new `skirmish` objective kind plus `Game.eliminated: Set<PlayerId>`.
  When a player's storehouse falls, `DamageSystem` reports `onCastleLost(owner)`; in
  PvP that records elimination instead of tripping the shared `defeat` flag. Both
  peers resolve the same winner deterministically in `main.ts` (`onSkirmishEnd`);
  hard-timer expiry with both storehouses standing is a draw.

## N-player / teams architecture plan

The beta is two seats, but new code was written so more players is data, not surgery:

1. **The team map is the only diplomacy source.** 2v2, FFA-4, or players-vs-AI-allies
   are just different `setTeams` entries — no combat system changes. Team games get
   allied player seats for free (same team → not hostile → existing co-op behavior).
2. **The remaining choke point is `PlayerId = 'p1' | 'p2'`** (`src/types.ts`) and the
   `PLAYER_IDS` list. Everything downstream is keyed by `PlayerId` Maps
   (`playerStores`, `playerGuilds`, `playerHeroes`, `playerColors`, per-player
   Modifiers, refuge bells, toasts), so widening the union is mechanical. Known
   2-seat literals to sweep when that happens:
   - `Game.initCoOp` places exactly p1/p2 at 28%/72%; generalize to N spawn points
     around the map (data-driven per skirmish map).
   - `main.ts` loops `['p1','p2']` when spawning garrisons/heroes → iterate the room
     roster instead.
   - `RoomSummary.capacity: 2`, lobby ready check `players.length !== 2`, and the
     one-guest manual WebRTC handshake. Direct signaling is pairwise; 3+ players
     realistically wants the server-backed room mode (`server/`, `CoOpClient.ts`)
     re-enabled, with the host relaying or a small mesh.
   - `PLAYER_COLOR_PRESETS` already has more than two colours.
3. **Determinism holds at any seat count** as long as commands stay host-sequenced
   and iteration order stays stable — nothing in the team map affects tick order.

## Known beta quirks / improvement backlog

- **Trade with the enemy**: the co-op Trade tab still works in skirmish, so players
  can gift the rival goods. Harmless but silly — hide the tab / reject trade commands
  between hostile owners.
- **Toast asymmetry**: you get no notification when you damage the rival's economy;
  they see "has fallen" messages. Consider attacker-side combat feedback.
- **Balance**: kit, start army, map density and the 60-minute draw timer are first
  guesses; tune from playtests. Consider small/medium/large map options and a
  worker-rush grace period (e.g. brief spawn-area truce).
- **No fog of war**: full visibility was a deliberate beta cut. If added, it likely
  lives in View/minimap filtering per local player; the sim stays fully informed.
- **Rewards/persistence**: skirmish banks no Heritage or gold; decide whether ranked
  or casual PvP should ever feed meta progression.
- **Pause etiquette**: co-op's host-pause rules carry over; PvP wants either no pause
  or mutual-consent pause.
- **Mirror maps**: world gen is seeded but not literally mirrored; true point-symmetric
  generation would remove terrain luck (deposit/water placement) from the matchup.

## Testing

`src/game/skirmish.test.ts` covers the diplomacy truth tables (co-op default vs
skirmish), attack-order validation flipping with teams, elimination vs shared defeat,
the `skirmish` objective, and auto-acquisition of rival units.
