import { describe, expect, it } from 'vitest';
import { BASE_SPEED, BUILD_TIME, CARRY_CAP } from '../constants';
import { Modifiers, hungerFactor } from './Modifiers';
import type { BuildingDef, Unit } from '../types';

const fakeUnit = (role: string, hunger = 50): Unit =>
  ({ role, hunger, spd: BASE_SPEED } as unknown as Unit);

const bakery = {
  name: 'Bakery', desc: '', cost: { timber: 2, stone: 2 }, roof: 0, wall: 0, model: 'cottage',
  recipe: { inp: { flour: 1 }, out: 'bread', time: 5 },
} as BuildingDef;

describe('Modifiers', () => {
  it('multipliers stack multiplicatively', () => {
    const m = new Modifiers([
      { stat: 'buildTime', mult: 0.75 },
      { stat: 'buildTime', mult: 0.75 },
    ]);
    expect(m.buildTime()).toBeCloseTo(BUILD_TIME * 0.5625);
  });

  it('adds stack additively', () => {
    const m = new Modifiers([
      { stat: 'carryCap', add: 1 },
      { stat: 'carryCap', add: 2 },
    ]);
    expect(m.carryCap()).toBe(CARRY_CAP + 3);
  });

  it('accepts live specs and stacks them', () => {
    const m = new Modifiers();
    m.addSpecs([{ stat: 'buildTime', mult: 0.75 }]);
    m.addSpecs([{ stat: 'buildTime', mult: 0.75 }]);
    expect(m.buildTime()).toBeCloseTo(BUILD_TIME * 0.5625);
  });

  it('filters scope an effect to its context', () => {
    const m = new Modifiers([{ stat: 'unitSpeed', mult: 1.2, filter: 'serf' }]);
    expect(m.unitSpeed(fakeUnit('serf'))).toBeCloseTo(BASE_SPEED * 1.2);
    expect(m.unitSpeed(fakeUnit('laborer'))).toBeCloseTo(BASE_SPEED);
  });

  it('unfiltered effects apply to every context', () => {
    const m = new Modifiers([{ stat: 'unitSpeed', mult: 1.12 }]);
    expect(m.unitSpeed(fakeUnit('serf'))).toBeCloseTo(BASE_SPEED * 1.12);
    expect(m.unitSpeed(fakeUnit('miller'))).toBeCloseTo(BASE_SPEED * 1.12);
  });

  it('recipe time scopes by output item', () => {
    const m = new Modifiers([{ stat: 'recipeTime', mult: 0.82, filter: 'bread' }]);
    expect(m.recipeTime(bakery)).toBeCloseTo(5 * 0.82);
  });

  it('building cost reductions never go below zero', () => {
    const m = new Modifiers([{ stat: 'cost:timber', add: -5 }]);
    const cost = m.buildingCost(bakery);
    expect(cost.timber).toBe(0);
    expect(cost.stone).toBe(2);
  });

  it('start stock aggregates the start* stats', () => {
    const m = new Modifiers([
      { stat: 'startBread', add: 4 },
      { stat: 'startTimber', add: 3 },
      { stat: 'startTimber', add: 3 },
    ]);
    expect(m.startStock()).toEqual({ bread: 4, timber: 6 });
  });

  it('freeInputs strips a recipe of its inputs (communal ovens)', () => {
    const m = new Modifiers([{ stat: 'freeInputs', filter: 'bread' }, { stat: 'recipeTime', mult: 2, filter: 'bread' }]);
    expect(m.recipeInputs(bakery)).toEqual({});
    expect(m.recipeTime(bakery)).toBeCloseTo(10);
    const smithy = { ...bakery, recipe: { inp: { iron: 1 }, out: 'weapon', time: 7 } } as BuildingDef;
    expect(m.recipeInputs(smithy)).toEqual({ iron: 1 }); // other recipes untouched
  });

  it('roadCost clamps at zero (corvée roads)', () => {
    const m = new Modifiers([{ stat: 'roadCost', add: -99 }, { stat: 'offRoadSpeed', mult: 0.75 }]);
    expect(m.roadCost()).toBe(0);
    expect(m.offRoadMult()).toBeCloseTo(0.75);
  });

  it('craftPerRoad scales with the live road count, capped at +60%', () => {
    const m = new Modifiers([{ stat: 'craftPerRoad', add: 0.02 }]);
    m.ctx.roadTiles = 10;
    expect(m.recipeTime(bakery)).toBeCloseTo(5 / 1.2);
    m.ctx.roadTiles = 100;                    // cap kicks in
    expect(m.recipeTime(bakery)).toBeCloseTo(5 / 1.6);
  });

  it('objectiveWeight boosts credit for the filtered item only', () => {
    const m = new Modifiers([{ stat: 'objectiveWeight', add: 1, filter: 'wine' }]);
    expect(m.objectiveWeight('wine')).toBe(2);
    expect(m.objectiveWeight('bread')).toBe(1);
  });

  it('unitCost scales training cost and respects flat cost additions', () => {
    const m = new Modifiers([
      { stat: 'trainCost', mult: 2, filter: 'soldier' },
      { stat: 'cost:coin', add: 1, filter: 'soldier' }
    ]);
    const cost = m.unitCost('soldier', { weapon: 1, coin: 2 });
    expect(cost.weapon).toBe(2); // 1 * 2 = 2
    expect(cost.coin).toBe(5);   // 2 * 2 + 1 = 5
  });

  it('keeps unit-role buffs on player units and off enemy units by default', () => {
    const m = new Modifiers([{ stat: 'combat:damage', mult: 2, filter: 'soldier' }]);
    expect(m.combatMult('damage', 'soldier', 'player')).toBe(2);
    expect(m.combatMult('damage', 'soldier', 'enemy')).toBe(1);
    expect(m.unitSpeed({ role: 'serf', spd: BASE_SPEED, faction: 'player' } as Unit)).toBeCloseTo(BASE_SPEED);
    const enemySpeed = m.unitSpeed({ role: 'serf', spd: BASE_SPEED, faction: 'enemy' } as Unit);
    expect(enemySpeed).toBeCloseTo(BASE_SPEED);
  });

  it('an empty modifier set is the identity', () => {
    const m = new Modifiers();
    expect(m.buildTime()).toBe(BUILD_TIME);
    expect(m.goldMult()).toBe(1);
    expect(m.combatMult('damage', 'soldier')).toBe(1);
    expect(m.extraSerfs()).toBe(0);
  });
});

describe('hungerFactor', () => {
  it('rewards fed workers and slows starving ones', () => {
    expect(hungerFactor(80)).toBeGreaterThan(1);
    expect(hungerFactor(50)).toBe(1);
    expect(hungerFactor(10)).toBeLessThan(1);
  });
});
