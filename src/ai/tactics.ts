import { findPath } from '../engine/pathfinding';
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

type Mode = 'muster' | 'defend' | 'attack';

export class Tactics {
  private mode: Mode = 'muster';
  private squad = new Set<number>();
  private raiders = new Set<number>();
  private launchSize = 0;
  private lastAttackAt = -Infinity;
  private lastRaidAt = -Infinity;
  private lastOrderAt = -Infinity;
  private lastDefendTarget: Coord | null = null;
  private threatSince: number | null = null;
  private bellOn = false;
  private sieging = false;
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
      if (this.mode === 'defend') { this.mode = 'muster'; this.lastOrderAt = -Infinity; }
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
      commands.push(...this.defend(ctx));
      return commands;
    }

    if (this.mode === 'attack') {
      commands.push(...this.pressAttack(ctx));
      return commands;
    }

    commands.push(...this.muster(ctx));
    return commands;
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
    if (recall) { this.squad.clear(); this.raiders.clear(); }
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
    const needed = Math.max(4, enemyKnown
      ? Math.min(profile.attackArmy, Math.ceil(view.enemyArmySize * 1.5) + 4)
      : profile.attackArmy);
    // the garrison is best-effort surplus, never a reason to delay the launch:
    // demanding wave + full guard before marching left Godlike massing forever
    const guard = Math.min(Math.ceil(view.armySize * profile.homeGuard), Math.max(0, view.armySize - needed));
    if (view.armySize - guard >= needed
      && view.elapsed - this.lastAttackAt >= profile.minAttackInterval
      && view.enemyStore) {
      const wave = view.army.slice(0, view.armySize - guard);
      this.squad = new Set(wave.map(unit => unit.id));
      for (const id of this.squad) this.raiders.delete(id);
      this.launchSize = this.squad.size;
      this.lastAttackAt = view.elapsed;
      this.firstAttackAt ??= view.elapsed;
      this.mode = 'attack';
      this.sieging = false;
      this.lastOrderAt = view.elapsed;
      const store = view.enemyStore;
      return [{
        type: 'orderUnits', unitIds: [...this.squad],
        order: { type: 'attackMove', x: store.x, y: store.y + 2 }, formation: 'box',
      }];
    }

    // Harassment raids between waves (higher difficulties): a small party
    // rides at the rival base to bleed workers, scout, and force reactions —
    // but never into a garrison that outnumbers it (a beaten raid invites the
    // counter-chase that razes half the home base), and never once the rival
    // has WALLED UP: a light raid party just dies on the curtain and its
    // towers, feeding the turtle instead of pestering it. Raids harass an open
    // economy; a fortified one is cracked by the main wave and its siege.
    if (profile.raidSize > 0 && view.enemyStore && !this.raiders.size
      && view.enemyArmySize < profile.raidSize
      && view.enemyBulwarks.length === 0
      && view.elapsed - this.lastRaidAt >= profile.raidInterval
      && view.armySize - guard >= profile.raidSize + 4) {
      const party = view.army.filter(unit => !this.squad.has(unit.id)).slice(0, profile.raidSize);
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

  // ---- the launched attack: march, then siege, or cut losses ----
  private pressAttack(ctx: PolicyContext): GameCommand[] {
    const { view, profile } = ctx;
    const squadUnits = view.army.filter(unit => this.squad.has(unit.id));
    const store = view.enemyStore;
    if (!store || !squadUnits.length) {
      this.squad.clear();
      this.mode = 'muster';
      this.lastOrderAt = -Infinity;
      return [];
    }
    // cut losses: below the retreat fraction the survivors walk home to re-mass
    if (squadUnits.length < Math.ceil(this.launchSize * profile.retreatRatio)) {
      this.squad.clear();
      this.mode = 'muster';
      this.lastOrderAt = view.elapsed;
      return [{
        type: 'orderUnits', unitIds: squadUnits.map(unit => unit.id),
        order: { type: 'move', x: ctx.approach.x, y: ctx.approach.y }, formation: 'box',
      }];
    }
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
    // close enough: focus the castle itself instead of drifting through the base
    let near = 0;
    for (const unit of squadUnits) {
      if (Math.max(Math.abs(unit.tx - store.x), Math.abs(unit.ty - store.y)) <= SIEGE_RANGE) near++;
    }
    if (!this.sieging && near >= squadUnits.length * 0.5) {
      this.sieging = true;
      this.lastOrderAt = view.elapsed;
      return [{
        type: 'orderUnits', unitIds: squadUnits.map(unit => unit.id),
        order: { type: 'attackBuilding', targetId: store.id }, formation: 'box',
      }];
    }
    return this.pressStragglers(ctx, squadUnits, store);
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
