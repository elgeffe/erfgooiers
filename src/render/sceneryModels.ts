import * as THREE from 'three';
import type { DecoKind } from '../types';
import {
  activeBiome, box, circle, cone, cyl, dodeca, FOL_GREENS, geoBlade, geoFol,
  geoFol2, geoRock, geoTrunk, GOLD_INK, goldSharp, mat, rnd, sharpOutline,
  sphere, stdMat, torus,
  type SceneMaterial,
} from './modelCore';

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

