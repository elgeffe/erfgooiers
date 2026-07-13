import { W as DEFAULT_W, H as DEFAULT_H } from '../constants';
import { worldRng } from '../engine/rng';
import { BIOMES, pickTreeKind, type BiomeDef, type BiomeKey } from '../data/biomes';
import type { DecoKind, DepositKind, Faction, Tile } from '../types';

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
  /** How many corners get walled off (default 1 when `frontier` is set). The
   *  hardest maps wall several corners, each with its own pass and garrison. */
  frontiers?: number;
  /** Build a staged, directional chain of open mountain pockets instead of
   *  corner arcs. Used by boss maps whose encounters should form a route. */
  lairStages?: number;
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
  /** The walled-off enemy quarters on frontier maps (centre + radius), each
   *  with the open pass through its mountain arc (gate garrisons stand there). */
  enemyZones: { x: number; y: number; r: number; pass: { x: number; y: number } }[] = [];
  /** The first walled-off quarter, or null — kept for single-zone callers. */
  enemyZone: { x: number; y: number; r: number; pass: { x: number; y: number } } | null = null;
  /** Top-left tile for the player's starting castle. Hostile frontier maps put
   *  it toward the corner opposite the enemy instead of forcing mid-map. */
  playerStart: { x: number; y: number };
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
      frontiers: params.frontiers ?? (params.frontier ? 1 : 0),
      lairStages: params.lairStages ?? 0,
      biome: params.biome ?? 'gooi',
    };
    this.biome = BIOMES[this.p.biome];
    // the biome shapes the terrain: extra ridge chains, denser or thinner woods
    this.p.mountains += this.biome.gen.mountainsAdd;
    if (this.biome.gen.flatland) this.p.mountains = 0;
    this.p.treeStands = Math.round(this.p.treeStands * this.biome.gen.treeMult);
    this.W = this.p.w;
    this.H = this.p.h;
    this.playerStart = { x: Math.floor(this.W / 2) - 1, y: Math.floor(this.H / 2) - 1 };
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

  /** Can a unit stand on / walk through this tile? A `faction` lets that
   *  side's units walk through its own gates; everyone else is walled out. */
  passable(x: number, y: number, faction?: Faction): boolean {
    const t = this.T(x, y);
    if (!t) return false;
    if (t.type !== 'grass') return false; // water & rock both block
    if (t.b || t.site) {
      const ownGate = !!faction && !!t.b && !t.site && t.b.def.gate && t.b.faction === faction;
      if (!ownGate) return false;
    }
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
    // ---- the frontier: directional ranges wall off enemy land ----
    // Ordinary frontier maps use broad, irregular corner crescents. Boss lairs
    // use a chain of open U-shaped pockets, turning the map into a readable
    // route of successively deeper encounters rather than a set of circles.
    const frontierCount = Math.max(this.p.frontiers, this.p.frontier ? 1 : 0);
    if (frontierCount > 0) {
      // on a single-coast map the enemy quarters keep to the landward corners,
      // so their arcs (and passes) never drown in the sea
      let corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
      if (this.coastDir) {
        const cd = this.coastDir;
        corners = corners.filter(([cx, cy]) => (cx - W / 2) * cd.x + (cy - H / 2) * cd.y < 0);
      }
      for (let i = corners.length - 1; i > 0; i--) { // seeded shuffle, distinct corners
        const j = Math.floor(rnd() * (i + 1));
        [corners[i], corners[j]] = [corners[j], corners[i]];
      }
      if (this.p.lairStages > 0) {
        const [ex, ey] = corners[0];
        const inset = Math.max(8, Math.round(Math.min(W, H) * 0.1));
        const enemyEnd = { x: ex === 0 ? inset : W - 1 - inset, y: ey === 0 ? inset : H - 1 - inset };
        const startCentre = { x: ex === 0 ? W - 1 - inset : inset, y: ey === 0 ? H - 1 - inset : inset };
        this.playerStart = { x: startCentre.x - 1, y: startCentre.y - 1 };
        const vx = enemyEnd.x - startCentre.x, vy = enemyEnd.y - startCentre.y;
        const vl = Math.max(1, Math.hypot(vx, vy));
        const nx = vx / vl, ny = vy / vl, pxv = -ny, pyv = nx;
        const bend = (rnd() < 0.5 ? -1 : 1) * Math.min(W, H) * (0.07 + rnd() * 0.025);
        const stages = Math.max(1, this.p.lairStages);
        for (let z = 0; z < stages; z++) {
          const t = stages === 1 ? 0.72 : 0.32 + z * 0.55 / (stages - 1);
          const stagger = (z % 2 === 0 ? -1 : 1) * Math.min(W, H) * 0.025;
          const curve = Math.sin(t * Math.PI) * bend + stagger;
          const zx = Math.round(startCentre.x + vx * t + pxv * curve);
          const zy = Math.round(startCentre.y + vy * t + pyv * curve);
          const R = Math.max(7, Math.round(Math.min(W, H) * 0.085 + z * 0.55));
          const phase = rnd() * Math.PI * 2;
          const lairRock = (x: number, y: number): void => {
            // The authored silhouette wins over a wandering lake. Give every
            // peak its usual grass foot so ranges remain continuous and never
            // rise directly out of water.
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
              const t = this.T(x + ox, y + oy);
              if (t?.type === 'water') { t.type = 'grass'; t.lake = false; t.deco = null; }
            }
            rockTile(x, y, 'peak');
          };
          // A craggy U: long unequal arms and an irregular back wall. Its broad
          // mouth faces the player's previous encounter along the route.
          for (let y = Math.max(0, zy - R - 4); y <= Math.min(H - 1, zy + R + 4); y++) {
            for (let x = Math.max(0, zx - R - 4); x <= Math.min(W - 1, zx + R + 4); x++) {
              const dx = x - zx, dy = y - zy;
              const along = dx * nx + dy * ny;
              const across = dx * pxv + dy * pyv;
              const half = R * (0.72 + Math.sin(along * 0.42 + phase) * 0.09);
              const leftArm = Math.abs(across + half) < 1.2 && along > -R * 0.62 && along < R * 0.9;
              const rightArm = Math.abs(across - half) < 1.2 && along > -R * 0.42 && along < R * 0.9;
              const back = R * 0.86 + Math.sin(across * 0.55 + phase) * 1.4;
              const backWall = Math.abs(along - back) < 1.2 && Math.abs(across) <= half + 0.8;
              if (leftArm || rightArm || backWall) lairRock(x, y);
            }
          }
          const pass = {
            x: Math.round(zx - nx * R * 0.58),
            y: Math.round(zy - ny * R * 0.58),
          };
          this.enemyZones.push({ x: zx, y: zy, r: Math.max(4, Math.round(R * 0.48)), pass });
        }
        // Single-zone callers (notably boss placement) want the deepest lair.
        this.enemyZone = this.enemyZones[this.enemyZones.length - 1];
      } else {
        const zones = Math.min(frontierCount, corners.length);
        for (let z = 0; z < zones; z++) {
        const [cx0, cy0] = corners[z];
      // several walled quarters must not merge: shrink the arcs a touch
      const R = Math.round(Math.min(W, H) * (zones > 1 ? 0.36 : 0.42));
      const sgnX = cx0 === 0 ? 1 : -1, sgnY = cy0 === 0 ? 1 : -1;
      // the pass: a gap somewhere along the arc, kept off the arc's ends
      const passAng = 0.25 + rnd() * (Math.PI / 2 - 0.5);
      const passHalf = 4.5 / R;                               // ≈9 walkable tiles of gap
      // Every range meanders. Two harmonics and a lopsided shoulder stop the
      // boundary reading as a clean quarter-circle from the isometric camera.
      const style = rnd();
      const amp = 2.2 + rnd() * 3;
      const wobF = 3 + rnd() * 3, wobP = rnd() * Math.PI * 2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x - cx0) * sgnX, dy = (y - cy0) * sgnY;   // fold every corner into quadrant I
        if (dx < 0 || dy < 0) continue;
        const d = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const shoulder = (ang - Math.PI / 4) * (style < 0.5 ? -3 : 3);
        const Ra = R + Math.sin(ang * wobF + wobP) * amp
          + Math.sin(ang * (wobF * 0.47 + 1.3) - wobP) * 1.6 + shoulder;
        if (d < Ra - 1.2 || d > Ra + 1.2) continue;
        if (Math.abs(ang - passAng) < passHalf) continue;      // leave the pass open
        const t = this.tiles[y][x];
        if (t.type !== 'grass' || nearCentre(x, y, 2)) continue;
        t.type = 'rock'; t.rock = 'peak';
      }
      // corridor style: two ridge spurs flank the approach to the pass, so the
      // way in reads as a mountain corridor rather than a hole in a ring
      if (style >= 0.72) {
        const len = Math.round(R * 0.35);
        for (const edge of [passAng - passHalf * 2.2, passAng + passHalf * 2.2]) {
          for (let d = R + 2; d <= R + 2 + len; d++) {
            const x = cx0 + sgnX * Math.round(d * Math.cos(edge));
            const y = cy0 + sgnY * Math.round(d * Math.sin(edge));
            rockTile(x, y, 'peak');
            if (rnd() < 0.6) rockTile(x + (rnd() < 0.5 ? sgnX : 0), y + (rnd() < 0.5 ? sgnY : 0), 'peak');
          }
        }
      }
      const ir = Math.round(R * 0.55);
      // the pass tile: where the gap sits on the arc, clamped onto the board —
      // gate garrisons (the dragon level's road-block camps) muster around it
      const px = Math.max(2, Math.min(W - 3, cx0 + sgnX * Math.round(R * Math.cos(passAng))));
      const py = Math.max(2, Math.min(H - 3, cy0 + sgnY * Math.round(R * Math.sin(passAng))));
      this.enemyZones.push({
        x: cx0 + sgnX * Math.round(ir * Math.cos(Math.PI / 4)),
        y: cy0 + sgnY * Math.round(ir * Math.sin(Math.PI / 4)),
        r: Math.round(R * 0.5),
        pass: { x: px, y: py },
      });
      }
        this.enemyZone = this.enemyZones[0];
        const inset = Math.max(8, Math.round(Math.min(W, H) * 0.12));
        const starts = [
          { x: inset, y: inset }, { x: W - inset - 1, y: inset },
          { x: inset, y: H - inset - 1 }, { x: W - inset - 1, y: H - inset - 1 },
        ];
        // Pick the corner whose nearest enemy quarter is farthest away. This
        // also behaves sensibly when two different corners are fortified.
        const start = starts.reduce((best, candidate) => {
          const clearance = Math.min(...this.enemyZones.map(z => Math.hypot(candidate.x - z.x, candidate.y - z.y)));
          const bestClearance = Math.min(...this.enemyZones.map(z => Math.hypot(best.x - z.x, best.y - z.y)));
          return clearance > bestClearance ? candidate : best;
        });
        this.playerStart = { x: start.x - 1, y: start.y - 1 };
      }
    }

    // ridges read as RANGES: long chains of overlapping blobs holding one
    // heading with only gentle drift, seeded away from the water
    const freeRanges = this.p.lairStages ? Math.min(2, this.p.mountains) : this.p.mountains;
    for (let i = 0; i < freeRanges; i++) {
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

    // ---- guarantee every frontier's pass: water (a delta arm, the wandering
    // lake) can conspire with the arcs and the ridges to seal an enemy
    // quarter. If a zone can't be walked to from the player start, carve a
    // causeway to it so the assault is always possible on foot.
    for (const ez of this.enemyZones) {
      // Later free-running ridges must not accidentally narrow the authored
      // frontier opening. Clear a seven-tile mouth before path validation.
      for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
        if (Math.hypot(ox, oy) > 3.5) continue;
        const t = this.T(ez.pass.x + ox, ez.pass.y + oy);
        if (t) { t.type = 'grass'; t.lake = false; t.rock = undefined; t.deco = null; }
      }
      const seen = new Uint8Array(W * H);
      const qx = [this.playerStart.x + 1], qy = [this.playerStart.y + 1];
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

      // ---- and guarantee the zone itself holds camp-worthy ground: the
      // wandering lake lives in the same outer band as the walled quarters, so
      // a wet seed can drown a quarter almost whole. A drowned quarter left
      // findStrongholdSpot with nothing, and its camps fell back to random
      // ground OUTSIDE the range — clustered at the pass mouth or worse. Drain
      // enough of the lake inside the zone (working out from its heart) that
      // strongholds always fit behind the mountains.
      let dry = 0;
      const need = Math.max(30, Math.round(ez.r * ez.r * 0.8)); // ~25% of the zone disc
      for (let y = Math.max(0, ez.y - ez.r); y <= Math.min(H - 1, ez.y + ez.r); y++)
        for (let x = Math.max(0, ez.x - ez.r); x <= Math.min(W - 1, ez.x + ez.r); x++)
          if (Math.hypot(x - ez.x, y - ez.y) <= ez.r && this.tiles[y][x].type === 'grass') dry++;
      for (let r = 0; r <= ez.r && dry < need; r++)
        for (let y = Math.max(0, ez.y - r); y <= Math.min(H - 1, ez.y + r) && dry < need; y++)
          for (let x = Math.max(0, ez.x - r); x <= Math.min(W - 1, ez.x + r) && dry < need; x++) {
            if (Math.max(Math.abs(x - ez.x), Math.abs(y - ez.y)) !== r) continue;
            const t = this.tiles[y][x];
            if (t.type === 'water' && Math.hypot(x - ez.x, y - ez.y) <= ez.r) {
              t.type = 'grass'; t.lake = false; t.deco = null; dry++;
            }
          }
    }

    // Tiles cleared later for the town apron and frontier routes stay clear
    // when the final ore invariant replenishes deposits.
    const oreReserved = new Uint8Array(W * H);
    const deposits = (cx: number, cy: number, r: number, kind: DepositKind, n: number): number => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 200) {
        const { x, y } = this.near(cx, cy, r);
        const t = this.T(x, y);
        const sx = this.playerStart.x + 1, sy = this.playerStart.y + 1;
        if (t && t.type === 'grass' && !t.dep && !t.tree && !t.deco && !t.pickup
          && !oreReserved[y * W + x] && Math.hypot(x - sx, y - sy) > 8) {
          t.dep = { kind, amt: 10 + Math.floor(rnd() * 11), meshes: [] }; placed++;
        }
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
    const MIN_ORE: Record<DepositKind, number> = { stone: 6, gold: 6, coal: 12, iron: 6 };
    for (const kind of ['stone', 'gold', 'coal', 'iron'] as const) {
      let guard = 0;
      while (oreCount[kind] < MIN_ORE[kind] && guard++ < 120) {
        const cx = 4 + Math.floor(rnd() * (W - 8)), cy = 4 + Math.floor(rnd() * (H - 8));
        oreCount[kind] += deposits(cx, cy, 3, kind, MIN_ORE[kind] - oreCount[kind]);
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

    // Hostile maps open with the town in the corner opposite the enemy route.
    // Reserve a real muster/build apron there after every terrain/deco pass so
    // a lake, ridge, ore heap or thicket cannot strand the starting army.
    if (frontierCount > 0) {
      const sx = this.playerStart.x + 1, sy = this.playerStart.y + 1;
      for (let y = Math.max(0, sy - 7); y <= Math.min(H - 1, sy + 7); y++) {
        for (let x = Math.max(0, sx - 7); x <= Math.min(W - 1, sx + 7); x++) {
          if (Math.hypot(x - sx, y - sy) > 7.5) continue;
          const t = this.tiles[y][x];
          t.type = 'grass'; t.lake = false; t.rock = undefined;
          t.tree = null; t.dep = null; t.deco = null; t.pickup = null;
          oreReserved[y * W + x] = 1;
        }
      }

      // Deposits and biome thickets are generated after the terrain causeway.
      // Reserve one grass route through each authored mouth so those late
      // blockers cannot silently turn an assault map into an island.
      for (const ez of this.enemyZones) {
        const parent = new Int32Array(W * H); parent.fill(-2);
        const start = sy * W + sx, queue = [start]; parent[start] = -1;
        let goal = -1;
        for (let i = 0; i < queue.length && goal < 0; i++) {
          const id = queue[i], x = id % W, y = Math.floor(id / W);
          if (Math.hypot(x - ez.x, y - ez.y) <= ez.r) { goal = id; break; }
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy, nid = ny * W + nx;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || parent[nid] !== -2) continue;
            if (this.tiles[ny][nx].type !== 'grass') continue;
            parent[nid] = id; queue.push(nid);
          }
        }
        for (let id = goal; id >= 0; id = parent[id]) {
          const t = this.tiles[Math.floor(id / W)][id % W];
          t.dep = null;
          if (t.tree?.dense) t.tree = null;
          oreReserved[id] = 1;
        }
      }
    }

    // The final frontier cleanup above deliberately removes deposits from the
    // castle apron and assault routes. Recount afterwards and replace anything
    // it consumed so every completed map retains its required ore chains.
    const finalOre: Record<DepositKind, number> = { stone: 0, gold: 0, coal: 0, iron: 0 };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dep = this.tiles[y][x].dep;
      if (dep) finalOre[dep.kind]++;
    }
    for (const kind of ['stone', 'gold', 'coal', 'iron'] as const) {
      let guard = 0;
      while (finalOre[kind] < MIN_ORE[kind] && guard++ < 160) {
        const cx = 4 + Math.floor(rnd() * (W - 8)), cy = 4 + Math.floor(rnd() * (H - 8));
        finalOre[kind] += deposits(cx, cy, 3, kind, MIN_ORE[kind] - finalOre[kind]);
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
