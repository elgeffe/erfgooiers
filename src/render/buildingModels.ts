import * as THREE from 'three';
import type { BuildingDef, BuildingKey } from '../types';
import {
  box, cachedGeo, capsule, circle, cone, cyl, dodeca, geoPost, mat, mkMat,
  rnd, sphere, stdMat, torus,
} from './modelCore';
import { makeFish } from './faunaModels';

// =====================================================================
//  Buildings
// =====================================================================
/**
 * Build a building mesh. In co-op each player picks a preset colour; passing
 * that colour recolours the building's roof to it so ownership reads at a
 * glance. Mines have no roof — their headframe (the timber attachment on the
 * grey mound) takes the colour instead. Single player passes no colour and
 * every building keeps its own palette from `def`.
 */
export function makeBuilding(key: BuildingKey, def: BuildingDef, ghost: boolean, playerColor?: number): THREE.Group {
  // A shallow copy with the roof recoloured drives every roof mesh (they all
  // read def.roof) without mutating the shared, frozen BuildingDef.
  if (playerColor != null) def = { ...def, roof: playerColor };
  switch (key) {
    case 'woodcutter': return woodcutterHut(def, ghost);
    case 'forester': return foresterLodge(def, ghost);
    case 'sawmill': return sawmillBuilding(def, ghost);
    case 'quarry': return quarryBuilding(def, ghost, playerColor);
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
    case 'monastery': return monasteryBuilding(def, ghost);
    case 'market': return marketBuilding(def, ghost);
    case 'woodwall': return woodenWall(def, ghost);
    case 'woodgate': return woodenGate(def, ghost);
    case 'wall': case 'enemywall': return wallSegment(def, ghost);
    case 'gate': case 'enemygate': return gateArch(def, ghost);
  }
  switch (def.model) {
    case 'windmill': return windmill(def, ghost);
    case 'farm': return farmhouse(def, ghost);
    case 'barn': return barn(def, ghost);
    case 'mine': return mine(key, def, ghost, playerColor);
    case 'tavern': return tavern(def, ghost);
    case 'castle': return castle(key, def, ghost);
    case 'guildhall': return guildhall(def, ghost);
    default: return cottage(def, ghost);
  }
}

function monasteryBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const stone = mkMat(def.wall, ghost), roof = mkMat(def.roof, ghost), gold = mkMat(def.accent ?? 0xd9a441, ghost);
  
  const nave = new THREE.Mesh(box(1.75, 0.85, 1.45), stone); nave.position.set(0, 0.43, 0.12); nave.castShadow = !ghost; g.add(nave);
  
  // Roof Slopes Fixed Here
  for (const s of [-1, 1]) {
    const slope = new THREE.Mesh(box(0.98, 0.12, 1.58), roof); 
    slope.position.set(s * 0.42, 1.02, 0.12); 
    slope.rotation.z = -s * 0.55; 
    g.add(slope);
  }
  
  const tower = new THREE.Mesh(box(0.52, 1.35, 0.52), stone); tower.position.set(-0.55, 0.68, -0.5); tower.castShadow = !ghost; g.add(tower);
  const spire = new THREE.Mesh(cone(0.42, 0.65, 4), roof); spire.position.set(-0.55, 1.68, -0.5); spire.rotation.y = Math.PI / 4; g.add(spire);
  const crossV = new THREE.Mesh(box(0.06, 0.4, 0.06), gold); crossV.position.set(-0.55, 2.08, -0.5); g.add(crossV);
  const crossH = new THREE.Mesh(box(0.25, 0.06, 0.06), gold); crossH.position.set(-0.55, 2.12, -0.5); g.add(crossH);
  const door = new THREE.Mesh(box(0.52, 0.68, 0.08), mkMat(0x5b3926, ghost)); door.position.set(-0.35, 0.34, 0.88); door.userData.marker = true; g.add(door);
  for (const x of [0.2, 0.58]) { const w = new THREE.Mesh(box(0.18, 0.32, 0.04), gold); w.position.set(x, 0.5, 0.86); g.add(w); }
  
  return g;
}

