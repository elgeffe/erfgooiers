import { DEFS } from '../../data/buildings';
import { UNITS, type UnitKind } from '../../data/units';
import { findPath } from '../../engine/pathfinding';
import { doorTile } from '../../game/util';
import { planDefensiveLine } from '../../game/fortification';
import type { BuildingKey, Building, Coord } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { findBuildingSpot, planPlots } from '../actuation';
import { economyStock, have, storeStock } from '../perception';
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
  for (const kind in byKind) {
    const def = UNITS[kind as UnitKind];
    // Support and siege are strategic quotas, not a field-composition signal:
    // treating priests as melee and trebuchets as ranged taught the counter
    // system to suppress exactly the combined-arms tools Godlike needs.
    if (def?.heal || def?.model === 'siege') continue;
    const n = byKind[kind as UnitKind] ?? 0;
    total += n;
    cats[unitCategory(kind)] += n;
  }
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

/** Convert composition weights into exact standing-army slots. Largest-
 * remainder allocation is deterministic and sums to the cap, so cheap units
 * cannot consume slots reserved for cavalry, siege or priests. */
export function allocateUnitQuotas(weights: Readonly<Record<string, number>>, cap: number): Record<string, number> {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!entries.length || total <= 0 || cap <= 0) return {};
  const rows = entries.map(([kind, weight]) => {
    const exact = weight / total * cap;
    return { kind, quota: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = cap - rows.reduce((sum, row) => sum + row.quota, 0);
  rows.sort((a, b) => b.remainder - a.remainder || a.kind.localeCompare(b.kind));
  for (let i = 0; i < rows.length && left > 0; i++, left--) rows[i].quota++;
  return Object.fromEntries(rows.map(row => [row.kind, row.quota]));
}

/**
 * The Classic baseline (Phase 1): a handwritten, layered, fair macro policy.
 * Build order is not a rigid list but a utility score over candidate goals —
 * situations reweight categories (war when outgunned, food when hungry, coin
 * when broke), so the same code plays every difficulty persona; the personas
 * themselves differ only in profile knobs (docs/skirmish-ai-design.md).
 */

type Category = 'economy' | 'food' | 'coin' | 'war' | 'fort';

/** A new staffed site must not have to wait for its first worker—or gamble its
 * hiring coin against the barracks. Two spare villagers also absorb a pair of
 * specialist casualties without collapsing an entire production line. */
const VILLAGER_RESERVE = 2;
const EXTRACTORS = new Set<BuildingKey>(['quarry', 'goldmine', 'coalmine', 'ironmine']);
const TIMBER_SUPPORT_RANGE = 9;

/** A forester is useful only when its planting ground overlaps an uncovered
 * woodcutter. Stable coordinate ordering preserves replay determinism. */
export function selectUncoveredWoodcutter(
  woodcutters: readonly Coord[], foresters: readonly Coord[], range = TIMBER_SUPPORT_RANGE,
): Coord | null {
  return [...woodcutters]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .find(woodcutter => !foresters.some(forester => Math.max(
      Math.abs(forester.x - woodcutter.x), Math.abs(forester.y - woodcutter.y),
    ) <= range)) ?? null;
}

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
function goals(towers: number, expansion: number, stoneTowers: boolean): BuildGoal[] {
  const E = expansion;
  const target = expansionTargets(E);
  const secondaryFoodLines = E >= 3 ? 2 : 1;
  const req = (...keys: BuildingKey[]): BuildingKey[] => keys;
  const towerKey: BuildingKey = stoneTowers ? 'stonetower' : 'watchtower';
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
    { key: 'engineer', target: E >= 3 ? 2 : 0, priority: 30, category: 'war', expand: true },
    { key: 'monastery', target: E >= 3 ? 1 : 0, priority: 30, category: 'war', expand: true },
    { key: towerKey, target: towers, priority: 30, category: 'fort', expand: true },
  ];
  return list.filter(goal => goal.target > 0);
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
  private lastFortAt = -Infinity;

  plan(ctx: PolicyContext): GameCommand[] {
    const { view } = ctx;
    if (!view.store) return [];
    if (view.threats.length) this.lastThreatAt = view.elapsed;
    const commands: GameCommand[] = [];
    const rescue = this.planSiteRescue(ctx);
    if (rescue) commands.push(rescue);
    const plots = this.planFieldPlots(ctx);
    if (plots) commands.push(plots);
    // One placement decision per state snapshot: never let a fort and an
    // economy site jointly exceed capacity or promise the same stock. The
    // shared opening always finishes first; thereafter wall pieces alternate
    // with economy growth on a slow cadence.
    const openingDone = nextOpeningDecision(view.built, view.pending).kind === 'complete';
    let construction: GameCommand | null = null;
    if (openingDone && view.elapsed - this.lastFortAt >= 12) {
      construction = this.planForwardOutpost(ctx);
      const homeTowerKey: BuildingKey = ctx.profile.wallMaterial === 'stone' ? 'stonetower' : 'watchtower';
      const homeTowersReady = (view.built[homeTowerKey] ?? 0) >= ctx.profile.towers;
      if (!construction && homeTowersReady && ctx.profile.walls > 0) construction = this.planFortification(ctx);
      if (construction) this.lastFortAt = view.elapsed;
    }
    construction ??= this.planBuild(ctx);
    if (construction) commands.push(construction);
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

  // ---- defensive lines ----
  /** Wall the ENEMY APPROACH, not the whole castle: a straight curtain with a
   *  central sortie gate, thrown across the open ground the rival must cross,
   *  and anchored to the map's natural barriers — segments whose ground is
   *  already water or rock are skipped (terrain IS the wall there), so the
   *  masonry only closes the gaps between them. Higher `walls` add a second,
   *  closer line as a fallback. Army before masonry; one piece per pass. */
  private planFortification(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile } = ctx;
    if (profile.walls <= 0 || !view.store) return null;
    // army before masonry, strictly: every stone laid before a fighting force
    // stands is measured tempo handed to a rushing rival
    if ((view.built.barracks ?? 0) < 1 || view.armySize < profile.attackArmy * 0.5) return null;
    if (view.sites.length >= profile.maxPendingSites) return null;
    const center = { x: view.store.x + 1, y: view.store.y + 1 };
    // face the rival; with none in view, wall the open map centre (the way in)
    const enemy = view.enemyStore
      ? { x: view.enemyStore.x, y: view.enemyStore.y }
      : { x: Math.round(world.W / 2), y: Math.round(world.H / 2) };
    const naturalBarrier = (x: number, y: number): boolean => {
      const tile = world.T(x, y);
      return !tile || tile.type === 'water' || tile.type === 'rock'; // off-map, lake or ridge
    };
    for (let line = 0; line < profile.walls; line++) {
      const preferred = 11 - line * 4;   // outer line first, then a closer fallback
      // A spread-out settlement can occupy the preferred gate slot. Try a
      // slightly wider/closer curtain, but never raise the wall pieces unless a
      // real friendly gate already stands at its centre.
      for (const distance of [preferred, preferred + 2, preferred - 2]) {
        const pieces = planDefensiveLine(center, enemy, distance, 6);
        const gate = pieces[0];
        const gateTile = world.T(gate.x, gate.y);
        const gateKey: BuildingKey = profile.wallMaterial === 'wood' ? 'woodgate' : 'gate';
        const standingGate = gateTile?.b;
        const pendingGate = gateTile?.site;
        // A site is still a solid obstacle. Wait for the actual gate before
        // closing wall segments around it, or the builder and army can be
        // sealed behind an unfinished centrepiece.
        if (pendingGate?.owner === view.owner && pendingGate.key === gateKey) return null;
        const gateReady = standingGate?.owner === view.owner && standingGate.key === gateKey;
        if (!gateReady) {
          if (naturalBarrier(gate.x, gate.y) || !this.affordable(ctx, gateKey)
            || !game.canPlace(gateKey, gate.x, gate.y, gate.rot)) continue;
          return { type: 'placeBuilding', key: gateKey, x: gate.x, y: gate.y, rot: gate.rot };
        }
        for (const piece of pieces.slice(1)) {
        // a segment already backed by terrain needs no wall — that is the point
          if (naturalBarrier(piece.x, piece.y) || naturalBarrier(piece.x + 1, piece.y + 1)) continue;
          const tile = world.T(piece.x, piece.y);
          if (!tile || tile.b || tile.site) continue;         // held or hopeless slot
          const key: BuildingKey = profile.wallMaterial === 'wood' ? 'woodwall' : 'wall';
          if (!this.affordable(ctx, key)) return null;
          if (!game.canPlace(key, piece.x, piece.y, piece.rot)) continue;
          return { type: 'placeBuilding', key, x: piece.x, y: piece.y, rot: piece.rot };
        }
        // This distance is complete; don't start a second alternative curtain.
        break;
      }
      // this line is as finished as the ground allows — add the closer fallback
    }
    return null;
  }

  /** Fortify distinct contested extractors after the home towers stand. The
   *  mine itself is the anchor, while the shared placement search still owns
   *  safety, spacing, reachability and exact legality. */
  private planForwardOutpost(ctx: PolicyContext): GameCommand | null {
    const { game, world, view, profile, rng } = ctx;
    if (profile.forwardTowers <= 0 || profile.wallMaterial !== 'stone' || !view.store) return null;
    if ((view.built.stonetower ?? 0) < profile.towers || view.sites.length >= profile.maxPendingSites) return null;

    const home = { x: view.store.x, y: view.store.y };
    const center = { x: Math.floor(world.W / 2), y: Math.floor(world.H / 2) };
    const distance = (a: Coord, b: Coord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const towers = [...view.buildings, ...view.sites].filter(entity => entity.key === 'stonetower');
    const forward = towers.filter(tower => distance(tower, home) >= 16);
    if (forward.length >= profile.forwardTowers || !this.affordable(ctx, 'stonetower')) return null;

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
    const wantsSiege = (view.built.engineer ?? 0) > 0
      && view.army.filter(u => u.role === 'onager' || u.role === 'trebuchet' || u.role === 'ballista').length < 3;
    const timberBuffer = wantsSiege ? 12 : 3; // one siege = 10 timber, plus a little slack
    const starved = timber < timberBuffer || stone < 3;
    const candidates = goals(profile.towers, profile.expansion, profile.wallMaterial === 'stone')
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
        if (goal.category === 'fort' && threatened) value *= 1.6;
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
      if (!this.affordable(ctx, goal.key)) {
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
    const { game, world, view, profile, rng } = ctx;
    if ((this.blockedUntil.get(key) ?? 0) > view.elapsed || !this.affordable(ctx, key)) return null;
    const reach = 22 + profile.expansion * 8;
    const timberAnchor = key === 'forester' ? this.uncoveredWoodcutter(view) : null;
    // Never scatter a forester beyond the nine-tile timber ecosystem it serves.
    // If every cutter is already covered, another lodge adds no capacity.
    if (key === 'forester' && !timberAnchor) return null;
    const spot = findBuildingSpot(
      game, world, view, key, rng, ctx.approach, reach,
      timberAnchor ?? undefined, timberAnchor ? TIMBER_SUPPORT_RANGE : Infinity,
    );
    if (spot) return { type: 'placeBuilding', key, x: spot.x, y: spot.y, rot: spot.rot };
    this.blockedUntil.set(key, view.elapsed + 45);
    return null;
  }

  private uncoveredWoodcutter(view: PolicyContext['view']): Coord | null {
    const owned = [...view.buildings, ...view.sites];
    return selectUncoveredWoodcutter(
      owned.filter(entity => entity.key === 'woodcutter'),
      owned.filter(entity => entity.key === 'forester'),
    );
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
        return pendingAny('forester') ? 0 : (this.uncoveredWoodcutter(view) ? 78 : 0);

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
    if (goal.category === 'fort') {
      if (p(goal.key) === 0) return 82;
      return view.threats.length ? 76 : 56;
    }
    return first ? 35 : 0;
  }

  private affordable(ctx: PolicyContext, key: BuildingKey): boolean {
    const cost = ctx.game.modsFor(ctx.view.owner).buildingCost(DEFS[key]) as Record<string, number>;
    for (const item in cost) {
      // `countItem` includes goods already carried toward a site. Reserve every
      // outstanding site need so a new command cannot promise the same timber or
      // stone twice and recreate the many-half-built-site gridlock.
      let committed = 0;
      for (const site of ctx.view.sites) {
        committed += Math.max(0, (site.needs[item] ?? 0) - (site.delivered[item] ?? 0));
      }
      if (economyStock(ctx.game, ctx.view.owner, item) - committed < cost[item]) return false;
    }
    return true;
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
      + VILLAGER_RESERVE - view.workers.freeVillagers - queuedOf('villager');
    if (villagersWanted > 0 && coin >= 1) {
      return { type: 'queueTraining', buildingId: guild.id, unit: 'villager' };
    }
    if (coin <= profile.workerReserveCoin) return null;
    // Haulers scale with the economy, but one-per-building overstaffs a town:
    // serfs spend most of their time idle while consuming every new coin ahead
    // of the army. The deeper profiles get a modest distance allowance for
    // their remote mines; the cap remains high enough for the largest planned
    // Godlike settlement without recreating the old ten-serf bottleneck.
    const production = view.buildings.filter(b => b.def.recipe || b.def.gather || b.def.tavern).length;
    const mobilising = profile.attackEnabled && view.armySize < profile.attackArmy;
    const serfScale = mobilising ? 0.4 : 0.5 + profile.expansion * 0.1;
    const serfTarget = Math.min(6 + Math.ceil(production * serfScale), mobilising ? 24 : 36);
    if (view.workers.serfs + queuedOf('serf') < serfTarget) {
      return { type: 'queueTraining', buildingId: guild.id, unit: 'serf' };
    }
    // Builders are deliberately last: the starting builder carries the whole
    // opening; extra construction throughput is a late-game luxury only after
    // every job is staffed and the logistics target is met.
    const coinEngineRunning = view.buildings.some(b => b.key === 'mint' && b.worker);
    const laborerTarget = coinEngineRunning && view.elapsed > 360 ? Math.min(3, Math.max(1, view.sites.length)) : 1;
    if (view.workers.laborers + queuedOf('laborer') < laborerTarget) {
      return { type: 'queueTraining', buildingId: guild.id, unit: 'laborer' };
    }
    return null;
  }

  private planFighter(ctx: PolicyContext, civilianCoinReserve = 0): GameCommand | null {
    const { game, view, profile, rng } = ctx;
    // Specialists come first. A queued barracks fighter must never spend the
    // coin that turns a completed production building (or imminent site) into
    // a working one. This is deliberately stronger than the ordinary reserve:
    // once every post is covered, civilian and military queues may run in
    // parallel again.
    if (view.workers.unstaffed > 0) return null;
    let queuedTotal = 0;
    const queuedByKind: Record<string, number> = {};
    const trainers: Building[] = [];
    for (const building of view.buildings) {
      if (!building.def.military || !building.active) continue;
      for (const kind of building.trainQ ?? []) {
        queuedTotal++;
        queuedByKind[kind] = (queuedByKind[kind] ?? 0) + 1;
      }
      if ((building.trainQ?.length ?? 0) < 2) trainers.push(building);
    }
    if (!trainers.length || view.armySize + queuedTotal >= profile.armyCap) return null;

    // Worker coins are permanent working capital. A staffed mint can still run
    // dry when its first ore vein exhausts or a miner dies; spending the final
    // coins on fighters at that moment makes the whole economy unrecoverable.
    const coinReserve = profile.workerReserveCoin + civilianCoinReserve;

    // A better player scouts the rival army and trains counters: the target
    // mix is reweighted toward what beats the enemy's dominant category (graded
    // by profile.counter). Full visibility, so it's the same read a human gets.
    const enemyDom = profile.counter > 0 ? dominantEnemyCategory(view.enemyArmyByKind) : null;

    // Allocate the final cap into exact per-kind slots. When all affordable
    // kinds have filled their quotas, WAIT for the missing premium resource or
    // trainer; never fill its reserved slots with another cheap archer.
    const target: Record<string, number> = {};
    for (const kind in profile.unitMix) {
      let w = profile.unitMix[kind as keyof typeof profile.unitMix] ?? 0;
      const def = UNITS[kind as UnitKind];
      if (enemyDom && !def?.heal && def?.model !== 'siege') {
        w *= counterMultiplier(kind, enemyDom.cat, profile.counter * enemyDom.frac);
      }
      if (w > 0) target[kind] = w;
    }
    const fullQuotas = allocateUnitQuotas(target, profile.armyCap);
    const projected: Record<string, number> = { ...queuedByKind };
    for (const unit of view.army) projected[unit.role] = (projected[unit.role] ?? 0) + 1;
    const projectedTotal = Object.values(projected).reduce((sum, count) => sum + count, 0);
    const availableKinds = new Set<string>();
    for (const building of trainers) for (const training of building.def.military!.units) {
      if ((target[training.kind] ?? 0) > 0) availableKinds.add(training.kind);
    }
    const availableFullSlots = [...availableKinds].reduce((sum, kind) => sum + (fullQuotas[kind] ?? 0), 0);
    // Before the Stable/Engineer/Monastery stand, reserved premium slots must
    // not leave the town defended by half an army. Reallocate only the first
    // wave floor over the trainers that exist; once that defensive core stands,
    // switch back to the exact final cap so every remaining slot is premium.
    const quotas = projectedTotal < profile.attackArmy && availableFullSlots < profile.attackArmy
      ? allocateUnitQuotas(Object.fromEntries([...availableKinds].map(kind => [kind, target[kind]])), profile.attackArmy)
      : fullQuotas;
    let structuralSiege = 0, priests = 0;
    for (const kind in projected) {
      const count = projected[kind] ?? 0;
      const def = UNITS[kind as UnitKind];
      if ((def?.structureMult ?? 1) > 1) structuralSiege += count;
      if (def?.heal) priests += count;
    }
    const hasEngineer = trainers.some(trainer => trainer.key === 'engineer');

    let best: { building: Building; kind: string } | null = null;
    let bestDeficit = -Infinity;
    for (const building of trainers) {
      for (const training of building.def.military!.units) {
        const kind = training.kind;
        const quota = quotas[kind] ?? 0;
        if (quota <= 0 || (projected[kind] ?? 0) >= quota) continue;
        const cost = game.modsFor(view.owner).unitCost(kind, training.cost) as Record<string, number>;
        const def = UNITS[kind as UnitKind];
        const structural = (def?.structureMult ?? 1) > 1;
        // A one-timber horse archer must not consume every trickle forever
        // while the Engineer waits for the ten-timber trebuchet lump. Reserve
        // one missing engine at a time; the engine itself may spend the fund.
        const siegeTimberReserve = !structural && structuralSiege < profile.minSiege
          && hasEngineer ? 10 : 0;
        let ok = true;
        for (const item in cost) {
          const reserve = item === 'coin' ? coinReserve : item === 'timber' ? siegeTimberReserve : 0;
          if (storeStock(game, view.owner, item) < cost[item] + reserve) { ok = false; break; }
        }
        if (!ok) continue;
        // Normalized missing quota, plus tiny deterministic jitter for ties.
        const essential = (def?.structureMult ?? 1) > 1 && structuralSiege < profile.minSiege
          ? 20
          : def?.heal && priests < profile.minPriests ? 15 : 0;
        const deficit = essential + (quota - (projected[kind] ?? 0)) / quota + rng.next() * 0.002;
        if (deficit > bestDeficit) { bestDeficit = deficit; best = { building, kind }; }
      }
    }
    if (!best) return null;
    return { type: 'queueTraining', buildingId: best.building.id, unit: best.kind };
  }
}
