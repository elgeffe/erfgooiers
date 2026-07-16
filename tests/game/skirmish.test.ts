import { describe, expect, it } from 'vitest';
import { makeTestGame } from '../../src/game/testHarness';
import { applyGameCommand } from '../../src/game/commands';
import { Objective } from '../../src/game/Objectives';
import type { Game } from '../../src/game/Game';

/** Put the game in 1v1 skirmish diplomacy: each player on their own team. */
function armSkirmish(game: Game): void {
  game.setTeams({ p1: 0, p2: 1, enemy: 2, wild: 2 });
}

describe('skirmish diplomacy', () => {
  it('keeps the co-op default truth table: players allied, both fight enemy and wild', () => {
    const { game } = makeTestGame();
    expect(game.hostileOwners('p1', 'p2')).toBe(false);
    expect(game.hostileOwners('p1', 'p1')).toBe(false);
    expect(game.hostileOwners('p1', 'enemy')).toBe(true);
    expect(game.hostileOwners('p2', 'wild')).toBe(true);
    expect(game.hostileOwners('enemy', 'wild')).toBe(false);
    expect(game.pvp).toBe(false);
  });

  it('skirmish teams make the two players mutually hostile', () => {
    const { game } = makeTestGame();
    armSkirmish(game);
    expect(game.pvp).toBe(true);
    expect(game.hostileOwners('p1', 'p2')).toBe(true);
    expect(game.hostileOwners('p2', 'p1')).toBe(true);
    expect(game.hostileOwners('p1', 'p1')).toBe(false);
    expect(game.hostileOwners('p1', 'enemy')).toBe(true);
  });

  it('rejects attack orders on the ally in co-op but accepts them in skirmish', () => {
    const { game } = makeTestGame();
    const mine = game.spawnSquad('soldier', 2, 0, 0, 'player', 'p1');
    const rival = game.spawnSquad('soldier', 1, 2, 2, 'player', 'p2')[0];
    const order = () => applyGameCommand(game, 'p1', {
      type: 'orderUnits', unitIds: mine.map(u => u.id),
      order: { type: 'attack', targetId: rival.id }, formation: 'box',
    });
    expect(order().ok).toBe(false);
    armSkirmish(game);
    expect(order().ok).toBe(true);
    expect(mine.every(u => u.order?.foe === rival)).toBe(true);
  });

  it('accepts a siege order on the rival storehouse in skirmish only', () => {
    const { game } = makeTestGame();
    const mine = game.spawnSquad('soldier', 2, 0, 0, 'player', 'p1');
    const rivalStore = game.storeFor('p2');
    const order = () => applyGameCommand(game, 'p1', {
      type: 'orderUnits', unitIds: mine.map(u => u.id),
      order: { type: 'attackBuilding', targetId: rivalStore.id }, formation: 'box',
    });
    expect(order().ok).toBe(false);
    armSkirmish(game);
    expect(order().ok).toBe(true);
  });

  it('a fallen storehouse eliminates its owner without tripping the shared defeat flag', () => {
    const { game } = makeTestGame();
    armSkirmish(game);
    const rivalStore = game.storeFor('p2');
    rivalStore.hp = 1;
    const attacker = game.spawnSquad('soldier', 1, 0, 0, 'player', 'p1')[0];
    (game as any).damageSystem.attackBuilding(attacker, rivalStore);
    expect(game.eliminated.has('p2')).toBe(true);
    expect(game.eliminated.has('p1')).toBe(false);
    expect(game.defeat).toBe(false); // main resolves PvP off `eliminated`
  });

  it('the same castle loss still defeats a co-op run', () => {
    const { game } = makeTestGame();
    const store = game.storeFor('p2');
    store.hp = 1;
    const raider = game.spawnSquad('soldier', 1, 0, 0, 'enemy', 'enemy')[0];
    (game as any).damageSystem.attackBuilding(raider, store);
    expect(game.defeat).toBe(true);
  });

  it('the skirmish objective completes once any player is eliminated', () => {
    const { game } = makeTestGame();
    armSkirmish(game);
    const objective = new Objective({ kind: 'skirmish' });
    expect(objective.evaluate(game).done).toBe(false);
    game.eliminated.add('p2');
    expect(objective.evaluate(game).done).toBe(true);
  });

  it('allies walk through each other\'s gates but skirmish rivals are walled out', () => {
    const { game, world } = makeTestGame();
    const gate = game.placeBuilding('gate', 10, 10, true, 0, 'player', 'p2');
    expect(gate.def.gate).toBe(true);
    expect(world.passable(gate.x, gate.y, 'p2')).toBe(true);      // own gate
    expect(world.passable(gate.x, gate.y, 'p1')).toBe(true);      // co-op ally
    expect(world.passable(gate.x, gate.y, 'enemy')).toBe(false);  // raiders must break it
    armSkirmish(game);
    expect(world.passable(gate.x, gate.y, 'p1')).toBe(false);     // rival is walled out
    expect(world.passable(gate.x, gate.y, 'p2')).toBe(true);
  });

  it('skirmish soldiers auto-acquire the rival player\'s units', () => {
    const { game } = makeTestGame();
    armSkirmish(game);
    const mine = game.spawnSquad('soldier', 1, 0, 0, 'player', 'p1')[0];
    const rival = game.spawnSquad('soldier', 1, 1, 1, 'player', 'p2')[0];
    game.update(0.05); // refresh the unit spatial index
    const target = (game as any).combatTargeting.acquireUnit(mine, 8);
    expect(target).toBe(rival);
  });
});
