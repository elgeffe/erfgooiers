import type { WorldParams } from '../world/World';
import type { StartKit } from '../game/Game';
import type { ObjectiveDef } from '../game/Objectives';

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
}

export const LEVELS: LevelDef[] = [
  { index: 1, name: 'First Frost', type: 'Economy',
    objectives: [{ kind: 'stock', reqs: [{ item: 'timber', n: 8 }, { item: 'stone', n: 4 }] }],
    world: { w: 34, h: 34, treeStands: 5, oreVeins: 4, waterScale: 0.7, meadows: 2, goldPiles: 2 },
    kit: { stock: { timber: 6, stone: 4, bread: 6 }, serfs: 6, laborers: 2 },
    timeTarget: 180, hardTimer: 260, reward: 25 },

  { index: 2, name: 'Daily Bread', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'bread', n: 6 },
      { kind: 'produce', item: 'timber', n: 10 },
    ],
    world: { w: 38, h: 38, treeStands: 6, oreVeins: 4, goldPiles: 2 },
    kit: { stock: { timber: 8, stone: 5, bread: 6 }, serfs: 6, laborers: 2 },
    timeTarget: 240, hardTimer: 340, reward: 30 },

  { index: 3, name: 'A Glint in the Grass', type: 'Collection',
    objectives: [{ kind: 'collect', n: 5 }],
    world: { w: 42, h: 42, treeStands: 6, oreVeins: 4, goldPiles: 8 },
    kit: { stock: { timber: 8, stone: 5, bread: 8 }, serfs: 7, laborers: 2 },
    timeTarget: 240, hardTimer: 340, reward: 35 },

  { index: 4, name: 'The Mint', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'coin', n: 5 },
      { kind: 'produce', item: 'flour', n: 12 },
    ],
    world: { w: 44, h: 44, treeStands: 6, oreVeins: 6, goldPiles: 3 },
    kit: { stock: { timber: 10, stone: 8, bread: 8 }, serfs: 7, laborers: 2 },
    timeTarget: 360, hardTimer: 500, reward: 45 },

  { index: 5, name: 'Hard Winter', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'bread', n: 8 }],
    world: { w: 46, h: 46, treeStands: 6, oreVeins: 5, goldPiles: 3 },
    kit: { stock: { timber: 12, stone: 8, bread: 8 }, serfs: 7, laborers: 3 },
    timeTarget: 300, hardTimer: 430, reward: 50 },

  { index: 6, name: 'The Coin Run', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'coin', n: 6 }],
    world: { w: 48, h: 48, treeStands: 6, oreVeins: 7, goldPiles: 4 },
    kit: { stock: { timber: 12, stone: 10, bread: 10 }, serfs: 8, laborers: 3 },
    timeTarget: 360, hardTimer: 520, reward: 60 },

  { index: 7, name: 'The Caravan', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'bread', n: 18 }],
    world: { w: 50, h: 50, treeStands: 7, oreVeins: 6, goldPiles: 4 },
    kit: { stock: { timber: 14, stone: 10, bread: 12 }, serfs: 8, laborers: 3 },
    timeTarget: 420, hardTimer: 600, reward: 70 },

  { index: 8, name: 'Fortune\u2019s Vein', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'coin', n: 8 }],
    world: { w: 50, h: 50, treeStands: 7, oreVeins: 8, goldPiles: 4 },
    kit: { stock: { timber: 14, stone: 12, bread: 12 }, serfs: 9, laborers: 3 },
    timeTarget: 420, hardTimer: 620, reward: 85 },

  { index: 9, name: 'The Great Works', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'timber', n: 25 }],
    world: { w: 54, h: 54, treeStands: 8, oreVeins: 7, goldPiles: 5 },
    kit: { stock: { timber: 14, stone: 12, bread: 14 }, serfs: 9, laborers: 4 },
    timeTarget: 480, hardTimer: 700, reward: 100 },

  { index: 10, name: 'Dragon\u2019s Hoard', type: 'Boss',
    objectives: [{ kind: 'produce', item: 'coin', n: 12 }],
    world: { w: 54, h: 54, treeStands: 8, oreVeins: 9, goldPiles: 6 },
    kit: { stock: { timber: 16, stone: 14, bread: 16 }, serfs: 10, laborers: 4 },
    timeTarget: 540, hardTimer: 800, reward: 140 },
];

/** The level for a run index (clamped so runs never fall off the end of the table). */
export function levelFor(index: number): LevelDef {
  return LEVELS[Math.min(LEVELS.length, Math.max(1, index)) - 1];
}

/** Deterministically pick one objective variant for this level from a 0..1 roll. */
export function pickObjective(level: LevelDef, roll: number): ObjectiveDef {
  return level.objectives[Math.floor(roll * level.objectives.length) % level.objectives.length];
}
