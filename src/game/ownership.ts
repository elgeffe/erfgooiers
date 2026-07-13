import { PLAYER_IDS, type Faction, type OwnerId, type PlayerId } from '../types';

export const LOCAL_PLAYER_ID: PlayerId = 'p1';

export function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === 'string' && (PLAYER_IDS as readonly string[]).includes(value);
}

export function factionForOwner(owner: OwnerId): Faction {
  return isPlayerId(owner) ? 'player' : owner;
}

export function ownerForFaction(faction: Faction, player: PlayerId = LOCAL_PLAYER_ID): OwnerId {
  return faction === 'player' ? player : faction;
}

/** Two distinct player owners are allied; all existing PvE relationships stay intact. */
export function ownersHostile(a: OwnerId, b: OwnerId): boolean {
  const af = factionForOwner(a);
  const bf = factionForOwner(b);
  return af === 'player' ? bf !== 'player' : bf === 'player';
}

export function canControl(actor: PlayerId, owner: OwnerId): boolean {
  return actor === owner;
}

export function alliedPlayers(a: OwnerId, b: OwnerId): boolean {
  return isPlayerId(a) && isPlayerId(b);
}
