# Two-player real-time co-op plan

This document proposes the multiplayer work to do first: two allied players undertaking
one Erfgooiers run in real time against the existing PvE simulation. It is deliberately
smaller than competitive multiplayer. Each player owns a separate settlement, economy,
army, hero, resources, gold, and upgrades. They win or lose the Expedition as a team,
and the host is allowed to be the network authority when browsers disagree.

The separate [multiplayer design](multiplayer-design.md) remains a possible future
asynchronous strategy mode. Co-op does not depend on it and should ship first.

## 1. Product scope

### Player experience

The main menu gets a **Co-op Expedition** entry with three paths:

- **Host game** — choose public/unlisted, a room name, optional password, region,
  Expedition difficulty, and run settings. Creating the room produces a short invite
  code and a copyable invite URL.
- **Join by invite** — paste a code or open an invite URL. An unlisted room never needs
  to appear in the browser.
- **Server browser** — list public rooms with name, host, mode, level, region, ping,
  occupancy (`1/2` or `2/2`), password flag, and version compatibility.

The lobby shows both player names, connection/ready state, the chosen settings, and the
invite code. Both players choose a hero, while only the host can start or change run
settings. Starting still requires both players to be ready. Once in a level, both
players build, paint roads and fields, manage production, train units, and command their
own army. Each player's resources, buildings, workers, units, hero, gold, cards, and
shop purchases are private to their settlement. The map, clock, enemies, and team
objective are shared.

Co-op is its own run type, called an **Expedition**. It does not reuse the ten-level
singleplayer campaign unchanged. An Expedition targets four large levels and roughly
60–90 minutes for a successful run: long enough to build two substantial economies,
but short enough to schedule with a friend. Each map should have roughly 1.5–2× the
playable area of a comparable solo level, subject to performance measurements rather
than a hard multiplier.

The four-level arc is:

1. **Foothold** — establish two supply hubs and deliver separate material quotas while
   probing attacks test both approaches.
2. **The Network** — connect distant resource regions, sustain two production chains,
   and protect timed deliveries or caravans.
3. **The Warfront** — hold separated objectives while producing military supplies and
   destroying enemy infrastructure.
4. **The Expedition finale** — a multi-stage siege/boss map requiring logistics,
   reinforcement routes, and simultaneous pressure on more than one front.

These are content directions, not four bespoke branches in `Game.ts`. Add generic,
composable objective data—delivery destinations, simultaneous holds, defended
production, escorts, linked targets, and staged objectives—then define Expedition
levels in a dedicated `src/data/coOpLevels.ts` table. World generation parameters,
starting kits, waves, timers, rewards, and encounter layouts remain data-driven.

For the first playable release:

- exactly two players;
- friends/trust model, with no ranked play or serious anti-cheat;
- Expedition and sandbox use the same networking layer, but sandbox is only the first
  technical vertical slice used to prove it;
- each player chooses and exclusively controls one physical hero; hero effects apply to
  that player's settlement and units unless a definition explicitly declares a team
  aura;
- each player makes their own shop purchases; contracts and the next level are confirmed
  by both players rather than granted to the host as a gameplay privilege;
- simulation speed is fixed at `1x`; the host may pause, and the guest can request a
  pause;
- voice chat, text chat, spectators, host migration, drop-in replacement players, PvP,
  and more than two players are out of scope.

The fixed `1x` rule avoids having one player unexpectedly change the other's cadence
and keeps networking/tick recovery much simpler. A synchronized speed vote can be
considered after the base game is stable.

### Expedition difficulty

Expedition difficulty is separate from solo Ascension. Start with three named presets
(working names: **Journey**, **Erfgooiers**, and **Veldheer**) and keep an internal
numeric tier so more presets can be added later. Difficulty is selected in the lobby
and recorded in the room/run state.

Scaling should create more coordination pressure, not merely inflate health:

- shorter overlap between delivery, defense, and assault deadlines;
- more simultaneous attack lanes and objectives;
- leaner starting stock and longer reinforcement routes;
- stronger enemy compositions, smarter wave combinations, and additional encounter
  stages;
- reduced recovery margin after losing a hub, route, or army;
- only modest HP/damage multipliers where composition and timing are insufficient.

