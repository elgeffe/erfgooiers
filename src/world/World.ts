import { W as DEFAULT_W, H as DEFAULT_H } from '../constants';
import { worldRng } from '../engine/rng';
import type { DecoKind, Tile } from '../types';

// Worldgen pulls exclusively from this stream (reseeded per level) so a level's
// map is fully determined by its seed, independent of sim/cosmetic call order.
const rnd = () => worldRng.next();

/** Per-level map parameters. Densities scale with the level; see data/levels. */
export interface WorldParams {
  seed: number;
  w?: number;
  h?: number;
  treeStands?: number;   // number of woodland clusters
  oreVeins?: number;     // ore clusters placed (stone/gold/coal mix)
  waterScale?: number;   // 0 = dry, 1 = default lake+ponds, >1 = wetter
  meadows?: number;      // lavender patches
  goldPiles?: number;    // scattered gold pickups the hero/serfs collect
}

/**
 * Pure map state: the tile grid plus generation and spatial queries.
 * Holds no Three.js — the View reads these tiles to build/refresh meshes.
 *
 * Generation is fully procedural and seeded from `WorldParams.seed`, so a given
 * run seed + level index always lands in the same patch of Het Gooi: a great
 * lake with small ponds, scattered ore, mixed woodland, lavender meadows and
 * reedy shallows.
 */
export class World {
  readonly W: number;
  readonly H: number;
  readonly tiles: Tile[][] = [];

  private readonly p: Required<WorldParams>;

  constructor(params: WorldParams = { seed: 1337 }) {
    this.p = {
      seed: params.seed,
      w: params.w ?? DEFAULT_W,
      h: params.h ?? DEFAULT_H,
      treeStands: params.treeStands ?? 6,
      oreVeins: params.oreVeins ?? 4,
      waterScale: params.waterScale ?? 1,
      meadows: params.meadows ?? 3,
      goldPiles: params.goldPiles ?? 0,
    };
    this.W = this.p.w;
    this.H = this.p.h;
    worldRng.reseed(this.p.seed);
    for (let y = 0; y < this.H; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < this.W; x++) {
        this.tiles[y][x] = { type: 'grass', road: false, b: null, site: null, tree: null, dep: null, field: null, deco: null, pickup: null, cshade: 0.9 + rnd() * 0.2 };
      }
    }
    this.generate();
  }

  /** Bounds-checked tile accessor. */
  T(x: number, y: number): Tile | null {
    return (x >= 0 && y >= 0 && x < this.W && y < this.H) ? this.tiles[y][x] : null;
  }

  /** World-space centre of a tile column/row (grid is centred on origin). */
  wx(tx: number): number { return tx - this.W / 2 + 0.5; }
  wz(ty: number): number { return ty - this.H / 2 + 0.5; }

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
    const W = this.W, H = this.H;
    const blob = (cx: number, cy: number, r: number, fn: (t: Tile) => void) => {
      for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= r * (0.72 + rnd() * 0.33)) fn(this.tiles[y][x]);
        }
    };

    // ---- water: one large lake plus a few small ponds ----
    // (kept away from the central build zone so the starting settlement fits)
    const central = (x: number, y: number) => Math.hypot(x - W / 2, y - H / 2) < 9;
    const nearCentre = (cx: number, cy: number, r: number) => Math.hypot(cx - W / 2, cy - H / 2) < 10 + r;
    const water = (cx: number, cy: number, r: number) => blob(cx, cy, r, t => t.type = 'water');

    // the large body: a chain of overlapping blobs wandering along the map's
    // outer band, producing one big irregular lake with bays and headlands
    const wet = this.p.waterScale;
    const ang0 = rnd() * Math.PI * 2;
    let lx = W / 2 + Math.cos(ang0) * W * 0.4;
    let ly = H / 2 + Math.sin(ang0) * H * 0.4;
    let drift = ang0 + Math.PI / 2 + (rnd() - 0.5) * 0.8; // wander roughly tangentially
    const lakeBlobs = Math.round(6 * wet);
    for (let i = 0; i < lakeBlobs; i++) {
      const r = Math.max(2, Math.round((5 + Math.floor(rnd() * 3)) * Math.min(1.4, wet)));
      const cx = Math.round(Math.max(2, Math.min(W - 3, lx)));
      const cy = Math.round(Math.max(2, Math.min(H - 3, ly)));
      if (!nearCentre(cx, cy, r)) water(cx, cy, r);
      drift += (rnd() - 0.5) * 0.9;
      lx += Math.cos(drift) * r * 1.1;
      ly += Math.sin(drift) * r * 1.1;
    }

    // small ponds dotted about the rest of the meadow
    const ponds = Math.round((2 + Math.floor(rnd() * 2)) * wet);
    for (let i = 0; i < ponds; i++) {
      const r = 2 + Math.floor(rnd() * 2);
      let cx = 0, cy = 0, guard = 0;
      do { cx = 4 + Math.floor(rnd() * (W - 8)); cy = 4 + Math.floor(rnd() * (H - 8)); }
      while (nearCentre(cx, cy, r) && guard++ < 40);
      if (!nearCentre(cx, cy, r)) water(cx, cy, r);
    }

    const deposits = (cx: number, cy: number, r: number, kind: 'stone' | 'gold' | 'coal', n: number) => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 200) {
        const { x, y } = this.near(cx, cy, r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep) { t.dep = { kind, amt: 6 + Math.floor(rnd() * 9), meshes: [] }; placed++; }
      }
    };
    // ore veins — random clusters, weighted toward stone
    const kindPool: Array<'stone' | 'gold' | 'coal'> = ['stone', 'stone', 'gold', 'coal'];
    for (let i = 0; i < this.p.oreVeins; i++) {
      const kind = kindPool[i % kindPool.length];
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
    for (let i = 0; i < this.p.treeStands; i++) {
      forest(5 + Math.floor(rnd() * (W - 10)), 5 + Math.floor(rnd() * (H - 10)), 4 + Math.floor(rnd() * 3), 12 + Math.floor(rnd() * 16));
    }

    // ---- lavender meadows: dense purple patches of rows ----
    for (let i = 0; i < this.p.meadows; i++) {
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

    // ---- gold piles: scattered pickups for collection quests & gold income ----
    let piles = 0, pguard = 0;
    while (piles < this.p.goldPiles && pguard++ < 500) {
      const x = 3 + Math.floor(rnd() * (W - 6)), y = 3 + Math.floor(rnd() * (H - 6));
      const t = this.T(x, y);
      if (t && t.type === 'grass' && !t.b && !t.site && !t.tree && !t.dep && !t.field && !t.pickup && !central(x, y)) {
        t.pickup = { gold: 3 + Math.floor(rnd() * 5), reserved: false, meshes: [] };
        piles++;
      }
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
