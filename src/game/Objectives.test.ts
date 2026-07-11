import { describe, expect, it } from 'vitest';
import { Objective, ascendObjective } from './Objectives';
import type { Game } from './Game';

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
    expect(ascendObjective(timber8, 1, 1)).toEqual(timber8);
  });

  it('turns the opening level into a whole-economy goal from Very Hard', () => {
    const d = ascendObjective(timber8, 2, 1);
    expect(d.kind).toBe('produceMulti');
    const grim = ascendObjective(timber8, 4, 1);
    expect(grim.kind === 'produceMulti' && grim.reqs.some(r => r.item === 'coin')).toBe(true);
  });

  it('swells economy quantities by half from Absurd, leaving combat alone', () => {
    expect(ascendObjective(timber8, 3, 2)).toEqual({ kind: 'produce', item: 'timber', n: 12 });
    const slay = { kind: 'slay', unit: 'dragon', n: 1 } as const;
    expect(ascendObjective(slay, 5, 10)).toEqual(slay);
  });
});
