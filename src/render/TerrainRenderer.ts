import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { uiRng } from '../engine/rng';
import type { World } from '../world/World';
import type { Field, Pickup, Tree } from '../types';
import { bakeGroupInto, makeDeco, makeDeposit, makeFieldCrop, makeMountain, makePickup, makeRuinWall, makeTree, stdMat, withSeededScatter } from './models';

const rnd = () => uiRng.next();

/** Owns level ground, crop, road, and chunk-baked scenery rendering. */
export class TerrainRenderer {
  private groundGeo = new THREE.BufferGeometry();
  private readonly _c = new THREE.Color();
  private readonly roadMeshes = new Map<string, THREE.Mesh>();
  private readonly roadGeo = new THREE.PlaneGeometry(1.0, 1.0);
  private readonly roadMats: THREE.Material[] = [];
  private static readonly CHUNK = 8;
  private chunkCols = 0;
  private chunkMeshes = new Map<number, THREE.Mesh>();
  private readonly dirtyChunks = new Set<number>();
  private chunkMat: THREE.Material | null = null;

  constructor(
    private readonly getWorld: () => World,
    private readonly getWorldGroup: () => THREE.Group,
    private readonly freezeObject: (root: THREE.Object3D, includeRoot?: boolean) => void,
  ) {
    for (let i = 0; i < 4; i++) this.roadMats.push(stdMat({ map: this.makeRoadTexture() }, false));
  }

  private get world(): World { return this.getWorld(); }
  private get worldGroup(): THREE.Group { return this.getWorldGroup(); }
  private freeze(root: THREE.Object3D, includeRoot = true): void { this.freezeObject(root, includeRoot); }

  loadWorld(): void {
    this.buildGround();
    this.populateDoodads();
  }

  clear(): void {
    this.roadMeshes.clear();
    this.chunkMeshes.clear();
    this.dirtyChunks.clear();
    this.chunkCols = 0;
  }

  flush(): void {
    if (this.dirtyChunks.size) this.flushChunks();
  }
  addTree(x: number, y: number, tree: Tree): void {
    if (tree.growth >= 1) { tree.meshes = []; this.dirtyTile(x, y); return; }
    const seed = this.tileSeed(x, y);
    const g = withSeededScatter(seed, () => makeTree(tree.kind));
    g.position.set(
      this.world.wx(x) + (this.hash01(seed, 1) - 0.5) * 0.3, 0,
      this.world.wz(y) + (this.hash01(seed, 2) - 0.5) * 0.3,
    );
    const s = tree.s * Math.max(0.15, tree.growth);
    g.scale.set(s, s, s);
    this.worldGroup.add(g);
    this.freeze(g, false); // the root rescales as the tree grows
    tree.meshes = [g];
  }

  /** A planted tree finished growing: retire its live mesh into the chunk bake. */
  treeMatured(x: number, y: number, tree: Tree): void {
    this.removeMeshes(tree.meshes);
    tree.meshes = [];
    this.dirtyTile(x, y);
  }

  addPickup(x: number, y: number, pickup: Pickup): void {
    const g = makePickup();
    g.position.set(this.world.wx(x), 0.02, this.world.wz(y));
    this.worldGroup.add(g);
    this.freeze(g);
    pickup.meshes = [g];
  }
  /** Plant the visible crop on a plot; growth drives its height, produce its look. */
  addFieldCrop(x: number, y: number, field: Field): void {
    const out = field.farm.def.gather?.out;
    const kind = out === 'grape' ? 'grape' : out === 'meat' ? 'pasture' : 'wheat';
    const g = makeFieldCrop(kind);
    g.position.set(this.world.wx(x), 0, this.world.wz(y));
    this.worldGroup.add(g);
    this.freeze(g, false); // the root's y-scale tracks crop growth
    field.meshes = [g];
    this.scaleFieldCrop(field);
  }
  scaleFieldCrop(field: Field): void {
    const m = field.meshes[0];
    if (m) m.scale.y = 0.12 + 0.88 * Math.min(1, field.growth);
  }
  removeMeshes(meshes: THREE.Object3D[]): void { for (const m of meshes) this.worldGroup.remove(m); }

