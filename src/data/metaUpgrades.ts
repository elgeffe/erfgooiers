import type { ModifierSpec } from '../game/Modifiers';

/**
 * Permanent unlocks bought with Heritage in the main-menu shop. Most are pure
 * ModifierSpecs merged into every run's Modifiers; a couple are handled
 * specially (starting gold, a free shop reroll).
 */
export interface MetaUpgradeDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  cost: number;                       // Heritage cost
  tier: number;                       // display/order: later tiers cost more and grant larger effects
  apply?: ModifierSpec[];             // permanent run modifiers
  special?: 'startGold' | 'freeReroll';
  specialValue?: number;
}

export const META_UPGRADES: MetaUpgradeDef[] = [
  { id: 'full-larder', name: 'Full Larder', desc: 'Start every level with +8 bread', icon: '🍞', cost: 50, tier: 1,
    apply: [{ stat: 'startBread', add: 8 }] },
  { id: 'willing-hands', name: 'Willing Hands', desc: 'Start every level with +2 serfs', icon: '🧺', cost: 100, tier: 2,
    apply: [{ stat: 'extraSerf', add: 2 }] },
  { id: 'seasoned-hands', name: 'Seasoned Hands', desc: 'Start every level with +2 builders', icon: '🧑\u200d🔧', cost: 150, tier: 3,
    apply: [{ stat: 'extraLaborer', add: 2 }] },
  { id: 'quartermaster', name: 'Quartermaster', desc: 'Start every level with +12 timber & +12 stone', icon: '📦', cost: 200, tier: 4,
    apply: [{ stat: 'startTimber', add: 12 }, { stat: 'startStone', add: 12 }] },
  { id: 'merchant-ties', name: 'Merchant Ties', desc: 'One free shop reroll each visit', icon: '🔄', cost: 300, tier: 5, special: 'freeReroll', specialValue: 1 },
  { id: 'stout-castle', name: 'Stout Castle', desc: 'Your castle has +75% HP', icon: '🏰', cost: 400, tier: 6,
    apply: [{ stat: 'castleHp', mult: 1.75 }] },
  { id: 'war-chest', name: 'War Chest', desc: 'Begin each run with +75 gold', icon: '💰', cost: 500, tier: 7, special: 'startGold', specialValue: 75 },
];

export const META_BY_ID: Record<string, MetaUpgradeDef> = Object.fromEntries(META_UPGRADES.map(u => [u.id, u]));

/** Flatten owned unlock ids into the ModifierSpecs the run's Modifiers consume. */
export function metaSpecsFor(activeId: string | null): ModifierSpec[] {
  return (activeId && META_BY_ID[activeId]?.apply) || [];
}

/** Value of the one active global blessing's special effect (zero if different/none). */
export function metaSpecialValue(activeId: string | null, special: 'startGold' | 'freeReroll'): number {
  const d = activeId ? META_BY_ID[activeId] : undefined;
  return d?.special === special ? (d.specialValue ?? 1) : 0;
}
