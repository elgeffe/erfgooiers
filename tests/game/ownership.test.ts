import { describe, expect, it } from 'vitest';
import { alliedPlayers, canControl, factionForOwner, isPlayerId, ownerForFaction, ownersHostile } from '../../src/game/ownership';

describe('co-op ownership', () => {
  it('keeps player identity separate from diplomatic faction', () => {
    expect(isPlayerId('p1')).toBe(true);
    expect(isPlayerId('p2')).toBe(true);
    expect(isPlayerId('enemy')).toBe(false);
    expect(factionForOwner('p1')).toBe('player');
    expect(factionForOwner('p2')).toBe('player');
    expect(ownerForFaction('player')).toBe('p1');
    expect(ownerForFaction('player', 'p2')).toBe('p2');
  });

  it('treats the two player economies as allied but independently controlled', () => {
    expect(alliedPlayers('p1', 'p2')).toBe(true);
    expect(ownersHostile('p1', 'p2')).toBe(false);
    expect(canControl('p1', 'p1')).toBe(true);
    expect(canControl('p1', 'p2')).toBe(false);
  });

  it('preserves the existing PvE hostility rules', () => {
    expect(ownersHostile('p1', 'enemy')).toBe(true);
    expect(ownersHostile('p2', 'wild')).toBe(true);
    expect(ownersHostile('enemy', 'wild')).toBe(false);
    expect(ownersHostile('enemy', 'p2')).toBe(true);
  });
});