Difficulty tunables flow through `Modifiers` or Expedition level data. Do not scatter
`if (coOp)` branches through the simulation. Balance the baseline for exactly two
players; solo play and dynamic player-count scaling are not v1 requirements.

### Ownership and allied interaction

Every player-created or player-controlled gameplay entity has a `PlayerId` owner.
A player may only place, demolish, staff, prioritize, train from, set rallies for, spend
from, or order entities they own. An ally's settlement and army may be inspected, but
not controlled. Roads are neutral allied infrastructure after construction: either
player can travel over them, while the builder pays the cost and owns demolition.

The host validates and orders commands but has no extra gameplay permissions. If both
players try to build on the same neutral tiles, the first host-accepted placement wins
and the other receives the normal placement rejection. Selection, camera, inspector,
build preview, formation, control groups, audio, and cosmetic effects remain local.
Colored cursors and order pings show what the ally is doing without exposing control.

Current `Faction = 'player' | 'enemy' | 'wild'` checks are not sufficient. Introduce
owner identity separately from diplomatic team: two distinct player owners belong to
the same allied team, while enemy and wild ownership remains hostile according to
relationship rules. Audit every literal `faction === 'player'`, store lookup, combat
query, objective contribution, worker dispatcher, pickup, and UI filter. Do not model
the second player as another enemy-like faction or duplicate the simulation.

### Trade tab and physical shipments

The HUD gets a persistent **Trade** tab. It is the only normal way to move goods between
the two economies; workers may not silently take stock or production output owned by
the ally. The tab contains:

- **Send** — choose an item, amount, source store/trading post, and allied destination;
- **Request** — ask for an item and amount, visible to the ally until fulfilled,
  declined, or cancelled;
- **Incoming / outgoing** — shipment contents, route status, ETA, and any blockage;
- **History** — recent requests, deliveries, losses, and cancellations.

Trade obeys the project's "nothing teleports" pillar. A confirmed send creates a
bounded `TradeShipment`, reserves the sender's goods, and dispatches a visible carrier
or cart between owned storage buildings or dedicated trading posts. Goods enter the
recipient's stock only on arrival. Distance, roads, terrain, and hostile interception
therefore matter. If a caravan is destroyed, cargo drops on the map with explicit owner
or recovery rules; it never reappears magically in either store.

Shipment capacity, loading time, cart speed, and trading-post upgrades are tunable data.
The castle can send and receive small shipments from the start, so trading is never
locked behind a production chain; a trading post makes regular or high-volume exchange
more efficient. Sending ten timber immediately versus investing in a road and waiting
for a full cart should be a meaningful decision visible in the ETA and risk preview.

Requests do not transfer anything and do not reserve the recipient's stock. Fulfilling
a request opens the normal Send form prefilled with its item, amount, and destination.
The sender can reduce the amount before confirming. Cancellation is allowed only before
dispatch; once moving, a shipment may be recalled physically rather than refunded
instantly.

Items are tradable by default. Any exceptions—quest tokens, bound equipment, or other
future content—must be declared in item data. Expedition gold and cards remain personal
and are not tradable in v1, preventing one player from operating both shops through a
resource-transfer shortcut.

Expedition maps should encourage specialization without hard-locking it. Resource
regions, travel distances, biome constraints, and objective timing can make one player
better positioned for food and timber while the other reaches ore or a military front
first. Both settlements must retain a slow fallback path for essential goods so one
lost caravan or disconnected ally cannot create an unrecoverable soft lock. The fastest
strategy should involve planned exchange; trade should not be mandatory busywork every
minute.

### In-game Multiplayer panel

The HUD gets a **Multiplayer** button with a green/amber/red connection indicator. It
opens a non-destructive panel without leaving the level. This panel owns session
management; the Trade tab remains focused on gameplay and resources.

The Multiplayer panel shows:

- room name, invite code, and **Copy invite link**;
- both player names, colors, host/guest network role, connected/reconnecting/offline
  state, and last-seen time;
- local RTT, command backlog, checkpoint age, and a plain-language connection status;
- **Reconnect now**, **Copy invite**, **Leave Expedition**, and host-only **Close room**;
- pending seat-reclaim requests with approve/deny actions for the connected player;
- ready state and pause requests where relevant to the current lifecycle screen.

