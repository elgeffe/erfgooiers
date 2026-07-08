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
  // Phase 1 economy arc. Each level asks for a deeper production chain than the
  // last, in larger quantities, on a map with progressively more water — so the
  // buildable land shrinks exactly as the objective demands more of it.
  { index: 1, name: 'First Coin', type: 'Economy',
    objectives: [{ kind: 'produce', item: 'coin', n: 3 }],
    world: { w: 36, h: 36, treeStands: 5, oreVeins: 6, waterScale: 0.5, meadows: 2, goldPiles: 2 },
    kit: { stock: { timber: 12, stone: 10, bread: 8 }, serfs: 6, laborers: 2 },
    timeTarget: 220, hardTimer: 320, reward: 25 },

  { index: 2, name: 'Daily Bread', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'bread', n: 8 },
      { kind: 'produce', item: 'timber', n: 12 },
    ],
    world: { w: 38, h: 38, treeStands: 6, oreVeins: 5, waterScale: 0.6, meadows: 3, goldPiles: 2 },
    kit: { stock: { timber: 10, stone: 10, bread: 6 }, serfs: 6, laborers: 2 },
    timeTarget: 240, hardTimer: 340, reward: 30 },

  { index: 3, name: 'The Vintner\u2019s Gamble', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'wine', n: 8 },
      { kind: 'produce', item: 'bread', n: 10 },
    ],
    world: { w: 40, h: 40, treeStands: 6, oreVeins: 5, waterScale: 0.7, meadows: 3, goldPiles: 3 },
    kit: { stock: { timber: 10, stone: 10, bread: 8 }, serfs: 7, laborers: 2 },
    timeTarget: 260, hardTimer: 370, reward: 35 },

  { index: 4, name: 'The Coin Run', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'coin', n: 6 },
      { kind: 'produce', item: 'wine', n: 10 },
    ],
    world: { w: 42, h: 42, treeStands: 6, oreVeins: 7, waterScale: 0.85, meadows: 3, goldPiles: 3 },
    kit: { stock: { timber: 12, stone: 10, bread: 8 }, serfs: 7, laborers: 3 },
    timeTarget: 300, hardTimer: 430, reward: 45 },

  { index: 5, name: 'Smoke & Salt', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'sausage', n: 8 },
      { kind: 'produce', item: 'bread', n: 14 },
    ],
    world: { w: 44, h: 44, treeStands: 6, oreVeins: 5, waterScale: 1.0, meadows: 4, goldPiles: 3 },
    kit: { stock: { timber: 12, stone: 10, bread: 10 }, serfs: 8, laborers: 3 },
    timeTarget: 340, hardTimer: 480, reward: 55 },

  { index: 6, name: 'Market Day', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'bread', n: 12 },
      { kind: 'produce', item: 'wine', n: 12 },
      { kind: 'produce', item: 'sausage', n: 10 },
    ],
    world: { w: 46, h: 46, treeStands: 6, oreVeins: 6, waterScale: 1.1, meadows: 4, goldPiles: 4 },
    kit: { stock: { timber: 12, stone: 10, bread: 10 }, serfs: 8, laborers: 3 },
    timeTarget: 340, hardTimer: 480, reward: 65 },

  { index: 7, name: 'Fortune\u2019s Vein', type: 'Economy',
    objectives: [
      { kind: 'produce', item: 'coin', n: 10 },
      { kind: 'produce', item: 'sausage', n: 12 },
    ],
    world: { w: 48, h: 48, treeStands: 7, oreVeins: 8, waterScale: 1.25, meadows: 4, goldPiles: 4 },
    kit: { stock: { timber: 14, stone: 12, bread: 12 }, serfs: 9, laborers: 3 },
    timeTarget: 380, hardTimer: 540, reward: 75 },

  { index: 8, name: 'The Feast', type: 'Economy',
    objectives: [{ kind: 'produceMulti', reqs: [{ item: 'bread', n: 10 }, { item: 'wine', n: 8 }] }],
    world: { w: 50, h: 50, treeStands: 7, oreVeins: 6, waterScale: 1.4, meadows: 4, goldPiles: 4 },
    kit: { stock: { timber: 14, stone: 12, bread: 12 }, serfs: 9, laborers: 4 },
    timeTarget: 420, hardTimer: 600, reward: 90 },

  { index: 9, name: 'The King\u2019s Order', type: 'Economy',
    objectives: [{ kind: 'produceMulti', reqs: [{ item: 'coin', n: 8 }, { item: 'sausage', n: 10 }] }],
    world: { w: 52, h: 52, treeStands: 8, oreVeins: 8, waterScale: 1.5, meadows: 4, goldPiles: 5 },
    kit: { stock: { timber: 16, stone: 12, bread: 14 }, serfs: 10, laborers: 4 },
    timeTarget: 460, hardTimer: 660, reward: 110 },

  { index: 10, name: 'Dragon\u2019s Hoard', type: 'Boss',
    objectives: [{ kind: 'produceMulti', reqs: [{ item: 'coin', n: 10 }, { item: 'sausage', n: 10 }, { item: 'wine', n: 10 }] }],
    world: { w: 52, h: 52, treeStands: 8, oreVeins: 9, waterScale: 1.6, meadows: 4, goldPiles: 6 },
    kit: { stock: { timber: 16, stone: 14, bread: 16 }, serfs: 10, laborers: 4 },
    timeTarget: 520, hardTimer: 740, reward: 150 },
];

/** The level for a run index (clamped so runs never fall off the end of the table). */
export function levelFor(index: number): LevelDef {
  return LEVELS[Math.min(LEVELS.length, Math.max(1, index)) - 1];
}

/** Deterministically pick one objective variant for this level from a 0..1 roll. */
export function pickObjective(level: LevelDef, roll: number): ObjectiveDef {
  return level.objectives[Math.floor(roll * level.objectives.length) % level.objectives.length];
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
    kit: { stock: { timber: 240, stone: 240, bread: 120 }, serfs: 12, laborers: 6 },
    timeTarget: Infinity, hardTimer: Infinity, reward: 0,
  };
}
