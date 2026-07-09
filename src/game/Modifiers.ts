import { BASE_SPEED, BUILD_TIME, CARRY_CAP, OUT_CAP, ROAD_STONE_COST } from '../constants';
import type { BuildingDef, ItemKey, Unit } from '../types';

/**
 * A single upgrade/perk effect, expressed as pure data (see data/upgrades.ts).
 * `mult` multiplies and `add` adds to the named stat; `filter` optionally scopes
 * the effect (e.g. a unit role, a gather node, or a recipe output).
 *
 * Stats consumed by the sim:
 *   unitSpeed   (filter: unit role)     buildTime
 *   gatherTime  (filter: node kind)     recipeTime  (filter: output item)
 *   carryCap    outCap                  fieldGrowth
 *   goldGain    cost:<item> (add only)  startBread / startTimber / startStone
 *   extraSerf   extraLaborer  (add only)
 *
 * Rule-bending stats (the shop's rare cards):
 *   freeInputs      (filter: recipe output) — the recipe consumes nothing
 *   roadCost        (add) — stone per road tile, clamped at zero
 *   offRoadSpeed    (mult) — player walk speed off roads
 *   goldPerMeal     (add) — gold paid per meal a tavern serves
 *   craftPerRoad    (add) — craft-speed bonus per paved road tile (cap +60%)
 *   objectiveWeight (add, filter: item) — extra objective credit per unit made
 *   preserveTrees   (add) — woodcutters harvest without felling
 */
export interface ModifierSpec {
  stat: string;
  mult?: number;
  add?: number;
  filter?: string;
}

/** Hunger's effect on walk speed: well-fed workers hustle, starving ones drag. */
export function hungerFactor(hunger: number): number {
  if (hunger >= 66) return 1.12;   // well fed
  if (hunger <= 25) return 0.75;   // hungry
  return 1;                        // content
}

/**
 * The single object the sim consults instead of raw constants. Every buff,
 * perk, mutator and ascension flows through here — if a feature can't be
 * expressed as a ModifierSpec, extend this class rather than special-casing it
 * in Game (ROADMAP §10).
 */
export class Modifiers {
  /** Live sim context consumed by dynamic modifiers (Game keeps it current). */
  readonly ctx = { roadTiles: 0 };

  constructor(private readonly specs: ModifierSpec[] = []) {}

  private accMult(stat: string, ctx?: string): number {
    let m = 1;
    for (const s of this.specs) {
      if (s.stat !== stat || s.mult === undefined) continue;
      if (s.filter !== undefined && s.filter !== ctx) continue;
      m *= s.mult;
    }
    return m;
  }

  private accAdd(stat: string, ctx?: string): number {
    let a = 0;
    for (const s of this.specs) {
      if (s.stat !== stat || s.add === undefined) continue;
      if (s.filter !== undefined && s.filter !== ctx) continue;
      a += s.add;
    }
    return a;
  }

  /** Walk speed (tiles/s) for a unit, before the road bonus. */
  unitSpeed(u: Unit): number { return (u.spd || BASE_SPEED) * this.accMult('unitSpeed', u.role) * hungerFactor(u.hunger); }

  /** Combat stat multiplier for a unit kind — upgrades/mutators scale these at spawn. */
  combatMult(stat: 'hp' | 'damage' | 'speed' | 'range', kind: string): number {
    return this.accMult('combat:' + stat, kind);
  }

  /** Multiplier on a building's max HP (castle-toughness upgrades, enemy mutators). */
  buildingHpMult(faction: string): number { return this.accMult('buildingHp', faction); }

  /** Multiplier on barracks/guild-hall training time for a unit kind. */
  trainTime(kind: string): number { return this.accMult('trainTime', kind); }

  /** Multiplier on the player's castle HP (Heritage 'Stout Castle'). */
  castleHpMult(): number { return this.accMult('castleHp'); }

  /** Seconds of laborer work to raise a building. */
  buildTime(): number { return BUILD_TIME * this.accMult('buildTime'); }

  /** Producer input-buffer depth the dispatcher fills toward. */
  carryCap(): number { return Math.max(1, Math.round(CARRY_CAP + this.accAdd('carryCap'))); }

  /** Producer output-buffer depth before a worker idles. */
  outCap(): number { return Math.max(1, Math.round(OUT_CAP + this.accAdd('outCap'))); }

  /** Seconds to gather one unit from a node. */
  gatherTime(def: BuildingDef): number {
    return def.gather!.time * this.accMult('gatherTime', def.gather!.node);
  }

  /** Seconds to craft one recipe output. */
  recipeTime(def: BuildingDef): number {
    let t = def.recipe!.time * this.accMult('recipeTime', def.recipe!.out);
    const perRoad = this.accAdd('craftPerRoad');
    if (perRoad) t /= 1 + Math.min(0.6, this.ctx.roadTiles * perRoad);
    return t;
  }

  /** A recipe's inputs after rule-benders (e.g. bakeries that need no flour). */
  recipeInputs(def: BuildingDef): Partial<Record<ItemKey, number>> {
    const out = def.recipe!.out;
    if (this.specs.some(s => s.stat === 'freeInputs' && s.filter === out)) return {};
    return def.recipe!.inp;
  }

  /** Stone consumed (and refunded) per road tile. */
  roadCost(): number { return Math.max(0, ROAD_STONE_COST + this.accAdd('roadCost')); }

  /** Walk-speed multiplier for player units off roads (corvée roads' downside). */
  offRoadMult(): number { return this.accMult('offRoadSpeed'); }

  /** Gold paid out per meal a tavern serves (0 = the usual nothing). */
  goldPerMeal(): number { return this.accAdd('goldPerMeal'); }

  /** How much objective credit one produced unit of an item is worth. */
  objectiveWeight(item: string): number { return 1 + this.accAdd('objectiveWeight', item); }

  /** Woodcutters take the trunk without felling the tree. */
  preserveTrees(): boolean { return this.accAdd('preserveTrees') > 0; }

  /** Field growth-rate multiplier (>1 = faster). */
  fieldGrowth(): number { return this.accMult('fieldGrowth'); }

  /** Gold-gain multiplier applied to rewards and gold piles. */
  goldMult(): number { return this.accMult('goldGain'); }

  /** A building's material cost after reductions (never below zero). */
  buildingCost(def: BuildingDef): Partial<Record<ItemKey, number>> {
    const out: Partial<Record<ItemKey, number>> = {};
    for (const k in def.cost) {
      const item = k as ItemKey;
      const base = (def.cost as Record<string, number>)[k];
      out[item] = Math.max(0, base + this.accAdd('cost:' + k));
    }
    return out;
  }

  /** Extra goods added to the level's starting-kit stock. */
  startStock(): Partial<Record<ItemKey, number>> {
    const s: Partial<Record<ItemKey, number>> = {};
    const bread = this.accAdd('startBread'); if (bread) s.bread = bread;
    const timber = this.accAdd('startTimber'); if (timber) s.timber = timber;
    const stone = this.accAdd('startStone'); if (stone) s.stone = stone;
    return s;
  }

  extraSerfs(): number { return Math.round(this.accAdd('extraSerf')); }
  extraLaborers(): number { return Math.round(this.accAdd('extraLaborer')); }
}
