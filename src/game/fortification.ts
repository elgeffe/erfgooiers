import type { Coord } from '../types';

/**
 * The fortification planner: pure ring geometry for systems that raise curtain
 * walls. The stronghold generator currently consumes it directly; a future
 * skirmish-AI or sandbox caller can feed player walls/gates through the command
 * seam. A plan is geometry only; each caller filters pieces through its own
 * legality (canPlace for player builds, areaClear for spawned strongholds), so
 * refused segments leave the same rough, honest gaps fortresses always had.
 *
 * Rings are square curtains of 2×2 blocks at a Chebyshev radius around a 2×2
 * anchor building, with gates mid-side. Gates are what make LAYERED defence
 * work: the owner's serfs and armies walk through their own gates freely, so
 * concentric rings become working baileys, while every hostile must batter a
 * way in.
 */

export type FortSide = 'n' | 'e' | 's' | 'w';

export interface FortificationPiece {
  /** Which slot in the curtain: gates go mid-side, walls everywhere else. */
  kind: 'wall' | 'gate';
  x: number;
  y: number;
  rot: number;
  side: FortSide;
}

/** The compass side of `center` that faces `toward` (ties break east/west
 *  first, matching the historical stronghold builder). */
export function sideToward(center: Coord, toward: Coord): FortSide {
  const dx = toward.x - center.x, dy = toward.y - center.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'e' : 'w';
  return dy > 0 ? 's' : 'n';
}

/**
 * Plan one square curtain ring at `radius` (even, ≥4) around `center` (the
 * anchor building's top-left tile), with a gate mid-side for every entry in
 * `gateSides`. Iteration order is row-major exactly like the original
 * stronghold builder, so refactored callers place identical fortresses.
 */
export function planFortificationRing(center: Coord, radius: number, gateSides: FortSide[]): FortificationPiece[] {
  const pieces: FortificationPiece[] = [];
  for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) {
    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
    const side: FortSide = Math.abs(dx) === radius && Math.abs(dy) !== radius
      ? (dx > 0 ? 'e' : 'w')
      : Math.abs(dy) === radius && Math.abs(dx) !== radius
        ? (dy > 0 ? 's' : 'n')
        : (dx > 0 ? 'e' : 'w'); // corners lean to their east/west face
    const gate = gateSides.some(g =>
      (g === 'e' && dx === radius && dy === 0)
      || (g === 'w' && dx === -radius && dy === 0)
      || (g === 's' && dy === radius && dx === 0)
      || (g === 'n' && dy === -radius && dx === 0));
    // gates on the east/west curtain turn their archway to run east–west
    const rot = gate && (side === 'e' || side === 'w') ? 1 : 0;
    pieces.push({ kind: gate ? 'gate' : 'wall', x: center.x + dx, y: center.y + dy, rot, side });
  }
  return pieces;
}

/**
 * Plan a straight DEFENSIVE LINE facing the enemy, instead of a full square
 * curtain. The line sits `distance` tiles from `center` on the side toward
 * `enemy`, spanning `halfSpan` 2×2 blocks each way along the perpendicular,
 * with a gate on the central approach so the garrison can sortie. Pieces are
 * ordered from the centre outward so a caller placing one per pass grows the
 * wall symmetrically from the gate.
 *
 * This is the "use the terrain" primitive: the caller skips any segment whose
 * ground is already impassable (a lake, a ridge) — natural barriers ARE the
 * wall there — so the masonry only closes the OPEN approaches between them,
 * which is what makes a line strategic rather than a pointless full ring.
 */
export function planDefensiveLine(center: Coord, enemy: Coord, distance: number, halfSpan: number): FortificationPiece[] {
  const dx = enemy.x - center.x, dy = enemy.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len;             // unit vector toward the enemy
  const side: FortSide = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 'e' : 'w') : (fy > 0 ? 's' : 'n');
  // Project the gate onto the actual enemy approach, but snap the curtain's
  // run to a cardinal axis. Rounding every point along a diagonal run makes
  // successive 2x2 pieces move by only one tile on one or both axes, causing
  // their footprints to overlap. A cardinal two-tile stride stays contiguous
  // and overlap-free for every approach angle.
  const gateX = Math.round(center.x + fx * distance);
  const gateY = Math.round(center.y + fy * distance);
  const runX = side === 'n' ? 1 : side === 's' ? -1 : 0;
  const runY = side === 'e' ? 1 : side === 'w' ? -1 : 0;
  // gate archway runs along the enemy axis: a mostly-vertical approach (n/s)
  // wants a north–south gate (rot 0), an east–west approach an e–w gate (rot 1)
  const gateRot = side === 'e' || side === 'w' ? 1 : 0;
  const order: number[] = [0];
  for (let k = 1; k <= halfSpan; k++) order.push(k, -k);
  const pieces: FortificationPiece[] = [];
  for (const k of order) {
    const x = gateX + runX * k * 2;
    const y = gateY + runY * k * 2;
    pieces.push({ kind: k === 0 ? 'gate' : 'wall', x, y, rot: k === 0 ? gateRot : 0, side });
  }
  return pieces;
}

/** Inner-corner tower spots for a ring (just behind the curtain), in the
 *  stronghold builder's historical order. */
export function ringTowerSpots(center: Coord, radius: number): Coord[] {
  const inset = radius - 2;
  return [
    { x: center.x - inset, y: center.y - inset },
    { x: center.x + inset, y: center.y - inset },
    { x: center.x - inset, y: center.y + inset },
    { x: center.x + inset, y: center.y + inset },
  ];
}
