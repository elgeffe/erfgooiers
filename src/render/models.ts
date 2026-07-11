import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { uiRng } from '../engine/rng';
import { GRAPHICS } from '../constants';
import type { BuildingDef, BuildingKey, DecoKind } from '../types';

// Mesh scatter is purely cosmetic — it must never touch gameplay/worldgen streams.
// It normally draws from uiRng, but chunk-baked doodads swap in a per-tile
// seeded stream (withSeededScatter) so a rebuilt chunk looks identical.
let activeRnd: () => number = () => uiRng.next();
const rnd = () => activeRnd();

/**
 * Run a builder with a deterministic local RNG in place of the uiRng stream.
 * Chunk-merged scenery is re-baked whenever a tile changes; seeding the
 * cosmetic scatter from the tile keeps every *other* doodad in the chunk
 * pixel-identical across rebuilds (and doesn't consume uiRng, so the rest of
 * the level's cosmetics stay on their deterministic sequence).
 */
export function withSeededScatter<T>(seed: number, fn: () => T): T {
  let s = seed >>> 0;
  const prev = activeRnd;
  activeRnd = () => {                        // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return fn(); } finally { activeRnd = prev; }
}

/* =====================================================================
   Mesh builders — the "look" of Het Gooi. Every builder returns a THREE
   Group centred on the origin; the View positions/rotates it. Parts that
   must NOT be recoloured by the placement ghost tint carry
   userData.marker = true. Animated parts (windmill sails) are exposed via
   group.userData.spin so the View can turn them each frame.
   ===================================================================== */

export type SceneMaterial = THREE.MeshToonMaterial | THREE.MeshLambertMaterial;

// One shared gradient map quantizes toon lighting into flat cel bands.
// r152's toon shader samples only the red channel, hence RedFormat.
let gradient: THREE.DataTexture | null = null;
function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    const n = Math.max(2, GRAPHICS.toonBands);
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.round(255 * (i + 1) / n);
    gradient = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.unpackAlignment = 1; // rows of an odd-width R8 texture aren't 4-byte aligned
    gradient.needsUpdate = true;
  }
  return gradient;
}

/** Exclude a material from the OutlineEffect ink pass (UI overlays, ghosts, transparents). */
export function noOutline<T extends THREE.Material>(m: T): T {
  m.userData.outlineParameters = { visible: false };
  return m;
}

/** Give a material a crisper, thicker ink edge than the scene default so the
 *  object it clothes reads sharply against the busy scenery. Thickness is in
 *  the same screen-space (NDC) units as GRAPHICS.outlineThickness. */
export function sharpOutline<T extends THREE.Material>(m: T, thickness: number): T {
  m.userData.outlineParameters = {
    thickness,
    color: new THREE.Color(GRAPHICS.outlineColor).toArray(),
    alpha: Math.min(1, GRAPHICS.outlineAlpha + 0.15),
  };
  return m;
}

// Crisper ink for the things the eye tracks most: the little folk and the
// gold they scurry after. Scaled off the scene default so one tweak in
// constants.ts carries through here too.
const UNIT_INK = GRAPHICS.outlineThickness * 1.7;
const GOLD_INK = GRAPHICS.outlineThickness * 2.0;

/** Every lit scene material funnels through here so the whole look flips
 *  between cel-shaded toon and flat Lambert on GRAPHICS.toon. Transparent
 *  materials never get ink outlines — expanded backfaces read wrong on them. */
export function stdMat(params: THREE.MeshLambertMaterialParameters, outline = true): SceneMaterial {
  const m = GRAPHICS.toon
    ? new THREE.MeshToonMaterial({ ...params, gradientMap: toonGradient() })
    : new THREE.MeshLambertMaterial(params);
  if (!outline || params.transparent) noOutline(m);
  return m;
}

const matCache: Record<number, SceneMaterial> = {};
function mat(hex: number): SceneMaterial {
  if (!matCache[hex]) matCache[hex] = stdMat({ color: hex });
  return matCache[hex];
}
// Solid material when placed, translucent when previewing (ghost).
function mkMat(hex: number, ghost: boolean): SceneMaterial {
  return ghost ? stdMat({ color: hex, transparent: true, opacity: 0.55 }) : mat(hex);
}

// A parallel cache for unit materials, kept separate from `matCache` so the
// sharper unit ink never bleeds onto scenery props that reuse the same colour.
const unitMatCache: Record<number, SceneMaterial> = {};
function umat(hex: number): SceneMaterial {
  if (!unitMatCache[hex]) unitMatCache[hex] = sharpOutline(stdMat({ color: hex }), UNIT_INK);
  return unitMatCache[hex];
}
// Shared sharp-edged gold for the coin heaps scattered on the map.
let goldMat: SceneMaterial | null = null;
function goldSharp(): SceneMaterial {
  if (!goldMat) goldMat = sharpOutline(stdMat({ color: 0xffd24a }), GOLD_INK);
  return goldMat;
}

