import type { BiomeKey } from './biomes';
import type { LevelDef } from './levels';

/**
 * The 1v1 Skirmish beta: one symmetric arena, no PvE. The two players spawn in
 * OPPOSITE corners (Game.initCoOp's 'diagonal' layout) — far enough apart that
 * each has room to build a real settlement and an early rush is a long march,
 * not a doorstep raid. Identical kits and warbands; the first storehouse to
 * fall ends the match. `enemies` is deliberately absent so the EncounterDirector
 * spawns nothing — the only threat is the other player. Resource clusters scale
 * with the map so both corners are provisioned.
 */

/** Player-tunable arena options, shared with the sandbox's world knobs so the
 *  two setup screens reuse the same controls. */
export interface SkirmishConfig {
  size: 'small' | 'medium' | 'large' | 'huge';
  biome: BiomeKey;
  mapRes: 'sparse' | 'normal' | 'rich';
  fog: boolean;
}

export const DEFAULT_SKIRMISH: SkirmishConfig = { size: 'large', biome: 'gooi', mapRes: 'normal', fog: true };

/** Arena edge (width; height keeps the ~1.14 landscape ratio of the original). */
const SKIRMISH_SIZE: Record<SkirmishConfig['size'], number> = { small: 72, medium: 88, large: 100, huge: 124 };
const SKIRMISH_DENSITY: Record<SkirmishConfig['mapRes'], number> = { sparse: 0.7, normal: 1, rich: 1.4 };

/** Build a skirmish arena LevelDef from the setup screen's choices. The
 *  fixed default (Gooi · large · normal) is `SKIRMISH_LEVEL`, used by
 *  self-play, the campaign runner and the tests. */
export function skirmishLevel(cfg: SkirmishConfig = DEFAULT_SKIRMISH): LevelDef {
  const w = SKIRMISH_SIZE[cfg.size];
  const h = Math.round(w * 0.88);
  const scale = (w * h) / (100 * 88);
  const den = SKIRMISH_DENSITY[cfg.mapRes];
  return {
    index: 1, name: 'Border Clash', type: 'Skirmish',
    objectives: [{ kind: 'skirmish' }],
    world: {
      w, h, biome: cfg.biome, arena: true,
      treeStands: Math.round(24 * scale * den),
      oreVeins: Math.round(20 * scale * den),
      waterScale: 0.9,
      meadows: Math.round(12 * scale),
      goldPiles: Math.round(12 * scale * den),
    },
    kit: { stock: { timber: 16, stone: 12, bread: 10, coin: 8 }, serfs: 3, laborers: 1 },
    startArmy: [{ kind: 'soldier', count: 4 }, { kind: 'archer', count: 2 }],
    // no hard clock pressure: an hour before a stalemate is called a draw
    timeTarget: 1800, hardTimer: 3600, reward: 0,
  };
}

export const SKIRMISH_LEVEL: LevelDef = skirmishLevel();
