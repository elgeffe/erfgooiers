import { findPath } from '../engine/pathfinding';
import { UNITS } from '../data/units';
import { doorTile } from '../game/util';
import type { Building, Coord, Unit } from '../types';
import type { GameCommand } from '../net/protocol';
import type { PolicyContext } from './strategy/types';

/**
 * Squad bookkeeping and the army state machine, shared by every macro policy
 * that fields an army: muster near home, defend when hostiles close in
 * (after the profile's human-like reaction delay), attack the rival castle at
 * the profile's army threshold, retreat when the squad bleeds out. Decisions
 * are committed — orders re-issue on a slow clock, never per tick, so the
 * army follows a plan instead of flapping.
 */

/** Ring the bell at this many attackers (and more of them than defenders). */
const BELL_THREAT = 5;
/** Re-issue standing orders no faster than this (seconds). */
const REORDER_INTERVAL = 10;
/** Switch from the marching wave to an explicit castle siege this close. */
const SIEGE_RANGE = 12;

/** A reactive force smaller than the scheduled wave seizes an opening; it does
 * not consume that wave's escalation step. Otherwise one successful defence
 * could turn a 33-unit counterstroke into a demand for a 52-unit second wave. */
export function advancesScheduledWave(
  wasCounterattack: boolean, launchSize: number, scheduledTarget: number,
): boolean {
  return !wasCounterattack || launchSize >= scheduledTarget;
}

type Mode = 'muster' | 'defend' | 'attack';

export class Tactics {
  private mode: Mode = 'muster';
  private squad = new Set<number>();
  private raiders = new Set<number>();
  /** Persistent fair equivalents of Shift+number control groups. */
  private flankers = new Set<number>();
  private support = new Set<number>();
  private flankPoint: Coord | null = null;
  private mainEngagedAt: number | null = null;
  private lastGroupOrderAt = -Infinity;
  private counterattackReady = false;
  private launchSize = 0;
  private wavesLaunched = 0;
  private lastAttackAt = -Infinity;
  private lastRaidAt = -Infinity;
  private lastOrderAt = -Infinity;
  private lastDefendTarget: Coord | null = null;
  private threatSince: number | null = null;
  private bellOn = false;
  private sieging = false;
  private allIn = false;
  private lastRepairAt = -Infinity;
  /** First launched attack (sim seconds) — the stance-separation metric. */
  firstAttackAt: number | null = null;

  step(ctx: PolicyContext): GameCommand[] {
    const { view, profile } = ctx;
    if (!view.store) return [];
    const commands: GameCommand[] = [];
    const alive = new Set(view.army.map(unit => unit.id));
    for (const id of this.squad) if (!alive.has(id)) this.squad.delete(id);
    for (const id of this.raiders) if (!alive.has(id)) this.raiders.delete(id);
    for (const id of this.flankers) if (!alive.has(id)) this.flankers.delete(id);
    for (const id of this.support) if (!alive.has(id)) this.support.delete(id);

    // Every fighter stands defensive: fight around the post, then WALK BACK.
    // Auto-stance pursuit is the classic suicide — chase a beaten rush across
    // the map, die under the rival castle's arrows. The stance re-posts on
    // every ordered march, so attacks and raids are unaffected.
    const undisciplined = view.army.filter(unit => unit.stance !== 'defensive');
    if (undisciplined.length) {
      commands.push({ type: 'setStance', unitIds: undisciplined.map(unit => unit.id), stance: 'defensive' });
    }

    // ---- reaction-delayed threat tracking ----
    if (view.threats.length) {
      this.threatSince ??= view.elapsed;
    } else {
      this.threatSince = null;
      if (this.mode === 'defend') {
        // Resume a still-live expedition after a local probe is cleared. Only a
        // serious recall clears `squad`; smaller attacks should not erase the
        // committed offensive plan.
        if (!this.squad.size && profile.attackEnabled
          && view.armySize >= Math.ceil(profile.attackArmy * 0.65)) this.counterattackReady = true;
        this.mode = this.squad.size ? 'attack' : 'muster';
        this.lastOrderAt = -Infinity;
      }
    }
    const reacting = this.threatSince !== null && view.elapsed - this.threatSince >= profile.reactionDelay;

    // ---- the town bell: shelter workers under a real assault ----
    const besieged = reacting && view.threats.length >= BELL_THREAT && view.threats.length > view.armySize;
    if (profile.useBell && besieged !== this.bellOn) {
      this.bellOn = besieged;
      commands.push({ type: 'setBell', active: besieged });
    }

    // ---- keep the roof on: order repairs, the castle above all ----
    const repair = this.planRepair(ctx);
    if (repair) commands.push(repair);

    if (reacting && view.threatCentroid) {
      return [...this.defend(ctx), ...commands];
    }

    if (this.mode === 'attack') {
      return [...this.pressAttack(ctx), ...commands];
    }

    return [...this.muster(ctx), ...commands];
  }

