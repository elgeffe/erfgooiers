import { DEFS } from '../../data/buildings';
import { UNITS, type UnitKind } from '../../data/units';
import { findPath } from '../../engine/pathfinding';
import { doorTile } from '../../game/util';
import { planFortificationRing, sideToward, type FortSide } from '../../game/fortification';
import type { BuildingKey, Building, Coord } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { findBuildingSpot, planPlots } from '../actuation';
import { economyStock, have, storeStock } from '../perception';
import type { MacroPolicy, PolicyContext } from './types';

/** Expand a waypoint path (findPath returns smoothed corners) into the full
 *  tile-by-tile line, so the road can be painted along the whole route. */
function tilesAlong(path: Coord[]): Coord[] {
  const tiles: Coord[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    let x = path[i].x, y = path[i].y;
    const to = path[i + 1];
    while (x !== to.x || y !== to.y) {
      tiles.push({ x, y });
      x += Math.sign(to.x - x);
      y += Math.sign(to.y - y);
    }
  }
  if (path.length) tiles.push(path[path.length - 1]);
  return tiles;
}

// ---- reactive counter-composition (graded by profile.counter) ----
type ArmyCategory = 'mounted' | 'ranged' | 'melee';

function unitCategory(kind: string): ArmyCategory {
  const def = (UNITS as Record<string, (typeof UNITS)[UnitKind] | undefined>)[kind];
  if (!def) return 'melee';
  if (def.tags?.includes('mounted')) return 'mounted';
  if (def.arrows || def.range > 1.6) return 'ranged';
  return 'melee';
}

/** The rival army's dominant category and how lopsided it is (null = too small
 *  a force to bother countering). */
export function dominantEnemyCategory(byKind: Partial<Record<UnitKind, number>>): { cat: ArmyCategory; frac: number } | null {
  const cats: Record<ArmyCategory, number> = { mounted: 0, ranged: 0, melee: 0 };
  let total = 0;
  for (const kind in byKind) { const n = byKind[kind as UnitKind] ?? 0; total += n; cats[unitCategory(kind)] += n; }
  if (total < 3) return null;
  let best: ArmyCategory = 'melee', bestN = -1;
  for (const c of ['mounted', 'ranged', 'melee'] as ArmyCategory[]) if (cats[c] > bestN) { bestN = cats[c]; best = c; }
  return { cat: best, frac: bestN / total };
}

/** How much to reweight training `myKind` given the enemy's dominant category:
 *  pikemen shred cavalry (data-backed 2.5× bonus), durable melee closes on and
 *  soaks archers, archers kite melee. Scaled by reactivity × how lopsided the
 *  enemy is, so a mixed enemy barely shifts the shopping list. */
export function counterMultiplier(myKind: string, enemyDom: ArmyCategory, gain: number): number {
  const mine = unitCategory(myKind);
  if (enemyDom === 'mounted') return myKind === 'pikeman' ? 1 + 2.5 * gain : mine === 'melee' ? 1 + 0.3 * gain : 1 - 0.3 * gain;
  if (enemyDom === 'ranged') return mine === 'melee' ? 1 + 1.5 * gain : mine === 'ranged' ? 1 - 0.4 * gain : 1;
  return mine === 'ranged' ? 1 + 1.5 * gain : 1; // enemy melee-heavy → archers
}

/**
 * The Classic baseline (Phase 1): a handwritten, layered, fair macro policy.
 * Build order is not a rigid list but a utility score over candidate goals —
 * stances and situations reweight categories (war when outgunned, food when
 * hungry, coin when broke), so the same code plays all nine profiles.
 */

type Category = 'economy' | 'food' | 'coin' | 'war' | 'fort';

interface BuildGoal {
  key: BuildingKey;
  target: number;
  priority: number;   // descending base order of the opening
  category: Category;
  /** Chain gates: every requirement must already STAND (sites don't count). */
  requires?: BuildingKey[];
  /** Deep-base tail entries only Godlike-scale economies reach for. */
  minScale?: number;
}

