import './style.css';
import { World } from './world/World';
import { View } from './render/View';
import { Game } from './game/Game';
import { UI } from './ui/UI';
import { Controls } from './input/Controls';
import { Shop } from './ui/Shop';
import { logoSVG } from './ui/logo';
import { randomSeed, simRng, uiRng } from './engine/rng';
import { Modifiers } from './game/Modifiers';
import { Objective, ascendObjective } from './game/Objectives';
import { MAX_CARDS, UPGRADES, UPGRADE_BY_ID, cardUnlocked, specsFor } from './data/upgrades';
import { MUTATOR_BY_ID, baseObjectiveIdx, contractsFor, mutatorRewardMult, mutatorSpecsFor, rollMutators, type Contract } from './data/mutators';
import { META_UPGRADES, META_BY_ID, metaSpecsFor, metaSpecialValue } from './data/metaUpgrades';
import { HEROES, HERO_BY_ID, heroAvailable, heroSpecsFor, heroUnlockId } from './data/heroes';
import { DEFAULT_SANDBOX, biomeWater, levelFor, sandboxLevel, type LevelDef, type SandboxConfig } from './data/levels';
import { campaignBiome } from './data/biomes';
import type { BiomeKey } from './data/biomes';
import { UNITS, type UnitKind } from './data/units';
import { ASCENSION_DESCS, ASCENSION_NAMES, MAX_ASCENSION, RUN_LEVELS, ascensionArmyMult, ascensionForcesCurse, ascensionPrepMult, ascensionShopSlots, ascensionTimerMult, currentLevelSeed, newRun, type MetaState, type Phase, type RunState } from './game/RunState';
import { loadSettings, saveSettings } from './game/Settings';
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
ui.onSandboxCard = id => {
  if (!sandbox || !run || !game || run.upgrades.length >= MAX_CARDS) return false;
  const def = UPGRADE_BY_ID[id];
  if (!def || def.unique && run.upgrades.includes(id)) return false;
  run.upgrades.push(id);
  game.mods.addSpecs(def.apply);
  ui.setPerks(run.upgrades, meta.activeGlobalBuff ? [meta.activeGlobalBuff] : []);
  ui.refreshModifiers();
  audio.play('coin');
  ui.toast(`${def.name} added — free sandbox card`);
  return true;
};

let meta: MetaState = Save.loadMeta();
let run: RunState | null = null;
let game: Game | null = null;
let phase: Phase = 'menu';
let currentLevel: LevelDef | null = null;
let sandbox = false;             // free-build mode: no objective, no timer, no save

// per-run tallies for the summary screen (reset when a run starts)
let clearedThisRun = 0;
let goldEarnedThisRun = 0;
let summaryNote = '';            // extra line on the summary (ascension unlocks)
let levelHardTimer = 0;          // the current level's hard timer, post-ascension

const shop = new Shop(shopContinue);

