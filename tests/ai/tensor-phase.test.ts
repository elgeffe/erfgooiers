import { describe, expect, it } from 'vitest';
import { DEFS } from '../../src/data/buildings';
import type { Building, BuildingKey, Unit } from '../../src/types';
import type { AIView } from '../../src/ai/perception';
import {
  advancePhase, initialPhase, lategameReached, milestones, needsRecovery, openingComplete,
  FIELD_ARMY, MAJOR_WAVE, MIDGAME_TIME_CAP, OPENING_TIME_CAP,
} from '../../src/ai/tensor/phase';

/** A standing, staffed building of `key` — the detector only reads key/def/
 *  active/worker/hp, so the rest of the record stays out of the fixture. */
function building(key: BuildingKey, options: { staffed?: boolean; active?: boolean; hp?: number } = {}): Building {
  const def = DEFS[key];
  return {
    key, def, active: options.active ?? true,
    worker: options.staffed === false ? null : ({} as Unit),
    hp: options.hp ?? def.hp ?? 100, maxHp: def.hp ?? 100,
  } as Building;
}

/** The staffed core economy the opening has to deliver. */
const CORE: BuildingKey[] = ['woodcutter', 'sawmill', 'quarry', 'mint', 'bakery', 'tavern', 'barracks'];

function view(over: Partial<AIView> = {}): AIView {
  const buildings = over.buildings ?? CORE.map(key => building(key));
  return {
    elapsed: 300, owner: 'p1', enemySeats: ['p2'], eliminated: false,
    store: building('storehouse'), buildings, sites: [], built: {}, pending: {},
    workers: { serfs: 8, laborers: 1, villagers: 6, freeVillagers: 1, unstaffed: 0 },
    averageWorkerHunger: 80,
    army: [], armySize: 0,
    enemyStore: null, enemyArmySize: 0, enemyArmyByKind: {}, enemyBulwarks: [], enemyTowers: [],
    threats: [], threatCentroid: null,
    resources: { trees: [], stone: [], gold: [], coal: [], iron: [] },
    ...over,
  } as AIView;
}

const hostiles = (count: number): Unit[] => Array.from({ length: count }, () => ({}) as Unit);

describe('Tensor v2 milestones', () => {
  it('requires the whole timber chain, not just a woodcutter', () => {
    expect(milestones(view({ buildings: [building('woodcutter')] })).timber).toBe(false);
    expect(milestones(view({ buildings: [building('woodcutter'), building('sawmill')] })).timber).toBe(true);
  });

  it('does not count an unstaffed or unfinished producer as a running industry', () => {
    expect(milestones(view({ buildings: [building('woodcutter'), building('sawmill', { staffed: false })] })).timber).toBe(false);
    expect(milestones(view({ buildings: [building('woodcutter'), building('sawmill', { active: false })] })).timber).toBe(false);
    // barracks need no worker at all — being active IS being online
    expect(milestones(view({ buildings: [building('barracks')] })).military).toBe(true);
  });

  it('needs a tavern before food counts as reaching the workers', () => {
    const withoutTavern = CORE.filter(key => key !== 'tavern').map(key => building(key));
    expect(milestones(view({ buildings: withoutTavern })).food).toBe(true);
    expect(milestones(view({ buildings: withoutTavern })).foodService).toBe(false);
    expect(openingComplete(view({ buildings: withoutTavern }))).toBe(false);
  });

  it('accepts any staple food industry, not only bread', () => {
    for (const key of ['bakery', 'butcher', 'fishery', 'clamdigger'] as BuildingKey[]) {
      expect(milestones(view({ buildings: [building(key)] })).food).toBe(true);
    }
    expect(milestones(view({ buildings: [building('farm'), building('mill')] })).food).toBe(false);
  });

  it('reads cavalry, siege and support as the advanced military layer', () => {
    for (const key of ['stable', 'engineer', 'monastery'] as BuildingKey[]) {
      expect(milestones(view({ buildings: [building(key)] })).advancedMilitary).toBe(true);
    }
    expect(milestones(view({ buildings: [building('barracks')] })).advancedMilitary).toBe(false);
  });
});

