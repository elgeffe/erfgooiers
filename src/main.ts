import './style.css';
import { World } from './world/World';
import { View } from './render/View';
import { Game } from './game/Game';
import { UI } from './ui/UI';
import { Controls } from './input/Controls';
import { Shop } from './ui/Shop';
import { logoSVG } from './ui/logo';
import { randomSeed, simRng, uiRng } from './engine/rng';
import { Modifiers, type ModifierSpec } from './game/Modifiers';
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
import { ASCENSION_DESCS, ASCENSION_NAMES, MAX_ASCENSION, PLAYER_TITLES, RUN_LEVELS, ascensionDemolishRefund, ascensionForcesCurse, ascensionShopSlots, compareScores, currentLevelSeed, formatRunTime, newRun, type MetaState, type Phase, type RunState, type ScoreEntry } from './game/RunState';
import { planLevel, planStartArmy } from './game/levelPlanning';
import { goldCoinIconSVG, heritageCoinIconSVG } from './ui/icons';
import { renderAchievements, renderMenuScores, renderRunDetail, renderScoreboard } from './ui/menus';
import { installSettingsController } from './ui/settingsController';
import { installSandboxTools } from './ui/sandboxTools';
import { CoOpController } from './ui/CoOpController';
import * as Save from './game/SaveGame';
import { audio } from './audio/Audio';
import { PeerCoOpClient, type ConnectionSnapshot } from './net/PeerCoOpClient';
import { PLAYER_COLOR_PRESETS, type AcceptedCommand, type ExpeditionDifficulty, type GameCommand } from './net/protocol';
import { applyGameCommand } from './game/commands';
import { EXPEDITION_DIFFICULTY, EXPEDITION_LEVEL_COUNT, expeditionLevelFor } from './data/coOpLevels';
import { SKIRMISH_LEVEL, skirmishLevel, DEFAULT_SKIRMISH, type SkirmishConfig } from './data/skirmishLevels';
import { AIController } from './ai/AIController';
import { AI_PROFILES, aiProfile, type AIDifficulty } from './data/aiProfiles';
import { ReplayRecorder, serializeReplay, skirmishWinner, type Replay } from './game/replay';
import type { PlayerId } from './types';

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

ui.onSandboxRemoveCard = id => {
  if (!sandbox || !run || !game) return false;
  const i = run.upgrades.lastIndexOf(id);
  if (i === -1) return false;
  run.upgrades.splice(i, 1);
  rebuildSandboxMods();
  audio.play('click');
  const def = UPGRADE_BY_ID[id];
  if (def) ui.toast(`${def.name} removed`);
  return true;
};

let meta: MetaState = Save.loadMeta();
let run: RunState | null = null;
let game: Game | null = null;
let phase: Phase = 'menu';
let currentLevel: LevelDef | null = null;
let sandbox = false;             // free-build mode: no objective, no timer, no save

/* =====================================================================
   Multiplayer — one system, several modes.
   A multiplayer session is a set of SEATS (local human, remote human, CPU)
   playing one MODE (co-op Expedition, or PvP Skirmish) over one TRANSPORT
   (the host-ordered network relay, or this browser alone). Skirmish vs CPU
   and CPU-vs-CPU spectating are the same system as networked play — only
   the seat kinds and the command transport differ. CPU seats tick from the
   fixed-step loop and submit through the same applyGameCommand seam as any
   human, and local matches record into a downloadable replay.
   ===================================================================== */
type MultiplayerMode = 'expedition' | 'skirmish';

interface MultiplayerSeat {
  id: PlayerId;
  kind: 'local' | 'remote' | 'cpu';
  /** Human seats may bring a hero (network lobbies); CPU seats never do. */
  hero?: string | null;
  /** Preset building paint for the seat. */
  colorHex?: number;
  /** CPU seats: the AIProfile id driving the seat. */
  profile?: string;
}

interface MultiplayerSession {
  mode: MultiplayerMode;
  transport: 'network' | 'local';
  seats: MultiplayerSeat[];
  /** Expedition ladder position (1 for skirmish). */
  level: number;
  difficulty: ExpeditionDifficulty;
  /** Local transport only: CPU seat drivers + the match record. */
  controllers: AIController[];
  recorder: ReplayRecorder | null;
  /** True when every seat is a CPU and the local player only watches. */
  spectate: boolean;
  clock: { tick: number };
}

let multiplayer: MultiplayerSession | null = null;
const networkSession = (): MultiplayerSession | null => multiplayer?.transport === 'network' ? multiplayer : null;
const localSession = (): MultiplayerSession | null => multiplayer?.transport === 'local' ? multiplayer : null;
let lastSkirmishReplay: Replay | null = null;
let expeditionStartSent = false; // host guard: fire one start per both-ready lobby
let coopCmdSeq = 0;
let coopConnected = false;       // frame loop freezes the co-op sim while offline
let coopAdvanceTimer: number | null = null;

