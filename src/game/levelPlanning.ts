import type { BiomeKey } from '../data/biomes';
import type { EnemySetup, LevelDef } from '../data/levels';
import type { UnitKind } from '../data/units';
import type { WorldParams } from '../world/World';
import { ascensionArmyMult, ascensionPrepMult, ascensionTimerMult } from './RunState';

export interface LevelPlan {
  world: WorldParams;
  enemies: EnemySetup | null;
  hardTimer: number;
  prepMult: number;
  garrisonMult: number;
  bossHpMult: number;
}

/** Pure campaign/sandbox policy. Keeping this out of the composition root makes
 * level construction auditable without changing simulation or RNG ordering. */
export function planLevel(level: LevelDef, seed: number, biome: BiomeKey, ascension: number, sandbox: boolean): LevelPlan {
  const hellFinale = !sandbox && biome === 'hell';
  const world: WorldParams = { seed, ...level.world, biome };
  if (hellFinale) {
    world.w = (level.world.w ?? 48) + 24;
    world.h = (level.world.h ?? 48) + 24;
    world.frontiers = 3;
    world.treeStands = Math.round((level.world.treeStands ?? 8) * 1.7);
    world.oreVeins = Math.round((level.world.oreVeins ?? 6) * 1.8);
    world.goldPiles = (level.world.goldPiles ?? 4) + 8;
  }
  if (!sandbox && level.index === 10) world.lairStages = 4;
  if (!sandbox && level.type === 'Hunt' && ascension > 0) {
    const tiers = Math.min(3, ascension);
    world.w = (level.world.w ?? 46) + tiers * 10;
    world.h = (level.world.h ?? 46) + tiers * 10;
    world.treeStands = Math.round((level.world.treeStands ?? 8) * (1 + 0.22 * tiers));
    world.meadows = Math.round((level.world.meadows ?? 5) * (1 + 0.25 * tiers));
    world.goldPiles = (level.world.goldPiles ?? 3) + tiers * 2;
  }

  let enemies: EnemySetup | null = hellFinale && level.enemies && !level.enemies.stages
    ? { ...level.enemies, camps: [...(level.enemies.camps ?? []), { count: 4, guards: 14, kinds: ['skeleton', 'skelarcher', 'zombie', 'brute'] }] }
    : level.enemies ?? null;
  if (!sandbox && level.index === 10 && ascension > 0 && enemies?.stages) {
    const a = Math.min(4, ascension);
    enemies = { ...enemies, stages: enemies.stages.map(stage => 'boss' in stage ? stage : {
      ...stage,
      guards: stage.guards + a * 2,
      towers: (stage.towers ?? 0) + (stage.structure === 'camp' ? 0 : Math.ceil(a / 2)),
    }) };
  }
  if (!sandbox && enemies?.wild && level.type === 'Hunt' && ascension > 0) {
    const packMult = 1 + 0.4 * ascension;
    enemies = { ...enemies, wild: enemies.wild.map(w => ({ ...w, count: Math.round(w.count * packMult) })) };
  }
  if (!sandbox && enemies?.waves && ascension > 0 && level.index >= 5 && level.index <= 9) {
    const a = Math.min(4, ascension);
    const waveMult = 1 + 0.5 * a;
    const scaled = enemies.waves.map(w => ({ ...w, count: Math.max(1, Math.round(w.count * waveMult)) }));
    const roster: UnitKind[] = ['orc', 'skeleton', 'skelarcher', 'zombie', 'troll', 'bandit'];
    const extra = Array.from({ length: a }, (_, i) => ({ at: 240 + i * 150, kind: roster[i % roster.length], count: 3 + a + i }));
    enemies = { ...enemies, waves: [...scaled, ...extra] };
    if (ascension >= 3 && level.index >= 7) {
      enemies = { ...enemies, strongholds: { count: 1 + (ascension - 3), guards: 12, towers: 2, kinds: ['orc', 'troll', 'skeleton', 'skelarcher', 'zombie'] } };
    }
  }

  return {
    world,
    enemies,
    prepMult: sandbox ? 1 : ascensionPrepMult(ascension),
    garrisonMult: sandbox ? 1 : 1 + 0.35 * ascension,
    bossHpMult: sandbox ? 1 : 1 + 0.5 * ascension,
    hardTimer: Math.round(level.hardTimer * ascensionTimerMult(sandbox ? 0 : ascension) * (hellFinale ? 1.8 : 1)),
  };
}

export function planStartArmy(
  levelArmy: readonly { kind: UnitKind; count: number }[] | undefined,
  heroArmy: readonly { kind: UnitKind; count: number }[] | undefined,
  ascension: number,
  sandbox: boolean,
): { kind: UnitKind; count: number }[] {
  const groups: { kind: UnitKind; count: number }[] = [];
  const mult = sandbox ? 1 : ascensionArmyMult(ascension);
  for (const group of levelArmy ?? []) groups.push({ kind: group.kind, count: Math.max(1, Math.round(group.count * mult)) });
  if (heroArmy) groups.push(...heroArmy);
  return groups;
}
