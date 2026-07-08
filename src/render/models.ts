import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { uiRng } from '../engine/rng';
import { GRAPHICS } from '../constants';
import type { BuildingDef, DecoKind } from '../types';

// Mesh scatter is purely cosmetic — it must never touch gameplay/worldgen streams.
const rnd = () => uiRng.next();

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

// ---------- shared primitive geometries ----------
const geoTrunk = new THREE.CylinderGeometry(0.07, 0.1, 0.5, 6);
const geoFol = new THREE.ConeGeometry(0.4, 0.95, 7);
const geoFol2 = new THREE.ConeGeometry(0.3, 0.7, 7);
const geoRock = new THREE.DodecahedronGeometry(0.42, 0);
const geoPost = new THREE.BoxGeometry(0.1, 0.7, 0.1);
const geoBody = new THREE.CylinderGeometry(0.16, 0.2, 0.42, 7);
const geoHead = new THREE.SphereGeometry(0.14, 8, 7);
const geoItem = new THREE.BoxGeometry(0.24, 0.18, 0.24);
const geoBlade = new THREE.BoxGeometry(0.03, 0.34, 0.03);
const geoArm = new THREE.BoxGeometry(0.055, 0.26, 0.08);
const geoHand = new THREE.SphereGeometry(0.05, 6, 5);
const geoEye = new THREE.SphereGeometry(0.026, 6, 5);
const geoSmile = new THREE.TorusGeometry(0.04, 0.009, 6, 10, Math.PI);

const FOL_GREENS = [0x4e7a3a, 0x557f38, 0x476f36, 0x5f8c40, 0x6a9a44];

// =====================================================================
//  Doodads — trees come in a few species/heights for a mixed woodland
// =====================================================================
export function makeTree(kind = 0): THREE.Group {
  const g = new THREE.Group();
  const green = FOL_GREENS[Math.floor(rnd() * FOL_GREENS.length)];
  switch (kind % 4) {
    case 0: { // classic layered conifer
      const trunk = new THREE.Mesh(geoTrunk, mat(0x7a5a3a)); trunk.position.y = 0.25; trunk.castShadow = true;
      const fol = new THREE.Mesh(geoFol, mat(green)); fol.position.y = 0.85; fol.castShadow = true;
      const fol2 = new THREE.Mesh(geoFol2, mat(green)); fol2.position.y = 1.28; fol2.castShadow = true;
      g.add(trunk, fol, fol2);
      break;
    }
    case 1: { // tall slender pine — three stacked cones
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.7, 6), mat(0x6f5334)); trunk.position.y = 0.35; trunk.castShadow = true; g.add(trunk);
      const dark = mat(0x3f6d34);
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.42 - i * 0.1, 0.7, 7), dark);
        c.position.y = 0.85 + i * 0.5; c.castShadow = true; g.add(c);
      }
      break;
    }
    case 2: { // round broadleaf — bushy sphere canopy
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.55, 6), mat(0x7d5a37)); trunk.position.y = 0.28; trunk.castShadow = true; g.add(trunk);
      const cm = mat(green);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 7), cm); crown.position.y = 0.95; crown.scale.y = 0.9; crown.castShadow = true; g.add(crown);
      for (const [ox, oy, oz] of [[0.32, 0.75, 0], [-0.28, 0.82, 0.2], [0.05, 1.2, -0.15]]) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.3, 7, 6), cm); p.position.set(ox, oy, oz); p.castShadow = true; g.add(p);
      }
      break;
    }
    default: { // slim birch — pale trunk, small oval crown
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.95, 6), mat(0xe6e2d6)); trunk.position.y = 0.48; trunk.castShadow = true; g.add(trunk);
      const cm = mat(0x87b455);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 7), cm); crown.position.y = 1.12; crown.scale.y = 1.25; crown.castShadow = true; g.add(crown);
      const crown2 = new THREE.Mesh(new THREE.SphereGeometry(0.26, 7, 6), cm); crown2.position.set(0.12, 0.92, 0.08); crown2.castShadow = true; g.add(crown2);
      break;
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
    default: return lily();
  }
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
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.02, 0.2, 5), mat(flowerCols[Math.floor(rnd() * 3)]));
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
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.02), stem); s.position.set(px, 0.08, pz);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), mat(cols[Math.floor(rnd() * cols.length)])); head.position.set(px, 0.18, pz);
    g.add(s, head);
  }
  return g;
}

function bush(): THREE.Group {
  const g = new THREE.Group();
  const green = mat(FOL_GREENS[Math.floor(rnd() * FOL_GREENS.length)]);
  for (const [ox, oy, oz, r] of [[0, 0.16, 0, 0.26], [0.22, 0.13, 0.08, 0.2], [-0.16, 0.12, -0.14, 0.18]] as number[][]) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), green); p.position.set(ox, oy, oz); p.scale.y = 0.85; p.castShadow = true; g.add(p);
  }
  // a few berries for interest
  if (rnd() < 0.5) {
    const berry = mat(0xd23b4a);
    for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.03, 5, 4), berry); b.position.set((rnd() - 0.5) * 0.4, 0.2 + rnd() * 0.1, (rnd() - 0.5) * 0.4); g.add(b); }
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
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, h, 4), stem);
    blade.position.set(px, h / 2, pz); blade.rotation.z = (rnd() - 0.5) * 0.35;
    g.add(blade);
    if (rnd() < 0.4) { // cattail head
      const cat = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.14, 6), mat(0x7a4a28));
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
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.15 + rnd() * 0.08, 10), pad);
    disc.rotation.x = -Math.PI / 2; disc.position.set(px, 0.005, pz); g.add(disc);
    if (rnd() < 0.5) { // a flower on the pad
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.055, 7, 5), mat(rnd() < 0.5 ? 0xf4c6dd : 0xfbf3ea));
      f.scale.y = 0.6; f.position.set(px, 0.05, pz); g.add(f);
    }
  }
  g.position.y = 0.03;
  return g;
}