  // ---- repairs: a battered base is mended, not abandoned ----
  /** Open a repair order on the most battered own building. The CASTLE
   *  outranks everything and is ordered at the first real dent — losing it IS
   *  losing the match — while lesser buildings only earn a crew once half
   *  their health is gone. One order per pass on a slow clock, so a burning
   *  base doesn't drown the APM budget in repair clicks. The order itself is
   *  physical (serfs haul materials, a builder works), so this stays fair. */
  private planRepair(ctx: PolicyContext): GameCommand | null {
    const { game, view } = ctx;
    if (view.elapsed - this.lastRepairAt < 5) return null;
    let target: Building | null = null;
    let bestScore = 0;
    for (const building of view.buildings) {
      if (!game.canRepair(building)) continue;
      const ratio = building.hp / building.maxHp;
      const isCastle = !!building.def.store;
      if (isCastle ? ratio > 0.8 : ratio > 0.5) continue;
      const score = (1 - ratio) + (isCastle ? 10 : 0);
      if (score > bestScore) { bestScore = score; target = building; }
    }
    if (!target) return null;
    this.lastRepairAt = view.elapsed;
    return { type: 'repair', buildingId: target.id };
  }

  // ---- defense: throw the home army at the intruders ----
  private defend(ctx: PolicyContext): GameCommand[] {
    const { view } = ctx;
    const target = view.threatCentroid!;
    const moved = !this.lastDefendTarget
      || Math.max(Math.abs(target.x - this.lastDefendTarget.x), Math.abs(target.y - this.lastDefendTarget.y)) > 4;
    const due = view.elapsed - this.lastOrderAt >= REORDER_INTERVAL;
    // a serious breach recalls the attack wave; a skirmisher probe does not
    const recall = view.threats.length > view.armySize - this.squad.size;
    if (this.mode !== 'defend') { this.mode = 'defend'; this.lastOrderAt = -Infinity; }
    if (!moved && !due) return [];
    const defenders = view.army.filter(unit => recall || !this.squad.has(unit.id));
    if (recall) { this.squad.clear(); this.raiders.clear(); this.clearWaveGroups(); }
    if (!defenders.length) return [];
    this.lastDefendTarget = { ...target };
    this.lastOrderAt = view.elapsed;
    return [{
      type: 'orderUnits', unitIds: defenders.map(unit => unit.id),
      order: { type: 'attackMove', x: target.x, y: target.y }, formation: 'box',
    }];
  }

