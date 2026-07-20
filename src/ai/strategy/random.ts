import type { BuildingKey } from '../../types';
import type { GameCommand } from '../../net/protocol';
import { findBuildingSpot } from '../actuation';
import { storeStock } from '../perception';
import type { MacroPolicy, PolicyContext } from './types';

/** Buildings the random seat may throw down (nothing exotic, all near-base). */
const RANDOM_BUILDS: BuildingKey[] = [
  'woodcutter', 'sawmill', 'quarry', 'farm', 'mill', 'bakery', 'barracks', 'watchtower', 'guildhall',
];

/**
 * Phase 0 seam-prover: legal random commands on a slow cadence. Random is the
 * second rung of the ladder — a policy that at least interacts with the sim,
 * which Classic must beat decisively to prove it actually plays the game.
 */
export class RandomMacro implements MacroPolicy {
  plan(ctx: PolicyContext): GameCommand[] {
    const { game, world, view, rng } = ctx;
    if (!view.store) return [];
    const roll = rng.next();
    if (roll < 0.4) {
      const key = RANDOM_BUILDS[rng.int(RANDOM_BUILDS.length)];
      if (view.sites.length >= ctx.profile.maxPendingSites) return [];
      const spot = findBuildingSpot(game, world, view, key, rng, ctx.approach);
      return spot ? [{ type: 'placeBuilding', key, x: spot.x, y: spot.y, rot: spot.rot }] : [];
    }
    if (roll < 0.7) {
      // queue something somewhere it can be queued (the sim validates the cost)
      const trainers = view.buildings.filter(b => (b.def.military || b.def.trainer) && b.active && (b.trainQ?.length ?? 0) < 2);
      if (!trainers.length) return [];
      const building = trainers[rng.int(trainers.length)];
      const units = (building.def.military ?? building.def.trainer)!.units;
      const pick = units[rng.int(units.length)];
      const cost = game.modsFor(view.owner).unitCost(pick.kind, pick.cost) as Record<string, number>;
      for (const item in cost) if (storeStock(game, view.owner, item) < cost[item]) return [];
      return [{ type: 'queueTraining', buildingId: building.id, unit: pick.kind }];
    }
    if (roll < 0.85 && view.army.length) {
      const x = rng.int(world.W), y = rng.int(world.H);
      if (!world.passable(x, y)) return [];
      return [{
        type: 'orderUnits', unitIds: view.army.map(unit => unit.id),
        order: { type: 'attackMove', x, y }, formation: 'box',
      }];
    }
    return [];
  }
}
