import { describe, expect, it } from 'vitest';
import { runSelfPlayMatch } from '../../src/ai/selfplay';

describe('self-play convergence diagnostics', () => {
  it('captures exact end-state economy, composition, health, and spacing', () => {
    const result = runSelfPlayMatch({ seed: 1234, p1: 'idle', p2: 'idle', maxSeconds: 0 });
    const seat = result.final.seats.p1;

    expect(result.final.t).toBe(0);
    expect(seat.buildingsByKey).toMatchObject({ storehouse: 1, guildhall: 1 });
    expect(seat.sitesByKey).toEqual({});
    expect(seat.armyByKind).toEqual({ soldier: 4, archer: 2 });
    expect(seat.workersByRole).toMatchObject({ serf: 3, laborer: 1 });
    expect(seat).toMatchObject({
      timber: 16, stone: 12, coin: 8, bread: 10,
      trunk: 0, goldore: 0, coal: 0, iron: 0, weapon: 0, armor: 0,
    });
    expect(seat.castleHp).toBe(seat.castleMaxHp);
    expect(seat.castleMaxHp).toBeGreaterThan(0);
    expect(seat.meanNearestBuildingGap).toBe(1);
  });
});