  // ---- peacetime: keep the growing army mustered on the approach ----
  private muster(ctx: PolicyContext): GameCommand[] {
    const { view, profile } = ctx;
    const commands: GameCommand[] = [];
    this.mode = 'muster';

    // Launch once the muster is strong enough (committed cooldown passed).
    // A defended castle punishes even odds hard (defenders + castle arrows),
    // so demand a real numbers advantage — but never wait on a rival with no
    // army left: an empty base is razed with whatever stands. Higher
    // difficulties keep a standing garrison at home while the wave marches.
    // Under fog an unseen army reads as 0 — that shortcut only applies when
    // the count is trustworthy (full visibility), or every profile would
    // suicide-rush at the 4-fighter floor against a rival it never scouted.
    const enemyKnown = !ctx.game.fogOfWar || view.enemyArmySize > 0;
    const waveTarget = Math.min(profile.armyCap, profile.attackArmy + this.wavesLaunched * profile.waveGrowth);
    const normalNeeded = Math.max(4, enemyKnown
      ? Math.min(waveTarget, Math.max(profile.attackArmy, Math.ceil(view.enemyArmySize * 1.5) + 4))
      : waveTarget);
    // A force that just broke an assault already has initiative and local
    // information. Convert that won field into a counterstroke instead of
    // walking home to wait for the pristine peacetime composition again.
    const counterNeeded = Math.max(12, Math.ceil(profile.attackArmy * 0.65), Math.ceil(view.enemyArmySize * 1.4) + 3);
    const needed = this.counterattackReady ? Math.min(normalNeeded, counterNeeded) : normalNeeded;
    // THE FINISHER: once the army fills the cap the economy has nothing bigger
    // to build toward, so massing further is wasted time — commit EVERYTHING
    // (no home guard) to a decisive assault, and (in pressAttack) fight it to
    // the death instead of retreating. This is what converts the deep economy
    // and its siege into an actual win rather than a timeout draw.
    this.allIn = profile.attackEnabled
      && view.armySize >= Math.max(needed, Math.round(profile.armyCap * 0.85));
    // A WALLED rival is never assaulted piecemeal: a periodic mid-size wave just
    // bleeds out on the curtain and its towers while the turtle masses behind it.
    // Against fortifications, hold for the full siege-backed
    // FINISHER — the trebuchets that actually break the wall — and commit once.
    const siege = view.army.filter(unit => (UNITS[unit.role as keyof typeof UNITS]?.structureMult ?? 1) > 1).length;
    // A reactive conventional army may exploit a won defence, but a profile
    // explicitly built around siege does not abandon that identity after one
    // skirmish. Godlike still waits for its structural core before marching.
    const counterCompositionReady = profile.minSiege === 0 && this.counterattackReady
      && view.armySize >= Math.ceil(profile.attackArmy * 0.75);
    const compositionReady = siege >= profile.minSiege || counterCompositionReady;
    const canLaunch = compositionReady
      && (view.enemyBulwarks.length === 0 || siege >= Math.max(2, profile.minSiege) || this.allIn);
    // the garrison is best-effort surplus, never a reason to delay the launch:
    // demanding wave + full guard before marching left Godlike massing forever
    const guard = this.allIn ? 0 : Math.min(Math.ceil(view.armySize * profile.homeGuard), Math.max(0, view.armySize - needed));
    if (profile.attackEnabled && canLaunch && view.armySize - guard >= needed
      && view.elapsed - this.lastAttackAt >= profile.minAttackInterval
      && view.enemyStore) {
      const wasCounterattack = this.counterattackReady;
      // Premium combined-arms units belong in the wave, not accidentally in the
      // home guard merely because they were trained most recently.
      const wave = [...view.army]
        .sort((a, b) => this.attackPriority(b) - this.attackPriority(a) || a.id - b.id)
        .slice(0, view.armySize - guard);
      this.squad = new Set(wave.map(unit => unit.id));
      for (const id of this.squad) this.raiders.delete(id);
      this.launchSize = this.squad.size;
      if (advancesScheduledWave(wasCounterattack, this.launchSize, waveTarget)) this.wavesLaunched++;
      this.counterattackReady = false;
      this.lastAttackAt = view.elapsed;
      this.firstAttackAt ??= view.elapsed;
      this.mode = 'attack';
      this.sieging = false;
      this.lastOrderAt = view.elapsed;
      const store = view.enemyStore;
      this.prepareWaveGroups(wave, profile.flankSize);
      const main = wave.filter(unit => !this.flankers.has(unit.id) && !this.support.has(unit.id));
      const vanguard = main.length ? main : wave;
      return [{
        type: 'orderUnits', unitIds: vanguard.map(unit => unit.id),
        order: { type: 'attackMove', x: store.x, y: store.y + 2 }, formation: 'line',
      }];
    }

    // Harassment raids between waves (higher difficulties): a small party
    // rides at the rival base to bleed workers, scout, and force reactions —
    // but never into a garrison that outnumbers it (a beaten raid invites the
    // counter-chase that razes half the home base), and never once the rival
    // has WALLED UP: a light raid party just dies on the curtain and its
    // towers, feeding the turtle instead of pestering it. Raids harass an open
    // economy; a fortified one is cracked by the main wave and its siege.
    if (profile.attackEnabled && profile.raidSize > 0 && view.enemyStore && !this.raiders.size
      && view.enemyArmySize < profile.raidSize
      && view.enemyBulwarks.length === 0
      && view.elapsed - this.lastRaidAt >= profile.raidInterval
      && view.armySize - guard >= profile.raidSize + 4) {
      // The harassment group is the fast mounted wing. Sending the six oldest
      // starting footmen into castle arrows was neither scouting nor flanking.
      const party = view.army.filter(unit => !this.squad.has(unit.id)
        && UNITS[unit.role as keyof typeof UNITS]?.tags?.includes('mounted'))
        .sort((a, b) => a.id - b.id)
        .slice(0, profile.raidSize);
      if (party.length === profile.raidSize) {
        this.raiders = new Set(party.map(unit => unit.id));
        this.lastRaidAt = view.elapsed;
        this.firstAttackAt ??= view.elapsed; // a raid IS the first aggression
        const store = view.enemyStore;
        commands.push({
          type: 'orderUnits', unitIds: party.map(unit => unit.id),
          order: { type: 'attackMove', x: store.x, y: store.y + 2 }, formation: 'box',
        });
      }
    }
    // hit-and-run: the first casualty sends the party home — raids harass and
    // scout, they do not trade armies
    if (this.raiders.size) {
      const alive = view.army.filter(unit => this.raiders.has(unit.id));
      if (alive.length < profile.raidSize) {
        this.raiders.clear();
        if (alive.length) {
          commands.push({
            type: 'orderUnits', unitIds: alive.map(unit => unit.id),
            order: { type: 'move', x: ctx.approach.x, y: ctx.approach.y }, formation: 'box',
          });
        }
      }
    }

    // rally-point upkeep: fresh recruits should walk to the muster, not the door
    const muster = ctx.approach;
    for (const building of view.buildings) {
      if (!building.def.military) continue;
      const rally = building.rally;
      if (rally && Math.max(Math.abs(rally.x - muster.x), Math.abs(rally.y - muster.y)) <= 4) continue;
      commands.push({ type: 'setRally', buildingId: building.id, x: muster.x, y: muster.y });
      break; // one per pass keeps APM honest
    }

    // walk the standing army (start army included) onto the muster ground
    if (view.elapsed - this.lastOrderAt >= REORDER_INTERVAL) {
      const strays = view.army.filter(unit => !unit.order && !this.raiders.has(unit.id)
        && Math.max(Math.abs(unit.tx - muster.x), Math.abs(unit.ty - muster.y)) > 8);
      if (strays.length) {
        this.lastOrderAt = view.elapsed;
        commands.push({
          type: 'orderUnits', unitIds: strays.map(unit => unit.id),
          order: { type: 'attackMove', x: muster.x, y: muster.y }, formation: 'box',
        });
      }
    }
    return commands;
  }