A transient network problem first triggers automatic reconnection with bounded
exponential backoff while an unobtrusive banner reports the state. Opening the panel
shows details and manual actions. Losing the guest does not stop the host simulation;
the guest's settlement keeps simulating autonomously but remains uncommandable. Losing
the host pauses the authoritative simulation for both players until host authority is
restored.

The invite code remains valid during an active Expedition, not only in the lobby. A
player can return to the main menu, choose **Join by invite**, enter the same code, and
recover the same `PlayerId`, settlement, hero, resources, trade state, and camera entry
point after checkpoint/tail replay. Rejoin must never create a third economy or reset
that player's state.

The invite code is the user-facing route back to the room, but is not sufficient proof
of seat ownership on its own:

- on the original browser, a locally stored reconnect secret silently reclaims the
  matching seat after the code resolves the room;
- on a new browser or after storage loss, entering the invite code creates a
  **Rejoin request** for the disconnected seat; the still-connected player approves it
  in the Multiplayer panel, and the server issues a replacement reconnect secret;
- the replacement invalidates the old secret and preserves the original `PlayerId`;
- if neither player is connected and all reconnect secrets are lost, the invite code
  alone cannot recover the room. This prevents anyone who sees a public/invite code
  from silently taking over a developed settlement.

Room retention must be long enough to survive ordinary browser crashes, Wi-Fi changes,
sleep, and accidental navigation. A disconnected seat stays reserved until its owner
rejoins, the room is explicitly closed, or the room's documented idle-retention period
expires; it is not automatically offered to a new player after a short timeout.

## 2. Recommended network model

Use a **host-authoritative, command-replicated simulation** over a WebSocket relay.

Both browsers generate the same world from the room seed and run the current 20 Hz
fixed-step simulation. Player intent is converted into small serializable commands.
The guest sends commands to the host through the relay; the host validates them,
assigns a sequence number and application tick, applies them, and broadcasts the
accepted command. The host also sends tick heartbeats and periodic state hashes.

This is intentionally not peer-to-peer networking. A browser host cannot reliably
accept inbound internet connections, and WebRTC adds signaling, NAT traversal, relay,
and operational complexity without removing the need for a room service. A single
WebSocket service can provide invites, discovery, relay, presence, and reconnects.

It is also not strict competitive lockstep:

- the host's state is truth;
- a late guest command may be moved to the next safe tick instead of stalling both
  players;
- hash mismatch is telemetry and a repair trigger, not a match-ending error;
- on disagreement, the guest is corrected from a host checkpoint/replay rather than
  asking both peers to agree;
- anti-cheat is limited to schema/rate checks and host validation.

This preserves responsive local rendering and keeps normal traffic to commands and
heartbeats. It also avoids streaming every unit transform every frame. It still needs
deterministic-enough execution between corrections; "desyncs are tolerable" means they
can be repaired, not ignored forever.

### Tick and command flow

1. Host announces `{tick, sequence, monotonicTime}` heartbeats several times per second.
2. A local action becomes a `ClientCommand` with `commandId`, `playerId`, and payload.
3. Host checks room membership, payload bounds, referenced entities, and whether the
   action is currently legal.
4. Host wraps it as `AcceptedCommand {sequence, applyTick, ...}`. Normally `applyTick`
   is a small fixed lead beyond the current host tick.
5. Both peers apply accepted commands in `(applyTick, sequence)` order.
6. The guest gently adjusts accumulator drift to the host clock; it does not skip
   arbitrary simulation ticks.
7. Every few seconds, both peers compute a canonical fingerprint. A mismatch schedules
   correction from the latest host checkpoint plus subsequent accepted commands.

Host-originated gameplay commands travel through the same ordering path as guest
commands. There must not be a local host-only shortcut, because that would create two
different input paths to test.

### Commands, not DOM events

Introduce a pure `src/net/protocol.ts` (or shared workspace package once a backend is
added) containing versioned DTOs. Representative commands are:

```ts
type GameCommand =
  | { type: 'placeBuilding'; key: BuildingKey; x: number; y: number; rot: number }
  | { type: 'paintRoad'; cells: Coord[] }
  | { type: 'placePlots'; buildingId: EntityId; cells: Coord[] }
  | { type: 'demolish'; x: number; y: number }
  | { type: 'setPriority'; siteId: EntityId; priority: boolean }
  | { type: 'queueTraining'; buildingId: EntityId; unit: UnitKind }
  | { type: 'cancelTraining'; buildingId: EntityId; index: number }
  | { type: 'setRally'; buildingId: EntityId; x: number; y: number }
  | { type: 'orderUnits'; unitIds: EntityId[]; order: NetUnitOrder; formation: Formation }
  | { type: 'collectPickup'; pickupId: EntityId }
  | { type: 'setBell'; active: boolean }
  | { type: 'requestTrade'; item: ItemKey; amount: number; destinationId: EntityId }
  | { type: 'cancelTradeRequest'; requestId: TradeRequestId }
  | { type: 'sendTrade'; item: ItemKey; amount: number; sourceId: EntityId;
      destinationId: EntityId; requestId?: TradeRequestId }
  | { type: 'cancelTradeShipment'; shipmentId: TradeShipmentId };
```

Do not put `Unit`, `Building`, mesh, or other object references in protocol data.
Attack orders carry a target entity ID. Road/plot painting is batched into bounded cell
lists to avoid flooding one message per pointer move. The accepted-command envelope
supplies the issuing `playerId`; command validation rejects references to entities that
player does not own, except for explicitly allowed allied destinations and inspections.

`Controls` and `UI` should submit commands through a `CommandDispatcher`. In
singleplayer the dispatcher validates/applies immediately. In co-op it submits to the
host ordering path. This keeps one gameplay implementation and makes command tests
useful outside networking.

## 3. State, identity, and recovery

The current runtime graph is not serializable: `Unit`, `Building`, `Site`, `Tile`, and
related structures contain Three.js objects and direct references to one another.
Networking must not attempt to stringify that graph.

Add stable monotonic entity IDs for gameplay objects and define a render-free
`GameCheckpoint` DTO. References such as worker, builder, home, task endpoints, combat
target, field owner, projectile source/target, rally, and selection are stored in a
checkpoint as IDs or coordinates. Restore occurs in two passes:

1. restore scalar/entity records and rebuild ID maps;
2. resolve cross-references, rebuild tile occupancy/spatial indexes, then ask `View` to
   recreate meshes and cosmetic state.

Mesh creation remains in `View`/`models.ts`; `World` stays Three.js-free and `Game`
stays DOM-free. This does not require an ECS rewrite. A focused serializer/rehydrator
boundary is enough.

A checkpoint includes at least:

- protocol/schema version, content version, room seed, level, biome, and mutators;
- authoritative tick, accepted sequence, sim RNG state, timers, and enemy director
  state;
- mutable world tile state (roads, depleted deposits, trees, fields, sites, buildings,
  pickups);
- all gameplay entities, their owners, and queues;
- both players' stock, reservations, gold, cards, heroes, modifiers, trade requests,
  shipments, cargo, and shipment history;
- team objective progress, level clock, and run state relevant to the current level.

Cosmetic RNG, particles, corpses, selection, camera, audio phase, and ambient wildlife
do not belong in the authoritative checkpoint.

For recovery and reconnect, the server retains the most recent compressed checkpoint
and the accepted command log after it. The host uploads a checkpoint periodically and
at lifecycle boundaries. A rejoining player downloads it, restores both settlements,
replays the tail commands, then resumes as the same `PlayerId`. Local selection and
camera are reset safely; gameplay ownership and resources are not. Limit checkpoint
size and command-log length; never accept an arbitrary unbounded blob without
authentication and validation.

If the host disconnects, the room pauses and advertises that state through the
Multiplayer panel. The host may reconnect through the invite-code flow with its room
credential, or the connected guest may approve a host-seat credential replacement.
This restores the same host authority; it is not host migration. Host migration remains
postponed until checkpoint authority transfer has dedicated tests. The room ends only
when explicitly closed or its documented idle-retention period expires.

## 4. Lobby and relay service

Use TypeScript end to end so protocol types and validators can be shared with the Vite
client. A small Node service with WebSockets and a durable store is the least surprising
development target; the same protocol can later run on a managed edge/WebSocket
platform if desired.

The service is authoritative for rooms and membership, but not for the game simulation.
It owns:

- room creation, invite-code lookup, public room listing, and filters;
- one host seat and one guest seat;
- short-lived join tickets, durable per-seat reconnect credentials, credential rotation,
  and connected-peer-approved seat reclaim;
