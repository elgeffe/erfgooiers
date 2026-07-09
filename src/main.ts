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
import { MUTATOR_BY_ID, baseObjectiveIdx, contractsFor, mutatorRewardMult, mutatorSpecsFor, rollMutators, type Contract } from './data/mutators';
import { META_UPGRADES, META_BY_ID, metaSpecsFor, hasMetaSpecial } from './data/metaUpgrades';
import { levelFor, sandboxLevel, type LevelDef } from './data/levels';
import type { UnitKind } from './data/units';
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
  const mutators = sandbox ? [] : run.mutators;
  const mods = new Modifiers([...specsFor(run.upgrades), ...metaSpecsFor(meta.unlocks), ...mutatorSpecsFor(mutators)]);
  game = new Game(world, view, mods);
  game.toast = (m, c) => ui.toast(m, c);
  game.onSelect = o => ui.showInspector(o);
  game.sfx = name => audio.play(name as any);
  audio.setLevel(level.index);
  audio.setDynamic(sandbox);
  game.onGold = amt => { if (run) { run.gold = Math.max(0, run.gold + amt); if (amt > 0) goldEarnedThisRun += amt; ui.setGold(run.gold); } };
  game.onHurt = (x, z) => view.spawnHurt(x, z);
  game.onDeath = (x, z, _fac, color, role, scale) => view.spawnCorpse(x, z, color, role, scale);
  // objective variant: the chosen contract's, else the seed's default pick
  if (sandbox) {
    game.objective = null;
  } else {
    const idx = run.objectiveIdx ?? baseObjectiveIdx(run.runSeed, run.levelIndex, level.objectives.length);
    game.objective = new Objective(level.objectives[idx % level.objectives.length]);
  }
  game.init(level.kit);
  ui.setGame(game);
  ui.setPerks(run.upgrades, meta.unlocks);
  controls.setGame(game);
  game.setEnemies(sandbox ? null : (level.enemies ?? null));
  // mutator payloads beyond stat curses: extra wild packs on the map
  for (const id of mutators) {
    const def = MUTATOR_BY_ID[id];
    if (def?.spawnWild) for (const w of def.spawnWild) game.spawnMutatorWild(w.kind, w.count);
  }
  ui.setMutators(mutators.map(id => MUTATOR_BY_ID[id]).filter(d => !!d));
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
  // dev-only handle for poking the live sim from the console
  if ((import.meta as any).env?.DEV) (window as any).game = game;
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

/** Stamp the (deterministic) baseline curse + reward for the run's current level. */
function stampContract(r: RunState): void {
  r.mutators = rollMutators(r.runSeed, r.levelIndex);
  r.rewardMult = mutatorRewardMult(r.mutators);
}