  private attackPriority(unit: Unit): number {
    const def = UNITS[unit.role as keyof typeof UNITS];
    if (!def) return 0;
    if ((def.structureMult ?? 1) > 1) return 100;
    if (def.heal) return 90;
    if (def.tags?.includes('mounted')) return 80;
    if (unit.role === 'knight') return 70;
    if (def.range > 1.6) return 60;
    return 50;
  }

  private prepareWaveGroups(wave: Unit[], flankSize: number): void {
    this.clearWaveGroups();
    if (flankSize <= 0) return;
    const mounted = wave
      .filter(unit => UNITS[unit.role as keyof typeof UNITS]?.tags?.includes('mounted'))
      .sort((a, b) => a.id - b.id)
      .slice(0, flankSize);
    // A pair is a patrol, not an envelopment. Fall back to the proven single
    // formation until a real mounted wing exists.
    if (mounted.length < 3) return;
    this.flankers = new Set(mounted.map(unit => unit.id));
    this.support = new Set(wave
      .filter(unit => {
        const def = UNITS[unit.role as keyof typeof UNITS];
        return def?.model === 'siege' || !!def?.heal;
      })
      .map(unit => unit.id));
  }

  private clearWaveGroups(): void {
    this.flankers.clear();
    this.support.clear();
    this.flankPoint = null;
    this.mainEngagedAt = null;
    this.lastGroupOrderAt = -Infinity;
  }

