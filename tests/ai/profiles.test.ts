import { describe, expect, it } from 'vitest';
import { AI_PROFILES } from '../../src/data/aiProfiles';
import { AI_HERO, HERO_BY_ID, heroSpecsFor } from '../../src/data/heroes';

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

describe('the CPU hero', () => {
  it('is the NEUTRAL hero — a CPU seat must never get a boon or bane', () => {
    const hero = HERO_BY_ID[AI_HERO.id];
    expect(hero, `AI_HERO '${AI_HERO.id}' is not a real hero`).toBeTruthy();
    expect(hero.name).toBe(AI_HERO.name);
    // `apply` carries every rule spec a hero grants. Empty means the seat gains
    // a scout and a duelist and changes no economy or combat rule, which is the
    // only way both sides can field one and the arena stay symmetric.
    expect(hero.apply).toEqual([]);
    expect(hero.heritageCost).toBe(0);
    expect(heroSpecsFor(AI_HERO.id)).toEqual([]);
    // and it must not smuggle in a free warband either
    expect(hero.startArmy ?? []).toEqual([]);
  });
});
