import { describe, expect, it } from 'vitest';
import { DEFS } from '../../src/data/buildings';
import type { BuildingKey } from '../../src/types';
import {
  COMMON_OPENING,
  nextArmsLineBuild,
  nextCoinLineBuild,
  nextOpeningDecision,
  nextTimberLineBuild,
  plannedBuildingCounts,
  type BuildingCounts,
} from '../../src/ai/strategy/classicPlan';

const counts = (values: Partial<Record<BuildingKey, number>> = {}): BuildingCounts => values;

describe('Classic common opening', () => {
  it('pins the shared supplier-first sequence and cumulative repeated targets', () => {
    expect(COMMON_OPENING.map(step => `${step.key}:${step.target}`)).toEqual([
      'woodcutter:1', 'sawmill:1', 'quarry:1',
      'goldmine:1', 'coalmine:1', 'mint:1', 'forester:1',
      'farm:1', 'mill:1', 'bakery:1', 'tavern:1',
      'barracks:1', 'watchtower:1',
      'ironmine:1', 'coalmine:2', 'smithy:1', 'armory:1',
      'fishery:1', 'vineyard:1', 'winery:1', 'pigfarm:1', 'butcher:1',
      'goldmine:2', 'coalmine:3', 'mint:2', 'quarry:2',
    ]);
  });

  it('builds the first missing stage, waits for its site, and never leapfrogs it', () => {
    expect(nextOpeningDecision(counts(), counts())).toMatchObject({ kind: 'build', key: 'woodcutter' });
    expect(nextOpeningDecision(counts(), counts({ woodcutter: 1 }))).toMatchObject({ kind: 'wait', key: 'woodcutter' });
    expect(nextOpeningDecision(counts({ woodcutter: 1 }), counts())).toMatchObject({ kind: 'build', key: 'sawmill' });

    const throughFirstMint = counts({
      woodcutter: 1, sawmill: 1, quarry: 1, goldmine: 1, coalmine: 1, mint: 1,
    });
    expect(nextOpeningDecision(throughFirstMint, counts())).toMatchObject({ kind: 'build', key: 'forester' });
  });

  it('uses cumulative counts for the second coal, mint, and quarry stages', () => {
    const built = Object.fromEntries(COMMON_OPENING.slice(0, 22).map(step => [step.key, step.target])) as Partial<Record<BuildingKey, number>>;
    expect(nextOpeningDecision(counts(built), counts())).toMatchObject({ kind: 'build', key: 'goldmine', target: 2 });
    built.goldmine = 2;
    expect(nextOpeningDecision(counts(built), counts({ coalmine: 1 }))).toMatchObject({ kind: 'wait', key: 'coalmine', target: 3 });
    built.coalmine = 3;
    expect(nextOpeningDecision(counts(built), counts())).toMatchObject({ kind: 'build', key: 'mint', target: 2 });
    built.mint = 2;
    built.quarry = 2;
    expect(nextOpeningDecision(counts(built), counts())).toEqual({ kind: 'complete' });
  });
});