  // ---- the launched attack: march, then siege, or cut losses ----
  private pressAttack(ctx: PolicyContext): GameCommand[] {
    const { view, profile } = ctx;
    const squadUnits = view.army.filter(unit => this.squad.has(unit.id));
    const store = view.enemyStore;
    if (!store || !squadUnits.length) {
      this.squad.clear();
      this.clearWaveGroups();
      this.mode = 'muster';
      this.lastOrderAt = -Infinity;
      return [];
    }
    // cut losses: below the retreat fraction the survivors walk home to re-mass
    // — but an ALL-IN finisher fights to the death (a low floor), because
    // there is no bigger army to re-mass into and a razed enemy storehouse ends
    // the match outright
    // Marching losses are a reason to disengage; a breach already converted
    // into a focused castle siege is not. Leaving at 49% while the keep was
    // actively falling let its repair crew erase every wave's progress.
    const retreatRatio = this.allIn || this.sieging ? 0.12 : profile.retreatRatio;
    const fieldWon = view.enemyArmySize <= Math.max(3, Math.floor(squadUnits.length * 0.4));
    if (squadUnits.length < Math.ceil(this.launchSize * retreatRatio) && !fieldWon) {
      this.squad.clear();
      this.clearWaveGroups();
      this.mode = 'muster';
      this.lastOrderAt = view.elapsed;
      return [{
        type: 'orderUnits', unitIds: squadUnits.map(unit => unit.id),
        order: { type: 'move', x: ctx.approach.x, y: ctx.approach.y }, formation: 'box',
      }];
    }
    const groups = this.coordinateCombinedArms(ctx, squadUnits, store);
    if (groups.waiting) return groups.command ? [groups.command] : [];
    if (view.elapsed - this.lastOrderAt < REORDER_INTERVAL) return [];
    // A walled rival is breached, not wandered around: when no ground route
    // to the castle door exists, the wave focuses the nearest curtain piece —
    // gates first (weakest, and a fallen gate IS the road in).
    if (!this.sieging && view.enemyBulwarks.length) {
      const breach = this.breachTarget(ctx, squadUnits, store);
      if (breach) {
        this.lastOrderAt = view.elapsed;
        return [{
          type: 'orderUnits', unitIds: squadUnits.map(unit => unit.id),
          order: { type: 'attackBuilding', targetId: breach.id }, formation: 'box',
        }];
      }
    }
    // Once the local defenders are broken, remove the arrow towers before
    // committing to the keep. Attack-move is good at winning the field but can
    // drift past static emplacements; focusing the castle first makes the
    // whole wave ignore both towers and surviving defenders.
    if (!this.sieging && fieldWon && view.enemyTowers.length) {
      const tower = this.nearestBuilding(squadUnits, view.enemyTowers);
      this.lastOrderAt = view.elapsed;
      return [{
        type: 'orderUnits', unitIds: squadUnits.map(unit => unit.id),
        order: { type: 'attackBuilding', targetId: tower.id }, formation: 'box',
      }];
    }
    // close enough: focus the castle itself instead of drifting through the base
    let near = 0;
    for (const unit of squadUnits) {
      if (Math.max(Math.abs(unit.tx - store.x), Math.abs(unit.ty - store.y)) <= SIEGE_RANGE) near++;
    }
    // Do not tell the whole line to stare at masonry while an intact garrison
    // is cutting it down. `attackBuilding` intentionally suppresses unit
    // targeting, so the field army must first win the local fight; only the
    // surviving demolition force then focuses the keep.
    const defendersBroken = view.enemyArmySize <= Math.max(2, Math.floor(squadUnits.length * 0.2));
    if (!this.sieging && defendersBroken && near >= squadUnits.length * 0.5) {
      this.sieging = true;
      this.lastOrderAt = view.elapsed;
      return [{
        type: 'orderUnits', unitIds: squadUnits.map(unit => unit.id),
        order: { type: 'attackBuilding', targetId: store.id }, formation: 'box',
      }];
    }
    return this.pressStragglers(ctx, squadUnits, store);
  }

