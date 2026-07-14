import type { ModifierSpec } from '../game/Modifiers';
import type { UnitKind } from './units';

/**
 * Heroes — the run's rule-set pick. A hero is currently a
 * rule-changer, not a stat pack: beyond the basic Erfgooier every hero is a
 * double-edged sword with a real boon AND a real bane, so the pick shapes how
 * the whole run wants to be played. Hero effects are plain ModifierSpecs
 * merged into every level's Modifiers; a warband (startArmy) is spawned by
 * main at level start. Hero-exclusive shop cards (data/upgrades.ts, pool
 * 'hero') only appear while their hero leads the run.
 *
 * The Erfgooier is always available; the others are permanent Heritage
 * unlocks bought right on the hero-select screen (stored in meta.unlocks as
 * 'hero:<id>').
 */
export interface HeroDef {
  id: string;
  name: string;
  title: string;
  icon: string;
  boon: string;                 // what the hero gives
  bane: string;                 // what the hero costs ('' for the basic hero)
  heritageCost: number;         // 0 = always available
  apply: ModifierSpec[];
  /** Fighters mustered at the castle at every level's start. */
  startArmy?: { kind: UnitKind; count: number }[];
}

export const HEROES: HeroDef[] = [
  { id: 'erfgooier', name: 'The Erfgooier', title: 'A commoner of Het Gooi', icon: '🧑‍🌾',
    boon: 'Honest hands and no debts — the plain start every other hero is measured against.',
    bane: '',
    heritageCost: 0,
    apply: [] },

  { id: 'merchant', name: 'Marcus the Merchant', title: 'Economy hero', icon: '💰',
    boon: '+30% gold from all sources · taverns pay 1 gold per meal they serve',
    bane: 'Fighters are twice as expensive — his soldiers are bought, not given',
    heritageCost: 100,
    apply: [
      { stat: 'goldGain', mult: 1.3 },
      { stat: 'goldPerMeal', add: 1 },
      { stat: 'trainCost', mult: 2, filter: 'soldier' },
      { stat: 'trainCost', mult: 2, filter: 'pikeman' },
      { stat: 'trainCost', mult: 2, filter: 'archer' },
      { stat: 'trainCost', mult: 2, filter: 'knight' },
      { stat: 'trainCost', mult: 2, filter: 'lancer' },
      { stat: 'trainCost', mult: 2, filter: 'horsearcher' },
      { stat: 'trainCost', mult: 2, filter: 'horseknight' },
    ] },

  { id: 'warlord', name: 'Walter the Warlord', title: 'War hero', icon: '⚔️',
    boon: 'Starts every level with a warband of 10 soldiers · soldiers deal x2 damage',
    bane: 'Serfs haul 20% slower — the war takes young hands',
    heritageCost: 150,
    apply: [
      { stat: 'combat:damage', mult: 2, filter: 'soldier' },
      { stat: 'unitSpeed', mult: 0.8, filter: 'serf' },
    ],
    startArmy: [{ kind: 'soldier', count: 10 }] },

  { id: 'captain', name: 'Gerald the Great', title: 'Ranger', icon: '🏹',
    boon: 'Starts every level with a warband of 10 archers · archers deal x2 damage',
    bane: 'Buildings take 10% longer to construct — wood for walls is spent on bows',
    heritageCost: 150,
    apply: [
      { stat: 'combat:damage', mult: 2, filter: 'archer' },
      { stat: 'buildTime', mult: 0.90 },
    ],
    startArmy: [{ kind: 'archer', count: 10 }] },

  { id: 'reeve', name: 'Roderick the Reeve', title: 'Builder hero', icon: '🧱',
    boon: 'Buildings raise 35% faster and cost 1 less timber',
    bane: '−20% gold from all sources — work swallows the purse',
    heritageCost: 200,
    apply: [
      { stat: 'buildTime', mult: 0.65 },
      { stat: 'cost:timber', add: -1 },
      { stat: 'goldGain', mult: 0.8 },
    ] },

  { id: 'transporter', name: 'Harold the Hauler', title: 'Logistical hero', icon: '👥',
    boon: 'Get 2 extra serfs at the start of every level',
    bane: 'Builders cost 2x as much to train — serfs first',
    heritageCost: 200,
    apply: [
      { stat: 'extraSerf', add: 2 },
      { stat: 'trainCost', mult: 2, filter: 'builder' },
    ] },

  { id: 'horselord', name: 'Stannis the Stabler', title: 'Equestrian hero', icon: '🐴',
    boon: 'Mounted units move 20% faster',
    bane: 'Mounted units cost 2x as much to train — unfortunately, horses are expensive',
    heritageCost: 250,
    apply: [
      { stat: 'unitSpeed', mult: 1.2, filter: 'lancer' },
      { stat: 'unitSpeed', mult: 1.2, filter: 'horsearcher' },
      { stat: 'unitSpeed', mult: 1.2, filter: 'horseknight' },
      { stat: 'trainCost', mult: 2, filter: 'lancer' },
      { stat: 'trainCost', mult: 2, filter: 'horsearcher' },
      { stat: 'trainCost', mult: 2, filter: 'horseknight' },
    ] },
];

export const HERO_BY_ID: Record<string, HeroDef> = Object.fromEntries(HEROES.map(h => [h.id, h]));

/** The meta.unlocks id under which a purchased hero is stored. */
export function heroUnlockId(id: string): string { return 'hero:' + id; }

/** Is a hero available to pick (free, or bought with Heritage)? */
export function heroAvailable(id: string, unlocks: string[]): boolean {
  const h = HERO_BY_ID[id];
  return !!h && (h.heritageCost === 0 || unlocks.includes(heroUnlockId(id)));
}

/** The chosen hero's ModifierSpecs (empty for none/the basic hero). */
export function heroSpecsFor(heroId: string | null): ModifierSpec[] {
  return (heroId && HERO_BY_ID[heroId]?.apply) || [];
}
