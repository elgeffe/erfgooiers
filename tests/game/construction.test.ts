import { describe, expect, it } from 'vitest';
import { doorTile } from '../../src/game/util';
import { makeOpenBattleGame, tickUntil } from '../../src/game/testHarness';
import type { Site } from '../../src/types';
import type { World } from '../../src/world/World';

/** Seal the site's only work/delivery tile after legal placement, mirroring a
 * player completing solid curtain walls before adding a gate. */
function sealSiteDoor(world: World, site: Site): void {
  const door = doorTile(site);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const tile = world.T(door.x + dx, door.y + dy);
    if (!tile || tile.site) continue;
    tile.type = 'rock';
    tile.rock = 'peak';
  }
}

describe('construction dispatch', () => {
  it('lets the owner pass through wooden and stone gate sites while keeping rivals out', () => {
    const { game, world } = makeOpenBattleGame(9200, 40);
    game.setTeams({ p1: 0, p2: 1, enemy: 2, wild: 2 });
    const wooden = game.placeSite('woodgate', 6, 6, 0, 'p1');
    const stone = game.placeSite('gate', 12, 6, 1, 'p1');

    for (const gate of [wooden, stone]) {
      expect(world.passable(gate.x, gate.y, 'p1')).toBe(true);
      expect(world.passable(gate.x, gate.y, 'p2')).toBe(false);
      expect(world.passable(gate.x, gate.y, 'enemy')).toBe(false);
    }
  });

  it('skips an unreachable funded site so a builder can raise later reachable work', () => {
    const { game, world } = makeOpenBattleGame(9201, 40);
    const blocked = game.placeSite('bakery', 6, 6, 0, 'p1');
    const reachable = game.placeSite('bakery', 12, 6, 0, 'p1');
    for (const site of [blocked, reachable]) {
      for (const item in site.needs) site.delivered[item] = site.needs[item];
      site.ready = true;
    }
    sealSiteDoor(world, blocked);
    game.spawnUnit('laborer', 0xc97b3d, { x: 18, y: 18 }, 'p1');

    expect(tickUntil(game, () => !game.sites.includes(reachable), 30)).toBe(true);
    expect(game.sites).toContain(blocked);
    expect(game.buildings.some(building => building.key === 'bakery' && building.x === reachable.x && building.y === reachable.y)).toBe(true);
  });

  it('skips an unreachable delivery so serfs fund later reachable sites', () => {
    const { game, world } = makeOpenBattleGame(9202, 40);
    game.store.stock!.timber = 4;
    game.store.stock!.stone = 4;
    const blocked = game.placeSite('bakery', 6, 6, 0, 'p1');
    const reachable = game.placeSite('bakery', 12, 6, 0, 'p1');
    sealSiteDoor(world, blocked);
    game.spawnUnit('serf', 0xc9b18a, { x: 18, y: 18 }, 'p1');

    expect(tickUntil(game, () => reachable.ready, 90)).toBe(true);

    expect(blocked.delivered.timber || 0).toBe(0);
    expect(blocked.delivered.stone || 0).toBe(0);
  });
});