  // =====================================================================
  //  Ground
  // =====================================================================
  private tileVertexBase(tx: number, ty: number) { return (ty * this.world.W + tx) * 6 * 3; }

  private lerpHex(a: number, b: number, t: number): number {
    const c1 = new THREE.Color(a), c2 = new THREE.Color(b); c1.lerp(c2, t); return c1.getHex();
  }
  private tileBaseColor(tx: number, ty: number): { hex: number; sh: number } {
    const t = this.world.tiles[ty][tx];
    const pal = this.world.biome.palette;
    if (t.type === 'water') return { hex: pal.water, sh: 0.9 + ((tx * 7 + ty * 13) % 10) / 100 };
    // rocky ground: grey scree under mountain peaks, dusty earth under ruined walls
    if (t.type === 'rock') return t.rock === 'wall'
      ? { hex: 0x9a8a6e, sh: 0.92 + ((tx * 3 + ty * 7) % 8) / 100 }
      : { hex: pal.scree, sh: 0.88 + ((tx * 5 + ty * 3) % 12) / 100 };
    if (t.road) return { hex: 0xcbb389, sh: 0.96 + ((tx * 3 + ty * 5) % 8) / 100 };
    if (t.field) {
      const out = t.field.farm.def.gather?.out;
      const ripe = out === 'grape' ? 0x5e7d3a : out === 'meat' ? 0x6fae52 : 0xe0c24e;
      return { hex: this.lerpHex(0x8a6b42, ripe, Math.min(1, t.field.growth)), sh: 1 };
    }
    // lush meadow — the biome's two greens dithered by position
    const g2 = ((tx * 5 + ty * 11) % 7) / 7;
    return { hex: this.lerpHex(pal.grassA, pal.grassB, g2), sh: t.cshade };
  }
  private setTileColor(tx: number, ty: number, hex: number, shade: number): void {
    this._c.setHex(hex).multiplyScalar(shade);
    const c = this.groundGeo.attributes.color.array as any, b = this.tileVertexBase(tx, ty);
    for (let i = 0; i < 6; i++) { c[b + i * 3] = this._c.r; c[b + i * 3 + 1] = this._c.g; c[b + i * 3 + 2] = this._c.b; }
    this.groundGeo.attributes.color.needsUpdate = true;
  }
  refreshTile(tx: number, ty: number): void { const c = this.tileBaseColor(tx, ty); this.setTileColor(tx, ty, c.hex, c.sh); }

