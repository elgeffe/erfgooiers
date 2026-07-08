import { W, H, TILE_COST_ROAD } from '../constants';
import type { World } from '../world/World';
import type { Coord } from '../types';

// A* over the tile grid. Roads are cheaper (TILE_COST_ROAD) so units prefer them.
// The goal tile is always considered enterable even if occupied (door tiles).
export function findPath(world: World, sx: number, sy: number, ex: number, ey: number): Coord[] | null {
  if (sx === ex && sy === ey) return [];
  const tiles = world.tiles;
  const open: { x: number; y: number; f: number }[] = [];
  const gS = new Map<number, number>();
  const came = new Map<number, number>();
  const key = (x: number, y: number) => y * W + x;
  const h = (x: number, y: number) => (Math.abs(x - ex) + Math.abs(y - ey)) * TILE_COST_ROAD;
  open.push({ x: sx, y: sy, f: h(sx, sy) });
  gS.set(key(sx, sy), 0);
  const closed = new Set<number>();
  let guard = 0;
  while (open.length && guard++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.x === ex && cur.y === ey) {
      const path: Coord[] = [];
      let k = ck;
      while (came.has(k)) { path.push({ x: k % W, y: Math.floor(k / W) }); k = came.get(k)!; }
      path.reverse();
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!(nx === ex && ny === ey) && !world.passable(nx, ny)) continue;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const t = tiles[ny][nx];
      if (t.type === 'water') continue;
      const cost = t.road ? TILE_COST_ROAD : 1;
      const ng = gS.get(ck)! + cost, nk = key(nx, ny);
      if (gS.has(nk) && gS.get(nk)! <= ng) continue;
      gS.set(nk, ng);
      came.set(nk, ck);
      open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
    }
  }
  return null;
}
