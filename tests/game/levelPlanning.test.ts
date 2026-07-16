import { describe, expect, it } from 'vitest';
import { levelFor } from '../../src/data/levels';
import { planLevel, planStartArmy } from '../../src/game/levelPlanning';

describe('level planning', () => {
  it('leaves a normal campaign level table untouched', () => {
    const level = levelFor(7);
    const original = structuredClone(level);
    const plan = planLevel(level, 123, 'gooi', 0, false);
    expect(plan.world).toEqual({ seed: 123, ...level.world, biome: 'gooi' });
    expect(plan.enemies).toEqual(level.enemies);
    expect(level).toEqual(original);
  });

  it('scales hunt terrain and packs at ascension without mutating data', () => {
    const level = levelFor(6);
    const original = structuredClone(level.enemies);
    const plan = planLevel(level, 9, 'ardennes', 2, false);
    expect(plan.world).toMatchObject({ w: 66, h: 66, treeStands: 12, meadows: 8, goldPiles: 7 });
    expect(plan.enemies?.wild?.map(w => w.count)).toEqual([18, 18]);
    expect(level.enemies).toEqual(original);
  });

  it('composes scaled level forces before the unchanged hero warband', () => {
    expect(planStartArmy([{ kind: 'soldier', count: 10 }], [{ kind: 'archer', count: 2 }], 2, false))
      .toEqual([{ kind: 'soldier', count: 5 }, { kind: 'archer', count: 2 }]);
  });
});