  private buildGround(): void {
    const W = this.world.W, H = this.world.H;
    this.groundGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(W * H * 6 * 3), col = new Float32Array(W * H * 6 * 3);
    const norm = new Float32Array(W * H * 6 * 3); for (let i = 0; i < norm.length; i += 3) norm[i + 1] = 1;
    this.groundGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.groundGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.groundGeo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    const p = pos as any;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const b = this.tileVertexBase(x, y);
      const x0 = this.world.wx(x) - 0.5, x1 = this.world.wx(x) + 0.5, z0 = this.world.wz(y) - 0.5, z1 = this.world.wz(y) + 0.5;
      const v = [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]];
      for (let i = 0; i < 6; i++) { p[b + i * 3] = v[i][0]; p[b + i * 3 + 2] = v[i][1]; }
      const yv = this.world.tiles[y][x].type === 'water' ? -0.14 : 0;
      for (let i = 0; i < 6; i++) p[b + i * 3 + 1] = yv;
      this.refreshTile(x, y);
    }
    const ground = new THREE.Mesh(this.groundGeo, stdMat({ vertexColors: true }, false));
    ground.receiveShadow = true;
    this.worldGroup.add(ground);
    this.freeze(ground);
    // the slab top must sit below the recessed water tiles (y −0.14) or it
    // shows through every lake and pond as a dark green sheet. It is dressed
    // in wood-plank grain so the map edge reads like a nice wooden game board.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 2, H + 2), stdMat({ map: this.makeWoodTexture() }, false));
    slab.position.y = -1.16; this.worldGroup.add(slab);
    this.freeze(slab);
  }

  /** Procedural wood: warm planks with grain streaks and the odd knot, for the
   *  board's edge slab. */
  private makeWoodTexture(): THREE.Texture {
    const S = 256;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#7a5230'; ctx.fillRect(0, 0, S, S);
    const rows = 4, rh = S / rows;
    for (let r = 0; r < rows; r++) {
      // each plank a slightly different warm brown
      const tone = 96 + Math.random() * 36;
      ctx.fillStyle = `rgb(${tone + 26 | 0},${tone * 0.68 | 0},${tone * 0.4 | 0})`;
      ctx.fillRect(0, r * rh, S, rh - 2);
      // long grain streaks along the plank
      for (let i = 0; i < 14; i++) {
        const gy = r * rh + 3 + Math.random() * (rh - 8);
        const dark = Math.random() < 0.6;
        ctx.strokeStyle = dark ? 'rgba(66,42,22,0.35)' : 'rgba(220,178,120,0.25)';
        ctx.lineWidth = 0.8 + Math.random() * 1.2;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.bezierCurveTo(S * 0.3, gy + (Math.random() - 0.5) * 5, S * 0.7, gy + (Math.random() - 0.5) * 5, S, gy + (Math.random() - 0.5) * 3);
        ctx.stroke();
      }
      // the odd knot
      if (Math.random() < 0.6) {
        const kx = Math.random() * S, ky = r * rh + rh * (0.3 + Math.random() * 0.4);
        for (let k = 3; k > 0; k--) {
          ctx.strokeStyle = 'rgba(60,38,20,0.5)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(kx, ky, k * 2.4, k * 1.5, 0.2, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // dark seam between planks
      ctx.fillStyle = 'rgba(40,26,14,0.8)';
      ctx.fillRect(0, r * rh + rh - 2, S, 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 1); // long sides tile instead of stretching
    tex.anisotropy = 8;
    return tex;
  }

  private populateDoodads(): void {
    const W = this.world.W, H = this.world.H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.world.tiles[y][x];
      if (t.tree) this.addTree(x, y, t.tree);         // grown trees route into chunks
      if (t.pickup) this.addPickup(x, y, t.pickup);   // pickups keep their gold ink
      // deposits, decoration and rock are baked straight into the chunks below
    }
    this.chunkCols = Math.ceil(W / TerrainRenderer.CHUNK);
    for (let i = 0; i < this.chunkCols * Math.ceil(H / TerrainRenderer.CHUNK); i++) this.dirtyChunks.add(i);
    this.flushChunks();
  }

  // =====================================================================
  //  Chunk-merged scenery — all static doodads in an 8×8-tile chunk render
  //  as ONE vertex-colored mesh. 5k+ individual doodad meshes (each drawn
  //  twice by the OutlineEffect) collapse into a few dozen draw calls; a
  //  chunk is re-baked only when one of its tiles changes (tree felled,
  //  deposit exhausted, building placed over decoration).
  // =====================================================================
  /** Deterministic cosmetic seed for a tile — stable across chunk rebuilds. */
  private tileSeed(x: number, y: number): number {
    return ((x * 73856093) ^ (y * 19349663) ^ Math.imul(this.world.seed, 83492791)) >>> 0;
  }
  private hash01(seed: number, salt: number): number {
    let h = (seed + Math.imul(salt, 0x9e3779b9)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** A tile's static scenery changed — queue its chunk for a re-bake. */
  dirtyTile(x: number, y: number): void {
    if (!this.chunkCols) return;
    this.dirtyChunks.add(Math.floor(y / TerrainRenderer.CHUNK) * this.chunkCols + Math.floor(x / TerrainRenderer.CHUNK));
  }

  private flushChunks(): void {
    for (const idx of this.dirtyChunks) this.rebuildChunk(idx);
    this.dirtyChunks.clear();
  }

  private rebuildChunk(idx: number): void {
    const old = this.chunkMeshes.get(idx);
    if (old) { this.worldGroup.remove(old); old.geometry.dispose(); this.chunkMeshes.delete(idx); }
    const cx = (idx % this.chunkCols) * TerrainRenderer.CHUNK, cy = Math.floor(idx / this.chunkCols) * TerrainRenderer.CHUNK;
    const parts: THREE.BufferGeometry[] = [];
    const H = this.world.H, W = this.world.W;
    for (let y = cy; y < Math.min(H, cy + TerrainRenderer.CHUNK); y++)
      for (let x = cx; x < Math.min(W, cx + TerrainRenderer.CHUNK); x++) this.bakeTileInto(parts, x, y);
    if (!parts.length) return;
    const merged = mergeGeometries(parts, false)!;
    parts.forEach(p => p.dispose());
    if (!this.chunkMat) this.chunkMat = stdMat({ vertexColors: true });
    const mesh = new THREE.Mesh(merged, this.chunkMat);
    mesh.castShadow = true;
    this.worldGroup.add(mesh);
    this.freeze(mesh);
    this.chunkMeshes.set(idx, mesh);
  }

  /** Bake one tile's static doodads (grown tree, deposit, deco, rock). */
  private bakeTileInto(parts: THREE.BufferGeometry[], x: number, y: number): void {
    const t = this.world.tiles[y][x];
    const seed = this.tileSeed(x, y);
    const wx = this.world.wx(x), wz = this.world.wz(y);
    if (t.tree && t.tree.growth >= 1 && t.tree.meshes.length === 0) {
      const tree = t.tree;
      const g = withSeededScatter(seed, () => makeTree(tree.kind));
      g.position.set(wx + (this.hash01(seed, 1) - 0.5) * 0.3, 0, wz + (this.hash01(seed, 2) - 0.5) * 0.3);
      g.scale.setScalar(tree.s);
      bakeGroupInto(parts, g);
    }
    if (t.dep) {
      const dep = t.dep;
      const g = withSeededScatter(seed ^ 0x9e37, () => makeDeposit(dep.kind));
      g.position.set(wx, 0, wz);
      bakeGroupInto(parts, g);
    }
    if (t.deco) {
      const deco = t.deco;
      const g = withSeededScatter(seed ^ 0x85eb, () => makeDeco(deco.kind));
      const baseY = t.type === 'water' ? -0.14 : 0;
      g.position.set(wx + (this.hash01(seed, 3) - 0.5) * 0.3, g.position.y + baseY, wz + (this.hash01(seed, 4) - 0.5) * 0.3);
      bakeGroupInto(parts, g);
    }
    if (t.type === 'rock') {
      const g = withSeededScatter(seed ^ 0xc2b2, () => {
        if (t.rock === 'wall') {
          const w = makeRuinWall();
          // run the wall along its neighbours so a line reads as one old rampart
          const L = this.world.T(x - 1, y), R = this.world.T(x + 1, y);
          const alongX = (L && L.rock === 'wall') || (R && R.rock === 'wall');
          if (!alongX) w.rotation.y = Math.PI / 2;
          return w;
        }
        const m = makeMountain();
        m.rotation.y = this.hash01(seed, 5) * Math.PI * 2;
        return m;
      });
      g.position.set(wx, 0, wz);
      bakeGroupInto(parts, g);
    }
  }

  // =====================================================================
  //  Cobbled road overlay
  // =====================================================================
  /** Procedural cobbles: offset courses of shaded stones over packed earth,
   *  with hairline cracks, moss in the joints and scattered grit. */
  private makeRoadTexture(): THREE.Texture {
    const S = 256;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    // packed-earth base, mottled so the joints between stones vary
    // (kept dark: the scene's bright lighting roughly doubles these values)
    ctx.fillStyle = '#665137'; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 130; i++) {
      ctx.fillStyle = `rgba(${70 + Math.random() * 60 | 0},${55 + Math.random() * 45 | 0},${34 + Math.random() * 28 | 0},0.25)`;
      ctx.beginPath(); ctx.arc(Math.random() * S, Math.random() * S, 4 + Math.random() * 14, 0, Math.PI * 2); ctx.fill();
    }
    // cobbles laid in offset courses like a real paved lane
    const rows = 6, rh = S / rows;
    for (let gy = 0; gy < rows; gy++) {
      let x = (gy % 2) * -rh * 0.5;
      while (x < S) {
        const w = rh * (0.85 + Math.random() * 0.75);
        const cx = x + w / 2, cy = gy * rh + rh / 2 + (Math.random() - 0.5) * rh * 0.18;
        const rx = w * 0.46, ry = rh * (0.36 + Math.random() * 0.1);
        // warm sandy stones with the odd cool grey one mixed in
        const cool = Math.random() < 0.22;
        const base = 84 + Math.random() * 42;
        const rC = cool ? base * 0.92 : base + 14, gC = cool ? base * 0.95 : base * 0.94, bC = cool ? base : base * 0.7;
        const grad = ctx.createRadialGradient(cx - rx * 0.35, cy - ry * 0.45, ry * 0.2, cx, cy, Math.max(rx, ry) * 1.15);
        grad.addColorStop(0, `rgb(${Math.min(255, rC + 24) | 0},${Math.min(255, gC + 21) | 0},${Math.min(255, bC + 17) | 0})`);
        grad.addColorStop(0.72, `rgb(${rC | 0},${gC | 0},${bC | 0})`);
        grad.addColorStop(1, `rgb(${rC * 0.66 | 0},${gC * 0.64 | 0},${bC * 0.62 | 0})`);
        ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, (Math.random() - 0.5) * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(70,54,34,0.6)'; ctx.stroke();
        // the occasional hairline crack across a worn stone
        if (Math.random() < 0.3) {
          ctx.beginPath();
          ctx.moveTo(cx - rx * 0.5, cy + (Math.random() - 0.5) * ry);
          ctx.quadraticCurveTo(cx, cy + (Math.random() - 0.5) * ry, cx + rx * 0.55, cy + (Math.random() - 0.5) * ry);
          ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(60,45,30,0.45)'; ctx.stroke();
        }
        // moss creeping into some joints
        if (Math.random() < 0.28) {
          ctx.fillStyle = `rgba(${90 + Math.random() * 30 | 0},${118 + Math.random() * 40 | 0},60,0.5)`;
          ctx.beginPath();
          ctx.arc(cx + (Math.random() - 0.5) * rx * 2, cy + ry * (Math.random() < 0.5 ? 1 : -1) * 0.95, 1.5 + Math.random() * 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        x += w;
      }
    }
    // grit — light grains catching the sun, dark flecks in the shade
    for (let i = 0; i < 170; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(230,208,168,0.25)' : 'rgba(40,30,20,0.32)';
      ctx.fillRect(Math.random() * S, Math.random() * S, 1.4, 1.4);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  }

  addRoad(x: number, y: number): void {
    const key = x + ',' + y;
    if (this.roadMeshes.has(key)) return;
    const m = new THREE.Mesh(this.roadGeo, this.roadMats[Math.floor(rnd() * this.roadMats.length)]);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.floor(rnd() * 4) * (Math.PI / 2);   // rotate for variety
    m.position.set(this.world.wx(x), 0.02, this.world.wz(y));
    m.receiveShadow = true;
    this.worldGroup.add(m);
    this.freeze(m);
    this.roadMeshes.set(key, m);
  }
  removeRoad(x: number, y: number): void {
    const key = x + ',' + y;
    const m = this.roadMeshes.get(key);
    if (m) { this.worldGroup.remove(m); this.roadMeshes.delete(key); }
  }

  /** The road tile's mesh, for the fog pass to hide/show. */
  roadMeshAt(x: number, y: number): THREE.Mesh | null {
    return this.roadMeshes.get(x + ',' + y) ?? null;
  }
}
