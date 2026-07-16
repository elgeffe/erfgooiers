import * as THREE from 'three';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { uiRng } from '../engine/rng';
import { GRAPHICS } from '../constants';
import type { World } from '../world/World';
import type { Building, BuildingDef, BuildingKey, Coord, Faction, Field, Pickup, Tree, Unit } from '../types';
import { circle, cone, makeArrow, makeBuilding, makeUnitCorpse, makeFireball, makeFlag, makeFlame, makeHero, makeRock, makePlotMarker, makeScaffold, makeTraderCaravan, makeUnit, noOutline, setActiveBiome, stdMat } from './models';
import { Ambience } from './Ambience';
import { TerrainRenderer } from './TerrainRenderer';

// Cosmetic scatter only — must not touch worldgen/gameplay streams.
const rnd = () => uiRng.next();

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
  private readonly CAM_OFF = new THREE.Vector3(28, 34, 28);
  private readonly terrain: TerrainRenderer;
  private readonly ambience: Ambience;

  // placement helpers
  private ghost: THREE.Group = new THREE.Group();
  private ghostKey: string | null = null;
  private readonly roadCursor: THREE.Mesh;
  private demoTarget!: THREE.Group;

  // green markers over building/site entrance tiles, shown while painting roads
  private readonly entranceMarkers: THREE.Mesh[] = [];
  private readonly entranceGeo = new THREE.PlaneGeometry(0.9, 0.9);
  private readonly entranceMat = noOutline(new THREE.MeshBasicMaterial({ color: 0x46c256, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));

  // the sun follows the camera so its shadow map only covers what's visible
  private sun!: THREE.DirectionalLight;

  // adaptive quality: drop pixelRatio when frames run long, restore when quick
  private readonly maxPixelRatio = Math.min(devicePixelRatio, 2);
  private qFrameMs = 16;
  private qLastT = 0;
  private qHoldT = 0;

  // right-drag formation draft: pooled tile discs + a facing chevron
  private formPreview: THREE.Group | null = null;
  private formPreviewMarks: THREE.Mesh[] = [];
  private formPreviewArrow: THREE.Group | null = null;

  // short-lived flags marking where the player just ordered units to go
  private readonly orderPings: { mesh: THREE.Group; life: number; max: number; mats: THREE.Material[] }[] = [];

  // minimap
  private readonly mm: HTMLCanvasElement;
  private readonly mmx: CanvasRenderingContext2D;

  // ---------- gore layer (cosmetic; bodies linger, then fade) ----------
  private readonly goreGroup = new THREE.Group();
  private readonly goreBodies: { obj: THREE.Mesh; age: number; mat: THREE.Material }[] = [];
  private MAX_BODIES = 2000;            // settings' performance cap can move both…
  private CORPSE_LIFE = 300;            // …seconds a body lies before it starts fading
  private readonly CORPSE_FADE = 20;    // seconds to fade out once its time is up

  /** Settings hook: cap battlefield bodies and how long they linger. */
  setGorePrefs(maxBodies: number, lifeSeconds: number): void {
    this.MAX_BODIES = maxBodies;
    this.CORPSE_LIFE = lifeSeconds;
    while (this.goreBodies.length > this.MAX_BODIES) this.cullBody(this.goreBodies.shift()!);
  }

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

    this.terrain = new TerrainRenderer(
      () => this.world,
      () => this.worldGroup,
      (root, includeRoot) => this.freeze(root, includeRoot),
    );
    this.ambience = new Ambience(
      this.scene,
      () => this.world,
      () => this.worldGroup,
      (root, includeRoot) => this.freeze(root, includeRoot),
    );

    this.scene.add(this.worldGroup);

    // road-tile cursor
    this.roadCursor = new THREE.Mesh(
      new THREE.PlaneGeometry(0.96, 0.96),
      noOutline(new THREE.MeshBasicMaterial({ color: 0xb9a179, transparent: true, opacity: 0.75, side: THREE.DoubleSide })),
    );
    this.roadCursor.rotation.x = -Math.PI / 2; this.roadCursor.position.y = 0.03; this.roadCursor.visible = false;
    this.scene.add(this.roadCursor);
    // demolish-target marker: a red frame + tint over a doomed building's 2×2
    this.demoTarget = new THREE.Group();
    const demoFill = new THREE.Mesh(
      new THREE.PlaneGeometry(2.15, 2.15),
      noOutline(new THREE.MeshBasicMaterial({ color: 0xcc3322, transparent: true, opacity: 0.28, side: THREE.DoubleSide })),
    );
    demoFill.rotation.x = -Math.PI / 2;
    this.demoTarget.add(demoFill);
    const demoRing = new THREE.Mesh(
      new THREE.RingGeometry(1.32, 1.52, 4),
      noOutline(new THREE.MeshBasicMaterial({ color: 0xdd2211, transparent: true, opacity: 0.9, side: THREE.DoubleSide })),
    );
    demoRing.rotation.x = -Math.PI / 2; demoRing.rotation.z = Math.PI / 4; demoRing.position.y = 0.012;
    this.demoTarget.add(demoRing);
    this.demoTarget.position.y = 0.05; this.demoTarget.visible = false;
    this.scene.add(this.demoTarget);
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
    setActiveBiome(world.biome);   // foliage palette, snowlines, flora variants
    this.fitShadowToMap();
    this.terrain.loadWorld();
    this.ambience.loadWorld();
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

    this.terrain.clear();
    this.ambience.clear();
    for (const p of this.orderPings) this.worldGroup.remove(p.mesh);
    this.orderPings.length = 0;
    this.formPreview = null;           // its meshes died with the worldGroup
    this.formPreviewMarks.length = 0;
    this.formPreviewArrow = null;
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
    this.viewSize = Math.max(6, Math.min(this.maxViewSize, this.viewSize * factor));
    this.updateCamera();
  }

  /** Ceiling on zoom-out; the settings' extended-zoom toggle raises it. */
  private maxViewSize = 28;
  setExtendedZoom(on: boolean): void {
    this.maxViewSize = on ? 46 : 28;
    if (this.viewSize > this.maxViewSize) { this.viewSize = this.maxViewSize; this.updateCamera(); }
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

  createBuildingMesh(key: BuildingKey, def: BuildingDef, playerColor?: number): THREE.Group { return makeBuilding(key, def, false, playerColor); }
  createScaffold(key: BuildingKey, def: BuildingDef, playerColor?: number) { return makeScaffold(key, def, playerColor); }

  createUnit(colorHex: number, role: string, tileX: number, tileY: number, faction: Faction = 'player', teamHex?: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
    const u = makeUnit(colorHex, role, faction, teamHex);
    u.group.position.set(this.world.wx(tileX), 0, this.world.wz(tileY));
    this.worldGroup.add(u.group);
    this.freeze(u.group, false); // the unit walks; its body parts are rigid
    return u;
  }

  /** The run's mounted hero — same contract as createUnit, styled per hero id. */
  createHero(heroId: string, tileX: number, tileY: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
    const u = makeHero(heroId);
    u.group.position.set(this.world.wx(tileX), 0, this.world.wz(tileY));
    this.worldGroup.add(u.group);
    this.freeze(u.group, false);
    return u;
  }

  /** Combat effect meshes, owned & positioned by the sim (removed via `remove`). */
  createArrow(): THREE.Group { const m = makeArrow(); this.worldGroup.add(m); return m; }
  createRock(): THREE.Group { const m = makeRock(); this.worldGroup.add(m); return m; }
  createFireball(): THREE.Group { const m = makeFireball(); this.worldGroup.add(m); return m; }
  createFlame(): THREE.Group { const m = makeFlame(); this.worldGroup.add(m); return m; }
  createFlag(pennantHex?: number): THREE.Group { const m = makeFlag(pennantHex); this.worldGroup.add(m); return m; }
  createTraderCaravan(): THREE.Group { const m = makeTraderCaravan(); this.worldGroup.add(m); this.freeze(m, false); return m; }
  /** Marker parented onto a building mesh (not the world) so it follows it. */
  createPlotMarker(): THREE.Group { return makePlotMarker(); }

  /** Plant a short-lived flag for a unit order. Focus-fire uses red; movement
   *  uses blue. Both fade in and out without touching shared scene materials. */
  /** Draft positioning: ghost discs on every tile the formation would take,
   *  plus a chevron showing which way the ranks face. Meshes are pooled and
   *  reused across drags; the whole group hides when the drag ends. */
  showFormationPreview(spots: Coord[], fx: number, fz: number): void {
    if (!this.formPreview) {
      this.formPreview = new THREE.Group();
      this.formPreview.userData.dynamic = true;
      this.worldGroup.add(this.formPreview);
      const arrow = new THREE.Group();
      const head = new THREE.Mesh(cone(0.34, 0.8, 4), stdMat({ color: 0xffd24a, transparent: true, opacity: 0.85 }, false));
      head.rotation.x = Math.PI / 2;   // apex forward along the group's +z
      head.position.y = 0.1;
      arrow.add(head);
      this.formPreview.add(arrow);
      this.formPreviewArrow = arrow;
    }
    this.formPreview.visible = true;
    const discMat = stdMat({ color: 0xffd24a, transparent: true, opacity: 0.4 }, false);
    const n = Math.min(spots.length, 600); // pool cap — plenty to read the shape
    while (this.formPreviewMarks.length < n) {
      const m = new THREE.Mesh(circle(0.3, 10), discMat);
      m.rotation.x = -Math.PI / 2;
      this.formPreview.add(m);
      this.formPreviewMarks.push(m);
    }
    let cx = 0, cz = 0;
    for (let i = 0; i < this.formPreviewMarks.length; i++) {
      const m = this.formPreviewMarks[i];
      m.visible = i < n;
      if (i >= n) continue;
      const wx = this.world.wx(spots[i].x), wz = this.world.wz(spots[i].y);
      m.position.set(wx, 0.06, wz);
      cx += wx; cz += wz;
    }
    if (this.formPreviewArrow && n) {
      const len = Math.hypot(fx, fz) || 1;
      const ux = fx / len, uz = fz / len;
      this.formPreviewArrow.position.set(cx / n + ux * 1.6, 0, cz / n + uz * 1.6);
      this.formPreviewArrow.rotation.y = Math.atan2(ux, uz);
    }
  }

  hideFormationPreview(): void {
    if (this.formPreview) this.formPreview.visible = false;
  }

  showOrderMarker(wx: number, wz: number, attack = false): void {
    const m = makeFlag(attack ? 0xc83232 : 0x3f5aa0, true);
    m.userData.dynamic = true;
    m.position.set(wx, 0, wz);
    this.worldGroup.add(m);
    this.freeze(m, false);
    const mats: THREE.Material[] = [];
    m.traverse(o => { const x = o as THREE.Mesh; if (x.material && !Array.isArray(x.material)) mats.push(x.material); });
    this.orderPings.push({ mesh: m, life: 1.6, max: 1.6, mats });
  }

  private updateOrderPings(dt: number): void {
    for (let i = this.orderPings.length - 1; i >= 0; i--) {
      const p = this.orderPings[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.worldGroup.remove(p.mesh);
        for (const m of p.mats) m.dispose();
        this.orderPings.splice(i, 1);
        continue;
      }
      const age = p.max - p.life;
      const alpha = Math.min(1, age / 0.18, p.life / 0.38);
      for (const m of p.mats) m.opacity = alpha;
      p.mesh.scale.setScalar(0.9 + Math.min(0.1, age * 0.6));
    }
  }

  addTree(x: number, y: number, tree: Tree): void { this.terrain.addTree(x, y, tree); }
  treeMatured(x: number, y: number, tree: Tree): void { this.terrain.treeMatured(x, y, tree); }
  addPickup(x: number, y: number, pickup: Pickup): void { this.terrain.addPickup(x, y, pickup); }
  addFieldCrop(x: number, y: number, field: Field): void { this.terrain.addFieldCrop(x, y, field); }
  scaleFieldCrop(field: Field): void { this.terrain.scaleFieldCrop(field); }
  removeMeshes(meshes: THREE.Object3D[]): void { this.terrain.removeMeshes(meshes); }
  refreshTile(tx: number, ty: number): void { this.terrain.refreshTile(tx, ty); }
  dirtyTile(x: number, y: number): void { this.terrain.dirtyTile(x, y); }
  addRoad(x: number, y: number): void { this.terrain.addRoad(x, y); }
  removeRoad(x: number, y: number): void { this.terrain.removeRoad(x, y); }
  /** Real-time animation independent of sim speed. */
  animate(dt: number, buildings: Building[]): void {
    this.ambience.animate(dt, buildings);
    this.updateOrderPings(dt);
    this.ageGore(dt);
  }
  // =====================================================================
  //  Placement ghost & road cursor
  // =====================================================================
  showGhost(def: BuildingDef, key: BuildingKey, tx: number, ty: number, rot: number, ok: boolean): void {
    if (this.ghostKey !== key) {
      this.scene.remove(this.ghost);
      this.ghost = makeBuilding(key, def, true);
      const offsets = def.entrance === 'none' ? [] : def.entrance === 'through'
        ? [[-0.5, -1.5], [0.5, -1.5], [-0.5, 1.5], [0.5, 1.5]] : [[-0.5, 1.5]];
      for (const [x, z] of offsets) {
        const mk = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), noOutline(new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.7, side: THREE.DoubleSide })));
        mk.rotation.x = -Math.PI / 2; mk.position.set(x, 0.04, z); mk.userData.marker = true;
        this.ghost.add(mk);
      }
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

  /** Frame a 2×2 building/site footprint in red while demolish hovers it. */
  showDemolishTarget(tx: number, ty: number): void {
    this.demoTarget.visible = true;
    this.demoTarget.position.x = this.world.wx(tx) + 0.5;
    this.demoTarget.position.z = this.world.wz(ty) + 0.5;
  }
  hideDemolishTarget(): void { this.demoTarget.visible = false; }

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
    // ground, water and woodland take the biome's own colours (snow, lava, ash)
    const pal = this.world.biome.palette;
    const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
    const cGrass = hex(pal.grassA), cWater = hex(pal.water), cTree = hex(pal.folGreens[0]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.world.tiles[y][x];
      let c = cGrass;
      if (t.type === 'water') c = cWater;
      else if (t.type === 'rock') c = t.rock === 'wall' ? '#8f8168' : '#757570';
      else if (t.road) c = '#cbb389';
      else if (t.field) c = '#d3bd56';
      else if (t.tree) c = cTree;
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
    this.terrain.flush(); // re-bake changed scenery chunks
    this.adaptQuality();
    if (this.outline) this.outline.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /** MSAA + pixelRatio 2 is expensive on 4K laptops: when frames sustain over
   *  ~20 ms, step the pixel ratio down (never below 1); step back up once
   *  frames run comfortably fast again. Re-evaluated at most every 2 s. */
  /** Settings: pin the pixel ratio high or low, or let adaptQuality steer it. */
  setQualityMode(mode: 'auto' | 'high' | 'low'): void {
    this.qualityMode = mode;
    if (mode === 'auto') return; // adaptQuality resumes from wherever it stands
    const pr = mode === 'high' ? this.maxPixelRatio : 1;
    if (this.renderer.getPixelRatio() !== pr) {
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(innerWidth, innerHeight);
    }
  }
  private qualityMode: 'auto' | 'high' | 'low' = 'auto';

  private adaptQuality(): void {
    if (this.qualityMode !== 'auto') return; // pinned from the settings screen
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
