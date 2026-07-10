import type { WorldParams } from '../world/World';
import type { StartKit } from '../game/Game';
import type { ObjectiveDef } from '../game/Objectives';
import type { UnitKind } from './units';
import type { BiomeKey } from './biomes';

/** One scheduled raid. Either `at` (sim seconds) or `whenArmy` (fires `delay`
 *  seconds after the player's fighter count first reaches it — the raid waits
 *  for YOUR muster, so eco time is never stolen). `bonusTime` extends the
 *  level's hard timer when the wave lands. */
export interface WaveDef {
  kind: UnitKind;
  count: number;
  at?: number;
  whenArmy?: number;
  delay?: number;       // seconds between arming and landing (default 45)
  bonusTime?: number;   // seconds added to the hard timer as the wave lands
}

/** A level's enemy presence, spawned by Game.setEnemies after init. */
export interface EnemySetup {
  wild?: { kind: UnitKind; count: number }[];              // roaming beasts (boars, dragon)
  camps?: { count: number; guards: number }[];             // bandit camps with guards
  keep?: { guards: number };                               // one enemy keep (late levels)
  towers?: number;                                         // watchtowers around the keep
  waves?: WaveDef[];                                       // raids marching on the castle
  boss?: UnitKind;                                         // a single boss unit
  commander?: { every: number; kind: UnitKind; count: number; from?: 'edge' | 'camp' };
}

/**
 * A level as pure data: objective (with random variants), world-gen params,
 * starting kit, soft/hard timers, gold reward and optional enemy setup. The
 * table currently spans economy, defense, hunting, frontier assaults and the
 * dragon boss. Numbers remain playtest targets rather than engine constants.
 */
export interface LevelDef {
  index: number;
  name: string;
  type: string;
  objectives: ObjectiveDef[]; // one is chosen per run, deterministically
  world: Omit<WorldParams, 'seed'>;
  kit: StartKit;
  timeTarget: number;         // soft target (seconds) → speed-bonus threshold
  hardTimer: number;          // hard limit (seconds) → run ends on expiry
  reward: number;             // base gold on clear
  enemies?: EnemySetup;       // combat presence (levels 5–10)
  startArmy?: { kind: UnitKind; count: number }[]; // fighters granted at the castle
}

