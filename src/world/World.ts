import { W, H } from '../constants';
import { rnd } from '../engine/rng';
import type { Tile } from '../types';

/**
 * Pure map state: the tile grid plus generation and spatial queries.
 * Holds no Three.js — the View reads these tiles to build/refresh meshes.
 */
export class World {
  readonly W = W;
  readonly H = H;
  readonly tiles: Tile[][] = [];

  constructor() {
    for (let y = 0; y < H; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < W; x++) {
        this.tiles[y][x] = { type: 'grass', road: false, b: null, site: null, tree: null, dep: null, field: null, cshade: 0.9 + rnd() * 0.2 };
      }
    }
    this.generate();
  }

  /** Bounds-checked tile accessor. */
  T(x: number, y: number): Tile | null {
    return (x >= 0 && y >= 0 && x < W && y < H) ? this.tiles[y][x] : null;
  }

  /** World-space centre of a tile column/row (grid is centred on origin). */
  wx(tx: number): number { return tx - W / 2 + 0.5; }
  wz(ty: number): number { return ty - H / 2 + 0.5; }

  /** Can a unit stand on / walk through this tile? */
  passable(x: number, y: number): boolean {
    const t = this.T(x, y);
    if (!t) return false;
    if (t.type === 'water') return false;
    if (t.b || t.site) return false;
    return true;
  }

  // ---------- generation ----------
  private generate(): void {
    const blob = (cx: number, cy: number, r: number, fn: (t: Tile) => void) => {
      for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= r * (0.72 + rnd() * 0.33)) fn(this.tiles[y][x]);
        }
    };
    // ponds & meandering water
    blob(5, 40, 6, t => t.type = 'water'); blob(9, 44, 5, t => t.type = 'water');
    blob(44, 6, 5, t => t.type = 'water'); blob(40, 3, 4, t => t.type = 'water');

    const deposits = (cx: number, cy: number, r: number, kind: 'stone' | 'gold' | 'coal', n: number) => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 200) {
        const x = cx + Math.floor((rnd() * 2 - 1) * r), y = cy + Math.floor((rnd() * 2 - 1) * r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep) { t.dep = { kind, amt: 6 + Math.floor(rnd() * 9), meshes: [] }; placed++; }
      }
    };
    deposits(38, 38, 4, 'stone', 9); deposits(10, 8, 4, 'stone', 7);
    deposits(42, 20, 3, 'gold', 7); deposits(6, 24, 3, 'gold', 5);
    deposits(20, 42, 3, 'coal', 7); deposits(34, 8, 3, 'coal', 6);

    const forest = (cx: number, cy: number, r: number, n: number) => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 400) {
        const x = cx + Math.floor((rnd() * 2 - 1) * r), y = cy + Math.floor((rnd() * 2 - 1) * r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep && !t.tree) { t.tree = { growth: 1, reserved: false, meshes: [], s: 0.8 + rnd() * 0.45 }; placed++; }
      }
    };
    forest(14, 16, 6, 26); forest(30, 30, 5, 18); forest(38, 12, 5, 16); forest(12, 34, 5, 14); forest(25, 7, 4, 10);
  }
}