// per-run tallies for the summary screen (reset when a run starts)
let clearedThisRun = 0;
let goldEarnedThisRun = 0;
let runTimeFinal = 0; // total sim time of the last victorious run (victory badge)
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
  // Cards like First Prize pay a purse at level start. levelGoldStart was
  // captured above, so a pause-menu restart rolls back before re-granting.
  const startGoldBonus = sandbox ? 0 : mods.startGold();
  if (startGoldBonus > 0) run.gold += startGoldBonus;
  game = new Game(world, view, mods);
  // Fog of war: the Normal tier plays fully revealed (and tutorialized); every
  // harder ascension hides hostiles outside your sight. The sandbox has its
  // own toggle on the setup screen.
  game.fogOfWar = sandbox ? sandboxCfg.fog : run.ascension >= 1;
  // the settings' performance cap gates spawns in single player only — co-op
  // peers must share one cap (the factory's MAX_UNITS default) to stay in sync
  game.unitCap = settings.unitCap;
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
  // demolition pays back less the higher the ascension (sandbox refunds all)
  game.demolishRefundRate = sandbox ? 1 : ascensionDemolishRefund(run.ascension);
  // On Normal a demolished building's worker walks back out as a villager;
  // every harder ascension makes demolition cost the person too.
  game.demolishReturnsWorker = sandbox || run.ascension === 0;
  game.setEnemies(levelPlan.enemies);
  // mutator payloads beyond stat curses: extra wild packs on the map
  for (const id of mutators) {
    const def = MUTATOR_BY_ID[id];
    if (def?.spawnWild) for (const w of def.spawnWild) game.spawnMutatorWild(w.kind, w.count);
  }
  ui.setMutators(mutators.map(id => MUTATOR_BY_ID[id]).filter(d => !!d));
  // hostile sandboxes grant a default garrison too (their LevelDef carries
  // one); higher ascensions thin the granted army but stretch prep time.
  // The whole granted army (level army + hero warband) parades in a grid
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
  s += badge(goldCoinIconSVG(20), `${goldEarnedThisRun}`, 'Gold earned');
  if (runTimeFinal > 0) s += badge('⏱', formatRunTime(runTimeFinal), 'Run time — signed on the scoreboard');
  s += badge(heritageCoinIconSVG(20), `${meta.heritage}`, 'Heritage banked');
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
    : 'The Hunt has Ended';
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
  if (!game || !networkSession()) return;
  applyGameCommand(game, accepted.playerId, command);
}

/** What buildMultiplayerLevel needs to raise one level for any mode/transport. */
interface MultiplayerLevelSetup {
  seed: number;
  mode: MultiplayerMode;
  level: LevelDef;
  localSeat: PlayerId;
  seats: MultiplayerSeat[];
  /** Shared rule base applied to every seat (expedition difficulty specs). */
  difficultySpecs: ModifierSpec[];
  timerMult: number;
  /** Fog of war for this match (default: on for skirmish, off for expedition). */
  fog?: boolean;
}

/**
 * The one construction path every multiplayer mode shares: the deterministic
 * sim (both settlements, diplomacy, garrisons, per-seat rule sets and heroes)
 * plus the common HUD chrome. Identical on every peer given the same setup,
 * which is what keeps networked matches in lockstep and local matches
 * replayable. The caller wires the command transport afterwards.
 */
