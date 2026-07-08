import * as THREE from 'three';
import { W, H } from '../constants';
import { rnd } from '../engine/rng';
import type { World } from '../world/World';
import type { Building, BuildingDef, Deco, Deposit, Tree, Unit } from '../types';
import { makeBuilding, makeDeco, makeDeposit, makeScaffold, makeTree, makeUnit } from './models';

/**
 * Owns everything Three.js: renderer, scene, orthographic camera, the ground
 * mesh, doodads, ambiance (clouds, distant hills) and the minimap. It reads the
 * World for tile data but never mutates game state.
 */
export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  readonly camTarget = new THREE.Vector3(0, 0, 2);
  viewSize = 13;

  private readonly world: World;
  private readonly CAM_OFF = new THREE.Vector3(28, 34, 28);
  private readonly groundGeo = new THREE.BufferGeometry();
  private readonly _c = new THREE.Color();
  private readonly clouds: THREE.Group[] = [];

  // placement helpers
  private ghost: THREE.Group = new THREE.Group();
  private ghostKey: string | null = null;
  private readonly roadCursor: THREE.Mesh;

  // cobbled road overlay meshes, keyed by "x,y"
  private readonly roadMeshes = new Map<string, THREE.Mesh>();
  private readonly roadGeo = new THREE.PlaneGeometry(1.0, 1.0);
  private roadMat!: THREE.MeshLambertMaterial;

  // minimap
  private readonly mm: HTMLCanvasElement;
  private readonly mmx: CanvasRenderingContext2D;
  private readonly MMS = 160 / W;

  constructor(world: World, canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // a soft pastoral daytime sky
    this.scene.background = new THREE.Color(0xbfe0ee);
    this.scene.fog = new THREE.Fog(0xcfe6f0, 70, 165);

    this.setSize();
    addEventListener('resize', () => this.setSize());

    // lighting — warm sun, cool sky fill
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xdaeeff, 0x6f8a52, 0.5));
    const sun = new THREE.DirectionalLight(0xfff0d2, 1.15);
    sun.position.set(-18, 30, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34; sun.shadow.camera.far = 100;
    this.scene.add(sun, sun.target);

    this.roadMat = new THREE.MeshLambertMaterial({ map: this.makeRoadTexture() });
    this.buildGround();
    this.populateDoodads();
    this.buildAmbiance();

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
      const r = this.mm.getBoundingClientRect();
      this.camTarget.x = ((e.clientX - r.left) / r.width) * W - W / 2;
      this.camTarget.z = ((e.clientY - r.top) / r.height) * H - H / 2;
      this.clampCam(); this.updateCamera();
    });
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
    const ndc = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.camera);
    const t = -rc.ray.origin.y / rc.ray.direction.y;
    const p = rc.ray.origin.clone().add(rc.ray.direction.clone().multiplyScalar(t));
    const tx = Math.floor(p.x + W / 2), ty = Math.floor(p.z + H / 2);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return null;
    return { x: tx, y: ty };
  }

  // =====================================================================
  //  Scene helpers
  // =====================================================================
  add(o: THREE.Object3D): void { this.scene.add(o); }
  remove(o: THREE.Object3D): void { this.scene.remove(o); }

  createBuildingMesh(def: BuildingDef): THREE.Group { return makeBuilding(def, false); }
  createScaffold(def: BuildingDef) { return makeScaffold(def); }

  createUnit(colorHex: number, role: string, tileX: number, tileY: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
    const u = makeUnit(colorHex, role);
    u.group.position.set(this.world.wx(tileX), 0, this.world.wz(tileY));
    this.scene.add(u.group);
    return u;
  }

  addTree(x: number, y: number, tree: Tree): void {
    const g = makeTree(tree.kind);
    g.position.set(this.world.wx(x) + (rnd() - 0.5) * 0.3, 0, this.world.wz(y) + (rnd() - 0.5) * 0.3);
    const s = tree.s * Math.max(0.15, tree.growth);
    g.scale.set(s, s, s);
    this.scene.add(g);
    tree.meshes = [g];
  }
  addDeposit(x: number, y: number, dep: Deposit): void {
    const g = makeDeposit(dep.kind);
    g.position.set(this.world.wx(x), 0, this.world.wz(y));
    this.scene.add(g);
    dep.meshes = [g];
  }
  addDeco(x: number, y: number, deco: Deco): void {
    const g = makeDeco(deco.kind);
    const baseY = this.world.tiles[y][x].type === 'water' ? -0.14 : 0;
    g.position.set(this.world.wx(x) + (rnd() - 0.5) * 0.3, g.position.y + baseY, this.world.wz(y) + (rnd() - 0.5) * 0.3);
    this.scene.add(g);
    deco.meshes = [g];
  }
  removeMeshes(meshes: THREE.Object3D[]): void { for (const m of meshes) this.scene.remove(m); }

  // =====================================================================
  //  Ground
  // =====================================================================
  private tileVertexBase(tx: number, ty: number) { return (ty * W + tx) * 6 * 3; }

  private lerpHex(a: number, b: number, t: number): number {
    const c1 = new THREE.Color(a), c2 = new THREE.Color(b); c1.lerp(c2, t); return c1.getHex();
  }
  private tileBaseColor(tx: number, ty: number): { hex: number; sh: number } {
    const t = this.world.tiles[ty][tx];
    if (t.type === 'water') return { hex: 0x5b93b0, sh: 0.9 + ((tx * 7 + ty * 13) % 10) / 100 };
    if (t.road) return { hex: 0xcbb389, sh: 0.96 + ((tx * 3 + ty * 5) % 8) / 100 };
    if (t.field) return { hex: this.lerpHex(0x8a6b42, 0xe0c24e, Math.min(1, t.field.growth)), sh: 1 };
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
    this.scene.add(ground);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 2, H + 2), new THREE.MeshLambertMaterial({ color: 0x4f6b3c }));
    slab.position.y = -1.06; this.scene.add(slab);
  }

  private populateDoodads(): void {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.world.tiles[y][x];
      if (t.tree) this.addTree(x, y, t.tree);
      if (t.dep) this.addDeposit(x, y, t.dep);
      if (t.deco) this.addDeco(x, y, t.deco);
    }
  }

  // =====================================================================
  //  Cobbled road overlay
  // =====================================================================
  /** A small procedural cobblestone tile, tinted warm sandy stone. */
  private makeRoadTexture(): THREE.Texture {
    const S = 128;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    // packed-earth mortar base
    ctx.fillStyle = '#a98f63'; ctx.fillRect(0, 0, S, S);
    // irregular rounded cobbles on a jittered grid
    const cell = S / 5;
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
      const cx = gx * cell + cell / 2 + (Math.random() - 0.5) * cell * 0.3;
      const cy = gy * cell + cell / 2 + (Math.random() - 0.5) * cell * 0.3;
      const r = cell * (0.32 + Math.random() * 0.12);
      const shade = 150 + Math.floor(Math.random() * 60);
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * (0.8 + Math.random() * 0.3), Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${shade + 20},${shade},${Math.floor(shade * 0.72)})`; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(90,70,45,0.55)'; ctx.stroke();
      // a soft highlight
      ctx.beginPath(); ctx.ellipse(cx - r * 0.25, cy - r * 0.25, r * 0.4, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,240,205,0.18)'; ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  addRoad(x: number, y: number): void {
    const key = x + ',' + y;
    if (this.roadMeshes.has(key)) return;
    const m = new THREE.Mesh(this.roadGeo, this.roadMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.floor(rnd() * 4) * (Math.PI / 2);   // rotate for variety
    m.position.set(this.world.wx(x), 0.02, this.world.wz(y));
    m.receiveShadow = true;
    this.scene.add(m);
    this.roadMeshes.set(key, m);
  }
  removeRoad(x: number, y: number): void {
    const key = x + ',' + y;
    const m = this.roadMeshes.get(key);
    if (m) { this.scene.remove(m); this.roadMeshes.delete(key); }
  }

  // =====================================================================
  //  Ambiance — distant hills + drifting clouds
  // =====================================================================
  private buildAmbiance(): void {
    // hazy hills ringing the meadow (evokes the wooded ridges around Het Gooi)
    const hillMat = new THREE.MeshLambertMaterial({ color: 0x86a679 });
    const hillMat2 = new THREE.MeshLambertMaterial({ color: 0x6f9a86 });
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2;
      const rad = W * 0.72 + rnd() * 6;
      const h = 3 + rnd() * 6;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(4 + rnd() * 4, h, 5), i % 2 ? hillMat2 : hillMat);
      cone.position.set(Math.cos(ang) * rad, h / 2 - 1.2, Math.sin(ang) * rad);
      cone.rotation.y = rnd() * Math.PI;
      this.scene.add(cone);
    }
    // soft clouds
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
      c.position.set((rnd() - 0.5) * W * 1.4, 14 + rnd() * 6, (rnd() - 0.5) * H * 1.4);
      this.scene.add(c);
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
      if (c.position.x > W * 0.8) c.position.x = -W * 0.8;
    }
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

  showRoadCursor(tx: number, ty: number, kind: 'road' | 'demolish'): void {
    this.roadCursor.visible = true;
    this.roadCursor.position.x = this.world.wx(tx); this.roadCursor.position.z = this.world.wz(ty);
    const t = this.world.T(tx, ty);
    const m = this.roadCursor.material as THREE.MeshBasicMaterial;
    if (kind === 'demolish') m.color.setHex((t && (t.road || t.b || t.site)) ? 0xcc3322 : 0x777777);
    else {
      const canRoad = !!(t && t.type === 'grass' && !t.b && !t.site && !t.road && !t.field && !t.dep);
      m.color.setHex(canRoad ? 0xd9a441 : 0xcc3322);
    }
  }
  hideRoadCursor(): void { this.roadCursor.visible = false; }

  // =====================================================================
  //  Minimap & render
  // =====================================================================
  drawMinimap(units: Unit[]): void {
    const mmx = this.mmx, MMS = this.MMS;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.world.tiles[y][x];
      let c = '#6fae52';
      if (t.type === 'water') c = '#5b93b0';
      else if (t.road) c = '#cbb389';
      else if (t.field) c = '#d3bd56';
      else if (t.tree) c = '#3d5c2e';
      else if (t.dep) c = t.dep.kind === 'stone' ? '#9aa0a3' : t.dep.kind === 'gold' ? '#c9a94e' : '#3d3d44';
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
