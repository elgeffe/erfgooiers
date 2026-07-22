import { describe, expect, it } from 'vitest';
import { planDefensiveLine, planFortificationRing, ringTowerSpots, sideToward } from '../../src/game/fortification';
import { makeTestGame } from '../../src/game/testHarness';
import { findPath } from '../../src/engine/pathfinding';
import { doorTile } from '../../src/game/util';

describe('defensive line planner', () => {
  it('throws a straight wall across the enemy approach with a central gate', () => {
    const center = { x: 20, y: 20 };
    const enemy = { x: 60, y: 20 }; // due east
    const pieces = planDefensiveLine(center, enemy, 11, 6);
    // one gate, the rest walls; gate is first (central approach)
    expect(pieces[0].kind).toBe('gate');
    expect(pieces.filter(p => p.kind === 'gate')).toHaveLength(1);
    expect(pieces.filter(p => p.kind === 'wall').length).toBe(pieces.length - 1);
    // the line runs perpendicular to the east approach: same x, spread in y
    const xs = new Set(pieces.map(p => p.x));
    expect(xs.size).toBe(1);           // a single column at distance 11 east
    expect([...xs][0]).toBe(31);       // 20 + 11
    const ys = pieces.map(p => p.y).sort((a, b) => a - b);
    expect(ys[0]).toBeLessThan(20);    // spans both sides of centre
    expect(ys[ys.length - 1]).toBeGreaterThan(20);
  });

  it('faces the gate toward whichever side the enemy sits', () => {
    const north = planDefensiveLine({ x: 20, y: 20 }, { x: 20, y: -20 }, 8, 3);
    expect(north[0].side).toBe('n');
    const ysSame = new Set(north.map(p => p.y));
    expect(ysSame.size).toBe(1);       // a horizontal line north of centre
  });

  it('snaps an arena-diagonal curtain to non-overlapping 2x2 pieces', () => {
    const center = { x: 12, y: 12 };
    const enemy = { x: 84, y: 84 };
    const pieces = planDefensiveLine(center, enemy, 12, 5);

    // A diagonal tie faces south, while the gate remains projected along the
    // true south-east approach rather than falling directly south of centre.
    expect(pieces[0]).toMatchObject({ kind: 'gate', x: 20, y: 20, rot: 0, side: 's' });
    expect(new Set(pieces.map(piece => piece.y))).toEqual(new Set([20]));

    // Top-left coordinates stride by exactly the two-tile footprint width,
    // producing one contiguous cardinal curtain with no occupied-tile overlap.
    const xs = [...new Set(pieces.map(piece => piece.x))].sort((a, b) => a - b);
    expect(xs).toHaveLength(pieces.length);
    expect(xs.slice(1).map((x, index) => x - xs[index])).toEqual(Array(xs.length - 1).fill(2));
    const occupied = new Set<string>();
    for (const piece of pieces) for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      occupied.add(`${piece.x + ox},${piece.y + oy}`);
    }
    expect(occupied.size).toBe(pieces.length * 4);
  });

  it('keeps an oblique gate on the enemy projection while the wall stays cardinal', () => {
    const center = { x: 10, y: 20 };
    const enemy = { x: 62, y: 60 };
    const pieces = planDefensiveLine(center, enemy, 14, 3);
    const gate = pieces[0];

    expect(gate).toMatchObject({ kind: 'gate', x: 21, y: 29, rot: 1, side: 'e' });
    expect(new Set(pieces.map(piece => piece.x))).toEqual(new Set([gate.x]));
    const ys = [...pieces.map(piece => piece.y)].sort((a, b) => a - b);
    expect(ys.slice(1).map((y, index) => y - ys[index])).toEqual(Array(ys.length - 1).fill(2));
  });
});

describe('fortification planner', () => {
  it('draws a closed square curtain with gates mid-side', () => {
    const pieces = planFortificationRing({ x: 20, y: 20 }, 6, ['e', 'w']);
    // radius 6 in 2-tile steps: 7 blocks per edge, corners shared → 24 blocks
    expect(pieces.length).toBe(24);
    for (const piece of pieces) {
      const dx = Math.abs(piece.x - 20), dy = Math.abs(piece.y - 20);
      expect(Math.max(dx, dy)).toBe(6);
    }
    const gates = pieces.filter(piece => piece.kind === 'gate');
    expect(gates.map(gate => `${gate.x},${gate.y}`).sort()).toEqual(['14,20', '26,20']);
    // east/west gates turn their archway to run east–west
    for (const gate of gates) expect(gate.rot).toBe(1);
    const northGate = planFortificationRing({ x: 20, y: 20 }, 4, ['n'])
      .find(piece => piece.kind === 'gate')!;
    expect(northGate).toMatchObject({ x: 20, y: 16, rot: 0 });
  });

  it('sideToward matches the stronghold builder tie-breaks', () => {
    expect(sideToward({ x: 0, y: 0 }, { x: 9, y: 3 })).toBe('e');
    expect(sideToward({ x: 0, y: 0 }, { x: -9, y: 3 })).toBe('w');
    expect(sideToward({ x: 0, y: 0 }, { x: 3, y: 9 })).toBe('s');
    expect(sideToward({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe('s'); // ties go n/s
    expect(ringTowerSpots({ x: 10, y: 10 }, 6)).toEqual([
      { x: 6, y: 6 }, { x: 14, y: 6 }, { x: 6, y: 14 }, { x: 14, y: 14 },
    ]);
  });

  it('a finished ring lets the owner out through their gate but walls a rival out', () => {
    const { game, world } = makeTestGame({ seed: 900, size: 48 });
    game.setTeams({ p1: 0, p2: 1, enemy: 2, wild: 2 }); // skirmish diplomacy
    const store = game.storeFor('p1');
    const center = { x: store.x, y: store.y };
    // raise the full ring instantly wherever the ground allows
    let placed = 0, gates = 0;
    for (const piece of planFortificationRing(center, 6, ['e', 'w'])) {
      const key = piece.kind === 'gate' ? 'gate' : 'wall';
      if (!game.canPlace(key, piece.x, piece.y, piece.rot)) continue;
      game.placeBuilding(key, piece.x, piece.y, true, piece.rot, 'player', 'p1');
      placed++;
      if (piece.kind === 'gate') gates++;
    }
    expect(placed).toBeGreaterThanOrEqual(20); // near-complete curtain on open ground
    expect(gates).toBeGreaterThanOrEqual(1);
    const door = doorTile(store);
    const outside = { x: center.x + 12, y: center.y };
    // the owner's serfs walk out through their own gate
    expect(findPath(world, door.x, door.y, outside.x, outside.y, 'p1')).not.toBeNull();
    // the hostile rival cannot walk in where the curtain stands: any route to
    // the castle door must pass a gap the terrain forced, never a gate
    const rivalPath = findPath(world, outside.x, outside.y, door.x, door.y, 'p2');
    if (placed === 24) expect(rivalPath).toBeNull();
  });
});