function marketBuilding(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group(), plaster = mkMat(def.wall, ghost), roof = mkMat(def.roof, ghost), wood = mkMat(0x6b472d, ghost);
  const hall = new THREE.Mesh(box(1.65, 0.72, 1.25), plaster); hall.position.set(0, 0.36, -0.12); hall.castShadow = !ghost; g.add(hall);
  const cap = new THREE.Mesh(box(1.82, 0.16, 1.42), roof); cap.position.set(0, 0.82, -0.12); g.add(cap);
  for (const x of [-0.68, 0, 0.68]) { const post = new THREE.Mesh(box(0.08, 0.7, 0.08), wood); post.position.set(x, 0.35, 0.72); g.add(post); }
  const awning = new THREE.Mesh(box(1.55, 0.08, 0.55), roof); awning.position.set(0, 0.78, 0.72); awning.rotation.x = -0.18; g.add(awning);
  const counter = new THREE.Mesh(box(1.45, 0.18, 0.25), wood); counter.position.set(0, 0.38, 0.75); g.add(counter);
  const sign = new THREE.Mesh(box(0.5, 0.38, 0.05), mkMat(def.accent ?? 0xffd24a, ghost)); sign.position.set(0, 1.15, 0.52); sign.userData.marker = true; g.add(sign);
  return g;
}

// ---------- fortifications: a crenellated rampart block and a barred gate ----------
function woodenWall(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const timber = mkMat(def.wall, ghost), dark = mkMat(def.accent ?? 0x4b3222, ghost);
  for (let x = -0.82; x <= 0.82; x += 0.205) {
    const post = new THREE.Mesh(cyl(0.12, 0.12, 1.35, 7), timber);
    post.position.set(x, 0.68, 0); post.castShadow = !ghost; g.add(post);
    const point = new THREE.Mesh(cone(0.13, 0.3, 7), timber);
    point.position.set(x, 1.5, 0); g.add(point);
  }
  for (const y of [0.42, 1.02]) {
    const rail = new THREE.Mesh(box(1.9, 0.16, 0.2), dark);
    rail.position.set(0, y, -0.13); g.add(rail);
  }
  return g;
}

function woodenGate(def: BuildingDef, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const timber = mkMat(def.wall, ghost), dark = mkMat(def.accent ?? 0x4b3222, ghost);
  for (const x of [-0.82, 0.82]) {
    const post = new THREE.Mesh(box(0.24, 1.75, 0.3), timber);
    post.position.set(x, 0.88, 0); post.castShadow = !ghost; g.add(post);
    const point = new THREE.Mesh(cone(0.19, 0.38, 4), timber);
    point.position.set(x, 1.94, 0); point.rotation.y = Math.PI / 4; g.add(point);
  }
  const beam = new THREE.Mesh(box(1.9, 0.25, 0.34), dark);
  beam.position.set(0, 1.55, 0); g.add(beam);
  for (const x of [-0.48, -0.24, 0, 0.24, 0.48]) {
    const bar = new THREE.Mesh(box(0.1, 1.25, 0.1), timber);
    bar.position.set(x, 0.65, 0); bar.userData.marker = true; g.add(bar);
  }
  return g;
}

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
  for (const s of [-1, 1]) { // slim piers leave an almost two-tile-wide passage
    const t = new THREE.Mesh(box(0.18, 1.5, 1.9), stone);
    t.position.set(s * 0.9, 0.75, 0); t.castShadow = !ghost; g.add(t);
    const c = new THREE.Mesh(box(0.28, 0.14, 2.0), cap);
    c.position.set(s * 0.86, 1.56, 0); g.add(c);
  }
  const lintel = new THREE.Mesh(box(1.96, 0.4, 1.9), stone);
  lintel.position.y = 1.28; lintel.castShadow = !ghost; g.add(lintel);
  for (const s of [-1, 1]) { // heavy timber doors on both faces of the passage
    const doors = new THREE.Mesh(box(1.62, 1.05, 0.1), wood);
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

  return g;
}