export function makeDeposit(kind: 'stone' | 'gold' | 'coal'): THREE.Group {
  const g = new THREE.Group();
  const col = kind === 'stone' ? 0x9aa0a3 : kind === 'gold' ? 0xc9a94e : 0x3a3a42;
  const m = new THREE.Mesh(geoRock, mat(col));
  m.position.set(0, 0.16, 0); m.scale.y = 0.62; m.rotation.y = rnd() * 3; m.castShadow = true;
  const m2 = new THREE.Mesh(geoRock, mat(col));
  m2.position.set(0.28, 0.09, -0.2); m2.scale.set(0.5, 0.35, 0.5); m2.rotation.y = rnd() * 3; m2.castShadow = true;
  // a glint of the valuable stuff
  if (kind !== 'stone') {
    const glint = new THREE.Mesh(new THREE.DodecahedronGeometry(0.12, 0), mat(kind === 'gold' ? 0xffd24a : 0x24242a));
    glint.position.set(-0.18, 0.2, 0.12); g.add(glint);
  }
  g.add(m, m2);
  return g;
}

/** A little heap of gold coins the hero/serfs pick up off the map. */
export function makePickup(): THREE.Group {
  const g = new THREE.Group();
  const gold = goldSharp();
  const coin = new THREE.CylinderGeometry(0.13, 0.13, 0.035, 12);
  const spots = [[0, 0.02, 0, 0], [0.1, 0.02, 0.06, 0.5], [-0.08, 0.02, 0.09, 1.1], [0.03, 0.055, 0.02, 0.3], [-0.04, 0.055, -0.05, 0.8], [0.02, 0.09, 0.03, 0.2]];
  for (const [x, y, z, rot] of spots) {
    const c = new THREE.Mesh(coin, gold);
    c.position.set(x, y, z); c.rotation.y = rot; c.rotation.x = (rnd() - 0.5) * 0.2; c.castShadow = true;
    g.add(c);
  }
  return g;
}

