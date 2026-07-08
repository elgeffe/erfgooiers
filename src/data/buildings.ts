import type { BuildingDef, BuildingKey } from '../types';

export const DEFS: Record<BuildingKey, BuildingDef> = {
  storehouse: { name: 'Storehouse', desc: 'Stores every good', model: 'barn',
    cost: {}, roof: 0x9a3b2e, wall: 0xcaa46e, store: true, hp: 500 },

  guildhall: { name: 'Guild Hall', desc: 'Trains villagers who staff your buildings (also serfs & laborers)', model: 'cottage',
    cost: { timber: 4, stone: 3 }, roof: 0x4a6a7a, wall: 0xcaa46e, accent: 0xffd24a, hp: 250,
    trainer: { trains: ['villager', 'serf', 'laborer'], time: 5, cost: { bread: 1 } } },

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

  farm: { name: 'Farm', desc: 'Grows & harvests wheat on its plots', model: 'farm',
    cost: { timber: 3, stone: 1 }, roof: 0xc9a13e, wall: 0xb08a5c,
    gather: { node: 'field', out: 'wheat', time: 2.5, range: 0 }, worker: 'Farmer', wcolor: 0xd9b64e, fields: true, plots: 9 },

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

  vineyard: { name: 'Vineyard', desc: 'Grows & harvests grapes on its plots', model: 'farm',
    cost: { timber: 3, stone: 1 }, roof: 0x6a3d6e, wall: 0xb08a5c,
    gather: { node: 'field', out: 'grape', time: 2.5, range: 0 }, worker: 'Vintner', wcolor: 0x7a4b8a, fields: true, plots: 6 },

  winery: { name: 'Winery', desc: 'Grapes → wine', model: 'cottage',
    cost: { timber: 2, stone: 2 }, roof: 0x5c1f2b, wall: 0xc4a075, accent: 0x7b2233,
    recipe: { inp: { grape: 1 }, out: 'wine', time: 6 }, worker: 'Winemaker', wcolor: 0x7b2233 },

  pigfarm: { name: 'Pig Farm', desc: 'Pigs graze pasture plots → meat', model: 'farm',
    cost: { timber: 3, stone: 2 }, roof: 0xb56a6a, wall: 0xb08a5c, accent: 0xc96b6b,
    gather: { node: 'field', out: 'meat', time: 3, range: 0 }, worker: 'Swineherd', wcolor: 0xc96b6b, fields: true, plots: 6 },

  butcher: { name: 'Butchery', desc: 'Meat → sausages', model: 'cottage',
    cost: { timber: 2, stone: 2 }, roof: 0x7a3320, wall: 0xc4a075, accent: 0x9c4a2f,
    recipe: { inp: { meat: 1 }, out: 'sausage', time: 6 }, worker: 'Butcher', wcolor: 0x9c4a2f },

  tavern: { name: 'Tavern', desc: 'Serves any food (bread, sausage, wine, fish…) to keep workers fed & fast', model: 'tavern',
    cost: { timber: 4, stone: 3 }, roof: 0x8a5a2b, wall: 0xcaa46e, accent: 0xffb060,
    tavern: { foods: ['bread', 'sausage', 'wine', 'fish'], capacity: 6, time: 4 }, worker: 'Taverner', wcolor: 0xb5763a },

  fishery: { name: 'Fishery', desc: 'Nets fish from the lake — build on the shore', model: 'cottage',
    cost: { timber: 3, stone: 1 }, roof: 0x3f6f7a, wall: 0xbfae8e, accent: 0x7fb0c4,
    gather: { node: 'fish', out: 'fish', time: 4, range: 6 }, worker: 'Fisher', wcolor: 0x4f93a8 },

  barracks: { name: 'Barracks', desc: 'Trains soldiers & archers (costs coin & timber)', model: 'barn',
    cost: { timber: 4, stone: 3 }, roof: 0x5a4a6a, wall: 0xb0a48c, accent: 0x8a5a2b, hp: 200,
    military: { trains: ['soldier', 'archer'], time: 6, cost: { timber: 1, coin: 1 } } },

  banditcamp: { name: 'Bandit Camp', desc: 'A den of raiders', model: 'barn',
    cost: {}, roof: 0x4a2e20, wall: 0x6b4a34, accent: 0x3a2a20, hp: 180 },

  watchtower: { name: 'Watchtower', desc: 'A fortified enemy archer tower', model: 'mine',
    cost: {}, roof: 0x4a5056, wall: 0x777d82, accent: 0x9c3b3b, hp: 260 },

  enemycastle: { name: 'Enemy Keep', desc: 'The enemy stronghold', model: 'barn',
    cost: {}, roof: 0x3a2a3a, wall: 0x8a8078, accent: 0x5a1a26, hp: 900 },
};

/** Build-menu tabs, grouping buildings by the goal / production chain they serve. */
export interface BuildCategory { id: string; name: string; keys: BuildingKey[]; stub?: string; }

export const MENU_CATEGORIES: BuildCategory[] = [
  { id: 'materials', name: 'Materials', keys: ['guildhall', 'woodcutter', 'sawmill', 'forester', 'quarry'] },
  { id: 'food', name: 'Food', keys: ['farm', 'mill', 'bakery', 'pigfarm', 'butcher', 'vineyard', 'winery', 'fishery', 'tavern'] },
  { id: 'coin', name: 'Coin', keys: ['goldmine', 'coalmine', 'mint'] },
  { id: 'military', name: 'Military', keys: ['barracks'] },
];