  /** Stage cavalry off-axis while the foot line advances, then release the
   *  mounted wing and finally the slow siege/healer column once contact is
   *  real. Every phase is inferred from observed unit orders/positions, so an
   *  APM-throttled command is retried instead of silently advancing state. */
  private coordinateCombinedArms(
    ctx: PolicyContext, squadUnits: Unit[], store: Building,
  ): { waiting: boolean; command: GameCommand | null } {
    if (!this.flankers.size) return { waiting: false, command: null };
    const { view } = ctx;
    const flankers = squadUnits.filter(unit => this.flankers.has(unit.id));
    const support = squadUnits.filter(unit => this.support.has(unit.id));
    const main = squadUnits.filter(unit => !this.flankers.has(unit.id) && !this.support.has(unit.id));
    if (!flankers.length) { this.clearWaveGroups(); return { waiting: false, command: null }; }

    this.flankPoint ??= this.chooseFlankPoint(ctx, flankers, store);
    const mainEngaged = !main.length || main.some(unit => !!unit.foe || !!unit.foeB
      || Math.max(Math.abs(unit.tx - store.x), Math.abs(unit.ty - store.y)) <= 20);
    if (mainEngaged) this.mainEngagedAt ??= view.elapsed;
    const due = view.elapsed - this.lastGroupOrderAt >= 3;

    if (!mainEngaged && this.flankPoint) {
      const staged = this.groupNear(flankers, this.flankPoint, 5);
      const headingThere = flankers.some(unit => this.orderNear(unit, this.flankPoint!, 4));
      if (!staged && !headingThere && due) {
        this.lastGroupOrderAt = view.elapsed;
        return { waiting: true, command: {
          type: 'orderUnits', unitIds: flankers.map(unit => unit.id),
          order: { type: 'move', x: this.flankPoint.x, y: this.flankPoint.y }, formation: 'column',
        } };
      }
      return { waiting: true, command: null };
    }

    const flankReleased = flankers.some(unit => !!unit.foe || this.orderNear(unit, store, 5));
    if (!flankReleased && due) {
      this.lastGroupOrderAt = view.elapsed;
      return { waiting: true, command: {
        type: 'orderUnits', unitIds: flankers.map(unit => unit.id),
        order: { type: 'attackMove', x: store.x, y: store.y + 2 }, formation: 'column',
      } };
    }

    const supportReleased = !support.length || support.some(unit => !!unit.foe || !!unit.foeB || this.orderNear(unit, store, 5));
    if (!supportReleased && this.mainEngagedAt !== null && view.elapsed - this.mainEngagedAt >= 2 && due) {
      this.lastGroupOrderAt = view.elapsed;
      return { waiting: true, command: {
        type: 'orderUnits', unitIds: support.map(unit => unit.id),
        order: { type: 'attackMove', x: store.x, y: store.y + 2 }, formation: 'column',
      } };
    }
    return { waiting: !flankReleased || !supportReleased, command: null };
  }