function buildMultiplayerLevel(setup: MultiplayerLevelSetup): { world: World; game: Game } {
  const { level, mode } = setup;
  currentLevel = level;
  simRng.reseed(setup.seed ^ 0x5bd1e995);
  uiRng.reseed(setup.seed ^ 0x27d4eb2f);
  const world = new World({ seed: setup.seed, ...level.world, biome: level.world.biome ?? 'gooi' });
  view.loadWorld(world);
  const g = new Game(world, view, new Modifiers([...setup.difficultySpecs]), setup.localSeat);
  game = g;
  // Each seat's colour paints its buildings, and its hero's rule specs layer
  // onto the shared difficulty base to form that seat's own Modifiers — one
  // seat's hero never buffs another. Set both before initCoOp so the starting
  // settlement already reflects them (colour, hero perks like extra serfs).
  for (const seat of setup.seats) {
    if (seat.colorHex !== undefined) g.playerColors.set(seat.id, seat.colorHex);
    g.setPlayerMods(seat.id, [...setup.difficultySpecs, ...heroSpecsFor(seat.hero ?? null)]);
  }
  g.toast = (m, c) => ui.toast(m, c);
  g.onSelect = o => ui.showInspector(o);
  g.sfx = name => audio.play(name as any);
  audio.setBiome(level.world.biome ?? 'gooi');
  audio.setLevel(level.index);
  g.onGold = amt => { if (run) { run.gold = Math.max(0, run.gold + amt); if (amt > 0) goldEarnedThisRun += amt; ui.setGold(run.gold); } };
  g.onHurt = (x, z) => view.spawnHurt(x, z);
  g.onDeath = (x, z, _fac, color, role, scale) => view.spawnCorpse(x, z, color, role, scale);
  g.objective = new Objective(level.objectives[0]);
  // Skirmish diplomacy: each seat on its own team, so the shared combat
  // systems treat the rival settlement as hostile. PvE owners keep a team of
  // their own even though the skirmish level spawns none.
  if (mode === 'skirmish') g.setTeams({ p1: 0, p2: 1, enemy: 2, wild: 2 });
  // fog is information-layer only (render + AI perception), so a mismatched
  // setting could not desync peers — but both read it from the shared room
  // settings anyway so the match is fair
  g.fogOfWar = setup.fog ?? (mode === 'skirmish');
  // skirmish rivals spawn in opposite corners; co-op allies share a mid-map axis
  g.initCoOp(level.kit, level.kit, mode === 'skirmish' ? 'diagonal' : 'axis');
  ui.setGame(g);
  ui.setPerks([], []);
  controls.setGame(g);
  g.setEnemies(level.enemies ?? null);
  ui.setMutators([]);
  // Each settlement gets the shared level garrison plus its seat's hero and
  // warband — spawned in fixed seat order so every peer builds the same sim.
  for (const seat of setup.seats) {
    const heroDef = seat.hero ? HERO_BY_ID[seat.hero] : null;
    // parade each seat's warband in front of its own castle gate (the owner is
    // passed so combat stats bake from that seat's rule set, identically on
    // every peer — and identically in headless re-simulation)
    const army = [...(level.startArmy ?? []), ...(heroDef?.startArmy ?? [])];
    if (army.length) g.spawnStartArmy(army, seat.id);
    if (heroDef) g.spawnHero(heroDef.id, heroDef.name, seat.id);
  }
  // Mount the local seat's hero on the HUD chip, if it brought one.
  const localHero = setup.seats.find(seat => seat.id === setup.localSeat)?.hero;
  const localHeroDef = localHero ? HERO_BY_ID[localHero] : null;
  const heroChip = $('heroChip') as HTMLElement;
  if (localHeroDef) {
    $('heroIcon').textContent = localHeroDef.icon;
    $('heroName').textContent = localHeroDef.name;
    heroChip.style.display = 'flex';
  } else heroChip.style.display = 'none';
  ui.setGold(run?.gold ?? 0);
  ui.setSandbox(false);
  // the objective card opens the full checklist (multiplayer has no briefings)
  $('objective').classList.add('clickable');
  $('objective').title = 'Click for the full objective checklist';
  ($('btnDebugWin') as HTMLElement).style.display = 'none'; // a local-only win would desync
  ($('sandboxbar') as HTMLElement).style.display = 'none';
  document.body.classList.remove('sandbox');
  levelHardTimer = Math.round(level.hardTimer * setup.timerMult);
  ui.setLevel(level.index, level.name);
  ui.setObjective(g.objective.brief());
  ui.updateObjective(g.objective.nextStepLabel(g), 0, levelHardTimer);
  const home = g.storeFor(setup.localSeat);
  view.centerOn(world.wx(home.x) + 0.5, world.wz(home.y) + 2);
  view.drawMinimap(g.units);
  simAcc = 0;
  phase = 'playing';
  if ((import.meta as any).env?.DEV) (window as any).game = g;
  showScreen(null);
  return { world, game: g };
}

/** Build one networked level for both peers from the shared seed. */
function startCoopLevel(seed: number, levelIndex: number): void {
  const snapshot = coop.snapshot();
  const playerId = snapshot.playerId;
  if (!playerId) return;
  if (coopAdvanceTimer !== null) { clearTimeout(coopAdvanceTimer); coopAdvanceTimer = null; }
  if (game) disposeLevel();
  sandbox = false;
  const difficulty = snapshot.room?.settings.difficulty ?? 'erfgooiers';
  const mode: MultiplayerMode = snapshot.room?.settings.mode === 'skirmish' ? 'skirmish' : 'expedition';
  const diff = EXPEDITION_DIFFICULTY[difficulty];
  const seats: MultiplayerSeat[] = (['p1', 'p2'] as const).map(id => {
    const roomPlayer = snapshot.room?.players.find(p => p.id === id);
    return {
      id,
      kind: id === playerId ? 'local' as const : 'remote' as const,
      hero: roomPlayer?.hero ?? null,
      colorHex: roomPlayer?.color?.startsWith('#') ? parseInt(roomPlayer.color.slice(1), 16) : undefined,
    };
  });
  if (!networkSession() || levelIndex === 1) {
    multiplayer = {
      mode, transport: 'network', seats, level: levelIndex, difficulty,
      controllers: [], recorder: null, spectate: false, clock: { tick: 0 },
    };
    run = newRun(seed);          // local gold container — never saved, never shopped (yet)
    clearedThisRun = 0;
    goldEarnedThisRun = 0;
  } else {
    multiplayer!.level = levelIndex;
    run!.levelIndex = levelIndex;
  }
  const level = mode === 'skirmish' ? SKIRMISH_LEVEL : expeditionLevelFor(levelIndex);
  buildMultiplayerLevel({
    seed, mode, level, localSeat: playerId, seats,
    difficultySpecs: [...diff.specs], timerMult: diff.timerMult,
    // hosts before the fog field existed omit it — default on for skirmish
    fog: mode === 'skirmish' ? snapshot.room?.settings.fog ?? true : false,
  });
  // over the network every gameplay intent goes through the host command
  // sequencer; the accepted broadcast (applyAcceptedCommand) mutates the sim
  // on both peers
  game!.submitCommand = command => { sendCoopCommand(command); };
  ui.setCoOp(true);
  ui.toast(mode === 'skirmish' ? `Skirmish — ${level.name}` : `Expedition level ${level.index} — ${level.name}`);
}

