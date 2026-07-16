import type { LevelDef } from './levels';

/**
 * The 1v1 Skirmish beta: one symmetric map, no PvE. Both players spawn on the
 * same east–west axis (Game.initCoOp) with identical kits and warbands; the
 * first storehouse to fall ends the match. `enemies` is deliberately absent so
 * the EncounterDirector spawns nothing — the only threat is the other player.
 * All numbers are playtest targets.
 */
export const SKIRMISH_LEVEL: LevelDef = {
  index: 1, name: 'Border Clash', type: 'Skirmish',
  objectives: [{ kind: 'skirmish' }],
  world: { w: 72, h: 56, treeStands: 12, oreVeins: 10, waterScale: 0.9, meadows: 6, goldPiles: 6 },
  kit: { stock: { timber: 16, stone: 12, bread: 10, coin: 8 }, serfs: 3, laborers: 1 },
  startArmy: [{ kind: 'soldier', count: 4 }, { kind: 'archer', count: 2 }],
  // no hard clock pressure: an hour before a stalemate is called a draw
  timeTarget: 1800, hardTimer: 3600, reward: 0,
};
