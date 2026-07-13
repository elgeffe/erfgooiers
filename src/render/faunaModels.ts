import * as THREE from 'three';
import { box, cone, cyl, mat, rnd, sphere, torus } from './modelCore';

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


