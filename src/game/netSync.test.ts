import { describe, expect, it } from 'vitest';
import { simRng } from '../engine/rng';
import { applyGameCommand } from './commands';
import { makeTestGame } from './testHarness';
import type { Game } from './Game';
import type { GameCommand } from '../net/protocol';
import type { PlayerId } from '../types';

/**
 * The co-op model: both peers build the same world from the shared seed and
 * apply the same accepted command stream. The only allowed difference between
 * host and guest is which PlayerId is local — if `localPlayerId` ever leaks
 * into simulation outcomes, the two sims drift apart and co-op breaks.
 */
function fingerprint(game: Game): string {
  const buildings = game.buildings.map(b => `${b.id}:${b.key}:${b.owner}:${b.x},${b.y}:${b.hp}`).join('|');
  const sites = game.sites.map(s => `${s.id}:${s.key}:${s.owner}:${s.x},${s.y}:${Math.round(s.progress * 1000)}`).join('|');
  const units = game.units.map(u =>
    `${u.id}:${u.role}:${u.owner}:${u.tx},${u.ty}:${Math.round(u.mesh.position.x * 1000)},${Math.round(u.mesh.position.z * 1000)}:${Math.round(u.hp)}`,
  ).join('|');
  const stocks = (['p1', 'p2'] as PlayerId[]).map(p => JSON.stringify(game.storeFor(p).stock)).join('|');
  const trade = game.tradeShipments.map(s => `${s.id}:${s.phase}:${s.amount}`).join('|')
    + '#' + game.tradeRequests.map(r => `${r.id}:${r.status}`).join('|');
  return [game.elapsed.toFixed(3), buildings, sites, units, stocks, trade].join('\n');
}

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

    expect(fingerprint(guest)).toBe(fingerprint(host));
  });
});