export function makeUnit(colorHex: number, role = 'serf'): { group: THREE.Group; itemMesh: THREE.Mesh } {
  if (role === 'boar') return makeBeast(colorHex);
  if (role === 'dragon') return makeDragon(colorHex);
  const g = new THREE.Group();
  const body = new THREE.Mesh(geoBody, umat(colorHex)); body.position.y = 0.21; body.castShadow = true;
  const head = new THREE.Mesh(geoHead, umat(0xe8c9a0)); head.position.y = 0.55; head.castShadow = true;
  g.add(body, head);

  // little arms with skin-toned hands, angled out from the body
  const skin = umat(0xe8c9a0);
  const ink = umat(0x2a2018);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(geoArm, umat(colorHex));
    arm.position.set(sx * 0.19, 0.26, 0.02); arm.rotation.z = sx * 0.22; arm.castShadow = true;
    const hand = new THREE.Mesh(geoHand, skin);
    hand.position.set(sx * 0.23, 0.13, 0.03);
    g.add(arm, hand);
  }

  // a cute little face — two eyes and a smile on the front of the head
  const eyeL = new THREE.Mesh(geoEye, ink); eyeL.position.set(-0.05, 0.57, 0.125);
  const eyeR = new THREE.Mesh(geoEye, ink); eyeR.position.set(0.05, 0.57, 0.125);
  const smile = new THREE.Mesh(geoSmile, ink); smile.position.set(0, 0.53, 0.125); smile.rotation.z = Math.PI;
  g.add(eyeL, eyeR, smile);

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
  const brim = (col: number, r: number, h: number, y: number) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), mat(col)).translateY(y);
  const dome = (col: number, r: number, y: number) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat(col)); m.position.y = y; m.scale.y = 0.75; return m; };
  const apron = (col: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.06), mat(col)); m.position.set(0, 0.24, 0.19); m.userData.marker = true; return m; };
  const strap = (x: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.04), mat(0x3f5aa0)); m.position.set(x, 0.28, 0.19); m.userData.marker = true; return m; };
  // combat kit — worn chest plate, a helmet, and a weapon held in the right hand
  const plate = (col: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.12), mat(col)); m.position.set(0, 0.26, 0.14); m.userData.marker = true; return m; };
  const shield = (col: number) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 12), mat(col)); m.rotation.x = Math.PI / 2; m.position.set(-0.26, 0.26, 0.08); m.userData.marker = true; return m; };
  const sword = () => {
    const s = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.05), mat(0xd8dde2)); blade.position.y = 0.2;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.05), mat(0x6b4a2f));
    const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), mat(0x4a3320)); hilt.position.y = -0.08;
    s.add(blade, guard, hilt); s.position.set(0.28, 0.22, 0.1); s.rotation.z = -0.22; s.userData.marker = true; return s;
  };
  const axe = () => {
    const s = new THREE.Group();
    const haft = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.4, 0.045), mat(0x5a4030)); haft.position.y = 0.16;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.04), mat(0x9aa0a3)); head.position.set(0.07, 0.3, 0);
    s.add(haft, head); s.position.set(0.28, 0.16, 0.1); s.rotation.z = -0.18; s.userData.marker = true; return s;
  };
  const bow = () => {
    const b = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 6, 12, Math.PI * 1.25), mat(0x6b4a2f));
    b.position.set(0.27, 0.3, 0.08); b.rotation.set(0, Math.PI / 2, Math.PI / 2 - 0.35); b.userData.marker = true; return b;
  };
  const quiver = () => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 7), mat(0x7a5230)); m.position.set(-0.14, 0.34, -0.16); m.rotation.x = 0.4; m.userData.marker = true; return m; };

  switch (role) {
    case 'woodcutter': { // red knit beanie
      add(dome(0xb5352f, 0.16, 0.66));
      add(brim(0xd6493f, 0.165, 0.06, 0.6), false);
      break;
    }
    case 'forester': { // green pointed hood
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.3, 8), mat(0x3f6d3a)); hat.position.y = 0.74; add(hat);
      add(brim(0x355c31, 0.19, 0.05, 0.62), false);
      break;
    }
    case 'carpenter': { // brown flat cap + work apron
      add(brim(0x6b4a2f, 0.17, 0.09, 0.66));
      add(apron(0x8a6a44));
      break;
    }
    case 'stonemason': { // grey dusty cap
      add(dome(0x9aa0a3, 0.16, 0.66));
      add(brim(0x8a9094, 0.185, 0.04, 0.62), false);
      break;
    }
    case 'farmer': { // wide straw hat
      add(brim(0xd9bd63, 0.28, 0.03, 0.66), false);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.16, 10), mat(0xcaa94e)).translateY(0.72));
      add(strap(-0.09)); add(strap(0.09)); // overalls
      break;
    }
    case 'miller': { // soft white cap
      add(dome(0xefe9dc, 0.17, 0.66));
      break;
    }
    case 'baker': { // tall white toque
      add(brim(0xf4efe6, 0.15, 0.16, 0.72));
      add(dome(0xfbf7ef, 0.17, 0.82));
      add(apron(0xf0e6d2));
      break;
    }
    case 'miner': case 'collier': { // hard hat + head lamp
      const helmCol = role === 'miner' ? 0xd8af43 : 0x35353c;
      add(dome(helmCol, 0.165, 0.66));
      add(brim(helmCol, 0.19, 0.04, 0.62), false);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 7, 6), mat(0xfff2a8)); lamp.position.set(0, 0.69, 0.15); add(lamp, false);
      break;
    }
    case 'minter': { // green cap with a gold band
      add(dome(0x2f6f52, 0.16, 0.67));
      add(brim(0xd4af37, 0.17, 0.05, 0.6), false);
      break;
    }
    case 'laborer': { // brown flat cap (builders)
      add(brim(0x8a5a34, 0.17, 0.08, 0.65));
      break;
    }
    case 'soldier': { // steel helmet with a crest, breastplate, sword & shield
      add(dome(0x9298a0, 0.175, 0.66));
      add(brim(0x82888f, 0.19, 0.04, 0.61), false);
      const crest = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.11, 0.22), mat(0xb5352f)); crest.position.set(0, 0.79, 0); crest.userData.marker = true; add(crest);
      add(plate(0x8f97a6));
      add(shield(0x3f5aa0));
      add(sword());
      break;
    }
    case 'archer': { // leather cap, green tunic accent, bow & quiver
      add(dome(0x5c6b3a, 0.16, 0.66));
      add(brim(0x4a5730, 0.175, 0.04, 0.61), false);
      add(plate(0x6b7a44));
      add(bow());
      add(quiver());
      break;
    }
    case 'bandit': { // dark hood, ragged leather, crude axe
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.26, 8), mat(0x3a3138)); hood.position.y = 0.72; add(hood);
      add(brim(0x2f272d, 0.185, 0.05, 0.62), false);
      add(plate(0x5a4636));
      add(axe());
      break;
    }
    default: { // serf — a jaunty maroon fez with a dark tassel
      const fez = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.145, 0.2, 14), mat(0x9e2b25));
      fez.position.y = 0.77; add(fez);
      // flat crown disc, a touch darker, caps the truncated cone
      add(brim(0x7f2019, 0.115, 0.02, 0.87), false);
      // tassel: a short cord flopping off one side to a little tuft
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 5), mat(0x241c14));
      cord.position.set(0.11, 0.82, 0.03); cord.rotation.z = 0.6; add(cord, false);
      const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 5), mat(0x241c14));
      tuft.position.set(0.18, 0.74, 0.03); tuft.scale.y = 1.3; add(tuft, false);
      break;
    }
  }
}

// =====================================================================
//  Beasts — a bristly wild boar and the dragon of Het Gooi
// =====================================================================
function makeBeast(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const hide = mat(colorHex);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), hide);
  body.scale.set(1.5, 0.95, 0.95); body.position.y = 0.3; body.castShadow = true;
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), hide); hump.position.set(-0.05, 0.46, 0); hump.scale.set(1.1, 0.8, 0.9);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 9, 7), hide); head.position.set(0.4, 0.3, 0); head.scale.set(1.05, 0.9, 0.9); head.castShadow = true;
  const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.16, 8), mat(0x4a3226)); snout.rotation.z = Math.PI / 2; snout.position.set(0.58, 0.27, 0);
  g.add(body, hump, head, snout);
  // tusks, ears, eyes
  for (const s of [-1, 1]) {
    const tusk = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.11, 5), mat(0xeee6cf)); tusk.position.set(0.56, 0.23, s * 0.07); tusk.rotation.set(0, 0, 0.7); g.add(tusk);
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.11, 5), hide); ear.position.set(0.31, 0.46, s * 0.11); g.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 5), mat(0x1a120c)); eye.position.set(0.47, 0.34, s * 0.08); g.add(eye);
  }
  // four stubby legs + a little tail
  for (const dx of [-0.2, 0.24]) for (const dz of [-0.14, 0.14]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 6), mat(0x3a2a20)); leg.position.set(dx, 0.11, dz); leg.castShadow = true; g.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 5), hide); tail.position.set(-0.42, 0.34, 0); tail.rotation.z = 0.8; g.add(tail);
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff })); item.visible = false; g.add(item);
  return { group: g, itemMesh: item };
}

