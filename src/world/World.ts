import { W, H } from '../constants';
import { rnd } from '../engine/rng';
import type { DecoKind, Tile } from '../types';

/**
 * Pure map state: the tile grid plus generation and spatial queries.
 * Holds no Three.js — the View reads these tiles to build/refresh meshes.
 *
 * Generation is fully procedural and reseeded on every load (see main.ts),
 * so each session lands in a freshly shaped patch of Het Gooi: wandering
 * ponds, scattered ore, mixed woodland, lavender meadows and reedy shallows.
 */
export class World {
  readonly W = W;
  readonly H = H;
  readonly tiles: Tile[][] = [];

  constructor() {
    for (let y = 0; y < H; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < W; x++) {
        this.tiles[y][x] = { type: 'grass', road: false, b: null, site: null, tree: null, dep: null, field: null, deco: null, cshade: 0.9 + rnd() * 0.2 };
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

  private near(cx: number, cy: number, r: number): { x: number; y: number } {
    return { x: cx + Math.floor((rnd() * 2 - 1) * r), y: cy + Math.floor((rnd() * 2 - 1) * r) };
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

    // ---- water: a handful of ponds & lakes scattered around the edges ----
    // (kept away from the central build zone so the starting settlement fits)
    const central = (x: number, y: number) => Math.hypot(x - W / 2, y - H / 2) < 9;
    const waterBodies = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < waterBodies; i++) {
      let cx = 0, cy = 0, guard = 0;
      do { cx = 4 + Math.floor(rnd() * (W - 8)); cy = 4 + Math.floor(rnd() * (H - 8)); }
      while (central(cx, cy) && guard++ < 40);
      const r = 4 + Math.floor(rnd() * 4);
      blob(cx, cy, r, t => t.type = 'water');
      // a wandering finger trailing off the main body for a natural shoreline
      if (rnd() < 0.7) blob(cx + Math.floor((rnd() * 2 - 1) * r), cy + Math.floor((rnd() * 2 - 1) * r), Math.max(2, r - 2), t => t.type = 'water');
    }

    const deposits = (cx: number, cy: number, r: number, kind: 'stone' | 'gold' | 'coal', n: number) => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 200) {
        const { x, y } = this.near(cx, cy, r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep) { t.dep = { kind, amt: 6 + Math.floor(rnd() * 9), meshes: [] }; placed++; }
      }
    };
    // ore veins — random clusters of each kind
    const kinds: Array<'stone' | 'gold' | 'coal'> = ['stone', 'stone', 'gold', 'coal'];
    for (const kind of kinds) {
      const cx = 5 + Math.floor(rnd() * (W - 10)), cy = 5 + Math.floor(rnd() * (H - 10));
      deposits(cx, cy, 3 + Math.floor(rnd() * 2), kind, 5 + Math.floor(rnd() * 5));
    }

    // ---- woodland: mixed stands, tree.kind picks the species/height ----
    const forest = (cx: number, cy: number, r: number, n: number) => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 400) {
        const { x, y } = this.near(cx, cy, r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep && !t.tree) {
          t.tree = { growth: 1, reserved: false, meshes: [], s: 0.8 + rnd() * 0.45, kind: Math.floor(rnd() * 4) };
          placed++;
        }
      }
    };
    const stands = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < stands; i++) {
      forest(5 + Math.floor(rnd() * (W - 10)), 5 + Math.floor(rnd() * (H - 10)), 4 + Math.floor(rnd() * 3), 12 + Math.floor(rnd() * 16));
    }

    // ---- lavender meadows: dense purple patches of rows ----
    const meadows = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < meadows; i++) {
      const cx = 6 + Math.floor(rnd() * (W - 12)), cy = 6 + Math.floor(rnd() * (H - 12));
      blob(cx, cy, 2 + Math.floor(rnd() * 3), t => {
        if (t.type === 'grass' && !t.tree && !t.dep && !t.deco && rnd() < 0.85) this.setDeco(t, 'lavender');
      });
    }

    // ---- reeds & lilies fringe / fill the water ----
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.tiles[y][x];
      if (t.type !== 'water') continue;
      const land = this.landNeighbours(x, y);
      if (land > 0) { if (rnd() < 0.5) this.setDeco(t, 'reed'); }          // shoreline reeds
      else if (rnd() < 0.28) this.setDeco(t, 'lily');                       // open-water lilies
    }

    // ---- loose greenery: wildflowers & bushes dotted across the meadow ----
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.tiles[y][x];
      if (t.type !== 'grass' || t.tree || t.dep || t.deco || central(x, y)) continue;
      const r = rnd();
      if (r < 0.045) this.setDeco(t, 'flowers');
      else if (r < 0.065) this.setDeco(t, 'bush');
    }
  }

  private setDeco(t: Tile, kind: DecoKind): void { t.deco = { kind, meshes: [] }; }

  /** Count of orthogonal neighbours that are land (used to find shorelines). */
  private landNeighbours(x: number, y: number): number {
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = this.T(x + dx, y + dy);
      if (t && t.type !== 'water') n++;
    }
    return n;
  }
}
