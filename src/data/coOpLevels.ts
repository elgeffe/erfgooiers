import type { LevelDef } from './levels';
import type { UnitKind } from './units';
import type { ModifierSpec } from '../game/Modifiers';
import type { ExpeditionDifficulty } from '../net/protocol';

/**
 * The co-op Expedition: four large levels sized for two allied settlements
 * and roughly 60–90 minutes of a successful run. Objectives are team-wide
 * event counters (production, waves, strongholds, the boss) so both players'
 * contributions aggregate; per-player `stock` goals are deliberately avoided
 * because each economy is private. All numbers are playtest targets.
 */
const HOSTILE_KINDS: readonly UnitKind[] = ['bandit', 'orc', 'troll', 'boar', 'wolf', 'demon', 'dragon'];

export interface ExpeditionDifficultyDef {
  id: ExpeditionDifficulty;
  name: string;
  desc: string;
  /** Multiplier on every level's hard timer (coordination pressure, not HP). */
  timerMult: number;
  /** Extra rule tweaks routed through Modifiers, mostly enemy composition aids. */
  specs: ModifierSpec[];
}

export const EXPEDITION_DIFFICULTY: Record<ExpeditionDifficulty, ExpeditionDifficultyDef> = {
  journey: {
    id: 'journey', name: 'Journey',
    desc: 'A forgiving first Expedition — longer clocks, standard foes.',
    timerMult: 1.2,
    specs: [],
  },
  erfgooiers: {
    id: 'erfgooiers', name: 'Erfgooiers',
    desc: 'The intended pace: tight deadlines for two coordinated economies.',
    timerMult: 1,
    specs: [],
  },
  veldheer: {
    id: 'veldheer', name: 'Veldheer',
    desc: 'Short clocks and hardened foes — plan routes and trade or fall.',
    timerMult: 0.85,
    specs: [
      ...HOSTILE_KINDS.map(kind => ({ stat: 'combat:hp', mult: 1.2, filter: kind })),
      ...HOSTILE_KINDS.map(kind => ({ stat: 'combat:damage', mult: 1.1, filter: kind })),
      { stat: 'buildingHp', mult: 1.25, filter: 'enemy' },
    ],
  },
};

/**
 * Levels use the singleplayer LevelDef shape so world generation, kits,
 * timers and the enemy director stay data-driven. Maps run wider than solo
 * levels because they hold two settlements; both players spawn on the same
 * east–west axis (Game.initCoOp).
 */
export const EXPEDITION_LEVELS: LevelDef[] = [
  // Two supply hubs from nothing while probing raids test both approaches.
  { index: 1, name: 'Foothold', type: 'Expedition',
    objectives: [{ kind: 'produceMulti', reqs: [{ item: 'timber', n: 24 }, { item: 'bread', n: 16 }] }],
    world: { w: 72, h: 56, treeStands: 12, oreVeins: 9, waterScale: 0.9, meadows: 6, goldPiles: 6 },
    kit: { stock: { timber: 14, stone: 10, bread: 8, coin: 5 }, serfs: 3, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 6 }, { kind: 'archer', count: 3 }],
    enemies: { wild: [{ kind: 'wolf', count: 6 }], waves: [
      { at: 360, kind: 'bandit', count: 5 },
      { at: 640, kind: 'bandit', count: 8, bonusTime: 90 },
    ] },
    timeTarget: 700, hardTimer: 1000, reward: 60 },

  // Distant resource regions: two full chains at once, under commander raids.
  { index: 2, name: 'The Network', type: 'Expedition',
    objectives: [{ kind: 'produceMulti', reqs: [{ item: 'coin', n: 12 }, { item: 'sausage', n: 10 }, { item: 'wine', n: 8 }] }],
    world: { w: 80, h: 60, treeStands: 12, oreVeins: 11, waterScale: 1.0, meadows: 7, goldPiles: 7, mountains: 2, ruins: 2 },
    kit: { stock: { timber: 18, stone: 14, bread: 10, coin: 8 }, serfs: 3, laborers: 2 },
    startArmy: [{ kind: 'soldier', count: 8 }, { kind: 'archer', count: 4 }, { kind: 'knight', count: 1 }],
    enemies: { wild: [{ kind: 'boar', count: 6 }], camps: [{ count: 2, guards: 4 }],
      commander: { every: 110, kind: 'bandit', count: 4, from: 'camp' },
      waves: [{ at: 700, kind: 'orc', count: 5, bonusTime: 120 }] },
    timeTarget: 900, hardTimer: 1300, reward: 85 },

  // Hold both settlements while razing the enemy's forward infrastructure.
  { index: 3, name: 'The Warfront', type: 'Expedition',
    objectives: [{ kind: 'destroy', n: 4 }],
    world: { w: 84, h: 64, treeStands: 13, oreVeins: 11, waterScale: 1.0, meadows: 6, goldPiles: 7, mountains: 2, ruins: 3, frontier: true },
    kit: { stock: { timber: 20, stone: 16, bread: 12, coin: 12, weapon: 3 }, serfs: 3, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 10 }, { kind: 'archer', count: 6 }, { kind: 'knight', count: 2 }],
    enemies: { camps: [{ count: 2, guards: 5 }], keep: { guards: 6 }, towers: 3,
      commander: { every: 80, kind: 'orc', count: 4, from: 'camp' },
      waves: [{ at: 520, kind: 'orc', count: 5 }, { at: 900, kind: 'troll', count: 3, bonusTime: 150 }] },
    timeTarget: 1100, hardTimer: 1500, reward: 110 },

  // The finale: a walled quarter, a brooding demon, pressure on two fronts.
  { index: 4, name: 'The Expedition Finale', type: 'Expedition',
    objectives: [{ kind: 'slay', unit: 'demon', n: 1 }],
    world: { w: 88, h: 68, treeStands: 14, oreVeins: 12, waterScale: 1.05, meadows: 7, goldPiles: 8, mountains: 3, ruins: 2, frontier: true },
    kit: { stock: { timber: 22, stone: 18, bread: 14, coin: 16, weapon: 4, armor: 2 }, serfs: 3, laborers: 3 },
    startArmy: [{ kind: 'soldier', count: 12 }, { kind: 'archer', count: 8 }, { kind: 'knight', count: 3 }],
    enemies: { keep: { guards: 8 }, towers: 4, boss: 'demon',
      commander: { every: 70, kind: 'orc', count: 5, from: 'camp' },
      waves: [{ at: 600, kind: 'troll', count: 3 }, { at: 1000, kind: 'orc', count: 6, bonusTime: 180 }] },
    timeTarget: 1300, hardTimer: 1800, reward: 150 },
];

export const EXPEDITION_LEVEL_COUNT = EXPEDITION_LEVELS.length;

/** The Expedition level for a 1-based index (clamped like the solo table). */
export function expeditionLevelFor(index: number): LevelDef {
  return EXPEDITION_LEVELS[Math.min(EXPEDITION_LEVELS.length, Math.max(1, index)) - 1];
}
