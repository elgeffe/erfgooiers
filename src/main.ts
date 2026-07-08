import './style.css';
import { World } from './world/World';
import { View } from './render/View';
import { Game } from './game/Game';
import { UI } from './ui/UI';
import { Controls } from './input/Controls';
import { logoSVG } from './ui/logo';
import { simRng, uiRng } from './engine/rng';
import { RUN_LEVELS, currentLevelSeed, newRun, type MetaState, type Phase, type RunState } from './game/RunState';
import * as Save from './game/SaveGame';

/* =====================================================================
   Erfgooiers — roguelite economy builder set in Het Gooi.
   Composition root + run lifecycle. The View (renderer/camera/lights)
   persists for the whole session; each level builds a fresh World → Game
   under it via startLevel() and tears it down with disposeLevel(), so the
   state machine (menu → playing → shop → summary) can rebuild levels
   deterministically without leaking GPU resources.
   ===================================================================== */

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const minimap = $('minimap') as HTMLCanvasElement;

// ---------- persistent session objects (built once) ----------
const view = new View(canvas, minimap);
const ui = new UI();
const controls = new Controls(view, ui);
ui.onMode = m => controls.setMode(m);

let meta: MetaState = Save.loadMeta();
let run: RunState | null = null;
let game: Game | null = null;
let phase: Phase = 'menu';

// ---------- level lifecycle ----------
function startLevel(): void {
  if (!run) return;
  const seed = currentLevelSeed(run);
  // Seed the non-world streams deterministically from the level seed so a
  // replayed level looks and plays identically. World reseeds worldRng itself.
  simRng.reseed(seed ^ 0x5bd1e995);
  uiRng.reseed(seed ^ 0x27d4eb2f);

  const world = new World({ seed });
  view.loadWorld(world);
  game = new Game(world, view);
  game.toast = (m, c) => ui.toast(m, c);
  game.onSelect = o => ui.showInspector(o);
  game.init();
  ui.setGame(game);
  controls.setGame(game);
  ui.setObjective(`Level ${run.levelIndex} / ${RUN_LEVELS} — debug: press “✓ Win” to clear`);
  view.centerOn(world.wx(game.store.x) + 0.5, world.wz(game.store.y) + 2);
  view.drawMinimap(game.units);

  simAcc = 0;
  phase = 'playing';
  showScreen(null);
  Save.saveRun(run); // persist at the level's start so a reload resumes here
}

function disposeLevel(): void {
  view.clearWorld();
  game = null;
}

// ---------- transitions ----------
function goMenu(): void {
  phase = 'menu';
  renderMenu();
  showScreen('menu');
}

function newRunFromMenu(): void {
  run = newRun(1 + Math.floor(Math.random() * 2147483645));
  meta.stats.runs++;
  Save.saveMeta(meta);
  startLevel();
}

function continueRun(): void {
  const saved = Save.loadRun();
  if (!saved) { goMenu(); return; }
  run = saved;
  startLevel();
}

function debugWin(): void {
  if (phase !== 'playing' || !run) return;
  const speedBonus = 0; // Phase 1 adds the under-target-time bonus
  run.gold += 20 + run.levelIndex * 5 + speedBonus;
  meta.stats.levelsCleared++;
  meta.stats.bestLevel = Math.max(meta.stats.bestLevel, run.levelIndex);
  meta.heritage += 3 + run.levelIndex; // bank Heritage now, even without a sink yet
  Save.saveMeta(meta);
  disposeLevel();

  if (run.levelIndex >= RUN_LEVELS) { phase = 'summary'; renderSummary(true); showScreen('summary'); Save.clearRun(); run = null; }
  else { phase = 'shop'; renderShop(); showScreen('shop'); Save.saveRun(run); }
}

function shopContinue(): void {
  if (!run) { goMenu(); return; }
  run.levelIndex++;
  startLevel();
}

function abandonRun(): void {
  if (phase === 'playing') disposeLevel();
  Save.clearRun();
  run = null;
  goMenu();
}

function clearSaveData(): void {
  if (phase === 'playing') disposeLevel();
  Save.clearAll();
  meta = Save.loadMeta();
  run = null;
  goMenu();
  ui.toast('Save data cleared');
}

// ---------- screens (DOM overlays) ----------
type ScreenId = 'menu' | 'shop' | 'summary' | null;
function showScreen(id: ScreenId): void {
  for (const s of ['menu', 'shop', 'summary']) $(s).style.display = id === s ? 'flex' : 'none';
  $('hud').style.display = phase === 'playing' ? 'block' : 'none';
}

function renderMenu(): void {
  const has = Save.hasRun();
  const cont = $('btnContinue') as HTMLButtonElement;
  cont.style.display = has ? 'block' : 'none';
  $('metaLine').innerHTML =
    `<b>${meta.heritage}</b> Heritage · runs: ${meta.stats.runs} · levels cleared: ${meta.stats.levelsCleared} · best: level ${meta.stats.bestLevel || 0}`;
}

function renderShop(): void {
  if (!run) return;
  $('shopGold').innerHTML = `<b>${run.gold}</b> gold · next: level ${run.levelIndex + 1} / ${RUN_LEVELS}`;
}

function renderSummary(victory: boolean): void {
  $('sumTitle').textContent = victory ? 'Run complete — victory!' : 'Run over';
  $('sumSub').textContent = victory
    ? `You cleared all ${RUN_LEVELS} levels of Het Gooi.`
    : 'Your run has ended.';
  $('sumBody').innerHTML =
    `<b>${meta.heritage}</b> Heritage banked · lifetime levels cleared: ${meta.stats.levelsCleared}`;
}

// ---------- wire screen + debug buttons ----------
$('menuLogo').innerHTML = logoSVG(40);
$('introLogo').innerHTML = logoSVG(40);
($('btnNewRun') as HTMLButtonElement).onclick = newRunFromMenu;
($('btnContinue') as HTMLButtonElement).onclick = continueRun;
($('btnClearSave') as HTMLButtonElement).onclick = clearSaveData;
($('btnHelp') as HTMLButtonElement).onclick = () => $('intro').style.display = 'flex';
($('startBtn') as HTMLButtonElement).onclick = () => $('intro').style.display = 'none';
($('btnShopContinue') as HTMLButtonElement).onclick = shopContinue;
($('btnSumMenu') as HTMLButtonElement).onclick = goMenu;
($('btnDebugWin') as HTMLButtonElement).onclick = debugWin;
($('btnToMenu') as HTMLButtonElement).onclick = abandonRun;

// ---------- main loop (fixed-timestep sim, real-time render) ----------
const TICK = 1 / 20;          // 20 sim steps/second — determinism & replay ready
const MAX_STEPS = 6;          // clamp catch-up so a slow frame can't spiral
let simAcc = 0;
let last = performance.now();
let uiT = 0, mmT = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;

  controls.update(dt);                       // keyboard camera panning
  if (game) view.animate(dt, game.buildings); // sails & clouds (real-time, ignores pause)

  if (phase === 'playing' && game) {
    simAcc += dt * game.simSpeed;
    let steps = 0;
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    if (simAcc > TICK) simAcc = 0;            // drop the backlog rather than fast-forward

    uiT += dt; if (uiT > 0.4) { uiT = 0; ui.tick(); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }
  }

  view.render();
}

goMenu();
requestAnimationFrame(frame);

