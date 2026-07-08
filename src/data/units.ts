import { BASE_SPEED } from '../constants';
import type { Faction } from '../types';

/** Combat unit archetypes. Economy workers (serf/laborer/specialists) are not here. */
export type UnitKind = 'soldier' | 'archer' | 'bandit' | 'boar' | 'dragon';

/** How a combat unit is drawn — humanoid reuses the worker model; beasts differ. */
export type FighterModel = 'human' | 'beast' | 'dragon';

export interface UnitDef {
  kind: UnitKind;
  name: string;
  faction: Faction;
  color: number;
  model: FighterModel;
  hp: number;
  dmg: number;          // damage per hit
  range: number;        // attack reach in tiles (>1 = ranged)
  atkCd: number;        // seconds between attacks
  speed: number;        // tiles/s base walk speed
  scale: number;        // mesh scale
}

export const UNITS: Record<UnitKind, UnitDef> = {
  soldier: { kind: 'soldier', name: 'Soldier', faction: 'player', color: 0x3f5aa0, model: 'human',
    hp: 60, dmg: 8, range: 1.3, atkCd: 1.0, speed: BASE_SPEED, scale: 1 },

  archer: { kind: 'archer', name: 'Archer', faction: 'player', color: 0x3f8a55, model: 'human',
    hp: 40, dmg: 6, range: 5.0, atkCd: 1.4, speed: BASE_SPEED, scale: 0.95 },

  bandit: { kind: 'bandit', name: 'Bandit', faction: 'enemy', color: 0x9c3b3b, model: 'human',
    hp: 50, dmg: 7, range: 1.3, atkCd: 1.1, speed: BASE_SPEED, scale: 1 },

  boar: { kind: 'boar', name: 'Wild Boar', faction: 'wild', color: 0x6b4a34, model: 'beast',
    hp: 70, dmg: 10, range: 1.0, atkCd: 1.2, speed: BASE_SPEED * 1.25, scale: 1 },

  dragon: { kind: 'dragon', name: 'Dragon of Het Gooi', faction: 'wild', color: 0x7a2233, model: 'dragon',
    hp: 800, dmg: 40, range: 2.5, atkCd: 2.0, speed: BASE_SPEED * 0.7, scale: 2.4 },
};
