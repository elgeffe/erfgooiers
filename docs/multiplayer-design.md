# Erfgooiers Grand Skirmish — asynchronous turn-based multiplayer

> This is a separate future competitive/strategy concept. The nearer-term multiplayer
> priority is [two-player real-time co-op](co-op-design.md), using a host-authoritative
> shared PvE simulation, invite codes, and a public server browser.

A solution design for a multiplayer game type built from the pieces Erfgooiers
already has: the sandbox generator, the deterministic simulation, heroes, and
the army layer. It is **not** real-time co-op (see ROADMAP's caveats about
lockstep); it is a *turn-based grand-strategy mode* that plays like
correspondence chess: browser-based, asynchronous, and playable by two to six
players who are rarely online at the same time.

The genre recipe, in one line:

> Civilization's turn cadence · Baldur's Gate 3's free-but-budgeted movement ·
> an auto-chess battle whenever armies meet · heroes/generals as aura pieces ·
> all on a shared sandbox map.

---

## 1. What a match looks like

1. **The host creates a match** from the sandbox setup screen — the exact
   options that exist today (map size, biome, water, map resources, starting
   stock) plus player count. `enemies` is replaced by the other players (with
   optional neutral camps as terrain-like hazards).
2. The game hands the host an **invite code** (e.g. `GOOI-K7PT-Q2`). Players
   join by entering it. Every client generates the identical world from the
   shared seed — the map never travels over the wire, only the seed and config.
3. Play proceeds in **simultaneous turns** ("we-go"). Each turn every player
   submits a plan; when the last plan arrives (or a deadline passes), every
   client resolves the turn deterministically and the next turn opens.
   Nobody waits for anyone in particular — you take your turn whenever you
   open the browser, like a play-by-mail game.
4. Victory: last castle standing, or a points target (castles held, coin
   minted, wonders built) after N turns so matches have a guaranteed end.

### Why turns, and why simultaneous

- Asynchronous play *requires* turns; a browser tab cannot be trusted to stay
  open.
- Simultaneous submission means a 4-player match needs 1 turn-length of
  waiting per round, not 4. It also removes first-player advantage.
- Determinism does all the heavy lifting: the server never simulates anything.
  A match **is** `(seed, config, the ordered list of everyone's plans)`. Any
  client can replay it from turn 1 and arrive at the identical state — the
  same property `World.test.ts` already asserts for map generation, extended
  to the sim.

---

## 2. The three-layer turn

Each round is resolved in three deterministic phases. The **economy keeps
running** underneath — a turn advances the existing fixed-step simulation by a
fixed budget of sim-seconds, so serfs haul, sawmills cut and bakers bake
exactly as they do today, just in discrete chunks.

### Phase A — Planning (the only interactive part)

On your turn you issue **orders**, not actions:

- **Build orders** — place buildings/roads exactly as in the sandbox today.
- **Production orders** — worker posts, training queues, tavern priorities.
- **Movement orders** — for armies and generals (below).
- End turn. Your order list is signed, serialized and submitted.

### Phase B — Movement (Baldur's Gate 3 rules)

Armies move as **stacks led by a general** (leaderless stacks move at half
budget). Movement is *free but limited*:

- Every stack has a **movement budget in sim-metres per turn** (e.g. 40 tiles
  of path length, modified by `Modifiers.unitSpeed`, terrain and formation).
  There is no hex grid: you drag a path on the real map — around the lake,
  through the mountain pass — and the UI draws the reachable region as a
  shaded isochrone, exactly like BG3 shows the white movement ring.
- Paths come from the existing A\* in `src/engine/`; the isochrone is a
  Dijkstra flood from the stack's position cut at the budget. Both are already
  deterministic and DOM-free.
- All players' movement resolves **simultaneously** along their paths in sim
  time. When hostile stacks' paths bring them within engagement range, both
  stop at the contact point: a **battle is pinned** there. Remaining budget is
  forfeit — walking into a fight ends your move.

### Phase C — Battle (auto-chess resolution)

Every pinned battle resolves as an **autobattle** — no player input, watchable
by both sides at any later time (it's a deterministic replay, not a live
event):

