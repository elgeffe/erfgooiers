import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Faction } from '../types';
import {
  bakeGroupInto, box, cachedGeo, cone, cyl, flatCone, flatSphere, geoArm,
  geoBelt, geoBlade, geoBody, geoHand, geoHead, geoItem, mat, noOutline,
  ONE, paintGeo, rnd, sharpOutline, sphere, stdMat, torus, UNIT_INK, umat,
  type SceneMaterial,
} from './modelCore';

// Shared materials for rigid, vertex-coloured unit bodies.
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

export function makeTraderCaravan(): THREE.Group {
  const g = new THREE.Group(), dark = umat(0x34281f), wood = umat(0x7a4f2d), cloth = umat(0xb54f38);
  for (const x of [-0.2, 0.2]) { const h = new THREE.Group(); addHorse(h, umat(x < 0 ? 0x8a5a3a : 0x6a4932), dark); h.position.set(x, 0, 0.45); g.add(h); }
  const cart = new THREE.Group(); cart.position.z = -0.45;
  const bed = new THREE.Mesh(box(0.75, 0.18, 0.75), wood); bed.position.y = 0.35; cart.add(bed);
  for (const x of [-0.42, 0.42]) { const w = new THREE.Mesh(cyl(0.22, 0.22, 0.06, 12), dark); w.rotation.z = Math.PI / 2; w.position.set(x, 0.23, 0); cart.add(w); }
  const canopy = new THREE.Mesh(box(0.72, 0.08, 0.72), cloth); canopy.position.y = 0.82; cart.add(canopy);
  for (const x of [-0.31, 0.31]) for (const z of [-0.3, 0.3]) { const p = new THREE.Mesh(box(0.035, 0.5, 0.035), wood); p.position.set(x, 0.58, z); cart.add(p); }
  const trader = makeHumanoid(0x6a4b8a, 'minter').group; trader.scale.setScalar(0.75); trader.position.set(0, 0.42, -0.05); cart.add(trader);
  // cargo crates on the bed — hidden until the caravan has loaded at a market,
  // so it rolls in empty and leaves laden (named for MarketSystem to toggle)
  const cargo = new THREE.Group(); cargo.name = 'cargo'; cargo.visible = false;
  for (const [cx, cz, s] of [[-0.18, -0.16, 0.24], [0.2, -0.14, 0.22], [-0.04, 0.16, 0.26], [0.16, 0.2, 0.2]] as const) {
    const crate = new THREE.Mesh(box(s, s, s), umat(0x9a6b38)); crate.position.set(cx, 0.5, cz); cargo.add(crate);
  }
  cart.add(cargo);
  g.add(cart); g.scale.setScalar(1.25); return g;
}

export function getCavalryStyle(kind: string, colorHex: number, faction: Faction = 'player'): { horse: number; coat: number; trim: number; bard: number; helmet: number } {
  if (faction === 'enemy') {
    return { horse: 0x0f0c0b, coat: 0x9c3b3b, trim: 0xb03030, bard: 0x7d2424, helmet: 0x2b1d18 };
  }
  return {
    horse: kind === 'horseknight' ? 0x33302c : kind === 'lancer' ? 0x8a5a2b : 0xa9746a,
    coat: colorHex,
    trim: kind === 'horseknight' ? 0x8f97a6 : colorHex,
    bard: kind === 'horseknight' ? 0x7d8794 : colorHex,
    helmet: 0xa9b2bd,
  };
}

/** Cavalry from the Stable: horse + armed rider, silhouette per kind —
 *  the lancer's couched lance, the horse archer's bow & quiver, the horse
 *  knight's full plate and shield. All face +z like every walker. */
export function makeCavalry(kind: string, colorHex: number, faction: Faction = 'player'): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const g = new THREE.Group();
  const dark = umat(0x3a2c1f), skin = umat(0xe8c9a0);
  const style = getCavalryStyle(kind, colorHex, faction);
  const coatM = umat(style.coat);
  const horseM = umat(style.horse);
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
    const helm = new THREE.Mesh(sphere(0.1, 8, 6), umat(style.helmet)); helm.scale.y = 0.8; helm.position.y = 0.9; g.add(helm);
    const plume = new THREE.Mesh(cone(0.028, 0.13, 5), umat(style.trim)); plume.position.y = 1.02; g.add(plume);
    const shield = new THREE.Mesh(cyl(0.09, 0.09, 0.03, 10), umat(0x5a6470));
    shield.rotation.z = Math.PI / 2; shield.position.set(-0.19, 0.62, 0.05); g.add(shield);
    // barding: an armoured skirt over the horse
    const bard = new THREE.Mesh(box(0.26, 0.14, 0.5), umat(style.bard)); bard.position.y = 0.3; g.add(bard);
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
 *  glance — straw hat commoner, hooded merchant, plumed warlord, plumed captain, capped reeve, plumed horselord.
 *  Faces +z like every walker (the sim rotates the group to the travel vector). */
