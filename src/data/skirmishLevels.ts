import type { LevelDef } from './levels';

/**
 * The 1v1 Skirmish beta: one large symmetric map, no PvE. The two players
 * spawn in OPPOSITE corners (Game.initCoOp's 'diagonal' layout) — far enough
 * apart that each has room to build a real settlement and an early rush is a
 * long march, not a doorstep raid. Identical kits and warbands; the first
 * storehouse to fall ends the match. `enemies` is deliberately absent so the
 * EncounterDirector spawns nothing — the only threat is the other player.
 * Resource clusters scale with the wider map so both corners are provisioned.
 * All numbers are playtest targets.
 */
export const SKIRMISH_LEVEL: LevelDef = {
  index: 1, name: 'Border Clash', type: 'Skirmish',
  objectives: [{ kind: 'skirmish' }],
  world: { w: 100, h: 88, treeStands: 24, oreVeins: 20, waterScale: 0.9, meadows: 12, goldPiles: 12, arena: true },
  kit: { stock: { timber: 16, stone: 12, bread: 10, coin: 8 }, serfs: 3, laborers: 1 },
  startArmy: [{ kind: 'soldier', count: 4 }, { kind: 'archer', count: 2 }],
  // no hard clock pressure: an hour before a stalemate is called a draw
  timeTarget: 1800, hardTimer: 3600, reward: 0,
};
