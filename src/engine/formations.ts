import type { Coord, Formation } from '../types';

export interface FormationOrigin { x: number; y: number; }

/**
 * Lay out distinct formation destinations around a target. Directional shapes
 * face away from the selected group's average origin. Blocked planned slots
 * are filled from nearby rings so callers always get as many usable spots as
 * the surrounding terrain permits.
 */
export function formationSpots(
  cx: number,
  cy: number,
  count: number,
  formation: Formation,
  origins: FormationOrigin[],
  canUse: (x: number, y: number) => boolean,
): Coord[] {
  if (count <= 0) return [];
  const out: Coord[] = [];
  const used = new Set<string>();
  const tryTile = (x: number, y: number): void => {
    if (out.length >= count) return;
    x = Math.round(x); y = Math.round(y);
    const key = `${x},${y}`;
    if (used.has(key) || !canUse(x, y)) return;
    used.add(key);
    out.push({ x, y });
  };

  let ax = 0, ay = 0;
  for (const p of origins) { ax += p.x; ay += p.y; }
  ax /= Math.max(1, origins.length); ay /= Math.max(1, origins.length);
  const dx = cx - ax, dy = cy - ay, len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len, rx = -fy, ry = fx;
  const put = (side: number, back: number): void => tryTile(cx + rx * side - fx * back, cy + ry * side - fy * back);

  if (formation === 'line') {
    for (let i = 0; i < count; i++) put((i - (count - 1) / 2) * 1.2, 0);
  } else if (formation === 'column') {
    for (let i = 0; i < count; i++) put(0, i * 1.1);
  } else if (formation === 'wedge') {
    put(0, 0);
    for (let row = 1; out.length < count && row < count; row++) {
      put(-row * 0.85, row * 0.9);
      put(row * 0.85, row * 0.9);
    }
  } else {
    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      put(col - (Math.min(cols, count - row * cols) - 1) / 2, row);
    }
  }

  tryTile(cx, cy);
  for (let r = 1; r < 10 && out.length < count; r++)
    for (let ox = -r; ox <= r && out.length < count; ox++)
      for (let oy = -r; oy <= r && out.length < count; oy++) {
        if (Math.abs(ox) !== r && Math.abs(oy) !== r) continue;
        tryTile(cx + ox, cy + oy);
      }
  if (!out.length) out.push({ x: cx, y: cy });
  return out;
}
