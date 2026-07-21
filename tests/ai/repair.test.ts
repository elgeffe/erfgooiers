import { describe, expect, it } from 'vitest';
import { AIController } from '../../src/ai/AIController';
import { AI_PROFILES } from '../../src/data/aiProfiles';
import { makeSkirmishGame } from '../../src/game/testHarness';
import { TICK_SECONDS } from '../../src/game/replay';

const classicHard = () =>
  Object.values(AI_PROFILES).find(p => p.policy === 'classic' && p.difficulty === 'hard')!;

describe('scripted AI orders repairs', () => {
  it('opens a repair order on its badly damaged castle, with priority', () => {
    const { game, world } = makeSkirmishGame(9);
    const castle = game.storeFor('p2');
    const barracksProxy = game.buildings.find(b => b.owner === 'p2' && b !== castle);
    castle.hp = Math.round(castle.maxHp * 0.5);
    // a lesser building is battered even harder — the castle must still win
    if (barracksProxy) barracksProxy.hp = Math.round(barracksProxy.maxHp * 0.2);

    const controller = new AIController({
      game, world, playerId: 'p2', profile: classicHard(), seed: 1234,
    });
    for (let tick = 0; tick < 20 * 30 && !castle.repair; tick++) {
      controller.tick(TICK_SECONDS);
      game.update(TICK_SECONDS);
    }
    expect(castle.repair).toBeTruthy();
  });

  it('leaves lightly scuffed non-castle buildings alone', () => {
    const { game, world } = makeSkirmishGame(9);
    const building = game.buildings.find(b => b.owner === 'p2' && !b.def.store)!;
    building.hp = Math.round(building.maxHp * 0.8); // above the 50% crew bar
    const controller = new AIController({
      game, world, playerId: 'p2', profile: classicHard(), seed: 99,
    });
    for (let tick = 0; tick < 20 * 20; tick++) {
      controller.tick(TICK_SECONDS);
      game.update(TICK_SECONDS);
    }
    expect(building.repair).toBeUndefined();
  });
});
