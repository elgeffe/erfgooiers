import { describe, expect, it } from 'vitest';
import { simRng } from '../engine/rng';
import { applyGameCommand } from './commands';
import { gameplayFingerprint, makeTestGame } from './testHarness';
import type { GameCommand } from '../net/protocol';
import type { PlayerId } from '../types';

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