const STANCE_WEIGHT: Record<string, Record<Category, number>> = {
  defensive: { economy: 1, food: 1, coin: 1, war: 0.9, fort: 1.6 },
  balanced: { economy: 1, food: 1, coin: 1, war: 1, fort: 1 },
  offensive: { economy: 1, food: 0.95, coin: 1, war: 1.3, fort: 0.6 },
};

function goals(towers: number, scale: number): BuildGoal[] {
  // The owner-blessed opening: wood → timber → quarry → gold → coal → mint
  // (villagers cost coin, the mint makes coin — the free starting villagers
  // must staff that loop first or the economy deadlocks at zero coin), then
  // the food chain through the tavern, then the barracks (archers train on
  // timber alone), then iron + a second coalmine into the weapons chain.
  const list: BuildGoal[] = [
    // normally start-granted, so the deficit is zero — but a razed guild hall
    // must be rebuilt at once or the settlement can never hire anyone again
    { key: 'guildhall', target: 1, priority: 98, category: 'economy' },
    { key: 'woodcutter', target: 1, priority: 100, category: 'economy' },
    { key: 'sawmill', target: 1, priority: 96, category: 'economy', requires: ['woodcutter'] },
    { key: 'quarry', target: 1, priority: 92, category: 'economy' },
    { key: 'goldmine', target: 1, priority: 88, category: 'coin' },
    { key: 'coalmine', target: 1, priority: 86, category: 'coin' },
    { key: 'mint', target: 1, priority: 84, category: 'coin', requires: ['goldmine', 'coalmine'] },
    // the forester joins the opening: a lone woodcutter strips its stand in
    // minutes and a dead wood economy starves archers (1 timber) forever
    { key: 'forester', target: 1, priority: 81, category: 'economy', requires: ['woodcutter'] },
    { key: 'farm', target: 1, priority: 80, category: 'food' },
    { key: 'mill', target: 1, priority: 78, category: 'food', requires: ['farm'] },
    { key: 'bakery', target: 1, priority: 76, category: 'food', requires: ['mill'] },
    { key: 'tavern', target: 1, priority: 74, category: 'food', requires: ['bakery'] },
    { key: 'barracks', target: 1, priority: 72, category: 'war' },
    { key: 'ironmine', target: 1, priority: 68, category: 'war' },
    { key: 'coalmine', target: 2, priority: 66, category: 'war', minScale: 1 },
    { key: 'smithy', target: 1, priority: 64, category: 'war', requires: ['ironmine', 'coalmine'] },
    // higher difficulties boost coin with market exports of surplus goods
    { key: 'market', target: 1, priority: 62, category: 'coin', minScale: 1 },
    { key: 'woodcutter', target: 2, priority: 56, category: 'economy', minScale: 1 },
    { key: 'watchtower', target: towers, priority: 54, category: 'fort' },
    // veins run dry: spare goldmines keep the coin (= army) income alive
    { key: 'goldmine', target: 2, priority: 52, category: 'coin', minScale: 0.8 },
    // a second quarry doubles stone income to fund the stone sinks — roads and
    // curtain walls — the way a real player bankrolls infrastructure rather
    // than starving construction for it (comes right after the core military)
    { key: 'quarry', target: 2, priority: 55, category: 'economy', minScale: 0.8 },
    { key: 'sawmill', target: 2, priority: 50, category: 'economy', minScale: 1 },
    // (curtain walls & gates are planned by planFortification, not listed here)
    { key: 'quarry', target: 3, priority: 34, category: 'economy', minScale: 1.1 },
    { key: 'goldmine', target: 3, priority: 44, category: 'coin', minScale: 1.25 },
    { key: 'farm', target: 2, priority: 43, category: 'food', minScale: 1.2 },
    { key: 'smithy', target: 2, priority: 40, category: 'war', minScale: 1.1 },
    { key: 'armory', target: 1, priority: 38, category: 'war', requires: ['smithy'], minScale: 1 },
    // the wall-breakers: an engineer's workshop arms the top tier's sieges
    { key: 'engineer', target: 1, priority: 37, category: 'war', requires: ['smithy'], minScale: 1.1 },
    { key: 'barracks', target: 2, priority: 36, category: 'war', minScale: 1.1 },
  ];
  return list.filter(goal => (goal.minScale ?? 0) <= scale && goal.target > 0);
}