function newRunFromMenu(): void {
  sandbox = false;
  run = newRun(1 + Math.floor(Math.random() * 2147483645));
  if (hasMetaSpecial(meta.unlocks, 'startGold')) run.gold = 25;
  stampContract(run);
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

/** One row of the end-of-level reckoning. */
export interface TallyRow { label: string; gold: number; }

/** The legible score: every gold source on clear, itemized for the shop screen. */
function computeTally(): { rows: TallyRow[]; total: number } {
  const level = currentLevel!, g = game!, r = run!;
  const rows: TallyRow[] = [];
  rows.push({
    label: r.rewardMult > 1 ? `Contract fulfilled — cursed ×${Math.round(r.rewardMult * 100) / 100}` : 'Contract fulfilled',
    gold: Math.round(level.reward * r.rewardMult),
  });
  if (g.elapsed <= level.timeTarget) {
    rows.push({ label: `Speed bonus — done in ${Math.round(g.elapsed)}s`, gold: Math.round(level.reward * 0.5) });
  }
  const surplus = Math.floor(g.stockTotal() / 8);
  if (surplus > 0) rows.push({ label: 'Surplus goods in the storehouse', gold: surplus });
  const fed = g.wellFedWorkers();
  const fedGold = Math.floor(fed / 2);
  if (fedGold > 0) rows.push({ label: `${fed} well-fed workers`, gold: fedGold });
  let total = rows.reduce((s, row) => s + row.gold, 0);
  const mult = g.mods.goldMult();
  if (mult !== 1) {
    const boosted = Math.round(total * mult);
    rows.push({ label: `Gold gain ×${Math.round(mult * 100) / 100}`, gold: boosted - total });
    total = boosted;
  }
  return { rows, total: Math.max(1, total) };
}

/** Award gold/Heritage for a cleared level, then advance to shop or victory. */
function onLevelClear(): void {
  if (phase !== 'playing' || !run || !currentLevel || !game) return;
  const tally = computeTally();
  const reward = tally.total;
  run.gold += reward;
  goldEarnedThisRun += reward;
  clearedThisRun++;
  meta.stats.levelsCleared++;
  meta.stats.bestLevel = Math.max(meta.stats.bestLevel, run.levelIndex);
  meta.heritage += 3 + run.levelIndex; // banked now, sink arrives in Phase 4
  Save.saveMeta(meta);
  audio.play('coin');
  ui.toast(`Level cleared! +${reward} gold`);

  const last = run.levelIndex >= RUN_LEVELS;
  disposeLevel();
  if (last) { phase = 'summary'; renderSummary(true); showScreen('summary'); Save.clearRun(); run = null; }
  else {
    const next = run.levelIndex + 1;
    const contracts = contractsFor(run.runSeed, next, levelFor(next).objectives.length, levelFor(next).reward);
    phase = 'shop';
    shop.open(run, contracts, hasMetaSpecial(meta.unlocks, 'freeReroll'), tally.rows);
    showScreen('shop');
    Save.saveRun(run);
  }
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

function shopContinue(contract: Contract): void {
  if (!run) { goMenu(); return; }
  run.levelIndex++;
  run.mutators = contract.mutators;
  run.rewardMult = contract.rewardMult;
  run.objectiveIdx = contract.objectiveIdx;
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
function sandboxSpawn(kind: UnitKind, count: number): void {
  if (!game) return;
  const c = view.camTarget;
  const squad = game.spawnSquad(kind, count, c.x, c.z);
  if (squad.length) ui.toast(`Spawned ${squad.length} ${kind}${squad.length > 1 ? 's' : ''}`);
}
let sandboxSpawnTimer: number | null = null;
function bindSandboxSpawn(id: string, kind: UnitKind, count: number): void {
  const btn = $(id) as HTMLButtonElement;
  const stop = (): void => {
    if (sandboxSpawnTimer !== null) {
      clearInterval(sandboxSpawnTimer);
      sandboxSpawnTimer = null;
    }
  };
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    stop();
    sandboxSpawn(kind, count);
    sandboxSpawnTimer = window.setInterval(() => sandboxSpawn(kind, count), 180);
  });
  addEventListener('pointerup', stop);
  addEventListener('pointercancel', stop);
  addEventListener('blur', stop);
}
($('sbToggle') as HTMLButtonElement).onclick = () => {
  const bar = $('sandboxbar');
  const collapsed = bar.classList.toggle('collapsed');
  $('sbToggle').textContent = collapsed ? 'Sandbox ▸' : 'Sandbox ▾';
};
bindSandboxSpawn('sbSoldier', 'soldier', 12);
bindSandboxSpawn('sbArcher', 'archer', 8);
bindSandboxSpawn('sbKnight', 'knight', 6);
bindSandboxSpawn('sbBandit', 'bandit', 12);
bindSandboxSpawn('sbBoar', 'boar', 6);
bindSandboxSpawn('sbWolf', 'wolf', 8);
bindSandboxSpawn('sbOrc', 'orc', 8);
bindSandboxSpawn('sbTroll', 'troll', 3);
bindSandboxSpawn('sbDemon', 'demon', 1);
bindSandboxSpawn('sbDragon', 'dragon', 1);
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

// ---------- runtime error banner ----------
// A runtime exception must never silently freeze the game: surface it and
// offer a reload — the run save resumes at the current level's start.
let lastErrAt = 0;
function showError(msg: string): void {
  const now = Date.now();
  if (now - lastErrAt < 4000) return;   // a render-loop error repeats every frame
  lastErrAt = now;
  $('errText').textContent = msg;
  $('errbar').style.display = 'flex';
}
addEventListener('error', e => showError(e.message || 'Unknown error'));
addEventListener('unhandledrejection', e => showError(String((e as PromiseRejectionEvent).reason ?? 'Unhandled rejection')));
($('errReload') as HTMLButtonElement).onclick = () => location.reload();
($('errDismiss') as HTMLButtonElement).onclick = () => { $('errbar').style.display = 'none'; };

// ---------- perf HUD (F3) — draw calls, frame & sim cost, live counts ----------
const perfEl = $('perfhud');
let perfOn = false;
let perfT = 0;
let frameMs = 0;   // exponential moving average of full-frame time
let simMs = 0;     // EMA of the sim-update portion of a frame
addEventListener('keydown', e => {
  if (e.key !== 'F3') return;
  e.preventDefault();
  perfOn = !perfOn;
  perfEl.style.display = perfOn ? 'block' : 'none';
});
function renderPerfHud(): void {
  const info = view.renderer.info;
  let meshes = 0;
  view.scene.traverse(o => { if ((o as any).isMesh) meshes++; });
  perfEl.textContent =
    `frame  ${frameMs.toFixed(1)} ms  (${frameMs > 0 ? Math.round(1000 / frameMs) : 0} fps)\n` +
    `sim    ${simMs.toFixed(2)} ms/frame\n` +
    `calls  ${info.render.calls}   tris ${info.render.triangles.toLocaleString()}\n` +
    `meshes ${meshes}   units ${game ? game.units.length : 0}\n` +
    `geoms  ${info.memory.geometries}   textures ${info.memory.textures}\n` +
    `px     ${view.renderer.getPixelRatio().toFixed(2)}`;
}

// ---------- main loop (fixed-timestep sim, real-time render) ----------
const TICK = 1 / 20;          // 20 sim steps/second — determinism & replay ready
const MAX_STEPS = 6;          // clamp catch-up so a slow frame can't spiral
let simAcc = 0;
let last = performance.now();
let uiT = 0, mmT = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  frameMs += (dt * 1000 - frameMs) * 0.05;

  controls.update(dt);                       // keyboard camera panning
  if (game) view.animate(dt, game.buildings); // sails & clouds (real-time, ignores pause)
  if (phase === 'playing' && game) view.updateHealthBars(game.units, game.buildings);

  if (phase === 'playing' && game && currentLevel && game.objective) {
    simAcc += dt * game.simSpeed;
    let steps = 0;
    const t0 = performance.now();
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    simMs += (performance.now() - t0 - simMs) * 0.05;
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
    const t0 = performance.now();
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    simMs += (performance.now() - t0 - simMs) * 0.05;
    if (simAcc > TICK) simAcc = 0;
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }
  }

  view.render();
  if (perfOn) { perfT += dt; if (perfT > 0.25) { perfT = 0; renderPerfHud(); } }
}

goMenu();
requestAnimationFrame(frame);