function makeDragon(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const scale = mat(colorHex);
  const membrane = mat(0x5a1a26);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 9), scale); body.scale.set(1.6, 1, 1); body.position.y = 0.5; body.castShadow = true;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.17, 0.42, 8), scale); neck.position.set(0.42, 0.72, 0); neck.rotation.z = -0.7; neck.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), scale); head.position.set(0.64, 0.9, 0); head.scale.set(1.3, 0.9, 0.9); head.castShadow = true;
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 7), scale); snout.rotation.z = -Math.PI / 2 * 0.85; snout.position.set(0.86, 0.86, 0);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.8, 7), scale); tail.rotation.z = Math.PI / 2; tail.position.set(-0.7, 0.44, 0); tail.castShadow = true;
  g.add(body, neck, head, snout, tail);
  // horns, eyes
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.18, 5), mat(0xe8e0cf)); horn.position.set(0.6, 1.04, s * 0.08); horn.rotation.x = s * 0.35; g.add(horn);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 7, 6), mat(0xffcf3a)); eye.position.set(0.7, 0.94, s * 0.09); g.add(eye);
  }
  // leathery wings + a spined back
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6, 0, Math.PI), membrane);
    wing.scale.set(1, 0.06, 0.75); wing.position.set(-0.05, 0.78, s * 0.32); wing.rotation.set(s * 0.5, 0, 0.25); g.add(wing);
  }
  for (let i = 0; i < 4; i++) { const spike = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 5), mat(0x4a141f)); spike.position.set(0.3 - i * 0.28, 0.82 - i * 0.03, 0); g.add(spike); }
  // four clawed legs
  for (const dx of [-0.24, 0.28]) for (const dz of [-0.22, 0.22]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.32, 6), scale); leg.position.set(dx, 0.17, dz); leg.castShadow = true; g.add(leg);
  }
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff })); item.visible = false; g.add(item);
  return { group: g, itemMesh: item };
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

const ONE = new THREE.Vector3(1, 1, 1);

/** Clone a base geometry, transform it, and bake a flat vertex colour onto it. */
function paintGeo(base: THREE.BufferGeometry, hex: number, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = base.clone().applyMatrix4(m);
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
export function makeBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  switch (def.model) {
    case 'windmill': return windmill(def, ghost);
    case 'farm': return farmhouse(def, ghost);
    case 'barn': return barn(def, ghost);
    case 'mine': return mine(def, ghost);
    case 'tavern': return tavern(def, ghost);
    default: return cottage(def, ghost);
  }
}

/** Scaffold shown while a building is under construction. */
export function makeScaffold(def: BuildingDef): { group: THREE.Group; frame: THREE.Group } {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 1.9), mat(0x8a6b42)); pad.position.y = 0.04; g.add(pad);
  for (const [px, pz] of [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]]) {
    const post = new THREE.Mesh(geoPost, mat(0xc9a06a)); post.position.set(px, 0.35, pz); post.castShadow = true; g.add(post);
  }
  const frame = makeBuilding(def, true);
  frame.visible = false;
  frame.userData.dynamic = true; // Game scales it up with build progress
  g.add(frame);
  return { group: g, frame };
}

// ---------- door / accessories ----------
function addDoor(g: THREE.Group, ghost: boolean): void {
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.6, 0.09), mkMat(0x4a3626, ghost));
  door.position.set(-0.4, 0.3, 0.86); door.userData.marker = true;
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.12), mkMat(0x6b4a2f, ghost));
  lintel.position.set(-0.4, 0.64, 0.86); lintel.userData.marker = true;
  g.add(door, lintel);
}
function addChimney(g: THREE.Group, ghost: boolean): void {
  const ch = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.55, 0.22), mkMat(0x7a5a45, ghost));
  ch.position.set(0.5, 1.4, -0.3); ch.castShadow = !ghost; ch.userData.marker = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.3), mkMat(0x5b4433, ghost));
  cap.position.set(0.5, 1.68, -0.3); cap.userData.marker = true;
  g.add(ch, cap);
  if (ghost) return;
  // drifting smoke — puffs rise & fade; View.animate cycles them via userData.smoke
  const puffs: THREE.Mesh[] = [];
  const N = 4;
  for (let i = 0; i < N; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 6), stdMat({ color: 0xbfbfbf, transparent: true, opacity: 0 }));
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
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.7, 8), logMat);
    log.rotation.x = Math.PI / 2; log.position.set(x, 0.14, z as number); log.castShadow = !ghost; log.userData.marker = true;
    const cap = new THREE.Mesh(new THREE.CircleGeometry(0.11, 8), ends);
    cap.position.set(x, 0.14, (z as number) + 0.36); cap.userData.marker = true;
    g.add(log, cap);
  }
}

// ---------- distinctive per-trade yard props (placed builds only, never on the ghost) ----------
function barrel(col: number, r = 0.15, h = 0.32): THREE.Group {
  const b = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat(col)); body.castShadow = true; b.add(body);
  const hoopMat = mat(0x3a2c1f);
  for (const hy of [h * 0.3, -h * 0.3]) { const hp = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.035, 10), hoopMat); hp.position.y = hy; b.add(hp); }
  return b;
}

function hangingSign(g: THREE.Group, boardCol: number): void {
  const wood = mat(0x5b4433);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.92, 7), wood); post.position.set(0.84, 0.46, 0.86); post.castShadow = true;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.045, 0.045), wood); arm.position.set(0.66, 0.84, 0.86);
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.03), mat(boardCol)); board.position.set(0.55, 0.66, 0.86); board.castShadow = true;
  g.add(post, arm, board);
}

