import { describe, expect, it } from 'vitest';
import { getCavalryStyle } from '../../src/render/unitModels';

describe('getCavalryStyle', () => {
  it('uses raider-like colors for enemy cavalry', () => {
    const enemy = getCavalryStyle('lancer', 0x4a7ab0, 'enemy');
    expect(enemy.horse).toBe(0x0f0c0b);
    expect(enemy.coat).toBe(0x9c3b3b);
  });

  it('preserves player cavalry colors for player factions', () => {
    const player = getCavalryStyle('horseknight', 0x8f97a6, 'player');
    expect(player.horse).toBe(0x33302c);
    expect(player.coat).toBe(0x8f97a6);
  });
});
