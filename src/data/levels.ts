import type { WorldParams } from '../world/World';
import type { StartKit } from '../game/Game';
import type { ObjectiveDef } from '../game/Objectives';
import type { UnitKind } from './units';

/** A level's enemy presence, spawned by Game.setEnemies after init. */
export interface EnemySetup {
  wild?: { kind: UnitKind; count: number }[];              // roaming beasts (boars, dragon)
  camps?: { count: number; guards: number }[];             // bandit camps with guards
  keep?: { guards: number };                               // one enemy keep (late levels)
  towers?: number;                                         // watchtowers around the keep
  waves?: { at: number; kind: UnitKind; count: number }[]; // timed raids at the castle
  boss?: UnitKind;                                         // a single boss unit
  commander?: { every: number; kind: UnitKind; count: number; from?: 'edge' | 'camp' };
}

/**
 * A level as pure data: objective (with random variants), world-gen params,
 * starting kit, soft/hard timers and gold reward. Levels 5–10 ship as economy
 * placeholders until Phase 3 replaces them with combat. Numbers are targets to
 * tune in playtesting — hard timers sit ~40% above the soft target.
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
  // Phase 1 economy arc. Each level asks for a deeper production chain than the
  // last, in larger quantities, on a map with progressively more water — so the
  // buildable land shrinks exactly as the objective demands more of it.

  { index: 1, name: 'Daily Bread', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'bread', n: 8 },
      { kind: 'produce', item: 'timber', n: 12 },
    ],
    world: { w: 38, h: 38, treeStands: 6, oreVeins: 5, waterScale: 0.6, meadows: 3, goldPiles: 2 },
    kit: { stock: { timber: 10, stone: 10, bread: 6, coin: 4 }, serfs: 2, laborers: 1 },
    timeTarget: 240, hardTimer: 340, reward: 30 },
  
  { index: 2, name: 'First Coin', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'coin', n: 3 }],
    world: { w: 36, h: 36, treeStands: 5, oreVeins: 6, waterScale: 0.5, meadows: 2, goldPiles: 2 },
    kit: { stock: { timber: 12, stone: 10, bread: 8, coin: 4 }, serfs: 2, laborers: 1 },
    timeTarget: 220, hardTimer: 320, reward: 25 },

  { index: 3, name: 'The Vintner\u2019s Gamble', type: 'Economy',
    objectives: [
      // both chains at once: run the bakery AND the winery side by side
      { kind: 'produceMulti', reqs: [{ item: 'bread', n: 8 }, { item: 'wine', n: 6 }] },
    ],
    world: { w: 40, h: 40, treeStands: 6, oreVeins: 5, waterScale: 0.7, meadows: 3, goldPiles: 3 },
    kit: { stock: { timber: 10, stone: 10, bread: 8, coin: 4 }, serfs: 2, laborers: 1 },
    timeTarget: 260, hardTimer: 370, reward: 35 },

  { index: 4, name: 'The Coin Run', type: 'Economy',
    objectives: [
      { kind: 'produceMulti', reqs: [{ item: 'coin', n: 14 }, { item: 'bread', n: 8 }] },
      { kind: 'produceMulti', reqs: [{ item: 'coin', n: 12 }, { item: 'wine', n: 6 }] },
    ],
    world: { w: 42, h: 42, treeStands: 6, oreVeins: 7, waterScale: 0.85, meadows: 3, goldPiles: 6 },
    kit: { stock: { timber: 12, stone: 10, bread: 8, coin: 5 }, serfs: 2, laborers: 2 },
    timeTarget: 360, hardTimer: 430, reward: 45 },

  { index: 5, name: 'Raiders at the Gate', type: 'Defend',
    objectives: [{ kind: 'survive', waves: 2 }],
    world: { w: 44, h: 44, treeStands: 6, oreVeins: 5, waterScale: 1.0, meadows: 4, goldPiles: 3, ruins: 2 },
    kit: { stock: { timber: 16, stone: 12, bread: 10, coin: 6, weapon: 2 }, serfs: 6, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 3 }],
    enemies: { waves: [{ at: 35, kind: 'bandit', count: 5 }, { at: 105, kind: 'bandit', count: 8 }] },
    timeTarget: 180, hardTimer: 260, reward: 55 },

  { index: 6, name: 'The Boar Hunt', type: 'Hunt',
    objectives: [{ kind: 'slay', unit: 'boar', n: 8 }],
    world: { w: 46, h: 46, treeStands: 8, oreVeins: 5, waterScale: 0.9, meadows: 5, goldPiles: 3, mountains: 2 },
    kit: { stock: { timber: 14, stone: 10, bread: 12, coin: 8, weapon: 2 }, serfs: 2, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 4 }, { kind: 'archer', count: 2 }],
    enemies: { wild: [{ kind: 'boar', count: 10 }, { kind: 'wolf', count: 5 }] },
    timeTarget: 260, hardTimer: 380, reward: 60 },

  { index: 7, name: 'Bandit Country', type: 'Military',
    objectives: [{ kind: 'destroy', n: 2 }],
    world: { w: 48, h: 48, treeStands: 7, oreVeins: 6, waterScale: 1.0, meadows: 4, goldPiles: 4, mountains: 1, ruins: 2 },
    kit: { stock: { timber: 16, stone: 12, bread: 12, coin: 10, weapon: 3 }, serfs: 2, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 4 }, { kind: 'archer', count: 3 }],
    enemies: { wild: [{ kind: 'wolf', count: 4 }], camps: [{ count: 2, guards: 4 }],
      commander: { every: 45, kind: 'bandit', count: 3, from: 'camp' },
      waves: [{ at: 120, kind: 'orc', count: 4 }] },
    timeTarget: 320, hardTimer: 460, reward: 75 },

  { index: 8, name: 'The Fortified Village', type: 'Military',
    objectives: [{ kind: 'destroy', n: 4 }],
    world: { w: 50, h: 50, treeStands: 7, oreVeins: 6, waterScale: 1.05, meadows: 4, goldPiles: 4, ruins: 3 },
    kit: { stock: { timber: 18, stone: 14, bread: 14, coin: 14, weapon: 3, armor: 1 }, serfs: 2, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 5 }, { kind: 'archer', count: 4 }],
    enemies: { keep: { guards: 6 }, towers: 3, commander: { every: 40, kind: 'orc', count: 4, from: 'camp' },
      waves: [{ at: 100, kind: 'troll', count: 3 }] },
    timeTarget: 380, hardTimer: 540, reward: 95 },

  { index: 9, name: 'The Enemy Keep', type: 'Military',
    objectives: [{ kind: 'destroy', n: 5 }],
    world: { w: 52, h: 52, treeStands: 8, oreVeins: 7, waterScale: 1.1, meadows: 4, goldPiles: 5, mountains: 3, ruins: 1 },
    kit: { stock: { timber: 20, stone: 16, bread: 16, coin: 18, weapon: 4, armor: 2 }, serfs: 2, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 6 }, { kind: 'archer', count: 5 }],
    enemies: { keep: { guards: 8 }, towers: 4, commander: { every: 32, kind: 'orc', count: 5, from: 'camp' },
      waves: [{ at: 90, kind: 'troll', count: 3 }, { at: 200, kind: 'demon', count: 1 }] },
    timeTarget: 440, hardTimer: 640, reward: 120 },

  { index: 10, name: 'Dragon\u2019s Hoard', type: 'Boss',
    objectives: [{ kind: 'slay', unit: 'dragon', n: 1 }],
    world: { w: 52, h: 52, treeStands: 8, oreVeins: 8, waterScale: 1.1, meadows: 4, goldPiles: 6, mountains: 4 },
    kit: { stock: { timber: 20, stone: 16, bread: 18, coin: 24, weapon: 4, armor: 2 }, serfs: 2, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 8 }, { kind: 'archer', count: 6 }],
    enemies: { boss: 'dragon', waves: [{ at: 60, kind: 'boar', count: 6 }, { at: 150, kind: 'orc', count: 5 }, { at: 240, kind: 'troll', count: 2 }] },
    timeTarget: 480, hardTimer: 700, reward: 160 },
];

/** The level for a run index (clamped so runs never fall off the end of the table). */
export function levelFor(index: number): LevelDef {
  return LEVELS[Math.min(LEVELS.length, Math.max(1, index)) - 1];
}

/**
 * A no-objective free-build map (menu → Sandbox). Big, resource-rich and
 * timer-free so you can raise as much as you like — the eventual test bed for
 * massive armies and combat juice. The objective is disabled by main, so the
 * placeholder entry here is never evaluated.
 */
export function sandboxLevel(): LevelDef {
  return {
    index: 0, name: 'Sandbox', type: 'Sandbox',
    objectives: [{ kind: 'produce', item: 'coin', n: 1 }],
    world: { w: 60, h: 60, treeStands: 14, oreVeins: 18, waterScale: 0.4, meadows: 7, goldPiles: 10 },
    kit: { stock: { timber: 240, stone: 240, bread: 120, coin: 60, iron: 40, weapon: 30, armor: 15 }, serfs: 8, laborers: 3 },
    timeTarget: Infinity, hardTimer: Infinity, reward: 0,
  };
}