export const LEVELS: LevelDef[] = [
  // Opening economy arc: each level asks for a deeper or wider production
  // network before the combat arc begins at level 5.

  // Economy arc: each level's NAME matches every objective variant it can roll,
  // and each asks for a deeper chain than the last, on a tighter-feeling clock.

  // one chain, two buildings: woodcutter \u2192 sawmill. The gentlest opening.
  { index: 1, name: 'First Timber', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'timber', n: 8 }],
    world: { w: 36, h: 36, treeStands: 6, oreVeins: 5, waterScale: 0.5, meadows: 3, goldPiles: 2 },
    kit: { stock: { timber: 8, stone: 8, bread: 6, coin: 4 }, serfs: 2, laborers: 1 },
    timeTarget: 200, hardTimer: 300, reward: 25 },

  // three-building food chain: farm (+plots) \u2192 mill \u2192 bakery
  { index: 2, name: 'Daily Bread', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'bread', n: 8 }],
    world: { w: 38, h: 38, treeStands: 6, oreVeins: 5, waterScale: 0.6, meadows: 3, goldPiles: 2 },
    kit: { stock: { timber: 12, stone: 10, bread: 6, coin: 4 }, serfs: 2, laborers: 1 },
    timeTarget: 260, hardTimer: 380, reward: 30 },

  // two mines feeding one mint \u2014 the first dual-input recipe
  { index: 3, name: 'First Coin', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'coin', n: 5 }],
    world: { w: 40, h: 40, treeStands: 5, oreVeins: 7, waterScale: 0.6, meadows: 2, goldPiles: 3 },
    kit: { stock: { timber: 12, stone: 10, bread: 8, coin: 4 }, serfs: 2, laborers: 1 },
    timeTarget: 300, hardTimer: 440, reward: 38 },

  // two full chains side by side; both variants stay wine-and-bread themed
  { index: 4, name: 'The Vintner\u2019s Gamble', type: 'Economy',
    objectives: [
      { kind: 'produceMulti', reqs: [{ item: 'bread', n: 8 }, { item: 'wine', n: 6 }] },
      { kind: 'produceMulti', reqs: [{ item: 'wine', n: 8 }, { item: 'bread', n: 6 }] },
    ],
    world: { w: 42, h: 42, treeStands: 6, oreVeins: 6, waterScale: 0.8, meadows: 3, goldPiles: 4 },
    kit: { stock: { timber: 14, stone: 10, bread: 8, coin: 5 }, serfs: 2, laborers: 2 },
    timeTarget: 380, hardTimer: 540, reward: 45 },

  { index: 5, name: 'Raiders at the Gate', type: 'Defend',
    objectives: [{ kind: 'survive', waves: 2 }],
    world: { w: 44, h: 44, treeStands: 6, oreVeins: 5, waterScale: 1.0, meadows: 4, goldPiles: 3, ruins: 2 },
    kit: { stock: { timber: 16, stone: 12, bread: 10, coin: 6, weapon: 2 }, serfs: 6, laborers: 2 },
    // a proper garrison out of the gate (higher ascensions thin it out but
    // stretch the prep clock in return — see ascensionArmyMult/PrepMult)
    startArmy: [{ kind: 'soldier', count: 10 }, { kind: 'archer', count: 4 }, { kind: 'knight', count: 1 }],
    // no raid until the player grows the muster past the starting eight: build
    // and train at your own pace, then provoke wave one. Wave two follows the
    // same trigger and pays its fight out in extra clock.
    enemies: { waves: [
      { whenArmy: 16, delay: 60, kind: 'bandit', count: 5 },
      { whenArmy: 16, delay: 100, bonusTime: 150, kind: 'bandit', count: 8 },
    ] },
    timeTarget: 300, hardTimer: 480, reward: 55 },

  { index: 6, name: 'The Boar Hunt', type: 'Hunt',
    objectives: [{ kind: 'slay', unit: 'boar', n: 8 }],
    world: { w: 46, h: 46, treeStands: 8, oreVeins: 5, waterScale: 0.9, meadows: 5, goldPiles: 3, mountains: 2 },
    kit: { stock: { timber: 14, stone: 10, bread: 12, coin: 8, weapon: 2 }, serfs: 2, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 8 }, { kind: 'archer', count: 4 }],
    enemies: { wild: [{ kind: 'boar', count: 10 }, { kind: 'wolf', count: 5 }] },
    timeTarget: 260, hardTimer: 380, reward: 60 },

  // Frontier levels (7+): a mountain arc walls off an enemy quarter with a
  // guarded pass. Nothing hostile starts near you — combat begins when YOU
  // march through. Maps are much larger, timers sized for building an army.
  { index: 7, name: 'Bandit Country', type: 'Military',
    objectives: [{ kind: 'destroy', n: 2 }],
    world: { w: 64, h: 64, treeStands: 11, oreVeins: 9, waterScale: 1.0, meadows: 6, goldPiles: 6, mountains: 2, ruins: 2, frontier: true },
    kit: { stock: { timber: 18, stone: 14, bread: 12, coin: 12, weapon: 3 }, serfs: 3, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 9 }, { kind: 'archer', count: 6 }, { kind: 'knight', count: 2 }],
    enemies: { wild: [{ kind: 'wolf', count: 4 }], camps: [{ count: 2, guards: 4 }],
      commander: { every: 75, kind: 'bandit', count: 3, from: 'camp' },
      waves: [{ at: 380, kind: 'orc', count: 4 }] },
    timeTarget: 480, hardTimer: 720, reward: 75 },

  { index: 8, name: 'The Fortified Village', type: 'Military',
    objectives: [{ kind: 'destroy', n: 4 }],
    world: { w: 68, h: 68, treeStands: 12, oreVeins: 10, waterScale: 1.05, meadows: 6, goldPiles: 6, mountains: 2, ruins: 3, frontier: true },
    kit: { stock: { timber: 20, stone: 16, bread: 14, coin: 16, weapon: 3, armor: 1 }, serfs: 3, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 11 }, { kind: 'archer', count: 8 }, { kind: 'knight', count: 3 }],
    enemies: { keep: { guards: 6 }, towers: 3, commander: { every: 70, kind: 'orc', count: 4, from: 'camp' },
      waves: [{ at: 440, kind: 'troll', count: 3 }] },
    timeTarget: 560, hardTimer: 840, reward: 95 },

  { index: 9, name: 'The Enemy Keep', type: 'Military',
    objectives: [{ kind: 'destroy', n: 5 }],
    world: { w: 72, h: 72, treeStands: 13, oreVeins: 11, waterScale: 1.1, meadows: 6, goldPiles: 7, mountains: 3, ruins: 2, frontier: true },
    kit: { stock: { timber: 22, stone: 18, bread: 16, coin: 20, weapon: 4, armor: 2 }, serfs: 3, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 13 }, { kind: 'archer', count: 10 }, { kind: 'knight', count: 4 }],
    // the demon broods over the keep's quarter instead of raiding your town
    enemies: { keep: { guards: 8 }, towers: 4, boss: 'demon',
      commander: { every: 60, kind: 'orc', count: 5, from: 'camp' },
      waves: [{ at: 500, kind: 'troll', count: 3 }] },
    timeTarget: 660, hardTimer: 960, reward: 120 },

  { index: 10, name: 'Dragon\u2019s Hoard', type: 'Boss',
    objectives: [{ kind: 'slay', unit: 'dragon', n: 1 }],
    world: { w: 76, h: 76, treeStands: 14, oreVeins: 12, waterScale: 1.1, meadows: 7, goldPiles: 9, mountains: 4, frontier: true },
    kit: { stock: { timber: 24, stone: 18, bread: 20, coin: 28, weapon: 5, armor: 2 }, serfs: 3, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 17 }, { kind: 'archer', count: 12 }, { kind: 'knight', count: 6 }],
    // the dragon sleeps in its walled cul-de-sac; raids trickle in late while
    // you build the massed army its 2600 HP now demands
    enemies: { boss: 'dragon', waves: [{ at: 300, kind: 'boar', count: 6 }, { at: 520, kind: 'orc', count: 5 }, { at: 760, kind: 'troll', count: 2 }] },
    timeTarget: 840, hardTimer: 1200, reward: 160 },
];