function woodcutterYard(g: THREE.Group): void {
  addLogpile(g, false);
  const block = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.24, 10), mat(0x7a5230)); block.position.set(0.66, 0.12, 0.55); block.castShadow = true;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 10), mat(0xcaa06a)); top.position.set(0.66, 0.26, 0.55);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 6), mat(0x6b4a2f)); handle.position.set(0.6, 0.44, 0.55); handle.rotation.z = 0.7;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.13, 0.16), mat(0xc2c6cb)); blade.position.set(0.73, 0.57, 0.55); blade.rotation.z = 0.7;
  g.add(block, top, handle, blade);
}

function sawmillYard(g: THREE.Group): void {
  const plankMat = mat(0xd2a35c);
  for (let i = 0; i < 4; i++) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.26), plankMat); p.position.set(-0.72, 0.07 + i * 0.06, 0.42); p.rotation.y = 0.08 * (i % 2 ? 1 : -1); p.castShadow = true; g.add(p); }
  const buckMat = mat(0x6b4a2f);
  for (const sx of [-0.9, -0.5]) for (const rz of [0.35, -0.35]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.42, 0.04), buckMat); leg.position.set(sx, 0.2, -0.5); leg.rotation.z = rz; g.add(leg); }
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.62, 8), mat(0x8a5a2b)); log.rotation.x = Math.PI / 2; log.position.set(-0.7, 0.42, -0.5); log.castShadow = true; g.add(log);
}

function foresterYard(g: THREE.Group): void {
  for (const [x, z] of [[0.72, 0.55], [0.9, 0.24], [0.55, 0.2]]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.12, 8), mat(0x8a5230)); pot.position.set(x, 0.06, z); pot.castShadow = true;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 7), mat(0x4e7a3a)); leaf.position.set(x, 0.28, z); leaf.castShadow = true;
    g.add(pot, leaf);
  }
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.52, 6), mat(0x6b4a2f)); shaft.position.set(-0.72, 0.32, 0.5); shaft.rotation.z = 0.4; g.add(shaft);
  const spade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.15, 0.025), mat(0x9aa0a3)); spade.position.set(-0.87, 0.09, 0.5); spade.rotation.z = 0.4; spade.castShadow = true; g.add(spade);
}

function bakeryYard(g: THREE.Group): void {
  const table = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.05, 0.34), mat(0x8a6a44)); table.position.set(0.66, 0.34, 0.5); table.castShadow = true; g.add(table);
  const legMat = mat(0x6b4a2f);
  for (const [lx, lz] of [[0.46, 0.38], [0.86, 0.38], [0.46, 0.62], [0.86, 0.62]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.32, 0.04), legMat); leg.position.set(lx, 0.16, lz); g.add(leg); }
  for (const [lx, lz] of [[0.55, 0.45], [0.72, 0.5], [0.64, 0.56]]) { const loaf = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 6), mat(0xc9853e)); loaf.scale.set(1.5, 0.7, 1); loaf.position.set(lx, 0.4, lz); loaf.castShadow = true; g.add(loaf); }
  const sack = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.24, 7), mat(0xefe6d0)); sack.position.set(-0.72, 0.12, 0.5); sack.castShadow = true; g.add(sack);
}

function mintYard(g: THREE.Group): void {
  for (const [cx, cz, n] of [[0.66, 0.5, 5], [0.5, 0.42, 3], [0.78, 0.56, 4]]) for (let i = 0; i < n; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 10), mat(0xffd24a)); c.position.set(cx, 0.02 + i * 0.022, cz); g.add(c); }
  const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.14), mat(0x35353c)); anvil.position.set(-0.7, 0.3, 0.5); anvil.castShadow = true; g.add(anvil);
  const anvilBase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.26, 8), mat(0x5b4433)); anvilBase.position.set(-0.7, 0.13, 0.5); g.add(anvilBase);
}

function wineryYard(g: THREE.Group): void {
  const b1 = barrel(0x6b3f26); b1.position.set(0.68, 0.16, 0.52); g.add(b1);
  const b2 = barrel(0x6b3f26); b2.position.set(0.86, 0.16, 0.28); g.add(b2);
  const b3 = barrel(0x6b3f26, 0.13, 0.28); b3.position.set(0.77, 0.46, 0.4); b3.rotation.z = Math.PI / 2; g.add(b3);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.24), mat(0x8a6a44)); crate.position.set(-0.7, 0.1, 0.5); crate.castShadow = true; g.add(crate);
  for (let i = 0; i < 6; i++) { const gr = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), mat(0x7a4b8a)); gr.position.set(-0.8 + (i % 3) * 0.09, 0.2, 0.44 + Math.floor(i / 3) * 0.1); g.add(gr); }
}

function butcherYard(g: THREE.Group): void {
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.62, 6), mat(0x5b4433)); rail.rotation.z = Math.PI / 2; rail.position.set(0.62, 0.82, 0.9); g.add(rail);
  for (const hx of [0.4, 0.55, 0.7, 0.85]) { const link = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.12, 3, 6), mat(0x9c4a2f)); link.position.set(hx, 0.68, 0.9); link.castShadow = true; g.add(link); }
  const block = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.24, 10), mat(0x7a5230)); block.position.set(-0.7, 0.12, 0.5); block.castShadow = true; g.add(block);
  const cleaver = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.16), mat(0xc2c6cb)); cleaver.position.set(-0.7, 0.3, 0.5); cleaver.rotation.z = 0.25; g.add(cleaver);
}

