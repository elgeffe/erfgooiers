import { describe, expect, it } from 'vitest';
import { Objective, ascendObjective } from '../../src/game/Objectives';
import type { Game } from '../../src/game/Game';

/** Objectives only touch the Game for `stock` counting. */
const gameWith = (stock: Record<string, number>): Game =>
  ({ countItem: (k: string) => stock[k] || 0 } as unknown as Game);

describe('Objective', () => {
  it('produce counts production events, not net stock', () => {
    const o = new Objective({ kind: 'produce', item: 'bread', n: 3 });
    o.onProduce('bread');
    o.onProduce('bread');
    o.onProduce('timber'); // other items don't count
    let st = o.evaluate(gameWith({}));
    expect(st.done).toBe(false);
    expect(st.ratio).toBeCloseTo(2 / 3);
    o.onProduce('bread');
    st = o.evaluate(gameWith({}));
    expect(st.done).toBe(true);
    expect(st.ratio).toBe(1);
  });

  it('produceMulti needs every requirement met', () => {
    const o = new Objective({ kind: 'produceMulti', reqs: [{ item: 'bread', n: 2 }, { item: 'wine', n: 1 }] });
    o.onProduce('bread');
    o.onProduce('bread');
    expect(o.evaluate(gameWith({})).done).toBe(false);
    o.onProduce('wine');
    expect(o.evaluate(gameWith({})).done).toBe(true);
  });

  it('stock checks live holdings', () => {
    const o = new Objective({ kind: 'stock', reqs: [{ item: 'coin', n: 5 }] });
    expect(o.evaluate(gameWith({ coin: 4 })).done).toBe(false);
    expect(o.evaluate(gameWith({ coin: 5 })).done).toBe(true);
  });

  it('collect counts gold-pile pickups', () => {
    const o = new Objective({ kind: 'collect', n: 2 });
    o.onCollect();
    expect(o.evaluate(gameWith({})).done).toBe(false);
    o.onCollect();
    expect(o.evaluate(gameWith({})).done).toBe(true);
  });

  it('slay counts only hostile kills of the named unit', () => {
    const o = new Objective({ kind: 'slay', unit: 'boar', n: 2 });
    o.onKill('boar', 'wild');
    o.onKill('boar', 'player'); // friendly-fire bookkeeping never counts
    o.onKill('wolf', 'wild');
    expect(o.evaluate(gameWith({})).done).toBe(false);
    o.onKill('boar', 'wild');
    expect(o.evaluate(gameWith({})).done).toBe(true);
  });

  it('survive and destroy track waves and razed strongholds', () => {
    const s = new Objective({ kind: 'survive', waves: 2 });
    s.onWaveCleared();
    expect(s.evaluate(gameWith({})).done).toBe(false);
    s.onWaveCleared();
    expect(s.evaluate(gameWith({})).done).toBe(true);

    const d = new Objective({ kind: 'destroy', n: 1 });
    d.onStructureDestroyed('player'); // razing your own building never counts
    expect(d.evaluate(gameWith({})).done).toBe(false);
    d.onStructureDestroyed('enemy');
    expect(d.evaluate(gameWith({})).done).toBe(true);
  });

  it('clearAll needs an empty map — no foes, no strongholds, no pending raids', () => {
    // a mock Game exposing just the clear-all queries
    const clearWith = (foes: number, holds: number, pending: boolean): Game =>
      ({ hostileUnitsLeft: () => foes, enemyStructuresLeft: () => holds, scheduledWavesPending: () => pending } as unknown as Game);
    const o = new Objective({ kind: 'clearAll' });
    expect(o.evaluate(clearWith(12, 3, true)).done).toBe(false);  // snapshots base = 15
    expect(o.evaluate(clearWith(4, 1, false)).done).toBe(false);   // foes & holds remain
    expect(o.evaluate(clearWith(0, 0, true)).done).toBe(false);    // a raid still looms
    expect(o.evaluate(clearWith(0, 0, false)).done).toBe(true);    // truly clear
    expect(o.evaluate(clearWith(0, 0, false)).ratio).toBe(1);
  });

  it('progress ratio is clamped to 1', () => {
    const o = new Objective({ kind: 'produce', item: 'bread', n: 2 });
    for (let i = 0; i < 5; i++) o.onProduce('bread');
    expect(o.evaluate(gameWith({})).ratio).toBe(1);
  });
});

