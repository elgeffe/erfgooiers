import * as THREE from 'three';
import { uiRng } from '../engine/rng';
import { GRAPHICS } from '../constants';

// Mesh scatter is purely cosmetic — it must never touch gameplay/worldgen streams.
// It normally draws from uiRng, but chunk-baked doodads swap in a per-tile
// seeded stream (withSeededScatter) so a rebuilt chunk looks identical.
let activeRnd: () => number = () => uiRng.next();
export const rnd = () => activeRnd();

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
export const UNIT_INK = GRAPHICS.outlineThickness * 1.7;
export const GOLD_INK = GRAPHICS.outlineThickness * 2.0;

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
export function mat(hex: number): SceneMaterial {
  if (!matCache[hex]) matCache[hex] = stdMat({ color: hex });
  return matCache[hex];
}
// Solid material when placed, translucent when previewing (ghost).
export function mkMat(hex: number, ghost: boolean): SceneMaterial {
  return ghost ? stdMat({ color: hex, transparent: true, opacity: 0.55 }) : mat(hex);
}

// A parallel cache for unit materials, kept separate from `matCache` so the
// sharper unit ink never bleeds onto scenery props that reuse the same colour.
const unitMatCache: Record<number, SceneMaterial> = {};
export function umat(hex: number): SceneMaterial {
  if (!unitMatCache[hex]) unitMatCache[hex] = sharpOutline(stdMat({ color: hex }), UNIT_INK);
  return unitMatCache[hex];
}
// Shared sharp-edged gold for the coin heaps scattered on the map.
let goldMat: SceneMaterial | null = null;
export function goldSharp(): SceneMaterial {
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
export const flatCone = (r: number, h: number, seg: number): THREE.BufferGeometry => flatGeo(`cone,${r},${h},${seg}`, cone(r, h, seg));
export const flatSphere = (r: number, ws: number, hs: number): THREE.BufferGeometry => flatGeo(`sph,${r},${ws},${hs}`, sphere(r, ws, hs));

// ---------- shared primitive geometries ----------
export const geoTrunk = cyl(0.07, 0.1, 0.5, 6);
export const geoFol = cone(0.4, 0.95, 7);
export const geoFol2 = cone(0.3, 0.7, 7);
export const geoRock = dodeca(0.42);
export const geoPost = box(0.1, 0.7, 0.1);
// unit bodies get generous segment counts — the camera lives close to these
// little folk, and low-poly rounding is what made them read as blurry
export const geoBody = cyl(0.16, 0.2, 0.42, 12);
export const geoHead = sphere(0.14, 12, 10);
export const geoItem = box(0.24, 0.18, 0.24);
export const geoBlade = box(0.03, 0.34, 0.03);
export const geoArm = box(0.055, 0.26, 0.08);
export const geoHand = sphere(0.05, 8, 6);
export const geoBelt = cyl(0.192, 0.198, 0.055, 12);

// The active biome drives foliage colours, snowlines and flora variants for
// every mesh built after loadWorld sets it (chunk re-bakes included).
import { BIOMES, type BiomeDef } from '../data/biomes';
export let activeBiome: BiomeDef = BIOMES.gooi;
export function setActiveBiome(b: BiomeDef): void { activeBiome = b; }
export const FOL_GREENS = (): number[] => activeBiome.palette.folGreens;

// =====================================================================
//  Doodads — trees come in a few species/heights for a mixed woodland
export const ONE = new THREE.Vector3(1, 1, 1);

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
export function paintGeo(base: THREE.BufferGeometry, hex: number, m: THREE.Matrix4): THREE.BufferGeometry {
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
