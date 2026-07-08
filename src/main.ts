import './style.css';
import { World } from './world/World';
import { View } from './render/View';
import { Game } from './game/Game';
import { UI } from './ui/UI';
import { Controls } from './input/Controls';
import { Shop } from './ui/Shop';
import { logoSVG } from './ui/logo';
import { simRng, uiRng } from './engine/rng';
import { Modifiers } from './game/Modifiers';
import { Objective } from './game/Objectives';
import { specsFor } from './data/upgrades';
import { META_UPGRADES, META_BY_ID, metaSpecsFor, hasMetaSpecial } from './data/metaUpgrades';
import { levelFor, pickObjective, sandboxLevel, type LevelDef } from './data/levels';
import { RUN_LEVELS, currentLevelSeed, newRun, type MetaState, type Phase, type RunState } from './game/RunState';
import * as Save from './game/SaveGame';
import { audio } from './audio/Audio';

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
let currentLevel: LevelDef | null = null;
let sandbox = false;             // free-build mode: no objective, no timer, no save

// per-run tallies for the summary screen (reset when a run starts)
let clearedThisRun = 0;
let goldEarnedThisRun = 0;

const shop = new Shop(shopContinue);

// ---------- level lifecycle ----------
function startLevel(): void {
  if (!run) return;
  const level = sandbox ? sandboxLevel() : levelFor(run.levelIndex);
  currentLevel = level;
  const seed = currentLevelSeed(run);
  // Seed the non-world streams deterministically from the level seed so a
  // replayed level looks and plays identically. World reseeds worldRng itself.
  simRng.reseed(seed ^ 0x5bd1e995);
  uiRng.reseed(seed ^ 0x27d4eb2f);

  const world = new World({ seed, ...level.world });
  view.loadWorld(world);
  const mods = new Modifiers([...specsFor(run.upgrades), ...metaSpecsFor(meta.unlocks)]);
  game = new Game(world, view, mods);
  game.toast = (m, c) => ui.toast(m, c);
  game.onSelect = o => ui.showInspector(o);
  game.sfx = name => audio.play(name as any);
  audio.setLevel(level.index);
  audio.setDynamic(sandbox);
  game.onGold = amt => { if (run) { run.gold += amt; goldEarnedThisRun += amt; ui.setGold(run.gold); } };
  game.onHurt = (x, z) => view.spawnHurt(x, z);
  game.onDeath = (x, z, _fac, color) => view.spawnCorpse(x, z, color);
  // pick this level's objective variant deterministically (skipped in sandbox)
  if (sandbox) {
    game.objective = null;
  } else {
    const objDef = pickObjective(level, ((seed >>> 8) % 9973) / 9973);
    game.objective = new Objective(objDef);
  }
  game.init(level.kit);
  ui.setGame(game);
  ui.setPerks(run.upgrades, meta.unlocks);
  controls.setGame(game);
  game.setEnemies(sandbox ? null : (level.enemies ?? null));
  if (!sandbox && level.startArmy) {
    const sx = world.wx(game.store.x) + 0.5, sz = world.wz(game.store.y) + 0.5;
    for (const a of level.startArmy) game.spawnSquad(a.kind, a.count, sx, sz, 'player');
  }
  ui.setGold(run.gold);
  ui.setSandbox(sandbox);
  ($('sandboxbar') as HTMLElement).style.display = sandbox ? 'flex' : 'none';
  if (game.objective) {
    ui.setLevel(level.index, level.name);
    ui.setObjective(game.objective.brief());
    ui.updateObjective(game.objective.evaluate(game).label, 0, level.hardTimer);
  }
  view.centerOn(world.wx(game.store.x) + 0.5, world.wz(game.store.y) + 2);
  view.drawMinimap(game.units);

  simAcc = 0;
  phase = 'playing';
  showScreen(null);
  if (!sandbox) Save.saveRun(run); // persist at the level's start so a reload resumes here
}

function disposeLevel(): void {
  view.clearWorld();
  game = null;
  currentLevel = null;
}

// ---------- transitions ----------
function goMenu(): void {
  phase = 'menu';
  sandbox = false;
  audio.setLevel(0);
  audio.setDynamic(false);
  renderMenu();
  showScreen('menu');
}

function newRunFromMenu(): void {
  sandbox = false;
  run = newRun(1 + Math.floor(Math.random() * 2147483645));
  if (hasMetaSpecial(meta.unlocks, 'startGold')) run.gold = 25;
  meta.stats.runs++;
  Save.saveMeta(meta);
  clearedThisRun = 0;
  goldEarnedThisRun = 0;
  startLevel();
}

/** Free-build mode: a big, timer-free, objective-free map that never touches the save. */
function startSandbox(): void {
  sandbox = true;
  run = newRun(1 + Math.floor(Math.random() * 2147483645));
  clearedThisRun = 0;
  goldEarnedThisRun = 0;
  startLevel();
}

