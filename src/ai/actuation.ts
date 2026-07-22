import { DEFS } from '../data/buildings';
import { PLOT_RANGE } from '../constants';
import { findPath } from '../engine/pathfinding';
import { doorTile } from '../game/util';
import type { Rng } from '../engine/rng';
import type { Game } from '../game/Game';
import type { World } from '../world/World';
import type { Building, BuildingKey, Coord } from '../types';
import type { AIView } from './perception';

/**
 * Turns macro intents into legal placements. The hard part is placement
 * search: pick a tile the validator will accept AND that is spatially sane
 * (mines near their deposits, woodcutters near trees, farms with room for
 * plots, towers on the enemy approach). Every candidate passes the exact
 * `Game.canPlace` legality players face; search work is hard-capped per call
 * so a decision pass can never stall the 20 Hz tick.
 */

export interface PlacementPlan { x: number; y: number; rot: number }

const MINE_NODE: Partial<Record<BuildingKey, 'stone' | 'gold' | 'coal' | 'iron'>> = {
  quarry: 'stone', goldmine: 'gold', coalmine: 'coal', ironmine: 'iron',
};

/** Miners/woodcutters work nodes within this box range (mirrors data/buildings). */
const GATHER_RANGE = 9;
/** Placement search budgets. Ring sampling sees the whole useful settlement
 *  radius, while only a small, fixed number of the best candidates reaches the
 *  comparatively expensive exact validator and A* reachability check. */
const MIN_RADIUS = 2, BASE_MAX_RADIUS = 16, ABS_MAX_RADIUS = 24;
const RING_SAMPLES = 24;
const EXACT_BUDGETS = [20, 6, 2] as const;
const PATH_BUDGETS = [6, 2, 1] as const;

const chebyshev = (a: Coord, b: Coord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Never build in the rival's half: anything nearer their castle than ours
 *  (or within their tower reach) drags serfs and defenders across the map to
 *  die — the classic "forward gold mine" suicide. */
function safeGround(at: Coord, home: Coord, enemyStore: Coord | null): boolean {
  if (!enemyStore) return true;
  if (chebyshev(at, enemyStore) < 18) return false;
  return chebyshev(at, home) <= chebyshev(at, enemyStore);
}

/** Door rotation whose entrance faces from the footprint toward `toward`. */
function rotFacing(from: Coord, toward: Coord): number {
  const dx = toward.x - from.x, dy = toward.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 3 : 1; // east / west doors
  return dy > 0 ? 0 : 2;                                  // south / north doors
}

function nodesNear(nodes: Coord[], at: Coord, range: number): number {
  let count = 0;
  for (const node of nodes) if (chebyshev(node, at) <= range + 1) count++;
  return count;
}

/** A clear shore tile the fisher can stand on. This deliberately mirrors
 *  PlacementSystem.fishingSpotInRange rather than merely looking for water:
 *  deep water without an open bank cannot be worked. */
function openFishingSpot(world: World, x: number, y: number): boolean {
  const tile = world.T(x, y);
  if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.tree || tile.dep || tile.road || tile.field) return false;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .some(([dx, dy]) => world.T(x + dx, y + dy)?.type === 'water');
}

function fishingSpotsNear(world: World, at: Coord, range: number): number {
  let count = 0;
  for (let y = Math.max(0, at.y - range); y <= Math.min(world.H - 1, at.y + 1 + range); y++) {
    for (let x = Math.max(0, at.x - range); x <= Math.min(world.W - 1, at.x + 1 + range); x++) {
      // The shore worker may not stand inside the pending 2x2 footprint.
      if (x >= at.x && x <= at.x + 1 && y >= at.y && y <= at.y + 1) continue;
      if (openFishingSpot(world, x, y)) count++;
    }
  }
  return count;
}

/** Free grass tiles a farm at `at` could plot (approximates canPlotAt cheaply). */
function openPlotGround(world: World, at: Coord): number {
  let open = 0;
  const range = PLOT_RANGE - 1;
  for (let y = at.y - range; y <= at.y + 1 + range; y++) for (let x = at.x - range; x <= at.x + 1 + range; x++) {
    const tile = world.T(x, y);
    if (tile && tile.type === 'grass' && !tile.b && !tile.site && !tile.road && !tile.field && !tile.dep && !tile.tree) open++;
  }
  return open;
}

