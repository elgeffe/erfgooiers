import { DEFS } from '../../data/buildings';
import { UNITS, type UnitKind } from '../../data/units';
import { findPath } from '../../engine/pathfinding';
import { doorTile } from '../../game/util';
import type { BuildingKey, Building, Coord } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { findBuildingSpot } from '../actuation';
import { economyStock, have, storeStock } from '../perception';
import {
  SiteWatch,
  affordable,
  fieldPlots,
  placeBuilding,
  planHomeTower,
  rankPerimeterTowerAnchors,
  selectUncoveredWoodcutter,
  staffEconomy,
  trainFighter,
  uncoveredWoodcutter,
  TIMBER_SUPPORT_RANGE,
  VILLAGER_RESERVE,
} from './execution';
import {
  nextArmsLineBuild,
  nextCoinLineBuild,
  nextOpeningDecision,
  nextTimberLineBuild,
  plannedBuildingCounts,
} from './classicPlan';
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

/**
 * The Classic baseline (Phase 1): a handwritten, layered, fair macro policy.
 * Build order is not a rigid list but a utility score over candidate goals —
 * situations reweight categories (war when outgunned, food when hungry, coin
 * when broke), so the same code plays every difficulty persona; the personas
 * themselves differ only in profile knobs (docs/skirmish-ai-design.md).
 */

type Category = 'economy' | 'food' | 'coin' | 'war';

/** Resource buildings that anchor a forward outpost worth guarding. */
const EXTRACTORS = new Set<BuildingKey>(['quarry', 'goldmine', 'coalmine', 'ironmine']);

/** Placement, affordability, staffing and stalled-site rules live in
 *  `execution.ts`, shared verbatim with every other macro policy. */

interface BuildGoal {
  key: BuildingKey;
  target: number;
  priority: number;   // descending base order of the opening
  category: Category;
  /** Chain gates: every requirement must already STAND (sites don't count). */
  requires?: BuildingKey[];
  /** Endless-expansion goal (vs a fixed opening): its priority is decided by
   *  current scarcity of its output, not a fixed opening order. */
  expand?: boolean;
}

interface ExpansionTargets {
  timberLines: number;
  coinLines: number;
  armsLines: number;
  quarries: number;
  foodLines: number;
}

/** Difficulty changes depth and tempo, never the production-line rules. */
function expansionTargets(depth: number): ExpansionTargets {
  const godlike = depth >= 3;
  return {
    // The common opening already owns one complete timber line, two coin
    // lines, one arms line and two quarries. Mid-game growth is deliberate,
    // not an exponential copy of every chain: Hard adds the requested second
    // timber pair, while Godlike spends its extra footprint on stone and a
    // deeper coin/arms backbone.
    timberLines: 2,
    coinLines: godlike ? 3 : 2,
    armsLines: godlike ? 2 : 1,
    quarries: godlike ? 4 : 2,
    foodLines: 2,
  };
}

/** Mid-game ceilings. The line planners below decide the supplier-first next
 * step, so these are capacity limits rather than independently competing asks. */