/** The level for a run index (clamped so runs never fall off the end of the table). */
export function levelFor(index: number): LevelDef {
  return LEVELS[Math.min(LEVELS.length, Math.max(1, index)) - 1];
}

// =====================================================================
//  Sandbox — a configurable free-build map (menu → Sandbox → setup screen).
//  Civilization-style knobs: size, biome (more coming), water, resource
//  density on the map and in the storehouse, and how much trouble to invite.
// =====================================================================
export interface SandboxConfig {
  size: 'small' | 'medium' | 'large' | 'huge';
  biome: BiomeKey;
  water: 'dry' | 'normal' | 'wet';
  mapRes: 'sparse' | 'normal' | 'rich';
  startRes: 'modest' | 'plentiful' | 'cornucopia';
  enemies: 'none' | 'wilds' | 'camps' | 'warzone';
}

export const DEFAULT_SANDBOX: SandboxConfig = {
  size: 'large', biome: 'gooi', water: 'normal', mapRes: 'rich', startRes: 'plentiful', enemies: 'none',
};

const SBX_SIZE: Record<SandboxConfig['size'], number> = { small: 48, medium: 64, large: 84, huge: 100 };
const SBX_WATER: Record<SandboxConfig['water'], number> = { dry: 0.3, normal: 1, wet: 1.6 };
const SBX_DENSITY: Record<SandboxConfig['mapRes'], number> = { sparse: 0.55, normal: 1, rich: 1.7 };

