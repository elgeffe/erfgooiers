import { DEFS } from '../../data/buildings';
import type { BuildingKey, Building, Coord } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { findBuildingSpot, planPlots } from '../actuation';
import { economyStock, have, storeStock } from '../perception';
import { deserializeMPS, sample, type MPS, type SerializedMPS } from '../tensor/mps';
import { decodePlan, type DecodedPlan } from '../tensor/plan';
import { dominantEnemyCategory, counterMultiplier } from './classic';
import type { MacroPolicy, PolicyContext } from './types';

/**
 * The experimental macro policy: a strategy SAMPLED from the Matrix Product
 * State generative model (src/ai/tensor/), executed through the exact same
 * command seam and placement search as the Classic baseline — so a win is a win
 * of *strategy*, not of information or reflexes (see docs/tensor-strategy-poc.md).
 *
 * Division of labour with the tensor network:
 *   • The MPS draws ONE correlated plan per game (build order + army-mix votes).
 *     The correlations are the whole point — the network can learn "if this
 *     opening, then that follow-up" that a per-slot independent sampler cannot.
 *   • This class is only the *actuator*: it walks the sampled build order, saves
 *     for the next building, reuses findBuildingSpot for legal placement, staffs
 *     the economy, and trains the sampled army mix (with the same fair counter
 *     read Classic gets). It adds no strategy of its own beyond keeping the base
 *     alive — everything strategic came from the sample.
 */
export class TensorMacro implements MacroPolicy {
  private readonly mps: MPS;
  private decoded: DecodedPlan | null = null;
  /** The raw action-index sequence this game drew — read by the trainer to
   *  reinforce the plans that won (the generator-enhanced feedback loop). */
  sampledSeq: number[] | null = null;
  /** Build-order positions abandoned as unplaceable, so the plan can't wedge. */
  private readonly skipped = new Set<number>();
  private readonly savingSince = new Map<number, number>();
  private readonly blockedUntil = new Map<BuildingKey, number>();
  private readonly siteWatch = new Map<number, { since: number; watermark: number }>();

  constructor(model: SerializedMPS) {
    this.mps = deserializeMPS(model);
  }

  plan(ctx: PolicyContext): GameCommand[] {
    const { view } = ctx;
    if (!view.store) return [];
    // Draw the game's plan once, from THIS seat's seeded stream — replay-safe.
    if (!this.decoded) {
      this.sampledSeq = sample(this.mps, ctx.rng);
      this.decoded = decodePlan(this.sampledSeq);
    }

    const commands: GameCommand[] = [];
    const rescue = this.siteRescue(ctx);
    if (rescue) commands.push(rescue);
    const plots = this.fieldPlots(ctx);
    if (plots) commands.push(plots);
    for (const civ of this.trainCivilian(ctx)) commands.push(civ);
    const build = this.nextBuild(ctx);
    if (build) commands.push(build);
    const fighter = this.trainFighter(ctx);
    if (fighter) commands.push(fighter);
    return commands;
  }

  // ---- build order (the sampled opening) ----
  private nextBuild(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile, rng } = ctx;
    if (view.sites.length >= profile.maxPendingSites) return null;
    const order = this.decoded!.buildOrder;

    // first not-yet-satisfied, non-skipped position in the sampled order
    const seen = new Map<BuildingKey, number>();
    let targetPos = -1, targetKey: BuildingKey | null = null;
    for (let p = 0; p < order.length; p++) {
      const key = order[p];
      const occ = (seen.get(key) ?? 0) + 1; seen.set(key, occ);
      if (this.skipped.has(p)) continue;
      if ((this.blockedUntil.get(key) ?? 0) > view.elapsed) continue;
      if (have(view, key) >= occ) continue;
      targetPos = p; targetKey = key; break;
    }
    // build order exhausted → steady-state growth keeps the economy compounding
    if (!targetKey) return this.expand(ctx);