/** The anchor a building key wants to sit near, or null when the map has none
 *  left (e.g. every iron deposit mined out) — the caller skips the goal then.
 *  `reach` is how far from home the profile will expand: low tiers hug the
 *  base, higher tiers push mines out toward the CONTESTED CENTRE deposits. */
function anchorFor(
  view: AIView, world: World, key: BuildingKey, home: Coord, approach: Coord, reach: number, center: Coord,
): Coord | null {
  const node = MINE_NODE[key];
  const enemyStore = view.enemyStore ? { x: view.enemyStore.x, y: view.enemyStore.y } : null;
  if (node) {
    // The first couple of each mine sit near home for a short, safe haul; BEYOND
    // that the pro CONTESTS THE CENTRE — planting mines on the shared central
    // gold/coal/iron veins to deny the rival and fuel an ever bigger army (the
    // win condition the human plays for). safeGround still bars the enemy half,
    // so "toward centre" means up to midfield, never into their base.
    const extractors = [...view.buildings, ...view.sites].filter(building => MINE_NODE[building.key] === node);
    const owned = extractors.length;
    const contestCentre = owned >= 2;
    const maxDistance = node === 'gold' ? reach + 4 : reach;
    let best: Coord | null = null, bestScore = Infinity;
    for (const deposit of view.resources[node]) {
      if (chebyshev(deposit, home) >= maxDistance || !safeGround(deposit, home, enemyStore)) continue;
      let taken = false;
      for (const building of extractors) {
        if (chebyshev(deposit, building) <= GATHER_RANGE + 1) { taken = true; break; }
      }
      if (taken) continue;
      // opening mines score by nearness to home; expansion mines by nearness to
      // the contested centre, so the base reaches out instead of hugging home
      const score = contestCentre ? chebyshev(deposit, center) : chebyshev(deposit, home);
      if (score < bestScore) { bestScore = score; best = deposit; }
    }
    return best;
  }
  if (DEFS[key].gather?.node === 'fish') {
    let best: Coord | null = null, bestDistance = Infinity;
    for (let y = 1; y < world.H - 1; y++) for (let x = 1; x < world.W - 1; x++) {
      if (!openFishingSpot(world, x, y)) continue;
      const shore = { x, y };
      const distance = chebyshev(shore, home);
      if (distance > reach || distance >= bestDistance || !safeGround(shore, home, enemyStore)) continue;
      bestDistance = distance;
      best = shore;
    }
    return best;
  }
  if (key === 'woodcutter' || key === 'forester') {
    // nearest tree that stands in a workable cluster, so the hut keeps busy
    let best: Coord | null = null, bestDistance = 1e9;
    for (const tree of view.resources.trees) {
      const distance = chebyshev(tree, home);
      if (distance >= bestDistance || distance > reach) continue;
      if (!safeGround(tree, home, enemyStore)) continue;
      if (nodesNear(view.resources.trees, tree, 4) < 3) continue;
      bestDistance = distance; best = tree;
    }
    return best;
  }
  if (key === 'watchtower' || key === 'stonetower' || key === 'woodgate' || key === 'woodwall' || key === 'gate' || key === 'wall') return approach;
  return home;
}

/** True when the spot could actually work: mirrors tryPlace's resource gates so
 *  the bot never submits a placement the sim would refuse with a toast. */
function workable(view: AIView, world: World, key: BuildingKey, at: Coord): boolean {
  const node = MINE_NODE[key];
  if (node) return nodesNear(view.resources[node], at, GATHER_RANGE) > 0;
  if (key === 'woodcutter') return nodesNear(view.resources.trees, at, GATHER_RANGE) >= 2;
  if (DEFS[key].fields) return openPlotGround(world, at) >= 6;
  if (DEFS[key].gather?.node === 'fish') return fishingSpotsNear(world, at, DEFS[key].gather.range) > 0;
  return true;
}

/** Empty tiles between two axis-aligned 2x2 logical footprints. canPlace
 *  rejects overlap; this policy adds readable lanes around legal footprints. */
function footprintGap(a: Coord, b: Coord): number {
  return chebyshev(a, b) - 2;
}

function desiredGap(key: BuildingKey): number {
  if (DEFS[key].bulwark) return 0; // curtain pieces deliberately join edge-to-edge
  if (DEFS[key].fields) return 4;
  if (MINE_NODE[key]) return 1;    // deposits can leave a mine only a narrow slot
  // Most render meshes overhang their logical 2x2 footprint. Three empty tiles
  // keeps roofs and working yards visually distinct instead of merely leaving
  // a mathematically walkable slit between them.
  return 3;
}

