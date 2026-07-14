import { TILE_COST_ROAD, TILE_COST_GRASS } from '../constants';
import type { World } from '../world/World';
import type { Coord, OwnerId } from '../types';

// A* over the tile grid, 8-directional. Open ground costs TILE_COST_GRASS per
// step while roads cost TILE_COST_ROAD, so units take a paved detour whenever
// it isn't wildly longer than the beeline. Diagonal steps cost ×√2 and may not
// cut corners (both orthogonal neighbours must be passable). The octile
// heuristic is weighted by the road cost (the cheapest possible step) to stay
// admissible. The goal tile is always considered enterable even if occupied
// (door tiles). The raw path is then string-pulled (`smooth`) so units walk
// natural straight lines across open ground instead of grid staircases.
export const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export interface OpenNode { x: number; y: number; f: number; }

/** Allocation-light binary min-heap. Mass formation orders can enqueue tens
 * of thousands of A* frontier nodes; linear scans of the old open array made
 * that work quadratic. */
export class MinHeap {
  private readonly a: OpenNode[] = [];
  get length(): number { return this.a.length; }
  push(n: OpenNode): void {
    const a = this.a;
    let i = a.length;
    a.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= n.f) break;
      a[i] = a[p]; i = p;
    }
    a[i] = n;
  }
  pop(): OpenNode {
    const a = this.a, root = a[0], tail = a.pop()!;
    if (a.length) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const c = r < a.length && a[r].f < a[l].f ? r : l;
        if (a[c].f >= tail.f) break;
        a[i] = a[c]; i = c;
      }
      a[i] = tail;
    }
    return root;
  }
}

/** An optional fence for the search: neighbours outside it are never expanded.
 *  Used for the short "take your exact formation slot" hop at the end of a
 *  flow-field path, where the whole search belongs inside the formation. */
export interface SearchBox { x0: number; y0: number; x1: number; y1: number; }

// Scratch buffers reused across searches (findPath is synchronous and never
// re-entered). Fresh ~120 KB allocations per call made the GC, not the search,
// the dominant cost when flow-field slot hops run in the hundreds per tick.
let scratchSize = 0;
let gScratch = new Float64Array(0);
let cameScratch = new Int32Array(0);
let closedScratch = new Uint8Array(0);

export function findPath(world: World, sx: number, sy: number, ex: number, ey: number, mover?: OwnerId, box?: SearchBox): Coord[] | null {
  if (sx === ex && sy === ey) return [];
  const W = world.W, H = world.H;
  const tiles = world.tiles;
  const open = new MinHeap();
  const size = W * H;
  if (size > scratchSize) {
    scratchSize = size;
    gScratch = new Float64Array(size);
    cameScratch = new Int32Array(size);
    closedScratch = new Uint8Array(size);
  }
  const gS = gScratch.subarray(0, size); gS.fill(Infinity);
  const came = cameScratch.subarray(0, size); came.fill(-1);
  const key = (x: number, y: number) => y * W + x;
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - ex), dy = Math.abs(y - ey);
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * TILE_COST_ROAD;
  };
  open.push({ x: sx, y: sy, f: h(sx, sy) });
  gS[key(sx, sy)] = 0;
  const closed = closedScratch.subarray(0, size); closed.fill(0);
  while (open.length) {
    const cur = open.pop();
    const ck = key(cur.x, cur.y);
    if (closed[ck]) continue;
    closed[ck] = 1;
    if (cur.x === ex && cur.y === ey) {
      const path: Coord[] = [];
      let k = ck;
      while (came[k] >= 0) { path.push({ x: k % W, y: Math.floor(k / W) }); k = came[k]; }
      path.reverse();
      return smooth(world, sx, sy, path, mover);
    }
    for (const [dx, dy, mult] of DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (box && (nx < box.x0 || ny < box.y0 || nx > box.x1 || ny > box.y1)) continue;
      if (!(nx === ex && ny === ey) && !world.passable(nx, ny, mover)) continue;
      // no corner cutting: a diagonal step needs both orthogonal shoulders clear
      if (dx !== 0 && dy !== 0 && (!world.passable(cur.x + dx, cur.y, mover) || !world.passable(cur.x, cur.y + dy, mover))) continue;
      const t = tiles[ny][nx];
      if (t.type !== 'grass') continue; // water & rock both block
      const cost = (t.road ? TILE_COST_ROAD : TILE_COST_GRASS) * mult;
      const ng = gS[ck] + cost, nk = key(nx, ny);
      if (gS[nk] <= ng) continue;
      gS[nk] = ng;
      came[nk] = ck;
      open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
    }
  }
  return null;
}

/**
 * String-pull the raw A* path: greedily connect each waypoint to the farthest
 * later node it can see in a straight line, dropping the grid zigzag between.
 * Road nodes are never skipped over — a paved detour the A* paid for stays a
 * paved detour, so units keep their road speed bonus.
 */
export function smooth(world: World, sx: number, sy: number, path: Coord[], mover?: OwnerId): Coord[] {
  if (path.length <= 1) return path;
  const out: Coord[] = [];
  let ax = sx, ay = sy, i = 0;
  while (i < path.length) {
    let far = i;
    // cap the lookahead: the greedy scan is quadratic in the span it clears,
    // and a long straight line is just as straight with a node every 32 tiles
    const jEnd = Math.min(path.length, i + 33);
    for (let j = i + 1; j < jEnd; j++) {
      // don't cut across intermediate road nodes (keep the detour) and stop
      // extending once the straight line is blocked
      if (world.tiles[path[j - 1].y][path[j - 1].x].road) break;
      if (!lineClear(world, ax, ay, path[j].x, path[j].y, mover)) break;
      far = j;
    }
    out.push(path[far]);
    ax = path[far].x; ay = path[far].y;
    i = far + 1;
  }
  return out;
}

/** Can a unit walk the straight segment between two tile centres? The end tile
 *  itself is exempt (door tiles are occupied but enterable). */
function lineClear(world: World, x0: number, y0: number, x1: number, y1: number, mover?: OwnerId): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4);
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const tx = Math.round(x0 + dx * t), ty = Math.round(y0 + dy * t);
    if (tx === x1 && ty === y1) continue;
    if (!world.passable(tx, ty, mover)) return false;
  }
  return true;
}