/** Team objective met: interlude, then the host launches the next level. */
function onCoopLevelClear(): void {
  if (phase !== 'playing' || !networkSession() || !currentLevel) return;
  clearedThisRun++;
  audio.play('coin');
  const cleared = networkSession()!.level;
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

// ---------- skirmish vs CPU (local, no lobby) ----------
/** Biome & map-density pickers, shared verbatim by the sandbox and skirmish
 *  setup screens (the arena reuses the sandbox's world knobs). */
const BIOME_OPTS: [string, string][] = [['gooi', 'Het Gooi']];
const MAP_RES_OPTS: [string, string][] = [['sparse', 'Sparse'], ['normal', 'Normal'], ['rich', 'Rich']];
const SKIRMISH_SIZE_OPTS: [string, string][] = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Huge']];

interface SkaiSeatCfg { difficulty: AIDifficulty; policy: string }
let skaiCfg: { seat: 'play' | 'spectate'; fog: boolean; map: SkirmishConfig; east: SkaiSeatCfg; west: SkaiSeatCfg } = {
  seat: 'play',
  fog: true,
  map: { ...DEFAULT_SKIRMISH },
  east: { difficulty: 'easy', policy: 'classic' },   // the rival (p2)
  west: { difficulty: 'hard', policy: 'classic' },   // your seat when spectating (p1)
};

function skaiProfileId(seat: SkaiSeatCfg): string {
  return seat.policy === 'classic' ? `classic-${seat.difficulty}` : seat.policy;
}

function openSkirmishAISetup(): void {
  renderSkirmishAISetup();
  showScreen('skirmishaiselect');
}

function renderSkirmishAISetup(): void {
  const el = $('skaiOptions');
  const spectate = skaiCfg.seat === 'spectate';
  const seatGroups = (side: 'east' | 'west', title: string): string => {
    const cfg = skaiCfg[side];
    const classic = cfg.policy === 'classic';
    const groups: { key: keyof SkaiSeatCfg; label: string; opts: [string, string][]; hidden?: boolean }[] = [
      { key: 'policy', label: `${title} — Classic is the benchmark; Tensor is the MPS research brain; Idle & Random are training dummies`, opts: [['classic', '⚔️ Classic'], ['tensor', '🧠 Tensor'], ['random', '🎲 Random'], ['idle', '💤 Idle']] },
      { key: 'difficulty', label: 'Difficulty — a better player, never a cheating one', hidden: !classic, opts: [['easy', '🌱 Easy'], ['hard', '⚔️ Hard'], ['godlike', '🔥 Godlike']] },
    ];
    let block = '';
    for (const grp of groups) {
      if (grp.hidden) continue;
      block += `<div class="optgroup"><div class="optlabel">${grp.label}</div><div class="optrow">`;
      for (const [val, label] of grp.opts) {
        block += `<button class="opt${cfg[grp.key] === val ? ' on' : ''}" data-side="${side}" data-key="${grp.key}" data-val="${val}">${label}</button>`;
      }
      block += '</div></div>';
    }
    block += `<div class="metaline">${AI_PROFILES[skaiProfileId(cfg)].name} — ${AI_PROFILES[skaiProfileId(cfg)].desc}</div>`;
    return block;
  };
  let s = '<div class="optgroup"><div class="optlabel">Your seat</div><div class="optrow">'
    + `<button class="opt${!spectate ? ' on' : ''}" data-seat="play">🧑‍🌾 Play the west seat</button>`
    + `<button class="opt${spectate ? ' on' : ''}" data-seat="spectate">👁️ Spectate — CPUs in both seats</button>`
    + '</div></div>';
  s += '<div class="optgroup"><div class="optlabel">Fog of war — hostiles are hidden outside your sight (CPUs play under the same fog)</div><div class="optrow">'
    + `<button class="opt${skaiCfg.fog ? ' on' : ''}" data-fog="on">🌫️ Fog on</button>`
    + `<button class="opt${!skaiCfg.fog ? ' on' : ''}" data-fog="off">☀️ Revealed</button>`
    + '</div></div>';
  // the arena's world knobs, shared with the sandbox setup screen
  const mapGroups: { key: keyof SkirmishConfig; label: string; opts: [string, string][] }[] = [
    { key: 'size', label: 'Arena size', opts: SKIRMISH_SIZE_OPTS },
    { key: 'biome', label: 'Biome', opts: BIOME_OPTS },
    { key: 'mapRes', label: 'Map resources', opts: MAP_RES_OPTS },
  ];
  for (const grp of mapGroups) {
    s += `<div class="optgroup"><div class="optlabel">${grp.label}</div><div class="optrow">`;
    for (const [val, label] of grp.opts) {
      s += `<button class="opt${skaiCfg.map[grp.key] === val ? ' on' : ''}" data-map="${grp.key}" data-val="${val}">${label}</button>`;
    }
    s += '</div></div>';
  }
  if (spectate) s += seatGroups('west', 'West CPU (your colours)');
  s += seatGroups('east', spectate ? 'East CPU' : 'Opponent brain');
  el.innerHTML = s;
  el.querySelectorAll<HTMLElement>('.opt[data-seat]').forEach(b => {
    b.onclick = () => { skaiCfg.seat = b.dataset.seat as 'play' | 'spectate'; audio.play('click'); renderSkirmishAISetup(); };
  });
  el.querySelectorAll<HTMLElement>('.opt[data-fog]').forEach(b => {
    b.onclick = () => { skaiCfg.fog = b.dataset.fog === 'on'; audio.play('click'); renderSkirmishAISetup(); };
  });
  el.querySelectorAll<HTMLElement>('.opt[data-map]').forEach(b => {
    b.onclick = () => { (skaiCfg.map as any)[b.dataset.map!] = b.dataset.val; audio.play('click'); renderSkirmishAISetup(); };
  });
  el.querySelectorAll<HTMLElement>('.opt[data-key]').forEach(b => {
    b.onclick = () => {
      (skaiCfg[b.dataset.side as 'east' | 'west'] as any)[b.dataset.key!] = b.dataset.val;
      audio.play('click');
      renderSkirmishAISetup();
    };
  });
}

/** Start a skirmish over the LOCAL transport: CPU seats instead of a lobby.
 *  Same builder, same level, same rules as the networked mode — only the
 *  seat kinds and the command path differ. */
function startSkirmishAI(): void {
  if (game) disposeLevel();
  sandbox = false;
  const seed = randomSeed();
  run = newRun(seed);           // local gold container — nothing is banked
  clearedThisRun = 0;
  goldEarnedThisRun = 0;
  const level = skirmishLevel({ ...skaiCfg.map, fog: skaiCfg.fog });
  const spectate = skaiCfg.seat === 'spectate';
  const seats: MultiplayerSeat[] = [
    spectate
      ? { id: 'p1', kind: 'cpu', profile: skaiProfileId(skaiCfg.west), colorHex: parseInt(PLAYER_COLOR_PRESETS[0].slice(1), 16) }
      : { id: 'p1', kind: 'local', colorHex: parseInt(PLAYER_COLOR_PRESETS[0].slice(1), 16) },
    { id: 'p2', kind: 'cpu', profile: skaiProfileId(skaiCfg.east), colorHex: parseInt(PLAYER_COLOR_PRESETS[1].slice(1), 16) },
  ];
  multiplayer = {
    mode: 'skirmish', transport: 'local', seats, level: 1, difficulty: 'erfgooiers',
    controllers: [], recorder: null, spectate, clock: { tick: 0 },
  };
  const session = multiplayer;
  const { world } = buildMultiplayerLevel({
    seed, mode: 'skirmish', level, localSeat: 'p1', seats,
    difficultySpecs: [], timerMult: 1, fog: skaiCfg.fog,
  });
  // a spectator is an observer, not a player: the CPU seats still perceive
  // under fog, but the whole board renders revealed
  if (spectate) game!.fogRevealAll = true;
  const recorder = new ReplayRecorder(seed, level.name, seats.map(seat =>
    seat.kind === 'cpu' ? { id: seat.id, kind: 'ai' as const, profile: seat.profile! } : { id: seat.id, kind: 'human' as const }));
  session.recorder = recorder;
  // the local seat's commands flow through the recorder, then apply directly;
  // a spectator's clicks are dropped — the ants run their own farm
  game!.submitCommand = spectate
    ? () => { ui.toast('Spectating — both seats are CPU-driven', 'err'); }
    : command => {
      recorder.record(session.clock.tick, 'p1', command);
      applyGameCommand(game!, 'p1', command);
    };
  session.controllers = seats
    .filter(seat => seat.kind === 'cpu')
    .map(seat => new AIController({
      game: game!, world, playerId: seat.id,
      profile: aiProfile(seat.profile!),
      // seat-index derivation as in headless self-play (p1 → 1, p2 → 2)
      seed: (seed ^ (seat.id === 'p1' ? 1 : 2) * 0x9e3779b9) >>> 0,
      submit: command => {
        recorder.record(session.clock.tick, seat.id, command);
        return applyGameCommand(game!, seat.id, command);
      },
    }));
  lastSkirmishReplay = null;
  ui.setCoOp(false);
  const cpuName = (id: PlayerId): string => AI_PROFILES[seats.find(s => s.id === id)!.profile!].name;
  ui.toast(spectate
    ? `Spectating ${cpuName('p1')} vs ${cpuName('p2')} — ${level.name}`
    : `Skirmish vs ${cpuName('p2')} — ${level.name}`);
}

/** The local-transport match resolved: winner off the same eliminated-set
 *  rule as networked skirmish, plus a downloadable replay of the match. */
function onSkirmishAIEnd(): void {
  const session = localSession();
  if (phase !== 'playing' || !session || !game) return;
  const { spectate } = session;
  const winner = skirmishWinner(game);
  const anyLost = game.eliminated.size > 0;
  const seatName = (id: PlayerId): string => {
    const seat = session.seats.find(s => s.id === id);
    return seat?.kind === 'cpu' ? `${AI_PROFILES[seat.profile!]?.name ?? seat.profile} CPU` : 'You';
  };
  lastSkirmishReplay = session.recorder?.finish({
    winner,
    ticks: session.clock.tick,
    reason: anyLost ? 'storehouse' : 'timeout',
  }) ?? null;
  const victory = winner === 'p1';
  audio.play(spectate || victory ? 'coin' : 'error');
  disposeLevel();
  multiplayer = null;
  phase = 'summary';
  if (spectate) {
    $('sumTitle').textContent = winner ? `Skirmish over — ${seatName(winner)} wins!` : 'Skirmish drawn';
    $('sumSub').textContent = winner
      ? `${seatName(winner)} razed the rival storehouse. The ants have spoken.`
      : 'The clock ran out with both storehouses standing — a stalemate.';
  } else {
    $('sumTitle').textContent = victory ? 'Skirmish won!' : anyLost ? 'Skirmish lost' : 'Skirmish drawn';
    $('sumSub').textContent = victory
      ? `The ${seatName('p2')}'s storehouse lies in ruins — the border is yours.`
      : anyLost
        ? `Your storehouse has fallen to the ${seatName('p2')}.`
        : 'The clock ran out with both storehouses standing — a stalemate.';
  }
  $('sumBody').innerHTML = `Gold earned <b>${goldEarnedThisRun}</b><br>Skirmish vs CPU is a beta mode — no Heritage or rewards are banked yet.`;
  ($('btnSumReplay') as HTMLElement).style.display = '';
  showScreen('summary');
  run = null;
}

/** Tear down a live local-transport match (pause menu abandon). */
function endSkirmishAISession(): void {
  if (phase === 'playing') disposeLevel();
  multiplayer = null;
  run = null;
  goMenu();
}

/** A storehouse fell (or the clock ran out): both peers resolve the same
 *  winner from the deterministic sim, each showing their own side of it. */
function onSkirmishEnd(): void {
  if (phase !== 'playing' || !networkSession() || !game) return;
  const localId = coop.snapshot().playerId ?? 'p1';
  const localLost = game.eliminated.has(localId);
  const anyLost = game.eliminated.size > 0;
  const victory = anyLost && !localLost;
  audio.play(victory ? 'coin' : 'error');
  disposeLevel();
  phase = 'summary';
  $('sumTitle').textContent = victory ? 'Skirmish won!' : anyLost ? 'Skirmish lost' : 'Skirmish drawn';
  $('sumSub').textContent = victory
    ? "Your rival's storehouse lies in ruins — the border is yours."
    : anyLost
      ? 'Your storehouse has fallen — the border is lost.'
      : 'The clock ran out with both storehouses standing — a stalemate.';
  $('sumBody').innerHTML = `Gold earned <b>${goldEarnedThisRun}</b><br>Skirmish is a beta mode — no Heritage or rewards are banked yet.`;
  showScreen('summary');
  endCoopSession();
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
  multiplayer = null;
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
  $('heroMeta').innerHTML = `${heritageCoinIconSVG(15)} <b>${meta.heritage}</b> Heritage — locked heroes are bought here, kept forever`;
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

const PLAYER_ID_KEY = 'erfgooiers.player.v1';

/** Fill the run-start name box and title picker, remembering the last choice. */
function initRunIdentity(): void {
  const select = $('runTitle') as HTMLSelectElement;
  select.innerHTML = PLAYER_TITLES.map(t => `<option value="${t}">${t}</option>`).join('');
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_ID_KEY) ?? 'null') as { name?: string; title?: string } | null;
    if (saved?.name) ($('runName') as HTMLInputElement).value = saved.name;
    if (saved?.title && PLAYER_TITLES.includes(saved.title)) select.value = saved.title;
  } catch { /* fresh browser — leave the defaults */ }
  ($('runName') as HTMLInputElement).addEventListener('keydown', e => e.stopPropagation());
}