- WebSocket authentication, presence, heartbeat timeouts, size/rate limits, and relay;
- version compatibility (`protocolVersion`, `contentVersion`, build identifier);
- latest checkpoint and bounded accepted-command tail;
- public metadata updates and idle-room expiry.

Suggested HTTP surface:

```text
POST /v1/rooms                 create room; return host ticket + invite code
GET  /v1/rooms                 paged public browser, filter by region/version/open
GET  /v1/rooms/:code           invite preview without joining
POST /v1/rooms/:code/join      claim guest seat; return guest ticket
POST /v1/rooms/:code/rejoin    secret → ticket, or create seat-reclaim request
POST /v1/rooms/:id/reclaims/:requestId/decision  approve/deny and rotate credential
GET  /v1/health                deployment/build health
WS   /v1/session?ticket=...    presence, commands, lobby state, checkpoint transfer
```

Invite codes are random, human-typable aliases with rate-limited lookup. They locate a
room but are not authentication by themselves. Reconnect credentials are bearer
secrets stored locally per room and are never shown in the browser listing. A reclaim
approval is valid only for a bounded request and invalidates the prior seat credential.
Passwords, if supported in the first deployment, are sent only over TLS and stored as
salted password hashes.

Public browser records contain metadata only—never credentials, checkpoints, IP
addresses, or command logs. Sanitize room/player names, cap lengths, paginate results,
and expire stale lobbies. Production requires HTTPS/WSS, origin checks, sensible CSP,
logging without secrets, and dependency/security updates.

### Local development and deployment

Add a workspace such as `server/` with its own start/test commands and shared protocol
package. The Vite client reads the service URL from an environment variable. Local
development runs Vite and the room service together; tests use an in-memory room store.

Do not commit to Cloudflare, Fly.io, Render, or a VPS until a WebSocket soak test and a
rough bandwidth/storage measurement exist. The service needs long-lived connections,
durable checkpoint storage, regional latency acceptable for two players, and simple
operational logs; choose the deployment that satisfies those measured needs.

## 5. Run lifecycle and progression

The host owns the canonical co-op run save. A room checkpoint is the resume mechanism;
the existing singleplayer `currentRun` save must not silently load into a co-op room.
Store co-op room/reconnect metadata under a separate versioned local-storage key.

Expedition rules for v1:

- host selects Expedition difficulty; each player selects from their locally unlocked
  heroes; hero modifiers affect only their owner unless explicitly marked as team-wide;
- each player owns separate stock, production chains, buildings, workers, army, hero,
  gold, cards, shop inventory, and purchases;
- mutators, enemies, level clock, contract, and victory/failure state are team-wide;
- team objectives may aggregate contributions or contain explicit per-player subgoals;
  objective data must state which behavior applies;
- both players see contract choices and independently ready the same selection; the
  next level starts only when both are ready;
- a disconnected player's settlement keeps simulating but cannot be commanded by the
  ally; it remains available for reconnection and its stock cannot be appropriated;
- goods cross ownership only through physical trade shipments recorded in the command
  log and checkpoint;
- successful level/run completion emits an idempotent reward event keyed by room and
  level so each participating local profile applies Heritage/stat rewards at most once;
- a player must have been present for a minimum participation window to receive meta
  rewards.

Without accounts and a trusted server simulation, local meta rewards can be forged.
That is acceptable for friend co-op and must be documented. Ranked progression would
require authentication and server-authoritative validation and is a different project.

## 6. Implementation milestones

Each milestone has a concrete exit test. Keep singleplayer playable throughout.

### Milestone 0 — decisions and observability

- Freeze the v1 scope above and decide the initial service deployment only after a
  local prototype measurement.
- Add simulation tick and content/build version identifiers.
- Add dev diagnostics for tick, command sequence, RTT, command backlog, hash status,
  checkpoint age/size, and reconnect state.

**Exit:** a documented protocol version policy and useful local diagnostics exist.

### Milestone 1 — deterministic command seam

- Inventory every gameplay mutation reachable from `Controls`, `UI`, shop, and main
  lifecycle code.
- Add `PlayerId` ownership, allied relationship queries, stable IDs, and ID lookup for
  units, buildings, sites, pickups, shipments, and targetable encounter state.