function goals(expansion: number): BuildGoal[] {
  const E = expansion;
  const target = expansionTargets(E);
  const secondaryFoodLines = E >= 3 ? 2 : 1;
  const req = (...keys: BuildingKey[]): BuildingKey[] => keys;
  const list: BuildGoal[] = [
    { key: 'guildhall', target: 1, priority: 100, category: 'economy' },
    { key: 'woodcutter', target: target.timberLines, priority: 30, category: 'economy', expand: true },
    { key: 'sawmill', target: target.timberLines, priority: 30, category: 'economy', requires: req('woodcutter'), expand: true },
    { key: 'forester', target: target.timberLines, priority: 30, category: 'economy', requires: req('woodcutter'), expand: true },
    { key: 'quarry', target: target.quarries, priority: 30, category: 'economy', expand: true },
    { key: 'farm', target: target.foodLines, priority: 30, category: 'food', expand: true },
    { key: 'mill', target: target.foodLines, priority: 30, category: 'food', requires: req('farm'), expand: true },
    { key: 'bakery', target: target.foodLines, priority: 30, category: 'food', requires: req('mill'), expand: true },
    { key: 'fishery', target: secondaryFoodLines, priority: 30, category: 'food', expand: true },
    { key: 'vineyard', target: secondaryFoodLines, priority: 30, category: 'food', expand: true },
    { key: 'winery', target: secondaryFoodLines, priority: 30, category: 'food', requires: req('vineyard'), expand: true },
    { key: 'pigfarm', target: secondaryFoodLines, priority: 30, category: 'food', expand: true },
    { key: 'butcher', target: secondaryFoodLines, priority: 30, category: 'food', requires: req('pigfarm'), expand: true },
    { key: 'tavern', target: E >= 3 ? 2 : 1, priority: 30, category: 'food', requires: req('bakery'), expand: true },
    { key: 'goldmine', target: target.coinLines, priority: 30, category: 'coin', expand: true },
    { key: 'coalmine', target: target.coinLines + target.armsLines, priority: 30, category: 'coin', expand: true },
    { key: 'mint', target: target.coinLines, priority: 30, category: 'coin', requires: req('goldmine', 'coalmine'), expand: true },
    { key: 'ironmine', target: target.armsLines, priority: 30, category: 'war', expand: true },
    { key: 'smithy', target: target.armsLines, priority: 30, category: 'war', requires: req('ironmine', 'coalmine'), expand: true },
    { key: 'armory', target: target.armsLines, priority: 30, category: 'war', requires: req('smithy'), expand: true },
    { key: 'barracks', target: E >= 3 ? 2 : 1, priority: 30, category: 'war', expand: true },
    { key: 'stable', target: E >= 3 ? 2 : 0, priority: 30, category: 'war', requires: req('smithy'), expand: true },
    // No Engineer's Workshop: nothing in the total strategy raises curtain
    // walls, so its engines have nothing to break that the line cannot, and
    // the timber and army slots they consumed go to the line instead.
    { key: 'monastery', target: E >= 3 ? 1 : 0, priority: 30, category: 'war', expand: true },
  ];
  return list.filter(goal => goal.target > 0);
}

export class ClassicMacro implements MacroPolicy {
  /** Keys whose placement search recently failed — retried after a cooldown
   *  instead of burning the search budget every pass. */
  private readonly blockedUntil = new Map<BuildingKey, number>();
  /** When the bot started saving toward each unaffordable top goal. */
  private readonly savingSince = new Map<BuildingKey, number>();
  /** Watches construction that will never finish, and demolishes it. */
  private readonly sites = new SiteWatch();
  /** Buildings already linked to the castle by a road — never repaved. */
  private readonly roadedBuildings = new Set<number>();
  private lastThreatAt = -Infinity;
  private lastRoadAt = -Infinity;
  private lastOutpostAt = -Infinity;

  plan(ctx: PolicyContext): GameCommand[] {
    const { view } = ctx;
    if (!view.store) return [];
    if (view.threats.length) this.lastThreatAt = view.elapsed;
    const commands: GameCommand[] = [];
    const rescue = this.planSiteRescue(ctx);
    if (rescue) commands.push(rescue);
    const plots = this.planFieldPlots(ctx);
    if (plots) commands.push(plots);
    // One placement decision per state snapshot: never let an outpost and an
    // economy site jointly exceed capacity or promise the same stock. Paced
    // home towers may pre-empt an opening step; remote towers wait until the
    // shared opening is complete.
    const openingDone = nextOpeningDecision(view.built, view.pending).kind === 'complete';
    let construction = this.planHomeTower(ctx);
    if (!construction && openingDone && view.elapsed - this.lastOutpostAt >= 12) {
      construction = this.planForwardOutpost(ctx);
      if (construction) this.lastOutpostAt = view.elapsed;
    }
    construction ??= this.planBuild(ctx);
    if (construction) commands.push(construction);
    commands.push(...this.planTraining(ctx));
    const road = this.planRoad(ctx);
    if (road) commands.push(road);
    return commands;
  }