function tavernYard(g: THREE.Group): void {
  hangingSign(g, 0xb5763a);
  const b1 = barrel(0x7a5230); b1.position.set(-0.72, 0.16, 0.5); g.add(b1);
  const b2 = barrel(0x7a5230, 0.13, 0.26); b2.position.set(-0.7, 0.44, 0.5); b2.rotation.z = Math.PI / 2; g.add(b2);
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.16), mat(0x6b4a2f)); bench.position.set(0.35, 0.18, 1.0); bench.castShadow = true; g.add(bench);
  for (const bx of [0.18, 0.52]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.14), mat(0x5b4433)); leg.position.set(bx, 0.09, 1.0); g.add(leg); }
  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 7), mat(0xffd27a)); lantern.position.set(-0.08, 0.72, 0.9); g.add(lantern);
}

function fisheryYard(g: THREE.Group): void {
  const wood = mat(0x6b4a2f);
  for (const x of [0.5, 0.9]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.7, 6), wood); post.position.set(x, 0.35, 0.55); post.castShadow = true; g.add(post); }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.04, 0.04), wood); bar.position.set(0.7, 0.66, 0.55); g.add(bar);
  const net = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.32, 0.02), stdMat({ color: 0xcfc7ad, transparent: true, opacity: 0.5 })); net.position.set(0.7, 0.46, 0.55); g.add(net);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.24), mat(0x8a6a44)); crate.position.set(-0.7, 0.09, 0.5); crate.castShadow = true; g.add(crate);
  for (const fz of [0.44, 0.56]) { const f = makeFish(); f.scale.setScalar(0.55); f.position.set(-0.7, 0.18, fz); f.rotation.z = 0.3; g.add(f); }
}

function farmYard(g: THREE.Group): void {
  const hay = new THREE.Group();
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.38, 10), mat(0xd7bd63)); stack.position.y = 0.19; stack.castShadow = true;
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.3, 10), mat(0xc9a94e)); top.position.y = 0.52; top.castShadow = true;
  hay.add(stack, top); hay.position.set(0.92, 0, -0.55); g.add(hay);
  const sheafMat = mat(0xdcc25c);
  for (const [sx, sz, lean] of [[0.86, 0.42, 0.18], [0.64, 0.62, -0.22]]) {
    const sheaf = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 6), sheafMat);
    sheaf.position.set(sx, 0.2, sz); sheaf.rotation.z = lean; sheaf.castShadow = true; g.add(sheaf);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.05, 6), mat(0xa98d45));
    band.position.set(sx, 0.18, sz); band.rotation.z = lean; g.add(band);
  }
  const fenceMat = mat(0x8a6a44);
  for (let i = 0; i < 3; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.06), fenceMat);
    post.position.set(-0.92, 0.17, -0.7 + i * 0.55); post.castShadow = true; g.add(post);
  }
  const rail1 = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 1.24), fenceMat);
  rail1.position.set(-0.92, 0.26, -0.15); g.add(rail1);
}

function vineyardYard(g: THREE.Group): void {
  const postMat = mat(0x6b4a2f);
  for (const z of [-0.4, 0.1, 0.6]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.38, 0.05), postMat); p.position.set(0.92, 0.19, z); p.castShadow = true; g.add(p); }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 1.1), postMat); rail.position.set(0.92, 0.36, 0.1); g.add(rail);
  for (const z of [-0.4, -0.15, 0.1, 0.35, 0.6]) { const gr = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), mat(0x7a4b8a)); gr.scale.y = 1.3; gr.position.set(0.9, 0.28, z); gr.castShadow = true; g.add(gr); }
  const b = barrel(0x6b3f26); b.position.set(-0.85, 0.16, 0.5); g.add(b);
}

function pigfarmYard(g: THREE.Group): void {
  const mud = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.03, 14), mat(0x6b4a34)); mud.position.set(0.68, 0.02, 0.2); g.add(mud);
  const fenceMat = mat(0x8a6a44);
  for (const [x, z] of [[0.28, -0.18], [0.68, -0.28], [1.06, -0.08], [1.08, 0.42], [0.75, 0.64], [0.33, 0.55]]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.05), fenceMat); p.position.set(x, 0.13, z); p.castShadow = true; g.add(p); }
  for (const [px, pz] of [[0.58, 0.12], [0.86, 0.32]]) {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 7), mat(0xe0a0a0)); body.scale.set(1.5, 0.9, 1); body.position.set(px, 0.12, pz); body.castShadow = true;
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), mat(0xd48f8f)); snout.position.set(px + 0.16, 0.12, pz);
    g.add(body, snout);
  }
  const trough = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.12), mat(0x6b4a2f)); trough.position.set(0.42, 0.06, 0.42); g.add(trough);
}

function quarryYard(g: THREE.Group): void {
  const stoneMat = mat(0xb0b4b8);
  for (const [x, y, z] of [[-0.5, 0.1, 0.55], [-0.26, 0.1, 0.6], [-0.4, 0.28, 0.57]]) { const blk = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.24), stoneMat); blk.position.set(x, y, z); blk.rotation.y = rnd(); blk.castShadow = true; g.add(blk); }
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6), mat(0x6b4a2f)); handle.position.set(0.55, 0.3, 0.6); handle.rotation.z = -0.5; g.add(handle);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), mat(0x555a5e)); head.position.set(0.63, 0.52, 0.6); head.rotation.z = 0.3; g.add(head);
}