// ---------- level lifecycle ----------
function startLevel(): void {
  if (!run) return;
  const level = sandbox ? sandboxLevel(sandboxCfg) : levelFor(run.levelIndex);
  currentLevel = level;
  const seed = currentLevelSeed(run);
  // Seed the non-world streams deterministically from the level seed so a
  // replayed level looks and plays identically. World reseeds worldRng itself.
  simRng.reseed(seed ^ 0x5bd1e995);
  uiRng.reseed(seed ^ 0x27d4eb2f);

  // ascension journey: higher tiers march the run's later levels into
  // harsher biomes (sandbox picks its own on the setup screen)
  const biomeKey = sandbox ? sandboxCfg.biome : campaignBiome(run.ascension, run.levelIndex);
  // The Infernal finale: Hell is a vast, thrice-walled battlefield. Great
  // undead strongholds stand between you and the dragon, with the resources
  // (and the clock, below) to raise the army that can break them.
  const hellFinale = !sandbox && biomeKey === 'hell';
  const worldParams = { seed, ...level.world, biome: biomeKey };
  if (hellFinale) {
    worldParams.w = (level.world.w ?? 48) + 24;
    worldParams.h = (level.world.h ?? 48) + 24;
    worldParams.frontiers = 3;
    worldParams.treeStands = Math.round((level.world.treeStands ?? 8) * 1.7);
    worldParams.oreVeins = Math.round((level.world.oreVeins ?? 6) * 1.8);
    worldParams.goldPiles = (level.world.goldPiles ?? 4) + 8;
  }
  // the road to the dragon: higher tiers wall off MORE corners on the boss
  // map, each behind its own barred pass and gate garrison (see gatecamps)
  if (!sandbox && level.index === 10) {
    worldParams.frontiers = Math.max(worldParams.frontiers ?? 2, 2 + Math.min(2, run.ascension));
  }
  const world = new World(worldParams);
  view.loadWorld(world);
  const mutators = sandbox ? [] : run.mutators;
  const selectedHeroId = sandbox ? (sandboxCfg.hero === 'none' ? null : sandboxCfg.hero) : run.hero;
  const mods = new Modifiers([...heroSpecsFor(selectedHeroId), ...specsFor(run.upgrades), ...metaSpecsFor(meta.activeGlobalBuff), ...mutatorSpecsFor(mutators)]);
  game = new Game(world, view, mods);
  game.toast = (m, c) => ui.toast(m, c);
  game.onSelect = o => ui.showInspector(o);
  game.sfx = name => audio.play(name as any);
  audio.setBiome(biomeKey); // before setLevel: a biome signature owns the score
  audio.setLevel(level.index);
  audio.setDynamic(sandbox && sandboxCfg.biome === 'gooi');
  game.onGold = amt => { if (run) { run.gold = Math.max(0, run.gold + amt); if (amt > 0) goldEarnedThisRun += amt; ui.setGold(run.gold); } };
  game.onHurt = (x, z) => view.spawnHurt(x, z);
  game.onDeath = (x, z, _fac, color, role, scale) => view.spawnCorpse(x, z, color, role, scale);
  // objective variant: the chosen contract's, else the seed's default pick
  if (sandbox) {
    game.objective = null;
  } else {
    const idx = run.objectiveIdx ?? baseObjectiveIdx(run.runSeed, run.levelIndex, level.objectives.length);
    // higher ascensions reshape the goal itself (harder openings, swollen asks)
    game.objective = new Objective(ascendObjective(level.objectives[idx % level.objectives.length], run.ascension, run.levelIndex));
  }
  game.init(level.kit);
  ui.setGame(game);
  ui.setPerks(run.upgrades, meta.activeGlobalBuff ? [meta.activeGlobalBuff] : []);
  controls.setGame(game);
  // sandbox trouble is configured on the setup screen; runs use the level table
  game.prepMult = sandbox ? 1 : ascensionPrepMult(run.ascension);
  // higher ascensions garrison the enemy strongholds ever more heavily
  // and breathe more life into their bosses
  game.garrisonMult = sandbox ? 1 : 1 + 0.35 * run.ascension;
  game.bossHpMult = sandbox ? 1 : 1 + 0.5 * run.ascension;
  // hell's extra strongholds: great undead hosts in every walled corner
  // (a fresh object each time — the static LEVELS table stays untouched)
  let enemies = hellFinale && level.enemies
    ? { ...level.enemies, camps: [...(level.enemies.camps ?? []), { count: 4, guards: 14, kinds: ['skeleton', 'skelarcher', 'zombie', 'brute'] as UnitKind[] }] }
    : level.enemies ?? null;
  // the hunt's quarry grows with the tier: enough wolves AND boars on the map
  // to honour the swollen slayMulti objective (see ascendObjective)
  if (!sandbox && enemies?.wild && level.type === 'Hunt' && run.ascension > 0) {
    const packMult = 1 + 0.4 * run.ascension;
    enemies = { ...enemies, wild: enemies.wild.map(w => ({ ...w, count: Math.round(w.count * packMult) })) };
  }
  game.setEnemies(enemies);
  // mutator payloads beyond stat curses: extra wild packs on the map
  for (const id of mutators) {
    const def = MUTATOR_BY_ID[id];
    if (def?.spawnWild) for (const w of def.spawnWild) game.spawnMutatorWild(w.kind, w.count);
  }
  ui.setMutators(mutators.map(id => MUTATOR_BY_ID[id]).filter(d => !!d));
  // hostile sandboxes grant a default garrison too (their LevelDef carries
  // one); higher ascensions thin the granted army but stretch prep time.
  // The whole granted muster (level army + hero warband) parades in a grid
  // on the open ground in front of the castle gate, never on the castle.
  const heroDef = selectedHeroId ? HERO_BY_ID[selectedHeroId] : null;
  {
    const startGroups: { kind: UnitKind; count: number }[] = [];
    if (level.startArmy) {
      const armyMult = sandbox ? 1 : ascensionArmyMult(run.ascension);
      for (const a of level.startArmy) startGroups.push({ kind: a.kind, count: Math.max(1, Math.round(a.count * armyMult)) });
    }
    if (heroDef?.startArmy) startGroups.push(...heroDef.startArmy);
    if (startGroups.length) game.spawnStartArmy(startGroups);
  }
  const heroChip = $('heroChip') as HTMLElement;
  if (heroDef) {
    game.spawnHero(heroDef.id, heroDef.name);
    $('heroIcon').textContent = heroDef.icon;
    $('heroName').textContent = heroDef.name;
    heroChip.style.display = 'flex';
  } else heroChip.style.display = 'none';
  ui.setGold(run.gold);
  ui.setSandbox(sandbox);
  ($('sandboxbar') as HTMLElement).style.display = sandbox ? 'flex' : 'none';
  // the sandbox spawn bar docks left — give the build menu room to breathe
  document.body.classList.toggle('sandbox', sandbox);
  // hell's siege is meant to be long and cumbersome: much more clock to match
  levelHardTimer = Math.round(level.hardTimer * ascensionTimerMult(sandbox ? 0 : run.ascension) * (hellFinale ? 1.8 : 1));
  if (game.objective) {
    ui.setLevel(level.index, level.name);
    ui.setObjective(game.objective.brief());
    ui.updateObjective(game.objective.evaluate(game).label, 0, levelHardTimer);
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
  audio.setBiome('gooi'); // release any biome signature before the menu mood
  audio.setLevel(0);
  audio.setDynamic(true); // the menu plays the evolving score, drifting through every mood
  renderMenu();
  showScreen('menu');
}

/** Stamp the (deterministic) baseline curse + reward for the run's current level. */
function stampContract(r: RunState): void {
  r.mutators = rollMutators(r.runSeed, r.levelIndex);
  r.rewardMult = mutatorRewardMult(r.mutators);
}

// ---------- hero select (start of a run) ----------
// The flow: pick a hero card, pick a difficulty tier, press Start run.
let pickedAscension = 0;
let pickedHero = 'erfgooier';

/** How extreme each tier feels, at a glance (matches ASCENSION_NAMES). */
const ASCENSION_ICONS = ['🌱', '⚔️', '🔥', '💀', '❄️', '😈'];

function openHeroSelect(): void {
  phase = 'heroSelect';
  pickedAscension = Math.min(pickedAscension, meta.ascension);
  if (!heroAvailable(pickedHero, meta.unlocks)) pickedHero = 'erfgooier';
  renderHeroSelect();
  showScreen('heroselect');
}

/** The difficulty ladder: always shown, with locked tiers greyed out until a
 *  win at the tier below opens them. Each tier carries an extremeness mark. */
function renderAscensionRow(): void {
  const row = $('ascensionRow');
  let s = '<div class="ascrow">';
  for (let a = 0; a <= MAX_ASCENSION; a++) {
    const locked = a > meta.ascension;
    s += `<button class="asc${a === pickedAscension ? ' on' : ''}${locked ? ' locked' : ''}" data-asc="${a}"`
      + ` title="${locked ? `Locked — win at ${ASCENSION_NAMES[a - 1]} to open this tier` : ASCENSION_DESCS[a]}">`
      + `<span class="asc-ico">${ASCENSION_ICONS[a]}</span>${ASCENSION_NAMES[a]}${locked ? ' 🔒' : ''}</button>`;
  }
  const active = pickedAscension === 0 ? ASCENSION_DESCS[0] : ASCENSION_DESCS.slice(1, pickedAscension + 1).join(' · ');
  s += `</div><div class="metaline">${active}</div>`;
  row.innerHTML = s;
  row.querySelectorAll<HTMLElement>('.asc:not(.locked)').forEach(b => {
    b.onclick = () => { pickedAscension = parseInt(b.dataset.asc!, 10); audio.play('click'); renderHeroSelect(); };
  });
}

function renderHeroSelect(): void {
  $('heroMeta').innerHTML = `<b>${meta.heritage}</b> Heritage — locked heroes are bought here, kept forever`;
  const grid = $('heroGrid'); grid.innerHTML = '';
  for (const h of HEROES) {
    const owned = heroAvailable(h.id, meta.unlocks);
    const afford = meta.heritage >= h.heritageCost;
    const picked = owned && pickedHero === h.id;
    const el = document.createElement('div');
    el.className = 'scard' + (picked ? ' picked' : '') + (owned || afford ? '' : ' cant disabled');
    const lines =
      `<div class="sc-desc">✦ ${h.boon}${h.bane ? `<br>✝ ${h.bane}` : ''}</div>`;
    const price = picked ? 'Leading this run ✓' : owned ? 'Choose' : `Unlock — ${h.heritageCost} Heritage`;
    el.innerHTML = `<div class="sc-icon">${h.icon}</div><div class="sc-body"><div class="sc-name">${h.name}</div><div class="sc-desc">${h.title}</div>${lines}<div class="sc-price${picked ? ' owned' : ''}">${price}</div></div>`;
    if (owned) el.onclick = () => { pickedHero = h.id; audio.play('click'); renderHeroSelect(); };
    else if (afford) el.onclick = () => { meta.heritage -= h.heritageCost; meta.unlocks.push(heroUnlockId(h.id)); Save.saveMeta(meta); audio.play('coin'); renderHeroSelect(); };
    grid.appendChild(el);
  }
  renderAscensionRow();
}

function startRun(): void {
  if (!heroAvailable(pickedHero, meta.unlocks)) pickedHero = 'erfgooier';
  sandbox = false;
  run = newRun(randomSeed(), Math.min(pickedAscension, meta.ascension));
  run.hero = pickedHero;
  run.gold = metaSpecialValue(meta.activeGlobalBuff, 'startGold');
  stampContract(run);
  meta.stats.runs++;
  Save.saveMeta(meta);
  clearedThisRun = 0;
  goldEarnedThisRun = 0;
  startLevel();
}

// ---------- sandbox setup (menu → Sandbox) ----------
let sandboxCfg: SandboxConfig = { ...DEFAULT_SANDBOX };

/** The setup screen's option groups: key into SandboxConfig, label, choices.
 *  The water level isn't a knob of its own — it follows the chosen biome. */
function sbxGroups(): { key: keyof SandboxConfig; label: string; opts: [string, string][] }[] {
  return [
    { key: 'size', label: 'Map size', opts: [['small', 'Small · 48'], ['medium', 'Medium · 64'], ['large', 'Large · 84'], ['huge', 'Huge · 112'], ['colossal', 'Colossal · 144']] },
    { key: 'biome', label: 'Biome', opts: [['gooi', 'Het Gooi'], ['ardennes', 'The Ardennes'], ['blackforest', 'The Black Forest'], ['alps', 'The Alps'], ['winter', 'Winter'], ['polder', 'The Polder'], ['seaside', 'Zeeland Delta'], ['island', 'Texel'], ['hell', 'Hell']] },
    { key: 'mapRes', label: 'Map resources', opts: [['sparse', 'Sparse'], ['normal', 'Normal'], ['rich', 'Rich']] },
    { key: 'startRes', label: 'Starting stock', opts: [['modest', 'Modest'], ['plentiful', 'Plentiful'], ['cornucopia', 'Cornucopia']] },
    { key: 'enemies', label: 'Enemies', opts: [['none', 'None — peaceful'], ['wilds', 'Wild beasts'], ['camps', 'Bandit camps'], ['warzone', 'Warzone']] },
    { key: 'strongholds', label: 'Enemy strongholds — camps holding spots across the map', opts: [['0', 'As the enemies say'], ['2', '2 strongholds'], ['4', '4 strongholds'], ['6', '6 strongholds']] },
    { key: 'hero', label: 'Hero', opts: [['none', 'No hero'], ...HEROES.map(h => [h.id, `${h.icon} ${h.name}`] as [string, string])] },
  ];
}

function openSandboxSetup(): void {
  renderSandboxSetup();
  showScreen('sandboxselect');
}

function renderSandboxSetup(): void {
  const el = $('sbxOptions');
  let s = '';
  for (const grp of sbxGroups()) {
    s += `<div class="optgroup"><div class="optlabel">${grp.label}</div><div class="optrow">`;
    for (const [val, label] of grp.opts) {
      s += `<button class="opt${String(sandboxCfg[grp.key]) === val ? ' on' : ''}" data-key="${grp.key}" data-val="${val}">${label}</button>`;
    }
    s += '</div></div>';
  }
  el.innerHTML = s;
  el.querySelectorAll<HTMLElement>('.opt[data-key]').forEach(b => {
    b.onclick = () => {
      const key = b.dataset.key as keyof SandboxConfig;
      // numeric knobs (stronghold count) parse back from their string value
      (sandboxCfg as any)[key] = key === 'strongholds' ? Number(b.dataset.val) : b.dataset.val;
      // water isn't chosen directly — it follows whichever biome is picked
      if (key === 'biome') sandboxCfg.water = biomeWater(b.dataset.val as BiomeKey);
      audio.play('click');
      renderSandboxSetup();
    };
  });
}

/** Free-build mode shaped by the setup screen: timer-free, objective-free,
 *  never touches the save — but as hostile as you asked for. */
function startSandbox(): void {
  sandbox = true;
  run = newRun(randomSeed());
  run.hero = sandboxCfg.hero === 'none' ? null : sandboxCfg.hero;
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

/** Toast every drip-fed card whose achievement gate was just crossed. */
function announceCardUnlocks(before: { levelsCleared: number; wins: number }): void {
  for (const u of UPGRADES) {
    if (u.unlockAt && !cardUnlocked(u, before) && cardUnlocked(u, meta.stats)) {
      ui.toast(`🃏 New card unlocked — ${u.name}!`);
      audio.play('coin');
    }
  }
}

/** Award gold/Heritage for a cleared level, then advance to shop or victory. */
function onLevelClear(): void {
  if (phase !== 'playing' || !run || !currentLevel || !game) return;
  const tally = computeTally();
  const reward = tally.total;
  run.gold += reward;
  goldEarnedThisRun += reward;
  clearedThisRun++;
  const statsBefore = { ...meta.stats };
  meta.stats.levelsCleared++;
  meta.stats.bestLevel = Math.max(meta.stats.bestLevel, run.levelIndex);
  meta.heritage += 3 + run.levelIndex; // banked now, sink arrives in Phase 4
  audio.play('coin');
  ui.toast(`Level cleared! +${reward} gold`);

  const last = run.levelIndex >= RUN_LEVELS;
  summaryNote = '';
  if (last) {
    meta.stats.wins++;
    // winning at your highest tier opens the next rung of the ladder
    if (run.ascension >= meta.ascension && meta.ascension < MAX_ASCENSION) {
      meta.ascension = Math.min(MAX_ASCENSION, run.ascension + 1);
      summaryNote = `New ascension unlocked: ${ASCENSION_NAMES[meta.ascension]} — ${ASCENSION_DESCS[meta.ascension]}`;
    }
  }
  Save.saveMeta(meta);
  announceCardUnlocks(statsBefore);
  disposeLevel();
  if (last) { phase = 'summary'; renderSummary(true); showScreen('summary'); Save.clearRun(); run = null; }
  else {
    const next = run.levelIndex + 1;
    const contracts = contractsFor(run.runSeed, next, levelFor(next).objectives.length, levelFor(next).reward, ascensionForcesCurse(run.ascension));
    phase = 'shop';
    shop.open(run, contracts, metaSpecialValue(meta.activeGlobalBuff, 'freeReroll') > 0, tally.rows,
      { slots: ascensionShopSlots(run.ascension), lifetime: { levelsCleared: meta.stats.levelsCleared, wins: meta.stats.wins } });
    showScreen('shop');
    Save.saveRun(run);
  }
}

/** The run is over: the hard timer expired or the castle fell. */
function onDefeat(reason: 'timeout' | 'castle' = 'timeout'): void {
  if (phase !== 'playing' || !run) return;
  audio.play('error');
  ui.toast(reason === 'castle' ? 'The castle has fallen — the run ends here' : 'Out of time — the run ends here', 'err');
  summaryNote = '';
  disposeLevel();
  phase = 'summary'; renderSummary(false, reason); showScreen('summary');
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
  controls.resetInput();
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
type ScreenId = 'menu' | 'shop' | 'summary' | 'heritage' | 'heroselect' | 'sandboxselect' | null;
function showScreen(id: ScreenId): void {
  $('pausemenu').style.display = 'none';
  for (const s of ['menu', 'shop', 'summary', 'heritage', 'heroselect', 'sandboxselect']) $(s).style.display = id === s ? 'flex' : 'none';
  $('hud').style.display = phase === 'playing' ? 'block' : 'none';
  // a screen swallows keyups/pointerups — never leave the camera mid-pan
  controls.resetInput();
}

function renderMenu(): void {
  const has = Save.hasRun();
  const cont = $('btnContinue') as HTMLButtonElement;
  cont.style.display = has ? 'block' : 'none';
  $('metaLine').innerHTML =
    `<b>${meta.heritage}</b> Heritage · runs: ${meta.stats.runs} · wins: ${meta.stats.wins} · levels cleared: ${meta.stats.levelsCleared} · best: level ${meta.stats.bestLevel || 0}` +
    (meta.ascension > 0 ? ` · ascension unlocked: ${ASCENSION_NAMES[meta.ascension]}` : '');
}

function renderSummary(victory: boolean, reason: 'timeout' | 'castle' = 'timeout'): void {
  $('sumTitle').textContent = victory ? 'Run complete — victory!' : 'Run over';
  $('sumSub').textContent = victory
    ? `You cleared all ${RUN_LEVELS} levels of Het Gooi.`
    : reason === 'castle'
      ? 'The enemy razed your castle. Your gold and upgrades are gone — but the Heritage remains.'
      : 'The clock beat you. Your gold and upgrades are gone — but the Heritage remains.';
  $('sumBody').innerHTML =
    `Cleared <b>${clearedThisRun}</b> level(s) this run · gold earned <b>${goldEarnedThisRun}</b> (lost) · ` +
    `<b>${meta.heritage}</b> Heritage banked · lifetime levels cleared: ${meta.stats.levelsCleared}` +
    (summaryNote ? `<br><b>⬆ ${summaryNote}</b>` : '');
}

// ---------- heritage shop (main menu) ----------
function openHeritage(): void { renderHeritage(); showScreen('heritage'); }

function renderHeritage(): void {
  $('heritageMeta').innerHTML = `<b>${meta.heritage}</b> Heritage to spend · own any number, activate one global blessing`;
  const grid = $('heritageGrid'); grid.innerHTML = '';
  for (const def of META_UPGRADES) {
    const owned = meta.unlocks.includes(def.id);
    const active = meta.activeGlobalBuff === def.id;
    const afford = meta.heritage >= def.cost;
    const cls = active ? 'picked' : owned ? '' : afford ? '' : 'cant disabled';
    const price = active ? 'active ✓' : owned ? 'Activate' : `Tier ${def.tier} · ${def.cost} Heritage`;
    const el = document.createElement('div');
    el.className = 'scard' + (cls ? ' ' + cls : '');
    el.innerHTML = `<div class="sc-icon">${def.icon}</div><div class="sc-body"><div class="sc-name">${def.name}</div><div class="sc-desc">${def.desc}</div><div class="sc-price ${cls}">${price}</div></div>`;
    if (owned && !active) el.onclick = () => activateMeta(def.id);
    else if (!owned && afford) el.onclick = () => buyMeta(def.id);
    grid.appendChild(el);
  }
}

function buyMeta(id: string): void {
  const def = META_BY_ID[id];
  if (!def || meta.unlocks.includes(id) || meta.heritage < def.cost) return;
  meta.heritage -= def.cost;
  meta.unlocks.push(id);
  meta.activeGlobalBuff = id;
  Save.saveMeta(meta);
  audio.play('coin');
  renderHeritage();
}

function activateMeta(id: string): void {
  if (!META_BY_ID[id] || !meta.unlocks.includes(id)) return;
  meta.activeGlobalBuff = id;
  Save.saveMeta(meta);
  audio.play('click');
  renderHeritage();
}

// ---------- wire screen + debug buttons ----------
$('menuLogo').innerHTML = logoSVG(40);
$('introLogo').innerHTML = logoSVG(40);
($('btnNewRun') as HTMLButtonElement).onclick = openHeroSelect;
($('btnHeroBack') as HTMLButtonElement).onclick = goMenu;
($('btnStartRun') as HTMLButtonElement).onclick = startRun;
// the hero chip selects the mounted hero and swings the camera to them
$('heroChip').onclick = () => {
  if (!game || !game.heroUnit || game.heroUnit.dead) return;
  game.select(game.heroUnit);
  controls.selectUnits([game.heroUnit]);   // so right-click orders work at once
  view.centerOn(game.heroUnit.mesh.position.x, game.heroUnit.mesh.position.z);
};
($('btnContinue') as HTMLButtonElement).onclick = continueRun;
($('btnSandbox') as HTMLButtonElement).onclick = openSandboxSetup;
($('btnSbxBack') as HTMLButtonElement).onclick = goMenu;
($('btnSbxStart') as HTMLButtonElement).onclick = startSandbox;

// ---------- sandbox spawn toolbar ----------
/** One spawn button: what to spawn per click (and per hold-tick), and how it looks. */
type SandboxSpawnDef = { kind: UnitKind; count: number; icon: string; label: string };

const SANDBOX_FRIENDLY: SandboxSpawnDef[] = [
  { kind: 'soldier', count: 12, icon: '⚔️', label: 'Soldiers' },
  { kind: 'pikeman', count: 10, icon: '🔱', label: 'Pikemen' },
  { kind: 'archer', count: 8, icon: '🏹', label: 'Archers' },
  { kind: 'knight', count: 6, icon: '🛡️', label: 'Knights' },
  { kind: 'lancer', count: 8, icon: '🐎', label: 'Lancers' },
  { kind: 'horseknight', count: 6, icon: '🏇', label: 'Horse Knights' },
  { kind: 'horsearcher', count: 8, icon: '🎯', label: 'Horse Archers' },
  { kind: 'ballista', count: 3, icon: '⚙️', label: 'Ballistas' },
  { kind: 'onager', count: 3, icon: '💥', label: 'Onagers' },
  { kind: 'trebuchet', count: 2, icon: '🪨', label: 'Trebuchets' },
];

const SANDBOX_ENEMY: SandboxSpawnDef[] = [
  { kind: 'bandit', count: 12, icon: '🗡️', label: 'Bandits' },
  { kind: 'lancer', count: 8, icon: '🐎', label: 'Enemy Lancers' },
  { kind: 'horseknight', count: 6, icon: '🏇', label: 'Enemy Horse Knights' },
  { kind: 'horsearcher', count: 8, icon: '🎯', label: 'Enemy Horse Archers' },
  { kind: 'boar', count: 6, icon: '🐗', label: 'Boars' },
  { kind: 'wolf', count: 8, icon: '🐺', label: 'Wolves' },
  { kind: 'orc', count: 8, icon: '🪓', label: 'Orcs' },
  { kind: 'troll', count: 3, icon: '🪨', label: 'Trolls' },
  { kind: 'skeleton', count: 10, icon: '💀', label: 'Skeletons' },
  { kind: 'skelarcher', count: 8, icon: '🏹', label: 'Skeletal Archers' },
  { kind: 'zombie', count: 10, icon: '🧟', label: 'Zombies' },
  { kind: 'brute', count: 1, icon: '🧟‍♂️', label: 'Bloated Zombie' },
  { kind: 'demon', count: 1, icon: '🔥', label: 'Demon' },
  { kind: 'dragon', count: 1, icon: '🐉', label: 'Dragon' },
];

function sandboxSpawn(kind: UnitKind, count: number, faction: 'player' | 'enemy'): void {
  if (!game) return;
  const c = view.camTarget;
  const squad = game.spawnSquad(kind, count, c.x, c.z, faction);
  const label = kind === 'pikeman' && squad.length > 1 ? 'Pikemen' : UNITS[kind].name + (squad.length > 1 ? 's' : '');
  if (squad.length) ui.toast(`Spawned ${squad.length} ${label}`);
}
let sandboxSpawnTimer: number | null = null;
function stopSandboxSpawn(): void {
  if (sandboxSpawnTimer !== null) {
    clearInterval(sandboxSpawnTimer);
    sandboxSpawnTimer = null;
  }
}
addEventListener('pointerup', stopSandboxSpawn);
addEventListener('pointercancel', stopSandboxSpawn);
addEventListener('blur', stopSandboxSpawn);
function makeSandboxSpawnBtn(def: SandboxSpawnDef, side: 'player' | 'enemy'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = `${def.icon} ${def.label}`;
  btn.title = `Spawn ${side} ${def.label.toLowerCase()} at the camera`;
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    stopSandboxSpawn();
    const faction = side === 'player' ? 'player' : 'enemy';
    sandboxSpawn(def.kind, def.count, faction);
    sandboxSpawnTimer = window.setInterval(() => sandboxSpawn(def.kind, def.count, faction), 180);
  });
  return btn;
}
for (const def of SANDBOX_FRIENDLY) $('sbFriendly').appendChild(makeSandboxSpawnBtn(def, 'player'));
for (const def of SANDBOX_ENEMY) $('sbEnemy').appendChild(makeSandboxSpawnBtn(def, 'enemy'));
($('sbToggle') as HTMLButtonElement).onclick = () => {
  const bar = $('sandboxbar');
  const collapsed = bar.classList.toggle('collapsed');
  $('sbToggle').textContent = collapsed ? 'Sandbox ▸' : 'Sandbox ▾';
};
// ---------- sandbox wave composer: a modal to mix a raid & put it on a timer ----------
{
  const modal = $('wavemodal');
  const kindsEl = $('waveKinds');
  const totalEl = $('waveTotal');
  const delayInp = $('waveDelay') as HTMLInputElement;
  // per-kind counts: the wave is exactly what you type, kind by kind
  const counts = new Map<UnitKind, number>([['bandit', 12]]);
  const refreshTotal = (): void => {
    let total = 0;
    for (const n of counts.values()) total += n;
    totalEl.textContent = String(total);
  };
  const renderKinds = (): void => {
    kindsEl.innerHTML = '';
    for (const def of SANDBOX_ENEMY) {
      const row = document.createElement('div');
      row.className = 'waverow-kind' + (counts.get(def.kind) ? ' on' : '');
      const label = document.createElement('span');
      label.className = 'wavekind-label';
      label.textContent = `${def.icon} ${def.label}`;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.max = '1000'; inp.step = '1';
      inp.value = String(counts.get(def.kind) ?? 0);
      inp.title = `How many ${def.label.toLowerCase()} arrive in the wave`;
      inp.addEventListener('keydown', e => e.stopPropagation());
      inp.addEventListener('input', () => {
        const n = Math.max(0, Math.min(1000, Math.round(Number(inp.value) || 0)));
        if (n > 0) counts.set(def.kind, n); else counts.delete(def.kind);
        row.classList.toggle('on', n > 0);
        refreshTotal();
      });
      row.appendChild(label);
      row.appendChild(inp);
      kindsEl.appendChild(row);
    }
    refreshTotal();
  };
  // typing in the modal must never fall through to game hotkeys
  delayInp.addEventListener('keydown', e => e.stopPropagation());
  const openModal = (): void => { renderKinds(); modal.style.display = 'flex'; };
  const closeModal = (): void => { modal.style.display = 'none'; };
  const summon = (): void => {
    if (!game) return;
    let total = 0;
    for (const n of counts.values()) total += n;
    if (total < 1) { ui.toast('Set a count for at least one kind', 'err'); audio.play('error'); return; }
    const delay = Math.max(0, Math.min(3600, Math.round(Number(delayInp.value) || 0)));
    delayInp.value = String(delay);
    for (const [kind, n] of counts) if (n > 0) game.scheduleWave(kind, n, delay);
    ui.toast(delay > 0
      ? `A wave of ${total} raiders will march in ${delay}s`
      : `A wave of ${total} raiders marches on your castle!`, delay > 0 ? undefined : 'err');
    closeModal();
  };
  ($('sbWaveOpen') as HTMLButtonElement).onclick = openModal;
  ($('waveCancel') as HTMLButtonElement).onclick = closeModal;
  ($('waveGo') as HTMLButtonElement).onclick = summon;
  delayInp.addEventListener('keydown', e => { if (e.key === 'Enter') summon(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display === 'flex') closeModal(); });
}
($('btnClearSave') as HTMLButtonElement).onclick = clearSaveData;

// ---------- settings screen ----------
const settings = loadSettings();
audio.setMusicVolume(settings.musicVol);
audio.setSfxVolume(settings.sfxVol);
view.setQualityMode(settings.quality);
controls.settings = settings;

let settingsReturn: 'menu' | 'pause' = 'menu';
function openSettings(from: 'menu' | 'pause'): void {
  settingsReturn = from;
  if (from === 'menu') $('menu').style.display = 'none';
  else $('pausemenu').style.display = 'none';
  renderSettings();
  $('settings').style.display = 'flex';
}
function closeSettings(): void {
  $('settings').style.display = 'none';
  if (settingsReturn === 'menu') $('menu').style.display = 'flex';
  else $('pausemenu').style.display = 'flex';
}
($('btnSettings') as HTMLButtonElement).onclick = () => openSettings('menu');
($('btnPauseSettings') as HTMLButtonElement).onclick = () => openSettings('pause');
($('btnSettingsBack') as HTMLButtonElement).onclick = closeSettings;

/** Push the stored values into the controls (called every time it opens). */
function renderSettings(): void {
  ($('setMusic') as HTMLInputElement).value = String(Math.round(settings.musicVol * 100));
  ($('setSfx') as HTMLInputElement).value = String(Math.round(settings.sfxVol * 100));
  ($('setPan') as HTMLInputElement).value = String(Math.round(settings.panSpeed * 100));
  ($('setInvZoom') as HTMLInputElement).checked = settings.invertZoom;
  ($('setEdgePan') as HTMLInputElement).checked = settings.edgePan;
  ($('setAutoPause') as HTMLInputElement).checked = settings.autoPauseOnBlur;
  ($('setQuality') as HTMLSelectElement).value = settings.quality;
  $('setMusicVal').textContent = `${Math.round(settings.musicVol * 100)}%`;
  $('setSfxVal').textContent = `${Math.round(settings.sfxVol * 100)}%`;
  $('setPanVal').textContent = `${settings.panSpeed.toFixed(1)}×`;
}
/** Every control applies live and persists immediately. */
($('setMusic') as HTMLInputElement).oninput = e => {
  settings.musicVol = Number((e.target as HTMLInputElement).value) / 100;
  audio.setMusicVolume(settings.musicVol); saveSettings(settings);
  $('setMusicVal').textContent = `${Math.round(settings.musicVol * 100)}%`;
};
($('setSfx') as HTMLInputElement).oninput = e => {
  settings.sfxVol = Number((e.target as HTMLInputElement).value) / 100;
  audio.setSfxVolume(settings.sfxVol); saveSettings(settings);
  $('setSfxVal').textContent = `${Math.round(settings.sfxVol * 100)}%`;
  audio.play('click');
};
($('setPan') as HTMLInputElement).oninput = e => {
  settings.panSpeed = Number((e.target as HTMLInputElement).value) / 100;
  saveSettings(settings);
  $('setPanVal').textContent = `${settings.panSpeed.toFixed(1)}×`;
};
($('setInvZoom') as HTMLInputElement).onchange = e => { settings.invertZoom = (e.target as HTMLInputElement).checked; saveSettings(settings); };
($('setEdgePan') as HTMLInputElement).onchange = e => { settings.edgePan = (e.target as HTMLInputElement).checked; saveSettings(settings); };
($('setAutoPause') as HTMLInputElement).onchange = e => { settings.autoPauseOnBlur = (e.target as HTMLInputElement).checked; saveSettings(settings); };
($('setQuality') as HTMLSelectElement).onchange = e => {
  settings.quality = (e.target as HTMLSelectElement).value as typeof settings.quality;
  view.setQualityMode(settings.quality); saveSettings(settings);
};
addEventListener('blur', () => { if (settings.autoPauseOnBlur) openPauseMenu(); });

// save export / import: a downloadable JSON bundle of run + Heritage progress
($('btnExportSave') as HTMLButtonElement).onclick = () => {
  const blob = new Blob([Save.exportAll()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `erfgooiers-save-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  ui.toast('Save exported — keep the file somewhere safe');
};
($('btnImportSave') as HTMLButtonElement).onclick = () => ($('importFile') as HTMLInputElement).click();
($('importFile') as HTMLInputElement).onchange = async e => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // allow re-picking the same file later
  if (!file) return;
  const res = Save.importAll(await file.text());
  if (!res.ok) { ui.toast(res.error ?? 'That save could not be read', 'err'); return; }
  // reload from storage so every screen reflects the imported progress
  if (phase === 'playing') disposeLevel();
  meta = Save.loadMeta();
  run = null;
  goMenu();
  ui.toast('Save imported');
};
($('btnSettingsClear') as HTMLButtonElement).onclick = () => {
  $('settings').style.display = 'none';
  clearSaveData();
};

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
// Start the score immediately where the browser allows it (returning visitors
// with prior engagement); everyone else gets it on their very first gesture.
audio.unlock();
for (const ev of ['pointerdown', 'keydown'] as const) {
  addEventListener(ev, () => audio.unlock(), { once: true });
}
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
    const remaining = levelHardTimer + game.bonusTime - game.elapsed;
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); ui.updateObjective(st.label, st.ratio, remaining); ui.updateWave(game.nextWave()); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }

    // resolve the level last: win, castle lost, or timeout tears the level down
    if (st.done) onLevelClear();
    else if (game.defeat) onDefeat('castle');
    else if (remaining <= 0) onDefeat('timeout');
  } else if (phase === 'playing' && game && currentLevel) {
    // sandbox: tick the sim with no objective/timer to resolve against
    simAcc += dt * game.simSpeed;
    let steps = 0;
    const t0 = performance.now();
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    simMs += (performance.now() - t0 - simMs) * 0.05;
    if (simAcc > TICK) simAcc = 0;
    // the wave banner counts down scheduled console waves too
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); ui.updateWave(game.nextWave() ?? game.nextScheduledWave()); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }
    // a hostile sandbox can still lose its castle — that ends the session
    if (game.defeat) onDefeat('castle');
  }

  view.render();
  if (perfOn) { perfT += dt; if (perfT > 0.25) { perfT = 0; renderPerfHud(); } }
}

goMenu();
requestAnimationFrame(frame);

