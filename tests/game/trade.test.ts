import { describe, expect, it } from 'vitest';
import { makeTestGame, tickUntil } from '../../src/game/testHarness';
import { tradeEta, tradeLoadTime, tradePartner } from '../../src/game/trade';
import { BASE_SPEED } from '../../src/constants';

describe('trade helpers', () => {
  it('loading time grows with the amount', () => {
    expect(tradeLoadTime(0)).toBeGreaterThan(0);
    expect(tradeLoadTime(50)).toBeGreaterThan(tradeLoadTime(5));
  });

  it('eta scales with distance at carrier speed', () => {
    expect(tradeEta(0, BASE_SPEED)).toBe(0);
    expect(tradeEta(30, BASE_SPEED)).toBeGreaterThan(tradeEta(10, BASE_SPEED));
  });

  it('partners are the two co-op seats', () => {
    expect(tradePartner('p1')).toBe('p2');
    expect(tradePartner('p2')).toBe('p1');
  });
});

describe('physical trade shipments', () => {
  it('reserves stock at send and delivers only on arrival', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.timber = 20;
    const p2Before = p2Store.stock!.timber || 0;

    expect(game.sendTrade('p1', 'timber', 10, p1Store.id, p2Store.id)).toBe(true);
    expect(p1Store.stock!.timber).toBe(10);          // reserved immediately
    expect(p2Store.stock!.timber).toBe(p2Before);    // nothing teleports
    const shipment = game.tradeShipments[0];
    expect(shipment.phase).toBe('loading');
    expect(shipment.carrier).not.toBeNull();

    expect(tickUntil(game, () => shipment.phase === 'delivered', 180)).toBe(true);
    expect(p2Store.stock!.timber).toBe(p2Before + 10);
    expect(shipment.carrier).toBeNull();
    expect(game.units.some(u => u.role === 'carrier')).toBe(false);
  });

  it('clamps the send to what the storehouse actually holds', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.stone = 3;
    expect(game.sendTrade('p1', 'stone', 999, p1Store.id, p2Store.id)).toBe(true);
    expect(game.tradeShipments[0].amount).toBe(3);
    expect(p1Store.stock!.stone).toBe(0);
  });

  it('rejects sends from a store the sender does not own', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p2Store.stock!.timber = 20;
    expect(game.sendTrade('p1', 'timber', 5, p2Store.id, p1Store.id)).toBe(false);
    expect(game.tradeShipments.length).toBe(0);
    expect(p2Store.stock!.timber).toBe(20);
  });

  it('rejects sends of goods the sender is out of', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.wine = 0;
    expect(game.sendTrade('p1', 'wine', 5, p1Store.id, p2Store.id)).toBe(false);
    expect(game.tradeShipments.length).toBe(0);
  });

  it('cancelling during loading refunds the goods at once', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.timber = 12;
    game.sendTrade('p1', 'timber', 12, p1Store.id, p2Store.id);
    expect(p1Store.stock!.timber).toBe(0);
    expect(game.cancelTradeShipment('p1', game.tradeShipments[0].id)).toBe(true);
    expect(game.tradeShipments[0].phase).toBe('recalled');
    expect(p1Store.stock!.timber).toBe(12);
    expect(game.units.some(u => u.role === 'carrier')).toBe(false);
  });

  it('recalling a moving cart walks it home and unloads physically', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.bread = 8;
    game.sendTrade('p1', 'bread', 8, p1Store.id, p2Store.id);
    const shipment = game.tradeShipments[0];
    expect(tickUntil(game, () => shipment.phase === 'enroute', 30)).toBe(true);
    expect(game.cancelTradeShipment('p1', shipment.id)).toBe(true);
    expect(shipment.phase).toBe('returning');
    expect(p1Store.stock!.bread).toBe(0);            // not refunded instantly
    expect(tickUntil(game, () => shipment.phase === 'recalled', 180)).toBe(true);
    expect(p1Store.stock!.bread).toBe(8);
  });

  it('only the sender may cancel a shipment', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.timber = 6;
    game.sendTrade('p1', 'timber', 6, p1Store.id, p2Store.id);
    expect(game.cancelTradeShipment('p2', game.tradeShipments[0].id)).toBe(false);
  });

  it('a slain carrier loses its cargo — no refund, no delivery', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.coin = 9;
    const p2Before = p2Store.stock!.coin || 0;
    game.sendTrade('p1', 'coin', 9, p1Store.id, p2Store.id);
    const shipment = game.tradeShipments[0];
    expect(tickUntil(game, () => shipment.phase === 'enroute', 30)).toBe(true);
    shipment.carrier!.dead = true;                   // ambushed on the road
    expect(tickUntil(game, () => shipment.phase === 'lost', 10)).toBe(true);
    expect(p1Store.stock!.coin).toBe(0);
    expect(p2Store.stock!.coin).toBe(p2Before);
    expect(game.tradeHistory.some(h => h.kind === 'lost')).toBe(true);
  });

  it('requests transfer nothing and can be fulfilled, declined, or cancelled', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');

    // p2 asks for stone into their own store; nothing moves
    const p2Stone = p2Store.stock!.stone || 0;
    expect(game.requestTrade('p2', 'stone', 5, p2Store.id)).toBe(true);
    expect(p2Store.stock!.stone).toBe(p2Stone);
    const request = game.tradeRequests[0];
    expect(request.status).toBe('open');

    // fulfilling opens a normal send tied to the request
    p1Store.stock!.stone = 10;
    expect(game.sendTrade('p1', 'stone', 5, p1Store.id, p2Store.id, request.id)).toBe(true);
    expect(request.status).toBe('fulfilled');

    // a second request can be declined by the ally, a third cancelled by its owner
    game.requestTrade('p2', 'bread', 4, p2Store.id);
    const declined = game.tradeRequests[0];
    expect(game.cancelTradeRequest('p1', declined.id)).toBe(true);
    expect(declined.status).toBe('declined');
    game.requestTrade('p2', 'wine', 2, p2Store.id);
    const cancelled = game.tradeRequests[0];
    expect(game.cancelTradeRequest('p2', cancelled.id)).toBe(true);
    expect(cancelled.status).toBe('cancelled');
  });

  it('a request must point at the requester’s own storehouse', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1');
    expect(game.requestTrade('p2', 'stone', 5, p1Store.id)).toBe(false);
  });
});