export class ClassicMacro implements MacroPolicy {
  /** Keys whose placement search recently failed — retried after a cooldown
   *  instead of burning the search budget every pass. */
  private readonly blockedUntil = new Map<BuildingKey, number>();
  /** When the bot started saving toward each unaffordable top goal. */
  private readonly savingSince = new Map<BuildingKey, number>();
  /** Per-site progress watermarks, to spot construction that will never finish. */
  private readonly siteWatch = new Map<number, { since: number; watermark: number }>();
  /** Buildings already linked to the castle by a road — never repaved. */
  private readonly roadedBuildings = new Set<number>();
  private lastThreatAt = -Infinity;
  private lastRoadAt = -Infinity;

  plan(ctx: PolicyContext): GameCommand[] {
    const { view } = ctx;
    if (!view.store) return [];
    if (view.threats.length) this.lastThreatAt = view.elapsed;
    const commands: GameCommand[] = [];
    const rescue = this.planSiteRescue(ctx);
    if (rescue) commands.push(rescue);
    const plots = this.planFieldPlots(ctx);
    if (plots) commands.push(plots);
    const market = this.planMarket(ctx);
    if (market) commands.push(market);
    // defensive stances wall first and expand second; everyone else fortifies
    // with whatever build capacity the economy goals leave over
    const fortFirst = ctx.profile.stance === 'defensive';
    const fort = fortFirst ? this.planFortification(ctx) : null;
    if (fort) commands.push(fort);
    const build = this.planBuild(ctx);
    if (build) commands.push(build);
    else if (!fortFirst) {
      const spare = this.planFortification(ctx);
      if (spare) commands.push(spare);
    }
    commands.push(...this.planTraining(ctx));
    const road = this.planRoad(ctx);
    if (road) commands.push(road);
    return commands;
  }

  // ---- roads ----
  /** Pave a stone road from the castle to a standing production building the
   *  serfs haul to, so the settlement's supply lines run on the 1-cost road
   *  lattice instead of open ground. Only ever starts once a QUARRY stands (a
   *  road costs stone, so a stone income must exist first), and keeps a stone
   *  buffer so paving never starves construction — roads are a surplus-stone
   *  efficiency play, not a priority over buildings or army. */
  private planRoad(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile } = ctx;
    const store = view.store;
    if (!store || profile.econScale <= 0) return null;
    // the user-requested gate: a quarry (= stone income) must exist first
    if ((view.built.quarry ?? 0) < 1) return null;
    // never pave under attack — stone then belongs to walls and defence
    if (view.threats.length || view.elapsed - this.lastThreatAt < 45) return null;
    // one link every so often, so roads trickle out instead of eating the quarry
    if (view.elapsed - this.lastRoadAt < 20) return null;
    // construction has first claim on stone: reserve what every pending site
    // still needs (plus a small buffer for the next building), and pave only
    // the SURPLUS beyond it. A second quarry's extra income is what turns that
    // surplus from rare to steady — the pro road/wall bankroll.
    const roadCost = game.modsFor(view.owner).roadCost();
    const stone = storeStock(game, view.owner, 'stone');
    const siteStoneNeed = view.sites.reduce((sum, s) => sum + Math.max(0, (s.needs.stone ?? 0) - (s.delivered.stone ?? 0) - (s.incoming.stone ?? 0)), 0);
    const spare = stone - siteStoneNeed - 3;
    if (spare < roadCost) return null;

