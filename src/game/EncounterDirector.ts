import { UNITS, type UnitKind } from '../data/units';
import type { EnemySetup } from '../data/levels';
import type { World } from '../world/World';
import type { Building, BuildingKey, Unit } from '../types';
import { unitLabel } from './util';

type EnemyZone = World['enemyZones'][number];

/** Spawn/query operations supplied by Game. EncounterDirector owns scheduling
 * policy and state, while Game continues to own entities and map placement. */
export interface EncounterPort {
  now(): number;
  enemyZones(): EnemyZone[];
  garrisonMult(): number;
  deferBoss(): boolean;
  resetPlacement(): void;
  spawnWild(kind: UnitKind, count: number): void;
  spawnBoss(kind: UnitKind, fromEdge?: boolean, zone?: EnemyZone | null): void;
  spawnStronghold(key: BuildingKey, guards: number, kinds?: UnitKind[], zone?: EnemyZone): Building | null;
  spawnCampNear(x: number, y: number, guards: number, kinds: UnitKind[]): void;
  fortifyStronghold(building: Building): void;
  spawnTowerNear(building: Building): void;
  spawnRaid(kind: UnitKind, count: number, from: 'edge' | 'camp'): Unit[];
  summonWave(kind: UnitKind, count: number): number;
  playerFighters(): number;
  enemyStructuresLeft(): number;
  onWaveCleared(): void;
  toast(message: string, cls?: string): void;
  sfx(name: string): void;
}

/** Deterministic enemy encounter policy: configured presence, raid waves,
 * commander reinforcements, deferred bosses, and sandbox wave scheduling. */
export class EncounterDirector {
  bonusTime = 0;
  prepMult = 1;

  private enemy: EnemySetup | null = null;
  private waveIdx = 0;
  private waves: { units: Unit[]; cleared: boolean }[] = [];
  private commanderT = 0;
  private waveArmT: number | null = null;
  private pendingBoss: UnitKind | null = null;
  private readonly pendingWaves: { kind: UnitKind; count: number; at: number }[] = [];

  constructor(private readonly port: EncounterPort) {}

  configure(setup: EnemySetup | null): void {
    this.enemy = setup;
    this.waveIdx = 0;
    this.waves = [];
    this.commanderT = 0;
    this.waveArmT = null;
    this.bonusTime = 0;
    this.port.resetPlacement();
    if (!setup) return;
    if (setup.commander) this.commanderT = -setup.commander.every * 0.75;
    if (setup.wild) for (const wild of setup.wild) this.port.spawnWild(wild.kind, wild.count);
    if (setup.stages) {
      const zones = this.port.enemyZones();
      for (let i = 0; i < setup.stages.length; i++) {
        const stage = setup.stages[i];
        const zone = zones[Math.min(i, zones.length - 1)];
        if ('boss' in stage) {
          this.port.spawnBoss(stage.boss, false, zone ?? null);
          continue;
        }
        const key: BuildingKey = stage.structure === 'camp' ? 'banditcamp' : 'enemycastle';
        const stronghold = this.port.spawnStronghold(key, stage.guards, stage.kinds, zone);
        if (!stronghold) continue;
        if (stage.structure === 'walledFortress') this.port.fortifyStronghold(stronghold);
        for (let tower = 0; tower < (stage.towers ?? 0); tower++) this.port.spawnTowerNear(stronghold);
      }
    } else if (setup.gatecamps) {
      for (const zone of this.port.enemyZones()) {
        const total = Math.round(setup.gatecamps.guards * this.port.garrisonMult());
        this.port.spawnCampNear(zone.pass.x, zone.pass.y, total, setup.gatecamps.kinds ?? ['bandit']);
      }
    }
    if (!setup.stages && setup.camps) {
      for (const camp of setup.camps) {
        for (let i = 0; i < camp.count; i++) this.port.spawnStronghold('banditcamp', camp.guards, camp.kinds);
      }
    }
    if (!setup.stages && setup.keep) {
      const keep = this.port.spawnStronghold('enemycastle', setup.keep.guards, setup.keep.kinds);
      if (keep && setup.towers) for (let i = 0; i < setup.towers; i++) this.port.spawnTowerNear(keep);
      if (keep && setup.keep.fortified) this.port.fortifyStronghold(keep);
    }
    if (!setup.stages && setup.strongholds) {
      const strongholds = setup.strongholds;
      for (let i = 0; i < strongholds.count; i++) {
        const keep = this.port.spawnStronghold('enemycastle', strongholds.guards, strongholds.kinds);
        if (!keep) continue;
        this.port.fortifyStronghold(keep);
        for (let tower = 0; tower < (strongholds.towers ?? 2); tower++) this.port.spawnTowerNear(keep);
      }
    }
    this.pendingBoss = null;
    if (setup.boss) {
      if (this.port.deferBoss() && this.port.enemyStructuresLeft() > 0) {
        this.pendingBoss = setup.boss;
        this.port.toast(`Raze every enemy stronghold first — only then will the ${UNITS[setup.boss].name} reveal itself`, 'err');
      } else this.port.spawnBoss(setup.boss);
    }
  }