  private chooseFlankPoint(ctx: PolicyContext, units: Unit[], store: Building): Coord | null {
    const home = ctx.view.store!;
    const dx = store.x - home.x, dy = store.y - home.y;
    const length = Math.hypot(dx, dy) || 1;
    const fx = dx / length, fy = dy / length;
    const side = this.wavesLaunched % 2 === 0 ? -1 : 1;
    let sx = 0, sy = 0;
    for (const unit of units) { sx += unit.tx; sy += unit.ty; }
    sx = Math.round(sx / units.length); sy = Math.round(sy / units.length);
    for (const progress of [0.58, 0.68, 0.48]) for (const offset of [14, 10, 6]) {
      const base = {
        x: Math.round(home.x + dx * progress - fy * offset * side),
        y: Math.round(home.y + dy * progress + fx * offset * side),
      };
      const point = this.walkableNear(ctx, base);
      if (point && findPath(ctx.world, sx, sy, point.x, point.y, ctx.view.owner)) return point;
    }
    return null;
  }

  private walkableNear(ctx: PolicyContext, base: Coord): Coord | null {
    for (let radius = 0; radius <= 3; radius++) {
      for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
        if (radius > 0 && Math.abs(ox) !== radius && Math.abs(oy) !== radius) continue;
        const x = base.x + ox, y = base.y + oy;
        if (x > 0 && y > 0 && x < ctx.world.W - 1 && y < ctx.world.H - 1
          && ctx.world.passable(x, y, ctx.view.owner)) return { x, y };
      }
    }
    return null;
  }

  private groupNear(units: Unit[], target: Coord, range: number): boolean {
    let x = 0, y = 0;
    for (const unit of units) { x += unit.tx; y += unit.ty; }
    x /= units.length; y /= units.length;
    return Math.max(Math.abs(x - target.x), Math.abs(y - target.y)) <= range;
  }

  private orderNear(unit: Unit, target: Coord, range: number): boolean {
    const order = unit.order;
    return !!order && Math.max(Math.abs(order.x - target.x), Math.abs(order.y - target.y)) <= range;
  }

  /** The wall/gate the wave should batter, or null when a ground route to the
   *  rival castle door already exists (marched through a fallen gate). */
  private breachTarget(ctx: PolicyContext, squadUnits: Unit[], store: Building): Building | null {
    const { world, view } = ctx;
    let cx = 0, cy = 0;
    for (const unit of squadUnits) { cx += unit.tx; cy += unit.ty; }
    cx = Math.round(cx / squadUnits.length); cy = Math.round(cy / squadUnits.length);
    const door = doorTile(store);
    if (findPath(world, cx, cy, door.x, door.y, view.owner)) return null;
    let best: Building | null = null, bestScore = Infinity;
    for (const bulwark of view.enemyBulwarks) {
      const distance = Math.max(Math.abs(bulwark.x - cx), Math.abs(bulwark.y - cy));
      if (distance > 16) continue;
      const score = distance - (bulwark.def.gate ? 6 : 0); // gates open the road
      if (score < bestScore) { bestScore = score; best = bulwark; }
    }
    return best;
  }

  private nearestBuilding(units: Unit[], buildings: Building[]): Building {
    let cx = 0, cy = 0;
    for (const unit of units) { cx += unit.tx; cy += unit.ty; }
    cx /= units.length; cy /= units.length;
    return [...buildings].sort((a, b) => {
      const ad = Math.max(Math.abs(a.x - cx), Math.abs(a.y - cy));
      const bd = Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy));
      return ad - bd || a.id - b.id;
    })[0];
  }

  private pressStragglers(ctx: PolicyContext, squadUnits: Unit[], store: Building): GameCommand[] {
    const { view } = ctx;
    // keep stragglers marching on the same committed target
    const idle = squadUnits.filter(unit => !unit.order && !unit.foe && !unit.foeB);
    if (idle.length) {
      this.lastOrderAt = view.elapsed;
      return [this.sieging
        ? { type: 'orderUnits', unitIds: idle.map(unit => unit.id), order: { type: 'attackBuilding', targetId: store.id }, formation: 'box' }
        : { type: 'orderUnits', unitIds: idle.map(unit => unit.id), order: { type: 'attackMove', x: store.x, y: store.y + 2 }, formation: 'box' }];
    }
    return [];
  }
}