// =====================================================================
//  Geometry cache — one GPU buffer per distinct shape, not per instance.
//  Keys are the constructor parameters, so a builder can call these freely;
//  anything size-randomized must use a fixed base shape and express its
//  variation through mesh scale/rotation instead of unique geometry.
// =====================================================================
const geoCache = new Map<string, THREE.BufferGeometry>();
export function cachedGeo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g as T;
}
export const cone = (r: number, h: number, seg: number): THREE.ConeGeometry =>
  cachedGeo(`cone,${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg));
export const cyl = (rt: number, rb: number, h: number, seg: number): THREE.CylinderGeometry =>
  cachedGeo(`cyl,${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
export const sphere = (r: number, ws: number, hs: number): THREE.SphereGeometry =>
  cachedGeo(`sph,${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
export const box = (w: number, h: number, d: number): THREE.BoxGeometry =>
  cachedGeo(`box,${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
export const dodeca = (r: number): THREE.DodecahedronGeometry =>
  cachedGeo(`dod,${r}`, () => new THREE.DodecahedronGeometry(r, 0));
export const torus = (r: number, t: number, rs: number, ts: number, arc = Math.PI * 2): THREE.TorusGeometry =>
  cachedGeo(`tor,${r},${t},${rs},${ts},${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc));
export const circle = (r: number, seg: number): THREE.CircleGeometry =>
  cachedGeo(`cir,${r},${seg}`, () => new THREE.CircleGeometry(r, seg));
export const capsule = (r: number, l: number, cs: number, rs: number): THREE.CapsuleGeometry =>
  cachedGeo(`caps,${r},${l},${cs},${rs}`, () => new THREE.CapsuleGeometry(r, l, cs, rs));

function flatGeo(key: string, base: THREE.BufferGeometry): THREE.BufferGeometry {
  return cachedGeo(`flat,${key}`, () => {
    const g = base.index ? base.toNonIndexed() : base.clone();
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    return g;
  });
}
const flatCone = (r: number, h: number, seg: number): THREE.BufferGeometry => flatGeo(`cone,${r},${h},${seg}`, cone(r, h, seg));
const flatSphere = (r: number, ws: number, hs: number): THREE.BufferGeometry => flatGeo(`sph,${r},${ws},${hs}`, sphere(r, ws, hs));

// ---------- shared primitive geometries ----------
const geoTrunk = cyl(0.07, 0.1, 0.5, 6);
const geoFol = cone(0.4, 0.95, 7);
const geoFol2 = cone(0.3, 0.7, 7);
const geoRock = dodeca(0.42);
const geoPost = box(0.1, 0.7, 0.1);
// unit bodies get generous segment counts — the camera lives close to these
// little folk, and low-poly rounding is what made them read as blurry
const geoBody = cyl(0.16, 0.2, 0.42, 12);
const geoHead = sphere(0.14, 12, 10);
const geoItem = box(0.24, 0.18, 0.24);
const geoBlade = box(0.03, 0.34, 0.03);
const geoArm = box(0.055, 0.26, 0.08);
const geoHand = sphere(0.05, 8, 6);
const geoBelt = cyl(0.192, 0.198, 0.055, 12);

// The active biome drives foliage colours, snowlines and flora variants for
// every mesh built after loadWorld sets it (chunk re-bakes included).
import { BIOMES, type BiomeDef } from '../data/biomes';
let activeBiome: BiomeDef = BIOMES.gooi;
export function setActiveBiome(b: BiomeDef): void { activeBiome = b; }
const FOL_GREENS = (): number[] => activeBiome.palette.folGreens;

// =====================================================================
//  Doodads — trees come in a few species/heights for a mixed woodland
// =====================================================================
export function makeTree(kind = 0): THREE.Group {
  const g = new THREE.Group();
  const greens = FOL_GREENS();
  const green = greens[Math.floor(rnd() * greens.length)];
  switch (kind % 4) {
    case 0: { // classic layered conifer
      const trunk = new THREE.Mesh(geoTrunk, mat(0x7a5a3a)); trunk.position.y = 0.25; trunk.castShadow = true;
      const fol = new THREE.Mesh(geoFol, mat(green)); fol.position.y = 0.85; fol.castShadow = true;
      const fol2 = new THREE.Mesh(geoFol2, mat(green)); fol2.position.y = 1.28; fol2.castShadow = true;
      g.add(trunk, fol, fol2);
      break;
    }
    case 1: { // tall slender pine — three stacked cones
      const trunk = new THREE.Mesh(cyl(0.06, 0.09, 0.7, 6), mat(0x6f5334)); trunk.position.y = 0.35; trunk.castShadow = true; g.add(trunk);
      const dark = mat(0x3f6d34);
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(cone(0.42 - i * 0.1, 0.7, 7), dark);
        c.position.y = 0.85 + i * 0.5; c.castShadow = true; g.add(c);
      }
      break;
    }
    case 2: { // round broadleaf — bushy sphere canopy
      const trunk = new THREE.Mesh(cyl(0.09, 0.12, 0.55, 6), mat(0x7d5a37)); trunk.position.y = 0.28; trunk.castShadow = true; g.add(trunk);
      const cm = mat(green);
      const crown = new THREE.Mesh(sphere(0.5, 8, 7), cm); crown.position.y = 0.95; crown.scale.y = 0.9; crown.castShadow = true; g.add(crown);
      for (const [ox, oy, oz] of [[0.32, 0.75, 0], [-0.28, 0.82, 0.2], [0.05, 1.2, -0.15]]) {
        const p = new THREE.Mesh(sphere(0.3, 7, 6), cm); p.position.set(ox, oy, oz); p.castShadow = true; g.add(p);
      }
      break;
    }
    default: { // slim birch — pale trunk, small oval crown
      const trunk = new THREE.Mesh(cyl(0.05, 0.06, 0.95, 6), mat(0xe6e2d6)); trunk.position.y = 0.48; trunk.castShadow = true; g.add(trunk);
      const cm = mat(0x87b455);
      const crown = new THREE.Mesh(sphere(0.34, 8, 7), cm); crown.position.y = 1.12; crown.scale.y = 1.25; crown.castShadow = true; g.add(crown);
      const crown2 = new THREE.Mesh(sphere(0.26, 7, 6), cm); crown2.position.set(0.12, 0.92, 0.08); crown2.castShadow = true; g.add(crown2);
      break;
    }
  }
  // in the Winter biome every crown carries a load of snow
  if (activeBiome.gen.treeSnow) {
    const snowM = mat(0xf2f4f1);
    const isConifer = kind % 4 === 0 || kind % 4 === 1;
    if (isConifer) {
      const cap = new THREE.Mesh(cone(0.22, 0.3, 7), snowM);
      cap.position.y = kind % 4 === 1 ? 2.12 : 1.52; g.add(cap);
    } else {
      const drift = new THREE.Mesh(sphere(0.26, 7, 5), snowM);
      drift.scale.y = 0.4; drift.position.y = kind % 4 === 2 ? 1.32 : 1.42; g.add(drift);
    }
  }
  g.rotation.y = rnd() * Math.PI;
  return g;
}

// =====================================================================
//  Decorative ground scatter — lavender, wildflowers, bushes, reeds, lilies
// =====================================================================
export function makeDeco(kind: DecoKind): THREE.Group {
  switch (kind) {
    case 'lavender': return lavender();
    case 'flowers': return wildflowers();
    case 'bush': return bush();
    case 'reed': return reeds();
    case 'heather': return heather();
    case 'fern': return fern();
    case 'mushroom': return mushrooms();
    case 'edelweiss': return edelweiss();
    case 'tulip': return tulips();
    case 'dunegrass': return dunegrass();
    case 'winterberry': return winterberry();
    case 'snowdrift': return snowdrift();
    case 'bones': return bones();
    case 'embers': return embers();
    default: return lily();
  }
}

/** Hell's meadow flowers: rocks that never stopped burning. */
function embers(): THREE.Group {
  const g = new THREE.Group();
  const charM = mat(0x2e2226);
  const glowCols = [0xe8622a, 0xd8451e, 0xf0913a];
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.7, pz = (rnd() - 0.5) * 0.7;
    const s = 0.6 + rnd() * 0.6;
    const rock = new THREE.Mesh(dodeca(0.09 * s), charM);
    rock.position.set(px, 0.05 * s, pz); rock.rotation.y = rnd() * 3; g.add(rock);
    const glow = new THREE.Mesh(sphere(0.035 * s, 5, 4), mat(glowCols[Math.floor(rnd() * glowCols.length)]));
    glow.position.set(px + (rnd() - 0.5) * 0.06, 0.09 * s, pz + (rnd() - 0.5) * 0.06); g.add(glow);
  }
  return g;
}

/** Bleached remains half-sunk in the ash: ribs, a long bone, sometimes a skull. */
function bones(): THREE.Group {
  const g = new THREE.Group();
  const boneM = mat(0xdcd4c0);
  const a = rnd() * Math.PI * 2;
  for (let i = 0; i < 3; i++) { // a rib cage arching out of the ground
    const rib = new THREE.Mesh(torus(0.09 + i * 0.012, 0.012, 5, 8, Math.PI), boneM);
    rib.position.set(Math.cos(a) * (i - 1) * 0.12, 0.02, Math.sin(a) * (i - 1) * 0.12);
    rib.rotation.y = a + Math.PI / 2; g.add(rib);
  }
  const shaft = new THREE.Mesh(cyl(0.014, 0.014, 0.3, 5), boneM);
  shaft.rotation.z = Math.PI / 2 - 0.25; shaft.rotation.y = rnd() * Math.PI;
  shaft.position.set((rnd() - 0.5) * 0.4, 0.03, (rnd() - 0.5) * 0.4); g.add(shaft);
  if (rnd() < 0.4) {
    const skull = new THREE.Mesh(sphere(0.055, 7, 6), boneM);
    skull.scale.set(1.25, 0.9, 0.9);
    skull.position.set((rnd() - 0.5) * 0.5, 0.045, (rnd() - 0.5) * 0.5); g.add(skull);
  }
  return g;
}

/** Polder tulips: stiff bright cups in rows of red, yellow and pink. */
function tulips(): THREE.Group {
  const g = new THREE.Group();
  const stemM = mat(0x4f8a3e);
  const cups = [0xd0342c, 0xe8b52e, 0xe07a9e, 0xf3f0e2];
  // one field grows one colour — that's what makes the strips read from above
  const cupM = mat(cups[Math.floor(rnd() * cups.length)]);
  const n = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.75, pz = (rnd() - 0.5) * 0.75;
    const stem = new THREE.Mesh(box(0.02, 0.2, 0.02), stemM); stem.position.set(px, 0.1, pz); g.add(stem);
    const cup = new THREE.Mesh(cyl(0.045, 0.025, 0.08, 6), cupM); cup.position.set(px, 0.23, pz); g.add(cup);
  }
  return g;
}

/** Coastal marram grass: pale wind-bent blades in a sandy tussock. */
function dunegrass(): THREE.Group {
  const g = new THREE.Group();
  const bladeM = mat(rnd() < 0.5 ? 0xb8bd7e : 0xa3b070);
  const lean = rnd() * Math.PI * 2; // the whole tussock leans off the sea wind
  const n = 6 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.55, pz = (rnd() - 0.5) * 0.55;
    const h = 0.28 + rnd() * 0.22;
    const blade = new THREE.Mesh(cone(0.018, h, 4), bladeM);
    blade.position.set(px, h / 2, pz);
    blade.rotation.z = Math.cos(lean) * (0.35 + rnd() * 0.25);
    blade.rotation.x = -Math.sin(lean) * (0.35 + rnd() * 0.25);
    g.add(blade);
  }
  if (rnd() < 0.4) { // a hump of bare sand at the roots
    const sandM = mat(0xd8c894);
    const hump = new THREE.Mesh(sphere(0.16, 7, 5), sandM); hump.scale.y = 0.3; hump.position.y = 0.02; g.add(hump);
  }
  return g;
}

/** Winter brambles: bare dark twigs hung with bright red berries. */
function winterberry(): THREE.Group {
  const g = new THREE.Group();
  const twigM = mat(0x4a3a2c), berryM = mat(0xc22b30);
  const n = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.6, pz = (rnd() - 0.5) * 0.6;
    const h = 0.2 + rnd() * 0.15;
    const twig = new THREE.Mesh(cyl(0.008, 0.014, h, 4), twigM);
    twig.position.set(px, h / 2, pz); twig.rotation.z = (rnd() - 0.5) * 0.6; g.add(twig);
    for (let b = 0; b < 2 + Math.floor(rnd() * 3); b++) {
      const berry = new THREE.Mesh(sphere(0.016, 5, 4), berryM);
      berry.position.set(px + (rnd() - 0.5) * 0.09, h * 0.5 + rnd() * h * 0.55, pz + (rnd() - 0.5) * 0.09);
      g.add(berry);
    }
  }
  return g;
}

/** A wind-piled drift: low white humps that break up the snowfield. */
function snowdrift(): THREE.Group {
  const g = new THREE.Group();
  const snowM = mat(0xf4f6f3);
  const n = 2 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    const hump = new THREE.Mesh(sphere(0.2 + rnd() * 0.14, 8, 6), snowM);
    hump.scale.y = 0.28 + rnd() * 0.14;
    hump.position.set((rnd() - 0.5) * 0.5, 0.03, (rnd() - 0.5) * 0.5);
    g.add(hump);
  }
  return g;
}

// ---------- biome flora ----------
/** Ardennes heather: low rounded clumps in dusty purple-pink over dark stems. */
function heather(): THREE.Group {
  const g = new THREE.Group();
  const bloomCols = [0xb06a9a, 0x9a5f8a, 0xc084ae, 0x8a5580];
  const base = mat(0x4a5c38);
  const n = 4 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.75, pz = (rnd() - 0.5) * 0.75;
    const stem = new THREE.Mesh(sphere(0.07, 6, 5), base);
    stem.scale.set(1.2, 0.7, 1.2); stem.position.set(px, 0.05, pz); g.add(stem);
    const bloom = new THREE.Mesh(sphere(0.075, 6, 5), mat(bloomCols[Math.floor(rnd() * bloomCols.length)]));
    bloom.scale.set(1.15, 0.75, 1.15); bloom.position.set(px, 0.11, pz); g.add(bloom);
  }
  return g;
}

/** Forest-floor fern: a whorl of arching fronds. */
function fern(): THREE.Group {
  const g = new THREE.Group();
  const greens = FOL_GREENS();
  const frondM = mat(greens[Math.floor(rnd() * greens.length)]);
  const n = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
    const frond = new THREE.Mesh(cone(0.045, 0.34, 4), frondM);
    frond.scale.z = 0.35;
    frond.position.set(Math.cos(a) * 0.1, 0.13, Math.sin(a) * 0.1);
    frond.rotation.z = Math.cos(a) * 0.9;
    frond.rotation.x = -Math.sin(a) * 0.9;
    g.add(frond);
  }
  return g;
}

/** Black Forest mushrooms: fly agaric reds and puffball creams in the moss. */
function mushrooms(): THREE.Group {
  const g = new THREE.Group();
  const stemM = mat(0xe8e2d2);
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.6, pz = (rnd() - 0.5) * 0.6;
    const s = 0.7 + rnd() * 0.6;
    const stem = new THREE.Mesh(cyl(0.025 * s, 0.032 * s, 0.09 * s, 6), stemM);
    stem.position.set(px, 0.045 * s, pz); g.add(stem);
    const red = rnd() < 0.6;
    const cap = new THREE.Mesh(sphere(0.055 * s, 8, 5), mat(red ? 0xc2352b : 0xd9c9a8));
    cap.scale.y = 0.62; cap.position.set(px, 0.1 * s, pz); g.add(cap);
    if (red) for (let d = 0; d < 3; d++) {
      const dot = new THREE.Mesh(sphere(0.011 * s, 4, 3), stemM);
      const a = rnd() * Math.PI * 2;
      dot.position.set(px + Math.cos(a) * 0.035 * s, 0.115 * s, pz + Math.sin(a) * 0.035 * s);
      g.add(dot);
    }
  }
  return g;
}

/** Alpine edelweiss: white starbursts with a golden heart in short grass. */
function edelweiss(): THREE.Group {
  const g = new THREE.Group();
  const white = mat(0xf2f0e4), gold = mat(0xd9b23c), stemM = mat(0x6d8a55);
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.7, pz = (rnd() - 0.5) * 0.7;
    const stem = new THREE.Mesh(box(0.018, 0.1, 0.018), stemM); stem.position.set(px, 0.05, pz); g.add(stem);
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      const petal = new THREE.Mesh(cone(0.018, 0.055, 4), white);
      petal.position.set(px + Math.cos(a) * 0.03, 0.115, pz + Math.sin(a) * 0.03);
      petal.rotation.z = Math.cos(a) * 1.25;
      petal.rotation.x = -Math.sin(a) * 1.25;
      g.add(petal);
    }
    const heart = new THREE.Mesh(sphere(0.016, 5, 4), gold); heart.position.set(px, 0.115, pz); g.add(heart);
  }
  return g;
}

function lavender(): THREE.Group {
  const g = new THREE.Group();
  const stem = mat(0x5f7d43);
  const flowerCols = [0x9b6fc4, 0x8455b8, 0xa87fd0];
  const n = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(geoBlade, stem);
    const px = (rnd() - 0.5) * 0.7, pz = (rnd() - 0.5) * 0.7;
    s.position.set(px, 0.17, pz); s.rotation.z = (rnd() - 0.5) * 0.3;
    const tip = new THREE.Mesh(cyl(0.035, 0.02, 0.2, 5), mat(flowerCols[Math.floor(rnd() * 3)]));
    tip.position.set(px, 0.38, pz);
    g.add(s, tip);
  }
  return g;
}

function wildflowers(): THREE.Group {
  const g = new THREE.Group();
  const stem = mat(0x5f8c40);
  const cols = [0xffffff, 0xffd94a, 0xff8fb0, 0xf2f27a];
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.7, pz = (rnd() - 0.5) * 0.7;
    const s = new THREE.Mesh(box(0.02, 0.16, 0.02), stem); s.position.set(px, 0.08, pz);
    const head = new THREE.Mesh(sphere(0.05, 6, 5), mat(cols[Math.floor(rnd() * cols.length)])); head.position.set(px, 0.18, pz);
    g.add(s, head);
  }
  return g;
}

function bush(): THREE.Group {
  const g = new THREE.Group();
  const greens = FOL_GREENS();
  const green = mat(greens[Math.floor(rnd() * greens.length)]);
  for (const [ox, oy, oz, r] of [[0, 0.16, 0, 0.26], [0.22, 0.13, 0.08, 0.2], [-0.16, 0.12, -0.14, 0.18]] as number[][]) {
    const p = new THREE.Mesh(sphere(r, 7, 6), green); p.position.set(ox, oy, oz); p.scale.y = 0.85; p.castShadow = true; g.add(p);
  }
  // a few berries for interest
  if (rnd() < 0.5) {
    const berry = mat(0xd23b4a);
    for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(sphere(0.03, 5, 4), berry); b.position.set((rnd() - 0.5) * 0.4, 0.2 + rnd() * 0.1, (rnd() - 0.5) * 0.4); g.add(b); }
  }
  return g;
}

function reeds(): THREE.Group {
  const g = new THREE.Group();
  const stem = mat(0x6f8f3e);
  const n = 6 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.8, pz = (rnd() - 0.5) * 0.8;
    const h = 0.5 + rnd() * 0.5;
    const blade = new THREE.Mesh(cyl(0.012, 0.02, 1, 4), stem);
    blade.scale.y = h;
    blade.position.set(px, h / 2, pz); blade.rotation.z = (rnd() - 0.5) * 0.35;
    g.add(blade);
    if (rnd() < 0.4) { // cattail head
      const cat = new THREE.Mesh(cyl(0.035, 0.035, 0.14, 6), mat(0x7a4a28));
      cat.position.set(px, h, pz); g.add(cat);
    }
  }
  g.position.y = 0.02;
  return g;
}

function lily(): THREE.Group {
  const g = new THREE.Group();
  const pad = mat(0x3f7a44);
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const px = (rnd() - 0.5) * 0.7, pz = (rnd() - 0.5) * 0.7;
    const disc = new THREE.Mesh(circle(0.19, 10), pad);
    disc.scale.setScalar((0.15 + rnd() * 0.08) / 0.19);
    disc.rotation.x = -Math.PI / 2; disc.position.set(px, 0.005, pz); g.add(disc);
    if (rnd() < 0.5) { // a flower on the pad
      const f = new THREE.Mesh(sphere(0.055, 7, 5), mat(rnd() < 0.5 ? 0xf4c6dd : 0xfbf3ea));
      f.scale.y = 0.6; f.position.set(px, 0.05, pz); g.add(f);
    }
  }
  g.position.y = 0.03;
  return g;
}

export function makeDeposit(kind: 'stone' | 'gold' | 'coal' | 'iron'): THREE.Group {
  const g = new THREE.Group();
  const col = kind === 'stone' ? 0x9aa0a3 : kind === 'gold' ? 0xc9a94e : kind === 'iron' ? 0x8a6a58 : 0x3a3a42;
  const m = new THREE.Mesh(geoRock, mat(col));
  m.position.set(0, 0.16, 0); m.scale.y = 0.62; m.rotation.y = rnd() * 3; m.castShadow = true;
  const m2 = new THREE.Mesh(geoRock, mat(col));
  m2.position.set(0.28, 0.09, -0.2); m2.scale.set(0.5, 0.35, 0.5); m2.rotation.y = rnd() * 3; m2.castShadow = true;
  // a glint of the valuable stuff
  if (kind !== 'stone') {
    const glint = new THREE.Mesh(dodeca(0.12), mat(kind === 'gold' ? 0xffd24a : kind === 'iron' ? 0xb0653a : 0x24242a));
    glint.position.set(-0.18, 0.2, 0.12); g.add(glint);
  }
  g.add(m, m2);
  return g;
}

// =====================================================================
//  Natural boundaries — impassable mountain peaks & ruined wall lines
// =====================================================================
/** One tile's worth of mountain: a craggy main peak with lesser spurs. */
export function makeMountain(): THREE.Group {
  const g = new THREE.Group();
  const rockM = mat(0x7d7d78);
  const darkM = mat(0x64645f);
  const h = 1.1 + rnd() * 0.9;
  const peak = new THREE.Mesh(cone(1, 1, 6), rockM);
  peak.scale.set(0.58 + rnd() * 0.12, h, 0.58 + rnd() * 0.12);
  peak.position.set((rnd() - 0.5) * 0.2, h / 2, (rnd() - 0.5) * 0.2);
  peak.rotation.y = rnd() * Math.PI; peak.castShadow = true; g.add(peak);
  // a snowy cap crowns the tallest peaks (in the Alps, every peak);
  // in Hell the tips smoulder instead
  if (activeBiome.gen.scorched) {
    const glow = new THREE.Mesh(cone(0.16, 0.28, 6), mat(0xe8622a));
    glow.position.set(peak.position.x, h - 0.13, peak.position.z); glow.rotation.y = peak.rotation.y; g.add(glow);
  } else if (h > 1.6 || activeBiome.gen.snowline) {
    const snow = new THREE.Mesh(cone(0.2, 0.34, 6), mat(0xf2f3f0));
    snow.position.set(peak.position.x, h - 0.16, peak.position.z); snow.rotation.y = peak.rotation.y; g.add(snow);
  }
  for (let i = 0; i < 2; i++) {
    const sh = 0.4 + rnd() * 0.5;
    const spur = new THREE.Mesh(cone(1, 1, 5), i ? darkM : rockM);
    spur.scale.set(0.3 + rnd() * 0.1, sh, 0.3 + rnd() * 0.1);
    const a = rnd() * Math.PI * 2;
    spur.position.set(Math.cos(a) * 0.32, sh / 2, Math.sin(a) * 0.32);
    spur.rotation.y = rnd() * Math.PI; spur.castShadow = true; g.add(spur);
  }
  const scree = new THREE.Mesh(geoRock, darkM);
  scree.position.set((rnd() - 0.5) * 0.6, 0.08, (rnd() - 0.5) * 0.6);
  scree.scale.setScalar(0.35 + rnd() * 0.2); scree.rotation.y = rnd() * 3; g.add(scree);
  return g;
}

/** One tile of a broken old wall: a crumbling rampart with tumbled blocks.
 *  Runs along local X; the View turns it to follow the wall line. */
export function makeRuinWall(): THREE.Group {
  const g = new THREE.Group();
  const stoneM = mat(0x9a958a);
  const oldM = mat(0x847f74);
  // the standing courses, stepped down where the wall has crumbled
  let x = -0.5;
  while (x < 0.48) {
    const w = 0.22 + rnd() * 0.2;
    const h = 0.35 + rnd() * 0.55;
    const blk = new THREE.Mesh(box(1, 1, 1), rnd() < 0.4 ? oldM : stoneM);
    blk.scale.set(w, h, 0.34);
    blk.position.set(x + w / 2, h / 2, (rnd() - 0.5) * 0.06);
    blk.rotation.y = (rnd() - 0.5) * 0.1; blk.castShadow = true; g.add(blk);
    x += w + 0.02;
  }
  // tumbled blocks at the foot of the wall
  for (let i = 0; i < 2 + Math.floor(rnd() * 2); i++) {
    const s = 0.1 + rnd() * 0.08;
    const b = new THREE.Mesh(box(1, 1, 1), oldM);
    b.scale.set(s * 1.4, s, s);
    b.position.set((rnd() - 0.5) * 0.8, s / 2, (rnd() < 0.5 ? -1 : 1) * (0.26 + rnd() * 0.14));
    b.rotation.y = rnd(); b.castShadow = true; g.add(b);
  }
  return g;
}

/** A little heap of gold coins the hero/serfs pick up off the map.
 *  Faces and rims wear different golds so every coin has a defined edge. */
export function makePickup(): THREE.Group {
  const g = new THREE.Group();
  const face = goldSharp();
  const rim = sharpOutline(stdMat({ color: 0xc9962e }), GOLD_INK);
  const coinGeo = cyl(0.15, 0.15, 0.055, 16);
  const mats = [rim, face, face]; // cylinder material slots: side, top cap, bottom cap
  const coin = (x: number, y: number, z: number, rot: number, tiltX = 0, tiltZ = 0): void => {
    const c = new THREE.Mesh(coinGeo, mats);
    c.position.set(x, y, z); c.rotation.set(tiltX, rot, tiltZ); c.castShadow = true;
    g.add(c);
  };
  // a tidy pyramid: four on the ground, two stacked, one crowning it
  coin(0, 0.028, 0, 0);
  coin(0.2, 0.028, 0.1, 0.5, 0, 0.08);
  coin(-0.16, 0.028, 0.14, 1.1, 0.07, 0);
  coin(-0.05, 0.028, -0.2, 1.7, -0.06, 0.05);
  coin(0.08, 0.086, 0.05, 0.3);
  coin(-0.09, 0.086, -0.03, 0.9, 0.05, -0.04);
  coin(0, 0.142, 0.01, 0.2);
  // one coin leaning on its edge against the pile — unmistakably money
  const lean = new THREE.Mesh(coinGeo, mats);
  lean.position.set(0.24, 0.13, -0.14); lean.rotation.set(Math.PI / 2 - 0.35, 0.4, 0); lean.castShadow = true;
  g.add(lean);
  return g;
}

// One shared material for every baked unit body: colors live in the vertices.
let unitBakedMat: SceneMaterial | null = null;
let unitBakedNoOutlineMat: SceneMaterial | null = null;
function bakedUnitMat(outline: boolean): SceneMaterial {
  if (!outline) {
    if (!unitBakedNoOutlineMat) unitBakedNoOutlineMat = noOutline(stdMat({ vertexColors: true }));
    return unitBakedNoOutlineMat;
  }
  if (!unitBakedMat) unitBakedMat = sharpOutline(stdMat({ vertexColors: true }), UNIT_INK);
  return unitBakedMat;
}

/**
 * Collapse a rigid unit's ~15–20 part meshes into ONE mesh with baked vertex
 * colours (the makeCorpse technique). A 400-unit battle drops from ~12k meshes
 * (each rendered twice by the OutlineEffect) to ~800. The item mesh stays
 * separate — it changes colour and visibility at runtime — and the merged
 * geometry is per-unit, so it's flagged for disposal when the unit dies.
 */
function bakeUnit(built: { group: THREE.Group; itemMesh: THREE.Mesh }, outline = true): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const { group, itemMesh } = built;
  itemMesh.parent!.remove(itemMesh);
  const parts: THREE.BufferGeometry[] = [];
  bakeGroupInto(parts, group);
  const merged = mergeGeometries(parts, false)!;
  parts.forEach(p => p.dispose());
  const body = new THREE.Mesh(merged, bakedUnitMat(outline));
  body.castShadow = true;
  body.userData.ownGeometry = true; // unique per unit — dispose on removal
  const g = new THREE.Group();
  g.add(body, itemMesh);
  return { group: g, itemMesh };
}

/** A little warhorse, long axis along z (forward), shared by hero & cavalry. */
function addHorse(g: THREE.Group, horseM: SceneMaterial, dark: SceneMaterial): void {
  const body = new THREE.Mesh(sphere(0.14, 9, 8), horseM); body.scale.set(0.85, 0.95, 1.9); body.position.y = 0.3; body.castShadow = true; g.add(body);
  for (const [lz, lx] of [[0.18, 0.07], [0.18, -0.07], [-0.18, 0.07], [-0.18, -0.07]]) {
    const leg = new THREE.Mesh(cyl(0.026, 0.03, 0.26, 6), horseM); leg.position.set(lx, 0.13, lz); g.add(leg);
  }
  const neck = new THREE.Mesh(cyl(0.05, 0.075, 0.24, 7), horseM); neck.position.set(0, 0.47, 0.26); neck.rotation.x = 0.55; neck.castShadow = true; g.add(neck);
  const head = new THREE.Mesh(sphere(0.062, 8, 7), horseM); head.scale.set(0.85, 0.85, 1.4); head.position.set(0, 0.56, 0.38); g.add(head);
  for (const ex of [0.03, -0.03]) { const ear = new THREE.Mesh(cone(0.016, 0.05, 4), horseM); ear.position.set(ex, 0.64, 0.33); g.add(ear); }
  const mane = new THREE.Mesh(box(0.03, 0.16, 0.14), dark); mane.position.set(0, 0.55, 0.24); mane.rotation.x = 0.5; g.add(mane);
  const tail = new THREE.Mesh(cone(0.035, 0.2, 5), dark); tail.position.set(0, 0.32, -0.32); tail.rotation.x = Math.PI - 0.5; g.add(tail);
}

/** Cavalry from the Stable: horse + armed rider, silhouette per kind —
 *  the lancer's couched lance, the horse archer's bow & quiver, the horse
 *  knight's full plate and shield. All face +z like every walker. */
export function makeCavalry(kind: string, colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const dark = umat(0x3a2c1f), skin = umat(0xe8c9a0);
  const coatM = umat(colorHex);
  const horseM = umat(kind === 'horseknight' ? 0x33302c : kind === 'lancer' ? 0x8a5a2b : 0xa9746a);
  addHorse(g, horseM, dark);
  const blanket = new THREE.Mesh(box(0.2, 0.05, 0.24), coatM); blanket.position.y = 0.41; g.add(blanket);
  // the rider
  const torso = new THREE.Mesh(geoBody, coatM); torso.scale.setScalar(0.85); torso.position.y = 0.58; torso.castShadow = true; g.add(torso);
  const rhead = new THREE.Mesh(geoHead, skin); rhead.scale.setScalar(0.9); rhead.position.y = 0.86; g.add(rhead);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(geoArm, coatM); arm.scale.setScalar(0.8); arm.position.set(sx * 0.15, 0.62, 0.05); arm.rotation.z = sx * 0.3; g.add(arm);
  }
  if (kind === 'lancer') {
    // couched lance angled forward past the horse's head, with a pennon
    const lance = new THREE.Mesh(cyl(0.014, 0.018, 0.85, 6), umat(0x8a6a44));
    lance.position.set(0.16, 0.68, 0.28); lance.rotation.x = Math.PI / 2 - 0.35; g.add(lance);
    const pennon = new THREE.Mesh(cone(0.035, 0.1, 3), coatM);
    pennon.rotation.x = Math.PI / 2; pennon.position.set(0.16, 0.82, 0.52); g.add(pennon);
    const cap = new THREE.Mesh(cyl(0.085, 0.095, 0.05, 8), umat(0x5a5f66)); cap.position.y = 0.93; g.add(cap);
  } else if (kind === 'horsearcher') {
    // an unstrung-looking curved bow held out and a quiver at the hip
    const bow = new THREE.Mesh(torus(0.11, 0.014, 5, 10, Math.PI), umat(0x6b4a2f));
    bow.position.set(0.18, 0.66, 0.1); bow.rotation.y = Math.PI / 2; g.add(bow);
    const quiver = new THREE.Mesh(cyl(0.035, 0.03, 0.16, 6), umat(0x6b4a2f));
    quiver.position.set(-0.16, 0.55, -0.1); quiver.rotation.x = 0.5; g.add(quiver);
    const hood = new THREE.Mesh(cone(0.1, 0.13, 7), coatM); hood.position.y = 0.95; g.add(hood);
  } else { // horseknight
    const helm = new THREE.Mesh(sphere(0.1, 8, 6), umat(0xa9b2bd)); helm.scale.y = 0.8; helm.position.y = 0.9; g.add(helm);
    const plume = new THREE.Mesh(cone(0.028, 0.13, 5), umat(0xb03030)); plume.position.y = 1.02; g.add(plume);
    const shield = new THREE.Mesh(cyl(0.09, 0.09, 0.03, 10), umat(0x5a6470));
    shield.rotation.z = Math.PI / 2; shield.position.set(-0.19, 0.62, 0.05); g.add(shield);
    // barding: an armoured skirt over the horse
    const bard = new THREE.Mesh(box(0.26, 0.14, 0.5), umat(0x7d8794)); bard.position.y = 0.3; g.add(bard);
  }
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff }));
  item.position.y = 1.1; item.visible = false;
  g.add(item);
  return bakeUnit({ group: g, itemMesh: item }, false);
}

/** Siege engines from the Engineer's Workshop: all-wood machines on wheels,
 *  facing +z. Ballista = giant crossbow, onager = torsion catapult flinging
 *  rocks, trebuchet = counterweight arm. */
export function makeSiege(kind: string): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const wood = umat(0x76502f), pale = umat(0xb08a5c), iron = umat(0x5a5f66), rope = umat(0xc9b58c);
  // wheeled base shared by all three
  const bed = new THREE.Mesh(box(0.34, 0.06, 0.52), wood); bed.position.y = 0.14; bed.castShadow = true; g.add(bed);
  for (const [wx, wz] of [[0.19, 0.16], [-0.19, 0.16], [0.19, -0.16], [-0.19, -0.16]]) {
    const wheel = new THREE.Mesh(cyl(0.08, 0.08, 0.04, 10), pale);
    wheel.rotation.z = Math.PI / 2; wheel.position.set(wx, 0.08, wz); g.add(wheel);
  }
  if (kind === 'trebuchet') {
    // A-frame, long throwing arm cocked back, counterweight box, sling stone
    for (const sx of [-0.12, 0.12]) {
      const post = new THREE.Mesh(box(0.05, 0.42, 0.05), wood); post.position.set(sx, 0.38, 0); post.rotation.x = 0.12; post.castShadow = true; g.add(post);
    }
    const axle = new THREE.Mesh(cyl(0.025, 0.025, 0.3, 6), iron); axle.rotation.z = Math.PI / 2; axle.position.set(0, 0.56, 0); g.add(axle);
    const arm = new THREE.Mesh(box(0.05, 0.05, 0.78), wood); arm.position.set(0, 0.62, -0.08); arm.rotation.x = -0.55; arm.castShadow = true; g.add(arm);
    const weight = new THREE.Mesh(box(0.16, 0.14, 0.14), iron); weight.position.set(0, 0.44, 0.28); g.add(weight);
    const stone = new THREE.Mesh(sphere(0.05, 7, 6), umat(0x9aa0a3)); stone.position.set(0, 0.22, -0.32); g.add(stone);
  } else if (kind === 'onager') {
    // squat torsion catapult: low frame, a single sprung arm angled up with a
    // bucket cradling a boulder, braced against a padded crossbar
    const frame = new THREE.Mesh(box(0.24, 0.09, 0.4), wood); frame.position.y = 0.22; frame.castShadow = true; g.add(frame);
    const skein = new THREE.Mesh(cyl(0.05, 0.05, 0.26, 8), rope); skein.rotation.z = Math.PI / 2; skein.position.set(0, 0.26, 0.12); g.add(skein);
    const arm = new THREE.Mesh(box(0.045, 0.045, 0.44), wood); arm.position.set(0, 0.36, -0.02); arm.rotation.x = 0.7; arm.castShadow = true; g.add(arm);
    const bucket = new THREE.Mesh(cyl(0.08, 0.06, 0.06, 8), iron); bucket.position.set(0, 0.52, -0.18); g.add(bucket);
    const boulder = new THREE.Mesh(sphere(0.06, 6, 5), umat(0x8f9195)); boulder.position.set(0, 0.56, -0.18); g.add(boulder);
    const crossbar = new THREE.Mesh(cyl(0.02, 0.02, 0.26, 6), pale); crossbar.rotation.z = Math.PI / 2; crossbar.position.set(0, 0.34, -0.18); g.add(crossbar);
  } else {
    // ballista: crossbow bed + curved arms + a loaded bolt
    const rail = new THREE.Mesh(box(0.08, 0.05, 0.56), wood); rail.position.y = 0.24; rail.rotation.x = -0.08; rail.castShadow = true; g.add(rail);
    for (const sx of [-1, 1]) {
      const armB = new THREE.Mesh(cyl(0.018, 0.024, 0.32, 6), pale);
      armB.position.set(sx * 0.17, 0.27, 0.16); armB.rotation.z = sx * 1.25; g.add(armB);
    }
    const string = new THREE.Mesh(box(0.34, 0.012, 0.012), rope); string.position.set(0, 0.27, 0.1); g.add(string);
    const bolt = new THREE.Mesh(cyl(0.012, 0.012, 0.4, 5), iron); bolt.rotation.x = Math.PI / 2; bolt.position.set(0, 0.29, 0.05); g.add(bolt);
    const stand = new THREE.Mesh(box(0.06, 0.14, 0.06), wood); stand.position.y = 0.19; g.add(stand);
  }
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff }));
  item.position.y = 0.9; item.visible = false;
  g.add(item);
  return bakeUnit({ group: g, itemMesh: item }, false);
}

/** The run's hero: a mounted rider, dressed per hero so each reads at a
 *  glance — straw hat commoner, hooded merchant, plumed warlord, capped reeve.
 *  Faces +z like every walker (the sim rotates the group to the travel vector). */
export function makeHero(heroId: string): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const style: Record<string, { horse: number; coat: number; trim: number; hat: number }> = {
    erfgooier: { horse: 0x8a5a2b, coat: 0x5a7a3f, trim: 0xd9b95c, hat: 0xd9b95c },
    merchant: { horse: 0xa9746a, coat: 0x7a4b8a, trim: 0xd4af37, hat: 0x7a4b8a },
    warlord: { horse: 0x33302c, coat: 0x8f97a6, trim: 0xb03030, hat: 0x8f97a6 },
    reeve: { horse: 0x9d938a, coat: 0x3f5aa0, trim: 0xece3cf, hat: 0x2a2a30 },
  };
  const s = style[heroId] ?? style.erfgooier;
  const g = new THREE.Group();
  const horseM = umat(s.horse), coatM = umat(s.coat), trimM = umat(s.trim), hatM = umat(s.hat);
  const skin = umat(0xe8c9a0), dark = umat(0x3a2c1f);
  addHorse(g, horseM, dark);
  // saddle blanket in the hero's colours
  const blanket = new THREE.Mesh(box(0.2, 0.05, 0.24), trimM); blanket.position.y = 0.41; g.add(blanket);

  // the rider
  const torso = new THREE.Mesh(geoBody, coatM); torso.scale.setScalar(0.85); torso.position.y = 0.58; torso.castShadow = true; g.add(torso);
  const rhead = new THREE.Mesh(geoHead, skin); rhead.scale.setScalar(0.9); rhead.position.y = 0.86; g.add(rhead);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(geoArm, coatM); arm.scale.setScalar(0.8); arm.position.set(sx * 0.15, 0.62, 0.05); arm.rotation.z = sx * 0.3; g.add(arm);
  }
  // a little cape off the back
  const cape = new THREE.Mesh(box(0.2, 0.24, 0.03), trimM); cape.position.set(0, 0.6, -0.12); cape.rotation.x = -0.15; g.add(cape);
  // per-hero headgear
  if (heroId === 'warlord') {
    const helm = new THREE.Mesh(sphere(0.1, 8, 6), hatM); helm.scale.y = 0.75; helm.position.y = 0.92; g.add(helm);
    const plume = new THREE.Mesh(cone(0.03, 0.14, 5), trimM); plume.position.y = 1.04; g.add(plume);
  } else if (heroId === 'merchant') {
    const hood = new THREE.Mesh(cone(0.11, 0.16, 7), hatM); hood.position.y = 0.96; g.add(hood);
    const brooch = new THREE.Mesh(sphere(0.02, 6, 5), trimM); brooch.position.set(0, 0.72, 0.11); g.add(brooch);
  } else if (heroId === 'reeve') {
    const cap = new THREE.Mesh(cyl(0.1, 0.1, 0.045, 8), hatM); cap.position.y = 0.94; g.add(cap);
    const collar = new THREE.Mesh(cyl(0.08, 0.09, 0.03, 8), trimM); collar.position.y = 0.74; g.add(collar);
  } else {
    const brim = new THREE.Mesh(cyl(0.13, 0.13, 0.02, 9), hatM); brim.position.y = 0.93; g.add(brim);
    const crown = new THREE.Mesh(cyl(0.07, 0.08, 0.07, 9), hatM); crown.position.y = 0.97; g.add(crown);
  }
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff }));
  item.position.y = 1.1; item.visible = false;
  g.add(item);
  return bakeUnit({ group: g, itemMesh: item }, false);
}

export function makeUnit(colorHex: number, role = 'serf'): { group: THREE.Group; itemMesh: THREE.Mesh } {
  // fliers keep their part meshes — the sim flaps their wings every tick
  if (role === 'dragon') return makeDragon(colorHex);
  if (role === 'demon') return makeDemon(colorHex);
  if (role === 'lancer' || role === 'horseknight' || role === 'horsearcher') return makeCavalry(role, colorHex);
  if (role === 'ballista' || role === 'onager' || role === 'trebuchet') return makeSiege(role);
  if (role === 'boar') return bakeUnit(makeBeast(colorHex));
  if (role === 'wolf') return bakeUnit(makeWolf(colorHex));
  return bakeUnit(makeHumanoid(colorHex, role), false);
}

function makeHumanoid(colorHex: number, role: string): { group: THREE.Group; itemMesh: THREE.Mesh } {
  // greenskins & trolls get their own hide, the undead bone or rot;
  // everyone else the usual complexion
  const skinHex = role === 'orc' ? 0x7a9a4a : role === 'troll' ? 0x8fa08a
    : role === 'skeleton' || role === 'skelarcher' ? 0xdcd6c4
    : role === 'zombie' || role === 'brute' ? 0x8aa065 : 0xe8c9a0;
  const g = new THREE.Group();
  const body = new THREE.Mesh(geoBody, umat(colorHex)); body.position.y = 0.21; body.castShadow = true;
  const head = new THREE.Mesh(geoHead, umat(skinHex)); head.position.y = 0.55; head.castShadow = true;
  g.add(body, head);
  // a dark belt with a little buckle breaks up the tunic and grounds the figure
  const belt = new THREE.Mesh(geoBelt, umat(0x3a2c1f)); belt.position.y = 0.13;
  const buckle = new THREE.Mesh(box(0.06, 0.05, 0.02), umat(0xc9a94e)); buckle.position.set(0, 0.13, 0.195);
  g.add(belt, buckle);

  // little arms with skin-toned hands, angled out from the body
  const skin = umat(skinHex);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(geoArm, umat(colorHex));
    arm.position.set(sx * 0.19, 0.26, 0.02); arm.rotation.z = sx * 0.22; arm.castShadow = true;
    const hand = new THREE.Mesh(geoHand, skin);
    hand.position.set(sx * 0.23, 0.13, 0.03);
    g.add(arm, hand);
  }

  dressUnit(g, role);
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff }));
  item.position.y = 0.82; item.visible = false;
  g.add(item);
  return { group: g, itemMesh: item };
}

// Give each role its own little hat + outfit accent so trades read at a glance.
// Head sits at y≈0.55 (r 0.14); hats perch around y≈0.66–0.9.
function dressUnit(g: THREE.Group, role: string): void {
  // Hats, aprons and weapons share the units' crisper ink, not the scenery cache.
  const mat = umat;
  const add = (m: THREE.Object3D, castsShadow = true) => { m.castShadow = castsShadow; g.add(m); };
  // small helpers
  const brim = (col: number, r: number, h: number, y: number) => new THREE.Mesh(cyl(r, r, h, 12), mat(col)).translateY(y);
  const dome = (col: number, r: number, y: number) => { const m = new THREE.Mesh(flatSphere(r, 8, 6), mat(col)); m.position.y = y; m.scale.y = 0.75; return m; };
  const hatCone = (col: number, r: number, h: number, seg: number) => new THREE.Mesh(flatCone(r, h, seg), mat(col));
  const apron = (col: number) => { const m = new THREE.Mesh(box(0.3, 0.34, 0.06), mat(col)); m.position.set(0, 0.24, 0.19); m.userData.marker = true; return m; };
  const strap = (x: number) => { const m = new THREE.Mesh(box(0.05, 0.34, 0.04), mat(0x3f5aa0)); m.position.set(x, 0.28, 0.19); m.userData.marker = true; return m; };
  // combat kit — worn chest plate, a helmet, and a weapon held in the right hand
  const plate = (col: number) => { const m = new THREE.Mesh(box(0.36, 0.32, 0.12), mat(col)); m.position.set(0, 0.26, 0.14); m.userData.marker = true; return m; };
  const shield = (col: number) => { const m = new THREE.Mesh(cyl(0.15, 0.15, 0.04, 12), mat(col)); m.rotation.x = Math.PI / 2; m.position.set(-0.26, 0.26, 0.08); m.userData.marker = true; return m; };
  const sword = () => {
    const s = new THREE.Group();
    const blade = new THREE.Mesh(box(0.05, 0.42, 0.05), mat(0xd8dde2)); blade.position.y = 0.2;
    const guard = new THREE.Mesh(box(0.18, 0.05, 0.05), mat(0x6b4a2f));
    const hilt = new THREE.Mesh(box(0.05, 0.12, 0.05), mat(0x4a3320)); hilt.position.y = -0.08;
    s.add(blade, guard, hilt); s.position.set(0.28, 0.22, 0.1); s.rotation.z = -0.22; s.userData.marker = true; return s;
  };
  const axe = () => {
    const s = new THREE.Group();
    const haft = new THREE.Mesh(box(0.045, 0.4, 0.045), mat(0x5a4030)); haft.position.y = 0.16;
    const head = new THREE.Mesh(box(0.16, 0.14, 0.04), mat(0x9aa0a3)); head.position.set(0.07, 0.3, 0);
    s.add(haft, head); s.position.set(0.28, 0.16, 0.1); s.rotation.z = -0.18; s.userData.marker = true; return s;
  };
  const bow = () => {
    const b = new THREE.Mesh(torus(0.17, 0.022, 6, 12, Math.PI * 1.25), mat(0x6b4a2f));
    b.position.set(0.27, 0.3, 0.08); b.rotation.set(0, Math.PI / 2, Math.PI / 2 - 0.35); b.userData.marker = true; return b;
  };
  const quiver = () => { const m = new THREE.Mesh(cyl(0.05, 0.05, 0.28, 7), mat(0x7a5230)); m.position.set(-0.14, 0.34, -0.16); m.rotation.x = 0.4; m.userData.marker = true; return m; };

  switch (role) {
    case 'woodcutter': { // red knit beanie
      add(dome(0xb5352f, 0.16, 0.66));
      break;
    }
    case 'forester': { // green pointed hood
      const hat = hatCone(0x3f6d3a, 0.18, 0.3, 8); hat.position.y = 0.74; add(hat);
      break;
    }
    case 'carpenter': { // brown work cap + apron
      add(dome(0x6b4a2f, 0.15, 0.66));
      add(apron(0x8a6a44));
      break;
    }
    case 'stonemason': { // grey dusty cap
      add(dome(0x9aa0a3, 0.16, 0.66));
      break;
    }
    case 'farmer': { // wide straw hat
      add(hatCone(0xd9bd63, 0.22, 0.16, 10).translateY(0.72));
      add(strap(-0.09)); add(strap(0.09)); // overalls
      break;
    }
    case 'miller': { // soft white cap
      add(dome(0xefe9dc, 0.17, 0.66));
      break;
    }
    case 'baker': { // tall white toque
      add(dome(0xfbf7ef, 0.18, 0.75));
      add(apron(0xf0e6d2));
      break;
    }
    case 'miner': case 'collier': { // hard hat + head lamp
      const helmCol = role === 'miner' ? 0xd8af43 : 0x35353c;
      add(dome(helmCol, 0.165, 0.66));
      const lamp = new THREE.Mesh(sphere(0.045, 7, 6), mat(0xfff2a8)); lamp.position.set(0, 0.69, 0.15); add(lamp, false);
      break;
    }
    case 'minter': { // green cap
      add(dome(0x2f6f52, 0.16, 0.67));
      break;
    }
    case 'laborer': { // brown flat cap (builders)
      add(brim(0x8a5a34, 0.17, 0.08, 0.65));
      break;
    }
    case 'soldier': { // steel helmet with a crest, breastplate, sword & shield
      add(dome(0x9298a0, 0.175, 0.66));
      const crest = new THREE.Mesh(box(0.04, 0.11, 0.22), mat(0xb5352f)); crest.position.set(0, 0.79, 0); crest.userData.marker = true; add(crest);
      add(plate(0x8f97a6));
      add(shield(0x3f5aa0));
      add(sword());
      break;
    }
    case 'pikeman': { // open helm, breastplate and a conspicuously long ash pike
      add(dome(0x858b93, 0.17, 0.66));
      add(plate(0x7d8794));
      const pike = new THREE.Group();
      const shaft = new THREE.Mesh(box(0.045, 1.25, 0.045), mat(0x76512f)); shaft.position.y = 0.48;
      const head = new THREE.Mesh(cone(0.07, 0.25, 5), mat(0xd8dde2)); head.position.y = 1.22;
      pike.add(shaft, head); pike.position.set(0.27, 0.05, 0.08); pike.rotation.z = -0.28; pike.userData.marker = true; add(pike);
      add(shield(0x6b568f));
      break;
    }
    case 'knight': { // full helm with plume, heavy plate, sword & kite shield
      add(dome(0x7d8794, 0.185, 0.64));
      const plume = hatCone(0xd9a441, 0.05, 0.22, 6); plume.position.set(0, 0.86, -0.02); plume.userData.marker = true; add(plume);
      add(plate(0x9aa3b0));
      const pauldronMat = mat(0x7d8794);
      for (const sx of [-1, 1]) { const p = new THREE.Mesh(sphere(0.09, 7, 6), pauldronMat); p.position.set(sx * 0.2, 0.4, 0.02); p.userData.marker = true; add(p); }
      add(shield(0x8f2f3a));
      add(sword());
      break;
    }
    case 'archer': { // leather cap, green tunic accent, bow & quiver
      add(dome(0x5c6b3a, 0.16, 0.66));
      add(plate(0x6b7a44));
      add(bow());
      add(quiver());
      break;
    }
    case 'orc': { // horned iron half-helm, shoulder plate, brutish axe
      add(dome(0x3a3a40, 0.17, 0.66));
      for (const sx of [-1, 1]) {
        const horn = new THREE.Mesh(cone(0.04, 0.16, 5), mat(0xd8cdb4));
        horn.position.set(sx * 0.15, 0.74, 0); horn.rotation.z = -sx * 0.7; horn.userData.marker = true; add(horn);
      }
      add(plate(0x4a4038));
      add(axe());
      break;
    }
    case 'troll': { // hulking hide-clad rock-thrower: ragged pelt, bow & quiver
      const mane = new THREE.Mesh(sphere(0.15, 7, 6), mat(0x4a5244));
      mane.position.y = 0.68; mane.scale.y = 0.7; mane.userData.marker = true; add(mane);
      for (const sx of [-1, 1]) { // big jutting ears
        const ear = new THREE.Mesh(cone(0.045, 0.14, 4), mat(0x8fa08a));
        ear.position.set(sx * 0.16, 0.6, -0.02); ear.rotation.z = sx * 1.25; ear.userData.marker = true; add(ear);
      }
      add(plate(0x6a5a44));
      add(bow());
      add(quiver());
      break;
    }
    case 'skeleton': { // rusted half-helm over bare bone, old sword & shield
      add(dome(0x6e5f4a, 0.165, 0.66));
      add(plate(0xb9b2a0)); // exposed ribcage reads as a bone-pale chest
      add(shield(0x5a4a3a));
      add(sword());
      break;
    }
    case 'skelarcher': { // tattered hood, bone-pale chest, bow & quiver
      const hood = hatCone(0x4a4440, 0.18, 0.24, 8); hood.position.y = 0.71; add(hood);
      add(plate(0xc4bda8));
      add(bow());
      add(quiver());
      break;
    }
    case 'zombie': { // bare rotting head, torn grave clothes
      add(plate(0x5c6a48));
      const wound = new THREE.Mesh(box(0.1, 0.08, 0.04), mat(0x7a2f2a));
      wound.position.set(0.1, 0.32, 0.19); wound.userData.marker = true; add(wound);
      break;
    }
    case 'brute': { // the bloated one: a vast straining belly and iron shackles
      const belly = new THREE.Mesh(sphere(0.24, 9, 7), mat(0x74875a));
      belly.position.set(0, 0.24, 0.1); belly.scale.set(1.15, 1, 0.95); belly.userData.marker = true; add(belly);
      for (const sx of [-1, 1]) {
        const cuff = new THREE.Mesh(cyl(0.06, 0.06, 0.05, 8), mat(0x4a4a50));
        cuff.position.set(sx * 0.23, 0.16, 0.03); cuff.userData.marker = true; add(cuff);
      }
      break;
    }
    case 'bandit': { // dark hood, ragged leather, crude axe
      const hood = hatCone(0x3a3138, 0.18, 0.26, 8); hood.position.y = 0.72; add(hood);
      add(plate(0x5a4636));
      add(axe());
      break;
    }
    case 'villager': { // unposted recruit — simple flat red cap
      add(brim(0xb5352f, 0.16, 0.07, 0.66));
      break;
    }
    default: { // serf — a jaunty maroon fez
      const fez = new THREE.Mesh(cyl(0.115, 0.145, 0.2, 14), mat(0x9e2b25));
      fez.position.y = 0.77; add(fez);
      add(brim(0x7f2019, 0.115, 0.02, 0.87), false);
      break;
    }
  }
}

// =====================================================================
//  Beasts — a bristly wild boar and the dragon of Het Gooi
// =====================================================================
function makeBeast(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  // The body is modelled snout-along +x; the sim expects +z forward (like the
  // human units), so the parts live in an inner group turned a quarter left.
  const outer = new THREE.Group();
  const g = new THREE.Group();
  g.rotation.y = -Math.PI / 2;
  outer.add(g);
  const hide = mat(colorHex);
  const body = new THREE.Mesh(sphere(0.28, 10, 8), hide);
  body.scale.set(1.5, 0.95, 0.95); body.position.y = 0.3; body.castShadow = true;
  const hump = new THREE.Mesh(sphere(0.16, 8, 6), hide); hump.position.set(-0.05, 0.46, 0); hump.scale.set(1.1, 0.8, 0.9);
  const head = new THREE.Mesh(sphere(0.2, 9, 7), hide); head.position.set(0.4, 0.3, 0); head.scale.set(1.05, 0.9, 0.9); head.castShadow = true;
  const snout = new THREE.Mesh(cyl(0.09, 0.12, 0.16, 8), mat(0x4a3226)); snout.rotation.z = Math.PI / 2; snout.position.set(0.58, 0.27, 0);
  g.add(body, hump, head, snout);
  // tusks, ears, eyes — the tusks jut proudly up-and-forward from the jaw
  for (const s of [-1, 1]) {
    const tusk = new THREE.Mesh(cone(0.035, 0.2, 6), mat(0xf4ecd8));
    tusk.position.set(0.58, 0.22, s * 0.1); tusk.rotation.set(s * 0.35, 0, -0.85); tusk.castShadow = true; g.add(tusk);
    const tuskTip = new THREE.Mesh(cone(0.02, 0.09, 6), mat(0xfaf5e8));
    tuskTip.position.set(0.68, 0.31, s * 0.13); tuskTip.rotation.set(s * 0.35, 0, -0.45); g.add(tuskTip);
    const ear = new THREE.Mesh(cone(0.06, 0.11, 5), hide); ear.position.set(0.31, 0.46, s * 0.11); g.add(ear);
    const eye = new THREE.Mesh(sphere(0.024, 6, 5), mat(0x1a120c)); eye.position.set(0.47, 0.34, s * 0.08); g.add(eye);
  }
  // four stubby legs + a little tail
  for (const dx of [-0.2, 0.24]) for (const dz of [-0.14, 0.14]) {
    const leg = new THREE.Mesh(cyl(0.05, 0.05, 0.22, 6), mat(0x3a2a20)); leg.position.set(dx, 0.11, dz); leg.castShadow = true; g.add(leg);
  }
  const tail = new THREE.Mesh(cyl(0.02, 0.02, 0.16, 5), hide); tail.position.set(-0.42, 0.34, 0); tail.rotation.z = 0.8; g.add(tail);
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff })); item.visible = false; outer.add(item);
  return { group: outer, itemMesh: item };
}

function makeDragon(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  // Modelled head-along +x like the boar; turned to the sim's +z-forward frame.
  const outer = new THREE.Group();
  const g = new THREE.Group();
  g.rotation.y = -Math.PI / 2;
  outer.add(g);
  const scale = mat(colorHex);
  const body = new THREE.Mesh(sphere(0.34, 12, 9), scale); body.scale.set(1.6, 1, 1); body.position.y = 0.5; body.castShadow = true;
  const neck = new THREE.Mesh(cyl(0.1, 0.17, 0.42, 8), scale); neck.position.set(0.42, 0.72, 0); neck.rotation.z = -0.7; neck.castShadow = true;
  const head = new THREE.Mesh(sphere(0.19, 10, 8), scale); head.position.set(0.64, 0.9, 0); head.scale.set(1.3, 0.9, 0.9); head.castShadow = true;
  const snout = new THREE.Mesh(cone(0.1, 0.26, 7), scale); snout.rotation.z = -Math.PI / 2 * 0.85; snout.position.set(0.86, 0.86, 0);
  const tail = new THREE.Mesh(cone(0.13, 0.8, 7), scale); tail.rotation.z = Math.PI / 2; tail.position.set(-0.7, 0.44, 0); tail.castShadow = true;
  g.add(body, neck, head, snout, tail);
  // horns, eyes
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(cone(0.035, 0.18, 5), mat(0xe8e0cf)); horn.position.set(0.6, 1.04, s * 0.08); horn.rotation.x = s * 0.35; g.add(horn);
    const eye = new THREE.Mesh(sphere(0.032, 7, 6), mat(0xffcf3a)); eye.position.set(0.7, 0.94, s * 0.09); g.add(eye);
  }
  // swept bat wings — a scalloped membrane framed by arm & finger bones, with
  // a claw at the wingtip (exposed so the sim can flap them)
  const wings: THREE.Object3D[] = [];
  const membraneMat = stdMat({ color: 0x5a1a26, side: THREE.DoubleSide });
  const UP = new THREE.Vector3(0, 1, 0);
  const mkWing = (): THREE.Group => {
    const w = new THREE.Group();
    // silhouette in the flat: +X toward the head, +Y outward from the body
    const shape = new THREE.Shape();
    shape.moveTo(0.3, 0);                              // shoulder
    shape.quadraticCurveTo(0.46, 0.5, 0.3, 1.08);      // leading edge out to the tip
    shape.quadraticCurveTo(0.1, 0.86, -0.06, 0.8);     // scallop in to finger 1
    shape.quadraticCurveTo(-0.28, 0.64, -0.38, 0.54);  // scallop in to finger 2
    shape.quadraticCurveTo(-0.56, 0.3, -0.52, 0.18);   // scallop in to finger 3
    shape.lineTo(-0.42, 0);
    shape.closePath();
    const geo = cachedGeo('dragon-wing', () => {
      const g2 = new THREE.ShapeGeometry(shape, 6);
      g2.rotateX(Math.PI / 2); // lay it flat: shape-Y becomes outward +Z
      return g2;
    });
    const mem = new THREE.Mesh(geo, membraneMat);
    mem.castShadow = true;
    w.add(mem);
    // bones radiate from the shoulder across the membrane to each scallop point
    const bone = (ex: number, ez: number, r: number): void => {
      const dx = ex - 0.3, len = Math.hypot(dx, ez);
      const b = new THREE.Mesh(cyl(r, r * 0.55, len, 5), scale);
      b.position.set(0.3 + dx / 2, 0.015, ez / 2);
      b.quaternion.setFromUnitVectors(UP, new THREE.Vector3(dx, 0, ez).normalize());
      w.add(b);
    };
    bone(0.3, 1.08, 0.035);   // arm + leading finger, out to the wingtip
    bone(-0.06, 0.8, 0.022);
    bone(-0.38, 0.54, 0.022);
    bone(-0.52, 0.18, 0.022);
    // wingtip claw
    const claw = new THREE.Mesh(cone(0.035, 0.16, 5), mat(0xe8e0cf));
    claw.position.set(0.38, 0.02, 1.1); claw.rotation.z = -1.2;
    w.add(claw);
    return w;
  };
  for (const s of [-1, 1]) {
    const wing = mkWing();
    wing.position.set(-0.02, 0.84, s * 0.16);
    wing.scale.set(1.15, 1, s * 1.15);       // mirror one side, span a touch wider
    wing.rotation.x = s * 0.5;
    wing.userData.flapBase = s * 0.5; wing.userData.flapSign = s;
    g.add(wing); wings.push(wing);
  }
  outer.userData.wings = wings; // the sim flaps them via u.mesh.userData.wings
  for (let i = 0; i < 4; i++) { const spike = new THREE.Mesh(cone(0.04, 0.12, 5), mat(0x4a141f)); spike.position.set(0.3 - i * 0.28, 0.82 - i * 0.03, 0); g.add(spike); }
  // four clawed legs
  for (const dx of [-0.24, 0.28]) for (const dz of [-0.22, 0.22]) {
    const leg = new THREE.Mesh(cyl(0.08, 0.08, 0.32, 6), scale); leg.position.set(dx, 0.17, dz); leg.castShadow = true; g.add(leg);
  }
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff })); item.visible = false; outer.add(item);
  return { group: outer, itemMesh: item };
}

/** A lean grey wolf — a prowling quadruped, modelled snout-along +x like the boar. */
function makeWolf(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const outer = new THREE.Group();
  const g = new THREE.Group();
  g.rotation.y = -Math.PI / 2;
  outer.add(g);
  const fur = mat(colorHex);
  const dark = mat(0x4a4e54);
  const body = new THREE.Mesh(sphere(0.22, 9, 7), fur);
  body.scale.set(1.9, 0.85, 0.8); body.position.y = 0.3; body.castShadow = true;
  const chest = new THREE.Mesh(sphere(0.17, 8, 6), fur); chest.position.set(0.22, 0.32, 0); chest.scale.set(1, 0.95, 0.95);
  const head = new THREE.Mesh(sphere(0.14, 9, 7), fur); head.position.set(0.44, 0.4, 0); head.castShadow = true;
  const muzzle = new THREE.Mesh(cone(0.075, 0.2, 6), fur); muzzle.rotation.z = -Math.PI / 2; muzzle.position.set(0.58, 0.37, 0);
  const nose = new THREE.Mesh(sphere(0.03, 5, 4), mat(0x1a1a1e)); nose.position.set(0.68, 0.37, 0);
  g.add(body, chest, head, muzzle, nose);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(cone(0.045, 0.12, 4), dark); ear.position.set(0.4, 0.53, s * 0.07); g.add(ear);
    const eye = new THREE.Mesh(sphere(0.022, 6, 5), mat(0xd9a441)); eye.position.set(0.51, 0.43, s * 0.06); g.add(eye);
  }
  // slim legs + a bushy down-swept tail
  for (const dx of [-0.24, 0.26]) for (const dz of [-0.1, 0.1]) {
    const leg = new THREE.Mesh(cyl(0.035, 0.03, 0.28, 5), dark); leg.position.set(dx, 0.14, dz); leg.castShadow = true; g.add(leg);
  }
  const tail = new THREE.Mesh(cone(0.06, 0.32, 6), dark);
  tail.position.set(-0.46, 0.28, 0); tail.rotation.z = -1.1; g.add(tail);
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff })); item.visible = false; outer.add(item);
  return { group: outer, itemMesh: item };
}

/** The magic demon — a horned, bat-winged fiend wreathed in ember light,
 *  modelled facing +z (the sim's forward) and hovering via the flying flag. */
function makeDemon(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const hide = mat(colorHex);
  const ember = stdMat({ color: 0xff5a2a });
  const body = new THREE.Mesh(sphere(0.26, 10, 8), hide);
  body.scale.set(1, 1.4, 0.85); body.position.y = 0.52; body.castShadow = true;
  const head = new THREE.Mesh(sphere(0.16, 9, 7), hide); head.position.y = 0.98; head.castShadow = true;
  g.add(body, head);
  // great curved horns, burning eyes and a fanged underjaw
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(torus(0.12, 0.032, 6, 10, Math.PI * 0.8), mat(0xd8cdb4));
    horn.position.set(s * 0.12, 1.1, 0); horn.rotation.set(0, s * 0.5, s * -0.4); g.add(horn);
    const eye = new THREE.Mesh(sphere(0.032, 6, 5), ember); eye.position.set(s * 0.06, 1.0, 0.14); g.add(eye);
    const fang = new THREE.Mesh(cone(0.018, 0.06, 4), mat(0xefe6d0)); fang.position.set(s * 0.05, 0.9, 0.14); g.add(fang);
  }
  // clawed arms spread wide, ember orbs cupped in the palms (its magic)
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(cyl(0.045, 0.055, 0.4, 6), hide);
    arm.position.set(s * 0.3, 0.62, 0.08); arm.rotation.z = s * 1.0; g.add(arm);
    const orb = new THREE.Mesh(sphere(0.06, 7, 6), ember); orb.position.set(s * 0.46, 0.5, 0.14); g.add(orb);
  }
  // ragged bat wings (flapped by the sim like the dragon's)
  const wings: THREE.Object3D[] = [];
  const membraneMat = stdMat({ color: 0x2a0f1c, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const wing = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.1);
    shape.quadraticCurveTo(0.5, 0.55, 0.85, 0.5);   // leading edge up & out
    shape.quadraticCurveTo(0.62, 0.22, 0.7, 0.02);  // scallop
    shape.quadraticCurveTo(0.4, -0.1, 0.42, -0.28); // scallop
    shape.quadraticCurveTo(0.18, -0.16, 0, -0.12);
    shape.closePath();
    const mem = new THREE.Mesh(cachedGeo('demon-wing', () => new THREE.ShapeGeometry(shape, 6)), membraneMat);
    mem.castShadow = true;
    wing.add(mem);
    const spar = new THREE.Mesh(cyl(0.02, 0.014, 0.95, 5), hide);
    spar.position.set(0.42, 0.28, 0); spar.rotation.z = 1.1; wing.add(spar);
    wing.position.set(s * 0.14, 0.78, -0.16);
    wing.rotation.y = s * Math.PI / 2 + s * 0.35;   // sweep back from the shoulders
    wing.scale.x = s;
    wing.userData.flapBase = s * 0.35; wing.userData.flapSign = s;
    // the sim drives rotation.x for flap; base pose comes from rotation.y sweep
    g.add(wing); wings.push(wing);
  }
  g.userData.wings = wings;
  // a whipping spade-tipped tail
  const tail = new THREE.Mesh(cyl(0.02, 0.045, 0.5, 5), hide);
  tail.position.set(0, 0.3, -0.28); tail.rotation.x = 0.9; g.add(tail);
  const spade = new THREE.Mesh(cone(0.05, 0.12, 4), hide);
  spade.position.set(0, 0.14, -0.5); spade.rotation.x = 2.2; g.add(spade);
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff })); item.visible = false; g.add(item);
  return { group: g, itemMesh: item };
}

// =====================================================================
//  Combat effects — arrows, flame bursts and the rally flag
// =====================================================================
/** An arrow in flight: shaft along +Z (nose forward), oriented by the sim. */
export function makeArrow(): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(cyl(0.016, 0.016, 0.42, 5), mat(0x8a6a44));
  shaft.rotation.x = Math.PI / 2; g.add(shaft);
  const head = new THREE.Mesh(cone(0.03, 0.09, 5), mat(0xc2c6cb));
  head.rotation.x = Math.PI / 2; head.position.z = 0.24; g.add(head);
  const fletch = new THREE.Mesh(cone(0.045, 0.1, 4), mat(0xefe6d0));
  fletch.rotation.x = -Math.PI / 2; fletch.position.z = -0.2; g.add(fletch);
  return g;
}

/** An onager boulder in flight — a chunky grey rock, faceted low-poly. */
export function makeRock(): THREE.Group {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(sphere(0.12, 6, 5), mat(0x8f9195));
  rock.scale.set(1, 0.85, 1.05); g.add(rock);
  const chip = new THREE.Mesh(box(0.1, 0.09, 0.11), mat(0x74767a));
  chip.rotation.set(0.6, 0.4, 0.3); g.add(chip);
  return g;
}

/** A gob of dragon fire in flight — a glowing two-tone blob. */
export function makeFireball(): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(sphere(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd24a }));
  const shell = new THREE.Mesh(sphere(0.24, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe06428, transparent: true, opacity: 0.7 }));
  g.add(core, shell);
  return g;
}

/** A burst of flame licking up where dragon fire lands; the sim fades & culls it.
 *  Own materials per instance so fading one flame doesn't dim the others. */
export function makeFlame(): THREE.Group {
  const g = new THREE.Group();
  const cols = [0xe06428, 0xf09a3e, 0xffd24a];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(
      cone(1, 1, 5),
      new THREE.MeshBasicMaterial({ color: cols[i % 3], transparent: true, opacity: 0.9 }),
    );
    m.scale.set(0.1 + rnd() * 0.08, 0.3 + rnd() * 0.3, 0.1 + rnd() * 0.08);
    m.position.set((rnd() - 0.5) * 0.7, 0.15, (rnd() - 0.5) * 0.7);
    g.add(m);
  }
  return g;
}

/** Floating "plots wanted" marker hovering over a fields-building: a red
 *  diamond with a long down-arrow stabbing at the roof, so it's unmistakable
 *  which building wants to be clicked for its crop/pasture plots. */
export function makePlotMarker(): THREE.Group {
  const g = new THREE.Group();
  const red = mat(0xd9483a);
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), red);
  gem.position.y = 0.52; gem.scale.y = 1.35;
  g.add(gem);
  const shaft = new THREE.Mesh(cyl(0.05, 0.05, 0.3, 6), red);
  shaft.position.y = 0.12; g.add(shaft);
  const tip = new THREE.Mesh(cone(0.13, 0.28, 8), red);
  tip.rotation.x = Math.PI; tip.position.y = -0.16;
  g.add(tip);
  return g;
}

/** A rally/order flag. Transient variants own transparent materials so their
 *  opacity can animate without fading every cached flag in the scene. */
export function makeFlag(pennantHex = 0x3f5aa0, transient = false): THREE.Group {
  const g = new THREE.Group();
  const flagMat = (hex: number) => transient ? stdMat({ color: hex, transparent: true, opacity: 0 }) : mat(hex);
  const pole = new THREE.Mesh(cyl(0.025, 0.03, 0.9, 6), flagMat(0x5b4433));
  pole.position.y = 0.45; pole.castShadow = true; g.add(pole);
  const pennant = new THREE.Mesh(cone(0.13, 0.4, 3), flagMat(pennantHex));
  pennant.rotation.z = -Math.PI / 2; pennant.position.set(0.22, 0.78, 0); g.add(pennant);
  return g;
}

// =====================================================================
//  Gore — a toppled body with a flung-off arm, for the battlefield
// =====================================================================
/**
 * A corpse as a SINGLE merged mesh with baked vertex colours — one draw call
 * and one (own) material per body, so hundreds can litter the field cheaply.
 * The material starts opaque; View only flips it to transparent while fading.
 */
export function makeCorpse(colorHex: number): THREE.Mesh {
  const skin = 0xe8c9a0;
  const parts: THREE.BufferGeometry[] = [
    paintGeo(geoBody, colorHex, new THREE.Matrix4().compose(new THREE.Vector3(0, 0.12, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), ONE)),
    paintGeo(geoHead, skin, new THREE.Matrix4().makeTranslation(0.3, 0.11, 0.02)),
    paintGeo(geoArm, colorHex, new THREE.Matrix4().compose(new THREE.Vector3(-0.26, 0.05, 0.22), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 1.15)), ONE)),
    paintGeo(geoHand, skin, new THREE.Matrix4().makeTranslation(-0.42, 0.05, 0.3)),
  ];
  const merged = mergeGeometries(parts, false)!;
  parts.forEach(p => p.dispose());
  return new THREE.Mesh(merged, stdMat({ vertexColors: true }));
}

/** A fallen unit body. Humanoids use the small readable corpse silhouette;
 *  beasts and bosses keep their model shape so enemy deaths remain visible. */
export function makeUnitCorpse(role: string, colorHex: number): THREE.Mesh {
  if (role !== 'boar' && role !== 'wolf' && role !== 'dragon' && role !== 'demon') return makeCorpse(colorHex);
  const built = role === 'boar' ? makeBeast(colorHex)
    : role === 'wolf' ? makeWolf(colorHex)
      : role === 'dragon' ? makeDragon(colorHex)
        : makeDemon(colorHex);
  built.itemMesh.parent?.remove(built.itemMesh);
  // roll the body onto its side (rotating around x pitched the long horizontal
  // beast models nose-up, leaving wolves & boars looking planted upside down)
  built.group.rotation.z = Math.PI / 2;
  built.group.position.y = 0.08;
  const parts: THREE.BufferGeometry[] = [];
  bakeGroupInto(parts, built.group);
  const merged = mergeGeometries(parts, false)!;
  parts.forEach(p => p.dispose());
  return new THREE.Mesh(merged, stdMat({ vertexColors: true }));
}

const ONE = new THREE.Vector3(1, 1, 1);

/**
 * Append every mesh under `root` (transformed into root's frame, material
 * colour baked into vertex colours) to `parts` — the shared step behind
 * merged corpses, baked unit bodies and chunk-merged scenery. The caller
 * owns the pushed geometries and must dispose them after merging.
 */
export function bakeGroupInto(parts: THREE.BufferGeometry[], root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const col = (m.material as THREE.MeshLambertMaterial).color;
    parts.push(paintGeo(m.geometry, col ? col.getHex() : 0xffffff, m.matrixWorld));
  });
}

/** Clone a base geometry, transform it, and bake a flat vertex colour onto it.
 *  Always emits non-indexed geometry: mergeGeometries refuses to mix indexed
 *  and non-indexed inputs, and polyhedra (rock dodecahedra) are non-indexed. */
function paintGeo(base: THREE.BufferGeometry, hex: number, m: THREE.Matrix4): THREE.BufferGeometry {
  let g = base.clone();
  if (g.index) { const ni = g.toNonIndexed(); g.dispose(); g = ni; }
  g.applyMatrix4(m);
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// =====================================================================
//  Buildings
// =====================================================================
export function makeBuilding(key: BuildingKey, def: BuildingDef, ghost: boolean): THREE.Group {
  switch (key) {
    case 'woodcutter': return woodcutterHut(def, ghost);
    case 'forester': return foresterLodge(def, ghost);
    case 'sawmill': return sawmillBuilding(def, ghost);
    case 'quarry': return quarryBuilding(def, ghost);
    case 'bakery': return bakeryBuilding(def, ghost);
    case 'mint': return mintBuilding(def, ghost);
    case 'vineyard': return vineyardHouse(def, ghost);
    case 'winery': return wineryBuilding(def, ghost);
    case 'pigfarm': return pigBarn(def, ghost);
    case 'butcher': return butcherShop(def, ghost);
    case 'fishery': return fisheryHut(def, ghost);
    case 'clamdigger': return fisheryHut(def, ghost); // same shorefront hut, its own palette
    case 'smithy': return smithyBuilding(def, ghost);
    case 'armory': return armoryBuilding(def, ghost);
    case 'barracks': return barracksBuilding(def, ghost);
    case 'watchtower': return woodenWatchtower(def, ghost);
    case 'enemywatchtower': case 'stonetower': return stoneWatchtower(def, ghost);
    case 'banditcamp': return banditCamp(def, ghost);
    case 'wall': case 'enemywall': return wallSegment(def, ghost);
    case 'gate': case 'enemygate': return gateArch(def, ghost);
  }
  switch (def.model) {
    case 'windmill': return windmill(def, ghost);
    case 'farm': return farmhouse(def, ghost);
    case 'barn': return barn(def, ghost);
    case 'mine': return mine(key, def, ghost);
    case 'tavern': return tavern(def, ghost);
    case 'castle': return castle(key, def, ghost);
    case 'guildhall': return guildhall(def, ghost);
    default: return cottage(def, ghost);
  }
}

// ---------- fortifications: a crenellated rampart block and a barred gate ----------
function wallSegment(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const stone = mkMat(def.wall, ghost), cap = mkMat(def.roof, ghost);
  const body = new THREE.Mesh(box(1.9, 1.1, 1.9), stone);
  body.position.y = 0.55; body.castShadow = !ghost; body.receiveShadow = !ghost; g.add(body);
  const walk = new THREE.Mesh(box(1.98, 0.12, 1.98), cap);
  walk.position.y = 1.16; g.add(walk);
  // merlons ring the parapet
  for (const [x, z] of [[-0.75, -0.75], [0, -0.75], [0.75, -0.75], [-0.75, 0.75], [0, 0.75], [0.75, 0.75], [-0.75, 0], [0.75, 0]]) {
    const m = new THREE.Mesh(box(0.28, 0.26, 0.28), stone);
    m.position.set(x, 1.35, z); m.userData.marker = true; g.add(m);
  }
  return g;
}

function gateArch(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const stone = mkMat(def.wall, ghost), cap = mkMat(def.roof, ghost);
  const wood = mkMat(def.accent ?? 0x6b4a2f, ghost);
  for (const s of [-1, 1]) { // twin flanking towers with capped tops
    const t = new THREE.Mesh(box(0.6, 1.5, 1.9), stone);
    t.position.set(s * 0.68, 0.75, 0); t.castShadow = !ghost; g.add(t);
    const c = new THREE.Mesh(box(0.72, 0.14, 2.0), cap);
    c.position.set(s * 0.68, 1.56, 0); g.add(c);
  }
  const lintel = new THREE.Mesh(box(1.96, 0.4, 1.9), stone);
  lintel.position.y = 1.28; lintel.castShadow = !ghost; g.add(lintel);
  for (const s of [-1, 1]) { // heavy timber doors on both faces of the passage
    const doors = new THREE.Mesh(box(0.78, 1.05, 0.1), wood);
    doors.position.set(0, 0.53, s * 0.92); doors.userData.marker = true; g.add(doors);
  }
  return g;
}

// ---------- guild hall — a municipal Dutch raadhuis: brick, stepped gable,
// sandstone trim, tall lit windows and a little clock turret ----------
function guildhall(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const brick = mkMat(def.wall, ghost);
  const sand = mkMat(0xe4d9bd, ghost);        // sandstone trim
  const roofM = mkMat(def.roof, ghost);
  const woodM = mkMat(0x4a3626, ghost);
  const glowM = mkMat(def.accent ?? 0xffd24a, ghost);

  // two-storey brick hall on a sandstone plinth
  const plinth = new THREE.Mesh(box(1.75, 0.14, 1.4), sand);
  plinth.position.y = 0.07; plinth.receiveShadow = !ghost; g.add(plinth);
  const hall = new THREE.Mesh(box(1.6, 1.2, 1.26), brick);
  hall.position.y = 0.72; hall.castShadow = !ghost; hall.receiveShadow = !ghost; g.add(hall);
  const band = new THREE.Mesh(box(1.66, 0.07, 1.32), sand);
  band.position.y = 0.78; band.userData.marker = true; g.add(band);

  // steep hip roof (pre-rotated cone, squashed in z like the farmhouse thatch)
  const roofGeo = cachedGeo('guild-roof', () => {
    const r = new THREE.ConeGeometry(1.32, 0.95, 4);
    r.rotateY(Math.PI / 4);
    return r;
  });
  const roof = new THREE.Mesh(roofGeo, roofM);
  roof.position.y = 1.78; roof.scale.z = 0.82; roof.castShadow = !ghost; g.add(roof);

  // the stepped gable (trapgevel) crowning the entrance front
  const steps = [[1.15, 1.42], [0.85, 1.62], [0.55, 1.82], [0.26, 2.0]] as const;
  for (const [w, y] of steps) {
    const s = new THREE.Mesh(box(w, 0.22, 0.16), brick);
    s.position.set(0, y, 0.68); s.castShadow = !ghost; g.add(s);
    const cap = new THREE.Mesh(box(w + 0.08, 0.05, 0.2), sand);
    cap.position.set(0, y + 0.13, 0.68); cap.userData.marker = true; g.add(cap);
  }

  // clock turret on the ridge: a little white lantern with a spire and a clock
  const turret = new THREE.Mesh(box(0.3, 0.4, 0.3), sand);
  turret.position.y = 2.28; turret.castShadow = !ghost; g.add(turret);
  const clock = new THREE.Mesh(cyl(0.09, 0.09, 0.03, 12), glowM);
  clock.rotation.x = Math.PI / 2; clock.position.set(0, 2.3, 0.17); clock.userData.marker = true; g.add(clock);
  const spire = new THREE.Mesh(cone(0.24, 0.42, 4), roofM);
  spire.position.y = 2.68; spire.rotation.y = Math.PI / 4; spire.castShadow = !ghost; g.add(spire);
  const orb = new THREE.Mesh(sphere(0.045, 8, 6), glowM);
  orb.position.y = 2.93; orb.userData.marker = true; g.add(orb);

  // tall lit windows in sandstone surrounds, both storeys
  for (const wx of [-0.52, 0.52]) for (const wy of [0.42, 1.06]) {
    const frame = new THREE.Mesh(box(0.3, 0.44, 0.05), sand);
    frame.position.set(wx, wy, 0.64); frame.userData.marker = true; g.add(frame);
    const win = new THREE.Mesh(box(0.22, 0.36, 0.06), glowM);
    win.position.set(wx, wy, 0.65); win.userData.marker = true; g.add(win);
  }
  // round window in the gable
  const oculus = new THREE.Mesh(cyl(0.11, 0.11, 0.05, 12), glowM);
  oculus.rotation.x = Math.PI / 2; oculus.position.set(0, 1.44, 0.77); oculus.userData.marker = true; g.add(oculus);

  // grand double door with a sandstone arch and stone steps
  const arch = new THREE.Mesh(box(0.62, 0.78, 0.08), sand);
  arch.position.set(0, 0.39, 0.64); arch.userData.marker = true; g.add(arch);
  const door = new THREE.Mesh(box(0.46, 0.62, 0.09), woodM);
  door.position.set(0, 0.31, 0.66); door.userData.marker = true; g.add(door);
  for (let i = 0; i < 2; i++) {
    const st = new THREE.Mesh(box(0.72 - i * 0.14, 0.07, 0.22 - i * 0.06), sand);
    st.position.set(0, 0.035 + i * 0.07, 0.82 - i * 0.05); st.userData.marker = true; g.add(st);
  }

  // the town flag by the door
  if (!ghost) {
    const flag = makeFlag();
    flag.position.set(0.78, 0, 0.62);
    g.add(flag);
  }
  return g;
}

/** Scaffold shown while a building is under construction. */
export function makeScaffold(key: BuildingKey, def: BuildingDef): { group: THREE.Group; frame: THREE.Group } {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(box(1.9, 0.08, 1.9), mat(0x8a6b42)); pad.position.y = 0.04; g.add(pad);
  for (const [px, pz] of [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]]) {
    const post = new THREE.Mesh(geoPost, mat(0xc9a06a)); post.position.set(px, 0.35, pz); post.castShadow = true; g.add(post);
  }
  const frame = makeBuilding(key, def, true);
  frame.visible = false;
  frame.userData.dynamic = true; // Game scales it up with build progress
  g.add(frame);
  return { group: g, frame };
}

// ---------- door / accessories ----------
function addDoor(g: THREE.Group, ghost: boolean): void {
  const door = new THREE.Mesh(box(0.34, 0.6, 0.09), mkMat(0x4a3626, ghost));
  door.position.set(-0.4, 0.3, 0.86); door.userData.marker = true;
  const lintel = new THREE.Mesh(box(0.44, 0.08, 0.12), mkMat(0x6b4a2f, ghost));
  lintel.position.set(-0.4, 0.64, 0.86); lintel.userData.marker = true;
  g.add(door, lintel);
}
function addChimney(g: THREE.Group, ghost: boolean): void {
  const ch = new THREE.Mesh(box(0.22, 0.55, 0.22), mkMat(0x7a5a45, ghost));
  ch.position.set(0.5, 1.4, -0.3); ch.castShadow = !ghost; ch.userData.marker = true;
  const cap = new THREE.Mesh(box(0.3, 0.08, 0.3), mkMat(0x5b4433, ghost));
  cap.position.set(0.5, 1.68, -0.3); cap.userData.marker = true;
  g.add(ch, cap);
  if (ghost) return;
  // drifting smoke — puffs rise & fade; View.animate cycles them via userData.smoke
  const puffs: THREE.Mesh[] = [];
  const N = 4;
  for (let i = 0; i < N; i++) {
    const m = new THREE.Mesh(sphere(0.12, 7, 6), stdMat({ color: 0xbfbfbf, transparent: true, opacity: 0 }));
    m.userData.marker = true;
    m.userData.dynamic = true;              // View moves each puff every frame
    m.userData.smokePhase = i / N;          // stagger the puffs up the plume
    m.position.set(0.5, 1.75, -0.3);
    g.add(m); puffs.push(m);
  }
  g.userData.smoke = { puffs, base: new THREE.Vector3(0.5, 1.75, -0.3) };
}
function addLogpile(g: THREE.Group, ghost: boolean): void {
  const logMat = mkMat(0x8a5a2b, ghost);
  const ends = mkMat(0xcaa06a, ghost);
  const rows = [[-0.75, 0.55, 0.28], [-0.75, 0.55, 0.5], [-0.75, 0.73, 0.39]];
  for (const [x, , z] of rows) {
    const log = new THREE.Mesh(cyl(0.11, 0.11, 0.7, 8), logMat);
    log.rotation.x = Math.PI / 2; log.position.set(x, 0.14, z as number); log.castShadow = !ghost; log.userData.marker = true;
    const cap = new THREE.Mesh(circle(0.11, 8), ends);
    cap.position.set(x, 0.14, (z as number) + 0.36); cap.userData.marker = true;
    g.add(log, cap);
  }
}

// ---------- distinctive per-trade yard props (placed builds only, never on the ghost) ----------
function barrel(col: number, r = 0.15, h = 0.32): THREE.Group {
  const b = new THREE.Group();
  const body = new THREE.Mesh(cyl(r, r, h, 10), mat(col)); body.castShadow = true; b.add(body);
  const hoopMat = mat(0x3a2c1f);
  for (const hy of [h * 0.3, -h * 0.3]) { const hp = new THREE.Mesh(cyl(r * 1.05, r * 1.05, 0.035, 10), hoopMat); hp.position.y = hy; b.add(hp); }
  return b;
}

function hangingSign(g: THREE.Group, boardCol: number): void {
  const wood = mat(0x5b4433);
  const post = new THREE.Mesh(cyl(0.035, 0.04, 0.92, 7), wood); post.position.set(0.84, 0.46, 0.86); post.castShadow = true;
  const arm = new THREE.Mesh(box(0.36, 0.045, 0.045), wood); arm.position.set(0.66, 0.84, 0.86);
  const board = new THREE.Mesh(box(0.28, 0.22, 0.03), mat(boardCol)); board.position.set(0.55, 0.66, 0.86); board.castShadow = true;
  g.add(post, arm, board);
}

function woodcutterYard(g: THREE.Group): void {
  addLogpile(g, false);
  const block = new THREE.Mesh(cyl(0.17, 0.19, 0.24, 10), mat(0x7a5230)); block.position.set(0.66, 0.12, 0.55); block.castShadow = true;
  const top = new THREE.Mesh(cyl(0.17, 0.17, 0.03, 10), mat(0xcaa06a)); top.position.set(0.66, 0.26, 0.55);
  const handle = new THREE.Mesh(cyl(0.018, 0.018, 0.34, 6), mat(0x6b4a2f)); handle.position.set(0.6, 0.44, 0.55); handle.rotation.z = 0.7;
  const blade = new THREE.Mesh(box(0.03, 0.13, 0.16), mat(0xc2c6cb)); blade.position.set(0.73, 0.57, 0.55); blade.rotation.z = 0.7;
  g.add(block, top, handle, blade);
}

function sawmillYard(g: THREE.Group): void {
  const plankMat = mat(0xd2a35c);
  for (let i = 0; i < 4; i++) { const p = new THREE.Mesh(box(0.72, 0.05, 0.26), plankMat); p.position.set(-0.72, 0.07 + i * 0.06, 0.42); p.rotation.y = 0.08 * (i % 2 ? 1 : -1); p.castShadow = true; g.add(p); }
  const buckMat = mat(0x6b4a2f);
  for (const sx of [-0.9, -0.5]) for (const rz of [0.35, -0.35]) { const leg = new THREE.Mesh(box(0.04, 0.42, 0.04), buckMat); leg.position.set(sx, 0.2, -0.5); leg.rotation.z = rz; g.add(leg); }
  const log = new THREE.Mesh(cyl(0.09, 0.09, 0.62, 8), mat(0x8a5a2b)); log.rotation.x = Math.PI / 2; log.position.set(-0.7, 0.42, -0.5); log.castShadow = true; g.add(log);
}

function foresterYard(g: THREE.Group): void {
  for (const [x, z] of [[0.72, 0.55], [0.9, 0.24], [0.55, 0.2]]) {
    const pot = new THREE.Mesh(cyl(0.09, 0.07, 0.12, 8), mat(0x8a5230)); pot.position.set(x, 0.06, z); pot.castShadow = true;
    const leaf = new THREE.Mesh(cone(0.1, 0.28, 7), mat(0x4e7a3a)); leaf.position.set(x, 0.28, z); leaf.castShadow = true;
    g.add(pot, leaf);
  }
  const shaft = new THREE.Mesh(cyl(0.016, 0.016, 0.52, 6), mat(0x6b4a2f)); shaft.position.set(-0.72, 0.32, 0.5); shaft.rotation.z = 0.4; g.add(shaft);
  const spade = new THREE.Mesh(box(0.12, 0.15, 0.025), mat(0x9aa0a3)); spade.position.set(-0.87, 0.09, 0.5); spade.rotation.z = 0.4; spade.castShadow = true; g.add(spade);
}

function bakeryYard(g: THREE.Group): void {
  const table = new THREE.Mesh(box(0.52, 0.05, 0.34), mat(0x8a6a44)); table.position.set(0.66, 0.34, 0.5); table.castShadow = true; g.add(table);
  const legMat = mat(0x6b4a2f);
  for (const [lx, lz] of [[0.46, 0.38], [0.86, 0.38], [0.46, 0.62], [0.86, 0.62]]) { const leg = new THREE.Mesh(box(0.04, 0.32, 0.04), legMat); leg.position.set(lx, 0.16, lz); g.add(leg); }
  for (const [lx, lz] of [[0.55, 0.45], [0.72, 0.5], [0.64, 0.56]]) { const loaf = new THREE.Mesh(sphere(0.075, 7, 6), mat(0xc9853e)); loaf.scale.set(1.5, 0.7, 1); loaf.position.set(lx, 0.4, lz); loaf.castShadow = true; g.add(loaf); }
  const sack = new THREE.Mesh(cyl(0.12, 0.14, 0.24, 7), mat(0xefe6d0)); sack.position.set(-0.72, 0.12, 0.5); sack.castShadow = true; g.add(sack);
}

function mintYard(g: THREE.Group): void {
  for (const [cx, cz, n] of [[0.66, 0.5, 5], [0.5, 0.42, 3], [0.78, 0.56, 4]]) for (let i = 0; i < n; i++) { const c = new THREE.Mesh(cyl(0.07, 0.07, 0.02, 10), mat(0xffd24a)); c.position.set(cx, 0.02 + i * 0.022, cz); g.add(c); }
  const anvil = new THREE.Mesh(box(0.26, 0.1, 0.14), mat(0x35353c)); anvil.position.set(-0.7, 0.3, 0.5); anvil.castShadow = true; g.add(anvil);
  const anvilBase = new THREE.Mesh(cyl(0.09, 0.11, 0.26, 8), mat(0x5b4433)); anvilBase.position.set(-0.7, 0.13, 0.5); g.add(anvilBase);
}

function wineryYard(g: THREE.Group): void {
  const b1 = barrel(0x6b3f26); b1.position.set(0.68, 0.16, 0.52); g.add(b1);
  const b2 = barrel(0x6b3f26); b2.position.set(0.86, 0.16, 0.28); g.add(b2);
  const b3 = barrel(0x6b3f26, 0.13, 0.28); b3.position.set(0.77, 0.46, 0.4); b3.rotation.z = Math.PI / 2; g.add(b3);
  const crate = new THREE.Mesh(box(0.3, 0.16, 0.24), mat(0x8a6a44)); crate.position.set(-0.7, 0.1, 0.5); crate.castShadow = true; g.add(crate);
  for (let i = 0; i < 6; i++) { const gr = new THREE.Mesh(sphere(0.045, 6, 5), mat(0x7a4b8a)); gr.position.set(-0.8 + (i % 3) * 0.09, 0.2, 0.44 + Math.floor(i / 3) * 0.1); g.add(gr); }
}

function butcherYard(g: THREE.Group): void {
  const rail = new THREE.Mesh(cyl(0.018, 0.018, 0.62, 6), mat(0x5b4433)); rail.rotation.z = Math.PI / 2; rail.position.set(0.62, 0.82, 0.9); g.add(rail);
  for (const hx of [0.4, 0.55, 0.7, 0.85]) { const link = new THREE.Mesh(capsule(0.032, 0.12, 3, 6), mat(0x9c4a2f)); link.position.set(hx, 0.68, 0.9); link.castShadow = true; g.add(link); }
  const block = new THREE.Mesh(cyl(0.16, 0.18, 0.24, 10), mat(0x7a5230)); block.position.set(-0.7, 0.12, 0.5); block.castShadow = true; g.add(block);
  const cleaver = new THREE.Mesh(box(0.03, 0.1, 0.16), mat(0xc2c6cb)); cleaver.position.set(-0.7, 0.3, 0.5); cleaver.rotation.z = 0.25; g.add(cleaver);
}

function tavernYard(g: THREE.Group): void {
  hangingSign(g, 0xb5763a);
  const b1 = barrel(0x7a5230); b1.position.set(-0.72, 0.16, 0.5); g.add(b1);
  const b2 = barrel(0x7a5230, 0.13, 0.26); b2.position.set(-0.7, 0.44, 0.5); b2.rotation.z = Math.PI / 2; g.add(b2);
  const bench = new THREE.Mesh(box(0.5, 0.04, 0.16), mat(0x6b4a2f)); bench.position.set(0.35, 0.18, 1.0); bench.castShadow = true; g.add(bench);
  for (const bx of [0.18, 0.52]) { const leg = new THREE.Mesh(box(0.04, 0.18, 0.14), mat(0x5b4433)); leg.position.set(bx, 0.09, 1.0); g.add(leg); }
  const lantern = new THREE.Mesh(sphere(0.06, 8, 7), mat(0xffd27a)); lantern.position.set(-0.08, 0.72, 0.9); g.add(lantern);
}

function fisheryYard(g: THREE.Group): void {
  const wood = mat(0x6b4a2f);
  for (const x of [0.5, 0.9]) { const post = new THREE.Mesh(cyl(0.03, 0.035, 0.7, 6), wood); post.position.set(x, 0.35, 0.55); post.castShadow = true; g.add(post); }
  const bar = new THREE.Mesh(box(0.44, 0.04, 0.04), wood); bar.position.set(0.7, 0.66, 0.55); g.add(bar);
  const net = new THREE.Mesh(box(0.4, 0.32, 0.02), stdMat({ color: 0xcfc7ad, transparent: true, opacity: 0.5 })); net.position.set(0.7, 0.46, 0.55); g.add(net);
  const crate = new THREE.Mesh(box(0.3, 0.14, 0.24), mat(0x8a6a44)); crate.position.set(-0.7, 0.09, 0.5); crate.castShadow = true; g.add(crate);
  for (const fz of [0.44, 0.56]) { const f = makeFish(); f.scale.setScalar(0.55); f.position.set(-0.7, 0.18, fz); f.rotation.z = 0.3; g.add(f); }
}

function farmYard(g: THREE.Group): void {
  const hay = new THREE.Group();
  const stack = new THREE.Mesh(cyl(0.26, 0.32, 0.38, 10), mat(0xd7bd63)); stack.position.y = 0.19; stack.castShadow = true;
  const top = new THREE.Mesh(cone(0.34, 0.3, 10), mat(0xc9a94e)); top.position.y = 0.52; top.castShadow = true;
  hay.add(stack, top); hay.position.set(0.92, 0, -0.55); g.add(hay);
  const sheafMat = mat(0xdcc25c);
  for (const [sx, sz, lean] of [[0.86, 0.42, 0.18], [0.64, 0.62, -0.22]]) {
    const sheaf = new THREE.Mesh(cone(0.13, 0.42, 6), sheafMat);
    sheaf.position.set(sx, 0.2, sz); sheaf.rotation.z = lean; sheaf.castShadow = true; g.add(sheaf);
    const band = new THREE.Mesh(cyl(0.075, 0.09, 0.05, 6), mat(0xa98d45));
    band.position.set(sx, 0.18, sz); band.rotation.z = lean; g.add(band);
  }
  const fenceMat = mat(0x8a6a44);
  for (let i = 0; i < 3; i++) {
    const post = new THREE.Mesh(box(0.06, 0.34, 0.06), fenceMat);
    post.position.set(-0.92, 0.17, -0.7 + i * 0.55); post.castShadow = true; g.add(post);
  }
  const rail1 = new THREE.Mesh(box(0.045, 0.05, 1.24), fenceMat);
  rail1.position.set(-0.92, 0.26, -0.15); g.add(rail1);
}

function vineyardYard(g: THREE.Group): void {
  const postMat = mat(0x6b4a2f);
  for (const z of [-0.4, 0.1, 0.6]) { const p = new THREE.Mesh(box(0.05, 0.38, 0.05), postMat); p.position.set(0.92, 0.19, z); p.castShadow = true; g.add(p); }
  const rail = new THREE.Mesh(box(0.05, 0.04, 1.1), postMat); rail.position.set(0.92, 0.36, 0.1); g.add(rail);
  for (const z of [-0.4, -0.15, 0.1, 0.35, 0.6]) { const gr = new THREE.Mesh(sphere(0.055, 6, 5), mat(0x7a4b8a)); gr.scale.y = 1.3; gr.position.set(0.9, 0.28, z); gr.castShadow = true; g.add(gr); }
  const b = barrel(0x6b3f26); b.position.set(-0.85, 0.16, 0.5); g.add(b);
}

function pigfarmYard(g: THREE.Group): void {
  const mud = new THREE.Mesh(cyl(0.5, 0.5, 0.03, 14), mat(0x6b4a34)); mud.position.set(0.68, 0.02, 0.2); g.add(mud);
  const fenceMat = mat(0x8a6a44);
  for (const [x, z] of [[0.28, -0.18], [0.68, -0.28], [1.06, -0.08], [1.08, 0.42], [0.75, 0.64], [0.33, 0.55]]) { const p = new THREE.Mesh(box(0.05, 0.26, 0.05), fenceMat); p.position.set(x, 0.13, z); p.castShadow = true; g.add(p); }
  for (const [px, pz] of [[0.58, 0.12], [0.86, 0.32]]) {
    const body = new THREE.Mesh(sphere(0.12, 8, 7), mat(0xe0a0a0)); body.scale.set(1.5, 0.9, 1); body.position.set(px, 0.12, pz); body.castShadow = true;
    const snout = new THREE.Mesh(sphere(0.05, 6, 5), mat(0xd48f8f)); snout.position.set(px + 0.16, 0.12, pz);
    g.add(body, snout);
  }
  const trough = new THREE.Mesh(box(0.26, 0.08, 0.12), mat(0x6b4a2f)); trough.position.set(0.42, 0.06, 0.42); g.add(trough);
}

function quarryYard(g: THREE.Group): void {
  const stoneMat = mat(0xb0b4b8);
  for (const [x, y, z] of [[-0.5, 0.1, 0.55], [-0.26, 0.1, 0.6], [-0.4, 0.28, 0.57]]) { const blk = new THREE.Mesh(box(0.24, 0.2, 0.24), stoneMat); blk.position.set(x, y, z); blk.rotation.y = rnd(); blk.castShadow = true; g.add(blk); }
  const handle = new THREE.Mesh(cyl(0.018, 0.018, 0.5, 6), mat(0x6b4a2f)); handle.position.set(0.55, 0.3, 0.6); handle.rotation.z = -0.5; g.add(handle);
  const head = new THREE.Mesh(box(0.28, 0.05, 0.05), mat(0x555a5e)); head.position.set(0.63, 0.52, 0.6); head.rotation.z = 0.3; g.add(head);
}

function minecart(g: THREE.Group, oreCol?: number): void {
  const body = new THREE.Mesh(box(0.4, 0.22, 0.3), mat(0x5b4433)); body.position.set(0.6, 0.22, 0.55); body.castShadow = true; g.add(body);
  for (const [wx, wz] of [[0.43, 0.42], [0.77, 0.42], [0.43, 0.68], [0.77, 0.68]]) { const w = new THREE.Mesh(cyl(0.07, 0.07, 0.04, 10), mat(0x2a2420)); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.09, wz); g.add(w); }
  if (oreCol != null) for (let i = 0; i < 4; i++) { const o = new THREE.Mesh(dodeca(0.07), mat(oreCol)); o.position.set(0.5 + rnd() * 0.2, 0.34, 0.45 + rnd() * 0.2); o.rotation.set(rnd(), rnd(), rnd()); g.add(o); }
}

// ---------- fully distinct trade architecture ----------
function gableRoof(g: THREE.Group, width: number, depth: number, y: number, color: number, ghost: boolean, steep = 0.58): void {
  const roofM = mkMat(color, ghost);
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(box(width * 0.62, 0.1, depth), roofM);
    // tilt the INNER edge up so the two panels meet at a ridge — the positive
    // sign raised the outer edges instead, leaving every roof an upside-down V
    panel.position.set(side * width * 0.22, y, 0); panel.rotation.z = -side * steep;
    panel.castShadow = !ghost; g.add(panel);
  }
}

function facadeWindow(g: THREE.Group, x: number, y: number, z: number, ghost: boolean, color = 0xf4d98a): void {
  const frame = new THREE.Mesh(box(0.3, 0.34, 0.06), mkMat(0x5b4433, ghost)); frame.position.set(x, y, z); frame.userData.marker = true;
  const pane = new THREE.Mesh(box(0.21, 0.25, 0.07), mkMat(color, ghost)); pane.position.set(x, y, z + 0.015); pane.userData.marker = true;
  g.add(frame, pane);
}

/** A low cabin assembled from visible round logs, with a deep woodland roof. */
function woodcutterHut(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), logs = mkMat(0x76502f, ghost), ends = mkMat(0xc69a62, ghost);
  for (let row = 0; row < 6; row++) for (const z of [-0.62, 0.62]) {
    const log = new THREE.Mesh(cyl(0.085, 0.085, 1.55, 8), logs); log.rotation.z = Math.PI / 2; log.position.set(0, 0.1 + row * 0.14, z); log.castShadow = !ghost; g.add(log);
  }
  for (const x of [-0.7, 0.7]) for (const z of [-0.64, 0.64]) {
    const cap = new THREE.Mesh(circle(0.087, 8), ends); cap.rotation.y = Math.PI / 2; cap.position.set(x, 0.45, z); cap.userData.marker = true; g.add(cap);
  }
  gableRoof(g, 1.9, 1.65, 1.13, def.roof, ghost, 0.68);
  const door = new THREE.Mesh(box(0.42, 0.62, 0.08), mkMat(0x3f2c20, ghost)); door.position.set(-0.32, 0.31, 0.69); door.userData.marker = true; g.add(door);
  if (!ghost) woodcutterYard(g);
  return g;
}

/** A ranger's lodge with stone plinth, green gable and sheltered planting porch. */
function foresterLodge(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const plinth = new THREE.Mesh(box(1.65, 0.22, 1.35), mkMat(0x8d897c, ghost)); plinth.position.y = 0.11; g.add(plinth);
  const hall = new THREE.Mesh(box(1.5, 0.86, 1.2), mkMat(def.wall, ghost)); hall.position.y = 0.62; hall.castShadow = !ghost; g.add(hall);
  gableRoof(g, 1.85, 1.55, 1.35, def.roof, ghost, 0.64);
  const porchRoof = new THREE.Mesh(box(1.0, 0.08, 0.58), mkMat(0x537448, ghost)); porchRoof.position.set(0.25, 0.88, 0.78); porchRoof.rotation.x = -0.18; g.add(porchRoof);
  for (const x of [-0.18, 0.68]) { const p = new THREE.Mesh(cyl(0.04, 0.05, 0.78, 7), mkMat(0x65472d, ghost)); p.position.set(x, 0.42, 0.93); g.add(p); }
  addDoor(g, ghost); facadeWindow(g, 0.48, 0.53, 0.62, ghost, 0xcde2a3);
  if (!ghost) foresterYard(g);
  return g;
}

/** An open-sided mill shed: timber frame, long roof and exposed circular saw. */
function sawmillBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), wood = mkMat(0x6a472b, ghost);
  const floor = new THREE.Mesh(box(1.85, 0.12, 1.45), mkMat(def.wall, ghost)); floor.position.y = 0.06; g.add(floor);
  for (const x of [-0.76, 0.76]) for (const z of [-0.56, 0.56]) { const post = new THREE.Mesh(box(0.12, 1.25, 0.12), wood); post.position.set(x, 0.68, z); post.castShadow = !ghost; g.add(post); }
  gableRoof(g, 2.05, 1.75, 1.48, def.roof, ghost, 0.42);
  const bench = new THREE.Mesh(box(1.35, 0.12, 0.45), mkMat(0xd2a35c, ghost)); bench.position.set(0, 0.55, 0.05); g.add(bench);
  const blade = new THREE.Mesh(cyl(0.34, 0.34, 0.045, 18), mkMat(0xc6ccd4, ghost)); blade.rotation.x = Math.PI / 2; blade.position.set(0.15, 0.86, 0.05); blade.userData.marker = true; g.add(blade);
  const hub = new THREE.Mesh(cyl(0.07, 0.07, 0.08, 10), mkMat(0x44484d, ghost)); hub.rotation.x = Math.PI / 2; hub.position.set(0.15, 0.86, 0.05); hub.userData.marker = true; g.add(hub);
  if (!ghost) sawmillYard(g);
  return g;
}

/** A whitewashed bakehouse dominated by a brick oven and broad smoking stack. */
function bakeryBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const house = new THREE.Mesh(box(1.48, 0.9, 1.35), mkMat(def.wall, ghost)); house.position.y = 0.45; house.castShadow = !ghost; g.add(house);
  gableRoof(g, 1.78, 1.62, 1.18, def.roof, ghost, 0.6);
  const oven = new THREE.Mesh(sphere(0.48, 10, 7), mkMat(0x9a6043, ghost)); oven.scale.set(1, 0.72, 0.7); oven.position.set(0.67, 0.32, 0.54); oven.castShadow = !ghost; g.add(oven);
  const mouth = new THREE.Mesh(box(0.28, 0.28, 0.08), mkMat(0x2a211b, ghost)); mouth.position.set(0.67, 0.23, 0.89); mouth.userData.marker = true; g.add(mouth);
  addDoor(g, ghost); addChimney(g, ghost); facadeWindow(g, 0.3, 0.58, 0.69, ghost);
  if (!ghost) bakeryYard(g);
  return g;
}

/** A compact civic mint: dressed stone, classical pediment and coin seal. */
function mintBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), trim = mkMat(0xe3d7b8, ghost);
  const base = new THREE.Mesh(box(1.65, 1.15, 1.35), mkMat(def.wall, ghost)); base.position.y = 0.58; base.castShadow = !ghost; g.add(base);
  const cap = new THREE.Mesh(box(1.78, 0.13, 1.48), trim); cap.position.y = 1.18; cap.userData.marker = true; g.add(cap);
  gableRoof(g, 1.82, 1.5, 1.52, def.roof, ghost, 0.42);
  for (const x of [-0.55, 0.55]) { const col = new THREE.Mesh(cyl(0.07, 0.08, 0.92, 10), trim); col.position.set(x, 0.48, 0.74); col.userData.marker = true; g.add(col); }
  const seal = new THREE.Mesh(cyl(0.18, 0.18, 0.055, 16), mkMat(0xffd24a, ghost)); seal.rotation.x = Math.PI / 2; seal.position.set(0, 0.82, 0.72); seal.userData.marker = true; g.add(seal);
  addDoor(g, ghost); if (!ghost) mintYard(g);
  return g;
}

/** A pale vineyard villa with purple roof and a grape-laden pergola. */
function vineyardHouse(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const villa = new THREE.Mesh(box(1.55, 0.88, 1.22), mkMat(0xd5c39d, ghost)); villa.position.y = 0.44; villa.castShadow = !ghost; g.add(villa);
  gableRoof(g, 1.85, 1.5, 1.18, def.roof, ghost, 0.5);
  const wood = mkMat(0x65472d, ghost);
  for (const x of [-0.75, -0.25, 0.25, 0.75]) { const p = new THREE.Mesh(cyl(0.035, 0.04, 0.78, 6), wood); p.position.set(x, 0.39, 0.83); g.add(p); }
  const pergola = new THREE.Mesh(box(1.65, 0.06, 0.6), wood); pergola.position.set(0, 0.78, 0.82); g.add(pergola);
  if (!ghost) { vineyardYard(g); for (const x of [-0.55, 0, 0.55]) { const bunch = new THREE.Mesh(sphere(0.09, 7, 6), mat(0x7a4b8a)); bunch.scale.y = 1.35; bunch.position.set(x, 0.69, 0.86); g.add(bunch); } }
  return g;
}

/** A deep wine cellar with stepped gable, cool stone base and barrel doors. */
function wineryBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), stone = mkMat(0x81786b, ghost);
  const cellar = new THREE.Mesh(box(1.72, 0.95, 1.45), mkMat(def.wall, ghost)); cellar.position.y = 0.48; cellar.castShadow = !ghost; g.add(cellar);
  const plinth = new THREE.Mesh(box(1.82, 0.2, 1.55), stone); plinth.position.y = 0.1; g.add(plinth);
  gableRoof(g, 2.0, 1.72, 1.27, def.roof, ghost, 0.7);
  for (const [w, y] of [[1.05, 1.0], [0.72, 1.18], [0.4, 1.36]]) { const step = new THREE.Mesh(box(w, 0.2, 0.12), mkMat(def.wall, ghost)); step.position.set(0, y, 0.78); g.add(step); }
  const doors = new THREE.Mesh(box(0.64, 0.64, 0.09), mkMat(0x573722, ghost)); doors.position.set(0, 0.32, 0.77); doors.userData.marker = true; g.add(doors);
  if (!ghost) wineryYard(g);
  return g;
}

/** A red livestock barn with a tall hayloft and attached open pig shelter. */
function pigBarn(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const barn = new THREE.Mesh(box(1.45, 1.05, 1.3), mkMat(0xb86a62, ghost)); barn.position.set(-0.16, 0.53, -0.12); barn.castShadow = !ghost; g.add(barn);
  gableRoof(g, 1.72, 1.55, 1.38, def.roof, ghost, 0.72);
  const loft = new THREE.Mesh(box(0.42, 0.38, 0.07), mkMat(0x4d3425, ghost)); loft.position.set(-0.16, 0.86, 0.56); loft.userData.marker = true; g.add(loft);
  const lean = new THREE.Mesh(box(0.82, 0.08, 1.05), mkMat(0x8f5d45, ghost)); lean.position.set(0.77, 0.72, -0.05); lean.rotation.z = -0.28; g.add(lean);
  for (const z of [-0.45, 0.36]) { const p = new THREE.Mesh(box(0.08, 0.65, 0.08), mkMat(0x67452c, ghost)); p.position.set(0.98, 0.34, z); g.add(p); }
  if (!ghost) pigfarmYard(g);
  return g;
}

/** A market butchery with tiled roof, striped awning and smokehouse stack. */
function butcherShop(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const shop = new THREE.Mesh(box(1.5, 1.0, 1.3), mkMat(def.wall, ghost)); shop.position.y = 0.5; shop.castShadow = !ghost; g.add(shop);
  gableRoof(g, 1.8, 1.55, 1.28, def.roof, ghost, 0.55); addChimney(g, ghost);
  const awning = new THREE.Mesh(box(1.05, 0.08, 0.5), mkMat(0xefe0c7, ghost)); awning.position.set(0.18, 0.75, 0.82); awning.rotation.x = -0.25; awning.userData.marker = true; g.add(awning);
  for (const x of [-0.18, 0.18, 0.54]) { const stripe = new THREE.Mesh(box(0.13, 0.085, 0.51), mkMat(0x9c4a2f, ghost)); stripe.position.set(x, 0.75, 0.82); stripe.rotation.x = -0.25; stripe.userData.marker = true; g.add(stripe); }
  addDoor(g, ghost); if (!ghost) butcherYard(g);
  return g;
}

/** A stilted waterside hut with a blue roof, landing deck and hanging net. */
function fisheryHut(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), wood = mkMat(0x6d5034, ghost);
  for (const x of [-0.62, 0.62]) for (const z of [-0.5, 0.5]) { const stilt = new THREE.Mesh(cyl(0.055, 0.07, 0.75, 7), wood); stilt.position.set(x, 0.38, z); g.add(stilt); }
  const deck = new THREE.Mesh(box(1.75, 0.12, 1.5), wood); deck.position.y = 0.62; g.add(deck);
  const hut = new THREE.Mesh(box(1.35, 0.75, 1.05), mkMat(def.wall, ghost)); hut.position.set(-0.12, 1.02, -0.1); hut.castShadow = !ghost; g.add(hut);
  gableRoof(g, 1.65, 1.32, 1.55, def.roof, ghost, 0.55);
  const pier = new THREE.Mesh(box(0.55, 0.1, 1.15), wood); pier.position.set(0.62, 0.58, 1.05); g.add(pier);
  facadeWindow(g, 0.28, 1.08, 0.44, ghost, 0xb8e2e8);
  if (!ghost) fisheryYard(g);
  return g;
}

/** An open-fronted forge with black hearth, oversized brick stack and weapon rack. */
function smithyBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const forge = new THREE.Mesh(box(1.65, 0.88, 1.35), mkMat(def.wall, ghost)); forge.position.y = 0.44; forge.castShadow = !ghost; g.add(forge);
  gableRoof(g, 1.95, 1.6, 1.18, def.roof, ghost, 0.45);
  const hearth = new THREE.Mesh(box(0.78, 0.58, 0.12), mkMat(0x252329, ghost)); hearth.position.set(0.28, 0.3, 0.71); hearth.userData.marker = true; g.add(hearth);
  const fire = new THREE.Mesh(cone(0.14, 0.32, 7), mkMat(0xe88335, ghost)); fire.position.set(0.28, 0.2, 0.8); fire.userData.marker = true; g.add(fire);
  const stack = new THREE.Mesh(box(0.38, 1.35, 0.42), mkMat(0x6a5550, ghost)); stack.position.set(-0.55, 1.15, -0.32); stack.castShadow = !ghost; g.add(stack);
  if (!ghost) { mintYard(g); for (const x of [0.65, 0.82]) { const sword = new THREE.Mesh(box(0.035, 0.65, 0.05), mat(0xc6ccd4)); sword.position.set(x, 0.52, 0.74); sword.rotation.z = x === 0.65 ? 0.45 : -0.45; g.add(sword); } }
  return g;
}

/** A fortified armorer's workshop with parapet, shield racks and narrow windows. */
function armoryBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), stone = mkMat(def.wall, ghost), trim = mkMat(0x666e78, ghost);
  const hall = new THREE.Mesh(box(1.65, 1.15, 1.45), stone); hall.position.y = 0.58; hall.castShadow = !ghost; g.add(hall);
  const top = new THREE.Mesh(box(1.78, 0.12, 1.58), trim); top.position.y = 1.2; g.add(top);
  for (const x of [-0.7, -0.24, 0.24, 0.7]) { const merlon = new THREE.Mesh(box(0.24, 0.28, 0.18), trim); merlon.position.set(x, 1.4, 0.68); g.add(merlon); }
  const gate = new THREE.Mesh(box(0.46, 0.68, 0.09), mkMat(0x3d3026, ghost)); gate.position.set(0, 0.34, 0.74); gate.userData.marker = true; g.add(gate);
  for (const x of [-0.53, 0.53]) { const shield = new THREE.Mesh(cyl(0.18, 0.18, 0.045, 8), mkMat(def.accent ?? 0x7d8794, ghost)); shield.rotation.x = Math.PI / 2; shield.position.set(x, 0.68, 0.76); shield.scale.y = 1.2; shield.userData.marker = true; g.add(shield); }
  return g;
}

/** An excavated stone works with cut terraces, lifting crane and block yard. */
function quarryBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), rock = mkMat(def.wall, ghost), cut = mkMat(0xc4cace, ghost), wood = mkMat(0x6b4a2f, ghost);
  for (const [r, y, x] of [[0.95, 0.18, -0.1], [0.72, 0.38, -0.25], [0.48, 0.58, -0.42]] as [number, number, number][]) { const step = new THREE.Mesh(dodeca(r), rock); step.scale.y = 0.42; step.position.set(x, y, -0.25); step.castShadow = !ghost; g.add(step); }
  const mast = new THREE.Mesh(cyl(0.06, 0.08, 1.7, 8), wood); mast.position.set(0.62, 0.85, 0.1); g.add(mast);
  const jib = new THREE.Mesh(box(1.05, 0.08, 0.08), wood); jib.position.set(0.18, 1.55, 0.1); jib.rotation.z = -0.15; g.add(jib);
  const rope = new THREE.Mesh(cyl(0.012, 0.012, 0.8, 5), mkMat(0x40362c, ghost)); rope.position.set(-0.25, 1.05, 0.1); rope.userData.marker = true; g.add(rope);
  const load = new THREE.Mesh(box(0.28, 0.25, 0.28), cut); load.position.set(-0.25, 0.62, 0.1); g.add(load);
  if (!ghost) quarryYard(g);
  return g;
}

/** A true military barracks: gatehouse, curtain walls, four turrets and yard. */
function barracksBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), stone = mkMat(def.wall, ghost), roofM = mkMat(def.roof, ghost), wood = mkMat(0x443327, ghost);
  const hall = new THREE.Mesh(box(1.25, 1.15, 1.15), stone); hall.position.set(0, 0.58, -0.25); hall.castShadow = !ghost; g.add(hall);
  gableRoof(g, 1.48, 1.38, 1.48, def.roof, ghost, 0.62);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const tower = new THREE.Mesh(cyl(0.23, 0.27, 1.25, 8), stone); tower.position.set(sx * 0.73, 0.63, sz * 0.65); tower.castShadow = !ghost; g.add(tower); const cap = new THREE.Mesh(cone(0.31, 0.46, 8), roofM); cap.position.set(sx * 0.73, 1.48, sz * 0.65); g.add(cap); }
  for (const x of [-0.4, 0, 0.4]) { const crenel = new THREE.Mesh(box(0.24, 0.24, 0.18), stone); crenel.position.set(x, 1.1, 0.72); g.add(crenel); }
  const gate = new THREE.Mesh(box(0.52, 0.72, 0.14), wood); gate.position.set(0, 0.36, 0.75); gate.userData.marker = true; g.add(gate);
  if (!ghost) { const rack = new THREE.Mesh(box(0.62, 0.08, 0.08), mat(0x65472d)); rack.position.set(0, 0.72, 0.83); g.add(rack); for (const x of [-0.22, 0, 0.22]) { const spear = new THREE.Mesh(cyl(0.014, 0.014, 0.75, 5), mat(0x6b4a2f)); spear.position.set(x, 0.55, 0.86); g.add(spear); } }
  return g;
}

/** A tall timber observation tower with splayed legs, braces and roofed platform. */
function woodenWatchtower(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), wood = mkMat(0x67472e, ghost), dark = mkMat(0x493323, ghost);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const leg = new THREE.Mesh(cyl(0.075, 0.1, 2.15, 7), wood); leg.position.set(sx * 0.48, 1.05, sz * 0.48); leg.rotation.z = -sx * 0.08; leg.rotation.x = sz * 0.08; leg.castShadow = !ghost; g.add(leg); }
  for (const y of [0.55, 1.15]) for (const z of [-0.5, 0.5]) { const brace = new THREE.Mesh(box(1.3, 0.07, 0.07), dark); brace.position.set(0, y, z); brace.rotation.z = y < 1 ? 0.55 : -0.55; g.add(brace); }
  const deck = new THREE.Mesh(box(1.45, 0.14, 1.45), wood); deck.position.y = 2.0; g.add(deck);
  const cabin = new THREE.Mesh(box(1.15, 0.62, 1.15), mkMat(def.wall, ghost)); cabin.position.y = 2.34; cabin.castShadow = !ghost; g.add(cabin);
  for (const x of [-0.38, 0, 0.38]) { const slit = new THREE.Mesh(box(0.18, 0.18, 0.06), mkMat(0x23201e, ghost)); slit.position.set(x, 2.38, 0.59); slit.userData.marker = true; g.add(slit); }
  const roof = new THREE.Mesh(cone(0.96, 0.68, 4), mkMat(def.roof, ghost)); roof.position.y = 2.98; roof.rotation.y = Math.PI / 4; roof.castShadow = !ghost; g.add(roof);
  const ladder = new THREE.Mesh(box(0.42, 1.75, 0.05), dark); ladder.position.set(0, 0.95, 0.65); ladder.rotation.x = -0.12; g.add(ladder);
  return g;
}

/** Enemy counterpart: a squat armored stone tower with a crenellated crown. */
function stoneWatchtower(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), stone = mkMat(def.wall, ghost), trim = mkMat(def.roof, ghost);
  const shaft = new THREE.Mesh(box(1.15, 2.15, 1.15), stone); shaft.position.y = 1.08; shaft.castShadow = !ghost; g.add(shaft);
  const crown = new THREE.Mesh(box(1.42, 0.25, 1.42), trim); crown.position.y = 2.18; g.add(crown);
  for (const x of [-0.52, 0, 0.52]) for (const z of [-0.64, 0.64]) { const m = new THREE.Mesh(box(0.24, 0.34, 0.2), trim); m.position.set(x, 2.48, z); g.add(m); }
  for (const y of [0.75, 1.35]) { const slit = new THREE.Mesh(box(0.1, 0.35, 0.06), mkMat(0x211c1c, ghost)); slit.position.set(0, y, 0.59); slit.userData.marker = true; g.add(slit); }
  return g;
}

/** A rough raider encampment of hide tents, palisade stakes and a cook fire. */
function banditCamp(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), hide = mkMat(def.wall, ghost), wood = mkMat(0x4d3425, ghost);
  for (const [x, z, s] of [[-0.38, -0.2, 1], [0.48, 0.25, 0.72]] as [number, number, number][]) { const tent = new THREE.Mesh(cone(0.7 * s, 1.25 * s, 4), hide); tent.position.set(x, 0.62 * s, z); tent.rotation.y = Math.PI / 4; tent.castShadow = !ghost; g.add(tent); const flap = new THREE.Mesh(cone(0.2 * s, 0.5 * s, 3), mkMat(0x251c17, ghost)); flap.position.set(x, 0.25 * s, z + 0.5 * s); flap.rotation.x = -Math.PI / 2; flap.userData.marker = true; g.add(flap); }
  for (let i = 0; i < 9; i++) { const a = -1.2 + i * 0.3; const stake = new THREE.Mesh(cone(0.08, 0.9, 5), wood); stake.position.set(a, 0.45, -0.82 + Math.abs(a) * 0.16); g.add(stake); }
  if (!ghost) { const fire = new THREE.Mesh(cone(0.16, 0.42, 7), mat(0xe06432)); fire.position.set(0.15, 0.21, 0.85); g.add(fire); for (const r of [-0.18, 0.18]) { const log = new THREE.Mesh(cyl(0.05, 0.05, 0.55, 7), mat(0x5b3824)); log.rotation.z = Math.PI / 2; log.rotation.y = r; log.position.set(0.15, 0.07, 0.85); g.add(log); } }
  return g;
}

// ---------- cottage (woodcutter, forester, sawmill, bakery, mint) ----------
function cottage(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(box(1.7, 0.95, 1.7), mkMat(def.wall, ghost));
  base.position.y = 0.475; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  const roof = new THREE.Mesh(cone(1.42, 0.9, 4), mkMat(def.roof, ghost));
  roof.position.y = 1.4; roof.rotation.y = Math.PI / 4; roof.castShadow = !ghost; g.add(roof);
  // little gable-end window
  const win = new THREE.Mesh(box(0.28, 0.28, 0.05), mkMat(0xf0e6c2, ghost));
  win.position.set(0.45, 0.6, 0.86); win.userData.marker = true; g.add(win);
  addDoor(g, ghost);
  // ovens, mints, smokehouses & taverns get a smoking chimney
  const out = def.recipe?.out;
  if (out === 'bread' || out === 'coin' || out === 'sausage' || def.tavern) addChimney(g, ghost);
  // each trade gets its own little yard of props once actually built
  if (!ghost) {
    if (def.gather?.node === 'tree') woodcutterYard(g);
    else if (def.gather?.node === 'plant') foresterYard(g);
    else if (def.gather?.node === 'fish') fisheryYard(g);
    else if (out === 'timber') sawmillYard(g);
    else if (out === 'bread') bakeryYard(g);
    else if (out === 'coin') mintYard(g);
    else if (out === 'wine') wineryYard(g);
    else if (out === 'sausage') butcherYard(g);
    else if (def.tavern) tavernYard(g);
  }
  return g;
}

// ---------- tavern — a wide half-timbered inn with an outdoor table ----------
function tavern(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  // a long inn hall, wider than a cottage and set back to leave a front yard
  const base = new THREE.Mesh(box(1.8, 1.0, 1.2), mkMat(def.wall, ghost));
  base.position.set(0, 0.5, -0.28); base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  // dark half-timber framing across the front
  const beam = mkMat(0x5b4433, ghost);
  for (const x of [-0.6, 0, 0.6]) { const b = new THREE.Mesh(box(0.07, 1.0, 0.06), beam); b.position.set(x, 0.5, 0.33); b.userData.marker = true; g.add(b); }
  const rail = new THREE.Mesh(box(1.8, 0.07, 0.06), beam); rail.position.set(0, 0.74, 0.33); rail.userData.marker = true; g.add(rail);
  // wide hip roof
  const roof = new THREE.Mesh(cone(1.55, 0.9, 4), mkMat(def.roof, ghost));
  roof.position.set(0, 1.44, -0.28); roof.rotation.y = Math.PI / 4; roof.scale.z = 0.82; roof.castShadow = !ghost; g.add(roof);
  // door + two lit windows
  const door = new THREE.Mesh(box(0.4, 0.62, 0.09), mkMat(0x4a3626, ghost)); door.position.set(0, 0.31, 0.33); door.userData.marker = true; g.add(door);
  for (const x of [-0.62, 0.62]) { const w = new THREE.Mesh(box(0.3, 0.3, 0.05), mkMat(0xf4d98a, ghost)); w.position.set(x, 0.56, 0.33); w.userData.marker = true; g.add(w); }
  addChimney(g, ghost);
  if (!ghost) tavernTable(g);
  return g;
}

/** An open table with benches, mugs and a barrel beside the tavern (extended side). */
function tavernTable(g: THREE.Group): void {
  const wood = mat(0x8a5a2b), dark = mat(0x5b4433);
  const tx = 1.15;           // out on the extended (+X) side of the inn
  const cz = -0.1;           // roughly level with the hall
  // table runs along Z beside the building
  const top = new THREE.Mesh(box(0.5, 0.06, 0.95), wood); top.position.set(tx, 0.36, cz); top.castShadow = true; g.add(top);
  for (const dx of [-0.18, 0.18]) for (const dz of [-0.4, 0.4]) { const leg = new THREE.Mesh(box(0.06, 0.36, 0.06), dark); leg.position.set(tx + dx, 0.18, cz + dz); g.add(leg); }
  for (const dx of [-0.42, 0.42]) { const bench = new THREE.Mesh(box(0.16, 0.05, 0.95), wood); bench.position.set(tx + dx, 0.22, cz); bench.castShadow = true; g.add(bench); }
  // mugs & a jug scattered on the table
  for (const dz of [-0.32, -0.02, 0.3]) { const mug = new THREE.Mesh(cyl(0.045, 0.05, 0.1, 7), mat(0xcaa06a)); mug.position.set(tx + (rnd() - 0.5) * 0.2, 0.44, cz + dz); g.add(mug); }
  const jug = new THREE.Mesh(cyl(0.06, 0.08, 0.16, 8), mat(0x7a5230)); jug.position.set(tx - 0.08, 0.47, cz + 0.14); g.add(jug);
  // a barrel at the near corner of the extended side
  const barrel = new THREE.Mesh(cyl(0.16, 0.16, 0.34, 10), mat(0x7a5230)); barrel.position.set(tx + 0.05, 0.17, 0.72); barrel.castShadow = true; g.add(barrel);
  for (const y of [0.06, 0.28]) { const hoop = new THREE.Mesh(torus(0.16, 0.015, 5, 10), mat(0x3a2a20)); hoop.rotation.x = Math.PI / 2; hoop.position.set(tx + 0.05, y, 0.72); g.add(hoop); }
}

// ---------- windmill (mill) — rotating sails ----------
function windmill(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(cyl(0.55, 0.85, 1.7, 12), mkMat(def.wall, ghost));
  tower.position.y = 0.85; tower.castShadow = !ghost; tower.receiveShadow = !ghost; g.add(tower);
  const cap = new THREE.Mesh(cone(0.66, 0.55, 12), mkMat(def.roof, ghost));
  cap.position.y = 1.98; cap.castShadow = !ghost; g.add(cap);
  const balcony = new THREE.Mesh(cyl(0.92, 0.92, 0.08, 12), mkMat(0x6b4a2f, ghost));
  balcony.position.y = 0.55; balcony.userData.marker = true; g.add(balcony);
  const door = new THREE.Mesh(box(0.32, 0.55, 0.1), mkMat(0x4a3626, ghost));
  door.position.set(0, 0.28, 0.8); door.userData.marker = true; g.add(door);

  // sail cross — a child group so it inherits building rotation, spun around local Z
  const blades = new THREE.Group();
  blades.position.set(0, 1.75, 0.72);
  const hub = new THREE.Mesh(sphere(0.1, 8, 6), mkMat(0x5b4a34, ghost)); hub.userData.marker = true; blades.add(hub);
  const sparMat = mkMat(0x6b4a2f, ghost);
  const sailMat = mkMat(ghost ? def.wall : 0xefe6d0, ghost);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2; arm.userData.marker = true;
    const spar = new THREE.Mesh(box(0.06, 1.05, 0.06), sparMat); spar.position.y = 0.55; arm.add(spar);
    const sail = new THREE.Mesh(box(0.26, 0.82, 0.02), sailMat); sail.position.set(0.18, 0.6, 0); arm.add(sail);
    blades.add(arm);
  }
  blades.userData.marker = true;
  blades.userData.dynamic = true; // spun every frame — must keep auto matrix updates
  g.add(blades);
  g.userData.spin = blades; // View turns this each frame
  return g;
}

// ---------- farmhouse (farm) — hipped thatch, timbered walls, working yard ----------
function farmhouse(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  // long low hall — plastered walls over a timber frame
  const base = new THREE.Mesh(box(1.85, 0.78, 1.5), mkMat(def.wall, ghost));
  base.position.y = 0.39; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  const beamMat = mkMat(0x6b4a2f, ghost);
  for (const bx of [-0.68, -0.12, 0.35, 0.8]) {
    const beam = new THREE.Mesh(box(0.07, 0.78, 0.05), beamMat);
    beam.position.set(bx, 0.39, 0.76); beam.userData.marker = true; g.add(beam);
  }
  const rail = new THREE.Mesh(box(1.85, 0.08, 0.05), beamMat);
  rail.position.set(0, 0.71, 0.76); rail.userData.marker = true; g.add(rail);
  // a small shuttered window between the beams
  const win = new THREE.Mesh(box(0.3, 0.26, 0.05), mkMat(0xf0e6c2, ghost));
  win.position.set(0.58, 0.42, 0.77); win.userData.marker = true; g.add(win);
  // deep hipped thatch with a generous overhang — sits snug on the walls,
  // no ridge beam (geometry pre-rotated 45° so the mesh can be squashed in z)
  const thatchGeo = cachedGeo('farm-thatch', () => {
    const g2 = new THREE.ConeGeometry(1.52, 1.05, 4);
    g2.rotateY(Math.PI / 4); // pre-rotate so the mesh can be squashed in z
    return g2;
  });
  const thatch = new THREE.Mesh(thatchGeo, mkMat(0xcaab5c, ghost));
  thatch.position.y = 1.3; thatch.scale.z = 0.84; thatch.castShadow = !ghost; g.add(thatch);
  addDoor(g, ghost);
  // the working yard differs by trade: wheat farm, grape vineyard or pig farm
  if (!ghost) {
    if (def.gather?.out === 'meat') pigfarmYard(g);
    else if (def.gather?.out === 'grape') vineyardYard(g);
    else farmYard(g);
  }
  return g;
}

// ---------- field crops — wheat stalks that rise as the plot ripens ----------
const geoStalk = cyl(0.012, 0.02, 0.32, 4);
const geoEar = cyl(0.03, 0.018, 0.12, 5);
export type CropKind = 'wheat' | 'grape' | 'pasture';
/** A tile's worth of crop: 3×3 jittered bundles keyed to the plot's produce.
 *  The View scales the group's y with growth so young plots read as low shoots,
 *  ripe ones as tall grain / laden vines / lush pasture. */
export function makeFieldCrop(kind: CropKind = 'wheat'): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'grape') {
    const vineMat = mat(0x4e6d33), grapeMat = mat(0x7a4b8a);
    for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 3; rx++) {
      const px = (rx - 1) * 0.3 + (rnd() - 0.5) * 0.1;
      const pz = (ry - 1) * 0.3 + (rnd() - 0.5) * 0.1;
      const vine = new THREE.Mesh(geoStalk, vineMat); vine.position.set(px, 0.16, pz); g.add(vine);
      const bunch = new THREE.Mesh(sphere(0.075, 6, 5), grapeMat); bunch.scale.y = 1.3; bunch.position.set(px, 0.34, pz); g.add(bunch);
    }
    return g;
  }
  if (kind === 'pasture') {
    const grassMat = mat(0x6fae52), tuftMat = mat(0x87c266);
    for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 3; rx++) {
      const px = (rx - 1) * 0.3 + (rnd() - 0.5) * 0.16;
      const pz = (ry - 1) * 0.3 + (rnd() - 0.5) * 0.16;
      const blade = new THREE.Mesh(cone(0.06, 0.22, 5), rnd() < 0.5 ? grassMat : tuftMat);
      blade.position.set(px, 0.11, pz); blade.rotation.z = (rnd() - 0.5) * 0.3; g.add(blade);
    }
    return g;
  }
  const stalkMat = mat(0xb5a04a), earMat = mat(0xe0c25c);
  for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 3; rx++) {
    const px = (rx - 1) * 0.3 + (rnd() - 0.5) * 0.12;
    const pz = (ry - 1) * 0.3 + (rnd() - 0.5) * 0.12;
    const tilt = (rnd() - 0.5) * 0.2;
    const stalk = new THREE.Mesh(geoStalk, stalkMat);
    stalk.position.set(px, 0.16, pz); stalk.rotation.z = tilt;
    const ear = new THREE.Mesh(geoEar, earMat);
    ear.position.set(px - Math.sin(tilt) * 0.36, 0.38, pz); ear.rotation.z = tilt;
    g.add(stalk, ear);
  }
  return g;
}

// ---------- pig — little & big grazers for pig-farm pastures ----------
export function makePig(big = false): THREE.Group {
  const g = new THREE.Group();
  const pink = mat(0xe0a0a0), snoutMat = mat(0xd48f8f), ink = mat(0x2a2018);
  const body = new THREE.Mesh(sphere(0.12, 8, 7), pink); body.scale.set(1.7, 0.95, 1.05); body.position.y = 0.14; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(sphere(0.088, 8, 7), pink); head.position.set(0.2, 0.16, 0); head.castShadow = true; g.add(head);
  const snout = new THREE.Mesh(cyl(0.042, 0.048, 0.05, 8), snoutMat); snout.rotation.z = Math.PI / 2; snout.position.set(0.29, 0.14, 0); g.add(snout);
  for (const ez of [0.045, -0.045]) {
    const ear = new THREE.Mesh(cone(0.03, 0.05, 4), pink); ear.position.set(0.19, 0.25, ez); g.add(ear);
    const eye = new THREE.Mesh(sphere(0.014, 5, 4), ink); eye.position.set(0.25, 0.19, ez); g.add(eye);
  }
  for (const [lx, lz] of [[0.11, 0.07], [0.11, -0.07], [-0.11, 0.07], [-0.11, -0.07]]) {
    const leg = new THREE.Mesh(cyl(0.022, 0.022, 0.1, 5), pink); leg.position.set(lx, 0.05, lz); g.add(leg);
  }
  const tail = new THREE.Mesh(torus(0.028, 0.009, 5, 8, Math.PI * 1.6), snoutMat); tail.position.set(-0.2, 0.17, 0); tail.rotation.y = Math.PI / 2; g.add(tail);
  g.scale.setScalar(big ? 1.3 : 0.82);
  return g;
}

// ---------- ambient critters — sparse wildlife that makes the meadow breathe ----------
export type CritterKind = 'rabbit' | 'fox' | 'hedgehog' | 'mouse' | 'duck' | 'cat' | 'frog'
  | 'deer' | 'squirrel' | 'marmot' | 'ibex'
  | 'sheep' | 'gull' | 'heron' | 'seal';
export const CRITTER_KINDS: CritterKind[] = ['rabbit', 'fox', 'hedgehog', 'mouse', 'duck'];

/** A tiny cosmetic animal. All face +x (like the pig) so movers can share the
 *  same steering; `hops` tells the View to bounce it while it travels. */
export function makeCritter(kind: CritterKind): { group: THREE.Group; hops: boolean } {
  const g = new THREE.Group();
  const ink = mat(0x2a2018);
  let hops = false;
  if (kind === 'rabbit') {
    hops = true;
    const fur = mat(rnd() < 0.4 ? 0xd9cfc0 : 0xa88d6d);
    const body = new THREE.Mesh(sphere(0.09, 8, 7), fur); body.scale.set(1.25, 1, 1); body.position.y = 0.09; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.06, 8, 7), fur); head.position.set(0.1, 0.16, 0); g.add(head);
    for (const ez of [0.028, -0.028]) {
      const ear = new THREE.Mesh(cyl(0.012, 0.018, 0.11, 5), fur); ear.position.set(0.08, 0.27, ez); ear.rotation.x = ez * 4; g.add(ear);
      const eye = new THREE.Mesh(sphere(0.011, 5, 4), ink); eye.position.set(0.145, 0.17, ez + Math.sign(ez) * 0.015); g.add(eye);
    }
    const tail = new THREE.Mesh(sphere(0.03, 6, 5), mat(0xf0ead9)); tail.position.set(-0.11, 0.1, 0); g.add(tail);
  } else if (kind === 'fox') {
    const red = mat(0xc26a35), cream = mat(0xe8d9c0);
    const body = new THREE.Mesh(sphere(0.1, 8, 7), red); body.scale.set(1.8, 0.9, 0.85); body.position.y = 0.12; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.065, 8, 7), red); head.position.set(0.19, 0.17, 0); g.add(head);
    const muzzle = new THREE.Mesh(cone(0.03, 0.09, 6), cream); muzzle.rotation.z = -Math.PI / 2; muzzle.position.set(0.27, 0.15, 0); g.add(muzzle);
    for (const ez of [0.035, -0.035]) {
      const ear = new THREE.Mesh(cone(0.022, 0.06, 4), red); ear.position.set(0.17, 0.25, ez); g.add(ear);
      const eye = new THREE.Mesh(sphere(0.011, 5, 4), ink); eye.position.set(0.24, 0.19, ez); g.add(eye);
    }
    const tail = new THREE.Mesh(sphere(0.055, 7, 6), red); tail.scale.set(2.1, 0.8, 0.8); tail.position.set(-0.24, 0.13, 0); g.add(tail);
    const tip = new THREE.Mesh(sphere(0.032, 6, 5), cream); tip.position.set(-0.34, 0.13, 0); g.add(tip);
    for (const [lx, lz] of [[0.1, 0.05], [0.1, -0.05], [-0.1, 0.05], [-0.1, -0.05]]) {
      const leg = new THREE.Mesh(cyl(0.016, 0.016, 0.1, 5), mat(0x5b3a24)); leg.position.set(lx, 0.05, lz); g.add(leg);
    }
  } else if (kind === 'hedgehog') {
    const spines = mat(0x6b5a48), faceM = mat(0xcbb597);
    const body = new THREE.Mesh(sphere(0.085, 8, 7), spines); body.scale.set(1.35, 0.9, 1); body.position.y = 0.075; body.castShadow = true; g.add(body);
    for (let i = 0; i < 7; i++) {
      const sp = new THREE.Mesh(cone(0.016, 0.05, 4), spines);
      sp.position.set(-0.08 + rnd() * 0.13, 0.13 + rnd() * 0.035, (rnd() - 0.5) * 0.1);
      sp.rotation.z = 0.4 - rnd() * 0.8; g.add(sp);
    }
    const face = new THREE.Mesh(cone(0.035, 0.09, 6), faceM); face.rotation.z = -Math.PI / 2; face.position.set(0.12, 0.06, 0); g.add(face);
    const nose = new THREE.Mesh(sphere(0.012, 5, 4), ink); nose.position.set(0.165, 0.06, 0); g.add(nose);
  } else if (kind === 'mouse') {
    const grey = mat(0x9d938a);
    const body = new THREE.Mesh(sphere(0.05, 7, 6), grey); body.scale.set(1.5, 0.9, 0.9); body.position.y = 0.045; body.castShadow = true; g.add(body);
    for (const ez of [0.02, -0.02]) { const ear = new THREE.Mesh(sphere(0.018, 5, 4), grey); ear.position.set(0.05, 0.09, ez); g.add(ear); }
    const nose = new THREE.Mesh(sphere(0.008, 5, 4), ink); nose.position.set(0.085, 0.045, 0); g.add(nose);
    const tail = new THREE.Mesh(cyl(0.005, 0.009, 0.12, 4), mat(0xc9a58f)); tail.rotation.z = Math.PI / 2 - 0.35; tail.position.set(-0.1, 0.035, 0); g.add(tail);
  } else if (kind === 'cat') {
    const coats = [
      [0xd18a49, 0xf0dfc4], [0x38342f, 0xf0eadc], [0xb8aa94, 0x685c50],
      [0xeee6d5, 0xc66d3d], [0x6d6259, 0xd9c9ae], [0x2f2b29, 0xc58a4b],
    ];
    const coat = coats[Math.floor(rnd() * coats.length)], fur = mat(coat[0]), patchM = mat(coat[1]);
    const body = new THREE.Mesh(sphere(0.085, 8, 7), fur); body.scale.set(1.65, 0.95, 0.9); body.position.y = 0.105; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.065, 8, 7), fur); head.position.set(0.14, 0.18, 0); g.add(head);
    for (const ez of [0.04, -0.04]) {
      const ear = new THREE.Mesh(cone(0.025, 0.07, 4), fur); ear.position.set(0.13, 0.275, ez); g.add(ear);
      const eye = new THREE.Mesh(sphere(0.009, 5, 4), mat(0x95bd55)); eye.position.set(0.195, 0.2, ez); g.add(eye);
    }
    const bib = new THREE.Mesh(sphere(0.045, 7, 6), patchM); bib.scale.set(0.7, 1, 1); bib.position.set(0.175, 0.125, 0); g.add(bib);
    const patch = new THREE.Mesh(sphere(0.04, 7, 6), patchM); patch.scale.set(1.6, 0.35, 0.8); patch.position.set(-0.02, 0.18, 0.055); g.add(patch);
    for (const [lx, lz] of [[0.09, 0.045], [0.09, -0.045], [-0.09, 0.045], [-0.09, -0.045]]) {
      const leg = new THREE.Mesh(cyl(0.014, 0.016, 0.1, 5), lx > 0 ? patchM : fur); leg.position.set(lx, 0.05, lz); g.add(leg);
    }
    // A short tapered curve anchored inside the rump; the old single cylinder
    // floated beside the body and read like a rigid stick from the iso camera.
    const tailPoints = [
      new THREE.Vector3(-0.12, 0.13, 0),
      new THREE.Vector3(-0.22, 0.18, 0.012),
      new THREE.Vector3(-0.29, 0.27, 0.035),
      new THREE.Vector3(-0.28, 0.37, 0.06),
    ];
    const radii = [[0.024, 0.022], [0.022, 0.017], [0.017, 0.011]];
    for (let i = 0; i < tailPoints.length - 1; i++) {
      const a = tailPoints[i], b = tailPoints[i + 1], dir = b.clone().sub(a), len = dir.length();
      const segment = new THREE.Mesh(cyl(radii[i][1], radii[i][0], len * 1.08, 7), fur);
      segment.position.copy(a).add(b).multiplyScalar(0.5);
      segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      g.add(segment);
    }
    const tailTip = new THREE.Mesh(sphere(0.012, 6, 5), fur); tailTip.position.copy(tailPoints[tailPoints.length - 1]); g.add(tailTip);
  } else if (kind === 'frog') {
    hops = true;
    const greens = [0x5f9f45, 0x79ad48, 0x438453], green = mat(greens[Math.floor(rnd() * greens.length)]);
    const body = new THREE.Mesh(sphere(0.065, 7, 6), green); body.scale.set(1.25, 0.65, 1.05); body.position.y = 0.055; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.055, 7, 6), green); head.scale.set(1, 0.75, 1.25); head.position.set(0.07, 0.09, 0); g.add(head);
    for (const ez of [0.035, -0.035]) {
      const eyeB = new THREE.Mesh(sphere(0.022, 6, 5), green); eyeB.position.set(0.085, 0.135, ez); g.add(eyeB);
      const eye = new THREE.Mesh(sphere(0.009, 5, 4), ink); eye.position.set(0.101, 0.14, ez); g.add(eye);
      const foot = new THREE.Mesh(sphere(0.028, 6, 5), green); foot.scale.set(1.8, 0.35, 0.7); foot.position.set(-0.06, 0.025, ez * 1.8); g.add(foot);
    }
  } else if (kind === 'deer') { // woodland biomes — a wary roe deer
    const tan = mat(0xa87a4e), cream = mat(0xe0cfae);
    const body = new THREE.Mesh(sphere(0.1, 8, 7), tan); body.scale.set(1.7, 0.95, 0.8); body.position.y = 0.22; body.castShadow = true; g.add(body);
    for (const [lx, lz] of [[0.11, 0.05], [0.11, -0.05], [-0.11, 0.05], [-0.11, -0.05]]) {
      const leg = new THREE.Mesh(cyl(0.013, 0.015, 0.22, 5), tan); leg.position.set(lx, 0.1, lz); g.add(leg);
    }
    const neck = new THREE.Mesh(cyl(0.032, 0.045, 0.17, 6), tan); neck.position.set(0.17, 0.35, 0); neck.rotation.z = -0.5; g.add(neck);
    const head = new THREE.Mesh(sphere(0.05, 7, 6), tan); head.scale.set(1.35, 0.85, 0.8); head.position.set(0.245, 0.43, 0); g.add(head);
    const nose = new THREE.Mesh(sphere(0.012, 5, 4), ink); nose.position.set(0.315, 0.42, 0); g.add(nose);
    for (const ez of [0.03, -0.03]) {
      const ear = new THREE.Mesh(cone(0.017, 0.055, 4), cream); ear.position.set(0.22, 0.5, ez); ear.rotation.x = ez * 8; g.add(ear);
      // small forked antlers
      const ant = new THREE.Mesh(cyl(0.007, 0.009, 0.1, 4), mat(0x6b543c)); ant.position.set(0.24, 0.53, ez * 0.8); ant.rotation.x = ez * 5; g.add(ant);
      const tine = new THREE.Mesh(cyl(0.006, 0.007, 0.05, 4), mat(0x6b543c)); tine.position.set(0.225, 0.56, ez * 1.4); tine.rotation.x = ez * 12; g.add(tine);
    }
    const rump = new THREE.Mesh(sphere(0.045, 6, 5), cream); rump.scale.set(0.6, 1, 1); rump.position.set(-0.165, 0.23, 0); g.add(rump);
  } else if (kind === 'squirrel') { // woodland biomes — russet, all tail
    hops = true;
    const russet = mat(0xa5502e);
    const body = new THREE.Mesh(sphere(0.05, 7, 6), russet); body.scale.set(1.2, 1, 0.9); body.position.y = 0.05; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.035, 7, 6), russet); head.position.set(0.055, 0.095, 0); g.add(head);
    for (const ez of [0.018, -0.018]) {
      const ear = new THREE.Mesh(cone(0.011, 0.03, 4), russet); ear.position.set(0.05, 0.135, ez); g.add(ear);
      const eye = new THREE.Mesh(sphere(0.007, 5, 4), ink); eye.position.set(0.082, 0.1, ez); g.add(eye);
    }
    // the tail: a plume curling up over the back
    const t1 = new THREE.Mesh(sphere(0.032, 6, 5), russet); t1.scale.set(0.8, 1.5, 0.8); t1.position.set(-0.07, 0.075, 0); g.add(t1);
    const t2 = new THREE.Mesh(sphere(0.028, 6, 5), russet); t2.scale.set(0.8, 1.3, 0.8); t2.position.set(-0.055, 0.14, 0); g.add(t2);
  } else if (kind === 'marmot') { // alpine — a chunky whistler by its burrow
    const fur = mat(0x8a6a45), belly = mat(0xc9a878);
    const body = new THREE.Mesh(sphere(0.08, 8, 7), fur); body.scale.set(1.3, 1, 1); body.position.y = 0.08; body.castShadow = true; g.add(body);
    const chest = new THREE.Mesh(sphere(0.05, 7, 6), belly); chest.position.set(0.07, 0.075, 0); g.add(chest);
    const head = new THREE.Mesh(sphere(0.05, 7, 6), fur); head.position.set(0.085, 0.15, 0); g.add(head);
    const nose = new THREE.Mesh(sphere(0.01, 5, 4), ink); nose.position.set(0.135, 0.145, 0); g.add(nose);
    for (const ez of [0.025, -0.025]) { const ear = new THREE.Mesh(sphere(0.013, 5, 4), fur); ear.position.set(0.065, 0.19, ez); g.add(ear); }
  } else if (kind === 'ibex') { // alpine — the crag goat with swept-back horns
    const coat = mat(0x9d8a70), hornM = mat(0x5f5245);
    const body = new THREE.Mesh(sphere(0.095, 8, 7), coat); body.scale.set(1.6, 1, 0.85); body.position.y = 0.2; body.castShadow = true; g.add(body);
    for (const [lx, lz] of [[0.1, 0.05], [0.1, -0.05], [-0.1, 0.05], [-0.1, -0.05]]) {
      const leg = new THREE.Mesh(cyl(0.015, 0.017, 0.18, 5), coat); leg.position.set(lx, 0.09, lz); g.add(leg);
    }
    const head = new THREE.Mesh(sphere(0.05, 7, 6), coat); head.scale.set(1.3, 0.9, 0.8); head.position.set(0.185, 0.3, 0); g.add(head);
    const beard = new THREE.Mesh(cone(0.016, 0.05, 4), hornM); beard.rotation.x = Math.PI; beard.position.set(0.2, 0.245, 0); g.add(beard);
    for (const ez of [0.028, -0.028]) {
      // three swept segments arc back over the shoulders
      let hx = 0.19, hy = 0.35, ang = -0.5;
      for (let seg = 0; seg < 3; seg++) {
        const piece = new THREE.Mesh(cyl(0.011 - seg * 0.003, 0.014 - seg * 0.003, 0.09, 5), hornM);
        piece.position.set(hx, hy, ez * (1 + seg * 0.35)); piece.rotation.z = ang;
        g.add(piece);
        hx -= 0.055; hy += 0.035 - seg * 0.02; ang -= 0.55;
      }
    }
  } else if (kind === 'sheep') { // island pastures — a woolly Texel grazer
    const wool = mat(0xeae4d4), skin = mat(0x3a332c);
    const body = new THREE.Mesh(sphere(0.1, 8, 7), wool); body.scale.set(1.5, 1.05, 1.05); body.position.y = 0.16; body.castShadow = true; g.add(body);
    for (let i = 0; i < 3; i++) { // extra puffs make the fleece lumpy
      const puff = new THREE.Mesh(sphere(0.055, 6, 5), wool);
      puff.position.set(-0.08 + rnd() * 0.16, 0.24 + rnd() * 0.03, (rnd() - 0.5) * 0.12); g.add(puff);
    }
    const head = new THREE.Mesh(sphere(0.05, 7, 6), skin); head.scale.set(1.3, 1, 0.85); head.position.set(0.17, 0.19, 0); g.add(head);
    for (const ez of [0.035, -0.035]) {
      const ear = new THREE.Mesh(sphere(0.02, 5, 4), skin); ear.scale.set(1.6, 0.6, 0.8); ear.position.set(0.15, 0.22, ez); g.add(ear);
    }
    for (const [lx, lz] of [[0.09, 0.05], [0.09, -0.05], [-0.09, 0.05], [-0.09, -0.05]]) {
      const leg = new THREE.Mesh(cyl(0.015, 0.017, 0.12, 5), skin); leg.position.set(lx, 0.06, lz); g.add(leg);
    }
  } else if (kind === 'gull') { // the coast — white, loud and eyeing your bread
    const white = mat(0xf0eee4), grey = mat(0xb9c0c4);
    const body = new THREE.Mesh(sphere(0.07, 8, 7), white); body.scale.set(1.6, 0.9, 0.9); body.position.y = 0.1; body.castShadow = true; g.add(body);
    const wing = new THREE.Mesh(sphere(0.055, 7, 6), grey); wing.scale.set(1.7, 0.55, 1.2); wing.position.set(-0.02, 0.135, 0); g.add(wing);
    const head = new THREE.Mesh(sphere(0.04, 7, 6), white); head.position.set(0.1, 0.19, 0); g.add(head);
    const beak = new THREE.Mesh(cone(0.014, 0.055, 5), mat(0xe0a33c)); beak.rotation.z = -Math.PI / 2; beak.position.set(0.15, 0.185, 0); g.add(beak);
    const eye = new THREE.Mesh(sphere(0.008, 5, 4), ink); eye.position.set(0.115, 0.205, 0.022); g.add(eye);
    const tail = new THREE.Mesh(cone(0.024, 0.07, 4), grey); tail.rotation.z = Math.PI / 2 + 0.35; tail.position.set(-0.12, 0.11, 0); g.add(tail);
    for (const lz of [0.025, -0.025]) {
      const leg = new THREE.Mesh(cyl(0.006, 0.006, 0.07, 4), mat(0xd6a33c)); leg.position.set(0.01, 0.035, lz); g.add(leg);
    }
  } else if (kind === 'heron') { // the ditches and shallows — a patient stilt-walker
    const slate = mat(0x8d99a0), white = mat(0xe8e6da);
    const body = new THREE.Mesh(sphere(0.07, 8, 7), slate); body.scale.set(1.5, 0.95, 0.85); body.position.y = 0.22; body.castShadow = true; g.add(body);
    const neck = new THREE.Mesh(cyl(0.016, 0.022, 0.18, 5), white); neck.position.set(0.09, 0.36, 0); neck.rotation.z = -0.35; g.add(neck);
    const head = new THREE.Mesh(sphere(0.03, 7, 6), white); head.scale.set(1.3, 0.9, 0.85); head.position.set(0.13, 0.46, 0); g.add(head);
    const beak = new THREE.Mesh(cone(0.011, 0.11, 5), mat(0xd6a33c)); beak.rotation.z = -Math.PI / 2; beak.position.set(0.21, 0.45, 0); g.add(beak);
    const crest = new THREE.Mesh(cone(0.008, 0.05, 4), ink); crest.rotation.z = Math.PI / 2 + 0.4; crest.position.set(0.1, 0.485, 0); g.add(crest);
    const eye = new THREE.Mesh(sphere(0.007, 5, 4), ink); eye.position.set(0.15, 0.47, 0.018); g.add(eye);
    for (const lz of [0.025, -0.025]) {
      const leg = new THREE.Mesh(cyl(0.007, 0.007, 0.19, 4), mat(0x8a7248)); leg.position.set(0, 0.095, lz); g.add(leg);
    }
  } else if (kind === 'seal') { // hauled out on the shore, doing nothing at speed
    const coat = mat(rnd() < 0.5 ? 0x9aa0a4 : 0x8b8478);
    const body = new THREE.Mesh(sphere(0.11, 9, 7), coat); body.scale.set(2, 0.75, 0.95); body.position.y = 0.08; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.055, 8, 6), coat); head.position.set(0.21, 0.13, 0); g.add(head);
    const nose = new THREE.Mesh(sphere(0.012, 5, 4), ink); nose.position.set(0.265, 0.125, 0); g.add(nose);
    for (const ez of [0.022, -0.022]) { const eye = new THREE.Mesh(sphere(0.009, 5, 4), ink); eye.position.set(0.245, 0.155, ez); g.add(eye); }
    for (const fz of [0.07, -0.07]) { // front flippers splayed on the sand
      const fl = new THREE.Mesh(sphere(0.035, 6, 5), coat); fl.scale.set(1.6, 0.3, 0.7); fl.position.set(0.08, 0.02, fz); g.add(fl);
    }
    const tail = new THREE.Mesh(sphere(0.04, 6, 5), coat); tail.scale.set(1.8, 0.4, 1.3); tail.position.set(-0.23, 0.045, 0); tail.rotation.y = 0.25; g.add(tail);
  } else { // duck — waddles the shorelines
    const white = mat(0xece7d6), bill = mat(0xe0a33c);
    const body = new THREE.Mesh(sphere(0.08, 8, 7), white); body.scale.set(1.5, 0.95, 0.95); body.position.y = 0.09; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(sphere(0.045, 7, 6), white); head.position.set(0.1, 0.2, 0); g.add(head);
    const beak = new THREE.Mesh(cone(0.02, 0.06, 5), bill); beak.rotation.z = -Math.PI / 2; beak.position.set(0.16, 0.19, 0); g.add(beak);
    const eye = new THREE.Mesh(sphere(0.009, 5, 4), ink); eye.position.set(0.12, 0.22, 0.025); g.add(eye);
    const tail = new THREE.Mesh(cone(0.03, 0.07, 4), white); tail.rotation.z = Math.PI / 2 + 0.5; tail.position.set(-0.12, 0.11, 0); g.add(tail);
  }
  g.scale.setScalar(0.85 + rnd() * 0.3);
  return { group: g, hops };
}

/** A high-flying ambient bird. Wing pivots remain dynamic for flapping. */
export function makeSkyBird(eagle = false): { group: THREE.Group; wings: THREE.Group[] } {
  const g = new THREE.Group();
  const bodyM = mat(eagle ? 0x594536 : [0x4d5660, 0x817d72, 0xe4ded0][Math.floor(rnd() * 3)]);
  const body = new THREE.Mesh(sphere(eagle ? 0.11 : 0.06, 7, 6), bodyM);
  body.scale.set(1.8, 0.7, 0.75); g.add(body);
  const head = new THREE.Mesh(sphere(eagle ? 0.065 : 0.035, 7, 6), eagle ? mat(0xe8dfca) : bodyM);
  head.position.set(eagle ? 0.18 : 0.1, 0.015, 0); g.add(head);
  const beak = new THREE.Mesh(cone(eagle ? 0.025 : 0.014, eagle ? 0.08 : 0.045, 5), mat(0xd6a33c));
  beak.rotation.z = -Math.PI / 2; beak.position.set(eagle ? 0.25 : 0.145, 0, 0); g.add(beak);
  const tail = new THREE.Mesh(cone(eagle ? 0.07 : 0.04, eagle ? 0.16 : 0.1, 4), bodyM);
  tail.rotation.z = Math.PI / 2; tail.position.set(eagle ? -0.2 : -0.12, 0, 0); g.add(tail);
  const wings: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.userData.dynamic = true;
    const wing = new THREE.Mesh(box(eagle ? 0.22 : 0.13, 0.018, eagle ? 0.55 : 0.3), bodyM);
    wing.position.z = side * (eagle ? 0.28 : 0.15); pivot.add(wing); g.add(pivot); wings.push(pivot);
  }
  if (eagle) g.scale.setScalar(1.25);
  return { group: g, wings };
}

// ---------- fish — cute silver/orange swimmers for the lake ----------
const FISH_COLORS = [0xd98c46, 0xc9c2b0, 0xe0a85a, 0x9fb7c4];
export function makeFish(): THREE.Group {
  const g = new THREE.Group();
  const col = FISH_COLORS[Math.floor(rnd() * FISH_COLORS.length)];
  const body = new THREE.Mesh(sphere(0.12, 7, 6), mat(col)); body.scale.set(1.7, 0.55, 0.85); body.castShadow = false; g.add(body);
  const tail = new THREE.Mesh(cone(0.09, 0.13, 4), mat(col)); tail.rotation.z = -Math.PI / 2; tail.position.set(-0.22, 0, 0); tail.scale.set(1, 1, 0.35); g.add(tail);
  const fin = new THREE.Mesh(cone(0.05, 0.1, 4), mat(col)); fin.position.set(0.02, 0.08, 0); fin.scale.set(1, 1, 0.4); g.add(fin);
  const eye = new THREE.Mesh(sphere(0.02, 5, 4), mat(0x2a2018)); eye.position.set(0.16, 0.03, 0.05); g.add(eye);
  g.scale.setScalar(0.7 + rnd() * 0.5);
  return g;
}

// ---------- barn (storehouse) ----------
function barn(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(box(2.1, 1.05, 1.7), mkMat(def.wall, ghost));
  base.position.y = 0.525; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  const roof = new THREE.Mesh(cone(1.72, 0.95, 4), mkMat(def.roof, ghost));
  roof.position.y = 1.52; roof.rotation.y = Math.PI / 4; roof.castShadow = !ghost; g.add(roof);
  // big double doors with pale trim
  const doors = new THREE.Mesh(box(0.8, 0.78, 0.1), mkMat(0x5b3f28, ghost));
  doors.position.set(0, 0.39, 1.02); doors.userData.marker = true; g.add(doors);
  const trimMat = mkMat(0xece3cf, ghost);
  const t1 = new THREE.Mesh(box(0.96, 0.06, 0.14), trimMat); t1.position.set(0, 0.8, 1.04); t1.userData.marker = true;
  const t2 = new THREE.Mesh(box(0.06, 0.82, 0.14), trimMat); t2.position.set(0.45, 0.4, 1.04); t2.userData.marker = true;
  const t3 = new THREE.Mesh(box(0.06, 0.82, 0.14), trimMat); t3.position.set(-0.45, 0.4, 1.04); t3.userData.marker = true;
  g.add(t1, t2, t3);
  g.scale.set(1.12, 1.08, 1.12);
  return g;
}

// ---------- castle (storehouse, enemy keep) — a real keep with corner towers ----------
function castle(key: BuildingKey, def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const stone = mkMat(def.wall, ghost);
  const trim = mkMat(0x8d887c, ghost);
  const roofM = mkMat(def.roof, ghost);
  const woodM = mkMat(0x4a3626, ghost);

  // battlemented crown: alternating merlons around a square top
  const crenel = (cx: number, cz: number, y: number, w: number, alongX: boolean): void => {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const off = -w / 2 + (i + 0.5) * (w / n);
      const m = new THREE.Mesh(box(alongX ? w / n * 0.55 : 0.14, 0.14, alongX ? 0.14 : w / n * 0.55), trim);
      m.position.set(cx + (alongX ? off : 0), y, cz + (alongX ? 0 : off));
      m.userData.marker = true; g.add(m);
    }
  };

  // Everything stays inside the 2×2 tile footprint (|x|,|z| ≤ ~1.05): the old
  // towers at ±0.95 with fat drums poked ~1.3 into the neighbouring walkable
  // tiles, so units strolled straight through them.
  const TOW = 0.8; // corner-tower centre offset from the keep's middle

  // central keep — a tall square donjon with a battlement crown
  const keep = new THREE.Mesh(box(1.1, 1.5, 1.1), stone);
  keep.position.y = 0.75; keep.castShadow = !ghost; keep.receiveShadow = !ghost; g.add(keep);
  const keepCap = new THREE.Mesh(box(1.24, 0.12, 1.24), trim);
  keepCap.position.y = 1.56; keepCap.userData.marker = true; g.add(keepCap);
  for (const [cx, cz, ax] of [[0, 0.62, true], [0, -0.62, true], [0.62, 0, false], [-0.62, 0, false]] as [number, number, boolean][])
    crenel(cx, cz, 1.69, 1.24, ax);
  // a proper steep pyramid roof that covers the whole crown (the old shallow
  // cone sat inset and read as a flat red slab from the iso camera)
  const keepRoof = new THREE.Mesh(cone(0.93, 0.85, 4), roofM);
  keepRoof.position.y = 2.02; keepRoof.rotation.y = Math.PI / 4; keepRoof.castShadow = !ghost; g.add(keepRoof);
  // curtain walls between the towers, crenellated
  for (const [cx, cz, ax] of [[0, TOW, true], [0, -TOW, true], [TOW, 0, false], [-TOW, 0, false]] as [number, number, boolean][]) {
    const wall = new THREE.Mesh(box(ax ? 1.5 : 0.2, 0.72, ax ? 0.2 : 1.5), stone);
    wall.position.set(cx, 0.36, cz); wall.castShadow = !ghost; wall.receiveShadow = !ghost; g.add(wall);
    const walk = new THREE.Mesh(box(ax ? 1.5 : 0.26, 0.07, ax ? 0.26 : 1.5), trim);
    walk.position.set(cx, 0.75, cz); walk.userData.marker = true; g.add(walk);
    crenel(cx, cz, 0.86, 1.42, ax);
  }

  // round towers on each corner: drum, corbelled crown, conical roof, arrow slit
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const tx = sx * TOW, tz = sz * TOW;
    const drum = new THREE.Mesh(cyl(0.22, 0.25, 1.2, 10), stone);
    drum.position.set(tx, 0.6, tz); drum.castShadow = !ghost; drum.receiveShadow = !ghost; g.add(drum);
    const crown = new THREE.Mesh(cyl(0.29, 0.24, 0.18, 10), trim);
    crown.position.set(tx, 1.28, tz); crown.userData.marker = true; g.add(crown);
    const cap = new THREE.Mesh(cone(0.31, 0.52, 10), roofM);
    cap.position.set(tx, 1.62, tz); cap.castShadow = !ghost; g.add(cap);
    const slit = new THREE.Mesh(box(0.05, 0.26, 0.05), woodM);
    slit.position.set(tx * 1.22, 0.78, tz * 1.22); slit.userData.marker = true; g.add(slit);
  }

  // gatehouse: an arched timber gate through the front wall
  const gateFrame = new THREE.Mesh(box(0.66, 0.86, 0.3), trim);
  gateFrame.position.set(0, 0.43, TOW); gateFrame.castShadow = !ghost; g.add(gateFrame);
  const gate = new THREE.Mesh(box(0.46, 0.6, 0.1), woodM);
  gate.position.set(0, 0.3, 0.93); gate.userData.marker = true; g.add(gate);
  const arch = new THREE.Mesh(cachedGeo('castle-arch', () => new THREE.CylinderGeometry(0.23, 0.23, 0.1, 10, 1, false, -Math.PI / 2, Math.PI)), woodM);
  arch.rotation.x = Math.PI / 2; arch.position.set(0, 0.6, 0.93); arch.userData.marker = true; g.add(arch);
  // lit keep windows
  for (const s of [-0.3, 0.3]) {
    const win = new THREE.Mesh(box(0.14, 0.24, 0.05), mkMat(0xf4d98a, ghost));
    win.position.set(s, 1.1, 0.59); win.userData.marker = true; g.add(win);
  }
  if (key === 'enemycastle') {
    // Hostile keeps carry an iron crown and fire baskets instead of civic cargo.
    for (const x of [-0.52, 0, 0.52]) { const spike = new THREE.Mesh(cone(0.07, 0.45, 5), mkMat(0x332c31, ghost)); spike.position.set(x, 2.02 + Math.abs(x) * 0.15, -0.58); spike.userData.marker = true; g.add(spike); }
    for (const x of [-0.62, 0.62]) { const bowl = new THREE.Mesh(cyl(0.12, 0.08, 0.12, 8), mkMat(0x40352f, ghost)); bowl.position.set(x, 1.15, 0.92); g.add(bowl); const flame = new THREE.Mesh(cone(0.09, 0.28, 7), mkMat(0xd95335, ghost)); flame.position.set(x, 1.34, 0.92); flame.userData.marker = true; g.add(flame); }
  } else if (!ghost) {
    // Player storehouse reads as a busy depot: loading platform, crates and sacks.
    const dock = new THREE.Mesh(box(1.2, 0.12, 0.42), mat(0x765538)); dock.position.set(0, 0.08, 1.05); g.add(dock);
    for (const [x, y, z, s] of [[-0.72, 0.16, 0.78, 0.28], [0.62, 0.15, 0.92, 0.25], [0.76, 0.38, 0.86, 0.2]] as [number, number, number, number][]) { const crate = new THREE.Mesh(box(s, s, s), mat(0x9a7045)); crate.position.set(x, y, z); crate.castShadow = true; g.add(crate); }
    for (const x of [-0.35, 0.35]) { const sack = new THREE.Mesh(cyl(0.12, 0.15, 0.3, 7), mat(0xd1bd92)); sack.position.set(x, 0.15, 1.18); g.add(sack); }
  }
  return g;
}

// ---------- mine (quarry, gold mine, coal mine) — rocky mound + adit ----------
function mine(key: BuildingKey, def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const mound = new THREE.Mesh(dodeca(1.05), mkMat(def.wall, ghost));
  mound.position.y = 0.35; mound.scale.set(1, 0.72, 1); mound.rotation.y = 0.5; mound.castShadow = !ghost; mound.receiveShadow = !ghost; g.add(mound);
  // dark timber-framed entrance
  const ent = new THREE.Mesh(box(0.58, 0.68, 0.5), mkMat(0x241f1b, ghost));
  ent.position.set(0, 0.34, 0.82); ent.userData.marker = true; g.add(ent);
  const beamMat = mkMat(0x6b4a2f, ghost);
  for (const sx of [-0.33, 0.33]) {
    const beam = new THREE.Mesh(box(0.1, 0.78, 0.1), beamMat);
    beam.position.set(sx, 0.4, 1.02); beam.userData.marker = true; g.add(beam);
  }
  const top = new THREE.Mesh(box(0.86, 0.12, 0.14), beamMat);
  top.position.set(0, 0.78, 1.02); top.userData.marker = true; g.add(top);
  // ore chunks in the accent colour (skip on ghost)
  if (!ghost && def.accent != null) {
    for (let i = 0; i < 3; i++) {
      const chunk = new THREE.Mesh(dodeca(0.15), mat(def.accent));
      chunk.position.set((rnd() - 0.5) * 1.3, 0.15, -0.35 - rnd() * 0.55); chunk.rotation.set(rnd(), rnd(), rnd()); chunk.castShadow = true;
      g.add(chunk);
    }
  }
  // Each ore operation has different headworks, readable even without colour.
  if (key === 'goldmine') {
    const timber = mkMat(0x6b4a2f, ghost);
    for (const x of [-0.52, 0.52]) { const leg = new THREE.Mesh(box(0.11, 1.35, 0.11), timber); leg.position.set(x, 1.05, 0.05); leg.rotation.z = x < 0 ? -0.18 : 0.18; g.add(leg); }
    const cross = new THREE.Mesh(box(1.25, 0.12, 0.14), timber); cross.position.set(0, 1.72, 0.05); g.add(cross);
    const wheel = new THREE.Mesh(torus(0.28, 0.035, 6, 14), mkMat(0xb8912e, ghost)); wheel.rotation.y = Math.PI / 2; wheel.position.set(0, 1.43, 0.06); wheel.userData.marker = true; g.add(wheel);
  } else if (key === 'coalmine') {
    const breaker = new THREE.Mesh(box(0.82, 0.95, 0.68), mkMat(0x45454b, ghost)); breaker.position.set(-0.35, 1.02, -0.18); breaker.rotation.z = -0.08; breaker.castShadow = !ghost; g.add(breaker);
    const chute = new THREE.Mesh(box(0.42, 0.24, 0.52), mkMat(0x2f3035, ghost)); chute.position.set(0.1, 0.52, 0.38); chute.rotation.z = -0.35; g.add(chute);
    const stack = new THREE.Mesh(cyl(0.13, 0.18, 1.35, 9), mkMat(0x313137, ghost)); stack.position.set(0.58, 1.16, -0.36); g.add(stack);
  } else if (key === 'ironmine') {
    const steel = mkMat(0x6d6260, ghost);
    const mast = new THREE.Mesh(box(0.16, 1.55, 0.16), steel); mast.position.set(0.5, 1.0, -0.2); g.add(mast);
    const arm = new THREE.Mesh(box(1.0, 0.12, 0.12), steel); arm.position.set(0.08, 1.72, -0.2); arm.rotation.z = -0.18; g.add(arm);
    const bucket = new THREE.Mesh(box(0.35, 0.3, 0.35), mkMat(0x8a4a30, ghost)); bucket.position.set(-0.36, 0.72, -0.2); g.add(bucket);
  }
  // quarry stacks cut blocks & leans a pickaxe; the mines park an ore-laden cart
  if (!ghost) {
    if (def.gather?.node === 'stone') quarryYard(g);
    else minecart(g, def.accent);
  }
  return g;
}
