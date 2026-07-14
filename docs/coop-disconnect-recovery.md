# Co-op disconnect recovery

How a two-player Expedition survives one player refreshing their page, closing
the tab, or dropping their connection — and how they rejoin the same run.

This assumes the current **browser-only direct WebRTC transport**
(`src/net/PeerCoOpClient.ts`), not the planned server-backed mode. See
[co-op-design.md](co-op-design.md) §3 for the server design this supersedes for
now.

## Motivation

A player refreshed the page mid-Expedition and could not recover the game. That
is expected: today there is **no recovery path at all** in direct mode.

## What exists today

- **Transport** (`PeerCoOpClient.ts`): browser-only direct WebRTC. The host is
  authoritative and sequences all commands; the guest runs a replica driven by
  `commandAccepted` broadcasts.
- **Recovery: none.** On a refresh the WebRTC connection dies, the survivor
  flips to `paused` ("Direct peer disconnected"), and `reconnectNow()` only
  errors: *"Direct sessions need a fresh invite after a failed connection."*
- **Checkpoints are a stub.** The `checkpoint` message exists in `protocol.ts`
  and `PeerCoOpClient` relays it, but **nothing captures or restores game
  state** — there is no `serialize`/`restore` in `src/game`. Each peer rebuilds
  the sim purely from `seed + full command log`.
- The in-game invite button (`btnMpCopy`) copies the **original lobby invite**,
  which is stale after the Expedition starts and carries no game state.

## Proposed player-facing flow

1. A player disconnects (refresh, tab close, network drop).
2. The surviving player's session pauses and offers to reconnect their ally.
3. The survivor generates a **fresh invite code** — the same encrypted
   offer/response handshake as "Join a friend" — from the in-game Multiplayer
   panel.
4. The returning player opens the game, chooses **Join by invite**, and pastes
   the code. Both compare the 6-digit safety code, the survivor accepts.
5. The survivor ships its authoritative game state; the returner restores both
   settlements and resumes as the **same player** they were before.
6. Both sims unpause and the Expedition continues.

There is a **5-minute reconnect window**. If it expires, the run ends (with an
option to continue solo — see open questions).

## The core problem

The invite handshake is the easy part. A refreshed page is **blank**: it has no
seed, no command log, and no world. The invite code only re-opens a WebRTC
channel — **it carries zero game state**. So "reconnect with the code and the
game moves on" cannot work until the survivor can **serialize its authoritative
game state and ship it over the channel**, and the returner **restores both
settlements** from it.

That checkpoint capture/restore is the real feature. It does not exist yet and
everything else depends on it.

## Design decisions

### 1. "Take over hosting" only matters when the host leaves

Handle both drop cases with one mental model: **whoever is still standing is the
host and owns the snapshot; the returning player is always a fresh guest who
receives that snapshot.**

- **Guest drops:** the host still holds truth. No migration — just ship a
  checkpoint when the guest rejoins.
- **Host drops:** the surviving guest becomes the new network host and its
  current replica *is* the new authoritative state. This is the only case that
  actually migrates authority.

Because both peers run the same deterministic sim, the survivor can always
serialize its current state on demand — no periodic checkpoint upload is needed
in P2P mode.

### 2. Decouple network role from gameplay identity — the subtle trap

Today `playerId` is bolted to network role: `createRoom` → `p1`,
`joinByInvite` → `p2`. If the ex-guest re-hosts, it becomes the network host but
**must keep owning its original settlement** (say it was `p2`).

- Ownership must come from the **checkpoint's `PlayerId`**, not from who hosts.
- Each side must be **explicitly told which `PlayerId` it is** in the
  welcome/checkpoint, independent of host/guest role.
- Get this wrong and you spawn a third economy or hand a player the wrong town.

### 3. Pause the whole sim during the reconnect window

The current design note says an absent settlement "keeps simulating but
uncommandable." But enemies still attack it; over 5 minutes an uncommanded
castle can fall and end the run, so the returner comes back to a smoking crater.

For a fixed-`1x` friends game, **pause both sims** until reconnect or timeout.
It is the least surprising behaviour and it also makes recovery deterministic:
the command queue is drained, so the checkpoint is captured at a clean tick
boundary with nothing in flight.

### 4. Persist the survivor's checkpoint to localStorage

Cheap insurance against a *double* disconnect (the survivor also refreshes
during the window): they can re-host from the saved snapshot. Store it under a
separate versioned co-op resume key, never mixing with the singleplayer save.

### 5. Keep the safety-code compare on reconnect

A fresh ECDH handshake with explicit accept is *safer* than a server "seat
reclaim": the survivor generates the code and hands it to their friend. Do not
drop the 6-digit safety-code comparison under time pressure.

### 6. The existing invite button is not enough

`btnMpCopy` copies the stale lobby invite. Reconnect needs the **full host
handshake** (offer → paste response → accept) available *in-game*, and it must
first pause and capture the checkpoint. Wire a distinct "Reconnect ally"
action rather than reusing the lobby copy button.

## Work breakdown, in dependency order

1. **`GameCheckpoint` serialize/restore** (blocks everything). A render-free DTO
   of authoritative state — both settlements' stock, buildings, units, workers,
   heroes, modifiers, ownership by `PlayerId`, objective progress, level clock,
   sim RNG state, enemy director state, tick, and accepted sequence. Restore in
   two passes (scalars + ID maps, then cross-references), then ask `View` to
   rebuild meshes. `World` stays Three.js-free; `Game` stays DOM-free.
2. **Identity/role split.** Carry `PlayerId` in the welcome/checkpoint; stop
   deriving ownership from host/guest role.
3. **Pause-during-window semantics** plus the 5-minute timeout and its expiry
   behaviour.
4. **In-game reconnect handshake UI** in the Multiplayer panel (pause → capture
   → offer → paste response → safety compare → accept → ship checkpoint).
5. **localStorage checkpoint persistence** for double-disconnect recovery.

The invite-code handshake crypto already exists and is reused as-is.

## Open questions

- **Timeout expiry:** end the run, or let the survivor continue solo (and if so,
  what happens to the absent player's paused settlement)?
- **Checkpoint size / transfer time** over a WebRTC data channel for a
  late-game two-economy state — may need chunking and a progress indicator.
- **Host-migration correctness** (the ex-guest becoming authority) needs
  dedicated tests before it can be trusted; the design doc deliberately deferred
  this.
