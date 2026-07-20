# Tensor networks for logistical AI: reality check

_Assessment recorded 13 July 2026._

## Short answer

The quoted explanation has a sound high-level idea, but it overstates both the
problem and the readiness of the proposed solution.

- Classical pathfinding, deterministic rules, queues, matching, and graph
  algorithms are the normal tools for game logistics. The categorical claim
  about the internals of proprietary games cannot be proven without their
  source, but tensor networks would be very unusual there.
- Tensor networks can compactly approximate some high-dimensional functions,
  distributions, and neural-network weights **when those objects have useful
  low-rank structure**. They do not automatically compress an arbitrary city
  simulation or remove combinatorial complexity.
- Tensor-network approaches to routing and combinatorial optimization are real
  research, but the evidence is early. It does not currently establish an
  advantage for real-time, dynamic game logistics.
- Erfgooiers has no neural logistics model to compress. Tensor Train model
  compression therefore offers it no immediate benefit.

**Recommendation:** do not put a tensor-network experiment on the product
roadmap now. Keep it as an optional research spike only after profiling shows a
specific logistics bottleneck and strong classical baselines have been built.

## Claim-by-claim check

### 1. “Commercial logistics games use classical algorithms, not tensor networks”

**Essentially correct, with one caveat.** A categorical statement about closed,
proprietary source is not verifiable from the outside. The described toolbox is
nevertheless the conventional one: shortest-path algorithms, rule/state-based
agents, queues, spatial indexes, and assignment or flow algorithms.

“Network flow” should not be presented as the universal implementation,
however. Many games use cheaper greedy dispatch, reservation systems, or
priority queues because they are easier to update incrementally and create
predictable player-facing behavior.

### 2. “A large city simulation creates an exponential explosion of data”

**Misleading.** Storing and stepping 10,000 agents does not inherently require
an exponential amount of data; a conventional simulation can have roughly
linear state in its number of agents, buildings, and links. Exponential or
combinatorial growth appears when asking a different question, such as jointly
enumerating future states or optimizing many coupled decisions over a long
horizon.

Tensor networks represent a large tensor as connected smaller tensors. That can
reduce storage and computation when the target admits a sufficiently low-rank
approximation. The rank/bond dimension needed depends on the correlations in
the data; difficult long-range correlations can erase the advantage. General
tensor-network contraction is itself computationally hard, and recent
optimization benchmarks have documented approximation failures and poor
performance on some large problems.

So “they filter out noise and preserve the strongest correlations” is a useful
intuition for lossy low-rank approximation, not a guarantee and not a drop-in
simulation engine.

### 3. “Tensor Network Generator-Enhanced Optimization improves routing”

**Based on real but very preliminary research.** The February 2026 TN-GEO TSP
paper is a recent arXiv preprint. It uses a matrix-product-state generative model
to learn a distribution over candidate tours. Its reported experiments cover
TSPLIB cases of at most 52 cities and compare against swap and 2-opt
hill-climbing. That is interesting evidence for a research method, but not a
demonstration that it beats mature TSP/vehicle-routing solvers, nor that it is
suited to hundreds of agents replanning in a changing game world.

The passage also makes an important category error: a serf taking an item from
one building to another is a shortest-path and assignment problem, not a
Traveling Salesperson Problem. TSP asks one tour to visit a set of locations.
Batching many pickups/deliveries with vehicle capacity and time constraints can
become a vehicle-routing problem, but Erfgooiers currently models one reserved
item per serf trip.

The claim that local correlations are helpful accurately reflects the paper's
reported result for its _k_-site variants. Saying that the method has
“outperformed traditional algorithms” is too broad: it outperformed the two
simple classical heuristics tested on those instances.

### 4. “Tensor Train can shrink neural game AI by over 90% without loss”

**Possible in selected models, not a general promise.** Tensor-network
factorizations are established neural-model compression techniques. Published
results range from large compression of particular layers to substantial whole
network compression with a measured accuracy trade-off. Compression ratio,
quality, latency, and hardware behavior depend on the architecture, tensor
shape, chosen ranks, and implementation. Fewer parameters do not automatically
mean proportionally faster inference.

Most importantly, compression only helps after there is a trained neural model
worth compressing. A deterministic state machine or greedy dispatcher has no
neural weight tensor to factorize.

## Fit with Erfgooiers today

Erfgooiers already uses the right family of techniques for its problem:

- [`LogisticsSystem`](../src/game/LogisticsSystem.ts) discovers demand on a
  fixed cadence, sorts it by deterministic gameplay priority, reserves stock,
  chooses a nearby source and serf, and creates one pickup/delivery task.
- [`pathfinding.ts`](../src/engine/pathfinding.ts) uses allocation-conscious A*
  with a binary heap and reusable scratch buffers.
- [`flowfield.ts`](../src/engine/flowfield.ts) already removes redundant A*
  searches for large military groups by sharing one reverse-Dijkstra field.
