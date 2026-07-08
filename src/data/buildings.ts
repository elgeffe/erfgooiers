import type { BuildingDef, BuildingKey } from '../types';

export const DEFS: Record<BuildingKey, BuildingDef> = {
  storehouse: { name: 'Storehouse', desc: 'Stores every good', model: 'barn',
    cost: {}, roof: 0x9a3b2e, wall: 0xcaa46e, store: true },

  woodcutter: { name: "Woodcutter's Hut", desc: 'Chops nearby trees → trunks', model: 'cottage',
    cost: { timber: 2, stone: 1 }, roof: 0x6b4a2f, wall: 0xa07850,
    gather: { node: 'tree', out: 'trunk', time: 3.5, range: 9 }, worker: 'Woodcutter', wcolor: 0x6b8e4e },

  forester: { name: "Forester's Lodge", desc: 'Plants new trees nearby', model: 'cottage',
    cost: { timber: 2, stone: 1 }, roof: 0x3f6d3a, wall: 0xa07850,
    gather: { node: 'plant', out: null, time: 2.5, range: 7 }, worker: 'Forester', wcolor: 0x3f6d3a },

  sawmill: { name: 'Sawmill', desc: 'Trunks → timber', model: 'cottage',
    cost: { timber: 3, stone: 2 }, roof: 0xa0662d, wall: 0xb08a5c, accent: 0x8a5a2b,
    recipe: { inp: { trunk: 1 }, out: 'timber', time: 5 }, worker: 'Carpenter', wcolor: 0xb08a5c },

  quarry: { name: 'Quarry', desc: 'Mines stone deposits', model: 'mine',
    cost: { timber: 1, stone: 0 }, roof: 0x777d82, wall: 0x9aa0a3, accent: 0xc4cace,
    gather: { node: 'stone', out: 'stone', time: 4.5, range: 9 }, worker: 'Stonemason', wcolor: 0x9aa0a3 },

  farm: { name: 'Farm', desc: 'Grows & harvests wheat', model: 'farm',
    cost: { timber: 3, stone: 1 }, roof: 0xc9a13e, wall: 0xb08a5c,
    gather: { node: 'field', out: 'wheat', time: 2.5, range: 0 }, worker: 'Farmer', wcolor: 0xd9b64e, fields: true },

  mill: { name: 'Mill', desc: 'Wheat → flour', model: 'windmill',
    cost: { timber: 2, stone: 2 }, roof: 0x8a7550, wall: 0xece3cf,
    recipe: { inp: { wheat: 1 }, out: 'flour', time: 5 }, worker: 'Miller', wcolor: 0xcabb9a },

  bakery: { name: 'Bakery', desc: 'Flour → bread', model: 'cottage',
    cost: { timber: 2, stone: 2 }, roof: 0xb35438, wall: 0xc4a075, accent: 0xffb060,
    recipe: { inp: { flour: 1 }, out: 'bread', time: 5 }, worker: 'Baker', wcolor: 0xf0e6d2 },

  goldmine: { name: 'Gold Mine', desc: 'Mines gold ore deposits', model: 'mine',
    cost: { timber: 2, stone: 1 }, roof: 0xb8912e, wall: 0x8f8a80, accent: 0xffd24a,
    gather: { node: 'gold', out: 'goldore', time: 5.5, range: 9 }, worker: 'Miner', wcolor: 0xc9a94e },

  coalmine: { name: 'Coal Mine', desc: 'Mines coal deposits', model: 'mine',
    cost: { timber: 2, stone: 1 }, roof: 0x3a3a40, wall: 0x8f8a80, accent: 0x2a2a30,
    gather: { node: 'coal', out: 'coal', time: 5.5, range: 9 }, worker: 'Collier', wcolor: 0x44444c },

  mint: { name: 'Mint', desc: 'Gold ore + coal → coins', model: 'cottage',
    cost: { timber: 2, stone: 3 }, roof: 0xd9a441, wall: 0x9c8a6a, accent: 0xffd24a,
    recipe: { inp: { goldore: 1, coal: 1 }, out: 'coin', time: 6 }, worker: 'Minter', wcolor: 0xd4af37 },
};

/** Order of build cards in the bottom menu. */
export const MENU_ORDER: BuildingKey[] = [
  'woodcutter', 'sawmill', 'forester', 'quarry', 'farm',
  'mill', 'bakery', 'goldmine', 'coalmine', 'mint',
];