function minecart(g: THREE.Group, oreCol?: number): void {
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.22, 0.3), mat(0x5b4433)); body.position.set(0.6, 0.22, 0.55); body.castShadow = true; g.add(body);
  for (const [wx, wz] of [[0.43, 0.42], [0.77, 0.42], [0.43, 0.68], [0.77, 0.68]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10), mat(0x2a2420)); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.09, wz); g.add(w); }
  if (oreCol != null) for (let i = 0; i < 4; i++) { const o = new THREE.Mesh(new THREE.DodecahedronGeometry(0.07, 0), mat(oreCol)); o.position.set(0.5 + rnd() * 0.2, 0.34, 0.45 + rnd() * 0.2); o.rotation.set(rnd(), rnd(), rnd()); g.add(o); }
}

// ---------- cottage (woodcutter, forester, sawmill, bakery, mint) ----------
function cottage(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.95, 1.7), mkMat(def.wall, ghost));
  base.position.y = 0.475; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.42, 0.9, 4), mkMat(def.roof, ghost));
  roof.position.y = 1.4; roof.rotation.y = Math.PI / 4; roof.castShadow = !ghost; g.add(roof);
  // little gable-end window
  const win = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.05), mkMat(0xf0e6c2, ghost));
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
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.2), mkMat(def.wall, ghost));
  base.position.set(0, 0.5, -0.28); base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  // dark half-timber framing across the front
  const beam = mkMat(0x5b4433, ghost);
  for (const x of [-0.6, 0, 0.6]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.06), beam); b.position.set(x, 0.5, 0.33); b.userData.marker = true; g.add(b); }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.07, 0.06), beam); rail.position.set(0, 0.74, 0.33); rail.userData.marker = true; g.add(rail);
  // wide hip roof
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.55, 0.9, 4), mkMat(def.roof, ghost));
  roof.position.set(0, 1.44, -0.28); roof.rotation.y = Math.PI / 4; roof.scale.z = 0.82; roof.castShadow = !ghost; g.add(roof);
  // door + two lit windows
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.09), mkMat(0x4a3626, ghost)); door.position.set(0, 0.31, 0.33); door.userData.marker = true; g.add(door);
  for (const x of [-0.62, 0.62]) { const w = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.05), mkMat(0xf4d98a, ghost)); w.position.set(x, 0.56, 0.33); w.userData.marker = true; g.add(w); }
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
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.95), wood); top.position.set(tx, 0.36, cz); top.castShadow = true; g.add(top);
  for (const dx of [-0.18, 0.18]) for (const dz of [-0.4, 0.4]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.06), dark); leg.position.set(tx + dx, 0.18, cz + dz); g.add(leg); }
  for (const dx of [-0.42, 0.42]) { const bench = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.95), wood); bench.position.set(tx + dx, 0.22, cz); bench.castShadow = true; g.add(bench); }
  // mugs & a jug scattered on the table
  for (const dz of [-0.32, -0.02, 0.3]) { const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 7), mat(0xcaa06a)); mug.position.set(tx + (rnd() - 0.5) * 0.2, 0.44, cz + dz); g.add(mug); }
  const jug = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.16, 8), mat(0x7a5230)); jug.position.set(tx - 0.08, 0.47, cz + 0.14); g.add(jug);
  // a barrel at the near corner of the extended side
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.34, 10), mat(0x7a5230)); barrel.position.set(tx + 0.05, 0.17, 0.72); barrel.castShadow = true; g.add(barrel);
  for (const y of [0.06, 0.28]) { const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.015, 5, 10), mat(0x3a2a20)); hoop.rotation.x = Math.PI / 2; hoop.position.set(tx + 0.05, y, 0.72); g.add(hoop); }
}

// ---------- windmill (mill) — rotating sails ----------
function windmill(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.85, 1.7, 12), mkMat(def.wall, ghost));
  tower.position.y = 0.85; tower.castShadow = !ghost; tower.receiveShadow = !ghost; g.add(tower);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.66, 0.55, 12), mkMat(def.roof, ghost));
  cap.position.y = 1.98; cap.castShadow = !ghost; g.add(cap);
  const balcony = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.08, 12), mkMat(0x6b4a2f, ghost));
  balcony.position.y = 0.55; balcony.userData.marker = true; g.add(balcony);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.1), mkMat(0x4a3626, ghost));
  door.position.set(0, 0.28, 0.8); door.userData.marker = true; g.add(door);

  // sail cross — a child group so it inherits building rotation, spun around local Z
  const blades = new THREE.Group();
  blades.position.set(0, 1.75, 0.72);
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), mkMat(0x5b4a34, ghost)); hub.userData.marker = true; blades.add(hub);
  const sparMat = mkMat(0x6b4a2f, ghost);
  const sailMat = mkMat(ghost ? def.wall : 0xefe6d0, ghost);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2; arm.userData.marker = true;
    const spar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.05, 0.06), sparMat); spar.position.y = 0.55; arm.add(spar);
    const sail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.82, 0.02), sailMat); sail.position.set(0.18, 0.6, 0); arm.add(sail);
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
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.78, 1.5), mkMat(def.wall, ghost));
  base.position.y = 0.39; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  const beamMat = mkMat(0x6b4a2f, ghost);
  for (const bx of [-0.68, -0.12, 0.35, 0.8]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.78, 0.05), beamMat);
    beam.position.set(bx, 0.39, 0.76); beam.userData.marker = true; g.add(beam);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.08, 0.05), beamMat);
  rail.position.set(0, 0.71, 0.76); rail.userData.marker = true; g.add(rail);
  // a small shuttered window between the beams
  const win = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.05), mkMat(0xf0e6c2, ghost));
  win.position.set(0.58, 0.42, 0.77); win.userData.marker = true; g.add(win);
  // deep hipped thatch with a generous overhang — sits snug on the walls,
  // no ridge beam (geometry pre-rotated 45° so the mesh can be squashed in z)
  const thatchGeo = new THREE.ConeGeometry(1.52, 1.05, 4);
  thatchGeo.rotateY(Math.PI / 4);
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
const geoStalk = new THREE.CylinderGeometry(0.012, 0.02, 0.32, 4);
const geoEar = new THREE.CylinderGeometry(0.03, 0.018, 0.12, 5);
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
      const bunch = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 5), grapeMat); bunch.scale.y = 1.3; bunch.position.set(px, 0.34, pz); g.add(bunch);
    }
    return g;
  }
  if (kind === 'pasture') {
    const grassMat = mat(0x6fae52), tuftMat = mat(0x87c266);
    for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 3; rx++) {
      const px = (rx - 1) * 0.3 + (rnd() - 0.5) * 0.16;
      const pz = (ry - 1) * 0.3 + (rnd() - 0.5) * 0.16;
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 5), rnd() < 0.5 ? grassMat : tuftMat);
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
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 7), pink); body.scale.set(1.7, 0.95, 1.05); body.position.y = 0.14; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.088, 8, 7), pink); head.position.set(0.2, 0.16, 0); head.castShadow = true; g.add(head);
  const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.048, 0.05, 8), snoutMat); snout.rotation.z = Math.PI / 2; snout.position.set(0.29, 0.14, 0); g.add(snout);
  for (const ez of [0.045, -0.045]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.05, 4), pink); ear.position.set(0.19, 0.25, ez); g.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 5, 4), ink); eye.position.set(0.25, 0.19, ez); g.add(eye);
  }
  for (const [lx, lz] of [[0.11, 0.07], [0.11, -0.07], [-0.11, 0.07], [-0.11, -0.07]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 5), pink); leg.position.set(lx, 0.05, lz); g.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.009, 5, 8, Math.PI * 1.6), snoutMat); tail.position.set(-0.2, 0.17, 0); tail.rotation.y = Math.PI / 2; g.add(tail);
  g.scale.setScalar(big ? 1.3 : 0.82);
  return g;
}