function continueRun(): void {
  const saved = Save.loadRun();
  if (!saved) { goMenu(); return; }
  sandbox = false;
  run = saved;
  clearedThisRun = Math.max(0, saved.levelIndex - 1);
  goldEarnedThisRun = saved.gold;
  startLevel();
}

/** Award gold/Heritage for a cleared level, then advance to shop or victory. */
function onLevelClear(): void {
  if (phase !== 'playing' || !run || !currentLevel || !game) return;
  const speedy = game.elapsed <= currentLevel.timeTarget;
  const base = currentLevel.reward + (speedy ? Math.round(currentLevel.reward * 0.5) : 0);
  const reward = Math.max(1, Math.round(base * game.mods.goldMult()));
  run.gold += reward;
  goldEarnedThisRun += reward;
  clearedThisRun++;
  meta.stats.levelsCleared++;
  meta.stats.bestLevel = Math.max(meta.stats.bestLevel, run.levelIndex);
  meta.heritage += 3 + run.levelIndex; // banked now, sink arrives in Phase 4
  Save.saveMeta(meta);
  audio.play('coin');
  ui.toast(`Level cleared! +${reward} gold${speedy ? ' — speed bonus!' : ''}`);

  const last = run.levelIndex >= RUN_LEVELS;
  disposeLevel();
  if (last) { phase = 'summary'; renderSummary(true); showScreen('summary'); Save.clearRun(); run = null; }
  else { phase = 'shop'; shop.open(run, hasMetaSpecial(meta.unlocks, 'freeReroll')); showScreen('shop'); Save.saveRun(run); }
}

/** The hard timer expired — the run is over. */
function onDefeat(): void {
  if (phase !== 'playing' || !run) return;
  audio.play('error');
  ui.toast('Out of time — the run ends here', 'err');
  disposeLevel();
  phase = 'summary'; renderSummary(false); showScreen('summary');
  Save.clearRun();
  run = null;
}

function debugWin(): void {
  if (phase === 'playing') onLevelClear();
}

function shopContinue(): void {
  if (!run) { goMenu(); return; }
  run.levelIndex++;
  startLevel();
}

function abandonRun(): void {
  if (phase === 'playing') disposeLevel();
  if (!sandbox) Save.clearRun();
  sandbox = false;
  run = null;
  goMenu();
}

/** Open the in-game pause menu, freezing the sim until the player resumes. */
function openPauseMenu(): void {
  if (phase !== 'playing') return;
  ui.setSpeed(0);
  $('pausemenu').style.display = 'flex';
}

