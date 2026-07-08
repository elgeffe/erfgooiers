import * as THREE from 'three';
import { uiRng } from '../engine/rng';
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

const matCache: Record<number, THREE.MeshLambertMaterial> = {};
function mat(hex: number): THREE.MeshLambertMaterial {
  if (!matCache[hex]) matCache[hex] = new THREE.MeshLambertMaterial({ color: hex });
  return matCache[hex];
}
// Solid material when placed, translucent when previewing (ghost).
function mkMat(hex: number, ghost: boolean): THREE.MeshLambertMaterial {
  return ghost ? new THREE.MeshLambertMaterial({ color: hex, transparent: true, opacity: 0.55 }) : mat(hex);
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
  const gold = mat(0xffd24a);
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
  const g = new THREE.Group();
  const body = new THREE.Mesh(geoBody, mat(colorHex)); body.position.y = 0.21; body.castShadow = true;
  const head = new THREE.Mesh(geoHead, mat(0xe8c9a0)); head.position.y = 0.55; head.castShadow = true;
  g.add(body, head);
  dressUnit(g, role);
  const item = new THREE.Mesh(geoItem, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  item.position.y = 0.82; item.visible = false;
  g.add(item);
  return { group: g, itemMesh: item };
}

// Give each role its own little hat + outfit accent so trades read at a glance.
// Head sits at y≈0.55 (r 0.14); hats perch around y≈0.66–0.9.
function dressUnit(g: THREE.Group, role: string): void {
  const add = (m: THREE.Mesh, castsShadow = true) => { m.castShadow = castsShadow; g.add(m); };
  // small helpers
  const brim = (col: number, r: number, h: number, y: number) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), mat(col)).translateY(y);
  const dome = (col: number, r: number, y: number) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat(col)); m.position.y = y; m.scale.y = 0.75; return m; };
  const apron = (col: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.06), mat(col)); m.position.set(0, 0.24, 0.19); m.userData.marker = true; return m; };
  const strap = (x: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.04), mat(0x3f5aa0)); m.position.set(x, 0.28, 0.19); m.userData.marker = true; return m; };

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
    default: { // serf — simple tan cap
      add(dome(0xcdbb8f, 0.155, 0.65));
      break;
    }
  }
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
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 6), new THREE.MeshLambertMaterial({ color: 0xbfbfbf, transparent: true, opacity: 0 }));
    m.userData.marker = true;
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
  // ovens & mints get a smoking chimney; the sawmill gets a log pile
  if (def.recipe?.out === 'bread' || def.recipe?.out === 'coin') addChimney(g, ghost);
  if (def.recipe?.out === 'timber') addLogpile(g, ghost);
  return g;
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
  // the farmyard: haystack, leaning wheat sheaves and a bit of paling fence
  if (!ghost) {
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
  return g;
}

// ---------- field crops — wheat stalks that rise as the plot ripens ----------
const geoStalk = new THREE.CylinderGeometry(0.012, 0.02, 0.32, 4);
const geoEar = new THREE.CylinderGeometry(0.03, 0.018, 0.12, 5);
/** A tile's worth of wheat: 3×3 jittered bundles. The View scales the group's
 *  y with growth so young fields read as green shoots, ripe ones as tall grain. */
export function makeFieldCrop(): THREE.Group {
  const g = new THREE.Group();
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
  return g;
}
