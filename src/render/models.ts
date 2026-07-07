import * as THREE from 'three';
import { rnd } from '../engine/rng';
import type { BuildingDef } from '../types';

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

// =====================================================================
//  Doodads
// =====================================================================
export function makeTree(): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(geoTrunk, mat(0x7a5a3a)); trunk.position.y = 0.25; trunk.castShadow = true;
  const folColor = [0x4e7a3a, 0x557f38, 0x476f36, 0x5f8c40][Math.floor(rnd() * 4)];
  const fol = new THREE.Mesh(geoFol, mat(folColor)); fol.position.y = 0.85; fol.castShadow = true;
  const fol2 = new THREE.Mesh(geoFol2, mat(folColor)); fol2.position.y = 1.28; fol2.castShadow = true;
  g.add(trunk, fol, fol2);
  g.rotation.y = rnd() * Math.PI;
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

export function makeUnit(colorHex: number): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(geoBody, mat(colorHex)); body.position.y = 0.21; body.castShadow = true;
  const head = new THREE.Mesh(geoHead, mat(0xe8c9a0)); head.position.y = 0.55; head.castShadow = true;
  const item = new THREE.Mesh(geoItem, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  item.position.y = 0.82; item.visible = false;
  g.add(body, head, item);
  return { group: g, itemMesh: item };
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

// ---------- farmhouse (farm) — thatched roof + haystack ----------
function farmhouse(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.82, 1.5), mkMat(def.wall, ghost));
  base.position.y = 0.41; base.castShadow = !ghost; base.receiveShadow = !ghost; g.add(base);
  // white plaster + timber frame stripes
  const beamMat = mkMat(0x6b4a2f, ghost);
  for (const bx of [-0.55, 0, 0.55]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.82, 0.05), beamMat);
    beam.position.set(bx, 0.41, 0.76); beam.userData.marker = true; g.add(beam);
  }
  // thatched roof — soft straw colour, oversized with overhang
  const thatch = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.95, 4), mkMat(0xcaab5c, ghost));
  thatch.position.y = 1.25; thatch.rotation.y = Math.PI / 4; thatch.castShadow = !ghost; g.add(thatch);
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 1.55), mkMat(0xa98d45, ghost));
  ridge.position.y = 1.66; ridge.userData.marker = true; g.add(ridge);
  addDoor(g, ghost);
  // haystack + a pumpkin-ish gourd for cosy farm vibes (skip on ghost)
  if (!ghost) {
    const hay = new THREE.Group();
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.4, 10), mat(0xd7bd63)); stack.position.y = 0.2; stack.castShadow = true;
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.32, 10), mat(0xc9a94e)); top.position.y = 0.55; top.castShadow = true;
    hay.add(stack, top); hay.position.set(0.98, 0, 0.55); g.add(hay);
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