function startRun(): void {
  if (!heroAvailable(pickedHero, meta.unlocks)) pickedHero = 'erfgooier';
  sandbox = false;
  run = newRun(randomSeed(), Math.min(pickedAscension, meta.ascension), pickedTutorials);
  run.hero = pickedHero;
  run.playerName = ($('runName') as HTMLInputElement).value.trim().slice(0, 20) || 'Erfgooier';
  run.playerTitle = ($('runTitle') as HTMLSelectElement).value || PLAYER_TITLES[0];
  try { localStorage.setItem(PLAYER_ID_KEY, JSON.stringify({ name: run.playerName, title: run.playerTitle })); } catch { /* ignore */ }
  run.gold = metaSpecialValue(meta.activeGlobalBuff, 'startGold');
  stampContract(run);
  meta.stats.runs++;
  meta.tutorialSeen = true; // the first-run auto-on no longer applies after this
  Save.saveMeta(meta);
  clearedThisRun = 0;
  goldEarnedThisRun = 0;
  runTimeFinal = 0;
  startLevel();
}

// ---------- sandbox setup (menu → Sandbox) ----------
let sandboxCfg: SandboxConfig = { ...DEFAULT_SANDBOX };

/** The setup screen's option groups: key into SandboxConfig, label, choices.
 *  The water level isn't a knob of its own — it follows the chosen biome. */
