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
