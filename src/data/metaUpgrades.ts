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
  apply?: ModifierSpec[];             // permanent run modifiers
  special?: 'startGold' | 'freeReroll';
}

export const META_UPGRADES: MetaUpgradeDef[] = [
  { id: 'willing-hands', name: 'Willing Hands', desc: 'Start every level with +1 serf', icon: '🧺', cost: 15,
    apply: [{ stat: 'extraSerf', add: 1 }] },
  { id: 'seasoned-hands', name: 'Seasoned Hands', desc: 'Start every level with +1 laborer', icon: '🧑\u200d🔧', cost: 15,
    apply: [{ stat: 'extraLaborer', add: 1 }] },
  { id: 'quartermaster', name: 'Quartermaster', desc: 'Start every level with +4 timber & +4 stone', icon: '📦', cost: 18,
    apply: [{ stat: 'startTimber', add: 4 }, { stat: 'startStone', add: 4 }] },
  { id: 'full-larder', name: 'Full Larder', desc: 'Start every level with +6 bread', icon: '🍞', cost: 12,
    apply: [{ stat: 'startBread', add: 6 }] },
  { id: 'stout-castle', name: 'Stout Castle', desc: 'Your castle has +40% HP', icon: '🏰', cost: 30,
    apply: [{ stat: 'castleHp', mult: 1.4 }] },
  { id: 'war-chest', name: 'War Chest', desc: 'Begin each run with +25 gold', icon: '💰', cost: 20, special: 'startGold' },
  { id: 'merchant-ties', name: 'Merchant Ties', desc: 'One free shop reroll each visit', icon: '🔄', cost: 25, special: 'freeReroll' },
];

export const META_BY_ID: Record<string, MetaUpgradeDef> = Object.fromEntries(META_UPGRADES.map(u => [u.id, u]));

/** Flatten owned unlock ids into the ModifierSpecs the run's Modifiers consume. */
export function metaSpecsFor(unlocks: string[]): ModifierSpec[] {
  const out: ModifierSpec[] = [];
  for (const id of unlocks) { const d = META_BY_ID[id]; if (d?.apply) out.push(...d.apply); }
  return out;
}

/** Does the player own an unlock with the given special effect? */
export function hasMetaSpecial(unlocks: string[], special: 'startGold' | 'freeReroll'): boolean {
  return unlocks.some(id => META_BY_ID[id]?.special === special);
}