  private planHomeTower(ctx: PolicyContext): GameCommand | null {
    return planHomeTower(ctx, this.blockedUntil);
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
    // never pave under attack — stone then belongs to towers and defence
    if (view.threats.length || view.elapsed - this.lastThreatAt < 45) return null;
    // one link every so often, so roads trickle out instead of eating the quarry
    if (view.elapsed - this.lastRoadAt < 20) return null;
    // construction has first claim on stone: reserve what every pending site
    // still needs (plus a small buffer for the next building), and pave only
    // the SURPLUS beyond it. A second quarry's extra income is what turns that
    // surplus from rare to steady — the pro road/tower bankroll.
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
    // No missing paintable cells means the route is complete. Partial links stay
    // eligible and resume on the next surplus-stone pass instead of being
    // blacklisted after their first twelve tiles.
    if (!cells.length) { this.roadedBuildings.add(target.id); return null; }
    this.lastRoadAt = view.elapsed;
    return { type: 'paintRoad', cells };
  }

  /** Fortify distinct contested extractors after the home towers stand. The
   *  mine itself is the anchor, while the shared placement search still owns
   *  safety, spacing, reachability and exact legality. */
  private planForwardOutpost(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile, rng } = ctx;
    if (profile.forwardTowers <= 0 || profile.towerKey !== 'stonetower' || !view.store) return null;
    if ((view.built.stonetower ?? 0) < profile.towers || view.sites.length >= profile.maxPendingSites) return null;

    const home = { x: view.store.x, y: view.store.y };
    const center = { x: Math.floor(world.W / 2), y: Math.floor(world.H / 2) };
    const distance = (a: Coord, b: Coord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const towers = [...view.buildings, ...view.sites].filter(entity => entity.key === 'stonetower');
    const forward = towers.filter(tower => distance(tower, home) >= 16);
    if (forward.length >= profile.forwardTowers || !affordable(ctx, 'stonetower')) return null;

    const mines = view.buildings
      .filter(building => EXTRACTORS.has(building.key) && !!building.worker && distance(building, home) >= 18)
      .sort((a, b) => distance(a, center) - distance(b, center)
        || distance(b, home) - distance(a, home)
        || a.id - b.id);
    const anchor = mines.find(mine => !forward.some(tower => distance(tower, mine) <= 11));
    if (!anchor) return null;
    const reach = 22 + profile.expansion * 8;
    const spot = findBuildingSpot(game, world, view, 'stonetower', rng, ctx.approach, reach, anchor);
    return spot ? { type: 'placeBuilding', key: 'stonetower', x: spot.x, y: spot.y, rot: spot.rot } : null;
  }

  // ---- stalled construction ----
  /** A site whose deliveries and build progress have not moved in minutes is
   *  never finishing (unreachable ground, dead supply line). Demolish it: the
   *  tile frees up, and the sim releases every serf task bound to it. */
  private planSiteRescue(ctx: PolicyContext): GameCommand | null {
    return this.sites.step(ctx.view);
  }

  // ---- fields ----
  private planFieldPlots(ctx: PolicyContext): GameCommand | null {
    return fieldPlots(ctx);
  }

