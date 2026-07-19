/**
 * Standalone building-model viewer — a dev tool for inspecting and iterating on
 * a single mesh in isolation, without launching the whole game and driving to
 * place a building. Served by Vite in dev only:
 *
 *   npm run dev -- --port 5199
 *   → http://localhost:5199/erfgooiers/model-viewer.html?model=barracks
 *
 * URL params: model, ghost=1, spin=1, seed=<n>, biome=<key>, view=<preset>.
 * A `window.__viewer` API (show/report/setView/setGhost/setBiome) plus a
 * `window.__modelReport` snapshot let a headless Playwright session screenshot
 * any model and read its footprint report. See the `render-model` skill.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeBuilding, makeUnit } from '../render/models';
import { setActiveBiome, withSeededScatter } from '../render/modelCore';
import { DEFS, MENU_CATEGORIES } from '../data/buildings';
import { BIOMES, type BiomeKey } from '../data/biomes';
import type { BuildingKey } from '../types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

// ---- state (seeded from the URL so screenshots are reproducible) ----
const mParam = params.get('model');
let currentKey: BuildingKey = (mParam && mParam in DEFS ? mParam : 'barracks') as BuildingKey;
// unit=<role> renders a unit model instead of a building (internally the key
// becomes "unit:<role>"); carry=1 shows the hauled crate on top.
const uParam = params.get('unit');
if (uParam) currentKey = ('unit:' + uParam) as BuildingKey;
const showCarry = params.get('carry') === '1';
const bParam = params.get('biome');
let biomeKey: BiomeKey = (bParam && bParam in BIOMES ? bParam : 'gooi') as BiomeKey;
let ghost = params.get('ghost') === '1';
let spin = params.get('spin') === '1';
let wire = false;
let seed = Math.max(1, Number(params.get('seed')) || 1);
// color=<hex> previews a co-op player colour (roof recolour + mine headframe).
const colorParam = params.get('color');
const playerColor = colorParam ? parseInt(colorParam.replace('#', ''), 16) : undefined;

const FOOTPRINT_LIMIT = 1.05; // world half-extent of a building's 2×2 tile footprint

// ---- renderer / scene / lights (matched to render/View.ts) ----
const canvas = $<HTMLCanvasElement>('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec7e6);

scene.add(new THREE.AmbientLight(0xffffff, 0.46));
scene.add(new THREE.HemisphereLight(0xdaeeff, 0x6f8a52, 0.56));
const sun = new THREE.DirectionalLight(0xfff0d2, 2.2);
sun.position.set(-18, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.far = 100;
(sun.shadow as THREE.DirectionalLightShadow & { intensity: number }).intensity = 0.72;
sun.shadow.normalBias = 0.03;
const sc = sun.shadow.camera;
sc.left = -4; sc.right = 4; sc.top = 4; sc.bottom = -4; sc.updateProjectionMatrix();
scene.add(sun, sun.target);
const fill = new THREE.DirectionalLight(0x9db8ff, 0.5);
fill.position.set(20, 18, -14);
scene.add(fill, fill.target);

// ---- camera + orbit controls ----
let viewSize = 2.8;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.85, 0);
controls.enableDamping = true;

const VIEWS = {
  iso: new THREE.Vector3(28, 34, 28),
  front: new THREE.Vector3(0, 7, 42),
  back: new THREE.Vector3(0, 7, -42),
  left: new THREE.Vector3(-42, 7, 0),
  right: new THREE.Vector3(42, 7, 0),
  top: new THREE.Vector3(0, 42, 0.01),
} as const;
type ViewName = keyof typeof VIEWS;
function setView(name: ViewName): void {
  camera.position.copy(controls.target).add(VIEWS[name]);
  controls.update();
}
setView((params.get('view') as ViewName) in VIEWS ? params.get('view') as ViewName : 'iso');

function resize(): void {
  const w = innerWidth, h = innerHeight, a = w / h;
  renderer.setSize(w, h);
  camera.left = -viewSize * a; camera.right = viewSize * a;
  camera.top = viewSize; camera.bottom = -viewSize;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- ground, tile grid and footprint reference ----
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 14),
  new THREE.MeshLambertMaterial({ color: 0x6f8a52 }),
);
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const grid = new THREE.GridHelper(8, 8, 0x35472c, 0x44583a);
(grid.material as THREE.Material & { opacity: number; transparent: boolean }).transparent = true;
(grid.material as THREE.Material & { opacity: number }).opacity = 0.55;
grid.position.y = 0.005; scene.add(grid);

const footprint = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(FOOTPRINT_LIMIT * 2, 2.6, FOOTPRINT_LIMIT * 2)),
  new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.5 }),
);
footprint.position.y = 1.3; scene.add(footprint);

// ---- model holder ----
const holder = new THREE.Group();
scene.add(holder);
let current: THREE.Group | null = null;

interface ModelReport {
  key: string; meshes: number;
  size: { x: number; y: number; z: number };
  minY: number;
  footprintOverflow: { part: string; x: number; z: number; reach: number }[];
}

function inspect(g: THREE.Group, key: BuildingKey): ModelReport {
  g.updateMatrixWorld(true);
  const overall = new THREE.Box3();
  const overflow: ModelReport['footprintOverflow'] = [];
  let meshes = 0;
  g.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const b = new THREE.Box3().setFromObject(m);
    overall.union(b);
    const reach = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z);
    if (reach > FOOTPRINT_LIMIT) {
      const geo = (m.geometry as THREE.BufferGeometry).type.replace('Geometry', '');
      overflow.push({ part: geo, x: +m.position.x.toFixed(2), z: +m.position.z.toFixed(2), reach: +reach.toFixed(2) });
    }
  });
  const size = overall.getSize(new THREE.Vector3());
  overflow.sort((a, b) => b.reach - a.reach);
  return {
    key, meshes,
    size: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
    minY: +overall.min.y.toFixed(3),
    footprintOverflow: overflow,
  };
}

function renderReport(r: ModelReport): void {
  const def = DEFS[r.key as BuildingKey] as (typeof DEFS)[BuildingKey] | undefined;
  const over = r.footprintOverflow;
  const sink = r.minY < -0.02 ? `\n<span class="warn">⚠ dips ${(-r.minY).toFixed(2)} below ground</span>` : '';
  const overLine = over.length
    ? `<span class="warn">⚠ ${over.length} part(s) past the footprint:</span>\n` +
      over.slice(0, 6).map(o => `  • ${o.part} @(${o.x}, ${o.z}) reaches ${o.reach}`).join('\n')
    : '<span class="ok">✓ all parts within the 2×2 footprint</span>';
  $('readout').innerHTML =
    `<b>${def?.name ?? r.key}</b>  (${r.key})\n` +
    `size  ${r.size.x} × ${r.size.y} × ${r.size.z}   ·   ${r.meshes} meshes${sink}\n` +
    overLine;
}

function applyWire(g: THREE.Group): void {
  g.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
      (mat as THREE.MeshLambertMaterial).wireframe = wire;
    }
  });
}

let spinTarget: THREE.Object3D | null = null;
let lastReport: ModelReport | null = null;
function build(key: BuildingKey): void {
  if (current) { holder.remove(current); current = null; }
  currentKey = key;
  setActiveBiome(BIOMES[biomeKey]);
  // seed the cosmetic scatter so a given seed always yields the same props
  const g = withSeededScatter(seed, () => {
    if (!key.startsWith('unit:')) return makeBuilding(key, DEFS[key], ghost, playerColor);
    const { group, itemMesh } = makeUnit(playerColor ?? 0x2d5a2d, key.slice(5));
    if (showCarry) {
      itemMesh.visible = true;
      ((itemMesh.material as THREE.MeshLambertMaterial).color as THREE.Color).setHex(0xb08a5c);
    }
    return group;
  });
  g.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = !ghost; m.receiveShadow = false; }
  });
  applyWire(g);
  holder.add(g);
  current = g;
  // units are a fraction of a building's size — frame them tightly
  const unitScale = key.startsWith('unit:');
  viewSize = unitScale ? 1.0 : 2.8;
  controls.target.y = unitScale ? 0.5 : 0.85;
  footprint.visible = !unitScale;
  resize();
  spinTarget = (g.userData.spin as THREE.Object3D) ?? null; // windmill sails, etc.
  lastReport = inspect(g, key);
  renderReport(lastReport);
  (window as { __modelReport?: ModelReport }).__modelReport = lastReport;
  syncUrl();
  const sel = $<HTMLSelectElement>('model');
  if (sel.value !== key) sel.value = key;
}
function setGhost(v: boolean): void {
  ghost = v;
  const box = $<HTMLInputElement>('ghost'); box.checked = v;
  build(currentKey);
}

function syncUrl(): void {
  const p = new URLSearchParams();
  if (currentKey.startsWith('unit:')) p.set('unit', currentKey.slice(5));
  else p.set('model', currentKey);
  if (ghost) p.set('ghost', '1');
  if (spin) p.set('spin', '1');
  if (seed !== 1) p.set('seed', String(seed));
  if (biomeKey !== 'gooi') p.set('biome', biomeKey);
  history.replaceState(null, '', location.pathname + '?' + p.toString());
}

// ---- populate the model + biome pickers ----
const sel = $<HTMLSelectElement>('model');
const grouped = new Set<string>();
for (const cat of MENU_CATEGORIES) {
  const og = document.createElement('optgroup'); og.label = cat.name;
  for (const key of cat.keys) {
    grouped.add(key);
    const o = document.createElement('option'); o.value = key; o.textContent = DEFS[key].name; og.appendChild(o);
  }
  sel.appendChild(og);
}
const otherKeys = (Object.keys(DEFS) as BuildingKey[]).filter(k => !grouped.has(k));
if (otherKeys.length) {
  const og = document.createElement('optgroup'); og.label = 'Other / Enemy';
  for (const key of otherKeys) {
    const o = document.createElement('option'); o.value = key; o.textContent = `${DEFS[key].name} (${key})`; og.appendChild(o);
  }
  sel.appendChild(og);
}
const biomeSel = $<HTMLSelectElement>('biome');
for (const key of Object.keys(BIOMES) as BiomeKey[]) {
  const o = document.createElement('option'); o.value = key; o.textContent = BIOMES[key].name; biomeSel.appendChild(o);
}
biomeSel.value = biomeKey;

// ---- ordered key list for prev/next ----
const ORDER: BuildingKey[] = [...MENU_CATEGORIES.flatMap(c => c.keys), ...otherKeys];
function step(delta: number): void {
  const i = ORDER.indexOf(currentKey);
  build(ORDER[(i + delta + ORDER.length) % ORDER.length]);
}

// ---- wiring ----
sel.value = currentKey;
sel.onchange = () => build(sel.value as BuildingKey);
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  b.onclick = () => setView(b.dataset.view as ViewName);
}
const spinBox = $<HTMLInputElement>('spin'); spinBox.checked = spin; spinBox.onchange = () => { spin = spinBox.checked; syncUrl(); };
const ghostBox = $<HTMLInputElement>('ghost'); ghostBox.checked = ghost; ghostBox.onchange = () => setGhost(ghostBox.checked);
const wireBox = $<HTMLInputElement>('wire'); wireBox.onchange = () => { wire = wireBox.checked; if (current) applyWire(current); };
$<HTMLInputElement>('footprint').onchange = e => { footprint.visible = (e.target as HTMLInputElement).checked; };
$<HTMLInputElement>('grid').onchange = e => { grid.visible = (e.target as HTMLInputElement).checked; };
$<HTMLInputElement>('shadow').onchange = e => { renderer.shadowMap.enabled = (e.target as HTMLInputElement).checked; scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = (e.target as HTMLInputElement).checked && !ghost; }); };
const seedBox = $<HTMLInputElement>('seed'); seedBox.value = String(seed);
seedBox.onchange = () => { seed = Math.max(1, Number(seedBox.value) || 1); build(currentKey); };
$('reseed').onclick = () => { seed = 1 + Math.floor(Math.random() * 9999); seedBox.value = String(seed); build(currentKey); };
biomeSel.onchange = () => { biomeKey = biomeSel.value as BiomeKey; build(currentKey); };
addEventListener('keydown', e => {
  if (e.key === '[') step(-1);
  else if (e.key === ']') step(1);
  else if (e.key === 'g') setGhost(!ghost);
});

// ---- render loop ----
function frame(): void {
  requestAnimationFrame(frame);
  if (spin && current) holder.rotation.y += 0.008;
  if (spinTarget) spinTarget.rotation.z += 0.02;
  controls.update();
  renderer.render(scene, camera);
}
frame();

// ---- headless API (for the render-model skill / Playwright) ----
interface ViewerApi {
  show(k: string): ModelReport | null;
  keys: string[];
  report(): ModelReport | null;
  setGhost(v: boolean): void;
  setView(v: ViewName): void;
  setBiome(b: string): void;
  setSeed(n: number): void;
}
(window as unknown as { __viewer: ViewerApi }).__viewer = {
  show: k => { if (!(k in DEFS) && !k.startsWith('unit:')) return null; build(k as BuildingKey); return lastReport; },
  keys: Object.keys(DEFS),
  report: () => lastReport,
  setGhost,
  setView,
  setBiome: b => { if (b in BIOMES) { biomeKey = b as BiomeKey; biomeSel.value = b; build(currentKey); } },
  setSeed: n => { seed = Math.max(1, n | 0); seedBox.value = String(seed); build(currentKey); },
};

build(currentKey);
(window as unknown as { __ready: boolean }).__ready = true;
