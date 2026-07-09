import type { ModifierSpec } from '../game/Modifiers';

export type UpgradePool = 'economy' | 'hero' | 'military';

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  /** A glyph shown on the shop card for quick recognition. */
  icon: string;
  pool: UpgradePool;
  basePrice: number;
  /** One or more modifier effects applied while this upgrade is owned. */
  apply: ModifierSpec[];
}

/** Price scales gently with the current level so late upgrades cost more. */
export function upgradePrice(def: UpgradeDef, levelIndex: number): number {
  return Math.round(def.basePrice * (1 + 0.18 * (levelIndex - 1)));
}

/**
 * Phase 1 ships economy upgrades only (hero/military pools arrive in Phases 2–3).
 * All are repeatable — buying an upgrade again stacks its effect, which is where
 * the visible "serfs are much faster by level 6" compounding comes from.
 */
export const UPGRADES: UpgradeDef[] = [
  { id: 'swift-serfs', name: 'Swift Serfs', desc: 'Serfs haul 20% faster', icon: '🏃', pool: 'economy', basePrice: 18,
    apply: [{ stat: 'unitSpeed', mult: 1.2, filter: 'serf' }] },

  { id: 'quick-feet', name: 'Quick Feet', desc: 'All workers move 12% faster', icon: '👟', pool: 'economy', basePrice: 22,
    apply: [{ stat: 'unitSpeed', mult: 1.12 }] },

  { id: 'master-builders', name: 'Master Builders', desc: 'Buildings raise 25% faster', icon: '🔨', pool: 'economy', basePrice: 20,
    apply: [{ stat: 'buildTime', mult: 0.75 }] },

  { id: 'sharp-tools', name: 'Sharp Tools', desc: 'Gathering is 18% faster', icon: '🪓', pool: 'economy', basePrice: 24,
    apply: [{ stat: 'gatherTime', mult: 0.82 }] },

  { id: 'busy-workshops', name: 'Busy Workshops', desc: 'Crafting is 18% faster', icon: '⚙️', pool: 'economy', basePrice: 24,
    apply: [{ stat: 'recipeTime', mult: 0.82 }] },

  { id: 'deep-veins', name: 'Deep Veins', desc: 'Mining stone, gold & coal 25% faster', icon: '⛏️', pool: 'economy', basePrice: 26,
    apply: [
      { stat: 'gatherTime', mult: 0.75, filter: 'stone' },
      { stat: 'gatherTime', mult: 0.75, filter: 'gold' },
      { stat: 'gatherTime', mult: 0.75, filter: 'coal' },
    ] },

  { id: 'fertile-fields', name: 'Fertile Fields', desc: 'Crops grow 35% faster', icon: '🌾', pool: 'economy', basePrice: 20,
    apply: [{ stat: 'fieldGrowth', mult: 1.35 }] },

  { id: 'cheap-timber', name: 'Thrifty Framing', desc: 'Buildings cost 1 less timber', icon: '🪵', pool: 'economy', basePrice: 16,
    apply: [{ stat: 'cost:timber', add: -1 }] },

  { id: 'coin-clipper', name: 'Coin Clipper', desc: '+25% gold from all sources', icon: '🪙', pool: 'economy', basePrice: 28,
    apply: [{ stat: 'goldGain', mult: 1.25 }] },

  { id: 'extra-hand', name: 'Extra Hand', desc: 'Start each level with +1 laborer', icon: '🧑\u200d🔧', pool: 'economy', basePrice: 22,
    apply: [{ stat: 'extraLaborer', add: 1 }] },

  { id: 'extra-serf', name: 'Willing Hands', desc: 'Start each level with +1 serf', icon: '🧺', pool: 'economy', basePrice: 22,
    apply: [{ stat: 'extraSerf', add: 1 }] },

  { id: 'well-fed', name: 'Full Larder', desc: 'Start each level with +4 bread', icon: '🍞', pool: 'economy', basePrice: 14,
    apply: [{ stat: 'startBread', add: 4 }] },

  { id: 'stout-stores', name: 'Stout Stores', desc: 'Start with +3 timber & +3 stone', icon: '📦', pool: 'economy', basePrice: 18,
    apply: [{ stat: 'startTimber', add: 3 }, { stat: 'startStone', add: 3 }] },

  // ---- military pool (offered once combat levels are in reach) ----
  { id: 'forged-blades', name: 'Forged Blades', desc: 'Your fighters deal 15% more damage', icon: '⚔️', pool: 'military', basePrice: 26,
    apply: [
      { stat: 'combat:damage', mult: 1.15, filter: 'soldier' },
      { stat: 'combat:damage', mult: 1.15, filter: 'archer' },
      { stat: 'combat:damage', mult: 1.15, filter: 'knight' },
    ] },

  { id: 'oak-shields', name: 'Oak Shields', desc: 'Your fighters have 20% more health', icon: '🛡️', pool: 'military', basePrice: 26,
    apply: [
      { stat: 'combat:hp', mult: 1.2, filter: 'soldier' },
      { stat: 'combat:hp', mult: 1.2, filter: 'archer' },
      { stat: 'combat:hp', mult: 1.2, filter: 'knight' },
    ] },

  { id: 'drill-yard', name: 'Drill Yard', desc: 'Fighters train 25% faster', icon: '🥁', pool: 'military', basePrice: 20,
    apply: [
      { stat: 'trainTime', mult: 0.75, filter: 'soldier' },
      { stat: 'trainTime', mult: 0.75, filter: 'archer' },
      { stat: 'trainTime', mult: 0.75, filter: 'knight' },
    ] },

  { id: 'fletchers-eye', name: "Fletcher's Eye", desc: 'Archers shoot 15% further', icon: '🏹', pool: 'military', basePrice: 22,
    apply: [{ stat: 'combat:range', mult: 1.15, filter: 'archer' }] },

  { id: 'forced-march', name: 'Forced March', desc: 'Your fighters move 15% faster', icon: '🎺', pool: 'military', basePrice: 20,
    apply: [
      { stat: 'combat:speed', mult: 1.15, filter: 'soldier' },
      { stat: 'combat:speed', mult: 1.15, filter: 'archer' },
      { stat: 'combat:speed', mult: 1.15, filter: 'knight' },
    ] },
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