/** Close the pause menu and resume the active game. */
function resumeGame(): void {
  $('pausemenu').style.display = 'none';
  if (phase === 'playing') ui.setSpeed(1);
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
type ScreenId = 'menu' | 'shop' | 'summary' | 'heritage' | null;
function showScreen(id: ScreenId): void {
  $('pausemenu').style.display = 'none';
  for (const s of ['menu', 'shop', 'summary', 'heritage']) $(s).style.display = id === s ? 'flex' : 'none';
  $('hud').style.display = phase === 'playing' ? 'block' : 'none';
}

function renderMenu(): void {
  const has = Save.hasRun();
  const cont = $('btnContinue') as HTMLButtonElement;
  cont.style.display = has ? 'block' : 'none';
  $('metaLine').innerHTML =
    `<b>${meta.heritage}</b> Heritage · runs: ${meta.stats.runs} · levels cleared: ${meta.stats.levelsCleared} · best: level ${meta.stats.bestLevel || 0}`;
}

function renderSummary(victory: boolean): void {
  $('sumTitle').textContent = victory ? 'Run complete — victory!' : 'Run over';
  $('sumSub').textContent = victory
    ? `You cleared all ${RUN_LEVELS} levels of Het Gooi.`
    : 'The clock beat you. Your gold and upgrades are gone — but the Heritage remains.';
  $('sumBody').innerHTML =
    `Cleared <b>${clearedThisRun}</b> level(s) this run · gold earned <b>${goldEarnedThisRun}</b> (lost) · ` +
    `<b>${meta.heritage}</b> Heritage banked · lifetime levels cleared: ${meta.stats.levelsCleared}`;
}

// ---------- heritage shop (main menu) ----------
function openHeritage(): void { renderHeritage(); showScreen('heritage'); }

function renderHeritage(): void {
  $('heritageMeta').innerHTML = `<b>${meta.heritage}</b> Heritage to spend`;
  const grid = $('heritageGrid'); grid.innerHTML = '';
  for (const def of META_UPGRADES) {
    const owned = meta.unlocks.includes(def.id);
    const afford = meta.heritage >= def.cost;
    const cls = owned ? 'picked' : afford ? '' : 'cant disabled';
    const price = owned ? 'owned ✓' : `${def.cost} Heritage`;
    const el = document.createElement('div');
    el.className = 'scard' + (cls ? ' ' + cls : '');
    el.innerHTML = `<div class="sc-icon">${def.icon}</div><div class="sc-body"><div class="sc-name">${def.name}</div><div class="sc-desc">${def.desc}</div><div class="sc-price ${cls}">${price}</div></div>`;
    if (!owned && afford) el.onclick = () => buyMeta(def.id);
    grid.appendChild(el);
  }
}

function buyMeta(id: string): void {
  const def = META_BY_ID[id];
  if (!def || meta.unlocks.includes(id) || meta.heritage < def.cost) return;
  meta.heritage -= def.cost;
  meta.unlocks.push(id);
  Save.saveMeta(meta);
  audio.play('coin');
  renderHeritage();
}

// ---------- wire screen + debug buttons ----------
$('menuLogo').innerHTML = logoSVG(40);
$('introLogo').innerHTML = logoSVG(40);
($('btnNewRun') as HTMLButtonElement).onclick = newRunFromMenu;
($('btnContinue') as HTMLButtonElement).onclick = continueRun;
($('btnSandbox') as HTMLButtonElement).onclick = startSandbox;

// ---------- sandbox spawn toolbar ----------
function sandboxSpawn(kind: 'soldier' | 'archer' | 'bandit' | 'boar' | 'dragon', count: number): void {
  if (!game) return;
  const c = view.camTarget;
  const squad = game.spawnSquad(kind, count, c.x, c.z);
  if (squad.length) ui.toast(`Spawned ${squad.length} ${kind}${squad.length > 1 ? 's' : ''}`);
}
($('sbSoldier') as HTMLButtonElement).onclick = () => sandboxSpawn('soldier', 12);
($('sbArcher') as HTMLButtonElement).onclick = () => sandboxSpawn('archer', 8);
($('sbBandit') as HTMLButtonElement).onclick = () => sandboxSpawn('bandit', 12);
($('sbBoar') as HTMLButtonElement).onclick = () => sandboxSpawn('boar', 6);
($('sbDragon') as HTMLButtonElement).onclick = () => sandboxSpawn('dragon', 1);
($('btnClearSave') as HTMLButtonElement).onclick = clearSaveData;
($('btnHelp') as HTMLButtonElement).onclick = () => $('intro').style.display = 'flex';
($('startBtn') as HTMLButtonElement).onclick = () => $('intro').style.display = 'none';
($('btnSumMenu') as HTMLButtonElement).onclick = goMenu;
($('btnDebugWin') as HTMLButtonElement).onclick = debugWin;
($('btnHeritage') as HTMLButtonElement).onclick = openHeritage;
($('btnHeritageBack') as HTMLButtonElement).onclick = goMenu;
($('btnToMenu') as HTMLButtonElement).onclick = openPauseMenu;
($('btnResume') as HTMLButtonElement).onclick = resumeGame;
($('btnAbandon') as HTMLButtonElement).onclick = () => { resumeGame(); abandonRun(); };

// ---------- audio ----------
const btnSound = $('btnSound') as HTMLButtonElement;
function renderSound(): void {
  btnSound.textContent = audio.isMuted ? '🔇' : '🔊';
  btnSound.classList.toggle('off', audio.isMuted);
  btnSound.title = audio.isMuted ? 'Sound off — click to unmute' : 'Sound on — click to mute';
}
btnSound.onclick = e => { e.stopPropagation(); audio.toggleMute(); renderSound(); };
// Browsers gate audio behind a user gesture: unlock on the first interaction.
addEventListener('pointerdown', () => audio.unlock(), { once: true });
renderSound();

// ---------- fullscreen ----------
($('btnFullscreen') as HTMLButtonElement).onclick = e => {
  e.stopPropagation();
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
};

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
  if (phase === 'playing' && game) view.updateHealthBars(game.units, game.buildings);

  if (phase === 'playing' && game && currentLevel && game.objective) {
    simAcc += dt * game.simSpeed;
    let steps = 0;
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    if (simAcc > TICK) simAcc = 0;            // drop the backlog rather than fast-forward

    const st = game.objective.evaluate(game);
    const remaining = currentLevel.hardTimer - game.elapsed;
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); ui.updateObjective(st.label, st.ratio, remaining); ui.updateWave(game.nextWave()); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }

    // resolve the level last: win, castle lost, or timeout tears the level down
    if (st.done) onLevelClear();
    else if (game.defeat) onDefeat();
    else if (remaining <= 0) onDefeat();
  } else if (phase === 'playing' && game && currentLevel) {
    // sandbox: tick the sim with no objective/timer to resolve against
    simAcc += dt * game.simSpeed;
    let steps = 0;
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    if (simAcc > TICK) simAcc = 0;
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }
  }

  view.render();
}

goMenu();
requestAnimationFrame(frame);

