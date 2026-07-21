import { DEFS } from '../../data/buildings';
import { UNITS, type UnitKind } from '../../data/units';
import { findPath } from '../../engine/pathfinding';
import { doorTile } from '../../game/util';
import { planDefensiveLine } from '../../game/fortification';
import type { BuildingKey, Building, Coord, ItemKey } from '../../types';
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
 * situations reweight categories (war when outgunned, food when hungry, coin
 * when broke), so the same code plays every difficulty persona; the personas
 * themselves differ only in profile knobs (docs/skirmish-ai-design.md).
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
  /** Endless-expansion goal (vs a fixed opening): its priority is decided by
   *  current scarcity of its output, not a fixed opening order. */
  expand?: boolean;
}

/** What a producer building outputs — drives scarcity-boosted expansion (build
 *  more of what the economy is short of). Raw gatherers and intermediates only;
 *  military/fort buildings expand on coin surplus, not an output. */
const OUTPUT: Partial<Record<BuildingKey, ItemKey>> = {
  woodcutter: 'trunk', sawmill: 'timber', quarry: 'stone', farm: 'wheat',
  mill: 'flour', bakery: 'bread', goldmine: 'goldore', coalmine: 'coal',
  ironmine: 'iron', mint: 'coin', smithy: 'weapon', armory: 'armor',
};

