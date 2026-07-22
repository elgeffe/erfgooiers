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
/** Search rings around the anchor, and a cap on scored legal candidates. */
const MIN_RADIUS = 2, MAX_RADIUS = 16, MAX_CANDIDATES = 40;

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
function anchorFor(view: AIView, key: BuildingKey, home: Coord, approach: Coord, reach: number, center: Coord): Coord | null {
  const node = MINE_NODE[key];
  const enemyStore = view.enemyStore ? { x: view.enemyStore.x, y: view.enemyStore.y } : null;
  if (node) {
    // The first couple of each mine sit near home for a short, safe haul; BEYOND
    // that the pro CONTESTS THE CENTRE — planting mines on the shared central
    // gold/coal/iron veins to deny the rival and fuel an ever bigger army (the
    // win condition the human plays for). safeGround still bars the enemy half,
    // so "toward centre" means up to midfield, never into their base.
    let owned = 0;
    for (const building of view.buildings) if (MINE_NODE[building.key] === node) owned++;
    const contestCentre = owned >= 2;
    const maxDistance = node === 'gold' ? reach + 4 : reach;
    let best: Coord | null = null, bestScore = Infinity;
    for (const deposit of view.resources[node]) {
      if (chebyshev(deposit, home) >= maxDistance || !safeGround(deposit, home, enemyStore)) continue;
      let taken = false;
      for (const building of view.buildings) {
        if (MINE_NODE[building.key] === node && chebyshev(deposit, building) <= GATHER_RANGE) { taken = true; break; }
      }
      if (taken) continue;
      // opening mines score by nearness to home; expansion mines by nearness to
      // the contested centre, so the base reaches out instead of hugging home
      const score = contestCentre ? chebyshev(deposit, center) : chebyshev(deposit, home);
      if (score < bestScore) { bestScore = score; best = deposit; }
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
  if (DEFS[key].gather?.node === 'fish') return false; // baseline bot skips shore buildings
  return true;
}

/** A crowding penalty that keeps the base from packing wall-to-wall: 2×2
 *  footprints sitting flush (gap 0) read as a cramped blob and choke the roads
 *  and serf lanes between them. This rewards a tile or two of breathing room —
 *  a more natural settlement — while still allowing a tight fit when the
 *  ground demands it (the penalty is soft, not a hard rule). Farms want extra
 *  clearance for their plots; mines tolerate closer since they cluster on ore. */
function crowding(view: AIView, key: BuildingKey, at: Coord): number {
  const wantGap = DEFS[key].fields ? 3 : MINE_NODE[key] ? 1 : 2;
  let penalty = 0;
  const near = (b: Coord): void => {
    // gap between two 2×2 footprints: Chebyshev of top-lefts, minus the 2-tile span
    const gap = chebyshev(at, b) - 2;
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
  const anchor = anchorFor(view, key, home, approach, reach, center);
  if (!anchor) return null;

  const candidates: (PlacementPlan & { value: number })[] = [];
  const startOffset = rng.int(8);
  const enemyStore = view.enemyStore ? { x: view.enemyStore.x, y: view.enemyStore.y } : null;
  for (let radius = MIN_RADIUS; radius <= MAX_RADIUS && candidates.length < MAX_CANDIDATES; radius++) {
    const ring: Coord[] = [];
    for (let x = anchor.x - radius; x <= anchor.x + radius; x++) {
      ring.push({ x, y: anchor.y - radius }, { x, y: anchor.y + radius });
    }
    for (let y = anchor.y - radius + 1; y <= anchor.y + radius - 1; y++) {
      ring.push({ x: anchor.x - radius, y }, { x: anchor.x + radius, y });
    }
    for (let i = 0; i < ring.length; i++) {
      const at = ring[(i + startOffset) % ring.length];
      if (at.x < 1 || at.y < 1 || at.x >= world.W - 2 || at.y >= world.H - 2) continue;
      if (!safeGround(at, home, enemyStore)) continue;
      if (!workable(view, world, key, at)) continue;
      const preferred = rotFacing(at, home);
      let rot = -1;
      for (const r of [preferred, 0, 1, 2, 3]) {
        if (game.canPlace(key, at.x, at.y, r)) { rot = r; break; }
      }
      if (rot < 0) continue;
      candidates.push({ x: at.x, y: at.y, rot, value: score(view, world, key, at, anchor, home) });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    // keep collecting a few rings past the first legal spot so the crowding
    // score has room to spread the base out rather than pack the first ring
    if (candidates.length && radius >= MIN_RADIUS + 6) break;
  }
  // A legal tile is not always a REACHABLE tile — a spot behind water or rock
  // starves its site forever and (worse) strands every serf sent to feed it.
  // Path-check the best few (the path is waypoint-compressed, so its truthiness
  // is the signal, not its length) before committing to one.
  candidates.sort((a, b) => b.value - a.value);
  const from = doorTile(store);
  for (const candidate of candidates.slice(0, 6)) {
    if (chebyshev(candidate, home) > reach + 8) continue;
    const door = doorTile(candidate);
    if (findPath(world, from.x, from.y, door.x, door.y, view.owner)) return candidate;
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