function sbxGroups(): { key: keyof SandboxConfig; label: string; opts: [string, string][] }[] {
  return [
    { key: 'size', label: 'Map size', opts: [['small', 'Small · 48'], ['medium', 'Medium · 64'], ['large', 'Large · 84'], ['huge', 'Huge · 112'], ['colossal', 'Colossal · 144']] },
    { key: 'biome', label: 'Biome', opts: BIOME_OPTS },
    { key: 'mapRes', label: 'Map resources', opts: MAP_RES_OPTS },
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
    + `<button class="opt${sandboxCfg.fog ? ' on' : ''}" data-toggle="fog">🌫️ Fog of war</button>`
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
      const key = b.dataset.toggle as 'wildBeasts' | 'banditCamps' | 'fog';
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
  run.timeSeconds += game.elapsed; // the speedrun clock sums every cleared level
  run.levelTimes.push(game.elapsed); // …and keeps the per-level split for the scoreboard
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
    // sign the speedrun scoreboard: this victory, under the name & epithet
    // chosen at run start (kept sorted, capped so the save can't bloat)
    runTimeFinal = run.timeSeconds;
    meta.scores.push({ name: run.playerName || 'Erfgooier', title: run.playerTitle || PLAYER_TITLES[0], ascension: run.ascension, timeSeconds: run.timeSeconds, hero: run.hero, date: Date.now(), levelTimes: [...run.levelTimes] });
    meta.scores.sort(compareScores);
    if (meta.scores.length > 50) meta.scores.length = 50;
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
      { slots: ascensionShopSlots(run.ascension), lifetime: { ...meta.stats } });
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
  if (networkSession()) {
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
  if (phase === 'playing' && !multiplayer) onLevelClear();
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
  if (localSession()) { endSkirmishAISession(); return; }
  if (networkSession()) { leaveCoop(); return; }
  if (phase === 'playing') disposeLevel();
  if (!sandbox) Save.clearRun();
  sandbox = false;
  run = null;
  goMenu();
}

/** Open the in-game pause menu; in co-op the shared sim keeps running. */
function openPauseMenu(): void {
  if (phase !== 'playing') return;
  if (!networkSession()) ui.setSpeed(0);
  controls.resetInput();
  $('btnRestart').style.display = multiplayer ? 'none' : '';
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
  if (phase !== 'playing' || !run || multiplayer) return;
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
type ScreenId = 'menu' | 'shop' | 'summary' | 'heritage' | 'achievements' | 'scoreboard' | 'heroselect' | 'sandboxselect' | 'skirmishaiselect' | 'coopmenu' | 'cooplobby' | null;
function showScreen(id: ScreenId): void {
  $('pausemenu').style.display = 'none';
  for (const s of ['menu', 'shop', 'summary', 'heritage', 'achievements', 'scoreboard', 'heroselect', 'sandboxselect', 'skirmishaiselect', 'coopmenu', 'cooplobby']) $(s).style.display = id === s ? 'flex' : 'none';
  // the replay button only belongs to a just-finished vs-CPU skirmish
  if (id !== 'summary') ($('btnSumReplay') as HTMLElement).style.display = 'none';
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
  isInterlude: () => !!networkSession() && phase === 'shop',
});
// ---------- direct co-op handshake, lobby, and in-game connection panel ----------
function openCoopMenu(): void { coopUi.open(); }
function renderCoopLobby(): void { coopUi.renderLobby(); }
function leaveCoop(): void {
  if (networkSession() && phase === 'playing') disposeLevel();
  endCoopSession();
  goMenu();
}


function renderMenu(): void {
  const has = Save.hasRun();
  const cont = $('btnContinue') as HTMLButtonElement;
  cont.style.display = has ? 'block' : 'none';
  $('metaLine').innerHTML =
    `${heritageCoinIconSVG(14)} <b>${meta.heritage}</b> Heritage · runs: ${meta.stats.runs} · wins: ${meta.stats.wins} · levels cleared: ${meta.stats.levelsCleared} · best: level ${meta.stats.bestLevel || 0}` +
    (meta.ascension > 0 ? ` · ascension unlocked: ${ASCENSION_NAMES[meta.ascension]}` : '');
  renderMenuScores($('menuScores'), meta);
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

// ---------- achievements (main menu) ----------
function openAchievements(): void { renderAchievements($('achMeta'), $('achGrid'), meta); showScreen('achievements'); }

// ---------- speedrun scoreboard (main menu) ----------
// The Back button walks the same way it came: run detail → run list → menu.
let scoreDetailOpen = false;
function openScoreboard(): void {
  scoreDetailOpen = false;
  renderScoreboard($('sbMeta'), $('sbBody'), meta, openScoreDetail);
  showScreen('scoreboard');
}
function openScoreDetail(entry: ScoreEntry): void {
  scoreDetailOpen = true;
  renderRunDetail($('sbMeta'), $('sbBody'), entry, meta);
  audio.play('click');
}

function renderHeritage(): void {
  $('heritageMeta').innerHTML = `${heritageCoinIconSVG(15)} <b>${meta.heritage}</b> Heritage to spend · own any number, activate one global blessing`;
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
initRunIdentity();
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
($('btnSkirmishAI') as HTMLButtonElement).onclick = openSkirmishAISetup;
($('btnSkaiBack') as HTMLButtonElement).onclick = goMenu;
($('btnSkaiStart') as HTMLButtonElement).onclick = startSkirmishAI;
($('btnSumReplay') as HTMLButtonElement).onclick = () => {
  if (!lastSkirmishReplay) return;
  const blob = new Blob([serializeReplay(lastSkirmishReplay)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `erfgooiers-skirmish-${lastSkirmishReplay.seed}.replay.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  ui.toast('Replay saved — it re-simulates the whole match from its command log');
};
coopUi.install();

installSandboxTools(view, ui, {
  getGame: () => game,
  getRun: () => run,
  rebuildModifiers: rebuildSandboxMods,
  isSandbox: () => sandbox,
  getUnlocks: () => (meta.activeGlobalBuff ? [meta.activeGlobalBuff] : []),
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
// Clearing everything is irreversible — demand a second click to confirm.
// The armed state disarms itself after a few seconds so a stray click can't
// linger as a loaded gun.
let clearArmTimer: number | null = null;
($('btnSettingsClear') as HTMLButtonElement).onclick = () => {
  const btn = $('btnSettingsClear') as HTMLButtonElement;
  if (clearArmTimer === null) {
    btn.textContent = '⚠ Click again to erase everything';
    clearArmTimer = window.setTimeout(() => {
      clearArmTimer = null;
      btn.textContent = 'Clear save data';
    }, 5000);
    return;
  }
  clearTimeout(clearArmTimer);
  clearArmTimer = null;
  btn.textContent = 'Clear save data';
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
  if (run && !multiplayer && run.ascension === 0 && run.tutorials && currentLevel && storyFor(currentLevel.index)) {
    showStoryModal(currentLevel.index, true);
  } else {
    showObjectiveModal();
  }
});
($('btnSumMenu') as HTMLButtonElement).onclick = goMenu;
($('btnDebugWin') as HTMLButtonElement).onclick = debugWin;
($('btnHeritage') as HTMLButtonElement).onclick = openHeritage;
($('btnHeritageBack') as HTMLButtonElement).onclick = goMenu;
($('btnAchievements') as HTMLButtonElement).onclick = openAchievements;
($('btnAchBack') as HTMLButtonElement).onclick = goMenu;
($('btnScoreboard') as HTMLButtonElement).onclick = openScoreboard;
($('btnScoreBack') as HTMLButtonElement).onclick = () => { if (scoreDetailOpen) openScoreboard(); else goMenu(); };
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
    const simDt = networkSession() && !coopConnected ? 0 : dt;
    simAcc += simDt * game.simSpeed;
    let steps = 0;
    const t0 = performance.now();
    while (simAcc >= TICK && steps < MAX_STEPS) {
      // CPU seats think before each step, exactly like headless self-play
      const local = localSession();
      if (local) for (const controller of local.controllers) controller.tick(TICK);
      game.update(TICK);
      if (local) local.clock.tick++;
      simAcc -= TICK; steps++;
    }
    simMs += (performance.now() - t0 - simMs) * 0.05;
    if (simAcc > TICK) simAcc = 0;            // drop the backlog rather than fast-forward

    const st = game.objective.evaluate(game);
    const remaining = levelHardTimer + game.bonusTime - game.elapsed;
    uiT += dt; if (uiT > 0.3) { uiT = 0; ui.tick(); ui.updateObjective(game.objective.nextStepLabel(game), st.ratio, remaining); ui.updateWave(game.nextWave()); }
    mmT += dt; if (mmT > 0.5) { mmT = 0; view.drawMinimap(game.units); }

    // resolve the level last: win, castle lost, or timeout tears the level down
    if (st.done) {
      if (multiplayer?.mode === 'skirmish') { if (multiplayer.transport === 'local') onSkirmishAIEnd(); else onSkirmishEnd(); }
      else if (networkSession()) onCoopLevelClear();
      else onLevelClear();
    }
    else if (game.defeat) onDefeat('castle');
    else if (remaining <= 0) {
      if (multiplayer?.mode === 'skirmish') { if (multiplayer.transport === 'local') onSkirmishAIEnd(); else onSkirmishEnd(); }
      else onDefeat('timeout');
    }
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

