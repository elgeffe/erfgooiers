import type { ModifierSpec } from '../game/Modifiers';

export type UpgradePool = 'economy' | 'hero' | 'military';
export type Rarity = 'common' | 'uncommon' | 'rare';

/** How many power-up cards a run can hold. The squeeze is the point: once the
 *  slots are full, buying means selling — that's where shop decisions get hard. */
export const MAX_CARDS = 5;

/** Shop offer weighting per rarity tier. */
export const RARITY_WEIGHT: Record<Rarity, number> = { common: 6, uncommon: 3, rare: 1 };

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  /** A glyph shown on the shop card for quick recognition. */
  icon: string;
  pool: UpgradePool;
  /** pool 'hero' only: the hero id this card is exclusive to. */
  hero?: string;
  rarity: Rarity;
  /** One-of-a-kind: never offered again while owned this run. */
  unique?: boolean;
  basePrice: number;
  /** One or more modifier effects applied while this upgrade is owned. */
  apply: ModifierSpec[];
}

/** Price scales gently with the current level so late upgrades cost more. */
export function upgradePrice(def: UpgradeDef, levelIndex: number): number {
  return Math.round(def.basePrice * (1 + 0.18 * (levelIndex - 1)));
}

/**
 * The run's card pool. Commons and uncommons are linear stat nudges and stack
 * freely (each copy takes a slot). Rares bend the rules of the sim itself —
 * they change what you want to build next, and most are unique. Every card
 * occupies one of the run's MAX_CARDS slots; the shop lets you sell.
 */
