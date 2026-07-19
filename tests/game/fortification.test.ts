import { describe, expect, it } from 'vitest';
import { planFortificationRing, ringTowerSpots, sideToward } from '../../src/game/fortification';
import { makeTestGame } from '../../src/game/testHarness';
import { findPath } from '../../src/engine/pathfinding';
import { doorTile } from '../../src/game/util';

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
