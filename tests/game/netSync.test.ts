import { describe, expect, it } from 'vitest';
import { simRng } from '../../src/engine/rng';
import { applyGameCommand } from '../../src/game/commands';
import { gameplayFingerprint, makeTestGame } from '../../src/game/testHarness';
import { heroSpecsFor } from '../../src/data/heroes';
import type { GameCommand } from '../../src/net/protocol';
import type { PlayerId } from '../../src/types';

describe('per-player co-op modifiers', () => {
  it('applies a player\'s hero rules only to their own units', () => {
    const { game } = makeTestGame({ localPlayerId: 'p1' });
    game.setPlayerMods('p1', heroSpecsFor('warlord'));   // soldiers deal x2 damage
    game.setPlayerMods('p2', heroSpecsFor('erfgooier')); // the plain baseline
    const [p1Soldier] = game.spawnSquad('soldier', 1, 0, 0, 'player', 'p1');
    const [p2Soldier] = game.spawnSquad('soldier', 1, 0, 0, 'player', 'p2');
    expect(p1Soldier && p2Soldier).toBeTruthy();
    expect(p1Soldier.dmg).toBeCloseTo(p2Soldier.dmg * 2);
  });

  it('bakes identical stats on both peers regardless of which seat is local', () => {
    const install = (localPlayerId: PlayerId) => {
      const { game } = makeTestGame({ seed: 909, localPlayerId });
      game.setPlayerMods('p1', heroSpecsFor('warlord'));
      game.setPlayerMods('p2', heroSpecsFor('captain'));
      // Spawn each player's fighter deterministically, owner-tagged.
      simRng.reseed(1234); const p1 = game.spawnSquad('soldier', 1, 0, 0, 'player', 'p1')[0];
      simRng.reseed(1234); const p2 = game.spawnSquad('archer', 1, 0, 0, 'player', 'p2')[0];
      return { p1, p2 };
    };
    const host = install('p1'), guest = install('p2');
    expect(host.p1.dmg).toBe(guest.p1.dmg);
    expect(host.p2.dmg).toBe(guest.p2.dmg);
  });
});

describe('per-player event toasts', () => {
  it('shows a player only their own settlement events, not their ally\'s', () => {
    const { game } = makeTestGame({ localPlayerId: 'p1' });
    const seen: string[] = [];
    game.toast = message => seen.push(message);
    // The bell toast is owner-scoped: p1 hears their own, never p2's.
    game.setBell('p2', true);
    expect(seen).toHaveLength(0);
    game.setBell('p1', true);
    expect(seen.some(message => message.includes('bell'))).toBe(true);
  });
});

/**
 * The co-op model: both peers build the same world from the shared seed and
 * apply the same accepted command stream. The only allowed difference between
 * host and guest is which PlayerId is local — if `localPlayerId` ever leaks
 * into simulation outcomes, the two sims drift apart and co-op breaks.
 */
describe('host/guest simulation parity', () => {
  it('two peers applying the same command stream stay identical', () => {
    const seed = 20260711;
    const host = makeTestGame({ seed, localPlayerId: 'p1' }).game;
    const guest = makeTestGame({ seed, localPlayerId: 'p2' }).game;

    const p1Store = host.storeFor('p1'), p2Store = host.storeFor('p2');
    const script: Array<{ at: number; playerId: PlayerId; command: GameCommand }> = [
      { at: 0.5, playerId: 'p1', command: { type: 'placeBuilding', key: 'woodcutter', x: p1Store.x + 4, y: p1Store.y + 4, rot: 0 } },
      { at: 1.0, playerId: 'p2', command: { type: 'placeBuilding', key: 'sawmill', x: p2Store.x - 6, y: p2Store.y + 3, rot: 1 } },
      { at: 2.0, playerId: 'p2', command: { type: 'paintRoad', cells: [{ x: p2Store.x - 2, y: p2Store.y - 2 }, { x: p2Store.x - 1, y: p2Store.y - 2 }] } },
      { at: 3.0, playerId: 'p1', command: { type: 'sendTrade', item: 'timber', amount: 4, sourceId: p1Store.id, destinationId: p2Store.id } },
      { at: 4.0, playerId: 'p2', command: { type: 'requestTrade', item: 'stone', amount: 3, destinationId: p2Store.id } },
      { at: 5.0, playerId: 'p1', command: { type: 'setBell', active: true } },
      { at: 8.0, playerId: 'p1', command: { type: 'setBell', active: false } },
    ];

    // Both peers apply each command at the same tick boundary, then run on.
    // In real co-op each browser owns its simRng singleton; in one process the
    // two games would otherwise split a single stream, so each peer's step is
    // reseeded identically — equal states then consume equal rnd() sequences.
    const TICK = 1 / 20;
    let next = 0;
    for (let step = 0; step < 20 * 30; step++) {
      const now = step * TICK;
      while (next < script.length && script[next].at <= now) {
        const { playerId, command } = script[next++];
        const cmdSeed = (seed ^ (next * 0x9e3779)) >>> 0;
        simRng.reseed(cmdSeed);
        const hostOk = applyGameCommand(host, playerId, command).ok;
        simRng.reseed(cmdSeed);
        const guestOk = applyGameCommand(guest, playerId, command).ok;
        expect(guestOk).toBe(hostOk);
      }
      const tickSeed = (seed + step * 7919) >>> 0;
      simRng.reseed(tickSeed);
      host.update(TICK);
      simRng.reseed(tickSeed);
      guest.update(TICK);
    }

    // History text is intentionally phrased for the local seat ("to you"),
    // while authoritative gameplay state must remain identical.
    expect(gameplayFingerprint(guest, false)).toBe(gameplayFingerprint(host, false));
  });
});