- The armies deploy in their chosen **formations** (the box/line/split
  formation layer already exists and is pure —`engine/formations`), on the
  actual terrain patch where contact happened: the lake shore, the mountain
  pass, the polder ditches. Terrain is the tactics: a narrow pass beats
  numbers, exactly like the current frontier levels.
- Units fight using the **existing combat sim** (targeting, projectiles,
  charge bonuses, siege) run headless at fixed step until one side is dead or
  a round cap forces a fighting retreat. This is the auto-chess feel: you won
  the fight in the *planning* phase — composition, formation, general, ground.
- Outcome (casualties, retreat vector, hero injuries) feeds back into the
  strategic state.

Because Phase C is just `Game.ts` with only-combat systems enabled, balance is
automatically shared with singleplayer.

### Generals — the strategic pieces

The hero roster becomes the general pool. Each general:

- leads one stack, sets its movement budget, and grants an **aura** — an
  area-of-effect buff drawn from the existing `Modifiers` gateway
  (`combatMult`, `unitSpeed`, `trainTime`…). A general parked in your capital
  buffs production; marched with the army she buffs the line. This reuses
  hero boons/banes verbatim — the Erfgooier's thrift, the Veldheer's drill.
- can be **injured** (autobattle outcome), knocking her out for K turns — the
  45-second hero respawn maps to a turn count.
- is the only unit the fog of war always reports — generals are visible
  rumors, armies are not. Scouting matters.

---

## 3. Networking: invite codes, minimal server

### Architecture in one paragraph

The server is a **dumb, tiny turn mailbox**. It never runs the game. It
stores, per match: the config+seed, per-turn order bundles from each player,
and per-turn state hashes for desync detection. Clients do everything else.
This is the classic deterministic-lockstep trick applied at turn granularity,
which is far more forgiving than real-time lockstep: floating-point identity
across browsers is required (the sim is already integer-tile + seeded-RNG
heavy; audit remaining float math into a fixed-point or `Math.fround`
discipline as part of this work — this is the single riskiest item).

### Protocol

```
POST /match                 {config, seed}            → {matchId, inviteCode, hostKey}
POST /match/join            {inviteCode, playerName}  → {matchId, playerKey, config, seed, players}
POST /match/:id/turn/:n     {playerKey, orders, stateHashOfTurn(n-1)}
GET  /match/:id/turn/:n     → {orders: {playerId: bundle}, complete: bool}
GET  /match/:id/status      → {currentTurn, submitted: [...], deadline}
```

- **Invite code** = short human-typable alias for the match id, generated
  server-side, unguessable enough (`4+2 base32 chars ≈ 30 bits` with rate
  limiting).
- **playerKey** = bearer secret per player, handed out at join, kept in
  localStorage. No accounts, no OAuth, nothing personal — a match is a shared
  secret club.
- Clients **poll** `status` while a tab is open (or subscribe via SSE — one
  event stream endpoint is still "minimal"). Push notifications are out of
  scope; async play means checking in like a Wordle habit.
- **Desync detection**: every submission carries the hash of the previous
  resolved turn. If hashes diverge, the server flags the match and clients
  re-derive from turn 1 (cheap: replaying e.g. 60 turns of orders headless is
  seconds) — the deterministic-replay property is also the recovery story.
- **Anti-cheat** is "good enough for friends": orders are validated by every
  client during replay (an illegal build simply fails for everyone, including
  the cheater), and fog-of-war peeking is accepted as a trust limitation —
  the full state is derivable client-side by design. Server-authoritative
  fog is explicitly a non-goal for v1.

### Persistence

One table (or KV namespace): `match → {config, seed, players[], turns[][]}`.
Order bundles are small (a few KB of JSON per player-turn); a hundred-turn
6-player match is under 5 MB. TTL-expire matches idle for 90 days.

### Deployment shape

Cloudflare Workers + Durable Objects (or a single tiny Node/Bun process on a
VPS) is a perfect fit: one Durable Object per match gives per-match
serialization for free, KV/D1 for storage, zero servers to babysit. The
static game stays on GitHub Pages / Cloudflare Pages exactly as now.

