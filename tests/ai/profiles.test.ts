import { describe, expect, it } from 'vitest';
import { AI_PROFILES } from '../../src/data/aiProfiles';

describe('Classic AI fortification profiles', () => {
  it('use only perimeter towers, wooden on Hard and stone on Godlike', () => {
    expect(AI_PROFILES['classic-hard']).toMatchObject({ towers: 4, towerKey: 'watchtower', forwardTowers: 0 });
    expect(AI_PROFILES['classic-godlike']).toMatchObject({ towers: 4, towerKey: 'stonetower', forwardTowers: 2 });
    for (const profile of Object.values(AI_PROFILES).filter(profile => profile.policy === 'classic')) {
      expect(profile).not.toHaveProperty('walls');
      expect(profile).not.toHaveProperty('wallMaterial');
    }
  });
});
