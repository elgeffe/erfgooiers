import type { BuildingKey } from '../../types';

/** Standing and/or planned building totals, keyed by the simulation identity. */
export type BuildingCounts = Readonly<Partial<Record<BuildingKey, number>>>;

export interface OpeningStep {
  key: BuildingKey;
  /** Cumulative count required when this stage is complete. */
  target: number;
}

export type OpeningDecision =
  | { kind: 'build'; key: BuildingKey; target: number; index: number }
  | { kind: 'wait'; key: BuildingKey; target: number; index: number }
  | { kind: 'complete' };

/**
 * The shared Classic opening. Repeated keys use cumulative targets, making the
 * production-line intent explicit without duplicating special-case ids.
 */
export const COMMON_OPENING = [
  { key: 'woodcutter', target: 1 },
  { key: 'sawmill', target: 1 },
  { key: 'quarry', target: 1 },
  { key: 'goldmine', target: 1 },
  { key: 'coalmine', target: 1 },
  { key: 'mint', target: 1 },
  { key: 'forester', target: 1 },
  { key: 'farm', target: 1 },
  { key: 'mill', target: 1 },
  { key: 'bakery', target: 1 },
  { key: 'tavern', target: 1 },
  { key: 'barracks', target: 1 },
  { key: 'watchtower', target: 1 },
  { key: 'ironmine', target: 1 },
  { key: 'coalmine', target: 2 },
  { key: 'smithy', target: 1 },
  { key: 'armory', target: 1 },
  { key: 'fishery', target: 1 },
  { key: 'vineyard', target: 1 },
  { key: 'winery', target: 1 },
  { key: 'pigfarm', target: 1 },
  { key: 'butcher', target: 1 },
  { key: 'goldmine', target: 2 },
  { key: 'coalmine', target: 3 },
  { key: 'mint', target: 2 },
  { key: 'quarry', target: 2 },
] as const satisfies readonly OpeningStep[];

function count(counts: BuildingCounts, key: BuildingKey): number {
  return counts[key] ?? 0;
}

/** Combine standing buildings and construction sites into planned capacity. */
export function plannedBuildingCounts(built: BuildingCounts, pending: BuildingCounts): BuildingCounts {
  const planned: Partial<Record<BuildingKey, number>> = { ...built };
  for (const key in pending) {
    const buildingKey = key as BuildingKey;
    planned[buildingKey] = count(built, buildingKey) + count(pending, buildingKey);
  }
  return planned;
}

/**
 * Return the first unfinished opening stage. A site for that exact stage means
 * wait: later stages never leapfrog construction that the single opening
 * builder has not completed yet.
 */
export function nextOpeningDecision(
  built: BuildingCounts,
  pending: BuildingCounts,
  opening: readonly OpeningStep[] = COMMON_OPENING,
): OpeningDecision {
  const planned = plannedBuildingCounts(built, pending);
  for (let index = 0; index < opening.length; index++) {
    const step = opening[index];
    if (count(built, step.key) >= step.target) continue;
    if (count(planned, step.key) >= step.target) {
      return { kind: 'wait', key: step.key, target: step.target, index };
    }
    return { kind: 'build', key: step.key, target: step.target, index };
  }
  return { kind: 'complete' };
}

/**
 * Grow or repair paired timber capacity. Starting from a balanced state, every
 * returned step preserves `sawmills <= woodcutters <= sawmills + 1`.
 */
export function nextTimberLineBuild(planned: BuildingCounts, targetLines: number): BuildingKey | null {
  const woodcutters = count(planned, 'woodcutter');
  const sawmills = count(planned, 'sawmill');
  if (woodcutters < sawmills) return 'woodcutter';
  if (sawmills < woodcutters) return 'sawmill';
  return woodcutters < targetLines ? 'woodcutter' : null;
}

/**
 * Add a coin line in supplier-first order. Each mint owns one gold mine and
 * one coal mine; `armsLines` reserves the coal mines dedicated to paired
 * smithy/armory lines before a mint may claim further coal capacity.
 */
export function nextCoinLineBuild(
  planned: BuildingCounts,
  targetMints: number,
  armsLines = Math.max(count(planned, 'smithy'), count(planned, 'armory')),
): BuildingKey | null {
  const goldmines = count(planned, 'goldmine');
  const coalmines = count(planned, 'coalmine');
  const mints = count(planned, 'mint');

  // Repair an unsupported existing line before considering expansion.
  if (goldmines < mints) return 'goldmine';
  if (coalmines < armsLines + mints) return 'coalmine';
  if (mints >= targetMints) return null;

  const nextMint = mints + 1;
  if (goldmines < nextMint) return 'goldmine';
  if (coalmines < armsLines + nextMint) return 'coalmine';
  return 'mint';
}

/**
 * Add a weapons-and-armour line in supplier-first order. One iron mine and one
 * dedicated coal mine feed one smithy plus one armory because both crafters run
 * at half the rate of their raw-material mines. `coinLines` protects the coal
 * already dedicated one-for-one to mints.
 */
export function nextArmsLineBuild(
  planned: BuildingCounts,
  targetLines: number,
  coinLines = count(planned, 'mint'),
): BuildingKey | null {
  const ironmines = count(planned, 'ironmine');
  const coalmines = count(planned, 'coalmine');
  const smithies = count(planned, 'smithy');
  const armories = count(planned, 'armory');
  const existingLines = Math.max(smithies, armories);

  // Repair the inputs and missing half of any existing crafter pair first.
  if (ironmines < existingLines) return 'ironmine';
  if (coalmines < coinLines + existingLines) return 'coalmine';
  if (smithies < armories) return 'smithy';
  if (armories < smithies) return 'armory';
  if (existingLines >= targetLines) return null;

  const nextLine = existingLines + 1;
  if (ironmines < nextLine) return 'ironmine';
  if (coalmines < coinLines + nextLine) return 'coalmine';
  return 'smithy';
}
