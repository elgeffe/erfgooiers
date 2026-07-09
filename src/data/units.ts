import { BASE_SPEED } from '../constants';
import type { Faction } from '../types';

/** Combat unit archetypes. Economy workers (serf/laborer/specialists) are not here. */
export type UnitKind = 'soldier' | 'archer' | 'knight' | 'bandit' | 'boar' | 'dragon'
  | 'wolf' | 'orc' | 'troll' | 'demon';

/** How a combat unit is drawn — humanoid reuses the worker model; beasts differ. */
export type FighterModel = 'human' | 'beast' | 'dragon' | 'wolf' | 'demon';

export interface UnitDef {
  kind: UnitKind;
  name: string;
  faction: Faction;
  color: number;
  model: FighterModel;
  hp: number;
  dmg: number;          // damage per hit
  range: number;        // attack reach in tiles (>1.6 = ranged, fires arrows)
  atkCd: number;        // seconds between attacks
  speed: number;        // tiles/s base walk speed
  scale: number;        // mesh scale
  aggro: number;        // tiles at which it notices & engages hostiles
  arrows?: boolean;     // attacks by loosing arrows instead of striking (archer)
  wander?: boolean;     // ambles around its anchor when idle (beasts, camp guards)
  leash?: number;       // wild only: max chase distance from anchor before giving up
  charge?: number;      // speed multiplier while chasing a foe (boar rush, wolf pounce)
  flying?: boolean;     // moves in straight lines over any terrain (the dragon)
  fire?: boolean;       // periodically hurls a fiery volley (dragon breath, demon magic)
}

export const UNITS: Record<UnitKind, UnitDef> = {
  soldier: { kind: 'soldier', name: 'Soldier', faction: 'player', color: 0x3f5aa0, model: 'human',
    hp: 60, dmg: 8, range: 1.3, atkCd: 1.0, speed: BASE_SPEED, scale: 1, aggro: 9 },

  archer: { kind: 'archer', name: 'Archer', faction: 'player', color: 0x3f8a55, model: 'human',
    hp: 40, dmg: 6, range: 5.0, atkCd: 1.4, speed: BASE_SPEED, scale: 0.95, aggro: 10, arrows: true },

  knight: { kind: 'knight', name: 'Knight', faction: 'player', color: 0x8f97a6, model: 'human',
    hp: 120, dmg: 13, range: 1.4, atkCd: 1.1, speed: BASE_SPEED * 0.95, scale: 1.08, aggro: 9 },

  bandit: { kind: 'bandit', name: 'Bandit', faction: 'enemy', color: 0x9c3b3b, model: 'human',
    hp: 50, dmg: 7, range: 1.3, atkCd: 1.1, speed: BASE_SPEED, scale: 1, aggro: 11, wander: true },

  boar: { kind: 'boar', name: 'Wild Boar', faction: 'wild', color: 0x6b4a34, model: 'beast',
    hp: 70, dmg: 10, range: 1.0, atkCd: 1.2, speed: BASE_SPEED * 1.1, scale: 1, aggro: 6,
    wander: true, leash: 14, charge: 1.5 },

  dragon: { kind: 'dragon', name: 'Dragon of Het Gooi', faction: 'wild', color: 0x7a2233, model: 'dragon',
    hp: 800, dmg: 40, range: 2.5, atkCd: 2.0, speed: BASE_SPEED * 0.8, scale: 2.4, aggro: 14, flying: true, fire: true },

  wolf: { kind: 'wolf', name: 'Wolf', faction: 'wild', color: 0x777d84, model: 'wolf',
    hp: 40, dmg: 7, range: 1.0, atkCd: 0.9, speed: BASE_SPEED * 1.25, scale: 0.95, aggro: 8,
    wander: true, leash: 16, charge: 1.6 },

  orc: { kind: 'orc', name: 'Orc', faction: 'enemy', color: 0x4a5a30, model: 'human',
    hp: 85, dmg: 11, range: 1.3, atkCd: 1.2, speed: BASE_SPEED * 0.95, scale: 1.1, aggro: 11, wander: true },

  troll: { kind: 'troll', name: 'Troll', faction: 'enemy', color: 0x5d7263, model: 'human',
    hp: 120, dmg: 9, range: 5.5, atkCd: 1.9, speed: BASE_SPEED * 0.8, scale: 1.3, aggro: 12,
    arrows: true, wander: true },

  demon: { kind: 'demon', name: 'Demon', faction: 'enemy', color: 0x3a1626, model: 'demon',
    hp: 500, dmg: 26, range: 2.2, atkCd: 1.6, speed: BASE_SPEED * 0.9, scale: 1.8, aggro: 13,
    flying: true, fire: true },
};
