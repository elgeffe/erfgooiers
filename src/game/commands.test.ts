import { describe, expect, it } from 'vitest';
import { applyGameCommand } from './commands';
import { makeTestGame, tick } from './testHarness';

describe('command application and ownership boundaries', () => {
  it('places a building site owned by the issuing player', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p2');
    const result = applyGameCommand(game, 'p2', { type: 'placeBuilding', key: 'woodcutter', x: store.x + 4, y: store.y + 4, rot: 0 });
    expect(result.ok).toBe(true);
    expect(game.sites.length).toBe(1);
    expect(game.sites[0].owner).toBe('p2');
  });

  it('rejects unknown building keys and malformed entity ids', () => {
    const { game } = makeTestGame();
    expect(applyGameCommand(game, 'p1', { type: 'placeBuilding', key: 'castleofdoom' as never, x: 5, y: 5, rot: 0 }).ok).toBe(false);
    expect(applyGameCommand(game, 'p1', { type: 'setPriority', siteId: 99999, priority: true }).ok).toBe(false);
    expect(applyGameCommand(game, 'p1', { type: 'queueTraining', buildingId: 99999, unit: 'soldier' }).ok).toBe(false);
  });

  it('refuses training at a building the player does not own', () => {
    const { game } = makeTestGame();
    const p2Guild = game.playerGuilds.get('p2')!;
    const before = (p2Guild.trainQ || []).length;
    const result = applyGameCommand(game, 'p1', { type: 'queueTraining', buildingId: p2Guild.id, unit: 'serf' });
    expect(result.ok).toBe(false);
    expect((p2Guild.trainQ || []).length).toBe(before);
  });

  it('lets the owner train through the command path', () => {
    const { game } = makeTestGame();
    const guild = game.playerGuilds.get('p1')!;
    const result = applyGameCommand(game, 'p1', { type: 'queueTraining', buildingId: guild.id, unit: 'serf' });
    expect(result.ok).toBe(true);
    expect(guild.trainQ).toEqual(['serf']);
  });

  it('retains a military site rally point through completion and training', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p1');
    const site = game.placeSite('barracks', store.x + 5, store.y + 5, 0, 'p1');
    const rally = { x: store.x + 9, y: store.y + 7 };

    expect(applyGameCommand(game, 'p2', { type: 'setRally', buildingId: site.id, ...rally }).ok).toBe(false);
    expect(applyGameCommand(game, 'p1', { type: 'setRally', buildingId: site.id, ...rally }).ok).toBe(true);
    const flag = site.rallyMesh;
    expect(site.rally).toEqual(rally);

    (game as any).completeSite(site);
    const barracks = game.buildings.find(b => b.key === 'barracks' && b.owner === 'p1')!;
    expect(barracks.rally).toEqual(rally);
    expect(barracks.rallyMesh).toBe(flag);

    const previousIds = new Set(game.units.map(u => u.id));
    barracks.trainQ = ['archer'];
    barracks.prog = 0.999;
    game.update(0.05);
    const trained = game.units.find(u => !previousIds.has(u.id) && u.role === 'archer')!;
    expect(trained.order).toMatchObject({ type: 'attackMove', ...rally });
  });

  it('refuses orders for units the player does not own', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p2');
    const squad = game.spawnSquad('soldier', 3, 0, 0, 'player');
    for (const u of squad) u.owner = 'p2';
    const result = applyGameCommand(game, 'p1', {
      type: 'orderUnits', unitIds: squad.map(u => u.id),
      order: { type: 'move', x: store.x, y: store.y }, formation: 'box',
    });
    expect(result.ok).toBe(false);
    expect(squad.every(u => u.order === null)).toBe(true);
  });

  it('orders your own fighters and ignores ally ids mixed into the list', () => {
    const { game } = makeTestGame();
    const mine = game.spawnSquad('soldier', 2, 0, 0, 'player');
    for (const u of mine) u.owner = 'p1';
    const theirs = game.spawnSquad('archer', 2, 2, 2, 'player');
    for (const u of theirs) u.owner = 'p2';
    const result = applyGameCommand(game, 'p1', {
      type: 'orderUnits', unitIds: [...mine, ...theirs].map(u => u.id),
      order: { type: 'attackMove', x: 5, y: 5 }, formation: 'line',
    });
    expect(result.ok).toBe(true);
    expect(mine.every(u => u.order !== null)).toBe(true);
    expect(theirs.every(u => u.order === null)).toBe(true);
  });

  it('scopes the bell to the issuing player', () => {
    const { game } = makeTestGame();
    applyGameCommand(game, 'p2', { type: 'setBell', active: true });
    tick(game, 0.1);
    const p1Workers = game.units.filter(u => u.owner === 'p1' && u.dmg === 0);
    expect(p1Workers.some(u => u.wstate === 'toRefuge' || u.wstate === 'refuge')).toBe(false);
    const p2Workers = game.units.filter(u => u.owner === 'p2' && u.dmg === 0 && u.role !== 'carrier');
    expect(p2Workers.every(u => u.wstate === 'toRefuge' || u.wstate === 'refuge')).toBe(true);
  });

  it('routes trade through the same validated path', () => {
    const { game } = makeTestGame();
    const p1Store = game.storeFor('p1'), p2Store = game.storeFor('p2');
    p1Store.stock!.timber = 10;
    // p2 cannot spend p1's stock
    expect(applyGameCommand(game, 'p2', { type: 'sendTrade', item: 'timber', amount: 5, sourceId: p1Store.id, destinationId: p2Store.id }).ok).toBe(false);
    // p1 can
    expect(applyGameCommand(game, 'p1', { type: 'sendTrade', item: 'timber', amount: 5, sourceId: p1Store.id, destinationId: p2Store.id }).ok).toBe(true);
    expect(p1Store.stock!.timber).toBe(5);
  });

  it('demolish over an ally road is a silent no-op', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p2');
    const rx = store.x - 2, ry = store.y - 2;
    applyGameCommand(game, 'p2', { type: 'paintRoad', cells: [{ x: rx, y: ry }] });
    // the road stands and belongs to p2 — only p2 may drag-demolish it
    expect(game.demolishableAt(rx, ry, true, 'p2')).toBe(true);
    expect(game.demolishableAt(rx, ry, true, 'p1')).toBe(false);
    applyGameCommand(game, 'p1', { type: 'demolish', x: rx, y: ry, drag: true });
    expect(game.demolishableAt(rx, ry, true, 'p2')).toBe(true);
    applyGameCommand(game, 'p2', { type: 'demolish', x: rx, y: ry, drag: true });
    expect(game.demolishableAt(rx, ry, true, 'p2')).toBe(false);
  });

  it('never applies the lifecycle command inside the sim', () => {
    const { game } = makeTestGame();
    expect(applyGameCommand(game, 'p1', { type: 'startExpedition', seed: 1, level: 1 }).ok).toBe(false);
  });
});
