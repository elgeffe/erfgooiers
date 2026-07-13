import { describe, expect, it } from 'vitest';
import { gameplayFingerprintHash, makeOpenBattleGame, makeTestGame, tick } from './testHarness';

describe('Game deterministic regression guardrails', () => {
  it('preserves the seeded update trace across economy, trade, bell, training, and waves', () => {
    const { game } = makeTestGame({ seed: 731337 });
    const p1 = game.storeFor('p1');
    const p2 = game.storeFor('p2');

    expect(gameplayFingerprintHash(game)).toBe('81e0dddf');

    game.setEnemies({
      waves: [
        { kind: 'bandit', count: 2, at: 1, bonusTime: 7 },
        { kind: 'wolf', count: 1, whenArmy: 1, delay: 2 },
      ],
    });
    game.spawnFighter('soldier', { x: p1.x + 5, y: p1.y + 5 }, 'player', 'p1');
    expect(game.sendTrade('p1', 'timber', 3, p1.id, p2.id)).toBe(true);
    expect(game.trainUnit(game.guild, 'serf')).toBe(true);
    game.setBell('p1', true);

    expect(gameplayFingerprintHash(game)).toBe('0799dfc9');
    tick(game, 2);
    expect(gameplayFingerprintHash(game)).toBe('68715bd0');

    game.setBell('p1', false);
    tick(game, 18);
    expect(gameplayFingerprintHash(game)).toBe('66b35801');
  });

  it('launches a timed wave on its exact fixed-step boundary', () => {
    const { game } = makeTestGame({ seed: 99881, coop: false });
    game.setEnemies({ waves: [{ kind: 'bandit', count: 2, at: 1, bonusTime: 7 }] });

    tick(game, 0.95);
    expect(game.units.filter(unit => unit.role === 'bandit')).toHaveLength(0);
    expect(game.bonusTime).toBe(0);

    game.update(0.05);
    expect(game.units.filter(unit => unit.role === 'bandit')).toHaveLength(2);
    expect(game.bonusTime).toBe(7);
  });

  it('delays arrow damage until impact and sweeps one death on the impact tick', () => {
    const { game } = makeOpenBattleGame(7711);
    const archer = game.spawnFighter('archer', { x: 10, y: 10 }, 'player');
    const target = game.spawnFighter('bandit', { x: 13, y: 10 }, 'enemy');
    target.hp = target.maxHp = 1;
    target.dmg = 0;
    target.spd = 0;
    let deaths = 0;
    let kills = 0;
    game.onDeath = () => { deaths++; };
    game.onKill = () => { kills++; };
    // Invoke the private launch seam directly: this test locks projectile
    // timing independently from target-acquisition and archer movement policy.
    (game as any).fireArrow(archer, 'player', archer.mesh.position.x, 1.2, archer.mesh.position.z, target, archer.dmg);

    game.update(0.05);
    expect(target.hp).toBe(1);
    expect(game.units).toContain(target);

    let impactTick = 1;
    while (game.units.includes(target) && impactTick < 20) {
      game.update(0.05);
      impactTick++;
    }
    expect(impactTick).toBe(6);
    expect(deaths).toBe(1);
    expect(kills).toBe(1);
    expect(game.units).not.toContain(target);
  });
});
