import { TILE_COST_ROAD, TILE_COST_GRASS } from '../constants';
import { DIRS, MinHeap, findPath, smooth } from './pathfinding';
import type { World } from '../world/World';
import type { Coord, OwnerId } from '../types';

/**
 * A shared flow field for group orders. A mass command ("300 soldiers, march
 * there") used to cost one full-map A* per unit — hundreds of near-identical
 * searches over the same ground, drip-fed through the per-tick path budget.
 * The redundancy is structural: every unit shares the one destination area,
 * so the unit×destination cost matrix is effectively rank one. One reverse
 * Dijkstra flooded outward from the destination tiles captures ALL of it;
 * afterwards each unit derives its own path by walking parent pointers
 * downhill — O(path length) per unit instead of O(map) per unit.
 *
 * The cost model mirrors findPath exactly (roads cheaper than grass, diagonal
 * ×√2, no corner cutting), so a descent is the same road-hugging route A*
 * would have picked toward the nearest seed. Like a computed path, a field is
 * a snapshot: ground built over after the order was issued isn't seen. Units
 * whose ground the field cannot serve fall back to the budgeted global A*.
 */
export interface FlowField {
  /** Cost to the nearest seed per tile (Infinity = unreachable). */
  dist: Float32Array;
  /** Tile index of the next step toward the seeds (-1 at a seed itself). */
  toSeed: Int32Array;
  /** Padded bounding box of the seeds: the fence for the exact-slot hop. */
  x0: number; y0: number; x1: number; y1: number;
}

/** Flood the map outward from the order's destination tiles. Seeds are always
 *  enterable (the same goal-tile exemption findPath grants door tiles). */
export function buildFlowField(world: World, seeds: Coord[], mover?: OwnerId): FlowField {
  const W = world.W, H = world.H, size = W * H;
  const dist = new Float32Array(size); dist.fill(Infinity);
  const toSeed = new Int32Array(size); toSeed.fill(-1);
  const open = new MinHeap();
  let x0 = W - 1, y0 = H - 1, x1 = 0, y1 = 0;
  for (const s of seeds) {
    if (s.x < 0 || s.y < 0 || s.x >= W || s.y >= H) continue;
    const k = s.y * W + s.x;
    if (dist[k] === 0) continue;
    dist[k] = 0;
    open.push({ x: s.x, y: s.y, f: 0 });
    x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
  }
  const closed = new Uint8Array(size);
  const tiles = world.tiles;
  while (open.length) {
    const cur = open.pop();
    const ck = cur.y * W + cur.x;
    if (closed[ck]) continue;
    closed[ck] = 1;
    for (const [dx, dy, mult] of DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!world.passable(nx, ny, mover)) continue;
      // no corner cutting: a diagonal step needs both orthogonal shoulders clear
      if (dx !== 0 && dy !== 0 && (!world.passable(cur.x + dx, cur.y, mover) || !world.passable(cur.x, cur.y + dy, mover))) continue;
      const t = tiles[ny][nx];
      const cost = (t.road ? TILE_COST_ROAD : TILE_COST_GRASS) * mult;
      const nd = dist[ck] + cost, nk = ny * W + nx;
      if (dist[nk] <= nd) continue;
      dist[nk] = nd;
      toSeed[nk] = ck;
      open.push({ x: nx, y: ny, f: nd });
    }
  }
  // pad the seed bbox so the finishing hop can bend around local obstacles
  return {
    dist, toSeed,
    x0: Math.max(0, x0 - 4), y0: Math.max(0, y0 - 4),
    x1: Math.min(W - 1, x1 + 4), y1: Math.min(H - 1, y1 + 4),
  };
}

/** One unit's own path out of a shared field: walk the parent chain downhill
 *  to the nearest seed, then — when the order names an exact slot elsewhere in
 *  the formation — finish with a small A* fenced into the seeds' bounding box.
 *  Omit `ex`/`ey` to accept whichever seed the descent reaches (sieges spread
 *  around the ring afterwards on their own). Returns null when the field
 *  cannot serve this unit; the caller falls back to a budgeted global search. */
export function fieldPath(world: World, field: FlowField, sx: number, sy: number, ex?: number, ey?: number, mover?: OwnerId): Coord[] | null {
  const W = world.W;
  let k = sy * W + sx;
  if (field.dist[k] === Infinity) return null;
  // collect only the turn points: collinear runs of the parent chain extend
  // the previous waypoint in place, so a 120-tile descent yields a handful of
  // nodes (not a handful of thousand short-lived Coords across a whole host)
  const chain: Coord[] = [];
  let px = sx, py = sy, runX = 0, runY = 0;
  while (field.toSeed[k] >= 0) {
    k = field.toSeed[k];
    const x = k % W, y = (k / W) | 0;
    const dx = x - px, dy = y - py;
    const last = chain[chain.length - 1];
    if (last && dx === runX && dy === runY) { last.x = x; last.y = y; }
    else { chain.push({ x, y }); runX = dx; runY = dy; }
    px = x; py = y;
  }
  const end = chain.length ? chain[chain.length - 1] : { x: sx, y: sy };
  const out = smooth(world, sx, sy, chain, mover);
  if (ex === undefined || ey === undefined || (end.x === ex && end.y === ey)) return out;
  const hop = findPath(world, end.x, end.y, ex, ey, mover, field);
  if (!hop) return null;
  out.push(...hop);
  return out;
}
