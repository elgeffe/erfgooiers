import { W as DEFAULT_W, H as DEFAULT_H } from '../constants';
import { worldRng } from '../engine/rng';
import { BIOMES, pickTreeKind, type BiomeDef, type BiomeKey } from '../data/biomes';
import type { DecoKind, DepositKind, Tile } from '../types';

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
  mountains?: number;    // impassable rocky ridges (natural boundaries / biomes)
  ruins?: number;        // broken old wall lines — impassable but with gaps
  /** Carve the map into friendly and enemy territory: a mountain arc walls off
   *  one corner (with a guarded pass or two), and enemy strongholds/bosses are
   *  placed inside it. Combat starts when YOU march through the pass. */
  frontier?: boolean;
  /** The landscape this map is cut from (palette, flora, fauna, gen character). */
  biome?: BiomeKey;
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
  /** The map's generation seed (exposed for per-tile cosmetic hashing). */
  readonly seed: number;
  readonly tiles: Tile[][] = [];
  /** The walled-off enemy quarter on frontier maps (centre + radius), or null. */
  enemyZone: { x: number; y: number; r: number } | null = null;
  /** The biome this map was generated in (View/models read its palette). */
  readonly biome: BiomeDef;
  /** On single-coast maps: unit vector from the map centre toward the open sea
   *  (the View aligns its horizon sea and lighthouse to it). Null inland. */
  coastDir: { x: number; y: number } | null = null;

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
      mountains: params.mountains ?? 0,
      ruins: params.ruins ?? 0,
      frontier: params.frontier ?? false,
      biome: params.biome ?? 'gooi',
    };
    this.biome = BIOMES[this.p.biome];
    // the biome shapes the terrain: extra ridge chains, denser or thinner woods
    this.p.mountains += this.biome.gen.mountainsAdd;
    this.p.treeStands = Math.round(this.p.treeStands * this.biome.gen.treeMult);
    this.W = this.p.w;
    this.H = this.p.h;
    this.seed = this.p.seed;
    worldRng.reseed(this.p.seed);
    for (let y = 0; y < this.H; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < this.W; x++) {
        this.tiles[y][x] = { type: 'grass', road: false, roadOwner: null, lake: false, b: null, site: null, tree: null, dep: null, field: null, deco: null, pickup: null, cshade: 0.9 + rnd() * 0.2 };
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
    if (t.type !== 'grass') return false; // water & rock both block
    if (t.b || t.site) return false;
    if (t.dep) return false;              // ore heaps are solid — mine from beside them
    if (t.tree?.dense) return false;      // old-growth thickets are a wall of trunks
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
    // the big body's tiles are tagged as lake (fish live here; ponds stay bare)
    const lakeWater = (cx: number, cy: number, r: number) => blob(cx, cy, r, t => { t.type = 'water'; t.lake = true; });

    // ---- the coast: the sea claims the map's edge(s) (fishable, like the lake) ----
    const sea = (x: number, y: number): void => {
      const t = this.T(x, y);
      if (t && !central(x, y)) { t.type = 'water'; t.lake = true; }
    };
    if (this.biome.gen.coast === 'island') {
      // sea all around: a wavy band eats every edge, leaving one irregular isle
      const phase = rnd() * Math.PI * 2, phase2 = rnd() * Math.PI * 2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d = Math.min(x, y, W - 1 - x, H - 1 - y);
        const a = Math.atan2(y - H / 2, x - W / 2);
        const depth = 3.5 + Math.sin(a * 3 + phase) * 1.6 + Math.sin(a * 7 + phase2) * 1.1;
        if (d < depth) sea(x, y);
      }
    } else if (this.biome.gen.coast === 'sea') {
      // one coastline: the sea takes a whole edge, its surf line wandering
      const side = Math.floor(rnd() * 4); // 0=E 1=W 2=S 3=N
      this.coastDir = side === 0 ? { x: 1, y: 0 } : side === 1 ? { x: -1, y: 0 } : side === 2 ? { x: 0, y: 1 } : { x: 0, y: -1 };
      const phase = rnd() * Math.PI * 2;
      for (let i = 0; i < (side < 2 ? H : W); i++) {
        const depth = Math.round(4 + Math.sin(i * 0.22 + phase) * 1.8 + Math.sin(i * 0.57 + phase * 2) * 1.2 + rnd() * 0.8);
        for (let d = 0; d < depth; d++) {
          const x = side === 0 ? W - 1 - d : side === 1 ? d : i;
          const y = side < 2 ? i : side === 2 ? H - 1 - d : d;
          sea(x, y);
        }
      }
    }

    // ---- the river delta: a stream rises inland and braids toward the sea,
    // splitting into distributaries as it nears the mouth. It springs from a
    // point (not the far edge) so both banks stay connected around the source.
    if (this.biome.gen.riverDelta && this.coastDir) {
      const cd = this.coastDir;
      const toSea = Math.atan2(cd.y, cd.x);
      const turn = (from: number, to: number): number => ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const carve = (x0: number, y0: number, width: number, forks: number): void => {
        let x = x0, y = y0, dir = toSea + (rnd() - 0.5) * 0.9;
        for (let step = 0; step < W + H; step++) {
          // meander lazily, steer seaward, and bow away from the build zone
          dir += (rnd() - 0.5) * 0.5 + turn(dir, toSea) * 0.18;
          if (Math.hypot(x - W / 2, y - H / 2) < 14) {
            dir += turn(dir, Math.atan2(y - H / 2, x - W / 2)) * 0.5;
          }
          x += Math.cos(dir); y += Math.sin(dir);
          const cx = Math.round(x), cy = Math.round(y);
          const at = this.T(cx, cy);
          if (!at) return;
          if (at.type === 'water' && at.lake) return; // found its mouth
          for (let oy = -width; oy <= width; oy++) for (let ox = -width; ox <= width; ox++) {
            if (Math.hypot(ox, oy) <= width + 0.2) sea(cx + ox, cy + oy);
          }
          if (forks > 0 && step > 8 && rnd() < 0.12) { carve(cx, cy, Math.max(0, width - 1), 0); forks--; }
        }
      };
      const off = (rnd() < 0.5 ? -1 : 1) * (12 + rnd() * 6);
      carve(W / 2 - cd.x * W * 0.24 + (cd.x === 0 ? off : 0),
            H / 2 - cd.y * H * 0.24 + (cd.y === 0 ? off : 0), 1, 2);
    }

    // ---- polder ditches: straight drainage canals, with grassy crossings
    // every few tiles so no line of water ever seals the map ----
    for (let i = 0; i < (this.biome.gen.ditches ?? 0); i++) {
      const vert = rnd() < 0.5;
      const len = 10 + Math.floor(rnd() * 9);
      let x = 4 + Math.floor(rnd() * Math.max(1, W - 8 - (vert ? 0 : len)));
      let y = 4 + Math.floor(rnd() * Math.max(1, H - 8 - (vert ? len : 0)));
      for (let j = 0; j < len; j++) {
        if (j % 6 < 4) {
          const t = this.T(x, y);
          if (t && t.type === 'grass' && !nearCentre(x, y, 0)) t.type = 'water';
        }
        if (vert) y++; else x++;
      }
    }

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
      if (!nearCentre(cx, cy, r)) lakeWater(cx, cy, r);
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

    // ---- natural boundaries: rocky ridges & broken old walls (both impassable) ----
    // Ridges wander as short chains of blobs, walls as straight-ish lines with
    // gaps — carving the map into passes and biomes without sealing the centre.
    // a mountain must never stand at the water's edge — keep a grass margin
    const nearWater = (x: number, y: number): boolean => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const t = this.T(x + dx, y + dy);
        if (t && t.type === 'water') return true;
      }
      return false;
    };
    const rockTile = (x: number, y: number, kind: 'peak' | 'wall'): void => {
      const t = this.T(x, y);
      if (!t || t.type !== 'grass' || nearCentre(x, y, 2)) return;
      if (kind === 'peak' && nearWater(x, y)) return;
      t.type = 'rock'; t.rock = kind;
    };
    // ---- the frontier: a mountain arc walls off one corner as enemy land ----
    // A thick rock band sweeps a quarter-circle around a random corner, with
    // one clear pass (plus any lake gaps) — the only ways in on foot. The
    // enclosed quarter is exposed as `enemyZone` for stronghold placement.
    if (this.p.frontier) {
      // on a single-coast map the enemy quarter keeps to the landward corners,
      // so its arc (and pass) never drowns in the sea
      let corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
      if (this.coastDir) {
        const cd = this.coastDir;
        corners = corners.filter(([cx, cy]) => (cx - W / 2) * cd.x + (cy - H / 2) * cd.y < 0);
      }
      const corner = corners[Math.floor(rnd() * corners.length)];
      const [cx0, cy0] = corner;
      const R = Math.round(Math.min(W, H) * 0.42);
      const sgnX = cx0 === 0 ? 1 : -1, sgnY = cy0 === 0 ? 1 : -1;
      // the pass: a gap somewhere along the arc, kept off the arc's ends
      const passAng = 0.25 + rnd() * (Math.PI / 2 - 0.5);
      const passHalf = 2.5 / R;                               // ≈5 walkable tiles of gap
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x - cx0) * sgnX, dy = (y - cy0) * sgnY;   // fold every corner into quadrant I
        if (dx < 0 || dy < 0) continue;
        const d = Math.hypot(dx, dy);
        if (d < R - 1.2 || d > R + 1.2) continue;
        const ang = Math.atan2(dy, dx);
        if (Math.abs(ang - passAng) < passHalf) continue;      // leave the pass open
        const t = this.tiles[y][x];
        if (t.type !== 'grass' || nearCentre(x, y, 2)) continue;
        t.type = 'rock'; t.rock = 'peak';
      }
      const ir = Math.round(R * 0.55);
      this.enemyZone = {
        x: cx0 + sgnX * Math.round(ir * Math.cos(Math.PI / 4)),
        y: cy0 + sgnY * Math.round(ir * Math.sin(Math.PI / 4)),
        r: Math.round(R * 0.5),
      };
    }

    // ridges read as RANGES: long chains of overlapping blobs holding one
    // heading with only gentle drift, seeded away from the water
    for (let i = 0; i < this.p.mountains; i++) {
      let mx = 0, my = 0, seedGuard = 0;
      do { mx = 4 + rnd() * (W - 8); my = 4 + rnd() * (H - 8); }
      while (nearWater(Math.round(mx), Math.round(my)) && seedGuard++ < 30);
      let dir = rnd() * Math.PI * 2;
      const links = 6 + Math.floor(rnd() * 4);
      for (let j = 0; j < links; j++) {
        const r = 1 + Math.floor(rnd() * 2);
        const cx = Math.round(mx), cy = Math.round(my);
        for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++)
          for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++)
            if (Math.hypot(x - cx, y - cy) <= r * (0.75 + rnd() * 0.3)) rockTile(x, y, 'peak');
        dir += (rnd() - 0.5) * 0.35;
        mx += Math.cos(dir) * (r + 1.3);
        my += Math.sin(dir) * (r + 1.3);
        // a range that runs into the lake ends there rather than fording it
        if (nearWater(Math.round(mx), Math.round(my))) break;
      }
    }
    for (let i = 0; i < this.p.ruins; i++) {
      let wx = 5 + rnd() * (W - 10), wy = 5 + rnd() * (H - 10);
      const dir = Math.floor(rnd() * 4) * Math.PI / 2 + (rnd() - 0.5) * 0.3;
      const len = 6 + Math.floor(rnd() * 7);
      for (let j = 0; j < len; j++) {
        // crumbled gaps let units (and armies) slip through the old line
        if (rnd() > 0.25) rockTile(Math.round(wx), Math.round(wy), 'wall');
        wx += Math.cos(dir); wy += Math.sin(dir);
      }
    }

    // ---- guarantee the frontier's pass: water (a delta arm, the wandering
    // lake) can conspire with the arc and the ridges to seal the enemy
    // quarter. If the zone can't be walked to from the centre, carve a
    // causeway to it so the assault is always possible on foot.
    if (this.p.frontier && this.enemyZone) {
      const ez = this.enemyZone;
      const seen = new Uint8Array(W * H);
      const qx = [Math.floor(W / 2)], qy = [Math.floor(H / 2)];
      seen[qy[0] * W + qx[0]] = 1;
      let nearest = { x: qx[0], y: qy[0], d: Math.hypot(qx[0] - ez.x, qy[0] - ez.y) };
      let reached = false;
      for (let i = 0; i < qx.length && !reached; i++) {
        const x = qx[i], y = qy[i];
        const d = Math.hypot(x - ez.x, y - ez.y);
        if (d < nearest.d) nearest = { x, y, d };
        if (d <= ez.r) { reached = true; break; }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx]) continue;
          if (this.tiles[ny][nx].type !== 'grass') continue;
          seen[ny * W + nx] = 1; qx.push(nx); qy.push(ny);
        }
      }
      if (!reached) {
        // a straight two-tile-wide causeway from the nearest reachable ground
        // to the zone's heart, filling water and breaking rock as it goes
        const { x: sx, y: sy } = nearest;
        const steps = Math.max(1, Math.ceil(Math.hypot(ez.x - sx, ez.y - sy)) * 2);
        for (let s = 0; s <= steps; s++) {
          const px = Math.round(sx + (ez.x - sx) * s / steps);
          const py = Math.round(sy + (ez.y - sy) * s / steps);
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) {
            const t = this.T(px + ox, py + oy);
            if (t && t.type !== 'grass') { t.type = 'grass'; t.lake = false; t.rock = undefined; t.deco = null; }
          }
        }
      }
    }

    const deposits = (cx: number, cy: number, r: number, kind: DepositKind, n: number): number => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 200) {
        const { x, y } = this.near(cx, cy, r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep) { t.dep = { kind, amt: 10 + Math.floor(rnd() * 11), meshes: [] }; placed++; }
      }
      return placed;
    };
    // ore veins — random clusters, mixed to the biome's taste (iron-red
    // Ardennes, charcoal Black Forest, stone-rich Alps)
    const kindPool: DepositKind[] = this.biome.oreWeights;
    const oreCount: Record<DepositKind, number> = { stone: 0, gold: 0, coal: 0, iron: 0 };
    for (let i = 0; i < this.p.oreVeins; i++) {
      const kind = kindPool[i % kindPool.length];
      const cx = 5 + Math.floor(rnd() * (W - 10)), cy = 5 + Math.floor(rnd() * (H - 10));
      oreCount[kind] += deposits(cx, cy, 3 + Math.floor(rnd() * 2), kind, 5 + Math.floor(rnd() * 5));
    }
    // guarantee a workable minimum of every ore kind: a wetter/late map (or too few
    // veins) can otherwise drop a vein into the lake and leave a whole resource
    // (e.g. gold, breaking the mint chain) absent from the map.
    const MIN_ORE = 6;
    for (const kind of ['stone', 'gold', 'coal', 'iron'] as const) {
      let guard = 0;
      while (oreCount[kind] < MIN_ORE && guard++ < 120) {
        const cx = 4 + Math.floor(rnd() * (W - 8)), cy = 4 + Math.floor(rnd() * (H - 8));
        oreCount[kind] += deposits(cx, cy, 3, kind, MIN_ORE - oreCount[kind]);
      }
    }

    // ---- woodland: mixed stands, tree.kind picks the species/height ----
    const forest = (cx: number, cy: number, r: number, n: number): number => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 400) {
        const { x, y } = this.near(cx, cy, r);
        const t = this.T(x, y);
        if (t && t.type === 'grass' && !t.dep && !t.tree) {
          t.tree = { growth: 1, reserved: false, meshes: [], s: 0.8 + rnd() * 0.45, kind: pickTreeKind(this.biome, rnd()) };
          placed++;
        }
      }
      return placed;
    };
    let treeCount = 0;
    for (let i = 0; i < this.p.treeStands; i++) {
      treeCount += forest(5 + Math.floor(rnd() * (W - 10)), 5 + Math.floor(rnd() * (H - 10)), 4 + Math.floor(rnd() * 3), 12 + Math.floor(rnd() * 16));
    }
    // guarantee a minimum stock of trees so the timber chain is always viable
    let tguard = 0;
    while (treeCount < 14 && tguard++ < 60) {
      treeCount += forest(5 + Math.floor(rnd() * (W - 10)), 5 + Math.floor(rnd() * (H - 10)), 4, 12);
    }

    // ---- old-growth thickets (Black Forest): dense clusters of towering
    // pines no one passes, harvests or builds through — walls made of wood ----
    for (let i = 0; i < this.biome.gen.denseThickets; i++) {
      let cx = 0, cy = 0, guard = 0;
      do { cx = 5 + Math.floor(rnd() * (W - 10)); cy = 5 + Math.floor(rnd() * (H - 10)); }
      while (nearCentre(cx, cy, 4) && guard++ < 40);
      if (nearCentre(cx, cy, 4)) continue;
      blob(cx, cy, 2 + Math.floor(rnd() * 2), t => {
        if (t.type !== 'grass' || t.dep || t.pickup) return;
        if (t.deco) t.deco = null;
        t.tree = { growth: 1, reserved: true, meshes: [], s: 1.15 + rnd() * 0.45, kind: 1, dense: true };
      });
    }

    // ---- flowering meadows: dense patches of the biome's signature flora ----
    for (let i = 0; i < this.p.meadows; i++) {
      const cx = 6 + Math.floor(rnd() * (W - 12)), cy = 6 + Math.floor(rnd() * (H - 12));
      blob(cx, cy, 2 + Math.floor(rnd() * 3), t => {
        if (t.type === 'grass' && !t.tree && !t.dep && !t.deco && rnd() < 0.85) this.setDeco(t, this.biome.meadowDeco);
      });
    }

    // ---- reeds & lilies fringe / fill the water (nothing fringes lava) ----
    if (!this.biome.gen.scorched) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.tiles[y][x];
      if (t.type !== 'water') continue;
      const land = this.landNeighbours(x, y);
      if (land > 0) { if (rnd() < 0.5) this.setDeco(t, 'reed'); }          // shoreline reeds
      // open-water lilies — freshwater only, nothing blooms on the salt sea
      else if (rnd() < 0.28 && !this.biome.gen.coast) this.setDeco(t, 'lily');
    }

    // ---- loose greenery: wildflowers & bushes dotted across the meadow ----
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.tiles[y][x];
      if (t.type !== 'grass' || t.tree || t.dep || t.deco || central(x, y)) continue;
      const r = rnd();
      if (r < 0.045) this.setDeco(t, this.biome.scatterDeco[0]);
      else if (r < 0.065) this.setDeco(t, this.biome.scatterDeco[1]);
    }

    // ---- gold piles: scattered pickups for collection quests & gold income ----
    let piles = 0, pguard = 0;
    while (piles < this.p.goldPiles && pguard++ < 500) {
      const x = 3 + Math.floor(rnd() * (W - 6)), y = 3 + Math.floor(rnd() * (H - 6));
      const t = this.T(x, y);
      if (t && t.type === 'grass' && !t.b && !t.site && !t.tree && !t.dep && !t.field && !t.pickup && !t.deco && !central(x, y)) {
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