function goals(towers: number, scale: number, expansion: number): BuildGoal[] {
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
    // NOTE: the market is intentionally OFF the build order for now — its export
    // orders vacuum the very gold ore, stone, timber and bread the base needs to
    // build and feed itself, doing more harm than the coin it earned.
    { key: 'watchtower', target: towers, priority: 54, category: 'fort' },
  ];

  // ---- endless, tier-scaled expansion ----
  // Fixed caps make a strong economy plateau (measured: Godlike froze at 25
  // buildings with 280 coin idle and an all-archer army it couldn't diversify).
  // Instead the higher tiers keep compounding producers and open the full
  // military spread, so surplus coin becomes a bigger, more varied army. The
  // scorer (planBuild) decides WHICH to build from current scarcity; these just
  // set how deep each tier may go. Easy (expansion 0) never reaches this — it
  // stays a small, beatable settlement.
  const E = expansion;
  if (E > 0) {
    const cap = (n: number): number => Math.max(0, Math.round(n));
    const req = (...keys: BuildingKey[]): BuildingKey[] => keys;
    // Caps are generous CEILINGS, not targets — scarcity scoring (planBuild)
    // stops building a producer the moment its output is plentiful, so extra
    // headroom just lets the bot chase a real bottleneck instead of stalling.
    // Coal is the sharpest one: it feeds the mint AND every smithy AND every
    // armory, so weapons and armour (and thus soldiers/knights/cavalry) all
    // starve behind it — hence the deepest coal ceiling.
    // The mid-game boom (learned from a winning human replay): the settlement
    // multiplies its COIN ENGINE — many mints, and the gold + coal to feed
    // them — so coin compounds into a continuous, diverse late-game army. Caps
    // are generous CEILINGS; the compounding scorer (expansionValue) decides
    // how far each actually goes from the chain's real bottleneck.
    const grow: [BuildingKey, number, Category, BuildingKey[]?][] = [
      ['woodcutter', 3 + 2 * E, 'economy'],
      ['sawmill', 2 + E, 'economy', req('woodcutter')],
      ['forester', 1 + Math.floor(E / 2), 'economy', req('woodcutter')],
      ['quarry', 3 + 2 * E, 'economy'],
      ['farm', 1 + E, 'food'],
      ['mill', E, 'food', req('farm')],
      ['bakery', E, 'food', req('mill')],
      ['tavern', E >= 2 ? 1 : 0, 'food', req('bakery')],
      ['goldmine', 2 + 2 * E, 'coin'],         // gold ore is the mints' fuel
      ['coalmine', 3 + 3 * E, 'coin'],         // feeds the mints AND smithies AND armories
      ['mint', E >= 2 ? 1 + E : 0, 'coin', req('goldmine', 'coalmine')], // the coin engine, multiplied
      ['market', E >= 3 ? 1 : 0, 'coin', req('quarry')], // late surplus → coin (godlike only)
      ['ironmine', 2 + E, 'war'],
      ['smithy', 1 + E, 'war', req('ironmine', 'coalmine')],
      ['armory', E >= 2 ? E : 0, 'war', req('smithy')],   // armour for knights & horse knights
      ['barracks', 1 + E, 'war'],
      ['stable', E >= 2 ? 1 : 0, 'war'],       // cavalry: lancers, horse knights/archers
      ['engineer', E >= 2 ? 1 : 0, 'war'],     // siege: onagers, trebuchets
      ['monastery', E >= 2 ? 1 : 0, 'war'],    // priests to heal the line
    ];
    for (const [key, base, category, requires] of grow) {
      const target = cap(base);
      if (target > 0) list.push({ key, target, priority: 30, category, requires, expand: true });
    }
  }
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
    // wall-building personas fortify first and expand second; the rest
    // fortify with whatever build capacity the economy goals leave over
    const fortFirst = ctx.profile.walls > 0;
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
      const distance = 11 - line * 4;   // outer line first, then a closer fallback
      for (const piece of planDefensiveLine(center, enemy, distance, 6)) {
        // a segment already backed by terrain needs no wall — that is the point
        if (naturalBarrier(piece.x, piece.y) || naturalBarrier(piece.x + 1, piece.y + 1)) continue;
        const tile = world.T(piece.x, piece.y);
        if (!tile || tile.b || tile.site) continue;           // held or hopeless slot
        const key: BuildingKey = piece.kind === 'gate' ? 'gate' : 'wall';
        if (!this.affordable(ctx, key)) return null;          // wait for the stone
        if (!game.canPlace(key, piece.x, piece.y, piece.rot)) continue;
        return { type: 'placeBuilding', key, x: piece.x, y: piece.y, rot: piece.rot };
      }
      // this line is as finished as the ground allows — add the closer fallback
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
    const hungry = view.averageWorkerHunger < 45 || economyStock(game, view.owner, 'bread') < 2;
    const outgunned = view.enemyArmySize > view.armySize + 3;
    const broke = storeStock(game, view.owner, 'coin') < profile.workerReserveCoin + 2;
    const threatened = view.elapsed - this.lastThreatAt < 60;

    const coin = storeStock(game, view.owner, 'coin');
    const armyRoom = view.armySize < profile.armyCap;
    // The endless mid-game expansion waits for the COIN ENGINE to run: a mint
    // built AND staffed, earning. Booming before that (a 2nd barracks, deep
    // mines) drains the opening's finite timber/stone and deadlocks the base at
    // zero coin — it can never afford the mint that would restart the economy
    // (measured: godlike froze at 8 buildings, 0 timber). The opening builds
    // straight through; only the `expand` goals hold for the mint.
    const coinEngineRunning = view.buildings.some(b => b.key === 'mint' && b.worker);
    // COIN ENGINE FIRST: until a mint STANDS, build only the chain that leads to
    // it (wood→timber, stone, gold, coal, mint). The mint's requirements aren't
    // met until the goldmine & coalmine finish CONSTRUCTING, and while the bot
    // waits it would otherwise spend its finite starting timber on a barracks /
    // ironmine / farm and never afford the mint — the coin deadlock. A 2-minute
    // fallback lets a mint-less map (no gold vein) proceed anyway.
    const preMint: BuildingKey[] = ['guildhall', 'woodcutter', 'sawmill', 'quarry', 'goldmine', 'coalmine', 'mint', 'forester'];
    const coinFirst = (view.built.mint ?? 0) === 0 && view.elapsed < 120;
    // The boom must not outrun its STAFFING: every RAW/food producer needs a
    // villager, and villagers cost coin, so sprawling those while posts sit
    // empty spends every coin on hiring and fields no army (measured: 76
    // buildings, coin 0, army 0). Pausing them while >2 posts are unstaffed
    // self-throttles the sprawl to what coin income can staff. EXEMPT: the coin
    // chain (mint + its gold/coal feed) — it GROWS income and takes control of
    // the map's central ore, the pro's edge — and war/fort (they unlock the
    // army). This is what compounds coin into the ever bigger, diverse army.
    const staffed = view.workers.unstaffed <= 2;
    const grows = (c: Category): boolean => c === 'war' || c === 'fort' || c === 'coin';
    // ANTI-GRIDLOCK: construction is timber+stone, so starting sites the base
    // can't supply spreads a trickle of materials across many half-built sites
    // and NONE finish (measured: timber/stone pinned at 0, goldmines stuck as
    // sites, the cheap mint never affordable). So while materials are starved,
    // only the MATERIAL PRODUCERS themselves (which end the starvation) may
    // start — everything else waits for a small buffer to build up.
    const timber = economyStock(game, view.owner, 'timber'), stone = economyStock(game, view.owner, 'stone');
    const materialProducer: BuildingKey[] = ['woodcutter', 'sawmill', 'quarry', 'forester'];
    const starved = timber < 3 || stone < 3;
    const candidates = goals(profile.towers, profile.econScale, profile.expansion)
      .filter(goal => have(view, goal.key) < goal.target)
      .filter(goal => coinEngineRunning || !goal.expand)
      .filter(goal => !coinFirst || preMint.includes(goal.key))
      .filter(goal => !goal.expand || grows(goal.category) || staffed)
      .filter(goal => !goal.expand || !starved || materialProducer.includes(goal.key))
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
      // how far the profile pushes its economy out: low tiers hug home, higher
      // tiers reach for the contested central deposits (never past midfield —
      // findBuildingSpot's safeGround still bars the enemy half)
      const reach = 22 + profile.expansion * 8;
      const spot = findBuildingSpot(game, world, view, goal.key, rng, ctx.approach, reach);
      if (spot) return { type: 'placeBuilding', key: goal.key, x: spot.x, y: spot.y, rot: spot.rot };
      this.blockedUntil.set(goal.key, view.elapsed + 45);
    }
    return null;
  }

  /** Score an endless-expansion goal by what the economy actually needs now.
   *  Multi-stage chains defeat a stock snapshot: an intermediate like iron or
   *  coal reads ~0 whether it flows healthily or starves three smithies, so a
   *  RAW producer is instead valued by producer/consumer BALANCE — build one
   *  more while it is outnumbered by the buildings that burn its output. Final
   *  goods (timber, stone, weapons, bread) keep the stock-scarcity signal;
   *  military buildings spend surplus coin and open new unit types. */
  private expansionValue(ctx: PolicyContext, goal: BuildGoal, coin: number, armyRoom: boolean): number {
    const { game, view } = ctx;
    const b = (key: BuildingKey): number => view.built[key] ?? 0;
    const stock = (item: string): number => economyStock(game, view.owner, item);
    // one more producer while consumers outnumber it (× a headroom factor): the
    // chain-balance signal. Headroom > 1 OVER-provisions a shared input so a
    // greedy consumer can't starve the others — the mint, left 1:1, drinks all
    // the coal and leaves every smithy dry (measured: 140 coin, 0 weapons).
    const feed = (producers: number, consumers: number, headroom = 1): number => {
      const want = Math.ceil(consumers * headroom);
      return want > 0 && producers < want ? 40 + (want - producers) * 14 : 0;
    };

    const armySpace = view.armySize < ctx.profile.armyCap;
    switch (goal.key) {
      // ---- the coin engine (the mid-game boom's heart) ----
      // A winning human multiplies MINTS and feeds them: more mints = more
      // coin = a bigger, more diverse standing army. Keep opening mints while
      // gold+coal supply can feed them and there's still an army to pay for.
      // The COIN ENGINE, decoupled so it actually compounds (a mint-per-goldmine
      // vs goldmine-per-mint loop kept both pinned at one, starving the army of
      // the coin that buys knights, cavalry and priests — the all-archer
      // plateau). A pro instead SEIZES the map's gold: goldmines grow whenever
      // coin is short (which is most of the game — the army spends it), claiming
      // veins out to the contested centre; mints then follow the gold, and coal
      // is over-provisioned to feed the mints and the weapon chain both.
      case 'mint': {
        if (b('mint') === 0) return 60;
        const supply = Math.min(b('goldmine'), b('coalmine')); // one mint per gold+coal feed
        return b('mint') < supply ? 62 + (supply - b('mint')) * 8 : (coin < 12 ? 40 : 0);
      }
      case 'goldmine':
        // grab gold while coin is short (claim the map's veins), but keep only a
        // small lead on the mints so goldmine sites don't gridlock construction
        // while the mint they feed waits for materials
        return b('goldmine') < b('mint') + 1 ? 56 : (coin < 25 && b('goldmine') < 5 ? 46 : 0);
      case 'coalmine': return feed(b('coalmine'), b('mint') + b('smithy') + b('armory') + b('goldmine'), 1.4);
      case 'ironmine': return feed(b('ironmine'), b('smithy') + b('armory'), 1.5);
      // ---- the timber & stone chain: it MUST keep construction supplied, so it
      // is valued by its good's scarcity and outbids other producers when the
      // base runs dry (an empty materials pile gridlocks every other site) ----
      case 'woodcutter': return stock('timber') < 12 ? 44 + (12 - stock('timber')) * 6 : feed(b('woodcutter'), b('sawmill'));
      case 'sawmill': return b('sawmill') < b('woodcutter') ? 48 : (stock('timber') < 10 ? 30 : 0);
      case 'quarry': return stock('stone') < 14 ? 44 + (14 - stock('stone')) * 6 : 0;
      case 'forester': return b('forester') < 1 ? 42 : (b('forester') < b('woodcutter') / 3 ? 30 : 0);
      case 'farm': return feed(b('farm'), b('mill')) || (stock('wheat') < 3 ? 35 : 0);
      // ---- crafters & final goods: stock scarcity (what's actually short) ----
      case 'mill': return b('mill') < b('farm') ? 30 : 0;
      case 'bakery': return stock('bread') < 6 ? 30 : 0;
      case 'market': return b('market') === 0 && coin < 20 && stock('stone') > 12 ? 26 : 0;
      // weapons & armour gate the whole DIVERSE army — short of them the bot can
      // only field timber-only archers (the measured all-archer plateau), so
      // these crafters outbid a cheaper producer whenever they run dry
      case 'smithy': return b('smithy') === 0 ? 62 : (feed(b('smithy'), b('barracks') + b('stable') + 1) || (stock('weapon') < 8 ? 42 : 0));
      // the first armory unlocks armour → knights & horse knights (a big slice
      // of the diverse mix); further ones only while armour is short
      case 'armory': return b('armory') === 0 ? 58 : (stock('armor') < 8 ? 36 : 0);
    }

    // ---- military / production-enabling buildings ----
    // Opening the FIRST of a kind unlocks a whole unit type (stable → cavalry,
    // engineer → siege, monastery → priests, extra barracks → throughput), and
    // it must happen EARLY — before the army fills with soldiers/archers and
    // leaves no room for the fancy units — so first-of-kind outbids another
    // producer. Further copies just spend surplus coin.
    const first = b(goal.key) === 0;
    if (goal.category === 'war') {
      if (first) return 72;
      if (!armyRoom || coin < 10) return 0;
      return 28 + Math.min(40, coin);                 // richer → keener to add production
    }
    if (goal.key === 'tavern') return view.averageWorkerHunger < 70 ? 45 : 0;
    return first ? 35 : 0;
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
    // Haulers scale with the economy: a sprawling base with mines scattered to
    // their ore veins needs FAR more serfs than a compact opening, or the ore
    // piles at the mines and the weapon chain starves downstream (measured: 7
    // coalmines yet 0 coal reaching the smithies). A capped 10 throttled the
    // whole logistics economy of the expanding tiers.
    const production = view.buildings.filter(b => b.def.recipe || b.def.gather || b.def.tavern).length;
    const serfTarget = Math.min(6 + Math.ceil(production * (0.7 + profile.expansion * 0.35)), 44);
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
