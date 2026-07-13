import type { Coord, Formation } from '../types';

export interface FormationOrigin { x: number; y: number; }

/**
 * Lay out formation destinations around a target, facing away from the
 * selected group's average origin.
 *
 * Built to survive HUGE selections: rotated slots are claimed through a
 * collision-safe lattice projection, rank depth is capped so a 200-unit line is a wide
 * wall three ranks deep rather than one absurd 200-tile string, and a blocked
 * slot is refilled from a small spiral around ITSELF — holes in the ground
 * dent a rank locally instead of dumping half the army into a blob at the
 * click point.
 *
 * Shapes:
 *  - box:   a solid block, ~1.8× wider than deep
 *  - line:  a broad wall at most 3 ranks deep
 *  - column: a marching column, at most 3 files wide
 *  - split: two half-strength boxes flanking a gap (envelopment / pincer)
 *
 * The returned spots are ordered front rank first (nearest the foe, furthest
 * from the group's origin), so a caller that sorts its units by battle order
 * puts the melee on the leading spots and the rear guard on the trailing ones.
 * In a split, both wings interleave rank by rank, so each wing keeps the
 * same front-to-back composition.
 */
export function formationSpots(
  cx: number,
  cy: number,
  count: number,
  formation: Formation,
  origins: FormationOrigin[],
  canUse: (x: number, y: number) => boolean,
  facing?: FormationOrigin,
): Coord[] {
  if (count <= 0) return [];
  const out: Coord[] = [];
  const used = new Set<string>();

  const claim = (x: number, y: number): boolean => {
    const key = `${x},${y}`;
    if (used.has(key) || !canUse(x, y)) return false;
    used.add(key);
    out.push({ x, y });
    return true;
  };

  // a planned slot that is blocked dents the rank locally: try a tight spiral
  // around the slot itself, never falling all the way back to the click point
  const claimNear = (x: number, y: number): void => {
    if (out.length >= count) return;
    if (claim(x, y)) return;
    for (let r = 1; r <= 3; r++)
      for (let ox = -r; ox <= r; ox++)
        for (let oy = -r; oy <= r; oy++) {
          if (Math.abs(ox) !== r && Math.abs(oy) !== r) continue;
          if (claim(x + ox, y + oy)) return;
        }
  };

  // Keep the full facing vector for genuine 360° right-drag aiming. claimNear
  // resolves duplicates produced by projecting a rotated shape to tiles.
  let dx: number, dy: number;
  if (facing && (facing.x || facing.y)) {
    dx = facing.x; dy = facing.y;
  } else {
    let ax = 0, ay = 0;
    for (const p of origins) { ax += p.x; ay += p.y; }
    ax /= Math.max(1, origins.length); ay /= Math.max(1, origins.length);
    dx = cx - ax; dy = cy - ay;
  }
  const fl = Math.hypot(dx, dy) || 1;
  const fx = dx / fl, fy = dy / fl;
  const rxv = -fy, ryv = fx; // the rank axis (perpendicular to facing)

  /** Fill `n` slots as a block `cols` wide, ranks marching backward from the
   *  front line, centred `shift` tiles along the rank axis. Keeps laying
   *  deeper ranks while terrain eats slots, so the block never comes up short
   *  as long as ground exists behind it. */
  const block = (n: number, cols: number, shift: number): void => {
    const target = Math.min(count, out.length + n);
    for (let i = 0; out.length < target && i < n * 5; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      const side = col - (cols - 1) / 2 + shift;
      claimNear(Math.round(cx + rxv * side - fx * row), Math.round(cy + ryv * side - fy * row));
    }
  };

  if (formation === 'line') {
    // a broad wall: never deeper than 3 ranks
    block(count, Math.max(1, Math.ceil(count / 3)), 0);
  } else if (formation === 'column') {
    block(count, Math.min(3, count), 0);
  } else if (formation === 'split') {
    // two half-boxes flanking a central gap — the pincer
    const half = Math.ceil(count / 2), rest = count - half;
    const cols = Math.max(1, Math.round(Math.sqrt(half * 1.8)));
    const gap = cols / 2 + 2.5;
    block(half, cols, -gap);
    block(rest, cols, gap);
  } else {
    // box: a solid block, wider than deep
    block(count, Math.max(1, Math.round(Math.sqrt(count * 1.8))), 0);
  }

  // Grow with the requested army. The old fixed radius silently collapsed
  // selections above its capacity onto the final destination.
  const fallbackRadius = Math.max(32, Math.ceil(Math.sqrt(count)) * 4);
  for (let r = 0; r <= fallbackRadius && out.length < count; r++)
    for (let ox = -r; ox <= r && out.length < count; ox++)
      for (let oy = -r; oy <= r && out.length < count; oy++) {
        if (r > 0 && Math.abs(ox) !== r && Math.abs(oy) !== r) continue;
        claim(cx + ox, cy + oy);
      }
  if (!out.length) out.push({ x: cx, y: cy });
  // sort front rank first: claimNear dents and the fallback spiral can emit
  // spots out of order, and split lays one whole wing before the other
  out.sort((a, b) =>
    (fx * (b.x - a.x) + fy * (b.y - a.y)) ||        // depth along the facing
    (rxv * (a.x - b.x) + ryv * (a.y - b.y)));       // then across the rank
  return out;
}
