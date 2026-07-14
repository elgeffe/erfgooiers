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
import { DEFAULT_SANDBOX, MAX_SANDBOX_STRONGHOLDS, biomeWater, levelFor, sandboxLevel, type LevelDef, type SandboxConfig } from './data/levels';
import { lockedBuildingsAt, objectiveBuildings, unlockedResourcesAt } from './data/buildings';
import { VICTORY_IMAGE, VICTORY_STORY, storyFor } from './data/story';
import type { GameSettings } from './game/Settings';
import { campaignBiome } from './data/biomes';
import type { BiomeKey } from './data/biomes';
import { ASCENSION_DESCS, ASCENSION_NAMES, MAX_ASCENSION, RUN_LEVELS, ascensionForcesCurse, ascensionShopSlots, currentLevelSeed, newRun, type MetaState, type Phase, type RunState } from './game/RunState';
import { planLevel, planStartArmy } from './game/levelPlanning';
import { installSettingsController } from './ui/settingsController';
import { installSandboxTools } from './ui/sandboxTools';
import { CoOpController } from './ui/CoOpController';
import * as Save from './game/SaveGame';
import { audio } from './audio/Audio';
import { PeerCoOpClient, type ConnectionSnapshot } from './net/PeerCoOpClient';
import type { AcceptedCommand, ExpeditionDifficulty, GameCommand } from './net/protocol';
import { applyGameCommand } from './game/commands';
import { EXPEDITION_DIFFICULTY, EXPEDITION_LEVEL_COUNT, expeditionLevelFor } from './data/coOpLevels';

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
const coop = new PeerCoOpClient();

/** Rebuild the sandbox's live modifiers from base perks + the cards held now.
 *  Called after any add/remove so a removed card's effect actually lifts. */
function rebuildSandboxMods(): void {
  if (!game || !run) return;
  const heroId = sandboxCfg.hero === 'none' ? null : sandboxCfg.hero;
  game.mods.setSpecs([...heroSpecsFor(heroId), ...specsFor(run.upgrades), ...metaSpecsFor(meta.activeGlobalBuff)]);
  ui.setPerks(run.upgrades, meta.activeGlobalBuff ? [meta.activeGlobalBuff] : []);
  ui.refreshModifiers();
}