describe('ascendObjective', () => {
  const timber8 = { kind: 'produce', item: 'timber', n: 8 } as const;

  it('leaves the base game untouched', () => {
    expect(ascendObjective(timber8, 0, 1)).toEqual(timber8);
    expect(ascendObjective({ kind: 'produce', item: 'bread', n: 8 }, 0, 2)).toEqual({ kind: 'produce', item: 'bread', n: 8 });
  });

  it('redesigns every opening level into a multi goal from the first ascension', () => {
    // level 1: already a two-item goal at Hard, three items with big counts higher up
    const hard = ascendObjective(timber8, 1, 1);
    expect(hard.kind).toBe('produceMulti');
    const grim = ascendObjective(timber8, 4, 1);
    expect(grim.kind === 'produceMulti' && grim.reqs.some(r => r.item === 'coin')).toBe(true);
    expect(grim.kind === 'produceMulti' && grim.reqs.find(r => r.item === 'timber')!.n).toBeGreaterThan(30);
    // counts keep growing with the tier instead of repeating
    const t2 = ascendObjective(timber8, 2, 1), t5 = ascendObjective(timber8, 5, 1);
    expect(t2.kind === 'produceMulti' && t5.kind === 'produceMulti'
      && t5.reqs[0].n > t2.reqs[0].n).toBe(true);
    // level 4 keeps its train component but drills a far larger host
    const drill = ascendObjective({ kind: 'produceTrain', reqs: [{ item: 'bread', n: 8 }], train: 5 }, 5, 4);
    expect(drill.kind === 'produceTrain' && drill.train).toBe(30);
  });

  it('swells economy quantities by half from Absurd, leaving combat alone', () => {
    // (a non-opening level: the redesigned tables own levels 1-4)
    expect(ascendObjective(timber8, 3, 6)).toEqual({ kind: 'produce', item: 'timber', n: 12 });
    const slay = { kind: 'slay', unit: 'dragon', n: 1 } as const;
    expect(ascendObjective(slay, 5, 10)).toEqual(slay);
  });

  it('turns level 5 into fortify-and-defend on every ascension, scaling with the tier', () => {
    const base = { kind: 'survive', waves: 2 } as const;
    expect(ascendObjective(base, 0, 5)).toEqual(base);
    const hard = ascendObjective(base, 1, 5);
    expect(hard).toEqual({ kind: 'fortifyDefend', walls: 10, gates: 1, towers: 4, waves: 2 });
    const top = ascendObjective(base, 5, 5);
    expect(top.kind === 'fortifyDefend' && top.walls).toBe(20);
    expect(top.kind === 'fortifyDefend' && top.waves).toBe(6);
    // no longer swallowed by clear-all at Absurd
    expect(ascendObjective(base, 3, 5).kind).toBe('fortifyDefend');
  });

  it('turns the Defend & assault levels into clear-all from Absurd', () => {
    const assault = { kind: 'destroy', n: 5 } as const;
    expect(ascendObjective(assault, 2, 9)).toEqual(assault);      // untouched below Absurd
    expect(ascendObjective(assault, 3, 7)).toEqual({ kind: 'clearAll' });
    expect(ascendObjective(assault, 3, 9)).toEqual({ kind: 'clearAll' });
    // the Hunt (6) and Dragon (10) keep their own goals
    expect(ascendObjective({ kind: 'slay', unit: 'boar', n: 8 }, 3, 6).kind).toBe('slayMulti');
    expect(ascendObjective({ kind: 'slay', unit: 'dragon', n: 1 }, 3, 10).kind).toBe('slay');
  });
});