    if (!this.affordable(ctx, targetKey)) {
      // save for it, but not forever: a dead income stream (all trees felled)
      // must not deadlock the plan — after a patience window, skip the slot.
      const since = this.savingSince.get(targetPos);
      if (since === undefined) { this.savingSince.set(targetPos, view.elapsed); return null; }
      if (view.elapsed - since < 75) return null;
      this.savingSince.delete(targetPos); this.skipped.add(targetPos);
      return null;
    }
    this.savingSince.delete(targetPos);
    const spot = findBuildingSpot(game, world, view, targetKey, rng, ctx.approach);
    if (spot) return { type: 'placeBuilding', key: targetKey, x: spot.x, y: spot.y, rot: spot.rot };
    // unplaceable right now (no anchor / no room): cool down, retry later, and
    // if it keeps failing the save-timer above eventually skips it for good
    this.blockedUntil.set(targetKey, view.elapsed + 40);
    return null;
  }

  /** Once the opening is built out, keep compounding the scarcest producer so a
   *  strong economy never plateaus — the same lesson the Classic expansion knob
   *  learned, but here it is only a fallback after the SAMPLED plan is done. */
  private expand(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile, rng } = ctx;
    if (view.sites.length >= profile.maxPendingSites) return null;
    const b = (key: BuildingKey): number => view.built[key] ?? 0;
    const stock = (item: string): number => economyStock(game, view.owner, item);
    // candidate → want-more signal (chain balance / stock scarcity), best first
    const candidates: [BuildingKey, number][] = [
      ['coalmine', b('coalmine') < Math.ceil((b('mint') + b('smithy') + b('armory')) * 1.6) ? 5 : 0],
      ['ironmine', b('ironmine') < Math.ceil((b('smithy') + b('armory')) * 1.4) ? 4 : 0],
      ['smithy', stock('weapon') < 6 ? 4 : 0],
      ['goldmine', stock('coin') < 12 ? 4 : 0],
      ['woodcutter', stock('timber') < 8 ? 3 : 0],
      ['quarry', stock('stone') < 8 ? 3 : 0],
      ['barracks', view.armySize < profile.armyCap && b('barracks') < 3 ? 2 : 0],
    ];
    candidates.sort((a, c) => c[1] - a[1]);
    for (const [key, want] of candidates) {
      if (want <= 0) break;
      if ((this.blockedUntil.get(key) ?? 0) > view.elapsed) continue;
      if (!this.affordable(ctx, key)) continue;
      const spot = findBuildingSpot(game, world, view, key, rng, ctx.approach);
      if (spot) return { type: 'placeBuilding', key, x: spot.x, y: spot.y, rot: spot.rot };
      this.blockedUntil.set(key, view.elapsed + 40);
    }
    return null;
  }

  // ---- economy staffing (not strategic — just keeps the plan's base alive) ----
  private trainCivilian(ctx: PolicyContext): GameCommand[] {
    const { game, view, profile } = ctx;
    const guild = view.buildings.find(building => building.def.trainer && building.active);
    if (!guild) return [];
    const queued = guild.trainQ ?? [];
    if (queued.length >= 2) return [];
    const coin = storeStock(game, view.owner, 'coin');
    const queuedOf = (kind: string): number => queued.filter(entry => entry === kind).length;

    const villagersWanted = view.workers.unstaffed
      + view.sites.filter(site => site.def.worker).length
      - view.workers.freeVillagers - queuedOf('villager');
    if (villagersWanted > 0 && coin >= 1) return [{ type: 'queueTraining', buildingId: guild.id, unit: 'villager' }];
    if (coin <= profile.workerReserveCoin) return [];

    const coinEngine = view.buildings.some(building => building.key === 'mint' && building.worker);
    const laborerTarget = coinEngine ? Math.min(2, Math.max(1, view.sites.length)) : 1;
    if (view.workers.laborers + queuedOf('laborer') < laborerTarget) return [{ type: 'queueTraining', buildingId: guild.id, unit: 'laborer' }];

    // haulers scale with the economy so a sprawling base actually moves its ore
    const production = view.buildings.filter(building => building.def.recipe || building.def.gather || building.def.tavern).length;
    const serfTarget = Math.min(6 + Math.ceil(production * (0.7 + profile.expansion * 0.35)), 44);
    if (view.workers.serfs + queuedOf('serf') < serfTarget) return [{ type: 'queueTraining', buildingId: guild.id, unit: 'serf' }];
    return [];
  }

  // ---- army composition (the sampled unit-mix votes) ----
  private trainFighter(ctx: PolicyContext): GameCommand | null {
    const { game, view, profile, rng } = ctx;
    let queuedTotal = 0;
    const trainers: Building[] = [];
    for (const building of view.buildings) {
      if (!building.def.military || !building.active) continue;
      queuedTotal += building.trainQ?.length ?? 0;
      if ((building.trainQ?.length ?? 0) < 2) trainers.push(building);
    }
    if (!trainers.length || view.armySize + queuedTotal >= profile.armyCap) return null;

    const weights = this.decoded!.unitWeights;
    const hasVote = Object.keys(weights).length > 0;
    const coinEngine = view.buildings.some(building => building.key === 'mint' && building.worker);
    const coinReserve = coinEngine ? 0 : profile.workerReserveCoin;
    const enemyDom = profile.counter > 0 ? dominantEnemyCategory(view.enemyArmyByKind) : null;

    const options: { building: Building; kind: string; weight: number }[] = [];
    for (const building of trainers) {
      for (const training of building.def.military!.units) {
        // a unit's weight is how often the sampled plan voted for it; if the
        // plan voted for nothing this trainer offers, fall back to an even hand
        let weight = weights[training.kind as keyof typeof weights] ?? (hasVote ? 0 : 1);
        if (weight <= 0) continue;
        if (enemyDom) weight *= counterMultiplier(training.kind, enemyDom.cat, profile.counter * enemyDom.frac);
        const cost = game.modsFor(view.owner).unitCost(training.kind, training.cost) as Record<string, number>;
        let ok = true;
        for (const item in cost) {
          const reserve = item === 'coin' ? coinReserve : 0;
          if (storeStock(game, view.owner, item) < cost[item] + reserve) { ok = false; break; }
        }
        if (ok) options.push({ building, kind: training.kind, weight });
      }
    }
    if (!options.length) return null;
    let roll = rng.next() * options.reduce((sum, option) => sum + option.weight, 0);
    for (const option of options) { roll -= option.weight; if (roll <= 0) return { type: 'queueTraining', buildingId: option.building.id, unit: option.kind }; }
    const last = options[options.length - 1];
    return { type: 'queueTraining', buildingId: last.building.id, unit: last.kind };
  }

  // ---- shared housekeeping (mirrors the Classic bot's) ----
  private fieldPlots(ctx: PolicyContext): GameCommand | null {
    for (const building of ctx.view.buildings) {
      if (!building.def.fields) continue;
      const cells = planPlots(ctx.game, building);
      if (cells.length) return { type: 'placePlots', buildingId: building.id, cells };
    }
    return null;
  }

  private siteRescue(ctx: PolicyContext): GameCommand | null {
    const { view } = ctx;
    const seen = new Set<number>();
    let demolish: GameCommand | null = null;
    for (const site of view.sites) {
      seen.add(site.id);
      let watermark = Math.round(site.progress * 100) + (site.ready ? 1000 : 0);
      for (const item in site.delivered) watermark += site.delivered[item] || 0;
      const watch = this.siteWatch.get(site.id);
      if (!watch || watch.watermark !== watermark) { this.siteWatch.set(site.id, { since: view.elapsed, watermark }); continue; }
      if (view.elapsed - watch.since > 150 && !demolish) demolish = { type: 'demolish', x: site.x, y: site.y, drag: false };
    }
    for (const id of [...this.siteWatch.keys()]) if (!seen.has(id)) this.siteWatch.delete(id);
    return demolish;
  }

  private affordable(ctx: PolicyContext, key: BuildingKey): boolean {
    const cost = ctx.game.modsFor(ctx.view.owner).buildingCost(DEFS[key]) as Record<string, number>;
    for (const item in cost) if (economyStock(ctx.game, ctx.view.owner, item) < cost[item]) return false;
    return true;
  }
}
