import * as THREE from 'three';
import { uiRng } from '../engine/rng';
import type { World } from '../world/World';
import type { Building } from '../types';
import { box, circle, cone, cyl, makeCritter, makeFish, makeMountain, makePig, makeSkyBird, sphere, stdMat, type CritterKind } from './models';

const rnd = () => uiRng.next();

interface Pig { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; big: boolean; }
interface SwimFish { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; speed: number; }
interface Critter { mesh: THREE.Group; x: number; z: number; tx: number; tz: number; wait: number; speed: number; hops: boolean; hop: number; shore: boolean; pond: boolean; }
interface SkyBird { mesh: THREE.Group; wings: THREE.Group[]; vx: number; vz: number; phase: number; }

/** Owns all per-level background scenery and real-time ambient life. */
export class Ambience {
  private skyTex: THREE.Texture | null = null;
  private readonly clouds: THREE.Group[] = [];
  private readonly millSails: THREE.Object3D[] = [];
  private readonly beacons: THREE.Object3D[] = [];
  private cloudBound = 40;
  private readonly pigHerds = new Map<Building, Pig[]>();
  private readonly fish: SwimFish[] = [];
  private lakeTiles: { x: number; y: number }[] = [];
  private readonly critters: Critter[] = [];
  private readonly skyBirds: SkyBird[] = [];
  private nextBirdT = 0;
  private whale: THREE.Group | null = null;
  private markerT = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly getWorld: () => World,
    private readonly getWorldGroup: () => THREE.Group,
    private readonly freezeObject: (root: THREE.Object3D, includeRoot?: boolean) => void,
  ) {}

  private get world(): World { return this.getWorld(); }
  private get worldGroup(): THREE.Group { return this.getWorldGroup(); }
  private freeze(root: THREE.Object3D, includeRoot = true): void { this.freezeObject(root, includeRoot); }

  loadWorld(): void {
    this.buildAmbiance();
    this.spawnFish();
    this.spawnCritters();
    this.nextBirdT = 6 + rnd() * 14;
  }

  clear(): void {
    if (this.skyTex) { this.skyTex.dispose(); this.skyTex = null; }
    this.scene.background = null;
    this.scene.fog = null;
    this.clouds.length = 0;
    this.pigHerds.clear();
    this.fish.length = 0;
    this.critters.length = 0;
    this.skyBirds.length = 0;
    this.nextBirdT = 0;
    this.lakeTiles = [];
    this.millSails.length = 0;
    this.beacons.length = 0;
    this.whale = null;
  }

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
    for (const b of this.beacons) b.rotation.y += dt * 0.7;
    this.updateWhale(dt);
    this.updatePigs(dt, buildings);
    this.updateFish(dt);
    this.updateCritters(dt);
    this.updateSkyBirds(dt);
  }
  private buildAmbiance(): void {
    const W = this.world.W, H = this.world.H;
    const biome = this.world.biome;
    const pal = biome.palette;
    // Painted sky: richer vertical colour, warm sun haze and a few extremely
    // faint high-altitude streaks. This is a screen backdrop, not a cloud count.
    const sky = document.createElement('canvas'); sky.width = 512; sky.height = 512;
    const sctx = sky.getContext('2d')!;
    const grad = sctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, pal.sky[0]);
    grad.addColorStop(0.42, pal.sky[1]);
    grad.addColorStop(0.72, pal.sky[2]);
    grad.addColorStop(1, pal.sky[3]);
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
    this.scene.fog = new THREE.Fog(pal.fog, 70, 165);

    // a broad meadow plain reaching out to the horizon beneath the map plinth
    const plain = new THREE.Mesh(new THREE.CircleGeometry(240, 96), stdMat({ color: pal.plain }, false));
    plain.rotation.x = -Math.PI / 2; plain.position.y = -2.1;
    this.worldGroup.add(plain);
    this.freeze(plain);

    // The board reaches its corners at `boardR`; keep every background element
    // beyond boardR + GAP so scenery never sits on top of the play area. Each
    // element's own radius is added in, so its *inner* edge clears the gap.
    const boardR = Math.hypot(W / 2, H / 2);
    const GAP = 12;

    // The open sea on the horizon. On single-coast maps the sea half of the
    // horizon follows the in-map coastline's direction; island maps are ringed
    // by it (their palette already paints the whole plain as water).
    const seaAmb = biome.ambiance.sea;
    const coastAng = this.world.coastDir
      ? Math.atan2(this.world.coastDir.y, this.world.coastDir.x)
      : rnd() * Math.PI * 2;
    // is a horizon angle on the open-sea side (skip land scenery there)?
    const seaward = (ang: number): boolean =>
      seaAmb === 'all' || (seaAmb === 'coast' && Math.cos(ang - coastAng) > 0.25);
    if (seaAmb === 'coast') {
      // CircleGeometry lives in XY; after the -90° X-rotation a vertex at angle
      // θ lands at world angle -θ, hence the negated start angle.
      const half = new THREE.Mesh(
        new THREE.CircleGeometry(240, 64, -coastAng - Math.PI / 2, Math.PI),
        stdMat({ color: 0x4a7898 }, false));
      half.rotation.x = -Math.PI / 2; half.position.y = -2.07;
      this.worldGroup.add(half); this.freeze(half);
    }
    if (seaAmb) {
      // a few sailboats out on the water
      const hullM = stdMat({ color: 0x6b4a33 }), sailM = stdMat({ color: 0xf0ead8 });
      for (let i = 0, n = 3 + Math.floor(rnd() * 2); i < n; i++) {
        const ang = seaAmb === 'all' ? rnd() * Math.PI * 2 : coastAng + (rnd() - 0.5) * 1.4;
        const rad = boardR + GAP + 14 + rnd() * 30;
        const boat = new THREE.Group();
        const hull = new THREE.Mesh(box(1.5, 0.3, 0.55), hullM); hull.position.y = 0.15; boat.add(hull);
        const mast = new THREE.Mesh(cyl(0.03, 0.03, 1.6, 4), hullM); mast.position.y = 1.0; boat.add(mast);
        const sail = new THREE.Mesh(cone(0.55, 1.3, 3), sailM); sail.scale.z = 0.12; sail.position.set(0.12, 1.05, 0); boat.add(sail);
        boat.position.set(Math.cos(ang) * rad, -2.06, Math.sin(ang) * rad);
        boat.rotation.y = rnd() * Math.PI * 2;
        this.worldGroup.add(boat); this.freeze(boat);
      }
    }

    // Keep the near horizon as an uninterrupted plain. Earlier builds placed
    // large rectangular "field strips" and hedge bars here; from the game
    // camera they read as unexplained floating panels rather than farmland.
    if (!seaAmb) {
      const waterMat = stdMat({ color: 0x72a9bd, transparent: true, opacity: 0.75 }, false);
      for (let i = 0; i < 3; i++) {
        const ang = rnd() * Math.PI * 2, rad = boardR + GAP + 15 + rnd() * 25;
        const water = new THREE.Mesh(circle(1, 24), waterMat); water.rotation.x = -Math.PI / 2;
        water.scale.set(3 + rnd() * 4, 1.2 + rnd() * 2.2, 1); water.position.set(Math.cos(ang) * rad, -2.01, Math.sin(ang) * rad);
        this.worldGroup.add(water); this.freeze(water);
      }
    }

    // A belt of sandy marram dunes between the land and the open sea.
    if (biome.ambiance.dunes) {
      const sand = [0xdccf9e, 0xd0c28f, 0xc2b482].map(c => stdMat({ color: c }));
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2 + rnd() * 0.5;
        if (seaAmb === 'coast' && Math.cos(ang - coastAng) < 0.1) continue; // dunes line the shore
        const r = 6 + rnd() * 6;
        const rad = boardR + GAP + r + rnd() * 5;
        const dune = new THREE.Mesh(sphere(1, 18, 10), sand[i % 3]);
        dune.scale.set(r, 1.6 + rnd() * 1.6, r * (0.6 + rnd() * 0.4));
        dune.rotation.y = ang + Math.PI / 2 + (rnd() - 0.5) * 0.5;
        dune.position.set(Math.cos(ang) * rad, -2.1, Math.sin(ang) * rad);
        this.worldGroup.add(dune); this.freeze(dune);
      }
    }

    // The Ardennes rolls: an extra ring of big, close grassy domes right past
    // the gap so the board reads as a clearing between hills.
    if (biome.ambiance.hillBumps) {
      const nearTones = pal.hillTones.map(c => stdMat({ color: c }));
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9) * Math.PI * 2 + rnd() * 0.6;
        const r = 12 + rnd() * 9;
        const rad = boardR + GAP + r + rnd() * 6;
        const h = 4 + rnd() * 4;
        const dome = new THREE.Mesh(sphere(1, 20, 12), nearTones[i % nearTones.length]);
        dome.scale.set(r, h, r * (0.8 + rnd() * 0.4));
        dome.position.set(Math.cos(ang) * rad, -2.1, Math.sin(ang) * rad);
        this.worldGroup.add(dome); this.freeze(dome);
      }
    }

    // The Alps loom: a ring of great snowbound massifs on the horizon in
    // place of soft farmland hills.
    if (biome.ambiance.peakRing) {
      for (let i = 0; i < 15; i++) {
        const ang = (i / 15) * Math.PI * 2 + rnd() * 0.35;
        const sc = 7 + rnd() * 7;
        const rad = boardR + GAP + sc + 14 + rnd() * 26;
        const massif = makeMountain();
        massif.scale.setScalar(sc);
        massif.position.set(Math.cos(ang) * rad, -2.1, Math.sin(ang) * rad);
        massif.rotation.y = rnd() * Math.PI * 2;
        this.worldGroup.add(massif); this.freeze(massif);
      }
    }

    // low rolling hill domes in three hazier and hazier rings. On an island
    // they stay: sandy-toned and out in the water, they read as neighbouring
    // isles. A single coast keeps its open-sea half properly empty.
    const hillTones = pal.hillTones.map(c => stdMat({ color: c }));
    for (let ring = 0; ring < 3; ring++) {
      const count = 12 + ring * 5;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + rnd() * 0.5;
        if (seaAmb === 'coast' && seaward(ang)) continue;
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
    // the Black Forest closes in: a far denser, near-solid ring of dark pines
    // (island boards get none at all — past the beach the plain IS the sea,
    // and a treeline there reads as trees standing in the water)
    const ringCount = biome.ambiance.forestRing ? 260 : seaAmb === 'all' ? 0 : 90;
    for (let i = 0; i < ringCount; i++) {
      const ang = rnd() * Math.PI * 2;
      if (seaAmb === 'coast' && seaward(ang)) continue;
      const s = (0.9 + rnd() * 1.4) * (biome.ambiance.forestRing ? 1.25 : 1);
      const rad = boardR + 5 + rnd() * (biome.ambiance.forestRing ? GAP + 16 : GAP - 4);
      const deciduous = !biome.ambiance.forestRing && rnd() < 0.42;
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
    // a pale lane, all well outside the playable edge. Wilder biomes skip it.
    if (biome.ambiance.village) {
    // coastal villages keep to the landward side of the horizon
    const villageAng = seaAmb ? coastAng + Math.PI + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2;
    const villageRad = boardR + 31;
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
    }

    // one far-off windmill turning on the plain — a little postcard of Het
    // Gooi. Pinned to the map's north (up-screen from the iso camera, world
    // (-1,-1)) so it's actually in view instead of hiding behind the camera.
    if (biome.ambiance.windmill) {
    const millAng = seaAmb ? coastAng + Math.PI + (rnd() - 0.5) * 0.9
      : -Math.PI * 3 / 4 + (rnd() - 0.5) * 0.5;
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
    }

    // A red-banded lighthouse (Texel's Eierland, more or less) stands among
    // the dunes, its twin beam sweeping the horizon in real time.
    if (biome.ambiance.lighthouse) {
      const lhAng = seaAmb === 'coast' ? coastAng + (rnd() - 0.5) * 0.6
        : -Math.PI * 3 / 4 + (rnd() - 0.5) * 0.8; // island: pinned up-screen like the mill
      const lh = new THREE.Group();
      const bands = [0xc23a2e, 0xf0ece0, 0xc23a2e, 0xf0ece0, 0xc23a2e];
      for (let i = 0; i < 5; i++) {
        const seg = new THREE.Mesh(cyl(0.62 - i * 0.06, 0.68 - i * 0.06, 1.05, 10), stdMat({ color: bands[i] }));
        seg.position.y = 0.55 + i * 1.02; lh.add(seg);
      }
      const gallery = new THREE.Mesh(cyl(0.55, 0.55, 0.12, 10), stdMat({ color: 0x3a3a3a })); gallery.position.y = 5.62; lh.add(gallery);
      const lampRoom = new THREE.Mesh(cyl(0.34, 0.38, 0.55, 8), stdMat({ color: 0x2e2e2e })); lampRoom.position.y = 5.95; lh.add(lampRoom);
      const lamp = new THREE.Mesh(sphere(0.2, 8, 6), stdMat({ color: 0xffe9a3 })); lamp.position.y = 5.95; lh.add(lamp);
      const cap = new THREE.Mesh(cone(0.45, 0.5, 8), stdMat({ color: 0xc23a2e })); cap.position.y = 6.42; lh.add(cap);
      const beam = new THREE.Group();
      beam.userData.dynamic = true; // sweeps every frame
      beam.position.y = 5.95;
      const rayM = stdMat({ color: 0xfff3c0, transparent: true, opacity: 0.3 }, false);
      for (const s of [1, -1]) {
        const ray = new THREE.Mesh(cone(0.5, 7, 6), rayM);
        ray.rotation.z = s * Math.PI / 2; // apex at the lamp, base flaring outward
        ray.position.x = s * 3.5;
        beam.add(ray);
      }
      lh.add(beam);
      lh.position.set(Math.cos(lhAng) * (boardR + 18), -2.1, Math.sin(lhAng) * (boardR + 18));
      this.worldGroup.add(lh); this.freeze(lh);
      this.beacons.push(beam);
    }

    // A great whale cruises the horizon sea in a slow circle, its back arching
    // out of the water and sliding under again (real-time, like the beacons).
    if (biome.ambiance.whale && seaAmb) {
      const w = new THREE.Group();
      const bodyM = stdMat({ color: 0x46525e }), bellyM = stdMat({ color: 0x9fb3bd });
      const body = new THREE.Mesh(sphere(1, 16, 10), bodyM);
      body.scale.set(1.35, 1.2, 3.4); w.add(body);                 // nose along +z
      const belly = new THREE.Mesh(sphere(1, 14, 9), bellyM);
      belly.scale.set(1.2, 1.0, 3.1); belly.position.y = -0.3; w.add(belly);
      const fin = new THREE.Mesh(cone(0.5, 1.0, 5), bodyM);
      fin.position.set(0, 1.25, -0.5); w.add(fin);
      for (const s of [1, -1]) {                                   // tail flukes
        const fl = new THREE.Mesh(sphere(1, 10, 7), bodyM);
        fl.scale.set(1.0, 0.18, 0.6); fl.position.set(s * 0.6, 0.3, -3.3);
        fl.rotation.y = s * 0.6; w.add(fl);
      }
      w.userData = { ang: rnd() * Math.PI * 2, rad: boardR + GAP + 22 + rnd() * 14, t: rnd() * 20 };
      this.worldGroup.add(w);
      this.whale = w;
    }

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

  private updateWhale(dt: number): void {
    const w = this.whale;
    if (!w) return;
    const u = w.userData as { ang: number; rad: number; t: number };
    u.ang += dt * 0.045;
    u.t += dt;
    const cycle = Math.sin(u.t * 0.35);          // >0 back above the surf, <0 diving
    const x = Math.cos(u.ang) * u.rad, z = Math.sin(u.ang) * u.rad;
    w.position.set(x, -3.4 + cycle * 1.6, z);
    // nose (+z) points along the direction of travel
    w.lookAt(Math.cos(u.ang + 0.02) * u.rad, w.position.y, Math.sin(u.ang + 0.02) * u.rad);
    w.rotateX(Math.cos(u.t * 0.35) * 0.3);       // pitch up surfacing, down diving
  }

  /** Scatter cute fish across the lake's water tiles (not the small ponds). */
  private spawnFish(): void {
    if (this.world.biome.gen.scorched) return; // nothing swims in lava
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
        speed: kind === 'fox' ? 0.9 : kind === 'mouse' ? 0.75 : kind === 'hedgehog' ? 0.22 : kind === 'frog' ? 0.35
          : kind === 'deer' ? 0.85 : kind === 'squirrel' ? 0.8 : kind === 'marmot' ? 0.3 : kind === 'ibex' ? 0.6
          : kind === 'sheep' ? 0.25 : kind === 'gull' ? 0.5 : kind === 'heron' ? 0.35 : kind === 'seal' ? 0.12 : 0.5,
        hops, hop: 0,
        shore: kind === 'duck' || kind === 'frog' || kind === 'gull' || kind === 'heron' || kind === 'seal',
        pond: kind === 'frog',
      });
    };

    // village cats & pond frogs belong to settled biomes only (their pool says so)
    const pool = [...this.world.biome.critters];
    if (pool.includes('cat')) {
      spawn('cat', this.critterGrassSpot());
      if (rnd() < 0.3) spawn('cat', this.critterGrassSpot());
    }
    const extra = 2 + (rnd() < 0.45 ? 1 : 0);
    for (let i = 0; i < extra && pool.length; i++) {
      const kind = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      if (kind === 'cat' || kind === 'frog') continue; // handled above/below
      const coastal = kind === 'duck' || kind === 'gull' || kind === 'heron' || kind === 'seal';
      spawn(kind, coastal ? this.critterShoreSpot() : this.critterGrassSpot());
      // herd animals show up in pairs
      if ((kind === 'deer' || kind === 'ibex' || kind === 'rabbit') && rnd() < 0.6) spawn(kind, this.critterGrassSpot());
      // sheep graze in small flocks, gulls squabble in pairs
      if (kind === 'sheep') for (let s = 0; s < 2 + (rnd() < 0.5 ? 1 : 0); s++) spawn('sheep', this.critterGrassSpot());
      if (kind === 'gull' && rnd() < 0.7) spawn('gull', this.critterShoreSpot());
    }
    if (this.world.biome.critters.includes('frog')) spawn('frog', this.critterPondSpot());
  }

  private critterGrassSpot(): { x: number; y: number } | null {
    for (let i = 0; i < 40; i++) {
      const x = 2 + Math.floor(uiRng.next() * (this.world.W - 4)), y = 2 + Math.floor(uiRng.next() * (this.world.H - 4));
      const t = this.world.tiles[y][x];
      if (t.type === 'grass' && !t.b && !t.site && !t.tree && !t.dep && this.critterClearOfTown(x, y)) return { x, y };
    }
    return null;
  }

  /** Ambient animals never begin or wander through the castle's town apron.
   *  Frontier maps move that castle into a corner, so map-centre checks are
   *  not a valid proxy for settlement distance. */
  private critterClearOfTown(x: number, y: number): boolean {
    const sx = this.world.playerStart.x + 1, sy = this.world.playerStart.y + 1;
    return Math.hypot(x - sx, y - sy) >= 12;
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
      if (t.type !== 'grass' || t.b || t.site || t.tree || t.dep || !this.critterClearOfTown(x, y)) continue;
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
            if (!t || t.type !== 'grass' || t.b || t.site || t.tree || t.dep || !this.critterClearOfTown(nx, ny)) continue;
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

  /** Occasionally send a lone bird, flock, or rare eagle across the board.
   *  In the high Alps the eagle is the rule, not the exception. */
  private spawnSkyBirds(): void {
    const roll = rnd(), eagle = roll > (this.world.biome.ambiance.peakRing ? 0.45 : 0.9);
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
}
