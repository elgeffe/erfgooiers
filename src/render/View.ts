import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { uiRng } from '../engine/rng';
import { GRAPHICS } from '../constants';
import type { World } from '../world/World';
import type { Building, BuildingDef, BuildingKey, Coord, Deco, Deposit, Field, Pickup, Tree, Unit } from '../types';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bakeGroupInto, box, circle, cone, cyl, makeArrow, makeBuilding, makeUnitCorpse, makeCritter, makeDeco, makeDeposit, makeFieldCrop, makeFireball, makeFish, makeFlag, makeFlame, makeMountain, makePickup, makePig, makePlotMarker, makeRuinWall, makeScaffold, makeSkyBird, makeTree, makeUnit, noOutline, sphere, stdMat, withSeededScatter, CRITTER_KINDS, type CritterKind } from './models';

// Cosmetic scatter only — must not touch worldgen/gameplay streams.
const rnd = () => uiRng.next();

/** A single grazing pig on a pig-farm pasture (cosmetic, real-time). */
interface Pig { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; big: boolean; }
/** A single fish swimming in the lake (cosmetic, real-time). */
interface SwimFish { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; speed: number; }
/** A wandering meadow critter (cosmetic, real-time). Ducks keep to the shore. */
interface Critter { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; speed: number; hops: boolean; hop: number; shore: boolean; pond: boolean; }
interface SkyBird { mesh: THREE.Group; wings: THREE.Group[]; vx: number; vz: number; phase: number; }

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
  private readonly outline: OutlineEffect | null;
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
  private readonly entranceMat = noOutline(new THREE.MeshBasicMaterial({ color: 0x46c256, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));

  // cobbled road overlay meshes, keyed by "x,y"
  private readonly roadMeshes = new Map<string, THREE.Mesh>();
  private readonly roadGeo = new THREE.PlaneGeometry(1.0, 1.0);
  private readonly roadMats: THREE.Material[] = [];

  // ambient scenery that turns in real time (distant windmill sails)
  private readonly millSails: THREE.Object3D[] = [];
  private cloudBound = 40;

  // the sun follows the camera so its shadow map only covers what's visible
  private sun!: THREE.DirectionalLight;

  // adaptive quality: drop pixelRatio when frames run long, restore when quick
  private readonly maxPixelRatio = Math.min(devicePixelRatio, 2);
  private qFrameMs = 16;
  private qLastT = 0;
  private qHoldT = 0;

  // grazing pigs on each pig-farm's pasture plots (cosmetic, real-time)
  private readonly pigHerds = new Map<Building, Pig[]>();

  // fish swimming in the lake (cosmetic, real-time)
  private readonly fish: SwimFish[] = [];
  private lakeTiles: { x: number; y: number }[] = [];

  // sparse wildlife ambling across the meadow (cosmetic, real-time)
  private readonly critters: Critter[] = [];
  private readonly skyBirds: SkyBird[] = [];
  private nextBirdT = 0;

  // short-lived flags marking where the player just ordered units to go
  private readonly orderPings: { mesh: THREE.Group; life: number; max: number }[] = [];

  // minimap
  private readonly mm: HTMLCanvasElement;
  private readonly mmx: CanvasRenderingContext2D;

  // ---------- gore layer (cosmetic; bodies linger, then fade) ----------
  private readonly goreGroup = new THREE.Group();
  private readonly goreBodies: { obj: THREE.Mesh; age: number; mat: THREE.Material }[] = [];
  private readonly MAX_BODIES = 11000;
  private readonly CORPSE_LIFE = 300;   // seconds a body lies before it starts fading (5 min)
  private readonly CORPSE_FADE = 20;    // seconds to fade out once its time is up

  // ---------- unit selection rings (pooled, persist across levels) ----------
  private readonly selRings: THREE.Mesh[] = [];
  private readonly selRingGeo = new THREE.RingGeometry(0.32, 0.44, 18);
  private readonly selRingMat = noOutline(new THREE.MeshBasicMaterial({ color: 0x46c256, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  private readonly selectedUnits = new Set<Unit>();

  // ---------- HP bars (pooled, billboarded, persist across levels) ----------
  private readonly hpBarGroup = new THREE.Group();
  private readonly hpBars: { group: THREE.Group; fill: THREE.Mesh }[] = [];

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // crisp hard-edged shadows suit the cel look and cost less than PCFSoft
    this.renderer.shadowMap.type = GRAPHICS.toon ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

    // ink edges: OutlineEffect re-renders outlined meshes as expanded backfaces
    this.outline = GRAPHICS.outlines ? new OutlineEffect(this.renderer, {
      defaultThickness: GRAPHICS.outlineThickness,
      defaultColor: new THREE.Color(GRAPHICS.outlineColor).toArray(),
      defaultAlpha: GRAPHICS.outlineAlpha,
    }) : null;

    this.setSize();
    addEventListener('resize', () => this.setSize());

    // Lighting — re-tuned for r155+ physical light units (legacy lights are
    // gone): a strong warm sun over a cool ambient floor so the cel bands
    // read, plus soft partial-strength shadows via shadow.intensity — an
    // r165+ capability that keeps shaded grass colorful instead of muddy.
    const toon = GRAPHICS.toon;
    this.scene.add(new THREE.AmbientLight(0xffffff, toon ? 0.46 : 0.55));
    this.scene.add(new THREE.HemisphereLight(0xdaeeff, 0x6f8a52, toon ? 0.56 : 0.5));
    const sun = new THREE.DirectionalLight(0xfff0d2, toon ? 2.2 : 1.95);
    sun.position.set(-18, 30, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.far = 100;
    (sun.shadow as THREE.DirectionalLightShadow & { intensity: number }).intensity = 0.72;      // shadows shade, they don't blacken
    sun.shadow.normalBias = 0.03;     // low-poly merged meshes acne easily
    this.scene.add(sun, sun.target);
    this.sun = sun;
    if (toon) {
      const fill = new THREE.DirectionalLight(0x9db8ff, 0.5);
      fill.position.set(20, 18, -14);
      this.scene.add(fill, fill.target);
    }

    // a few cobble variants so long roads don't tile visibly (shared, persist);
    // flat on the ground, so skip their outline pass — it would be invisible
    for (let i = 0; i < 4; i++) this.roadMats.push(stdMat({ map: this.makeRoadTexture() }, false));

    this.scene.add(this.worldGroup);

    // road-tile cursor
    this.roadCursor = new THREE.Mesh(
      new THREE.PlaneGeometry(0.96, 0.96),
      noOutline(new THREE.MeshBasicMaterial({ color: 0xb9a179, transparent: true, opacity: 0.75, side: THREE.DoubleSide })),
    );
    this.roadCursor.rotation.x = -Math.PI / 2; this.roadCursor.position.y = 0.03; this.roadCursor.visible = false;
    this.scene.add(this.roadCursor);
    this.scene.add(this.ghost); this.ghost.visible = false;
    this.scene.add(this.goreGroup);
    this.scene.add(this.hpBarGroup);
    this.scene.add(this.goreGroup);

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
    this.fitShadowToMap();
    this.buildGround();
    this.populateDoodads();
    this.buildAmbiance();
    this.spawnFish();
    this.spawnCritters();
    this.nextBirdT = 6 + rnd() * 14;
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
    this.chunkMeshes.clear();   // their geometries were disposed with worldGroup
    this.dirtyChunks.clear();
    this.chunkCols = 0;
    this.clouds.length = 0;
    this.pigHerds.clear();
    this.fish.length = 0;
    this.critters.length = 0;
this.skyBirds.length = 0;
    this.nextBirdT = 0;
    for (const p of this.orderPings) this.worldGroup.remove(p.mesh);
    this.orderPings.length = 0;
    this.lakeTiles = [];
    this.millSails.length = 0;
    this.ghostKey = null;
    this.clearGore();
  }

  // =====================================================================
  //  Gore layer
  // =====================================================================
  /** A hit no longer sprays blood — kept as a no-op so the callback stays wired. */
  spawnHurt(_x: number, _z: number): void { /* bodies only; no blood pools */ }

  /** A persistent corpse where a unit died; it lingers, then fades (see ageGore). */
  spawnCorpse(x: number, z: number, colorHex: number, role = 'serf', scale = 1): void {
    const body = makeUnitCorpse(role, colorHex); // single merged mesh, its own opaque material
    body.scale.setScalar(scale);
    body.position.set(x, 0.04 * scale, z);
    body.rotation.y = rnd() * Math.PI * 2;
    this.goreGroup.add(body);
    this.freeze(body); // lies where it fell until culled
    this.goreBodies.push({ obj: body, age: 0, mat: body.material as THREE.Material });
    if (this.goreBodies.length > this.MAX_BODIES) this.cullBody(this.goreBodies.shift()!);
  }

  /** Age corpses in real time; keep them opaque until their time is up, then fade & cull. */
  private ageGore(dt: number): void {
    for (let i = this.goreBodies.length - 1; i >= 0; i--) {
      const c = this.goreBodies[i];
      c.age += dt;
      if (c.age <= this.CORPSE_LIFE) continue;
      const k = 1 - (c.age - this.CORPSE_LIFE) / this.CORPSE_FADE;
      if (k <= 0) { this.cullBody(c); this.goreBodies.splice(i, 1); continue; }
      const m = c.mat as THREE.Material & { opacity: number };
      if (!m.transparent) {
        m.transparent = true; m.needsUpdate = true;  // only now joins the transparent pass
        m.userData.outlineParameters = { visible: false }; // ink must not outlive the fading body
      }
      m.opacity = k;
    }
  }

  private cullBody(c: { obj: THREE.Mesh; mat: THREE.Material }): void {
    this.goreGroup.remove(c.obj);
    c.obj.geometry.dispose();
    c.mat.dispose();
  }

  private clearGore(): void {
    for (const c of this.goreBodies) this.cullBody(c);
    this.goreBodies.length = 0;
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

  /** Size the sun's shadow frustum to the loaded map once per level — no
   *  bigger than the board needs, no per-frame retargeting to get wrong. */
  private fitShadowToMap(): void {
    if (!this.sun || !this.world) return;
    const r = Math.hypot(this.world.W, this.world.H) / 2 + 4;
    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.updateProjectionMatrix();
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

  /** World-space point → screen pixels (for box-selection hit tests). */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  }

  /** Show green selection rings under the given units (pooled; persists across levels). */
  showSelection(units: Unit[]): void {
    this.selectedUnits.clear();
    for (const u of units) this.selectedUnits.add(u);
    while (this.selRings.length < units.length) {
      const r = new THREE.Mesh(this.selRingGeo, this.selRingMat);
      r.rotation.x = -Math.PI / 2; this.scene.add(r); this.selRings.push(r);
    }
    for (let i = 0; i < this.selRings.length; i++) {
      const r = this.selRings[i];
      if (i < units.length) { r.visible = true; const p = units[i].mesh.position; r.position.set(p.x, 0.06, p.z); }
      else r.visible = false;
    }
  }

  /** Billboarded HP bars over damaged fighters and enemy/damaged buildings (pooled). */
  updateHealthBars(units: Unit[], buildings: Building[]): void {
    let i = 0;
    const use = (wx: number, wy: number, wz: number, ratio: number): void => {
      let bar = this.hpBars[i];
      if (!bar) { bar = this.makeHpBar(); this.hpBarGroup.add(bar.group); this.hpBars.push(bar); }
      bar.group.visible = true;
      bar.group.position.set(wx, wy, wz);
      bar.group.quaternion.copy(this.camera.quaternion);
      const r = Math.max(0, Math.min(1, ratio));
      bar.fill.scale.x = Math.max(0.001, r);
      bar.fill.position.x = -0.34 * (1 - r);
      (bar.fill.material as THREE.MeshBasicMaterial).color.setHex(r > 0.5 ? 0x46c256 : r > 0.25 ? 0xd9a441 : 0xc96b4a);
      i++;
    };
    for (const u of units) {
      if (u.dead || u.hp >= u.maxHp || !u.mesh.visible) continue;
      const p = u.mesh.position, s = u.mesh.scale.y || 1;
      use(p.x, p.y + 0.95 * s + 0.2, p.z, u.hp / u.maxHp);
    }
    for (const b of buildings) {
      if (b.removed) continue;
      const enemy = b.faction !== 'player';
      if (!enemy && b.hp >= b.maxHp) continue;   // show player buildings only when hurt
      use(this.world.wx(b.x) + 0.5, 2.3, this.world.wz(b.y) + 0.5, b.hp / b.maxHp);
    }
    for (; i < this.hpBars.length; i++) this.hpBars[i].group.visible = false;
  }

  private makeHpBar(): { group: THREE.Group; fill: THREE.Mesh } {
    // Both planes must live in the transparent pass with explicit renderOrder:
    // an opaque fill would be drawn first and the translucent background would
    // then paint over it, leaving every bar looking empty.
    const g = new THREE.Group();
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.11), new THREE.MeshBasicMaterial({ color: 0x140f0a, depthTest: false, transparent: true, opacity: 0.85 }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.075), new THREE.MeshBasicMaterial({ color: 0x46c256, depthTest: false, transparent: true }));
    (bg.material as THREE.Material).depthWrite = false; (fill.material as THREE.Material).depthWrite = false;
    bg.renderOrder = 998; fill.renderOrder = 999;
    fill.position.z = 0.01;
    g.add(bg, fill);
    return { group: g, fill };
  }

  // =====================================================================
  //  Scene helpers
  // =====================================================================
  /**
   * Freeze a static object's local matrices (matrixAutoUpdate off, one final
   * updateMatrix) so hundreds of placed doodads/buildings cost no per-frame
   * matrix math. Subtrees that do animate (windmill sails, smoke puffs,
   * scaffold frames) carry userData.dynamic and keep auto updates; their
   * children are still frozen since they never move relative to the parent.
   * Pass includeRoot=false when the root itself is animated (growing trees,
   * ripening crops, walking units) but its children are rigid.
   */
  private freeze(root: THREE.Object3D, includeRoot = true): void {
    if (includeRoot && !root.userData.dynamic) { root.updateMatrix(); root.matrixAutoUpdate = false; }
    for (const c of root.children) this.freeze(c);
  }

  /** Buildings and construction sites — placed once, then static (bar their dynamic-flagged parts). */
  add(o: THREE.Object3D): void { this.worldGroup.add(o); this.freeze(o); }
  remove(o: THREE.Object3D): void {
    this.worldGroup.remove(o);
    // baked unit bodies own their merged geometry — free it now, not at level end
    o.traverse((c) => { if (c.userData.ownGeometry) (c as THREE.Mesh).geometry.dispose(); });
  }

  createBuildingMesh(key: BuildingKey, def: BuildingDef): THREE.Group { return makeBuilding(key, def, false); }
  createScaffold(key: BuildingKey, def: BuildingDef) { return makeScaffold(key, def); }

  createUnit(colorHex: number, role: string, tileX: number, tileY: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
    const u = makeUnit(colorHex, role);
    u.group.position.set(this.world.wx(tileX), 0, this.world.wz(tileY));
    this.worldGroup.add(u.group);
    this.freeze(u.group, false); // the unit walks; its body parts are rigid
    return u;
  }

  /** Combat effect meshes, owned & positioned by the sim (removed via `remove`). */
  createArrow(): THREE.Group { const m = makeArrow(); this.worldGroup.add(m); return m; }
  createFireball(): THREE.Group { const m = makeFireball(); this.worldGroup.add(m); return m; }
  createFlame(): THREE.Group { const m = makeFlame(); this.worldGroup.add(m); return m; }
  createFlag(): THREE.Group { const m = makeFlag(); this.worldGroup.add(m); return m; }
  /** Marker parented onto a building mesh (not the world) so it follows it. */
  createPlotMarker(): THREE.Group { return makePlotMarker(); }

  /** Plant a short-lived flag where the player just ordered units to move —
   *  it pops in, stands a moment, then shrinks away (see animate). */
  showOrderMarker(wx: number, wz: number): void {
    const m = makeFlag();
    m.userData.dynamic = true;
    m.position.set(wx, 0, wz);
    m.scale.setScalar(0.1);
    this.worldGroup.add(m);
    this.freeze(m, false);
    this.orderPings.push({ mesh: m, life: 1.5, max: 1.5 });
  }

  private updateOrderPings(dt: number): void {
    for (let i = this.orderPings.length - 1; i >= 0; i--) {
      const p = this.orderPings[i];
      p.life -= dt;
      if (p.life <= 0) { this.worldGroup.remove(p.mesh); this.orderPings.splice(i, 1); continue; }
      const age = p.max - p.life;
      // quick pop up, hold, then shrink out at the end
      const s = p.life < 0.3 ? p.life / 0.3 : Math.min(1, age * 6);
      p.mesh.scale.setScalar(Math.max(0.05, s));
    }
  }

  /**
   * A tree that is still growing gets its own mesh (its root rescales every
   * tick); a grown tree is folded into its scenery chunk. Game calls
   * `treeMatured` at the moment growth completes to swap the former into the
   * latter.
   */
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
    if (t.type === 'water') return { hex: 0x36648f, sh: 0.9 + ((tx * 7 + ty * 13) % 10) / 100 };
    // rocky ground: grey scree under mountain peaks, dusty earth under ruined walls
    if (t.type === 'rock') return t.rock === 'wall'
      ? { hex: 0x9a8a6e, sh: 0.92 + ((tx * 3 + ty * 7) % 8) / 100 }
      : { hex: 0x83837e, sh: 0.88 + ((tx * 5 + ty * 3) % 12) / 100 };
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
    this.chunkCols = Math.ceil(W / View.CHUNK);
    for (let i = 0; i < this.chunkCols * Math.ceil(H / View.CHUNK); i++) this.dirtyChunks.add(i);
    this.flushChunks();
  }

  // =====================================================================
  //  Chunk-merged scenery — all static doodads in an 8×8-tile chunk render
  //  as ONE vertex-colored mesh. 5k+ individual doodad meshes (each drawn
  //  twice by the OutlineEffect) collapse into a few dozen draw calls; a
  //  chunk is re-baked only when one of its tiles changes (tree felled,
  //  deposit exhausted, building placed over decoration).
  // =====================================================================
  private static readonly CHUNK = 8;
  private chunkCols = 0;
  private chunkMeshes = new Map<number, THREE.Mesh>();
  private readonly dirtyChunks = new Set<number>();
  private chunkMat: THREE.Material | null = null;

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
    this.dirtyChunks.add(Math.floor(y / View.CHUNK) * this.chunkCols + Math.floor(x / View.CHUNK));
  }

  private flushChunks(): void {
    for (const idx of this.dirtyChunks) this.rebuildChunk(idx);
    this.dirtyChunks.clear();
  }

  private rebuildChunk(idx: number): void {
    const old = this.chunkMeshes.get(idx);
    if (old) { this.worldGroup.remove(old); old.geometry.dispose(); this.chunkMeshes.delete(idx); }
    const cx = (idx % this.chunkCols) * View.CHUNK, cy = Math.floor(idx / this.chunkCols) * View.CHUNK;
    const parts: THREE.BufferGeometry[] = [];
    const H = this.world.H, W = this.world.W;
    for (let y = cy; y < Math.min(H, cy + View.CHUNK); y++)
      for (let x = cx; x < Math.min(W, cx + View.CHUNK); x++) this.bakeTileInto(parts, x, y);
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

  // =====================================================================
  //  Ambiance — gradient sky, horizon meadow, rolling hills, treeline,
  //  a distant windmill and drifting clouds
  // =====================================================================
  private buildAmbiance(): void {
    const W = this.world.W, H = this.world.H;
    // Painted sky: richer vertical colour, warm sun haze and a few extremely
    // faint high-altitude streaks. This is a screen backdrop, not a cloud count.
    const sky = document.createElement('canvas'); sky.width = 512; sky.height = 512;
    const sctx = sky.getContext('2d')!;
    const grad = sctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#4e9bd0');
    grad.addColorStop(0.42, '#82bddd');
    grad.addColorStop(0.72, '#bddbea');
    grad.addColorStop(1, '#f0e9d3');
    sctx.fillStyle = grad; sctx.fillRect(0, 0, 512, 512);
    const sun = sctx.createRadialGradient(405, 120, 3, 405, 120, 155);
    sun.addColorStop(0, 'rgba(255,247,206,.72)');
    sun.addColorStop(0.22, 'rgba(255,235,184,.3)');
    sun.addColorStop(1, 'rgba(255,235,184,0)');
    sctx.fillStyle = sun; sctx.fillRect(0, 0, 512, 360);
    sctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const y = 62 + rnd() * 150, x = rnd() * 380, w = 70 + rnd() * 150;
      sctx.strokeStyle = `rgba(255,255,255,${0.025 + rnd() * 0.035})`;
      sctx.lineWidth = 7 + rnd() * 13;
      sctx.beginPath(); sctx.moveTo(x, y); sctx.bezierCurveTo(x + w * 0.3, y - 8, x + w * 0.7, y + 8, x + w, y); sctx.stroke();
    }
    this.skyTex = new THREE.CanvasTexture(sky);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.skyTex;
    this.scene.fog = new THREE.Fog(0xd4e4df, 70, 165);

    // a broad meadow plain reaching out to the horizon beneath the map plinth
    const plain = new THREE.Mesh(new THREE.CircleGeometry(240, 96), stdMat({ color: 0x7da866 }, false));
    plain.rotation.x = -Math.PI / 2; plain.position.y = -2.1;
    this.worldGroup.add(plain);
    this.freeze(plain);

    // The board reaches its corners at `boardR`; keep every background element
    // beyond boardR + GAP so scenery never sits on top of the play area. Each
    // element's own radius is added in, so its *inner* edge clears the gap.
    const boardR = Math.hypot(W / 2, H / 2);
    const GAP = 12;

    // Patchwork countryside beyond the playable board: irregular field strips,
    // dark hedges and glints of distant water break up the old flat green disc.
    const fieldMats = [0x91ae61, 0xb3ad62, 0x779d59, 0xc0a86a, 0x88a968].map(c => stdMat({ color: c }, false));
    const hedgeMat = stdMat({ color: 0x456842 }, false);
    for (let i = 0; i < 26; i++) {
      const ang = rnd() * Math.PI * 2, rad = boardR + GAP + 7 + rnd() * 34;
      const w = 4 + rnd() * 8, d = 2.5 + rnd() * 5;
      const field = new THREE.Mesh(box(w, 0.035, d), fieldMats[i % fieldMats.length]);
      field.position.set(Math.cos(ang) * rad, -2.055, Math.sin(ang) * rad); field.rotation.y = ang + (rnd() - 0.5) * 1.2;
      this.worldGroup.add(field); this.freeze(field);
      if (i % 2 === 0) {
        const hedge = new THREE.Mesh(box(w + 0.4, 0.13, 0.12), hedgeMat);
        hedge.position.set(field.position.x, -1.98, field.position.z); hedge.rotation.y = field.rotation.y; this.worldGroup.add(hedge); this.freeze(hedge);
      }
    }
    const waterMat = stdMat({ color: 0x72a9bd, transparent: true, opacity: 0.75 }, false);
    for (let i = 0; i < 3; i++) {
      const ang = rnd() * Math.PI * 2, rad = boardR + GAP + 15 + rnd() * 25;
      const water = new THREE.Mesh(circle(1, 24), waterMat); water.rotation.x = -Math.PI / 2;
      water.scale.set(3 + rnd() * 4, 1.2 + rnd() * 2.2, 1); water.position.set(Math.cos(ang) * rad, -2.01, Math.sin(ang) * rad);
      this.worldGroup.add(water); this.freeze(water);
    }

    // low rolling hill domes in three hazier and hazier rings
    const hillTones = [0x91b879, 0x7da86f, 0x709a73, 0x668c7b].map(c => stdMat({ color: c }));
    for (let ring = 0; ring < 3; ring++) {
      const count = 12 + ring * 5;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + rnd() * 0.5;
        const r = 9 + ring * 7 + rnd() * 7;
        const rad = boardR + GAP + r + ring * 22 + rnd() * 10; // inner edge = rad - r ≥ boardR + GAP
        const h = (2.5 + rnd() * 2.5) * (1 + ring * 0.5);
        const hill = new THREE.Mesh(sphere(1, 20, 12), hillTones[Math.min(3, ring + (i % 2))]);
        hill.scale.set(r, h, r);
        hill.position.set(Math.cos(ang) * rad, -2.1, Math.sin(ang) * rad);
        this.worldGroup.add(hill);
        this.freeze(hill);
      }
    }

    // a hazy treeline out in the meadow ring, between the plinth and the hills
    const foliage = [0x4a7350, 0x3f6a5e, 0x577d48, 0x426b43].map(c => stdMat({ color: c }));
    const trunkM = stdMat({ color: 0x5b4433 });
    for (let i = 0; i < 90; i++) {
      const ang = rnd() * Math.PI * 2;
      const s = 0.9 + rnd() * 1.4;
      const rad = boardR + 5 + rnd() * (GAP - 4); // sits in the gap ring, clear of the board
      const deciduous = rnd() < 0.42;
      const crown = new THREE.Mesh(deciduous ? sphere(0.82, 10, 7) : cone(0.75, 2.6, 7), foliage[Math.floor(rnd() * foliage.length)]);
      crown.scale.set(s, deciduous ? s * (0.85 + rnd() * 0.35) : s, s);
      crown.position.set(Math.cos(ang) * rad, -2.1 + 1.5 * s, Math.sin(ang) * rad);
      this.worldGroup.add(crown);
      this.freeze(crown);
      if (rnd() < 0.35) {
        const trunk = new THREE.Mesh(cyl(0.1, 0.14, 0.5, 5), trunkM);
        trunk.scale.setScalar(s);
        trunk.position.set(crown.position.x, -2.1 + 0.22 * s, crown.position.z);
        this.worldGroup.add(trunk);
        this.freeze(trunk);
      }
    }

// A tiny horizon village adds human scale: warm roofs, a church spire and
    // a pale lane, all well outside the playable edge.
    const villageAng = rnd() * Math.PI * 2, villageRad = boardR + 31;
    const village = new THREE.Group();
    const lane = new THREE.Mesh(box(8.5, 0.025, 0.7), stdMat({ color: 0xc9b58c }, false)); lane.position.y = 0.02; village.add(lane);
    const villageRoofs = [0x9c4b36, 0x7e4935, 0xb0603f];
    for (let i = 0; i < 6; i++) {
      const x = -3.4 + i * 1.35, z = (rnd() - 0.5) * 1.1, s = 0.55 + rnd() * 0.28;
      const house = new THREE.Mesh(box(0.9 * s, 0.75 * s, 0.72 * s), stdMat({ color: i % 2 ? 0xd6c59f : 0xc8b489 })); house.position.set(x, 0.38 * s, z); village.add(house);
      const roof = new THREE.Mesh(cone(0.72 * s, 0.55 * s, 4), stdMat({ color: villageRoofs[i % villageRoofs.length] })); roof.rotation.y = Math.PI / 4; roof.position.set(x, 1.02 * s, z); village.add(roof);
    }
    const church = new THREE.Mesh(box(0.72, 1.65, 0.72), stdMat({ color: 0xd9cfb5 })); church.position.set(0.2, 0.83, -0.8); village.add(church);
    const spire = new THREE.Mesh(cone(0.58, 1.45, 6), stdMat({ color: 0x55666a })); spire.position.set(0.2, 2.27, -0.8); village.add(spire);
    village.position.set(Math.cos(villageAng) * villageRad, -2.08, Math.sin(villageAng) * villageRad); village.lookAt(0, -2.08, 0);
    this.worldGroup.add(village); this.freeze(village);

    // one far-off windmill turning on the plain — a little postcard of Het
    // Gooi. Pinned to the map's north (up-screen from the iso camera, world
    // (-1,-1)) so it's actually in view instead of hiding behind the camera.
    const millAng = -Math.PI * 3 / 4 + (rnd() - 0.5) * 0.5;
    const millRad = boardR + 38;
    const mill = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.7, 5.2, 8), stdMat({ color: 0x6b5540 }));
    body.position.y = 2.6; mill.add(body);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.35, 1.3, 8), stdMat({ color: 0x54402f }));
    cap.position.y = 5.85; mill.add(cap);
    const sails = new THREE.Group();
    sails.userData.dynamic = true; // turns every frame
    sails.position.set(0, 5.4, 1.5);
    const sailMat = stdMat({ color: 0xefe6d0 });
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
    this.freeze(mill);
    this.millSails.push(sails);

    // Two or three detailed cloud banks drift high above the board. Layered
    // blue-grey undersides and bright crowns give them volume without turning
    // the playfield into a ceiling of white blobs.
    const cloudSpan = boardR * 2 + 30;
    this.cloudBound = cloudSpan / 2;
    const cloudTop = stdMat({ color: 0xffffff, transparent: true, opacity: 0.72 });
    const cloudLight = stdMat({ color: 0xf5fbff, transparent: true, opacity: 0.5 });
    const cloudShade = stdMat({ color: 0xb8ced9, transparent: true, opacity: 0.42 });
    const mk = (c: THREE.Group, x: number, z: number, s: number, y = 0): void => {
      const shade = new THREE.Mesh(sphere(1, 14, 9), cloudShade);
      shade.position.set(x, y - 0.16, z); shade.scale.set(s * 1.08, s * 0.34, s * 0.92); c.add(shade);
      const p = new THREE.Mesh(sphere(1, 16, 10), cloudTop);
      p.position.set(x, y + rnd() * 0.18, z); p.scale.set(s, s * 0.62, s); c.add(p);
      const light = new THREE.Mesh(sphere(1, 14, 9), cloudLight);
      light.position.set(x - s * 0.16, y + s * 0.28, z - s * 0.08); light.scale.set(s * 0.62, s * 0.31, s * 0.62); c.add(light);
    };
    // each builder sketches an animal silhouette in the horizontal plane
    const animals: Array<(c: THREE.Group) => void> = [
      c => { mk(c, -1.2, 0, 0.5); mk(c, 0, 0, 1.3); mk(c, 1.5, 0, 0.95); mk(c, 1.85, -0.5, 0.42); mk(c, 2.15, -0.85, 0.32); mk(c, 1.85, 0.5, 0.42); mk(c, 2.15, 0.85, 0.32); }, // bunny
      c => { mk(c, 0, 0, 1.25); mk(c, 1.45, 0, 0.85); mk(c, 1.7, -0.42, 0.3); mk(c, 1.7, 0.42, 0.3); mk(c, -1.3, 0.3, 0.4); mk(c, -1.75, 0.65, 0.32); }, // cat
      c => { mk(c, 0, 0, 1.15); mk(c, 1.25, 0.1, 0.8); mk(c, 1.95, 0.1, 0.32); mk(c, -1.0, 0.2, 0.55, 0.2); }, // duck
      c => { mk(c, 0.3, 0, 1.25); mk(c, -0.5, 0, 0.9); mk(c, -1.7, -0.5, 0.45); mk(c, -1.7, 0.5, 0.45); }, // fish
      c => { mk(c, 0, 0, 1.5); mk(c, 1.6, 0, 1.0); mk(c, 2.3, 0.1, 0.5); mk(c, 2.75, 0.42, 0.4); mk(c, 3.05, 0.78, 0.3); mk(c, 1.3, -0.78, 0.5); mk(c, -1.5, 0, 0.55); }, // elephant
      c => { mk(c, 0, 0, 1.25); mk(c, 1.55, 0, 0.85); mk(c, 2.15, 0, 0.4); mk(c, 1.4, -0.55, 0.4); mk(c, -1.4, 0.2, 0.4, 0.2); }, // dog
    ];
    const cloudCount = 2 + (rnd() < 0.35 ? 1 : 0);
    for (let i = 0; i < cloudCount; i++) {
      const c = new THREE.Group();
      if (rnd() < 0.18) {
        animals[Math.floor(rnd() * animals.length)](c);
      } else {
        const n = 4 + Math.floor(rnd() * 3);
        for (let j = 0; j < n; j++) {
          const s = 1 + rnd() * 1.2;
          mk(c, (j - (n - 1) / 2) * 1.35 + (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 1.6, s, rnd() * 0.45);
        }
      }
      c.scale.setScalar(0.9 + rnd() * 0.5);
      c.rotation.y = (rnd() - 0.5) * 0.55;
      const laneX = -this.cloudBound + (i + 0.5) * (cloudSpan / cloudCount);
      c.position.set(laneX + (rnd() - 0.5) * cloudSpan / cloudCount * 0.45, 15 + rnd() * 4, (rnd() - 0.5) * cloudSpan);
      c.userData.cloudSpeed = 0.38 + rnd() * 0.28;
      this.worldGroup.add(c);
      this.freeze(c, false); // the group drifts; its puffs never move within it
      this.clouds.push(c);
    }
  }

  private markerT = 0;

  /** Real-time animation independent of sim speed: turning sails, drifting clouds. */
  animate(dt: number, buildings: Building[]): void {
    this.markerT += dt;
    for (const b of buildings) {
      const spin = b.mesh.userData.spin as THREE.Group | undefined;
      if (spin) spin.rotation.z += dt * (b.active ? 1.1 : 0.35);
      const smoke = b.mesh.userData.smoke as { puffs: THREE.Mesh[]; base: THREE.Vector3 } | undefined;
      if (smoke) this.animateSmoke(smoke, dt, b.active);
      const pm = b.mesh.userData.plotMarker as THREE.Group | undefined;
      if (pm) {
        pm.visible = b.active && b.fieldsList.length < (b.def.plots ?? 8);
        if (pm.visible) { pm.rotation.y += dt * 2.4; pm.position.y = 2.4 + Math.sin(this.markerT * 3) * 0.12; }
      }
    }
    for (const c of this.clouds) {
      c.position.x += dt * (c.userData.cloudSpeed as number || 0.5);
      if (c.position.x > this.cloudBound) c.position.x = -this.cloudBound;
    }
    for (const s of this.millSails) s.rotation.z += dt * 0.45;
    this.updatePigs(dt, buildings);
    this.updateFish(dt);
    this.updateCritters(dt);
this.updateSkyBirds(dt);
    this.updateOrderPings(dt);
    this.ageGore(dt);
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
      const mesh = makeFish(); this.worldGroup.add(mesh); this.freeze(mesh, false);
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

  /** A genuinely sparse handful of wildlife: one colorful cat, at most two
   *  meadow animals, and a frog only when the map has a small pond. */
  private spawnCritters(): void {
    const spawn = (kind: CritterKind, spot: { x: number; y: number } | null): void => {
      if (!spot) return;
      const { group, hops } = makeCritter(kind);
      this.worldGroup.add(group); this.freeze(group, false);
      const x = this.world.wx(spot.x), z = this.world.wz(spot.y);
      group.position.set(x, 0, z);
      this.critters.push({
        mesh: group, x, z, tx: x, tz: z, wait: rnd() * 4,
        speed: kind === 'fox' ? 0.9 : kind === 'mouse' ? 0.75 : kind === 'hedgehog' ? 0.22 : kind === 'frog' ? 0.35 : 0.5,
        hops, hop: 0, shore: kind === 'duck' || kind === 'frog', pond: kind === 'frog',
      });
    };

    spawn('cat', this.critterGrassSpot());
    if (rnd() < 0.3) spawn('cat', this.critterGrassSpot());
    const pool = [...CRITTER_KINDS];
    const extra = 1 + (rnd() < 0.45 ? 1 : 0);
    for (let i = 0; i < extra && pool.length; i++) {
      const kind = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      spawn(kind, kind === 'duck' ? this.critterShoreSpot() : this.critterGrassSpot());
    }
    spawn('frog', this.critterPondSpot());
  }

  private critterGrassSpot(): { x: number; y: number } | null {
    for (let i = 0; i < 40; i++) {
      const x = 2 + Math.floor(uiRng.next() * (this.world.W - 4)), y = 2 + Math.floor(uiRng.next() * (this.world.H - 4));
      const t = this.world.tiles[y][x];
      if (t.type === 'grass' && !t.b && !t.site && !t.tree && !t.dep) return { x, y };
    }
    return null;
  }

  private critterShoreSpot(): { x: number; y: number } | null {
    for (let i = 0; i < 60; i++) {
      const s = this.critterGrassSpot();
      if (!s) return null;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = this.world.T(s.x + dx, s.y + dy);
        if (t && t.type === 'water') return s;
      }
    }
    return this.critterGrassSpot();
  }

  /** Grass on the bank of one of the small non-lake ponds. */
  private critterPondSpot(): { x: number; y: number } | null {
    const banks: { x: number; y: number }[] = [];
    for (let y = 1; y < this.world.H - 1; y++) for (let x = 1; x < this.world.W - 1; x++) {
      const t = this.world.tiles[y][x];
      if (t.type !== 'grass' || t.b || t.site || t.tree || t.dep) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const w = this.world.T(x + dx, y + dy);
        return !!w && w.type === 'water' && !w.lake;
      })) banks.push({ x, y });
    }
    return banks.length ? banks[Math.floor(rnd() * banks.length)] : null;
  }

  private updateCritters(dt: number): void {
    for (const c of this.critters) {
      if (c.wait > 0) {
        c.wait -= dt;
        c.mesh.position.y = 0;
        if (c.wait <= 0) {
          // pick a nearby free grass tile to drift to (shore-birds stay coastal)
          const cur = { x: Math.round(c.x + this.world.W / 2 - 0.5), y: Math.round(c.z + this.world.H / 2 - 0.5) };
          for (let i = 0; i < 8; i++) {
            const nx = cur.x + Math.round((uiRng.next() - 0.5) * 7), ny = cur.y + Math.round((uiRng.next() - 0.5) * 7);
            const t = this.world.T(nx, ny);
            if (!t || t.type !== 'grass' || t.b || t.site || t.tree || t.dep) continue;
            if (c.shore && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => {
              const w = this.world.T(nx + ox, ny + oy);
              return !!w && w.type === 'water' && (!c.pond || !w.lake);
            })) continue;
            c.tx = this.world.wx(nx) + (uiRng.next() - 0.5) * 0.5;
            c.tz = this.world.wz(ny) + (uiRng.next() - 0.5) * 0.5;
            break;
          }
        }
        continue;
      }
      const dx = c.tx - c.x, dz = c.tz - c.z, dist = Math.hypot(dx, dz);
      if (dist < 0.05) { c.wait = 2 + uiRng.next() * 6; c.mesh.position.y = 0; continue; }
      const step = Math.min(c.speed * dt, dist);
      c.x += dx / dist * step; c.z += dz / dist * step;
      // hoppers bounce along; everyone else glides
      if (c.hops) { c.hop += dt * 9; c.mesh.position.y = Math.abs(Math.sin(c.hop)) * 0.06; }
      c.mesh.position.x = c.x; c.mesh.position.z = c.z;
      c.mesh.rotation.y = Math.atan2(-dz, dx); // critter models face +x
    }
  }

  /** Occasionally send a lone bird, flock, or rare eagle across the board. */
  private spawnSkyBirds(): void {
    const roll = rnd(), eagle = roll > 0.9;
    const count = eagle ? 1 : roll < 0.4 ? 1 : 3 + Math.floor(rnd() * 4);
    const dir = rnd() < 0.5 ? 1 : -1;
    const startX = dir > 0 ? -this.cloudBound - 5 : this.cloudBound + 5;
    const baseZ = (rnd() - 0.5) * this.world.H * 0.8;
    for (let i = 0; i < count; i++) {
      const { group, wings } = makeSkyBird(eagle);
      const row = Math.floor(i / 2) + 1, side = i === 0 ? 0 : i % 2 ? -1 : 1;
      group.position.set(startX - dir * row * 0.8, eagle ? 12 : 8 + rnd() * 3, baseZ + side * row * 0.75);
      if (dir < 0) group.rotation.y = Math.PI;
      this.worldGroup.add(group); this.freeze(group, false);
      this.skyBirds.push({ mesh: group, wings, vx: dir * (eagle ? 3.2 : 2.2 + rnd() * 0.8), vz: (rnd() - 0.5) * 0.18, phase: rnd() * Math.PI * 2 });
    }
  }

  private updateSkyBirds(dt: number): void {
    this.nextBirdT -= dt;
    if (this.nextBirdT <= 0) {
      this.spawnSkyBirds();
      this.nextBirdT = 18 + rnd() * 28;
    }
    for (let i = this.skyBirds.length - 1; i >= 0; i--) {
      const b = this.skyBirds[i];
      b.mesh.position.x += b.vx * dt; b.mesh.position.z += b.vz * dt;
      b.phase += dt * 7;
      const flap = Math.sin(b.phase) * 0.55;
      b.wings[0].rotation.x = flap; b.wings[1].rotation.x = -flap;
      if (Math.abs(b.mesh.position.x) <= this.cloudBound + 8) continue;
      this.worldGroup.remove(b.mesh);
      this.skyBirds.splice(i, 1);
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
        const mesh = makePig(big); this.worldGroup.add(mesh); this.freeze(mesh, false);
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
  showGhost(def: BuildingDef, key: BuildingKey, tx: number, ty: number, rot: number, ok: boolean): void {
    if (this.ghostKey !== key) {
      this.scene.remove(this.ghost);
      this.ghost = makeBuilding(key, def, true);
      const mk = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), noOutline(new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.7, side: THREE.DoubleSide })));
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
      else if (t.type === 'rock') c = t.rock === 'wall' ? '#8f8168' : '#757570';
      else if (t.road) c = '#cbb389';
      else if (t.field) c = '#d3bd56';
      else if (t.tree) c = '#3d5c2e';
      else if (t.dep) c = t.dep.kind === 'stone' ? '#9aa0a3' : t.dep.kind === 'gold' ? '#c9a94e' : t.dep.kind === 'iron' ? '#a86a4a' : '#3d3d44';
      if (t.pickup) c = '#ffd24a';
      if (t.b) c = '#7a4a2e';
      if (t.site) c = '#d9a441';
      mmx.fillStyle = c;
      mmx.fillRect(x * MMS, y * MMS, MMS + 0.5, MMS + 0.5);
    }
    for (const u of units) {
      const selected = this.selectedUnits.has(u);
      const size = selected ? 3 : 2;
      mmx.fillStyle = selected ? '#52ff68' : '#fff';
      mmx.fillRect((u.mesh.position.x + W / 2) * MMS - size / 2, (u.mesh.position.z + H / 2) * MMS - size / 2, size, size);
    }
    const a = innerWidth / innerHeight;
    mmx.strokeStyle = 'rgba(255,255,255,.8)'; mmx.lineWidth = 1;
    mmx.strokeRect((this.camTarget.x + W / 2 - this.viewSize * a * 0.72) * MMS, (this.camTarget.z + H / 2 - this.viewSize * 0.95) * MMS, this.viewSize * a * 1.44 * MMS, this.viewSize * 1.9 * MMS);
  }

  render(): void {
    if (this.dirtyChunks.size) this.flushChunks(); // re-bake changed scenery chunks
    this.adaptQuality();
    if (this.outline) this.outline.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /** MSAA + pixelRatio 2 is expensive on 4K laptops: when frames sustain over
   *  ~20 ms, step the pixel ratio down (never below 1); step back up once
   *  frames run comfortably fast again. Re-evaluated at most every 2 s. */
  private adaptQuality(): void {
    const now = performance.now();
    if (this.qLastT) this.qFrameMs += (Math.min(100, now - this.qLastT) - this.qFrameMs) * 0.04;
    this.qLastT = now;
    if (now < this.qHoldT) return;      // re-evaluate at most every 2 s
    this.qHoldT = now + 2000;
    const pr = this.renderer.getPixelRatio();
    let next = pr;
    if (this.qFrameMs > 20 && pr > 1) next = Math.max(1, pr - 0.25);
    else if (this.qFrameMs < 12 && pr < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, pr + 0.25);
    if (next !== pr) {
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(innerWidth, innerHeight); // resize the buffer to the new ratio
    }
  }
}