- Replace single-player faction assumptions in economy, combat, objectives, placement,
  selection, modifiers, and UI with explicit owner/team rules.
- Define versioned commands and runtime validation.
- Route singleplayer through `CommandDispatcher`; keep local-only camera/selection out.
- Make command application return a structured accepted/rejected result.
- Remove wall-clock reads from authoritative outcomes (for example, toast throttling
  may stay local but cannot affect whether a road is placed).

**Exit:** scripted commands produce the same results as direct singleplayer actions,
with unit tests for validation, ownership boundaries, allied relationships, placement
conflicts, and malformed IDs.

### Milestone 2 — checkpoint, fingerprint, and replay

- Implement canonical simulation fingerprinting, including RNG and director state.
- Implement checkpoint capture/restore without meshes or DOM objects.
- Rebuild view objects from restored gameplay state.
- Add a command-log replay harness and golden fixtures.
- Test a long economy/combat scenario: checkpoint mid-level, restore, replay, and reach
  the same fingerprint and objective result.

**Exit:** a 20+ minute scripted mixed level can be restored and replayed repeatedly
with matching fingerprints and no leaked/stale render objects.

### Milestone 3 — two-browser local prototype

- Implement host clock, command sequencing, small application lead, guest drift
  correction, hashes, and correction flow behind a development transport.
- Exercise two tabs with artificial latency, jitter, duplication, reordering, and
  disconnects.
- Batch drag commands and cap command rates.

**Exit:** two local tabs can build and command an army for 20 minutes under simulated
network impairment; deliberate guest corruption is detected and repaired.

### Milestone 4 — room service and menu flow

- Add room/invite endpoints, WebSocket sessions, public browser, ready lobby, tickets,
  per-seat reconnect credentials, credential rotation, seat-reclaim approval, storage
  limits, and documented idle expiry.
- Add main-menu Co-op, Host, Join by invite, Server browser, Lobby, and active-room
  invite-code rejoin flow.
- Add the in-game Multiplayer panel, connection indicator/banner, automatic/manual
  reconnect, invite copy, player presence, reclaim approval, leave, and close-room UI.
- Reject incompatible protocol/content versions before joining.
- Add integration tests for seat races, full rooms, guest/host loss, same-browser
  reconnect, invite-code rejoin, approved/denied reclaim, credential rotation, stale
  tickets, invalid messages, pagination, and expiry.

**Exit:** two browsers on different networks can discover or invite, enter a sandbox,
disconnect either peer, recover the same seat through the invite-code flow without
duplicating state, and return cleanly to menu.

### Milestone 5 — two-economy sandbox and trade vertical slice

- Spawn two allied starting settlements with independent stock, workers, buildings,
  armies, heroes, modifiers, gold, and player-scoped HUDs.
- Enforce ownership across every in-level command and prevent cross-settlement worker
  dispatch or spending.
- Add the Trade tab, requests, physical shipments, routing, delivery, interception,
  cargo drops, cancellation/recall, and reconnect restoration.
- Add player colors, remote command pings, latency/connection status, and clear error
  states.
- Run browser end-to-end and WebSocket soak tests; measure bandwidth, command rate,
  checkpoint size, restore time, and server memory per room.

**Exit:** repeated 30-minute public/unlisted two-player sandbox sessions maintain two
isolated economies, complete and lose trade shipments correctly, meet measured budgets,
and recover from guest disconnects without duplicating or transferring stock.

### Milestone 6 — Expedition content and progression

- Add the dedicated four-level Expedition table and the generic composable objective
  features needed by its delivery, simultaneous-hold, defended-production, escort,
  linked-target, and staged goals.
- Add three Expedition difficulty presets through data and `Modifiers`, emphasizing
  coordination, multiple fronts, and recovery pressure over health inflation.
- Network two-player hero setup, personal shops/cards/gold, difficulty, team and
  per-player objective contributions, contracts/readiness, rewards, next-level rebuild,
  defeat, and summary.
- Separate co-op resume state from singleplayer save state.
- Add idempotent participation/reward records and explain the trust limitation in UI.
- Define and test personal versus explicitly team-wide hero effects; never apply one
  player's global solo modifiers to the ally accidentally.