describe('Tensor v2 phase transitions', () => {
  it('leaves the opening only once the staffed core economy is complete', () => {
    expect(openingComplete(view())).toBe(true);
    for (const missing of CORE) {
      const rest = CORE.filter(key => key !== missing).map(key => building(key));
      expect(openingComplete(view({ buildings: rest }))).toBe(false);
    }
  });

  it('falls back to the opening time cap when the economy deadlocks', () => {
    const stuck = view({ buildings: [building('woodcutter')], elapsed: OPENING_TIME_CAP - 1 });
    expect(advancePhase(initialPhase(0), stuck).phase).toBe('opening');
    expect(advancePhase(initialPhase(0), { ...stuck, elapsed: OPENING_TIME_CAP }).phase).toBe('midgame');
  });

  it('enters the late game on a launched wave, a landed wave, or an advanced army', () => {
    const mid = { phase: 'midgame', since: 200, recovery: false } as const;
    expect(advancePhase(mid, view()).phase).toBe('midgame');
    expect(advancePhase(mid, view(), { committed: true }).phase).toBe('lategame');
    expect(advancePhase(mid, view({ threats: hostiles(MAJOR_WAVE) })).phase).toBe('lategame');
    expect(advancePhase(mid, view({ enemyArmySize: MAJOR_WAVE })).phase).toBe('lategame');

    // an advanced arm alone is not late game — it needs an army to use it
    const withStable = [...CORE.map(key => building(key)), building('stable')];
    expect(lategameReached(view({ buildings: withStable }), {})).toBe(false);
    expect(lategameReached(view({ buildings: withStable, armySize: FIELD_ARMY }), {})).toBe(true);
    expect(lategameReached(view({ armySize: FIELD_ARMY }), {})).toBe(false);
  });

  it('is monotonic and advances at most one phase per pass', () => {
    const decisive = view({ armySize: 40, threats: hostiles(20), elapsed: MIDGAME_TIME_CAP + 100 });
    const opening = initialPhase(0);
    const mid = advancePhase(opening, decisive);
    expect(mid.phase).toBe('midgame'); // not straight to late game
    const late = advancePhase(mid, decisive);
    expect(late.phase).toBe('lategame');
    // and nothing walks it back: a razed economy stays in the late game
    const razed = view({ buildings: [], armySize: 0, elapsed: MIDGAME_TIME_CAP + 200 });
    expect(advancePhase(late, razed).phase).toBe('lategame');
  });

  it('stamps `since` at the transition and keeps the same object while nothing changes', () => {
    const opening = initialPhase(0);
    expect(advancePhase(opening, view({ buildings: [building('woodcutter')], elapsed: 90 }))).toBe(opening);
    const mid = advancePhase(opening, view({ elapsed: 240 }));
    expect(mid).toMatchObject({ phase: 'midgame', since: 240 });
  });
});

describe('Tensor v2 recovery overlay', () => {
  it('triggers on starvation, worker gaps, stalled sites, and castle damage', () => {
    expect(needsRecovery(view({ averageWorkerHunger: 20 }), {}, false)).toBe(true);
    expect(needsRecovery(view({ workers: { serfs: 4, laborers: 0, villagers: 2, freeVillagers: 0, unstaffed: 5 } }), {}, false)).toBe(true);
    expect(needsRecovery(view(), { stalledSites: 3 }, false)).toBe(true);
    expect(needsRecovery(view({ store: building('storehouse', { hp: 10 }) }), {}, false)).toBe(true);
    expect(needsRecovery(view(), {}, false)).toBe(false);
  });

  it('ignores a worker gap a waiting villager is about to fill', () => {
    const workers = { serfs: 4, laborers: 0, villagers: 3, freeVillagers: 2, unstaffed: 5 };
    expect(needsRecovery(view({ workers }), {}, false)).toBe(false);
  });

  it('latches: it holds through the grey zone and only clears when truly healthy', () => {
    const greyZone = view({ averageWorkerHunger: 45 });
    expect(needsRecovery(greyZone, {}, false)).toBe(false); // never would have started here
    expect(needsRecovery(greyZone, {}, true)).toBe(true);   // but having started, it holds
    expect(needsRecovery(view({ averageWorkerHunger: 70 }), {}, true)).toBe(false);
  });

  it('rides along with the phase without disturbing it', () => {
    const state = advancePhase(initialPhase(0), view({ averageWorkerHunger: 10, elapsed: 120 }));
    expect(state).toMatchObject({ phase: 'midgame', recovery: true });
    const healed = advancePhase(state, view({ elapsed: 200 }));
    expect(healed).toMatchObject({ phase: 'midgame', since: 120, recovery: false });
  });
});