  nextWave(): { in: number; count: number; label?: string } | null {
    const waves = this.enemy?.waves;
    if (!waves || this.waveIdx >= waves.length) return null;
    const wave = waves[this.waveIdx];
    if (wave.at !== undefined) return { in: Math.max(0, wave.at * this.prepMult - this.port.now()), count: wave.count };
    if (this.waveArmT !== null) return { in: Math.max(0, this.waveArmT - this.port.now()), count: wave.count };
    return { in: Infinity, count: wave.count, label: `Raiders are watching — mustering ${wave.whenArmy ?? 1} fighters will provoke them` };
  }

  update(dt: number): void {
    if (this.enemy) {
      if (this.pendingBoss && this.port.enemyStructuresLeft() === 0) {
        const kind = this.pendingBoss;
        this.pendingBoss = null;
        this.port.spawnBoss(kind, true);
      }
      const definitions = this.enemy.waves;
      while (definitions && this.waveIdx < definitions.length) {
        const wave = definitions[this.waveIdx];
        let launch = false;
        if (wave.at !== undefined) launch = this.port.now() >= wave.at * this.prepMult;
        else if (this.waveArmT !== null) launch = this.port.now() >= this.waveArmT;
        else if (this.port.playerFighters() >= (wave.whenArmy ?? 1)) {
          this.waveArmT = this.port.now() + (wave.delay ?? 45) * this.prepMult;
          this.port.toast('Your muster has been spotted — raiders are gathering!', 'err');
          this.port.sfx('error');
        }
        if (!launch) break;
        this.waveIdx++;
        this.waveArmT = null;
        if (wave.bonusTime) {
          this.bonusTime += wave.bonusTime;
          this.port.toast(`+${wave.bonusTime}s on the clock for the fight ahead`);
        }
        this.waves.push({ units: this.port.spawnRaid(wave.kind, wave.count, 'edge'), cleared: false });
        this.port.toast('A raid approaches!', 'err');
        this.port.sfx('error');
      }
      for (const wave of this.waves) {
        if (wave.cleared || !wave.units.length) continue;
        if (wave.units.every(unit => unit.dead)) {
          wave.cleared = true;
          this.port.onWaveCleared();
          this.port.toast('Raid repelled!');
        }
      }
      const commander = this.enemy.commander;
      if (commander && (commander.from !== 'camp' || this.port.enemyStructuresLeft() > 0)) {
        this.commanderT += dt;
        if (this.commanderT >= commander.every) {
          this.commanderT = 0;
          this.port.spawnRaid(commander.kind, commander.count, commander.from ?? 'camp');
        }
      }
    }
    this.launchPendingWaves();
  }

  scheduleWave(kind: UnitKind, count: number, delay: number): void {
    if (delay <= 0) {
      this.port.summonWave(kind, count);
      return;
    }
    this.pendingWaves.push({ kind, count, at: this.port.now() + delay });
    this.pendingWaves.sort((a, b) => a.at - b.at);
  }

  nextScheduledWave(): { in: number; count: number } | null {
    const wave = this.pendingWaves[0];
    return wave ? { in: Math.max(0, wave.at - this.port.now()), count: wave.count } : null;
  }

  scheduledWavesPending(): boolean {
    const waves = this.enemy?.waves;
    return !!waves && this.waveIdx < waves.length;
  }

  private launchPendingWaves(): void {
    while (this.pendingWaves.length && this.port.now() >= this.pendingWaves[0].at) {
      const wave = this.pendingWaves.shift()!;
      const spawned = this.port.summonWave(wave.kind, wave.count);
      if (spawned) {
        this.port.toast(`The scheduled wave marches — ${spawned} ${unitLabel(wave.kind).toLowerCase()}${spawned > 1 ? 's' : ''}!`, 'err');
        this.port.sfx('error');
      }
    }
  }
}