const SBX_KITS: Record<SandboxConfig['startRes'], StartKit> = {
  modest: { stock: { timber: 20, stone: 16, bread: 10, coin: 8 }, serfs: 4, laborers: 2, villagers: 5 },
  plentiful: { stock: { timber: 90, stone: 70, bread: 50, coin: 30, iron: 12, weapon: 10, armor: 5 }, serfs: 8, laborers: 3, villagers: 8 },
  cornucopia: { stock: { timber: 320, stone: 320, bread: 160, coin: 90, iron: 50, weapon: 40, armor: 20 }, serfs: 12, laborers: 4, villagers: 12 },
};

/** A no-objective free-build map shaped by the setup screen's choices. */
export function sandboxLevel(cfg: SandboxConfig = DEFAULT_SANDBOX): LevelDef {
  const size = SBX_SIZE[cfg.size];
  const den = SBX_DENSITY[cfg.mapRes];
  const scale = size / 48;
  const hostile = cfg.enemies === 'camps' || cfg.enemies === 'warzone';
  const enemies: EnemySetup | undefined =
    cfg.enemies === 'none' ? undefined
      : cfg.enemies === 'wilds' ? {
        wild: [
          { kind: 'boar', count: Math.round(6 * scale) },
          { kind: 'wolf', count: Math.round(5 * scale) },
        ],
      } : cfg.enemies === 'camps' ? {
        wild: [{ kind: 'wolf', count: Math.round(4 * scale) }],
        camps: [{ count: Math.max(2, Math.round(2 * scale)), guards: 4 }],
        commander: { every: 120, kind: 'bandit', count: 3, from: 'camp' },
      } : {
        wild: [{ kind: 'boar', count: Math.round(4 * scale) }],
        camps: [{ count: Math.max(2, Math.round(2 * scale)), guards: 5 }],
        keep: { guards: 8 }, towers: 3,
        commander: { every: 75, kind: 'orc', count: 4, from: 'camp' },
        waves: [{ at: 640, kind: 'troll', count: 3 }],
      };
  const startArmy = cfg.enemies === 'none' ? undefined
    : cfg.enemies === 'wilds' ? [{ kind: 'soldier' as UnitKind, count: 8 }, { kind: 'archer' as UnitKind, count: 4 }]
      : cfg.enemies === 'camps' ? [{ kind: 'soldier' as UnitKind, count: 12 }, { kind: 'archer' as UnitKind, count: 8 }, { kind: 'knight' as UnitKind, count: 2 }]
        : [{ kind: 'soldier' as UnitKind, count: 16 }, { kind: 'archer' as UnitKind, count: 10 }, { kind: 'knight' as UnitKind, count: 4 }, { kind: 'lancer' as UnitKind, count: 4 }];
  return {
    index: 0, name: 'Sandbox', type: 'Sandbox',
    objectives: [{ kind: 'produce', item: 'coin', n: 1 }], // never evaluated (main disables it)
    startArmy,
    world: {
      w: size, h: size,
      biome: cfg.biome,
      treeStands: Math.round(10 * scale * den),
      oreVeins: Math.round(11 * scale * den),
      waterScale: SBX_WATER[cfg.water],
      meadows: Math.round(6 * scale),
      goldPiles: Math.round(8 * scale * den),
      mountains: Math.round(2 * scale),
      ruins: Math.round(1 * scale),
      frontier: hostile,   // hostile sandboxes keep their trouble behind the pass
    },
    kit: SBX_KITS[cfg.startRes],
    timeTarget: Infinity, hardTimer: Infinity, reward: 0,
    enemies,
  };
}
