import { UNITS, type UnitKind } from '../../data/units';
import type { BuildingKey } from '../../types';
import type { Game } from '../../game/Game';
import { economyStock, type AIView } from '../perception';
import type { Phase } from '../tensor/phase';

/**
 * The observation a learned model sees: one normalised vector per decision.
 *
 * This is deliberately NOT the four discretised context slots the MPS uses.
 * Those exist because an MPS can only condition on a handful of nearby slots
 * before the signal dies in the chain; a network has no such constraint, so it
 * gets the continuous quantities instead of buckets, and can generalise between
 * states rather than memorising 256 of them.
 *
 * Fairness is unchanged: every field comes from `AIView` (fog-filtered) or from
 * this seat's own economy. The rival's castle and its damage are included
 * because perception already keeps the enemy storehouse through fog — spawn
 * corners are map knowledge a human has too — but nothing hidden is read.
 *
 * Values are scaled to roughly [0, 1] so a tanh network starts in its useful
 * range and no single count dominates the first layer.
 */

export const FEATURE_NAMES = [
  'time',
  'own_buildings', 'own_sites', 'own_serfs', 'own_free_villagers', 'own_unstaffed', 'hunger',
  'own_army', 'enemy_army', 'army_share',
  'own_siege', 'own_priests', 'own_towers', 'enemy_towers', 'enemy_bulwarks', 'threats',
  'castle_hp', 'enemy_castle_hp',
  'coin', 'timber', 'stone', 'bread', 'weapon', 'armor', 'iron', 'coal', 'goldore',
  'has_barracks', 'has_smithy', 'has_armory', 'has_stable', 'has_engineer', 'has_monastery',
  'has_mint', 'has_tavern', 'timber_lines', 'coin_lines',
  'phase_opening', 'phase_midgame', 'phase_lategame', 'recovery',
] as const;

export const FEATURE_COUNT = FEATURE_NAMES.length;

/** Squash a count into [0,1] with a soft knee — large values keep some signal
 *  instead of all saturating at 1, which matters for army sizes and stocks. */
const norm = (value: number, scale: number): number => value / (value + scale);

export interface LearnContext {
  phase: Phase;
  recovery: boolean;
}

export function featureVector(game: Game, view: AIView, context: LearnContext): number[] {
  const stock = (item: string): number => economyStock(game, view.owner, item);
  const built = (key: BuildingKey): number => view.built[key] ?? 0;

  let siege = 0, priests = 0;
  for (const unit of view.army) {
    const def = UNITS[unit.role as UnitKind];
    if ((def?.structureMult ?? 1) > 1) siege++;
    if (def?.heal) priests++;
  }
  const towers = built('watchtower') + built('stonetower');
  const castle = view.store;
  const enemyCastle = view.enemyStore;
  const totalArmy = view.armySize + view.enemyArmySize;

  return [
    norm(view.elapsed, 900),
    norm(view.buildings.length, 20), norm(view.sites.length, 3),
    norm(view.workers.serfs, 20), norm(view.workers.freeVillagers, 5), norm(view.workers.unstaffed, 4),
    Math.min(1, view.averageWorkerHunger / 100),
    norm(view.armySize, 30), norm(view.enemyArmySize, 30),
    // relative strength — the single most predictive quantity, and one a model
    // cannot infer from the two absolute counts without a product term
    totalArmy > 0 ? view.armySize / totalArmy : 0.5,
    norm(siege, 3), norm(priests, 3), norm(towers, 4),
    norm(view.enemyTowers.length, 4), norm(view.enemyBulwarks.length, 6), norm(view.threats.length, 8),
    castle && castle.maxHp > 0 ? castle.hp / castle.maxHp : 0,
    enemyCastle && enemyCastle.maxHp > 0 ? enemyCastle.hp / enemyCastle.maxHp : 1,
    norm(stock('coin'), 20), norm(stock('timber'), 15), norm(stock('stone'), 15),
    norm(stock('bread'), 15), norm(stock('weapon'), 10), norm(stock('armor'), 10),
    norm(stock('iron'), 10), norm(stock('coal'), 10), norm(stock('goldore'), 10),
    built('barracks') > 0 ? 1 : 0, built('smithy') > 0 ? 1 : 0, built('armory') > 0 ? 1 : 0,
    built('stable') > 0 ? 1 : 0, built('engineer') > 0 ? 1 : 0, built('monastery') > 0 ? 1 : 0,
    built('mint') > 0 ? 1 : 0, built('tavern') > 0 ? 1 : 0,
    norm(Math.min(built('woodcutter'), built('sawmill')), 2), norm(built('mint'), 2),
    context.phase === 'opening' ? 1 : 0,
    context.phase === 'midgame' ? 1 : 0,
    context.phase === 'lategame' ? 1 : 0,
    context.recovery ? 1 : 0,
  ];
}
