import * as THREE from 'three';
import { uiRng } from '../engine/rng';
import type { World } from '../world/World';
import type { Building, BuildingDef, Coord, Deco, Deposit, Field, Pickup, Tree, Unit } from '../types';
import { makeBuilding, makeDeco, makeDeposit, makeFieldCrop, makeFish, makePickup, makePig, makeScaffold, makeTree, makeUnit } from './models';

// Cosmetic scatter only — must not touch worldgen/gameplay streams.
const rnd = () => uiRng.next();

/** A single grazing pig on a pig-farm pasture (cosmetic, real-time). */
interface Pig { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; big: boolean; }
/** A single fish swimming in the lake (cosmetic, real-time). */
interface SwimFish { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; speed: number; }

/**
 * Owns everything Three.js: renderer, scene, orthographic camera, the ground
 * mesh, doodads, ambiance (clouds, distant hills) and the minimap. It reads the
 * World for tile data but never mutates game state.
 *
 * The renderer, camera, lights, placement helpers and minimap are built once
 * and persist for the whole session. Everything tied to a specific level lives
 * under `worldGroup`, so `loadWorld()`/`clearWorld()` can tear a level down and
 * rebuild the next without leaking GPU resources (see `clearWorld`).
 */
export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  readonly camTarget = new THREE.Vector3(0, 0, 2);
  viewSize = 13;

  private world!: World;
  private worldGroup = new THREE.Group();
  private skyTex: THREE.Texture | null = null;
  private readonly CAM_OFF = new THREE.Vector3(28, 34, 28);
  private groundGeo = new THREE.BufferGeometry();
  private readonly _c = new THREE.Color();
  private readonly clouds: THREE.Group[] = [];

  // placement helpers
  private ghost: THREE.Group = new THREE.Group();
  private ghostKey: string | null = null;
  private readonly roadCursor: THREE.Mesh;

  // green markers over building/site entrance tiles, shown while painting roads
  private readonly entranceMarkers: THREE.Mesh[] = [];
  private readonly entranceGeo = new THREE.PlaneGeometry(0.9, 0.9);
  private readonly entranceMat = new THREE.MeshBasicMaterial({ color: 0x46c256, transparent: true, opacity: 0.5, side: THREE.DoubleSide });

  // cobbled road overlay meshes, keyed by "x,y"
  private readonly roadMeshes = new Map<string, THREE.Mesh>();
  private readonly roadGeo = new THREE.PlaneGeometry(1.0, 1.0);
  private readonly roadMats: THREE.MeshLambertMaterial[] = [];

  // ambient scenery that turns in real time (distant windmill sails)
  private readonly millSails: THREE.Object3D[] = [];
  private cloudBound = 40;

  // grazing pigs on each pig-farm's pasture plots (cosmetic, real-time)
  private readonly pigHerds = new Map<Building, Pig[]>();

  // fish swimming in the lake (cosmetic, real-time)
  private readonly fish: SwimFish[] = [];
  private lakeTiles: { x: number; y: number }[] = [];

  // minimap
  private readonly mm: HTMLCanvasElement;
  private readonly mmx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.setSize();
    addEventListener('resize', () => this.setSize());

    // lighting — warm sun, cool sky fill (persists across levels)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xdaeeff, 0x6f8a52, 0.5));
    const sun = new THREE.DirectionalLight(0xfff0d2, 1.15);
    sun.position.set(-18, 30, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34; sun.shadow.camera.far = 100;
    this.scene.add(sun, sun.target);

    // a few cobble variants so long roads don't tile visibly (shared, persist)
    for (let i = 0; i < 4; i++) this.roadMats.push(new THREE.MeshLambertMaterial({ map: this.makeRoadTexture() }));

    this.scene.add(this.worldGroup);

    // road-tile cursor
    this.roadCursor = new THREE.Mesh(
      new THREE.PlaneGeometry(0.96, 0.96),
      new THREE.MeshBasicMaterial({ color: 0xb9a179, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    );
    this.roadCursor.rotation.x = -Math.PI / 2; this.roadCursor.position.y = 0.03; this.roadCursor.visible = false;
    this.scene.add(this.roadCursor);
    this.scene.add(this.ghost); this.ghost.visible = false;

    // minimap navigation
    this.mm = minimap;
    this.mmx = minimap.getContext('2d')!;
    this.mm.addEventListener('pointerdown', e => {
      if (!this.world) return;
      const r = this.mm.getBoundingClientRect();
      this.camTarget.x = ((e.clientX - r.left) / r.width) * this.world.W - this.world.W / 2;
      this.camTarget.z = ((e.clientY - r.top) / r.height) * this.world.H - this.world.H / 2;
      this.clampCam(); this.updateCamera();
    });
  }

  // =====================================================================
  //  Level lifecycle — build/tear down all per-level scene content
  // =====================================================================
  /** Attach a freshly generated world and build its ground, doodads and ambiance. */
  loadWorld(world: World): void {
    this.world = world;
    this.buildGround();
    this.populateDoodads();
    this.buildAmbiance();
    this.spawnFish();
  }

  /**
   * Dispose every GPU resource under `worldGroup` and reset per-level caches.
   * Shared geometries/materials (from models.ts and the road overlay) are
   * disposed too, but Three re-uploads them lazily the next time a mesh uses
   * them, so the next level rebuilds cleanly. Watch `renderer.info.memory` —
   * geometry/texture counts must return to baseline between levels.
   */
  clearWorld(): void {
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.worldGroup.traverse((o: any) => {
      if (o.geometry) geos.add(o.geometry);
      const m = o.material;
      if (m) { if (Array.isArray(m)) m.forEach((x: THREE.Material) => mats.add(x)); else mats.add(m); }
    });
    geos.forEach(g => g.dispose());
    mats.forEach(m => { const map = (m as any).map as THREE.Texture | undefined; if (map) map.dispose(); m.dispose(); });

    this.scene.remove(this.worldGroup);
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    if (this.skyTex) { this.skyTex.dispose(); this.skyTex = null; }
    this.scene.background = null;
    this.scene.fog = null;
    this.roadMeshes.clear();
    this.clouds.length = 0;
    this.pigHerds.clear();
    this.fish.length = 0;
    this.lakeTiles = [];
    this.millSails.length = 0;
    this.ghostKey = null;
  }

  // =====================================================================
  //  Camera
  // =====================================================================
  setSize(): void {
    this.renderer.setSize(innerWidth, innerHeight);
    this.updateCamera();
  }
  updateCamera(): void {
    const a = innerWidth / innerHeight;
    this.camera.left = -this.viewSize * a; this.camera.right = this.viewSize * a;
    this.camera.top = this.viewSize; this.camera.bottom = -this.viewSize;
    this.camera.position.copy(this.camTarget).add(this.CAM_OFF);
    this.camera.lookAt(this.camTarget);
    this.camera.updateProjectionMatrix();
  }
  clampCam(): void {
    const W = this.world ? this.world.W : 48, H = this.world ? this.world.H : 48;
    this.camTarget.x = Math.max(-W / 2, Math.min(W / 2, this.camTarget.x));
    this.camTarget.z = Math.max(-H / 2, Math.min(H / 2, this.camTarget.z));
  }
  pan(v: THREE.Vector3): void { this.camTarget.add(v); this.clampCam(); this.updateCamera(); }
  centerOn(x: number, z: number): void { this.camTarget.set(x, 0, z); this.clampCam(); this.updateCamera(); }
  zoom(factor: number): void {
    this.viewSize = Math.max(6, Math.min(28, this.viewSize * factor));
    this.updateCamera();
  }

  /** Screen point → world tile (or null off-map). */
  tileAt(cx: number, cy: number): { x: number; y: number } | null {
    const W = this.world.W, H = this.world.H;
    const p = this.groundPoint(cx, cy);
    const tx = Math.floor(p.x + W / 2), ty = Math.floor(p.z + H / 2);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return null;
    return { x: tx, y: ty };
  }

  /** Screen point → world-space point on the ground plane (y = 0). */
  groundPoint(cx: number, cy: number): { x: number; z: number } {
    const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.camera);
    const t = -rc.ray.origin.y / rc.ray.direction.y;
    const p = rc.ray.origin.clone().add(rc.ray.direction.clone().multiplyScalar(t));
    return { x: p.x, z: p.z };
  }

  // =====================================================================
  //  Scene helpers
  // =====================================================================
  add(o: THREE.Object3D): void { this.worldGroup.add(o); }
  remove(o: THREE.Object3D): void { this.worldGroup.remove(o); }

  createBuildingMesh(def: BuildingDef): THREE.Group { return makeBuilding(def, false); }
  createScaffold(def: BuildingDef) { return makeScaffold(def); }

  createUnit(colorHex: number, role: string, tileX: number, tileY: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
    const u = makeUnit(colorHex, role);
    u.group.position.set(this.world.wx(tileX), 0, this.world.wz(tileY));
    this.worldGroup.add(u.group);
    return u;
  }

  addTree(x: number, y: number, tree: Tree): void {
    const g = makeTree(tree.kind);
    g.position.set(this.world.wx(x) + (rnd() - 0.5) * 0.3, 0, this.world.wz(y) + (rnd() - 0.5) * 0.3);
    const s = tree.s * Math.max(0.15, tree.growth);
    g.scale.set(s, s, s);
    this.worldGroup.add(g);
    tree.meshes = [g];
  }
  addDeposit(x: number, y: number, dep: Deposit): void {
    const g = makeDeposit(dep.kind);
    g.position.set(this.world.wx(x), 0, this.world.wz(y));
    this.worldGroup.add(g);
    dep.meshes = [g];
  }
  addPickup(x: number, y: number, pickup: Pickup): void {
    const g = makePickup();
    g.position.set(this.world.wx(x), 0.02, this.world.wz(y));
    this.worldGroup.add(g);
    pickup.meshes = [g];
  }
  addDeco(x: number, y: number, deco: Deco): void {
    const g = makeDeco(deco.kind);
    const baseY = this.world.tiles[y][x].type === 'water' ? -0.14 : 0;
    g.position.set(this.world.wx(x) + (rnd() - 0.5) * 0.3, g.position.y + baseY, this.world.wz(y) + (rnd() - 0.5) * 0.3);
    this.worldGroup.add(g);
    deco.meshes = [g];
  }
  /** Plant the visible crop on a plot; growth drives its height, produce its look. */
  addFieldCrop(x: number, y: number, field: Field): void {
    const out = field.farm.def.gather?.out;
    const kind = out === 'grape' ? 'grape' : out === 'meat' ? 'pasture' : 'wheat';
    const g = makeFieldCrop(kind);
    g.position.set(this.world.wx(x), 0, this.world.wz(y));
    this.worldGroup.add(g);
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
    if (t.type === 'water') return { hex: 0x36648f, sh: 0.9 + ((tx * 7 + ty * 13) % 10) / 100 };
    if (t.road) return { hex: 0xcbb389, sh: 0.96 + ((tx * 3 + ty * 5) % 8) / 100 };
    if (t.field) {
      const out = t.field.farm.def.gather?.out;
      const ripe = out === 'grape' ? 0x5e7d3a : out === 'meat' ? 0x6fae52 : 0xe0c24e;
      return { hex: this.lerpHex(0x8a6b42, ripe, Math.min(1, t.field.growth)), sh: 1 };
    }
    // lush meadow — two greens dithered by position
    const g2 = ((tx * 5 + ty * 11) % 7) / 7;
    return { hex: this.lerpHex(0x6fae52, 0x89c266, g2), sh: t.cshade };
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
    const ground = new THREE.Mesh(this.groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    this.worldGroup.add(ground);
    // the slab top must sit below the recessed water tiles (y −0.14) or it
    // shows through every lake and pond as a dark green sheet
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 2, H + 2), new THREE.MeshLambertMaterial({ color: 0x4f6b3c }));
    slab.position.y = -1.16; this.worldGroup.add(slab);
  }

  private populateDoodads(): void {
    const W = this.world.W, H = this.world.H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.world.tiles[y][x];
      if (t.tree) this.addTree(x, y, t.tree);
      if (t.dep) this.addDeposit(x, y, t.dep);
      if (t.deco) this.addDeco(x, y, t.deco);
      if (t.pickup) this.addPickup(x, y, t.pickup);
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
    this.roadMeshes.set(key, m);
  }
  removeRoad(x: number, y: number): void {
    const key = x + ',' + y;
    const m = this.roadMeshes.get(key);
    if (m) { this.worldGroup.remove(m); this.roadMeshes.delete(key); }
  }

  // =====================================================================
  //  Ambiance — gradient sky, horizon meadow, rolling hills, treeline,
  //  a distant windmill and drifting clouds
  // =====================================================================
  private buildAmbiance(): void {
    const W = this.world.W, H = this.world.H;
    // gradient sky: deep blue overhead fading to a warm pale horizon
    const sky = document.createElement('canvas'); sky.width = 1; sky.height = 256;
    const sctx = sky.getContext('2d')!;
    const grad = sctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#69b0dd');
    grad.addColorStop(0.55, '#a9d3ea');
    grad.addColorStop(1, '#e9f2ea');
    sctx.fillStyle = grad; sctx.fillRect(0, 0, 1, 256);
    this.skyTex = new THREE.CanvasTexture(sky);
    this.scene.background = this.skyTex;
    this.scene.fog = new THREE.Fog(0xddecee, 62, 150);

    // a broad meadow plain reaching out to the horizon beneath the map plinth
    const plain = new THREE.Mesh(new THREE.CircleGeometry(240, 48), new THREE.MeshLambertMaterial({ color: 0x7fae66 }));
    plain.rotation.x = -Math.PI / 2; plain.position.y = -2.1;
    this.worldGroup.add(plain);

    // The board reaches its corners at `boardR`; keep every background element
    // beyond boardR + GAP so scenery never sits on top of the play area. Each
    // element's own radius is added in, so its *inner* edge clears the gap.
    const boardR = Math.hypot(W / 2, H / 2);
    const GAP = 12;

    // low rolling hill domes in three hazier and hazier rings
    const hillTones = [0x8cbc70, 0x7aa96a, 0x6f9d74, 0x678f79].map(c => new THREE.MeshLambertMaterial({ color: c }));
    for (let ring = 0; ring < 3; ring++) {
      const count = 12 + ring * 5;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + rnd() * 0.5;
        const r = 9 + ring * 7 + rnd() * 7;
        const rad = boardR + GAP + r + ring * 22 + rnd() * 10; // inner edge = rad - r ≥ boardR + GAP
        const h = (2.5 + rnd() * 2.5) * (1 + ring * 0.5);
        const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 12), hillTones[Math.min(3, ring + (i % 2))]);
        hill.scale.y = h / r;
        hill.position.set(Math.cos(ang) * rad, -2.1, Math.sin(ang) * rad);
        this.worldGroup.add(hill);
      }
    }

    // a hazy treeline out in the meadow ring, between the plinth and the hills
    const folA = new THREE.MeshLambertMaterial({ color: 0x4a7350 });
    const folB = new THREE.MeshLambertMaterial({ color: 0x3f6a5e });
    const trunkM = new THREE.MeshLambertMaterial({ color: 0x5b4433 });
    for (let i = 0; i < 90; i++) {
      const ang = rnd() * Math.PI * 2;
      const s = 0.9 + rnd() * 1.4;
      const rad = boardR + 5 + rnd() * (GAP - 4); // sits in the gap ring, clear of the board
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.75 * s, 2.6 * s, 6), rnd() < 0.5 ? folA : folB);
      crown.position.set(Math.cos(ang) * rad, -2.1 + 1.5 * s, Math.sin(ang) * rad);
      this.worldGroup.add(crown);
      if (rnd() < 0.35) {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * s, 0.14 * s, 0.5 * s, 5), trunkM);
        trunk.position.set(crown.position.x, -2.1 + 0.22 * s, crown.position.z);
        this.worldGroup.add(trunk);
      }
    }

    // one far-off windmill turning on the plain — a little postcard of Het Gooi
    const millAng = rnd() * Math.PI * 2;
    const millRad = boardR + 38;
    const mill = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.7, 5.2, 8), new THREE.MeshLambertMaterial({ color: 0x6b5540 }));
    body.position.y = 2.6; mill.add(body);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.35, 1.3, 8), new THREE.MeshLambertMaterial({ color: 0x54402f }));
    cap.position.y = 5.85; mill.add(cap);
    const sails = new THREE.Group();
    sails.position.set(0, 5.4, 1.5);
    const sailMat = new THREE.MeshLambertMaterial({ color: 0xefe6d0 });
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.6, 0.08), sailMat);
      blade.position.y = 1.5;
      const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2; arm.add(blade);
      sails.add(arm);
    }
    mill.add(sails);
    mill.position.set(Math.cos(millAng) * millRad, -2.1, Math.sin(millAng) * millRad);
    mill.lookAt(0, -2.1, 0);
    this.worldGroup.add(mill);
    this.millSails.push(sails);

    // soft clouds drifting high above, spread wide around the board
    const cloudSpan = boardR * 2 + 30;
    this.cloudBound = cloudSpan / 2;
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Group();
      const n = 3 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(1 + rnd() * 1.2, 8, 6), cloudMat);
        puff.position.set((j - n / 2) * 1.5 + rnd(), rnd() * 0.6, rnd() * 1.4);
        puff.scale.y = 0.6;
        c.add(puff);
      }
      c.position.set((rnd() - 0.5) * cloudSpan, 14 + rnd() * 6, (rnd() - 0.5) * cloudSpan);
      this.worldGroup.add(c);
      this.clouds.push(c);
    }
  }

  /** Real-time animation independent of sim speed: turning sails, drifting clouds. */
  animate(dt: number, buildings: Building[]): void {
    for (const b of buildings) {
      const spin = b.mesh.userData.spin as THREE.Group | undefined;
      if (spin) spin.rotation.z += dt * (b.active ? 1.1 : 0.35);
      const smoke = b.mesh.userData.smoke as { puffs: THREE.Mesh[]; base: THREE.Vector3 } | undefined;
      if (smoke) this.animateSmoke(smoke, dt, b.active);
    }
    for (const c of this.clouds) {
      c.position.x += dt * 0.6;
      if (c.position.x > this.cloudBound) c.position.x = -this.cloudBound;
    }
    for (const s of this.millSails) s.rotation.z += dt * 0.45;
    this.updatePigs(dt, buildings);
    this.updateFish(dt);
  }

  /** Scatter cute fish across the lake's water tiles (not the small ponds). */
  private spawnFish(): void {
    const lake: { x: number; y: number }[] = [];
    for (let y = 0; y < this.world.H; y++) for (let x = 0; x < this.world.W; x++) {
      const t = this.world.tiles[y][x];
      if (t.type === 'water' && t.lake) lake.push({ x, y });
    }
    this.lakeTiles = lake;
    if (!lake.length) return;
    const n = Math.min(18, Math.max(4, Math.round(lake.length / 12)));
    for (let i = 0; i < n; i++) {
      const c = lake[Math.floor(uiRng.next() * lake.length)];
      const mesh = makeFish(); this.worldGroup.add(mesh);
      const x = this.world.wx(c.x) + (uiRng.next() - 0.5) * 0.6, z = this.world.wz(c.y) + (uiRng.next() - 0.5) * 0.6;
      mesh.position.set(x, 0.05, z);
      this.fish.push({ mesh, x, z, tx: x, tz: z, wait: uiRng.next() * 2, speed: 0.25 + uiRng.next() * 0.25 });
    }
  }

  private fishTarget(fx: number, fz: number): { x: number; z: number } {
    for (let i = 0; i < 6; i++) {
      const c = this.lakeTiles[Math.floor(uiRng.next() * this.lakeTiles.length)];
      const x = this.world.wx(c.x) + (uiRng.next() - 0.5) * 0.6, z = this.world.wz(c.y) + (uiRng.next() - 0.5) * 0.6;
      if (Math.hypot(x - fx, z - fz) < 5) return { x, z };
    }
    return { x: fx, z: fz };
  }

  private updateFish(dt: number): void {
    for (const f of this.fish) {
      if (f.wait > 0) { f.wait -= dt; if (f.wait <= 0) { const t = this.fishTarget(f.x, f.z); f.tx = t.x; f.tz = t.z; } continue; }
      const dx = f.tx - f.x, dz = f.tz - f.z, dist = Math.hypot(dx, dz);
      if (dist < 0.05) { f.wait = 0.4 + uiRng.next() * 1.6; continue; }
      const step = Math.min(f.speed * dt, dist);
      f.x += dx / dist * step; f.z += dz / dist * step;
      f.mesh.position.set(f.x, 0.05, f.z);
      f.mesh.rotation.y = Math.atan2(-dz, dx); // fish model faces +x
    }
  }

  /** Little & big pigs wander and graze across each pig-farm's pasture plots. */
  private updatePigs(dt: number, buildings: Building[]): void {
    const present = new Set<Building>();
    for (const b of buildings) {
      if (b.def.gather?.out !== 'meat' || b.removed || b.fieldsList.length === 0) continue;
      present.add(b);
      let herd = this.pigHerds.get(b);
      if (!herd) { herd = []; this.pigHerds.set(b, herd); }
      const want = Math.max(2, Math.min(6, b.fieldsList.length + 1));
      while (herd.length < want) {
        const big = herd.length % 2 === 0;
        const mesh = makePig(big); this.worldGroup.add(mesh);
        const p = this.pigTarget(b);
        herd.push({ mesh, x: p.x, z: p.z, tx: p.x, tz: p.z, wait: uiRng.next() * 3, big });
        mesh.position.set(p.x, 0, p.z);
      }
      while (herd.length > want) { const p = herd.pop()!; this.worldGroup.remove(p.mesh); }
      for (const p of herd) this.movePig(p, b, dt);
    }
    for (const [b, herd] of this.pigHerds) {
      if (present.has(b)) continue;
      for (const p of herd) this.worldGroup.remove(p.mesh);
      this.pigHerds.delete(b);
    }
  }

  private pigTarget(b: Building): { x: number; z: number } {
    const f = b.fieldsList[Math.floor(uiRng.next() * b.fieldsList.length)];
    return { x: this.world.wx(f.x) + (uiRng.next() - 0.5) * 0.6, z: this.world.wz(f.y) + (uiRng.next() - 0.5) * 0.6 };
  }

  private movePig(p: Pig, b: Building, dt: number): void {
    if (p.wait > 0) { p.wait -= dt; if (p.wait <= 0) { const t = this.pigTarget(b); p.tx = t.x; p.tz = t.z; } return; }
    const dx = p.tx - p.x, dz = p.tz - p.z, dist = Math.hypot(dx, dz);
    if (dist < 0.04) { p.wait = 3 + uiRng.next() * 5; return; }
    const step = Math.min((p.big ? 0.3 : 0.45) * dt, dist);
    p.x += dx / dist * step; p.z += dz / dist * step;
    p.mesh.position.set(p.x, 0, p.z);
    // the pig model faces +x (snout forward), so point +x along the travel vector
    p.mesh.rotation.y = Math.atan2(-dz, dx);
  }

  /** Chimney puffs rise, drift, swell and fade; only visible while the oven works. */
  private animateSmoke(s: { puffs: THREE.Mesh[]; base: THREE.Vector3 }, dt: number, active: boolean): void {
    for (const p of s.puffs) {
      let t = (p.userData.smokePhase as number) + dt * 0.35;
      if (t >= 1) t -= 1;
      p.userData.smokePhase = t;
      const mat = p.material as THREE.MeshLambertMaterial;
      if (!active) { mat.opacity = Math.max(0, mat.opacity - dt); continue; }
      p.position.set(s.base.x + Math.sin(t * 6.2) * 0.18 * t, s.base.y + t * 1.4, s.base.z + Math.cos(t * 5.1) * 0.12 * t);
      const sc = 0.5 + t * 1.3; p.scale.setScalar(sc);
      mat.opacity = Math.max(0, 0.55 * (1 - t)) * (t < 0.15 ? t / 0.15 : 1);
    }
  }

  // =====================================================================
  //  Placement ghost & road cursor
  // =====================================================================
  showGhost(def: BuildingDef, key: string, tx: number, ty: number, rot: number, ok: boolean): void {
    if (this.ghostKey !== key) {
      this.scene.remove(this.ghost);
      this.ghost = makeBuilding(def, true);
      const mk = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
      mk.rotation.x = -Math.PI / 2; mk.position.set(-0.5, 0.04, 1.5); mk.userData.marker = true;
      this.ghost.add(mk);
      this.scene.add(this.ghost); this.ghostKey = key;
    }
    this.ghost.visible = true;
    this.ghost.rotation.y = -rot * Math.PI / 2;
    this.ghost.position.set(this.world.wx(tx) + 0.5, 0, this.world.wz(ty) + 0.5);
    this.ghost.traverse((o: any) => {
      if (o.userData.marker) return;
      if (o.material) o.material.color.setHex(ok ? def.wall : 0xcc3322);
    });
  }
  hideGhost(): void { this.ghost.visible = false; }

  showRoadCursor(tx: number, ty: number, kind: 'road' | 'demolish' | 'plot'): void {
    this.roadCursor.visible = true;
    this.roadCursor.position.x = this.world.wx(tx); this.roadCursor.position.z = this.world.wz(ty);
    const t = this.world.T(tx, ty);
    const m = this.roadCursor.material as THREE.MeshBasicMaterial;
    if (kind === 'demolish') m.color.setHex((t && (t.road || t.b || t.site || t.field)) ? 0xcc3322 : 0x777777);
    else {
      const free = !!(t && t.type === 'grass' && !t.b && !t.site && !t.road && !t.field && !t.dep);
      m.color.setHex(free ? (kind === 'plot' ? 0x46c256 : 0xd9a441) : 0xcc3322);
    }
  }
  hideRoadCursor(): void { this.roadCursor.visible = false; }

  /** Highlight the given entrance tiles in green (used while painting roads). */
  showEntranceMarkers(coords: Coord[]): void {
    for (let i = 0; i < coords.length; i++) {
      let m = this.entranceMarkers[i];
      if (!m) {
        m = new THREE.Mesh(this.entranceGeo, this.entranceMat);
        m.rotation.x = -Math.PI / 2; m.position.y = 0.05;
        this.scene.add(m);
        this.entranceMarkers[i] = m;
      }
      m.visible = true;
      m.position.x = this.world.wx(coords[i].x); m.position.z = this.world.wz(coords[i].y);
    }
    for (let i = coords.length; i < this.entranceMarkers.length; i++) this.entranceMarkers[i].visible = false;
  }
  hideEntranceMarkers(): void { for (const m of this.entranceMarkers) m.visible = false; }

  // =====================================================================
  //  Minimap & render
  // =====================================================================
  drawMinimap(units: Unit[]): void {
    if (!this.world) return;
    const W = this.world.W, H = this.world.H;
    const mmx = this.mmx, MMS = this.mm.width / W;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.world.tiles[y][x];
      let c = '#6fae52';
      if (t.type === 'water') c = '#5b93b0';
      else if (t.road) c = '#cbb389';
      else if (t.field) c = '#d3bd56';
      else if (t.tree) c = '#3d5c2e';
      else if (t.dep) c = t.dep.kind === 'stone' ? '#9aa0a3' : t.dep.kind === 'gold' ? '#c9a94e' : '#3d3d44';
      if (t.pickup) c = '#ffd24a';
      if (t.b) c = '#7a4a2e';
      if (t.site) c = '#d9a441';
      mmx.fillStyle = c;
      mmx.fillRect(x * MMS, y * MMS, MMS + 0.5, MMS + 0.5);
    }
    mmx.fillStyle = '#fff';
    for (const u of units) mmx.fillRect((u.mesh.position.x + W / 2) * MMS - 1, (u.mesh.position.z + H / 2) * MMS - 1, 2, 2);
    const a = innerWidth / innerHeight;
    mmx.strokeStyle = 'rgba(255,255,255,.8)'; mmx.lineWidth = 1;
    mmx.strokeRect((this.camTarget.x + W / 2 - this.viewSize * a * 0.72) * MMS, (this.camTarget.z + H / 2 - this.viewSize * 0.95) * MMS, this.viewSize * a * 1.44 * MMS, this.viewSize * 1.9 * MMS);
  }

  render(): void { this.renderer.render(this.scene, this.camera); }
}