describe('Classic production-line planner', () => {
  it('combines standing and pending counts without mutating either input', () => {
    const built = counts({ woodcutter: 1, sawmill: 1 });
    const pending = counts({ woodcutter: 1, coalmine: 2 });
    expect(plannedBuildingCounts(built, pending)).toMatchObject({ woodcutter: 2, sawmill: 1, coalmine: 2 });
    expect(built).toEqual({ woodcutter: 1, sawmill: 1 });
    expect(pending).toEqual({ woodcutter: 1, coalmine: 2 });
  });

  it.each([
    [{ woodcutter: 1, sawmill: 1 }, 3, 'woodcutter'],
    [{ woodcutter: 2, sawmill: 1 }, 3, 'sawmill'],
    [{ woodcutter: 1, sawmill: 2 }, 3, 'woodcutter'],
    [{ woodcutter: 3, sawmill: 3 }, 3, null],
  ] as const)('balances timber lines for planned=%j target=%i', (planned, target, expected) => {
    expect(nextTimberLineBuild(counts(planned), target)).toBe(expected);
  });

  it('counts pending timber sites, so rapid passes alternate rather than duplicate', () => {
    const built = counts({ woodcutter: 1, sawmill: 1 });
    const woodPending = plannedBuildingCounts(built, counts({ woodcutter: 1 }));
    expect(nextTimberLineBuild(woodPending, 3)).toBe('sawmill');
    const pairPending = plannedBuildingCounts(woodPending, counts({ sawmill: 1 }));
    expect(nextTimberLineBuild(pairPending, 3)).toBe('woodcutter');
  });

  it.each([
    [{ goldmine: 1, coalmine: 2, mint: 1, smithy: 1, armory: 1 }, 2, 1, 'goldmine'],
    [{ goldmine: 2, coalmine: 2, mint: 1, smithy: 1, armory: 1 }, 2, 1, 'coalmine'],
    [{ goldmine: 2, coalmine: 3, mint: 1, smithy: 1, armory: 1 }, 2, 1, 'mint'],
    [{ goldmine: 2, coalmine: 3, mint: 2, smithy: 1, armory: 1 }, 2, 1, null],
    [{ goldmine: 1, coalmine: 1, mint: 2 }, 2, 0, 'goldmine'],
  ] as const)('stages coin capacity for planned=%j', (planned, target, armsLines, expected) => {
    expect(nextCoinLineBuild(counts(planned), target, armsLines)).toBe(expected);
  });

  it('counts a pending mint and does not queue a duplicate against completed counts', () => {
    const planned = plannedBuildingCounts(
      counts({ goldmine: 2, coalmine: 3, mint: 1, smithy: 1, armory: 1 }),
      counts({ mint: 1 }),
    );
    expect(nextCoinLineBuild(planned, 2, 1)).toBeNull();
  });

  it.each([
    [{ mint: 2, ironmine: 1, coalmine: 3, smithy: 1, armory: 1 }, 2, 2, 'ironmine'],
    [{ mint: 2, ironmine: 2, coalmine: 3, smithy: 1, armory: 1 }, 2, 2, 'coalmine'],
    [{ mint: 2, ironmine: 2, coalmine: 4, smithy: 1, armory: 1 }, 2, 2, 'smithy'],
    [{ mint: 2, ironmine: 2, coalmine: 4, smithy: 2, armory: 1 }, 2, 2, 'armory'],
    [{ mint: 2, ironmine: 2, coalmine: 4, smithy: 2, armory: 2 }, 2, 2, null],
    [{ mint: 1, ironmine: 1, coalmine: 2, smithy: 0, armory: 1 }, 1, 1, 'smithy'],
  ] as const)('stages paired arms capacity for planned=%j', (planned, target, coinLines, expected) => {
    expect(nextArmsLineBuild(counts(planned), target, coinLines)).toBe(expected);
  });

  it('counts pending arms sites, including coal already reserved for mints', () => {
    let planned = counts({ mint: 2, ironmine: 1, coalmine: 3, smithy: 1, armory: 1 });
    expect(nextArmsLineBuild(planned, 2, 2)).toBe('ironmine');
    planned = plannedBuildingCounts(planned, counts({ ironmine: 1 }));
    expect(nextArmsLineBuild(planned, 2, 2)).toBe('coalmine');
    planned = plannedBuildingCounts(planned, counts({ coalmine: 1 }));
    expect(nextArmsLineBuild(planned, 2, 2)).toBe('smithy');
  });
});

describe('Classic production-line timing assumptions', () => {
  it('one gold and one coal mine supply one mint', () => {
    expect(DEFS.goldmine.gather?.time).toBe(5);
    expect(DEFS.coalmine.gather?.time).toBe(DEFS.goldmine.gather?.time);
    expect(DEFS.mint.recipe?.time).toBe(DEFS.goldmine.gather?.time);
    expect(DEFS.mint.recipe?.inp).toEqual({ goldore: 1, coal: 1 });
  });

  it('one iron and one dedicated coal mine supply one smithy plus one armory', () => {
    const mineTime = DEFS.ironmine.gather!.time;
    expect(DEFS.coalmine.gather?.time).toBe(mineTime);
    expect(DEFS.smithy.recipe?.time).toBe(mineTime * 2);
    expect(DEFS.armory.recipe?.time).toBe(mineTime * 2);
    expect(DEFS.smithy.recipe?.inp).toEqual({ iron: 1, coal: 1 });
    expect(DEFS.armory.recipe?.inp).toEqual({ iron: 1, coal: 1 });
  });
});
