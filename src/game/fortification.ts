import type { Coord } from '../types';

/**
 * The fortification planner: pure ring geometry shared by everything that
 * raises curtain walls — the skirmish AI (player walls/gates through the
 * command seam), the stronghold generator (enemy walls/gates placed directly),
 * and any future sandbox planning tools. A plan is geometry only; each caller
 * filters pieces through its own legality (canPlace for player builds,
 * areaClear for spawned strongholds), so refused segments leave the same
 * rough, honest gaps fortresses always had.
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