export const UPGRADES: UpgradeDef[] = [
  { id: 'swift-serfs', name: 'Swift Serfs', desc: 'Serfs haul 20% faster', icon: '🏃', pool: 'economy', rarity: 'common', basePrice: 18,
    apply: [{ stat: 'unitSpeed', mult: 1.2, filter: 'serf' }] },

  { id: 'quick-feet', name: 'Quick Feet', desc: 'All workers move 12% faster', icon: '👟', pool: 'economy', rarity: 'uncommon', basePrice: 22,
    apply: [{ stat: 'unitSpeed', mult: 1.12 }] },

  { id: 'master-builders', name: 'Master Builders', desc: 'Buildings raise 25% faster', icon: '🔨', pool: 'economy', rarity: 'common', basePrice: 20,
    apply: [{ stat: 'buildTime', mult: 0.75 }] },

  { id: 'sharp-tools', name: 'Sharp Tools', desc: 'Gathering is 18% faster', icon: '🪓', pool: 'economy', rarity: 'common', basePrice: 24,
    apply: [{ stat: 'gatherTime', mult: 0.82 }] },

  { id: 'busy-workshops', name: 'Busy Workshops', desc: 'Crafting is 18% faster', icon: '⚙️', pool: 'economy', rarity: 'common', basePrice: 24,
    apply: [{ stat: 'recipeTime', mult: 0.82 }] },

  { id: 'deep-veins', name: 'Deep Veins', desc: 'Mining stone, gold & coal 25% faster', icon: '⛏️', pool: 'economy', rarity: 'uncommon', basePrice: 26,
    apply: [
      { stat: 'gatherTime', mult: 0.75, filter: 'stone' },
      { stat: 'gatherTime', mult: 0.75, filter: 'gold' },
      { stat: 'gatherTime', mult: 0.75, filter: 'coal' },
    ] },

  { id: 'fertile-fields', name: 'Fertile Fields', desc: 'Crops grow 35% faster', icon: '🌾', pool: 'economy', rarity: 'common', basePrice: 20,
    apply: [{ stat: 'fieldGrowth', mult: 1.35 }] },

  { id: 'cheap-timber', name: 'Thrifty Framing', desc: 'Buildings cost 1 less timber', icon: '🪵', pool: 'economy', rarity: 'common', basePrice: 16,
    apply: [{ stat: 'cost:timber', add: -1 }] },

  { id: 'coin-clipper', name: 'Coin Clipper', desc: '+25% gold from all sources', icon: '🪙', pool: 'economy', rarity: 'uncommon', basePrice: 28,
    apply: [{ stat: 'goldGain', mult: 1.25 }] },

  { id: 'extra-hand', name: 'Extra Hand', desc: 'Start each level with +1 builder', icon: '🧑\u200d🔧', pool: 'economy', rarity: 'common', basePrice: 22,
    apply: [{ stat: 'extraLaborer', add: 1 }] },

  { id: 'extra-serf', name: 'Willing Hands', desc: 'Start each level with +1 serf', icon: '🧺', pool: 'economy', rarity: 'common', basePrice: 22,
    apply: [{ stat: 'extraSerf', add: 1 }] },

  { id: 'well-fed', name: 'Full Larder', desc: 'Start each level with +4 bread', icon: '🍞', pool: 'economy', rarity: 'common', basePrice: 14,
    apply: [{ stat: 'startBread', add: 4 }] },

  { id: 'stout-stores', name: 'Stout Stores', desc: 'Start with +3 timber & +3 stone', icon: '📦', pool: 'economy', rarity: 'common', basePrice: 18,
    apply: [{ stat: 'startTimber', add: 3 }, { stat: 'startStone', add: 3 }] },

  // ---- military pool (offered once combat levels are in reach) ----
  { id: 'forged-blades', name: 'Forged Blades', desc: 'Your fighters deal 15% more damage', icon: '⚔️', pool: 'military', rarity: 'uncommon', basePrice: 26,
    apply: [
      { stat: 'combat:damage', mult: 1.15, filter: 'soldier' },
      { stat: 'combat:damage', mult: 1.15, filter: 'archer' },
      { stat: 'combat:damage', mult: 1.15, filter: 'knight' },
    ] },

  { id: 'oak-shields', name: 'Oak Shields', desc: 'Your fighters have 20% more health', icon: '🛡️', pool: 'military', rarity: 'uncommon', basePrice: 26,
    apply: [
      { stat: 'combat:hp', mult: 1.2, filter: 'soldier' },
      { stat: 'combat:hp', mult: 1.2, filter: 'archer' },
      { stat: 'combat:hp', mult: 1.2, filter: 'knight' },
    ] },

  { id: 'drill-yard', name: 'Drill Yard', desc: 'Fighters train 25% faster', icon: '🥁', pool: 'military', rarity: 'uncommon', basePrice: 20,
    apply: [
      { stat: 'trainTime', mult: 0.75, filter: 'soldier' },
      { stat: 'trainTime', mult: 0.75, filter: 'archer' },
      { stat: 'trainTime', mult: 0.75, filter: 'knight' },
    ] },

  { id: 'fletchers-eye', name: "Fletcher's Eye", desc: 'Archers shoot 15% further', icon: '🏹', pool: 'military', rarity: 'uncommon', basePrice: 22,
    apply: [{ stat: 'combat:range', mult: 1.15, filter: 'archer' }] },

  { id: 'forced-march', name: 'Forced March', desc: 'Your fighters move 15% faster', icon: '🎺', pool: 'military', rarity: 'uncommon', basePrice: 20,
    apply: [
      { stat: 'combat:speed', mult: 1.15, filter: 'soldier' },
      { stat: 'combat:speed', mult: 1.15, filter: 'archer' },
      { stat: 'combat:speed', mult: 1.15, filter: 'knight' },
    ] },

  // ---- rule-benders: cards that change how the sim works, not just its numbers ----
  { id: 'communal-ovens', name: 'Communal Ovens', desc: 'Bakeries need no flour — but bake twice as slow', icon: '🫓',
    pool: 'economy', rarity: 'rare', unique: true, basePrice: 40,
    apply: [{ stat: 'freeInputs', filter: 'bread' }, { stat: 'recipeTime', mult: 2, filter: 'bread' }] },

  { id: 'corvee-roads', name: 'Corvée Roads', desc: 'Roads cost no stone — but walking off-road is 25% slower', icon: '🛤️',
    pool: 'economy', rarity: 'uncommon', unique: true, basePrice: 26,
    apply: [{ stat: 'roadCost', add: -99 }, { stat: 'offRoadSpeed', mult: 0.75 }] },

  { id: 'tavern-tithe', name: 'Tavern Tithe', desc: 'Taverns pay you 1 gold for every meal they serve', icon: '🍺',
    pool: 'economy', rarity: 'uncommon', unique: true, basePrice: 30,
    apply: [{ stat: 'goldPerMeal', add: 1 }] },

  { id: 'guild-charter', name: 'Guild Charter', desc: 'Crafting is 2% faster per road tile paved (up to +60%)', icon: '📜',
    pool: 'economy', rarity: 'rare', unique: true, basePrice: 45,
    apply: [{ stat: 'craftPerRoad', add: 0.02 }] },

  { id: 'wine-fame', name: 'Famous Vintage', desc: 'Wine counts double toward objectives — but takes 25% longer to make', icon: '🍷',
    pool: 'economy', rarity: 'rare', unique: true, basePrice: 38,
    apply: [{ stat: 'objectiveWeight', add: 1, filter: 'wine' }, { stat: 'recipeTime', mult: 1.25, filter: 'wine' }] },

  { id: 'coppice-craft', name: 'Coppice Craft', desc: 'Woodcutters harvest without felling the tree — but chop 50% slower', icon: '🌳',
    pool: 'economy', rarity: 'rare', unique: true, basePrice: 40,
    apply: [{ stat: 'preserveTrees', add: 1 }, { stat: 'gatherTime', mult: 1.5, filter: 'tree' }] },

  // ---- hero-exclusive cards: only offered while their hero leads the run ----
  { id: 'golden-ledger', name: 'Golden Ledger', desc: "Griet's books: +1 more gold per tavern meal and +10% gold from all sources", icon: '📒',
    pool: 'hero', hero: 'merchant', rarity: 'rare', unique: true, basePrice: 36,
    apply: [{ stat: 'goldPerMeal', add: 1 }, { stat: 'goldGain', mult: 1.1 }] },

  { id: 'iron-discipline', name: 'Iron Discipline', desc: "Wolter's drills: fighters train 40% faster and have +15% health", icon: '🗡️',
    pool: 'hero', hero: 'warlord', rarity: 'rare', unique: true, basePrice: 34,
    apply: [
      { stat: 'trainTime', mult: 0.6, filter: 'soldier' },
      { stat: 'trainTime', mult: 0.6, filter: 'archer' },
      { stat: 'trainTime', mult: 0.6, filter: 'knight' },
      { stat: 'combat:hp', mult: 1.15, filter: 'soldier' },
      { stat: 'combat:hp', mult: 1.15, filter: 'archer' },
      { stat: 'combat:hp', mult: 1.15, filter: 'knight' },
    ] },

  { id: 'crown-masons', name: 'Crown Masons', desc: "Dirkje's guild: buildings cost 1 less stone and raise 25% faster", icon: '🧱',
    pool: 'hero', hero: 'reeve', rarity: 'rare', unique: true, basePrice: 34,
    apply: [{ stat: 'cost:stone', add: -1 }, { stat: 'buildTime', mult: 0.75 }] },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

/** Resolve owned upgrade ids into the flat ModifierSpec list Modifiers consumes. */
export function specsFor(upgradeIds: string[]): ModifierSpec[] {
  const specs: ModifierSpec[] = [];
  for (const id of upgradeIds) {
    const def = UPGRADE_BY_ID[id];
    if (def) specs.push(...def.apply);
  }
  return specs;
}