---

## 4. Backend language: Rust or JavaScript?

**TypeScript/JavaScript. Not close, for this design.** Reasoning:

1. **The server doesn't simulate.** The whole point of the
   deterministic-mailbox architecture is that the backend is ~300 lines of
   request handling, validation and storage. Rust's strengths — raw compute,
   fearless concurrency — buy nothing when the hot path is "append JSON blob,
   return JSON blobs".
2. **Any code the server *does* share with the game must be the same code.**
   The one future feature that tempts server-side logic is order validation
   or full server-side replay (tournament mode). The sim is TypeScript;
   running it server-side is `import { Game } from '../game/Game'` in Node —
   versus a second implementation in Rust that must be *bit-identical* to the
   TS sim forever. A dual-language deterministic sim is a desync factory and
   a double maintenance bill. This argument dominates everything else.
3. **One language, one toolchain, one contributor skill set.** The repo is
   TS + Vite + Vitest; a `server/` workspace with shared `src/game` types
   keeps order schemas and state hashing literally the same module on both
   ends.
4. **The minimal-infra targets are JS-native.** Cloudflare Workers/Durable
   Objects, Deno Deploy, Bun on a VPS — the cheapest ways to run an
   invite-code mailbox all speak TypeScript natively. (Workers can run Rust
   via WASM, but that is extra complexity for negative benefit here.)

Where Rust *would* be the right call — none of which apply now: a
server-authoritative real-time sim for hundreds of concurrent matches; a
sim rewritten once in Rust→WASM and shared by both client and server (a
legitimate long-term determinism strategy, but a rewrite, not a backend
choice); or heavy matchmaking/ranking infrastructure.

**Recommendation:** TypeScript end-to-end. Node 22 (or Bun) + a single
Durable-Object-per-match on Cloudflare, `zod`-validated order schemas
imported from the game's own types.

---

## 5. What has to be true first (engineering prerequisites)

Ordered; each is independently useful to singleplayer.

1. **Determinism audit of the sim** — the ROADMAP already gates co-op on
   this. Stable iteration order (no `Set`/`Map` iteration feeding sim
   decisions unordered), all randomness through the seeded streams (`simRng`,
   `worldRng` — already true), no `Date.now()`/`Math.random()` in sim paths,
   float discipline. Add a golden test: run a scripted 500-step sim twice →
   identical state hash (the `mapFingerprint` pattern, extended to `Game`).
2. **State hashing + serialization** — a canonical `Game.fingerprint()` and
   save/load of full sim state (RunState/SaveGame already versions persisted
   state; extend to in-level state).
3. **Order layer** — reify player intent as data (`PlaceBuilding`,
   `SetWorkerPost`, `MoveStack`, …). The singleplayer UI then *also* goes
   through orders, which incidentally gives replays and an undo debug tool.
4. **Turn scheduler** — advance sim by fixed budget, resolve movement,
   detect contacts, run autobattles headless.
5. **Isochrone + path-preview UI** on top of the existing pathfinder.
6. **Server** — the mailbox above (a weekend once 1–4 exist).
7. **Match UI** — lobby, invite code entry, turn timeline, battle replay
   viewer (the sim rendered by the existing View at 3× speed).

Fog of war, ranked seasons, spectators, and >6 players are all v2+.

---

## 6. Why this fits Erfgooiers specifically

- The sandbox screen is already a lobby configuration screen; it grows one
  row (players) and one button (Create invite).
- `World` is seed-deterministic and DOM-free — map sharing is free.
- `Game` is DOM-free and already runs headless under Vitest — the autobattler
  and server-side replay need no refactor, only a "combat-only" systems flag.
- Heroes-as-rule-changers map one-to-one onto generals-as-auras via
  `Modifiers`, the codebase's single gateway for every tunable.
- Formations are pure functions — deployment previews are trivial.
- The biome roster (now nine, from Het Gooi to Hell) gives asymmetric-terrain
  matches their character: a delta map is a bridge war, Texel is a naval-less
  island brawl, Hell starves the food economy. Biome-bans become a draft
  mechanic for free.