// ---------- fish — cute silver/orange swimmers for the lake ----------
const FISH_COLORS = [0xd98c46, 0xc9c2b0, 0xe0a85a, 0x9fb7c4];
export function makeFish(): THREE.Group {
  const g = new THREE.Group();
  const col = FISH_COLORS[Math.floor(rnd() * FISH_COLORS.length)];
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 6), mat(col)); body.scale.set(1.7, 0.55, 0.85); body.castShadow = false; g.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.13, 4), mat(col)); tail.rotation.z = -Math.PI / 2; tail.position.set(-0.22, 0, 0); tail.scale.set(1, 1, 0.35); g.add(tail);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 4), mat(col)); fin.position.set(0.02, 0.08, 0); fin.scale.set(1, 1, 0.4); g.add(fin);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 5, 4), mat(0x2a2018)); eye.position.set(0.16, 0.03, 0.05); g.add(eye);
  g.scale.setScalar(0.7 + rnd() * 0.5);
  return g;
}

// ---------- barn (storehouse) ----------
function barn(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.05, 1.7), mkMat(def.wall, ghost));
  base.position.y = 0.525; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.72, 0.95, 4), mkMat(def.roof, ghost));
  roof.position.y = 1.52; roof.rotation.y = Math.PI / 4; roof.castShadow = !ghost; g.add(roof);
  // big double doors with pale trim
  const doors = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.78, 0.1), mkMat(0x5b3f28, ghost));
  doors.position.set(0, 0.39, 1.02); doors.userData.marker = true; g.add(doors);
  const trimMat = mkMat(0xece3cf, ghost);
  const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.06, 0.14), trimMat); t1.position.set(0, 0.8, 1.04); t1.userData.marker = true;
  const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.82, 0.14), trimMat); t2.position.set(0.45, 0.4, 1.04); t2.userData.marker = true;
  const t3 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.82, 0.14), trimMat); t3.position.set(-0.45, 0.4, 1.04); t3.userData.marker = true;
  g.add(t1, t2, t3);
  g.scale.set(1.12, 1.08, 1.12);
  return g;
}

// ---------- mine (quarry, gold mine, coal mine) — rocky mound + adit ----------
function mine(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const mound = new THREE.Mesh(new THREE.DodecahedronGeometry(1.05, 0), mkMat(def.wall, ghost));
  mound.position.y = 0.35; mound.scale.set(1, 0.72, 1); mound.rotation.y = 0.5; mound.castShadow = !ghost; mound.receiveShadow = !ghost; g.add(mound);
  // dark timber-framed entrance
  const ent = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.68, 0.5), mkMat(0x241f1b, ghost));
  ent.position.set(0, 0.34, 0.82); ent.userData.marker = true; g.add(ent);
  const beamMat = mkMat(0x6b4a2f, ghost);
  for (const sx of [-0.33, 0.33]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.78, 0.1), beamMat);
    beam.position.set(sx, 0.4, 1.02); beam.userData.marker = true; g.add(beam);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.12, 0.14), beamMat);
  top.position.set(0, 0.78, 1.02); top.userData.marker = true; g.add(top);
  // ore chunks in the accent colour (skip on ghost)
  if (!ghost && def.accent != null) {
    for (let i = 0; i < 3; i++) {
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.15, 0), mat(def.accent));
      chunk.position.set((rnd() - 0.5) * 1.3, 0.15, -0.35 - rnd() * 0.55); chunk.rotation.set(rnd(), rnd(), rnd()); chunk.castShadow = true;
      g.add(chunk);
    }
  }
  // quarry stacks cut blocks & leans a pickaxe; the mines park an ore-laden cart
  if (!ghost) {
    if (def.gather?.node === 'stone') quarryYard(g);
    else minecart(g, def.accent);
  }
  return g;
}