- [`logistics-engine.md`](logistics-engine.md) makes dispatch order and failure
  handling a player-facing deterministic contract.

This is not a high-dimensional tensor that the simulation materializes. It is a
small, dynamic, discrete matching problem followed by graph searches. Adding a
tensor-network optimizer would introduce model/search runtime, numerical and
browser tooling complexity, and a harder determinism story. It could also
change legible priority rules into opaque approximate decisions. In co-op, any
sampling and floating-point sensitivity would need especially careful handling
to preserve synchronized results.

## Higher-value experiments first

Only optimize after a reproducible benchmark shows where frame/tick time goes.
If logistics becomes expensive on large sandbox maps, test these in order:

1. Index available outputs and demands by owner and item instead of repeatedly
   scanning all buildings and demand records.
2. Represent repeated unit demands as counts rather than allocating one demand
   object per missing item, while preserving stable assignment order.
3. Cache or incrementally update route distances between building doors;
   invalidate them when passability changes.
4. Compare the current greedy matching with deterministic min-cost matching or
   min-cost flow in an offline benchmark. Measure tick time and total haul time,
   not just route optimality.
5. Explore shared fields, hierarchical pathfinding, or destination batching
   only where many trips actually share topology or endpoints.
6. Put heavy simulation work in a worker only if profiling shows main-thread
   contention; this is already the direction in the scale plan.

These approaches operate directly on the existing problem, preserve the
simulation's rules, and provide simpler correctness and determinism tests.

## Is a tensor-network experiment ever worth doing?

Yes, as a **bounded research experiment**, not an expected optimization. It
would become reasonable if all of the following are true:

- a recorded stress case shows logistics assignment—not rendering, movement,
  or A*—is a material part of the tick budget;
- the game has evolved into a genuine batch routing/scheduling problem with
  many coupled pickup/drop-off decisions;
- a strong deterministic classical baseline exists;
- the experiment runs offline first and has explicit quality, latency, memory,
  determinism, and integration criteria.

A sensible spike would export static logistics snapshots, solve the same
formulation using greedy matching, min-cost flow/OR methods, and a
tensor-network method, then compare solution cost and wall-clock time. No
runtime integration should happen unless the tensor method wins on representative
game instances by enough to repay its complexity. Based on present evidence,
that outcome is unlikely, but the experiment could still be educational.

## Follow-up: a spike in the RIGHT domain (strategy, not logistics)

The combinatorial hardness this document keeps pointing at (§2: "optimizing many
coupled decisions over a long horizon") is **not** logistics — it is *strategy*:
the build-order/army-composition plan. A later Phase 3 spike took the tensor
method there instead, exactly under the discipline set above (a strong classical
baseline first, offline, a pre-registered win bar, no runtime integration unless
it earns it). A Matrix Product State Born machine represents the distribution
over whole plans and is trained by generator-enhanced self-play against the
Godlike baseline. See **[tensor-strategy-poc.md](tensor-strategy-poc.md)** for
the design, the pre-registered bar, and the honest result. That spike is the
sanctioned application of this family in Erfgooiers; the logistics rejection
above still stands.

## Sources

- Sakai and Liu, [Tensor Network Generator-Enhanced Optimization for Traveling
  Salesman Problem](https://arxiv.org/abs/2602.20175) (2026 preprint).
- Ali, Perez Delgado, and Moreno Fdez. de Leceta, [Traveling Salesman Problem
  from a Tensor Networks Perspective](https://arxiv.org/abs/2311.14344) (2023
  preprint).
- Liu et al., [How Good Is Neural Combinatorial Optimization? A Systematic
  Evaluation on the Traveling Salesman Problem](https://arxiv.org/abs/2209.10913)
  (2022 preprint), which reports that evaluated neural solvers generally lagged
  traditional solvers across most criteria.
- Dziubyna et al., [Limitations of tensor network approaches for optimization
  and sampling](https://arxiv.org/abs/2411.16431) (2024 preprint), a useful
  counterexample to blanket performance claims.
- Cichocki et al., [Tensor Networks for Dimensionality Reduction and Large-Scale
  Optimizations, Part 2](https://arxiv.org/abs/1708.09165) (2017 review).
- Novikov et al., [Tensorizing Neural Networks](https://arxiv.org/abs/1509.06569)
  (2015), an early Tensor Train neural-compression result.
- Obukhov et al., [T-Basis: a Compact Representation for Neural
  Networks](https://proceedings.mlr.press/v119/obukhov20a.html) (ICML 2020).
- Stoian, Milbradt, and Mendl, [On the Optimal Linear Contraction Order of Tree
  Tensor Networks, and Beyond](https://doi.org/10.1137/23M161286X) (SIAM Journal
  on Scientific Computing, 2025), noting that optimal contraction ordering is
  NP-hard in general while identifying a tractable tree-network case.

