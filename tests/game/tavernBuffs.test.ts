import { describe, expect, it } from 'vitest';
import { makeTestGame, tick } from '../../src/game/testHarness';
import { TAVERN_BUILD_BUFF, TAVERN_GATHER_BUFF, TAVERN_HUNGER_BUFF, TAVERN_SPEED_BUFF } from '../../src/game/Modifiers';

describe('stocked-tavern buffs', () => {
  it('a staffed tavern with specialty foods grants owner-wide bonuses', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    const tavern = game.placeBuilding('tavern', store.x + 6, store.y + 6, true, 0, 'player', 'p1');
    tavern.active = true;
    tavern.inp.fish = 2;
    tavern.inp.sausage = 1;
    tavern.inp.bread = 1;
    tavern.inp.wine = 1;
    tick(game, 3); // let the slow refresh clock run

    const mods = game.modsFor('p1');
    expect(mods.tavernBuffs('p1').gather).toBe(TAVERN_GATHER_BUFF);
    expect(mods.tavernBuffs('p1').build).toBe(TAVERN_BUILD_BUFF);
    expect(mods.tavernBuffs('p1').speed).toBe(TAVERN_SPEED_BUFF);
    expect(mods.tavernBuffs('p1').hunger).toBe(TAVERN_HUNGER_BUFF);
    // per-owner: p2 runs no stocked tavern, so its rates stay neutral
    expect(game.modsFor('p2').tavernBuffs('p2').gather).toBe(1);
    // and the buffed times actually shrink
    expect(mods.buildTime('p1')).toBeLessThan(mods.buildTime('p2'));
  });

  it('bonuses lapse when the larder runs dry', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    const tavern = game.placeBuilding('tavern', store.x + 6, store.y + 6, true, 0, 'player', 'p1');
    tavern.active = true;
    tavern.inp.bread = 1;
    tick(game, 3);
    expect(game.modsFor('p1').tavernBuffs('p1').speed).toBe(TAVERN_SPEED_BUFF);
    tavern.inp.bread = 0;
    tick(game, 3);
    expect(game.modsFor('p1').tavernBuffs('p1').speed).toBe(1);
  });

  it('wine slows hunger depletion for its owner', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    const tavern = game.placeBuilding('tavern', store.x + 6, store.y + 6, true, 0, 'player', 'p1');
    tavern.active = true;
    tavern.inp.wine = 1;
    tick(game, 3);

    expect(game.modsFor('p1').hungerRate('p1')).toBe(TAVERN_HUNGER_BUFF);
    expect(game.modsFor('p2').hungerRate('p2')).toBe(1);
  });
});