ui.onSandboxCard = id => {
  if (!sandbox || !run || !game || run.upgrades.length >= MAX_CARDS) return false;
  const def = UPGRADE_BY_ID[id];
  if (!def || def.unique && run.upgrades.includes(id)) return false;
  run.upgrades.push(id);
  rebuildSandboxMods();
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

// ---------- co-op expedition state ----------
let coopRun: { level: number; difficulty: ExpeditionDifficulty } | null = null;
let expeditionStartSent = false; // host guard: fire one start per both-ready lobby
let coopCmdSeq = 0;
let coopConnected = false;       // frame loop freezes the co-op sim while offline
let coopAdvanceTimer: number | null = null;

// per-run tallies for the summary screen (reset when a run starts)
let clearedThisRun = 0;
let goldEarnedThisRun = 0;
let levelGoldStart = 0;          // restored when the pause menu restarts a level
let levelGoldEarnedStart = 0;    // prevents restart-farming pickups in the run tally
let summaryNote = '';            // extra line on the summary (ascension unlocks)
let levelHardTimer = 0;          // the current level's hard timer, post-ascension

const shop = new Shop(shopContinue);

// ---------- level lifecycle ----------
function startLevel(): void {
  if (!run) return;
  levelGoldStart = run.gold;
  levelGoldEarnedStart = goldEarnedThisRun;
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
  const levelPlan = planLevel(level, seed, biomeKey, run.ascension, sandbox);
  const world = new World(levelPlan.world);
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
  // First-ascension onboarding: unlock the build menu a few buildings at a time
  // and surface only the resources those buildings involve. Every harder tier
  // (and the sandbox) opens the whole menu at once.
  const onboarding = !sandbox && run.ascension === 0 && run.tutorials;
  if (onboarding) {
    const locked = lockedBuildingsAt(run.levelIndex);
    game.lockedBuildings = new Set(locked);
    ui.applyProgression(locked, unlockedResourcesAt(run.levelIndex));
    // the objective's build checklist drives the ticking list and card highlight
    ui.setChecklist(game.objective ? objectiveBuildings(game.objective.def) : []);
  } else {
    ui.applyProgression(null, null);
    ui.setChecklist([]);
  }
  ui.setPerks(run.upgrades, meta.activeGlobalBuff ? [meta.activeGlobalBuff] : []);
  controls.setGame(game);
  // sandbox trouble is configured on the setup screen; runs use the level table
  game.prepMult = levelPlan.prepMult;
  // higher ascensions garrison the enemy strongholds ever more heavily
  // and breathe more life into their bosses
  game.garrisonMult = levelPlan.garrisonMult;
  game.bossHpMult = levelPlan.bossHpMult;
  game.setEnemies(levelPlan.enemies);
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
  const startGroups = planStartArmy(level.startArmy, heroDef?.startArmy, run.ascension, sandbox);
  if (startGroups.length) game.spawnStartArmy(startGroups);
  const heroChip = $('heroChip') as HTMLElement;
  if (heroDef) {
    game.spawnHero(heroDef.id, heroDef.name);
    $('heroIcon').textContent = heroDef.icon;
    $('heroName').textContent = heroDef.name;
    heroChip.style.display = 'flex';
  } else heroChip.style.display = 'none';
  ui.setGold(run.gold);
  ui.setSandbox(sandbox);
  ui.setCoOp(false);
  ($('sandboxbar') as HTMLElement).style.display = sandbox ? 'flex' : 'none';
  // the sandbox spawn bar docks left — give the build menu room to breathe
  document.body.classList.toggle('sandbox', sandbox);
  // hell's siege is meant to be long and cumbersome: much more clock to match
  levelHardTimer = levelPlan.hardTimer;
  if (game.objective) {
    ui.setLevel(level.index, level.name);
    ui.setObjective(game.objective.brief());
    ui.updateObjective(game.objective.nextStepLabel(game), 0, levelHardTimer);
  }
  view.centerOn(world.wx(game.store.x) + 0.5, world.wz(game.store.y) + 2);
  view.drawMinimap(game.units);

  simAcc = 0;
  phase = 'playing';
  // dev-only handle for poking the live sim from the console
  if ((import.meta as any).env?.DEV) (window as any).game = game;
  showScreen(null);
  if (!sandbox) Save.saveRun(run); // persist at the level's start so a reload resumes here
  // the story briefing opens the level (Normal tier only) and the objective
  // card becomes a doorway back to it
  const story = onboarding ? storyFor(run.levelIndex) : undefined;
  // the objective card always opens a modal: the story briefing on a tutorial
  // level, the full objective checklist otherwise
  $('objective').classList.toggle('clickable', !sandbox);
  $('objective').title = sandbox ? '' : story ? 'Click to revisit the story & how-to' : 'Click for the full objective checklist';
  if (story) showStoryModal(run.levelIndex);
}

function disposeLevel(): void {
  view.clearWorld();
  game = null;
  currentLevel = null;
}

// ---------- first-ascension story briefings ----------
// A briefing modal opens each Normal-tier level with one paragraph of the
// evolving dragon-of-Het-Gooi story and concrete how-to-win hints (thinning as
// the run goes on). It pauses the sim while open; the objective card reopens it.
let storyPrevSpeed = 1;
let storyOnClose: () => void = () => {};

function hideStory(): void {
  $('story').style.display = 'none';
  const cb = storyOnClose; storyOnClose = () => {}; cb();
}

/** The full objective breakdown as checklist rows, for the modals (the panel
 *  itself only shows the next step). Reuses the build-checklist row styling. */
function objectiveBreakdownHTML(): string {
  if (!game || !game.objective) return '';
  const rows = game.objective.steps(game)
    .map(s => `<div class="ckrow ${s.done ? 'done' : 'todo'}"><span class="ckmark">${s.done ? '✓' : '○'}</span><span class="cknm">${s.label}</span></div>`)
    .join('');
  // the onboarding "Build these" list now lives here in the modal, not the HUD panel
  return `<div class="ck-head">Objective — full checklist</div>${rows}${ui.buildChecklistHTML()}`;
}

/** Show a level's story + how-to briefing. `reopened` is the objective-card
 *  revisit — it keeps the current speed rather than assuming a fresh 1×. */
function showStoryModal(levelIndex: number, reopened = false): void {
  const s = storyFor(levelIndex);
  if (!s) return;
  $('storyChapter').textContent = `Chapter ${levelIndex} of ${RUN_LEVELS} · Het Gooi`;
  $('storyTitle').textContent = s.title;
  $('storyText').textContent = s.story;
  ($('storyGoalHead') as HTMLElement).style.display = s.how.length ? '' : 'none';
  $('storyHow').innerHTML = s.how.map(h => `<li>${h}</li>`).join('');
  $('storyObjective').innerHTML = objectiveBreakdownHTML();
  ($('storyImage') as HTMLElement).style.display = 'none';
  ($('storyStart') as HTMLButtonElement).textContent = reopened ? 'Back to the field' : 'Begin';
  // pause while the briefing is up, then restore the speed we came in on
  if (game) { storyPrevSpeed = reopened ? game.simSpeed : 1; ui.setSpeed(0); }
  storyOnClose = () => { if (phase === 'playing') ui.setSpeed(storyPrevSpeed || 1); };
  $('story').style.display = 'flex';
}

/** The objective card's modal for non-tutorial runs: the full objective
 *  checklist (no story), so long multi-part goals live here rather than
 *  overflowing the compact objective panel. Pauses (a no-op in co-op). */
function showObjectiveModal(): void {
  if (!game || !currentLevel) return;
  $('storyChapter').textContent = `Level ${currentLevel.index} · ${currentLevel.name}`;
  $('storyTitle').textContent = 'Objective';
  $('storyText').textContent = game.objective ? game.objective.brief() : '';
  ($('storyGoalHead') as HTMLElement).style.display = 'none';
  $('storyHow').innerHTML = '';
  $('storyObjective').innerHTML = objectiveBreakdownHTML();
  ($('storyImage') as HTMLElement).style.display = 'none';
  ($('storyStart') as HTMLButtonElement).textContent = 'Back to the field';
  storyPrevSpeed = game.simSpeed; ui.setSpeed(0);
  storyOnClose = () => { if (phase === 'playing') ui.setSpeed(storyPrevSpeed || 1); };
  $('story').style.display = 'flex';
}

/** The run's achievements as individually-marked badges: the level tally, gold
 *  earned and Heritage banked, plus a highlighted banner when a new ascension
 *  opens. Shared by both the Normal and the higher-ascension victory modals so
 *  every win reads the same, proud way. */
function victoryOutputsHTML(ascensionNote: string, cta = ''): string {
  const badge = (ico: string, val: string, label: string) =>
    `<div class="vout"><span class="vout-ico">${ico}</span><b>${val}</b><small>${label}</small></div>`;
  let s = '<div class="victory-outputs">';
  s += badge('🏆', `${clearedThisRun}/${RUN_LEVELS}`, 'Levels cleared');
  s += badge('🪙', `${goldEarnedThisRun}`, 'Gold earned');
  s += badge('🏛️', `${meta.heritage}`, 'Heritage banked');
  s += badge('🗺️', `${meta.stats.levelsCleared}`, 'Lifetime cleared');
  s += '</div>';
  if (ascensionNote) s += `<div class="vout-banner"><span class="vout-ico">⬆</span><div class="vout-banner-tx"><b>New ascension unlocked</b><span>${ascensionNote.replace(/^New ascension unlocked:\s*/, '')}</span></div></div>`;
  if (cta) s += `<div class="vout-note">${cta}</div>`;
  return s;
}

/** The one-time congratulations when the dragon falls. Merges the story payoff,
 *  the run tally and any ascension unlock into a single proud modal so a win
 *  ends in one click, not two screens. `higher` is a win above Normal, which
 *  drops the first-run onboarding story for a shorter salute. Button → menu. */
function showVictoryModal(opts: { ascensionNote?: string; higher?: boolean; tierName?: string } = {}): void {
  const { ascensionNote = '', higher = false, tierName = '' } = opts;
  ($('storyImage') as HTMLElement).style.display = '';
  $('storyImage').innerHTML = VICTORY_IMAGE;
  $('storyChapter').textContent = higher
    ? `${tierName || 'Ascension'} cleared · Het Gooi`
    : 'The Hunt is Ended';
  $('storyTitle').textContent = higher ? 'The Dragon Falls Again' : VICTORY_STORY.title;
  $('storyText').textContent = higher
    ? 'The beast is slain once more, on a harder road than the last. Het Gooi stands, its people free, and the songs grow longer with every dragon dragged home to die.'
    : VICTORY_STORY.story;
  ($('storyGoalHead') as HTMLElement).style.display = 'none';
  $('storyHow').innerHTML = '';
  $('storyObjective').innerHTML = victoryOutputsHTML(ascensionNote, higher ? '' : VICTORY_STORY.cta);
  ($('storyStart') as HTMLButtonElement).textContent = 'Return to Het Gooi';
  storyOnClose = () => goMenu();
  $('story').style.display = 'flex';
}

// ---------- co-op expedition lifecycle ----------
/** Submit a gameplay intent to the host sequencer; its accepted broadcast applies it. */
function sendCoopCommand(command: GameCommand): boolean {
  const snapshot = coop.snapshot();
  const sent = coop.send({ type: 'command', commandId: `${snapshot.playerId ?? 'p'}-${++coopCmdSeq}`, command });
  if (!sent) ui.toast('Not connected — action dropped', 'err');
  return sent;
}

/** Host auto-start: both seats ready in the lobby fires exactly one launch. */
function maybeStartExpedition(snapshot: ConnectionSnapshot): void {
  const room = snapshot.room;
  if (!room || room.phase !== 'lobby' || expeditionStartSent) return;
  if (snapshot.status !== 'connected') return;
  const local = room.players.find(p => p.id === snapshot.playerId);
  if (!local?.host) return;
  if (room.players.length !== 2 || !room.players.every(p => p.ready)) return;
  expeditionStartSent = true;
  sendCoopCommand({ type: 'startExpedition', seed: randomSeed(), level: 1 });
}

/** Every accepted command (both players', in server order) lands here. */
function applyAcceptedCommand(accepted: AcceptedCommand): void {
  const command = accepted.command;
  if (command.type === 'startExpedition') {
    if (coop.snapshot().room) startCoopLevel(command.seed, command.level);
    return;
  }
  if (!game || !coopRun) return;
  applyGameCommand(game, accepted.playerId, command);
}

/** Build one Expedition level for both peers from the shared seed. */
function startCoopLevel(seed: number, levelIndex: number): void {
  const snapshot = coop.snapshot();
  const playerId = snapshot.playerId;
  if (!playerId) return;
  if (coopAdvanceTimer !== null) { clearTimeout(coopAdvanceTimer); coopAdvanceTimer = null; }
  if (game) disposeLevel();
  sandbox = false;
  const difficulty = snapshot.room?.settings.difficulty ?? 'erfgooiers';
  const diff = EXPEDITION_DIFFICULTY[difficulty];
  if (!coopRun || levelIndex === 1) {
    coopRun = { level: levelIndex, difficulty };
    run = newRun(seed);          // local gold container — never saved, never shopped (yet)
    clearedThisRun = 0;
    goldEarnedThisRun = 0;
  } else {
    coopRun.level = levelIndex;
    run!.levelIndex = levelIndex;
  }
  const level = expeditionLevelFor(levelIndex);
  currentLevel = level;
  simRng.reseed(seed ^ 0x5bd1e995);
  uiRng.reseed(seed ^ 0x27d4eb2f);
  const world = new World({ seed, ...level.world, biome: 'gooi' });
  view.loadWorld(world);
  game = new Game(world, view, new Modifiers([...diff.specs]), playerId);
  game.toast = (m, c) => ui.toast(m, c);
  game.onSelect = o => ui.showInspector(o);
  game.sfx = name => audio.play(name as any);
  audio.setBiome('gooi');
  audio.setLevel(level.index);
  game.onGold = amt => { if (run) { run.gold = Math.max(0, run.gold + amt); if (amt > 0) goldEarnedThisRun += amt; ui.setGold(run.gold); } };
  game.onHurt = (x, z) => view.spawnHurt(x, z);
  game.onDeath = (x, z, _fac, color, role, scale) => view.spawnCorpse(x, z, color, role, scale);
  game.objective = new Objective(level.objectives[0]);
  game.initCoOp(level.kit, level.kit);
  // in co-op every gameplay intent goes through the host command sequencer;
  // the accepted broadcast (applyAcceptedCommand) mutates the sim on both peers
  game.submitCommand = command => { sendCoopCommand(command); };
  ui.setGame(game);
  ui.setPerks([], []);
  controls.setGame(game);
  game.setEnemies(level.enemies ?? null);
  ui.setMutators([]);
  // both settlements get the same starting garrison, each owned by its player
  if (level.startArmy) {
    for (const pid of ['p1', 'p2'] as const) {
      const st = game.storeFor(pid);
      const sx = world.wx(st.x) + 0.5, sz = world.wz(st.y) + 0.5;
      for (const a of level.startArmy) {
        for (const u of game.spawnSquad(a.kind, a.count, sx, sz, 'player')) u.owner = pid;
      }
    }
  }
  ($('heroChip') as HTMLElement).style.display = 'none'; // no mounted hero in co-op v1
  ui.setGold(run!.gold);
  ui.setSandbox(false);
  ui.setCoOp(true);
  // no story briefings in co-op, but the objective card still opens its checklist
  $('objective').classList.add('clickable');
  $('objective').title = 'Click for the full objective checklist';
  ($('btnDebugWin') as HTMLElement).style.display = 'none'; // a local-only win would desync
  ($('sandboxbar') as HTMLElement).style.display = 'none';
  levelHardTimer = Math.round(level.hardTimer * diff.timerMult);
  ui.setLevel(level.index, level.name);
  ui.setObjective(game.objective.brief());
  ui.updateObjective(game.objective.nextStepLabel(game), 0, levelHardTimer);
  const home = game.storeFor(playerId);
  view.centerOn(world.wx(home.x) + 0.5, world.wz(home.y) + 2);
  view.drawMinimap(game.units);
  simAcc = 0;
  phase = 'playing';
  if ((import.meta as any).env?.DEV) (window as any).game = game;
  showScreen(null);
  ui.toast(`Expedition level ${level.index} — ${level.name}`);
}

/** Team objective met: interlude, then the host launches the next level. */
function onCoopLevelClear(): void {
  if (phase !== 'playing' || !coopRun || !currentLevel) return;
  clearedThisRun++;
  audio.play('coin');
  const cleared = coopRun.level;
  const last = cleared >= EXPEDITION_LEVEL_COUNT;
  disposeLevel();
  if (last) {
    phase = 'summary';
    renderCoopSummary(true);
    showScreen('summary');
    endCoopSession();
    return;
  }
  phase = 'shop'; // a non-playing beat while both peers wait for the next launch
  renderCoopLobby();
  showScreen('cooplobby');
  const snapshot = coop.snapshot();
  const isHost = snapshot.room?.players.find(p => p.id === snapshot.playerId)?.host;
  if (isHost) {
    coopAdvanceTimer = window.setTimeout(() => {
      coopAdvanceTimer = null;
      sendCoopCommand({ type: 'startExpedition', seed: randomSeed(), level: cleared + 1 });
    }, 4000);
  }
}

function renderCoopSummary(victory: boolean, reason: 'timeout' | 'castle' = 'timeout'): void {
  $('sumTitle').textContent = victory ? 'Expedition complete — victory!' : 'Expedition over';
  $('sumSub').textContent = victory
    ? `You and your ally cleared all ${EXPEDITION_LEVEL_COUNT} Expedition levels.`
    : reason === 'castle'
      ? 'A castle has fallen — the Expedition ends for both of you.'
      : 'The clock beat the Expedition — it ends for both of you.';
  $('sumBody').innerHTML =
    `Cleared <b>${clearedThisRun}</b> Expedition level(s) together · gold earned <b>${goldEarnedThisRun}</b>` +
    '<br>Co-op runs bank no Heritage yet — rewards arrive with a later update.';
}

/** Tear down the co-op session state and release the seat. */
function endCoopSession(): void {
  if (coopAdvanceTimer !== null) { clearTimeout(coopAdvanceTimer); coopAdvanceTimer = null; }
  coopRun = null;
  run = null;
  expeditionStartSent = false;
  ui.setCoOp(false);
  coop.leave();
  $('multiplayerpanel').style.display = 'none';
}

// ---------- transitions ----------
function goMenu(): void {
  phase = 'menu';
  sandbox = false;
  audio.rerollHarmony(); // one new pads/chords identity per home-screen visit
  audio.setBiome('gooi'); // release any biome signature before the menu mood
  audio.setLevel(0);
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

/** Whether this run's onboarding aids are on. The very first run forces them
 *  on (first-run flag); afterwards it follows the saved Tutorials setting.
 *  Either can be overridden per run by the new-run panel checkbox. */
let pickedTutorials = true;

function openHeroSelect(): void {
  phase = 'heroSelect';
  pickedAscension = Math.min(pickedAscension, meta.ascension);
  if (!heroAvailable(pickedHero, meta.unlocks)) pickedHero = 'erfgooier';
  pickedTutorials = meta.tutorialSeen ? settings.tutorials : true;
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
  // tutorials only exist on Normal — grey the toggle out on harder tiers
  const normal = pickedAscension === 0;
  const row = $('newRunTutorialsRow');
  row.style.opacity = normal ? '' : '.45';
  const box = $('newRunTutorials') as HTMLInputElement;
  box.disabled = !normal;
  box.checked = !pickedTutorials; // the checkbox turns tutorials OFF
}

function startRun(): void {
  if (!heroAvailable(pickedHero, meta.unlocks)) pickedHero = 'erfgooier';
  sandbox = false;
  run = newRun(randomSeed(), Math.min(pickedAscension, meta.ascension), pickedTutorials);
  run.hero = pickedHero;
  run.gold = metaSpecialValue(meta.activeGlobalBuff, 'startGold');
  stampContract(run);
  meta.stats.runs++;
  meta.tutorialSeen = true; // the first-run auto-on no longer applies after this
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
  // Trouble: independent toggles for beasts & camps, plus a stronghold count.
  // With nothing toggled and no strongholds, the map stays perfectly peaceful.
  s += '<div class="optgroup"><div class="optlabel">Enemies — toggle any trouble you want (leave all off for a peaceful build)</div><div class="optrow">'
    + `<button class="opt${sandboxCfg.wildBeasts ? ' on' : ''}" data-toggle="wildBeasts">🐗 Wild beasts</button>`
    + `<button class="opt${sandboxCfg.banditCamps ? ' on' : ''}" data-toggle="banditCamps">🗡️ Bandit camps</button>`
    + '</div></div>';
  s += `<div class="optgroup"><div class="optlabel">Enemy strongholds — fortified castles with walls & towers dotted across the corners</div>`
    + `<label class="sbxnum">Strongholds <input id="sbxStrongholds" type="number" min="0" max="${MAX_SANDBOX_STRONGHOLDS}" step="1" value="${sandboxCfg.strongholds}"> <span class="whint">(0–${MAX_SANDBOX_STRONGHOLDS})</span></label></div>`;
  el.innerHTML = s;
  el.querySelectorAll<HTMLElement>('.opt[data-key]').forEach(b => {
    b.onclick = () => {
      const key = b.dataset.key as keyof SandboxConfig;
      (sandboxCfg as any)[key] = b.dataset.val;
      // water isn't chosen directly — it follows whichever biome is picked
      if (key === 'biome') sandboxCfg.water = biomeWater(b.dataset.val as BiomeKey);
      audio.play('click');
      renderSandboxSetup();
    };
  });
  el.querySelectorAll<HTMLElement>('.opt[data-toggle]').forEach(b => {
    b.onclick = () => {
      const key = b.dataset.toggle as 'wildBeasts' | 'banditCamps';
      sandboxCfg[key] = !sandboxCfg[key];
      audio.play('click');
      renderSandboxSetup();
    };
  });
  const strong = $('sbxStrongholds') as HTMLInputElement;
  strong.addEventListener('keydown', e => e.stopPropagation());
  strong.addEventListener('input', () => {
    sandboxCfg.strongholds = Math.max(0, Math.min(MAX_SANDBOX_STRONGHOLDS, Math.round(Number(strong.value) || 0)));
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
  if (surplus > 0) rows.push({ label: 'Surplus goods in the castle', gold: surplus });
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
  const normalVictory = last && run.ascension === 0;
  const ascensionNote = summaryNote;
  const clearedTierName = last ? ASCENSION_NAMES[run.ascension] : '';
  disposeLevel();
  if (last) {
    Save.clearRun(); run = null;
    phase = 'summary';
    // every win — Normal or higher — ends on the same proud victory modal with
    // its badged outputs, ending in a single click instead of a summary screen
    showScreen(null); // hide the HUD; the modal brings its own backdrop
    showVictoryModal({ ascensionNote, higher: !normalVictory, tierName: clearedTierName });
  }
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
  phase = 'summary';
  if (coopRun) {
    renderCoopSummary(false, reason);
    showScreen('summary');
    endCoopSession();
    return;
  }
  renderSummary(false, reason); showScreen('summary');
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
  if (coopRun) { leaveCoop(); return; }
  if (phase === 'playing') disposeLevel();
  if (!sandbox) Save.clearRun();
  sandbox = false;
  run = null;
  goMenu();
}

/** Open the in-game pause menu; in co-op the shared sim keeps running. */
function openPauseMenu(): void {
  if (phase !== 'playing') return;
  if (!coopRun) ui.setSpeed(0);
  controls.resetInput();
  $('btnRestart').style.display = coopRun ? 'none' : '';
  $('pausemenu').style.display = 'flex';
}

/** Close the pause menu and resume the active game. */
function resumeGame(): void {
  $('pausemenu').style.display = 'none';
  if (phase === 'playing') ui.setSpeed(1);
}

/** Discard only the active level and rebuild it from its deterministic start.
 *  Run-wide cards, contract, hero and seed remain intact. Co-op deliberately
 *  has no local restart: both peers would need a synchronized checkpoint command. */
function restartLevel(): void {
  if (phase !== 'playing' || !run || coopRun) return;
  run.gold = levelGoldStart;
  goldEarnedThisRun = levelGoldEarnedStart;
  $('pausemenu').style.display = 'none';
  disposeLevel();
  startLevel();
  ui.toast(`Level ${run.levelIndex} restarted`);
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
type ScreenId = 'menu' | 'shop' | 'summary' | 'heritage' | 'heroselect' | 'sandboxselect' | 'coopmenu' | 'cooplobby' | null;
function showScreen(id: ScreenId): void {
  $('pausemenu').style.display = 'none';
  for (const s of ['menu', 'shop', 'summary', 'heritage', 'heroselect', 'sandboxselect', 'coopmenu', 'cooplobby']) $(s).style.display = id === s ? 'flex' : 'none';
  $('hud').style.display = phase === 'playing' ? 'block' : 'none';
  // a screen swallows keyups/pointerups — never leave the camera mid-pan
  controls.resetInput();
}

const coopUi = new CoOpController(coop, ui, {
  showScreen,
  onBack: goMenu,
  onConnection: snapshot => { coopConnected = snapshot.status === 'connected'; maybeStartExpedition(snapshot); },
  onAccepted: applyAcceptedCommand,
  onLeave: leaveCoop,
  isInterlude: () => !!coopRun && phase === 'shop',
});
// ---------- direct co-op handshake, lobby, and in-game connection panel ----------
function openCoopMenu(): void { coopUi.open(); }
function renderCoopLobby(): void { coopUi.renderLobby(); }
function leaveCoop(): void {
  if (coopRun && phase === 'playing') disposeLevel();
  endCoopSession();
  goMenu();
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
// per-run tutorials toggle (checkbox turns them OFF); default follows the setting
($('newRunTutorials') as HTMLInputElement).onchange = e => { pickedTutorials = !(e.target as HTMLInputElement).checked; };
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
coopUi.install();

installSandboxTools(view, ui, {
  getGame: () => game,
  getRun: () => run,
  rebuildModifiers: rebuildSandboxMods,
});
// (the homepage no longer carries a Clear-save button — it lives in Settings)

// ---------- settings screen ----------
const settings: GameSettings = installSettingsController(view, controls, openPauseMenu);

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
($('storyStart') as HTMLButtonElement).onclick = () => { audio.play('click'); hideStory(); };
// the objective card opens the objective modal (full checklist); on a
// first-ascension tutorial level it reopens the story briefing instead
$('objective').addEventListener('click', () => {
  if (phase !== 'playing' || !game || !game.objective || sandbox) return;
  audio.play('click');
  if (run && !coopRun && run.ascension === 0 && run.tutorials && currentLevel && storyFor(currentLevel.index)) {
    showStoryModal(currentLevel.index, true);
  } else {
    showObjectiveModal();
  }
});
($('btnSumMenu') as HTMLButtonElement).onclick = goMenu;
($('btnDebugWin') as HTMLButtonElement).onclick = debugWin;
($('btnHeritage') as HTMLButtonElement).onclick = openHeritage;
($('btnHeritageBack') as HTMLButtonElement).onclick = goMenu;
($('btnToMenu') as HTMLButtonElement).onclick = openPauseMenu;
($('btnResume') as HTMLButtonElement).onclick = resumeGame;
($('btnRestart') as HTMLButtonElement).onclick = restartLevel;
($('btnAbandon') as HTMLButtonElement).onclick = () => { resumeGame(); abandonRun(); };

// ---------- audio ----------
const btnSound = $('btnSound') as HTMLButtonElement;
function renderSound(): void {
  // the in-game control reflects the current mute state
  btnSound.textContent = audio.isMuted ? '🔇' : '🔊';
  btnSound.classList.toggle('off', audio.isMuted);
  btnSound.title = audio.isMuted ? 'Sound off — click to unmute' : 'Sound on — click to mute';
}
const toggleSound = (e: Event): void => { e.stopPropagation(); audio.toggleMute(); renderSound(); };
btnSound.onclick = toggleSound;
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
    // a disconnected co-op peer freezes rather than drifting from its ally
    const simDt = coopRun && !coopConnected ? 0 : dt;
    simAcc += simDt * game.simSpeed;
    let steps = 0;
    const t0 = performance.now();
    while (simAcc >= TICK && steps < MAX_STEPS) { game.update(TICK); simAcc -= TICK; steps++; }
    simMs += (performance.now() - t0 - simMs) * 0.05;
    if (simAcc > TICK) simAcc = 0;            // drop the backlog rather than fast-forward

    const st = game.objective.evaluate(game);
    const remaining = levelHardTimer + game.bonusTime - game.elapsed;
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); ui.updateObjective(game.objective.nextStepLabel(game), st.ratio, remaining); ui.updateWave(game.nextWave()); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }

    // resolve the level last: win, castle lost, or timeout tears the level down
    if (st.done) { if (coopRun) onCoopLevelClear(); else onLevelClear(); }
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
if (new URL(location.href).searchParams.has('coop')) openCoopMenu();
requestAnimationFrame(frame);

