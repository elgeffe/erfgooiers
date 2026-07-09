import type { ItemDef, ItemKey } from '../types';

export const ITEMS: Record<ItemKey, ItemDef> = {
  trunk:   { name: 'Trunk',    color: '#8b5a2b', hex: 0x8b5a2b },
  timber:  { name: 'Timber',   color: '#d2a35c', hex: 0xd2a35c },
  stone:   { name: 'Stone',    color: '#b0b4b8', hex: 0xb0b4b8 },
  wheat:   { name: 'Wheat',    color: '#e0c05a', hex: 0xe0c05a },
  flour:   { name: 'Flour',    color: '#f2ead8', hex: 0xf2ead8 },
  bread:   { name: 'Bread',    color: '#c9853e', hex: 0xc9853e },
  goldore: { name: 'Gold ore', color: '#c9a94e', hex: 0xc9a94e },
  coal:    { name: 'Coal',     color: '#3d3d44', hex: 0x3d3d44 },
  coin:    { name: 'Coin',     color: '#ffd24a', hex: 0xffd24a },
  grape:   { name: 'Grapes',   color: '#7a4b8a', hex: 0x7a4b8a },
  wine:    { name: 'Wine',     color: '#7b2233', hex: 0x7b2233 },
  meat:    { name: 'Meat',     color: '#c96b6b', hex: 0xc96b6b },
  sausage: { name: 'Sausage',  color: '#9c4a2f', hex: 0x9c4a2f },
  fish:    { name: 'Fish',     color: '#7fb0c4', hex: 0x7fb0c4 },
  iron:    { name: 'Iron',     color: '#a86a4a', hex: 0xa86a4a },
  weapon:  { name: 'Weapon',   color: '#c6ccd4', hex: 0xc6ccd4 },
  armor:   { name: 'Armor',    color: '#7d8794', hex: 0x7d8794 },
};

/** Items surfaced in the top resource bar, in order. */
export const RES_SHOWN: ItemKey[] = [
  'timber', 'stone', 'trunk', 'wheat', 'flour', 'bread',
  'grape', 'wine', 'meat', 'sausage', 'fish', 'goldore', 'coal', 'coin',
  'iron', 'weapon', 'armor',
];