    // nearest not-yet-linked production building the serfs actually service
    const from = doorTile(store);
    let target: Building | null = null;
    let bestDistance = 1e9;
    for (const building of view.buildings) {
      if (building.id === store.id || this.roadedBuildings.has(building.id)) continue;
      if (!building.active || !(building.def.gather || building.def.recipe || building.def.tavern || building.def.store)) continue;
      const distance = Math.abs(building.x - store.x) + Math.abs(building.y - store.y);
      if (distance > 4 && distance < bestDistance) { bestDistance = distance; target = building; }
    }
    if (!target) return null;
    this.roadedBuildings.add(target.id);
    const door = doorTile(target);
    const path = findPath(world, from.x, from.y, door.x, door.y, view.owner);
    if (!path) return null;
    // pave the route the haulers walk, but only as far as the surplus stone
    // allows — a long link finishes over several passes as more stone frees up
    const budget = Math.min(12, Math.floor(spare / Math.max(1, roadCost)));
    const cells: Coord[] = [];
    for (const tile of tilesAlong(path)) {
      if (cells.length >= budget) break;
      if (game.canPaintRoadAt(tile.x, tile.y)) cells.push(tile);
    }
    // a link too long to even start now waits; don't burn the cooldown on nothing
    if (!cells.length) { this.roadedBuildings.delete(target.id); return null; }
    this.lastRoadAt = view.elapsed;
    return { type: 'paintRoad', cells };
  }

  // ---- curtain walls ----
  /** Raise the profile's fortification rings around the castle: layered
   *  square curtains with a gate toward the enemy and one at the rear, so
   *  the baileys between rings stay working ground for the owner's serfs
   *  while every hostile must batter a way in. One piece per pass; slots the
   *  ground refuses stay honest gaps. */
  private planFortification(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile } = ctx;
    if (profile.walls <= 0 || !view.store) return null;
    // army before masonry, strictly: every stone laid before a fighting force
    // stands is measured tempo handed to a rushing rival
    if ((view.built.barracks ?? 0) < 1 || view.armySize < profile.attackArmy * 0.5) return null;
    if (view.sites.length >= profile.maxPendingSites) return null;
    const center = { x: view.store.x, y: view.store.y };
    const enemySide: FortSide = view.enemyStore ? sideToward(center, view.enemyStore) : 'e';
    const opposite: Record<FortSide, FortSide> = { n: 's', s: 'n', e: 'w', w: 'e' };
    const gateSides: FortSide[] = [enemySide, opposite[enemySide]];
    for (let ring = 0; ring < profile.walls; ring++) {
      const radius = 6 + ring * 4;
      for (const piece of planFortificationRing(center, radius, gateSides)) {
        const tile = world.T(piece.x, piece.y);
        if (!tile || tile.b || tile.site) continue;           // held or hopeless slot
        const key: BuildingKey = piece.kind === 'gate' ? 'gate' : 'wall';
        if (!this.affordable(ctx, key)) return null;          // wait for the stone
        if (!game.canPlace(key, piece.x, piece.y, piece.rot)) continue;
        return { type: 'placeBuilding', key, x: piece.x, y: piece.y, rot: piece.rot };
      }
      // this ring is as finished as the ground allows — start the next layer
    }
    return null;
  }

  // ---- market exports ----
  /** Sell the surplus the economy actually makes: raw gold ore is worth five
   *  coin a piece at the stalls (far more than minting it), stone piles up
   *  from every quarry, bread from a running bakery. One configuration per
   *  market — re-issued only if the orders were somehow cleared. */
  private planMarket(ctx: PolicyContext): GameCommand | null {
    const { view } = ctx;
    for (const building of view.buildings) {
      if (building.key !== 'market' || !building.active) continue;
      if (!building.marketOrders?.length) {
        const orders: { item: 'goldore' | 'stone' | 'bread' | 'timber'; amount: number }[] = [];
        if (view.built.goldmine) orders.push({ item: 'goldore', amount: 5 });
        orders.push({ item: 'stone', amount: 5 });
        if (view.built.bakery) orders.push({ item: 'bread', amount: 4 });
        if (orders.length < 3) orders.push({ item: 'timber', amount: 3 });
        return { type: 'configureMarket', buildingId: building.id, orders: orders.slice(0, 3) };
      }
      // Exports outrank routine hauling ONLY when no gold vein backs the
      // economy — on gold-rich maps a priority market vacuums the stone and
      // timber that walls, towers and the barracks need.
      if (!building.priority && !view.built.goldmine) {
        return { type: 'setPriority', siteId: building.id, priority: true };
      }
    }
    return null;
  }

  // ---- stalled construction ----
  /** A site whose deliveries and build progress have not moved in minutes is
   *  never finishing (unreachable ground, dead supply line). Demolish it: the
   *  tile frees up, and the sim releases every serf task bound to it. */
  private planSiteRescue(ctx: PolicyContext): GameCommand | null {
    const { view } = ctx;
    const seen = new Set<number>();
    let demolish: GameCommand | null = null;
    for (const site of view.sites) {
      seen.add(site.id);
      let watermark = Math.round(site.progress * 100) + (site.ready ? 1000 : 0);
      for (const item in site.delivered) watermark += site.delivered[item] || 0;
      const watch = this.siteWatch.get(site.id);
      if (!watch || watch.watermark !== watermark) {
        this.siteWatch.set(site.id, { since: view.elapsed, watermark });
        continue;
      }
      if (view.elapsed - watch.since > 150 && !demolish) {
        demolish = { type: 'demolish', x: site.x, y: site.y, drag: false };
      }
    }
    for (const id of [...this.siteWatch.keys()]) if (!seen.has(id)) this.siteWatch.delete(id);
    return demolish;
  }

  // ---- fields ----
  private planFieldPlots(ctx: PolicyContext): GameCommand | null {
    for (const building of ctx.view.buildings) {
      if (!building.def.fields) continue;
      const cells = planPlots(ctx.game, building);
      if (cells.length) return { type: 'placePlots', buildingId: building.id, cells };
    }
    return null;
  }

  // ---- construction ----
  private planBuild(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile, rng } = ctx;
    if (view.sites.length >= profile.maxPendingSites) return null;
    const weights = STANCE_WEIGHT[profile.stance];
    const hungry = view.averageWorkerHunger < 45 || economyStock(game, view.owner, 'bread') < 2;
    const outgunned = view.enemyArmySize > view.armySize + 3;
    const broke = storeStock(game, view.owner, 'coin') < profile.workerReserveCoin + 2;
    const threatened = view.elapsed - this.lastThreatAt < 60;

    const candidates = goals(profile.towers, profile.econScale)
      .filter(goal => have(view, goal.key) < goal.target)
      .filter(goal => (goal.requires ?? []).every(key => (view.built[key] ?? 0) > 0))
      .filter(goal => (this.blockedUntil.get(goal.key) ?? 0) <= view.elapsed)
      .map(goal => {
        let value = goal.priority * weights[goal.category];
        if (goal.category === 'food' && hungry) value *= 1.6;
        if (goal.category === 'war' && (outgunned || threatened)) value *= 1.5;
        if (goal.category === 'coin' && broke) value *= 1.7;
        if (goal.category === 'fort' && threatened) value *= 1.6;
        return { goal, value };
      })
      .sort((a, b) => b.value - a.value);

    for (const { goal } of candidates.slice(0, 3)) {
      // SAVE for the best goal instead of buying cheaper, lesser ones — an
      // affordability filter here silently starved the barracks forever while
      // low-priority buildings kept spending the timber the moment it landed.
      // But saving has a patience window: income for a good can DIE (all
      // nearby trees felled), and waiting on a dead stream deadlocks the base.
      if (!this.affordable(ctx, goal.key)) {
        const since = this.savingSince.get(goal.key);
        if (since === undefined) { this.savingSince.set(goal.key, view.elapsed); return null; }
        if (view.elapsed - since < 90) return null;
        this.savingSince.delete(goal.key);
        this.blockedUntil.set(goal.key, view.elapsed + 60);
        continue;
      }
      this.savingSince.delete(goal.key);
      const spot = findBuildingSpot(game, world, view, goal.key, rng, ctx.approach);
      if (spot) return { type: 'placeBuilding', key: goal.key, x: spot.x, y: spot.y, rot: spot.rot };
      this.blockedUntil.set(goal.key, view.elapsed + 45);
    }
    return null;
  }

  private affordable(ctx: PolicyContext, key: BuildingKey): boolean {
    const cost = ctx.game.modsFor(ctx.view.owner).buildingCost(DEFS[key]) as Record<string, number>;
    for (const item in cost) {
      if (economyStock(ctx.game, ctx.view.owner, item) < cost[item]) return false;
    }
    return true;
  }

  // ---- training ----
  private planTraining(ctx: PolicyContext): GameCommand[] {
    const commands: GameCommand[] = [];
    const civilian = this.planCivilian(ctx);
    if (civilian) commands.push(civilian);
    const fighter = this.planFighter(ctx);
    if (fighter) commands.push(fighter);
    return commands;
  }

  private planCivilian(ctx: PolicyContext): GameCommand | null {
    const { game, view, profile } = ctx;
    const guild = view.buildings.find(b => b.def.trainer && b.active);
    if (!guild) return null;
    const queued = guild.trainQ ?? [];
    if (queued.length >= 2) return null;
    const coin = storeStock(game, view.owner, 'coin');
    const queuedOf = (kind: string) => queued.filter(entry => entry === kind).length;

    // production stalls without a specialist, and villagers are what turn coin
    // back into coin (they staff the mint) — hire down to the last coin
    const villagersWanted = view.workers.unstaffed
      + view.sites.filter(site => site.def.worker).length
      - view.workers.freeVillagers - queuedOf('villager');
    if (villagersWanted > 0 && coin >= 1) {
      return { type: 'queueTraining', buildingId: guild.id, unit: 'villager' };
    }
    if (coin <= profile.workerReserveCoin) return null;
    // builders are a luxury: the kit's single builder carries the opening, and
    // a second is only hired once the coin engine runs and sites still queue
    const coinEngineRunning = view.buildings.some(b => b.key === 'mint' && b.worker);
    const laborerTarget = coinEngineRunning ? Math.min(2, Math.max(1, view.sites.length)) : 1;
    if (view.workers.laborers + queuedOf('laborer') < laborerTarget) {
      return { type: 'queueTraining', buildingId: guild.id, unit: 'laborer' };
    }
    // a lean haulage corps: every coin spent here is a fighter not trained
    const production = view.buildings.filter(b => b.def.recipe || b.def.gather || b.def.tavern).length;
    const serfTarget = Math.min(Math.round(10 * profile.econScale), 3 + Math.ceil(production * 0.6));
    if (view.workers.serfs + queuedOf('serf') < serfTarget) {
      return { type: 'queueTraining', buildingId: guild.id, unit: 'serf' };
    }
    return null;
  }

  private planFighter(ctx: PolicyContext): GameCommand | null {
    const { game, view, profile, rng } = ctx;
    let queuedTotal = 0;
    const trainers: Building[] = [];
    for (const building of view.buildings) {
      if (!building.def.military || !building.active) continue;
      queuedTotal += building.trainQ?.length ?? 0;
      if ((building.trainQ?.length ?? 0) < 2) trainers.push(building);
    }
    if (!trainers.length || view.armySize + queuedTotal >= profile.armyCap) return null;

    // Until the mint is staffed and earning, the last coins are earmarked for
    // the minters — an army with no income behind it is a one-shot gamble that
    // deadlocks the whole economy at zero coin.
    const coinEngineRunning = view.buildings.some(b => b.key === 'mint' && b.worker);
    const coinReserve = coinEngineRunning ? 0 : profile.workerReserveCoin;

    // A better player scouts the rival army and trains counters: the base mix
    // is reweighted toward what beats the enemy's dominant category (graded by
    // profile.counter, and by how lopsided the enemy is). Full visibility, so
    // it's the same read a human gets — no cheat.
    const enemyDom = profile.counter > 0 ? dominantEnemyCategory(view.enemyArmyByKind) : null;

    // weighted pick among the mix entries some standing trainer offers & the store affords
    const options: { building: Building; kind: string; weight: number }[] = [];
    for (const building of trainers) {
      for (const training of building.def.military!.units) {
        let weight = profile.unitMix[training.kind as keyof typeof profile.unitMix] ?? 0;
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
    for (const option of options) {
      roll -= option.weight;
      if (roll <= 0) return { type: 'queueTraining', buildingId: option.building.id, unit: option.kind };
    }
    const last = options[options.length - 1];
    return { type: 'queueTraining', buildingId: last.building.id, unit: last.kind };
  }
}