- Balance/playtest map area, timers, travel time, starting kits, enemy fronts, and armies
  with two commanders; prefer data changes
  or `Modifiers` additions over multiplayer branches in `Game`.

**Exit:** two players can complete or lose a four-level Expedition, reconnect across
level boundaries, and receive rewards exactly once without corrupting either local
profile.

### Milestone 7 — release hardening

- Cross-browser matrix, slow-device testing, tab-background behavior, mobile-width menu
  checks, accessibility/keyboard navigation, and localization-safe layouts.
- Abuse controls, schema fuzzing, dependency audit, production observability, backups,
  retention policy, and incident/runbook documentation.
- Publish compatibility and room shutdown behavior.

**Exit:** production can be operated and rolled back safely, and disconnect/version
  errors are actionable to players.

## 7. Test strategy and budgets

Unit tests cover command validation/application, stable IDs, canonical encoding,
fingerprints, clock adjustment, sequence deduplication, room state, and reward
idempotency. Property/fuzz tests feed malformed or reordered commands and checkpoint
records. Integration tests run two headless clients against the real room protocol.
Browser tests cover menu/lobby/reconnect, ownership rejection, Trade tab flows, and
representative placement/trade conflicts. Rejoin tests assert the same `PlayerId`,
entity ownership, stock totals, in-flight shipments, command sequence, and reward
idempotency before and after recovery.

Add explicit measured budgets before release rather than guessing them. Track:

- command messages/second and bytes/second per peer at normal and drag-heavy play;
- p50/p95/p99 command-to-application latency by region;
- checkpoint compressed size, capture time, restore time, and upload interval;
- fingerprint time and guest correction frequency;
- server memory/storage per active/idle room;
- main-thread and frame-time impact on low/medium/high quality settings.

Every implementation milestone still uses the repository completion bar: `npm test`
and `npm run build` must pass. Server work adds its own unit/integration command to the
same root validation workflow.

## 8. Risks and deliberate trade-offs

| Risk | Mitigation / decision |
|---|---|
| Runtime state mixes simulation and Three.js references | Stable IDs plus explicit checkpoint DTOs and two-pass restore; no serialized meshes |
| Hidden nondeterminism causes frequent corrections | Golden replay tests, canonical hashes, host authority, checkpoint repair telemetry |
| Latency makes guest commands feel late | Small tick lead, immediate local previews, nearby region, clear pending/rejected feedback |
| Ownership leaks let one player spend or command the other's economy | Central owner/team authorization in command validation plus exhaustive mutation-path tests |
| Trading bypasses physical logistics or duplicates stock | Reserve once, physical shipment state machine, idempotent delivery, checkpoint/replay tests |
| A long trade route becomes tedious rather than strategic | Clear ETA/risk UI, road bonuses, requests, route feedback, and balance around map travel time |
| Rejoin creates a new seat or duplicates a settlement | Per-seat `PlayerId`, credential rotation, checkpoint restore, and invariant tests across reconnect |
| Invite-code reclaim enables seat theft | Stored secret for automatic reclaim; otherwise explicit connected-peer approval and rate limiting |
| Host closes the tab | Pause, durable room retention, invite-code rejoin, and no host migration in v1 |
| Browser background throttling | Host-loss detection, visible warning, pause/reconnect; do not advertise background hosting |
| Server browser attracts abuse | Sanitization, rate limits, pagination, passwords/unlisted rooms, report/block only if usage warrants it |
| Local progression is forgeable | Friends-only trust statement; no ranked claims without auth and authoritative validation |
| Scope expands toward PvP | Keep two allied owners on one team with shared victory; competitive diplomacy/combat remains a separate design |

## 9. Go/no-go gates

Do not start the public room service until Milestone 3 proves command replication and
repair locally. Do not enable Expedition runs until sandbox sessions demonstrate stable
checkpoints, reconnects, and acceptable performance on maps approaching the intended
size. Do not claim ranked, secure, or competitive multiplayer
without authentication and server-authoritative simulation.

Co-op is ready to ship when two ordinary browsers can host/join from the main menu,
play a complete run with isolated player economies and physical trade, recover a guest
or host disconnect through the Multiplayer panel and invite-code flow without changing
ownership or duplicating stock, reject incompatible builds cleanly, and preserve
singleplayer behavior and saves.