  // ---- construction ----
  private planBuild(ctx: PolicyContext): GameCommand | null {
    const { game, view, profile } = ctx;
    if (view.sites.length >= profile.maxPendingSites) return null;

    // Every persona follows the same real opening, one completed stage at a
    // time. A site is a WAIT state, not permission to leapfrog seven more sites
    // onto the starting builder. Rebuild the Guild Hall first if it was razed.
    if (have(view, 'guildhall') < 1) return this.placeGoal(ctx, 'guildhall');
    const opening = nextOpeningDecision(view.built, view.pending);
    if (opening.kind === 'wait') return null;
    if (opening.kind === 'build') return this.placeGoal(ctx, opening.key);

    const hungry = view.averageWorkerHunger < 45 || economyStock(game, view.owner, 'bread') < 2;
    const outgunned = view.enemyArmySize > view.armySize + 3;
    const broke = storeStock(game, view.owner, 'coin') < profile.workerReserveCoin + 2;
    const threatened = view.elapsed - this.lastThreatAt < 60;

    const coin = storeStock(game, view.owner, 'coin');
    const armyRoom = view.armySize < profile.armyCap;
    // The boom must not outrun its specialists. Coin and military capacity may
    // still grow because they fund/field the recovery; routine food and material
    // sprawl waits until almost every standing post has a villager.
    const pendingWorkerPosts = view.sites.filter(site => !!site.def.worker).length;
    const workforceReady = view.workers.unstaffed === 0
      && pendingWorkerPosts === 0
      && view.workers.freeVillagers >= VILLAGER_RESERVE;
    const timber = economyStock(game, view.owner, 'timber'), stone = economyStock(game, view.owner, 'stone');
    const materialProducer: BuildingKey[] = ['woodcutter', 'sawmill', 'quarry', 'forester'];
    // Hold a real timber float before luxury expansion. This buffer used to be
    // justified as reserving the ten-timber lump for a siege engine, but that
    // was never the work it did: `starved` restricts expansion to material
    // producers and coin, so the reserve is what kept the seat raising a SECOND
    // timber line and a third quarry instead of sprawling. Removing it with the
    // siege cost Godlike its entire premium arm — measured at 18 minutes, the
    // roster went from 8 lancers, 4 horse archers and 3 knights to no mounted
    // units at all, with no stable, no monastery, two stone towers instead of
    // five and one woodcutter instead of two.
    const timberBuffer = (view.built.armory ?? 0) > 0 ? 12 : 3;
    const starved = timber < timberBuffer || stone < 3;
    const candidates = goals(profile.expansion)
      .filter(goal => have(view, goal.key) < goal.target)
      // Expansion is earned by staffing the settlement already on the map.
      // Letting coin/war goals bypass this gate produced impressive-looking
      // rows of empty mines and mints, then a permanent zero-coin deadlock.
      .filter(goal => !goal.expand || workforceReady)
      .filter(goal => !goal.expand || !starved || materialProducer.includes(goal.key) || goal.category === 'coin')
      .filter(goal => (goal.requires ?? []).every(key => (view.built[key] ?? 0) > 0))
      .filter(goal => (this.blockedUntil.get(goal.key) ?? 0) <= view.elapsed)
      .map(goal => {
        let value = goal.priority;
        if (goal.category === 'food' && hungry) value *= 1.6;
        if (goal.category === 'war' && (outgunned || threatened)) value *= 1.5;
        if (goal.category === 'coin' && broke) value *= 1.7;
        if (goal.expand) value = this.expansionValue(ctx, goal, coin, armyRoom);
        return { goal, value };
      })
      .filter(candidate => candidate.value > 0)
      .sort((a, b) => b.value - a.value);

    for (const { goal } of candidates.slice(0, 3)) {
      // SAVE for the best goal instead of buying cheaper, lesser ones — an
      // affordability filter here silently starved the barracks forever while
      // low-priority buildings kept spending the timber the moment it landed.
      // But saving has a patience window: income for a good can DIE (all
      // nearby trees felled), and waiting on a dead stream deadlocks the base.
      if (!affordable(ctx, goal.key)) {
        const since = this.savingSince.get(goal.key);
        if (since === undefined) { this.savingSince.set(goal.key, view.elapsed); return null; }
        if (view.elapsed - since < 90) return null;
        this.savingSince.delete(goal.key);
        this.blockedUntil.set(goal.key, view.elapsed + 60);
        continue;
      }
      this.savingSince.delete(goal.key);
      const command = this.placeGoal(ctx, goal.key);
      if (command) return command;
    }
    return null;
  }

  /** Place one validated site. The shared helper keeps opening, recovery and
   * expansion on the exact same reach/cooldown policy. */
  private placeGoal(ctx: PolicyContext, key: BuildingKey): GameCommand | null {
    return placeBuilding(ctx, key, this.blockedUntil);
  }