function clearance(view: AIView, at: Coord): number {
  let nearest = Infinity;
  for (const building of view.buildings) nearest = Math.min(nearest, footprintGap(at, building));
  for (const site of view.sites) nearest = Math.min(nearest, footprintGap(at, site));
  return nearest;
}

/** Cheap first-stage footprint test. It mirrors the non-directional part of
 *  canPlace, which remains the final authority for entrances and sealing. */
function footprintOpen(world: World, at: Coord): boolean {
  for (let y = at.y; y < at.y + 2; y++) for (let x = at.x; x < at.x + 2; x++) {
    const tile = world.T(x, y);
    if (!tile || tile.type !== 'grass' || tile.b || tile.site || tile.dep || tile.road || tile.field || tile.tree?.dense) return false;
  }
  return true;
}

/** A crowding penalty that keeps the base from packing wall-to-wall: 2×2
 *  footprints sitting flush (gap 0) read as a cramped blob and choke the roads
 *  and serf lanes between them. This rewards a tile or two of breathing room —
 *  a more natural settlement — while still allowing a tight fit when the
 *  ground demands it (the penalty is soft, not a hard rule). Farms want extra
 *  clearance for their plots; mines tolerate closer since they cluster on ore. */
function crowding(view: AIView, key: BuildingKey, at: Coord): number {
  const wantGap = desiredGap(key);
  let penalty = 0;
  const near = (b: Coord): void => {
    const gap = footprintGap(at, b);
    if (gap < wantGap) penalty += (wantGap - gap);
  };
  for (const b of view.buildings) near(b);
  for (const s of view.sites) near(s);
  return penalty;
}

function score(view: AIView, world: World, key: BuildingKey, at: Coord, anchor: Coord, home: Coord): number {
  let value = -chebyshev(at, anchor) - 0.35 * chebyshev(at, home);
  const node = MINE_NODE[key];
  if (node) value += 2 * Math.min(4, nodesNear(view.resources[node], at, GATHER_RANGE));
  if (key === 'woodcutter' || key === 'forester') value += Math.min(6, nodesNear(view.resources.trees, at, GATHER_RANGE));
  if (DEFS[key].fields) value += 0.4 * Math.min(20, openPlotGround(world, at));
  value -= 2.5 * crowding(view, key, at); // spread out for roads & serf lanes
  return value;
}

interface ScoredCandidate extends Coord {
  value: number;
  gap: number;
  anchorDistance: number;
  homeDistance: number;
}

/** A ring in the historical deterministic order (top/bottom, then sides). */
function ringAround(anchor: Coord, radius: number): Coord[] {
  const ring: Coord[] = [];
  for (let x = anchor.x - radius; x <= anchor.x + radius; x++) {
    ring.push({ x, y: anchor.y - radius }, { x, y: anchor.y + radius });
  }
  for (let y = anchor.y - radius + 1; y <= anchor.y + radius - 1; y++) {
    ring.push({ x: anchor.x - radius, y }, { x: anchor.x + radius, y });
  }
  return ring;
}

/** Broad, bounded sampling of a whole ring. Eight fixed compass/corner slots
 *  prevent blind directions; the remaining slots use one seeded phase so maps
 *  vary between games without consuming a different number of RNG draws. */
function sampledRing(anchor: Coord, radius: number, phase: number): Coord[] {
  const ring = ringAround(anchor, radius);
  if (ring.length <= RING_SAMPLES) return ring;
  const indices = new Set<number>();
  for (let i = 0; i < 8; i++) indices.add(Math.floor(i * ring.length / 8));
  const phased = RING_SAMPLES - indices.size;
  const offset = phase % ring.length;
  for (let i = 0; i < phased; i++) indices.add((offset + Math.floor(i * ring.length / phased)) % ring.length);
  // A phased sample can coincide with a fixed landmark. Fill any holes with a
  // deterministic linear walk so every large ring gets the same fixed budget.
  for (let i = 0; indices.size < RING_SAMPLES; i++) indices.add((offset + i) % ring.length);
  return [...indices].sort((a, b) => a - b).map(index => ring[index]);
}

/**
 * Ring search around the key's anchor for the best legal, workable footprint.
 * Deterministic given (state, rng); the rng only rotates the ring start so
 * bases grow differently between matches, not between replays of one match.
 */