/** Scaffold shown while a building is under construction. */
export function makeScaffold(key: BuildingKey, def: BuildingDef, playerColor?: number): { group: THREE.Group; frame: THREE.Group } {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(box(1.9, 0.08, 1.9), mat(0x8a6b42)); pad.position.y = 0.04; g.add(pad);
  for (const [px, pz] of [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]]) {
    const post = new THREE.Mesh(geoPost, mat(0xc9a06a)); post.position.set(px, 0.35, pz); post.castShadow = true; g.add(post);
  }
  const frame = makeBuilding(key, def, true, playerColor);
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
  // sit the pile clear of the cabin's log walls (x = ±0.7) instead of through them
  const rows = [[-0.92, 0.55, 0.28], [-0.92, 0.55, 0.5], [-0.92, 0.73, 0.39]];
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
  // sawbuck + log rest in the open front bay, clear of the shed's corner posts
  const buckMat = mat(0x6b4a2f);
  for (const sx of [-0.5, -0.12]) for (const rz of [0.35, -0.35]) { const leg = new THREE.Mesh(box(0.04, 0.42, 0.04), buckMat); leg.position.set(sx, 0.2, 0.86); leg.rotation.z = rz; g.add(leg); }
  const log = new THREE.Mesh(cyl(0.09, 0.09, 0.62, 8), mat(0x8a5a2b)); log.rotation.z = Math.PI / 2; log.position.set(-0.31, 0.44, 0.86); log.castShadow = true; g.add(log);
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
  // eave walls run along Z, tucked under the roof's two lower edges (x = ±0.7)
  for (let row = 0; row < 6; row++) for (const x of [-0.7, 0.7]) {
    const log = new THREE.Mesh(cyl(0.085, 0.085, 1.5, 8), logs); log.rotation.x = Math.PI / 2; log.position.set(x, 0.1 + row * 0.14, 0); log.castShadow = !ghost; g.add(log);
  }
  // gable-end walls run along X, closing the cabin into four full log walls (z = ±0.62)
  for (let row = 0; row < 6; row++) for (const z of [-0.62, 0.62]) {
    const log = new THREE.Mesh(cyl(0.085, 0.085, 1.5, 8), logs); log.rotation.z = Math.PI / 2; log.position.set(0, 0.1 + row * 0.14, z); log.castShadow = !ghost; g.add(log);
  }
  // notched log ends at the four corners
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
  const hearth = new THREE.Mesh(box(0.78, 0.58, 0.16), mkMat(0x252329, ghost)); hearth.position.set(0.28, 0.3, 0.69); hearth.userData.marker = true; g.add(hearth);
  // fire nestles inside the hearth mouth rather than poking out over the sill
  const embers = new THREE.Mesh(box(0.5, 0.08, 0.14), mkMat(0xd9531f, ghost)); embers.position.set(0.28, 0.12, 0.66); embers.userData.marker = true; g.add(embers);
  const fire = new THREE.Mesh(cone(0.1, 0.34, 7), mkMat(0xe88335, ghost)); fire.position.set(0.28, 0.3, 0.64); fire.userData.marker = true; g.add(fire);
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
function quarryBuilding(def: BuildingDef, ghost: boolean, playerColor?: number): THREE.Group {
  // Rock steps keep their grey; the timber derrick is the player-colour attachment.
  const g = new THREE.Group(), rock = mkMat(def.wall, ghost), cut = mkMat(0xc4cace, ghost), wood = mkMat(playerColor ?? 0x6b4a2f, ghost);
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
  // inner keep grown to meet the corner turrets so the walls read as one block
  const hall = new THREE.Mesh(box(1.55, 1.2, 1.5), stone); hall.position.set(0, 0.6, -0.1); hall.castShadow = !ghost; hall.receiveShadow = !ghost; g.add(hall);
  gableRoof(g, 1.72, 1.6, 1.52, def.roof, ghost, 0.6);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const tower = new THREE.Mesh(cyl(0.23, 0.27, 1.25, 8), stone); tower.position.set(sx * 0.73, 0.63, sz * 0.65); tower.castShadow = !ghost; g.add(tower); const cap = new THREE.Mesh(cone(0.31, 0.46, 8), roofM); cap.position.set(sx * 0.73, 1.48, sz * 0.65); g.add(cap); }
  for (const x of [-0.4, 0, 0.4]) { const crenel = new THREE.Mesh(box(0.24, 0.24, 0.18), stone); crenel.position.set(x, 1.15, 0.68); g.add(crenel); }
  const gate = new THREE.Mesh(box(0.52, 0.72, 0.14), wood); gate.position.set(0, 0.36, 0.72); gate.userData.marker = true; g.add(gate);
  // warm lit windows in the curtain wall, like the castle keep
  for (const wx of [-0.46, 0.46]) { const win = new THREE.Mesh(box(0.16, 0.3, 0.05), mkMat(0xf4d98a, ghost)); win.position.set(wx, 0.66, 0.66); win.userData.marker = true; g.add(win); }
  for (const sx of [-1, 1]) { const win = new THREE.Mesh(box(0.05, 0.3, 0.16), mkMat(0xf4d98a, ghost)); win.position.set(sx * 0.78, 0.66, -0.1); win.userData.marker = true; g.add(win); }
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
function mine(key: BuildingKey, def: BuildingDef, ghost: boolean, playerColor?: number): THREE.Group {
  const g = new THREE.Group();
  // The mound keeps its natural grey/earth wall colour in every mode — only the
  // timber headframe attached to it takes the co-op player colour.
  const mound = new THREE.Mesh(dodeca(1.05), mkMat(def.wall, ghost));
  mound.position.y = 0.35; mound.scale.set(1, 0.72, 1); mound.rotation.y = 0.5; mound.castShadow = !ghost; mound.receiveShadow = !ghost; g.add(mound);
  // dark timber-framed entrance
  const ent = new THREE.Mesh(box(0.58, 0.68, 0.5), mkMat(0x241f1b, ghost));
  ent.position.set(0, 0.34, 0.82); ent.userData.marker = true; g.add(ent);
  const beamMat = mkMat(playerColor ?? 0x6b4a2f, ghost);
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
    const timber = mkMat(playerColor ?? 0x6b4a2f, ghost);
    for (const x of [-0.52, 0.52]) { const leg = new THREE.Mesh(box(0.11, 1.35, 0.11), timber); leg.position.set(x, 1.05, 0.05); leg.rotation.z = x < 0 ? -0.18 : 0.18; g.add(leg); }
    const cross = new THREE.Mesh(box(1.25, 0.12, 0.14), timber); cross.position.set(0, 1.72, 0.05); g.add(cross);
    const wheel = new THREE.Mesh(torus(0.28, 0.035, 6, 14), mkMat(0xb8912e, ghost)); wheel.rotation.y = Math.PI / 2; wheel.position.set(0, 1.43, 0.06); wheel.userData.marker = true; g.add(wheel);
  } else if (key === 'coalmine') {
    // no breaker house: the big dark box read as a black square sticking out
    // of the mound. The tall stack alone marks the colliery.
    const chute = new THREE.Mesh(box(0.42, 0.24, 0.52), mkMat(playerColor ?? 0x2f3035, ghost)); chute.position.set(0.1, 0.52, 0.38); chute.rotation.z = -0.35; g.add(chute);
    const stack = new THREE.Mesh(cyl(0.13, 0.18, 1.35, 9), mkMat(playerColor ?? 0x313137, ghost)); stack.position.set(0.58, 1.16, -0.36); stack.castShadow = !ghost; g.add(stack);
  } else if (key === 'ironmine') {
    const steel = mkMat(playerColor ?? 0x6d6260, ghost);
    const mast = new THREE.Mesh(box(0.16, 1.55, 0.16), steel); mast.position.set(0.5, 1.0, -0.2); g.add(mast);
    const arm = new THREE.Mesh(box(1.0, 0.12, 0.12), steel); arm.position.set(0.08, 1.72, -0.2); arm.rotation.z = -0.18; g.add(arm);
    // hoist the ore skip on a cable from the arm's tip so it hangs above the
    // mound instead of floating detached in front of it
    const cable = new THREE.Mesh(cyl(0.015, 0.015, 0.3, 5), mkMat(0x40362c, ghost)); cable.position.set(-0.4, 1.62, -0.2); g.add(cable);
    const bucket = new THREE.Mesh(box(0.3, 0.28, 0.3), mkMat(0x8a4a30, ghost)); bucket.position.set(-0.4, 1.36, -0.2); bucket.castShadow = !ghost; g.add(bucket);
    const bail = new THREE.Mesh(torus(0.15, 0.016, 4, 8), steel); bail.position.set(-0.4, 1.5, -0.2); g.add(bail);
  }
  // quarry stacks cut blocks & leans a pickaxe; the mines park an ore-laden cart
  if (!ghost) {
    if (def.gather?.node === 'stone') quarryYard(g);
    else minecart(g, def.accent);
  }
  return g;
}
