# Logistics engine

This document defines the player-facing rules and implementation contract for serf
hauling in `Game.dispatch`. Physical logistics is part of the simulation: one task
reserves one item, and one serf carries that item from one source to one destination.
The castle is storage and a fallback destination; it is not an obligatory hub.

## Core rules

1. A waiting consumer receives an available item before that item is sent to storage.
   Production chains route directly from producer to consumer when possible. For
   example, gold ore and coal move from their mines to a waiting mint, not through the
   castle first.
2. Storage receives surplus output only when there is no outstanding demand for that
   item. Output near the cap is an urgent liveness job: it outranks unrelated input
   refills so a producer cannot remain blocked forever.
3. Routing is physical. Serfs walk to the source, pick up one reserved item, then walk
   to the destination. Roads affect travel speed and path choice, not demand priority.
4. Assignment is deterministic. The dispatcher runs every 0.5 simulation seconds,
   discovers demands and sources in stable array/key order, then assigns available
   serfs without random choice.
5. `Modifiers` owns tunable buffer sizes. `carryCap()` is the target input buffer per
   recipe item; `outCap()` is the total output limit that stops a producer.
6. Recipes may declare `globalOutput`. Their completed output enters global storage
   immediately and never occupies a building output buffer or creates a serf task. The
   mint uses this for coins, making each minted coin immediately spendable.

## Demand priority

Lower numeric values are assigned first. The numbers are implementation details, but
their ordering is a gameplay contract.

| Order | Demand | Priority | Rules and purpose |
|---:|---|---:|---|
| 1 | Prioritized construction | -1 | Every missing material unit creates a demand. Player priority wins over all automatic work. |
| 2 | Construction | 0 | Keeps placed sites supplied before routine production and storage. |
| 3 | Prioritized near-cap output to storage | 0.4 | Clears a prioritized blocked producer only when no destination currently wants that item. |
| 4 | Near-cap output to storage | 0.5 | Prevents output deadlock ahead of unrelated input top-ups, subject to the same no-consumer rule. |
| 5 | Prioritized recipe input | 0.75 | Fills each missing recipe input toward `carryCap()`. |
| 6 | Recipe and tavern input | 1 | Normal consuming-building demand. Taverns request eligible foods while below capacity. |
| 7 | Market export stock | 1.5 | Stocks the configured sale quantity after construction and production needs. |
| 8 | Routine surplus to storage | 2 | Moves output only when no current construction, production, tavern, or market demand wants that item. |

Priority is global between jobs, while the no-consumer rule is item-specific. A coal
demand suppresses coal-to-storage jobs, but it does not prevent a serf from storing
unwanted timber after higher-priority work has been assigned.

## Demand discovery and destination rules

- Construction sites request every material unit not already delivered or incoming.
- Active recipe buildings request each input whose `inp + incoming` count is below
  `carryCap()`.
- Active taverns request food while their combined delivered and incoming food is below
  tavern capacity; an individual food is requested while its count is below two.
- Active player markets request the configured amount minus delivered and incoming
  market inventory.
- A non-storage building with output may request a haul to its nearest standing
  storehouse only if no discovered demand wants that item.
- A `globalOutput` recipe deposits into global storage at completion and therefore
  creates neither an output-haul demand nor an intermediate building inventory.
- The destination for a consumer demand is the consumer itself. Storage must never be
  inserted as an intermediate destination.

## Source selection

For a demand without a fixed source, the dispatcher considers every other building
that has the requested item in either output or storage. It chooses the source with the
lowest Manhattan distance to the destination. Storage sources receive a small `+0.5`
distance penalty, so an equally close producer wins. A fixed-source surplus job always
uses the producer that created that job.

Once the source is known, the idle serf closest to the source door receives the task.
Pathfinding happens after assignment and may use roads or any other walkable route.

## Reservations and delivery

Assignment reserves both ends immediately:

- one item is decremented from source output or source storage;
- `incoming[item]` is incremented for a construction site or non-storage destination;
- the serf receives a `pickup` task.

At the source door, the task changes to `deliver` and the carried-item mesh becomes
visible. At the destination door, construction increments `delivered`, storage
increments `stock`, and a consumer moves the item from `incoming` to `inp`.

Immediate reservation prevents two serfs from claiming the same item or overfilling a
consumer buffer during later dispatcher passes.

## Exceptions and failure behavior

- Player priority changes ordering within construction, input delivery, and near-cap
  output clearing. It never permits storage to take an item that a current consumer
  wants.
- Urgent output clearing may outrank an input request for a different item. This is a
  liveness exception: it frees a blocked producer, while the item-specific consumer
  rule still prevents detours such as coal mine → castle when a mint wants coal.
- A full input buffer is not a waiting consumer. Further output is surplus and may go
  to storage until consumption opens buffer space.
- Markets are intentional low-priority consumers. They do not take goods ahead of
  construction or production, but their active demand still prevents the same goods
  from being classified as surplus.
- If no source contains a demanded item, no task is created. The demand remains and is
  reconsidered on the next dispatcher pass.
- If no walkable path exists during pickup, the reservation is cancelled and the item
  is restored to its source. If delivery fails after pickup, the carried item is
  recovered to the main castle and destination `incoming` is released.
- Demolishing a source before pickup discards that source's reserved output with the
  building. Demolishing a destination cancels its tasks; already carried goods are
  recovered to the castle.
- Ringing the town bell cancels civilian logistics. Uncollected reservations are
  restored, while already carried goods are recovered to the castle before the serf
  seeks refuge.
- Market caravans are not serfs. They consume inventory already delivered to the
  market and create coin as market output; serfs then route that coin normally.

## Regression expectations

Tests for this subsystem should cover both sides of the routing invariant:

- capped producers with a waiting consumer route directly to that consumer, including
  multi-input chains such as gold mine + coal mine to mint;
- capped producers with no waiting consumer still route output to storage;
- capped output cannot be starved indefinitely by unrelated recurring input refills;
- `globalOutput` recipes create immediately spendable stock without a serf task;
- reservations prevent duplicate claims and buffer overfill;
- cancellation restores or recovers items according to task phase.

Any change to priorities, buffer semantics, source scoring, or cancellation must update
this document and add a focused `Game.test.ts` regression before handoff.