export function findBuildingSpot(
  game: Game, world: World, view: AIView, key: BuildingKey, rng: Rng, approach: Coord, reach = 26,
): PlacementPlan | null {
  const store = view.store;
  if (!store) return null;
  const home = { x: store.x, y: store.y };
  const center = { x: Math.floor(world.W / 2), y: Math.floor(world.H / 2) };
  const anchor = anchorFor(view, world, key, home, approach, reach, center);
  if (!anchor) return null;

  const candidates: ScoredCandidate[] = [];
  const phase = rng.int(65536);
  const enemyStore = view.enemyStore ? { x: view.enemyStore.x, y: view.enemyStore.y } : null;
  const resourceBound = !!MINE_NODE[key] || key === 'woodcutter' || key === 'forester' || DEFS[key].gather?.node === 'fish';
  const maxRadius = resourceBound
    ? BASE_MAX_RADIUS
    : Math.min(ABS_MAX_RADIUS, Math.max(BASE_MAX_RADIUS, Math.floor(reach / 2)));
  for (let radius = MIN_RADIUS; radius <= maxRadius; radius++) {
    for (const at of sampledRing(anchor, radius, phase)) {
      if (at.x < 1 || at.y < 1 || at.x >= world.W - 2 || at.y >= world.H - 2) continue;
      if (!safeGround(at, home, enemyStore)) continue;
      if (chebyshev(at, home) > reach + 8) continue;
      if (!footprintOpen(world, at)) continue;
      if (!workable(view, world, key, at)) continue;
      candidates.push({
        x: at.x, y: at.y,
        value: score(view, world, key, at, anchor, home),
        gap: clearance(view, at),
        anchorDistance: chebyshev(at, anchor),
        homeDistance: chebyshev(at, home),
      });
    }
  }
  candidates.sort((a, b) => b.value - a.value
    || b.gap - a.gap
    || a.anchorDistance - b.anchorDistance
    || a.homeDistance - b.homeDistance
    || a.y - b.y
    || a.x - b.x);

  // Strict spacing first; constrained terrain gets two small, bounded fallback
  // bands rather than deadlocking the build order. At most 28 coordinates (112
  // rotations) and nine A* calls reach the expensive stages per decision pass.
  const wanted = desiredGap(key);
  const bands = wanted === 0
    ? [{ min: 0, max: Infinity }]
    : [
        { min: wanted, max: Infinity },
        { min: Math.max(0, wanted - 1), max: wanted },
        { min: 0, max: Math.max(0, wanted - 1) },
      ];
  const from = doorTile(store);
  for (let pass = 0; pass < bands.length; pass++) {
    const band = bands[pass];
    let exactChecks = 0, pathChecks = 0;
    for (const candidate of candidates) {
      if (candidate.gap < band.min || candidate.gap >= band.max) continue;
      if (exactChecks++ >= EXACT_BUDGETS[pass]) break;
      const preferred = rotFacing(candidate, home);
      let rot = -1;
      for (const r of new Set([preferred, 0, 1, 2, 3])) {
        if (game.canPlace(key, candidate.x, candidate.y, r)) { rot = r; break; }
      }
      if (rot < 0) continue;
      if (pathChecks++ >= PATH_BUDGETS[pass]) break;
      const door = doorTile({ ...candidate, rot });
      if (findPath(world, from.x, from.y, door.x, door.y, view.owner) !== null) {
        return { x: candidate.x, y: candidate.y, rot };
      }
    }
  }
  return null;
}

/** The next plot tiles a fields building should claim, nearest first. */
export function planPlots(game: Game, farm: Building): Coord[] {
  const capacity = (farm.def.plots ?? 8) - farm.fieldsList.length;
  if (capacity <= 0) return [];
  const cells: (Coord & { d: number })[] = [];
  const cx = farm.x + 0.5, cy = farm.y + 0.5;
  for (let y = farm.y - PLOT_RANGE; y <= farm.y + 1 + PLOT_RANGE; y++) {
    for (let x = farm.x - PLOT_RANGE; x <= farm.x + 1 + PLOT_RANGE; x++) {
      if (!game.canPlotFor(farm, x, y)) continue;
      cells.push({ x, y, d: Math.hypot(x - cx, y - cy) });
    }
  }
  cells.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return cells.slice(0, capacity).map(({ x, y }) => ({ x, y }));
}