export function makeHero(heroId: string): { group: THREE.Group; itemMesh: THREE.Mesh } {
  const style: Record<string, { horse: number; coat: number; trim: number; hat: number }> = {
    erfgooier: { horse: 0x8a5a2b, coat: 0x5a7a3f, trim: 0xd9b95c, hat: 0xd9b95c },
    merchant: { horse: 0xa9746a, coat: 0x7a4b8a, trim: 0xd4af37, hat: 0x7a4b8a },
    warlord: { horse: 0x33302c, coat: 0x8f97a6, trim: 0xb03030, hat: 0x8f97a6 },
    captain: { horse: 0x8a5a2b, coat: 0x2d5a2d, trim: 0xd4af37, hat: 0x2d5a2d },
    reeve: { horse: 0x9d938a, coat: 0x3f5aa0, trim: 0xece3cf, hat: 0x2a2a30 },
    horselord: { horse: 0x8a5a2b, coat: 0x800020, trim: 0x3d2817, hat: 0x800020 },
    transporter: { horse: 0xb8956a, coat: 0xd4af37, trim: 0x4a4a4a, hat: 0x4a4a4a },
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
  switch (heroId) {
    case 'warlord':
      const helm = new THREE.Mesh(sphere(0.1, 8, 6), hatM); helm.scale.y = 0.75; helm.position.y = 0.92; g.add(helm);
      const plume = new THREE.Mesh(cone(0.03, 0.14, 5), trimM); plume.position.y = 1.04; g.add(plume);
      break;
    case 'merchant':
      const hood = new THREE.Mesh(cone(0.11, 0.16, 7), hatM); hood.position.y = 0.96; g.add(hood);
      const brooch = new THREE.Mesh(sphere(0.02, 6, 5), trimM); brooch.position.set(0, 0.72, 0.11); g.add(brooch);
      break;
    case 'reeve':
      const cap = new THREE.Mesh(cyl(0.1, 0.1, 0.045, 8), hatM); cap.position.y = 0.94; g.add(cap);
      const collar = new THREE.Mesh(cyl(0.08, 0.09, 0.03, 8), trimM); collar.position.y = 0.74; g.add(collar);
      break;
    case 'captain':
      const captainHelm = new THREE.Mesh(sphere(0.1, 8, 6), hatM); captainHelm.scale.y = 0.75; captainHelm.position.y = 0.92; g.add(captainHelm);
      const captainPlume = new THREE.Mesh(cone(0.03, 0.14, 5), trimM); captainPlume.position.y = 1.04; g.add(captainPlume);
      break;
    case 'horselord':
      const horselordHelm = new THREE.Mesh(sphere(0.1, 8, 6), hatM); horselordHelm.scale.y = 0.75; horselordHelm.position.y = 0.92; g.add(horselordHelm);
      const horselordPlume = new THREE.Mesh(cone(0.03, 0.14, 5), trimM); horselordPlume.position.y = 1.04; g.add(horselordPlume);
      break;
    case 'transporter':
      const transporterCap = new THREE.Mesh(cyl(0.1, 0.1, 0.045, 8), hatM); transporterCap.position.y = 0.94; g.add(transporterCap);
      const transporterCollar = new THREE.Mesh(cyl(0.08, 0.09, 0.03, 8), trimM); transporterCollar.position.y = 0.74; g.add(transporterCollar);
      break;
    default:
      const brim = new THREE.Mesh(cyl(0.13, 0.13, 0.02, 9), hatM); brim.position.y = 0.93; g.add(brim);
      const crown = new THREE.Mesh(cyl(0.07, 0.08, 0.07, 9), hatM); crown.position.y = 0.97; g.add(crown);
  }
  const item = new THREE.Mesh(geoItem, stdMat({ color: 0xffffff }));
  item.position.y = 1.1; item.visible = false;
  g.add(item);
  return bakeUnit({ group: g, itemMesh: item }, false);
}

export function makeUnit(colorHex: number, role = 'serf', faction: Faction = 'player'): { group: THREE.Group; itemMesh: THREE.Mesh } {
  // fliers keep their part meshes — the sim flaps their wings every tick
  if (role === 'dragon') return makeDragon(colorHex);
  if (role === 'demon') return makeDemon(colorHex);
  if (role === 'lancer' || role === 'horseknight' || role === 'horsearcher') return makeCavalry(role, colorHex, faction);
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
    case 'priest': { // pointed white mitre, Christian cross and crozier
      const mitre = hatCone(0xf4efe2, 0.19, 0.38, 4); mitre.position.y = 0.82; mitre.scale.z = 0.58; add(mitre);
      const band = new THREE.Mesh(box(0.28, 0.045, 0.04), mat(0xd9a441)); band.position.set(0, 0.72, 0.12); add(band);
      const cv = new THREE.Mesh(box(0.035, 0.16, 0.025), mat(0xd9a441)); cv.position.set(0, 0.86, 0.13); add(cv);
      const ch = new THREE.Mesh(box(0.11, 0.035, 0.025), mat(0xd9a441)); ch.position.set(0, 0.89, 0.13); add(ch);
      add(apron(0xf4efe2));
      const staff = new THREE.Group();
      const shaft = new THREE.Mesh(box(0.025, 0.7, 0.025), mat(0xb8912e)); shaft.position.y = 0.28;
      const hook = new THREE.Mesh(torus(0.08, 0.018, 6, 10, Math.PI * 1.5), mat(0xb8912e)); hook.position.set(0.06, 0.66, 0); hook.rotation.z = Math.PI / 2;
      staff.add(shaft, hook); staff.position.set(0.27, 0.1, 0.05); add(staff);
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