  /** Score the one supplier-first step each production line is allowed to take.
   * Standing + pending counts prevent rapid passes from duplicating sites, and
   * an in-flight stage pauses its own line until that stage actually stands. */
  private expansionValue(ctx: PolicyContext, goal: BuildGoal, coin: number, armyRoom: boolean): number {
    const { game, view } = ctx;
    const planned = plannedBuildingCounts(view.built, view.pending);
    const p = (key: BuildingKey): number => planned[key] ?? 0;
    const stock = (item: string): number => economyStock(game, view.owner, item);
    const pendingAny = (...keys: BuildingKey[]): boolean => keys.some(key => (view.pending[key] ?? 0) > 0);
    const targets = expansionTargets(ctx.profile.expansion);

    const timberNext = pendingAny('woodcutter', 'sawmill')
      ? null : nextTimberLineBuild(planned, targets.timberLines);
    const coinNext = pendingAny('goldmine', 'coalmine', 'mint')
      ? null : nextCoinLineBuild(planned, targets.coinLines);
    const armsNext = pendingAny('ironmine', 'coalmine', 'smithy', 'armory')
      ? null : nextArmsLineBuild(planned, targets.armsLines);

    const lineValue = (next: BuildingKey | null, value: number): number => goal.key === next ? value : 0;
    const pairedNext = (
      source: BuildingKey, sink: BuildingKey, target: number,
    ): BuildingKey | null => {
      if (pendingAny(source, sink)) return null;
      if (p(sink) < p(source)) return sink;
      return p(source) < target ? source : null;
    };

    switch (goal.key) {
      // Timber capacity is an invariant, not a scarcity contest: a pair always
      // grows woodcutter first, then sawmill, and no pass can stack duplicates.
      case 'woodcutter': case 'sawmill':
        return lineValue(timberNext, 62 + Math.max(0, 14 - stock('timber')) * 3);
      case 'quarry':
        return pendingAny('quarry') ? 0 : (stock('stone') < 20 ? 54 + (20 - stock('stone')) * 2 : 24);
      case 'forester':
        return pendingAny('forester') ? 0 : (uncoveredWoodcutter(view) ? 78 : 0);

      // A mint is always the third step of gold → dedicated coal → mint. Arms
      // consume a separate coal allowance, so neither line steals the other's.
      case 'goldmine': case 'mint':
        return lineValue(coinNext, 58 + Math.max(0, 18 - coin) * 2);
      case 'coalmine': {
        const coinValue = coinNext === 'coalmine' ? 58 + Math.max(0, 18 - coin) * 2 : 0;
        const armsValue = armsNext === 'coalmine' ? 72 + Math.max(0, 8 - stock('weapon') - stock('armor')) * 2 : 0;
        return Math.max(coinValue, armsValue);
      }
      case 'ironmine': case 'smithy': case 'armory':
        return lineValue(armsNext, 72 + Math.max(0, 8 - stock('weapon') - stock('armor')) * 2);

      // Bread remains the staple. Extra wine/meat/fish chains broaden tavern
      // buffs but do not outrank a missing weapon, coin or material stage.
      case 'farm': case 'mill': case 'bakery': {
        const next = p('mill') < p('farm') ? 'mill'
          : p('bakery') < p('mill') ? 'bakery'
            : p('farm') < targets.foodLines ? 'farm' : null;
        return pendingAny('farm', 'mill', 'bakery') ? 0
          : lineValue(next, stock('bread') < 8 ? 56 : 28);
      }
      case 'vineyard': case 'winery':
        return lineValue(pairedNext('vineyard', 'winery', Math.max(1, ctx.profile.expansion)), stock('wine') < 4 ? 36 : 18);
      case 'pigfarm': case 'butcher':
        return lineValue(pairedNext('pigfarm', 'butcher', Math.max(1, ctx.profile.expansion)), stock('sausage') < 4 ? 38 : 18);
      case 'fishery': return pendingAny('fishery') ? 0 : (stock('fish') < 4 ? 34 : 16);
      case 'tavern': return pendingAny('tavern') ? 0 : (view.averageWorkerHunger < 75 ? 42 : 18);
    }

    // Unlock the advanced roster before cheap units can consume its quota. Only
    // Godlike has these goals; Hard intentionally stays a barracks army.
    const first = p(goal.key) === 0;
    if (goal.category === 'war') {
      if (first) return 86;
      if (!armyRoom || coin < 10) return 0;
      return 38 + Math.min(30, coin);
    }
    return first ? 35 : 0;
  }

  // ---- training ----
  private planTraining(ctx: PolicyContext): GameCommand[] {
    const commands: GameCommand[] = [];
    const civilian = this.planCivilian(ctx);
    if (civilian) commands.push(civilian);
    // The Guild Hall command executes first and spends one coin. Reserve it in
    // the parallel military decision so both commands are valid against the
    // same snapshot instead of silently overcommitting the last coin.
    const fighter = this.planFighter(ctx, civilian ? 1 : 0);
    if (fighter) commands.push(fighter);
    return commands;
  }

  private planCivilian(ctx: PolicyContext): GameCommand | null {
    return staffEconomy(ctx);
  }

  private planFighter(ctx: PolicyContext, civilianCoinReserve = 0): GameCommand | null {
    return trainFighter(ctx, ctx.profile.unitMix, civilianCoinReserve);
  }
}
