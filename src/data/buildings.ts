import type { BuildingDef, BuildingKey } from '../types';

export const DEFS: Record<BuildingKey, BuildingDef> = {
  storehouse: { name: 'Storehouse', desc: 'A fortified depot: stores every good and looses arrows at raiders. Your first one is the castle — build more to shorten haul routes', model: 'castle',
    cost: { timber: 12, stone: 16, coin: 10 }, roof: 0x9a3b2e, wall: 0xb3aea2, store: true, hp: 500,
    tower: { range: 7, dmg: 8, rate: 1.6 } },

  guildhall: { name: 'Guild Hall', desc: 'Trains villagers who staff your buildings (also serfs & builders)', model: 'guildhall',
    cost: { timber: 4, stone: 3 }, roof: 0x46606e, wall: 0x9a5a40, accent: 0xffd24a, hp: 250,
    trainer: { units: [
      { kind: 'villager', cost: { coin: 1 }, time: 5,
        desc: 'Staffs one production building as its specialist (woodcutter, baker, miner…)' },
      { kind: 'serf', cost: { coin: 1 }, time: 5,
        desc: 'Hauls goods between buildings and delivers materials to construction sites' },
      { kind: 'laborer', cost: { coin: 1 }, time: 5,
        desc: 'Raises buildings once their materials have been delivered' },
    ] } },

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

  market: { name: 'Market', desc: 'Assign surplus goods to export; invulnerable horse traders arrive automatically and pay in coin', model: 'cottage',
    cost: { timber: 4, stone: 2, coin: 2 }, roof: 0xb54f38, wall: 0xc8aa78, accent: 0xffd24a, hp: 180 },

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
    tavern: { foods: ['bread', 'sausage', 'wine', 'fish', 'clam'], capacity: 6, time: 4 }, worker: 'Taverner', wcolor: 0xb5763a },

  fishery: { name: 'Fishery', desc: 'Nets fish from the lake — build on the shore', model: 'cottage',
    cost: { timber: 3, stone: 1 }, roof: 0x3f6f7a, wall: 0xbfae8e, accent: 0x7fb0c4,
    gather: { node: 'fish', out: 'fish', time: 4, range: 6 }, worker: 'Fisher', wcolor: 0x4f93a8 },

  // Coastal lands only (the Zeeland Delta, Texel): the tidal flats are a food
  // chain that asks for no farmland, no plots and no second building.
  clamdigger: { name: 'Clam Digger', desc: 'Rakes clams from the tidal flats — build on the sea shore (coastal lands only)', model: 'cottage',
    cost: { timber: 2, stone: 1 }, roof: 0x8a7c5e, wall: 0xcbbd97, accent: 0xd8bb8c, coastal: true,
    gather: { node: 'fish', out: 'clam', time: 3.2, range: 6 }, worker: 'Clam raker', wcolor: 0xb9a97e },

  ironmine: { name: 'Iron Mine', desc: 'Mines iron deposits — the raw metal for weapons & armor', model: 'mine',
    cost: { timber: 2, stone: 1 }, roof: 0x8a4a30, wall: 0x8f8a80, accent: 0xa86a4a,
    gather: { node: 'iron', out: 'iron', time: 5, range: 9 }, worker: 'Ironminer', wcolor: 0xa86a4a },

  smithy: { name: 'Weaponsmith', desc: 'Iron + coal → weapons for training infantry & knights', model: 'cottage',
    cost: { timber: 3, stone: 3 }, roof: 0x4a4a52, wall: 0x9c8a6a, accent: 0xd8dde2,
    recipe: { inp: { iron: 1, coal: 1 }, out: 'weapon', time: 7 }, worker: 'Smith', wcolor: 0x5a5f66 },

  armory: { name: 'Armorer', desc: 'Iron + coal → armor for training knights', model: 'cottage',
    cost: { timber: 3, stone: 3 }, roof: 0x5a6470, wall: 0x9c8a6a, accent: 0x7d8794,
    recipe: { inp: { iron: 1, coal: 1 }, out: 'armor', time: 8 }, worker: 'Armorer', wcolor: 0x7d8794 },

  barracks: { name: 'Barracks', desc: 'Trains soldiers, pikemen, archers & knights — weapons come from the smithy', model: 'barn',
    cost: { timber: 4, stone: 3 }, roof: 0x5a4a6a, wall: 0xb0a48c, accent: 0x8a5a2b, hp: 200,
    military: { units: [
      { kind: 'soldier', cost: { weapon: 1, coin: 1 }, time: 6,
        desc: 'Steady melee line fighter — the backbone of any warband' },
      { kind: 'pikeman', cost: { timber: 1, weapon: 1, coin: 1 }, time: 7,
        desc: 'Long-pike infantry — deals 2.5× damage to mounted riders' },
      { kind: 'archer', cost: { timber: 1, coin: 1 }, time: 6,
        desc: 'Ranged fighter — fragile, but hits from five tiles away' },
      { kind: 'knight', cost: { weapon: 1, armor: 1, coin: 2 }, time: 9,
        desc: 'Heavy elite — twice a soldier\'s health and hits much harder' },
    ] } },

  stable: { name: 'Stable', desc: 'Breeds warhorses and trains mounted fighters', model: 'barn',
    cost: { timber: 4, stone: 2 }, roof: 0x7a4a2c, wall: 0xb59a6a, accent: 0x8a5a2b, hp: 220,
    military: { units: [
      { kind: 'lancer', cost: { weapon: 1, coin: 2 }, time: 7,
        desc: 'Fast light cavalry — charges into melee at half again a rider\u2019s pace' },
      { kind: 'horsearcher', cost: { timber: 1, coin: 2 }, time: 7,
        desc: 'Mounted bowman — fragile, quick, shoots on the move' },
      { kind: 'horseknight', cost: { weapon: 1, armor: 1, coin: 3 }, time: 10,
        desc: 'Heavy shock cavalry — armoured horse and rider, hits like a wall' },
    ] } },

  engineer: { name: 'Engineer\u2019s Workshop', desc: 'Builds siege engines — ballistas, onagers & trebuchets', model: 'cottage',
    cost: { timber: 5, stone: 4 }, roof: 0x5a5346, wall: 0x9c8a6a, accent: 0xc9a94e, hp: 240,
    military: { units: [
      { kind: 'ballista', cost: { timber: 3, weapon: 1, coin: 2 }, time: 10,
        desc: 'Giant crossbow on wheels — long-ranged bolts, slow to move' },
      { kind: 'onager', cost: { timber: 3, stone: 2, coin: 3 }, time: 11,
        desc: 'Rock-lobbing catapult — splashes damage across a cluster of foes' },
      { kind: 'trebuchet', cost: { timber: 5, stone: 3, coin: 4 }, time: 14,
        desc: 'The wall-breaker — devastating stones from far off, but crawls' },
    ] } },

  monastery: { name: 'Monastery', desc: 'A stone cloister and chapel that trains priests to heal nearby allies', model: 'cottage',
    cost: { timber: 4, stone: 6, coin: 2 }, roof: 0x70433a, wall: 0xd8cfba, accent: 0xd9a441, hp: 280,
    military: { units: [
      { kind: 'priest', cost: { coin: 3 }, time: 8,
        desc: 'Humble support unit — automatically heals nearby friendly units and stays at the rear' },
    ] } },

  watchtower: { name: 'Watchtower', desc: 'Looses arrows at raiders in range — build it along their path', model: 'mine',
    cost: { timber: 2, stone: 5 }, roof: 0x6a7076, wall: 0x9aa0a3, accent: 0x3f5aa0, hp: 320,
    tower: { range: 7, dmg: 9, rate: 1.4 } },

  stonetower: { name: 'Stone Watchtower', desc: 'A tall stone tower — tougher and further-seeing than the wooden one', model: 'mine',
    cost: { timber: 1, stone: 8, coin: 2 }, roof: 0x565c62, wall: 0x8f959a, accent: 0x3f5aa0, hp: 520,
    tower: { range: 8, dmg: 11, rate: 1.5 } },

  wall: { name: 'Stone Wall', desc: 'A solid stretch of rampart — raiders must batter it down to pass', model: 'mine',
    cost: { stone: 4 }, roof: 0x8a9095, wall: 0x9aa0a3, accent: 0x6a7076, hp: 600, bulwark: true, entrance: 'none' },

  gate: { name: 'Gate', desc: 'A fortified archway: your own units pass freely, enemies must break it down', model: 'mine',
    cost: { timber: 2, stone: 3 }, roof: 0x77593a, wall: 0x9aa0a3, accent: 0x6b4a2f, hp: 450, bulwark: true, gate: true, entrance: 'through' },

  banditcamp: { name: 'Bandit Camp', desc: 'A den of raiders', model: 'barn',
    cost: {}, roof: 0x4a2e20, wall: 0x6b4a34, accent: 0x3a2a20, hp: 180 },

  enemywatchtower: { name: 'Watchtower', desc: 'A fortified enemy archer tower', model: 'mine',
    cost: {}, roof: 0x4a5056, wall: 0x777d82, accent: 0x9c3b3b, hp: 260,
    tower: { range: 6.5, dmg: 9, rate: 1.6 } },

  enemycastle: { name: 'Enemy Keep', desc: 'The enemy stronghold', model: 'castle',
    cost: {}, roof: 0x3a2a3a, wall: 0x8a8078, accent: 0x5a1a26, hp: 900,
    tower: { range: 7, dmg: 11, rate: 2.2 } },

  enemywall: { name: 'Stronghold Wall', desc: 'The stronghold’s rampart — batter it down or find the gate', model: 'mine',
    cost: {}, roof: 0x5a5560, wall: 0x777d82, accent: 0x4a5056, hp: 500, bulwark: true, entrance: 'none' },

  enemygate: { name: 'Stronghold Gate', desc: 'The stronghold’s barred gate — its defenders pass, you don’t', model: 'mine',
    cost: {}, roof: 0x4a3a30, wall: 0x777d82, accent: 0x3a2a20, hp: 400, bulwark: true, gate: true, entrance: 'through' },
};

/** Build-menu tabs, grouping buildings by the goal / production chain they serve. */
export interface BuildCategory { id: string; name: string; keys: BuildingKey[]; stub?: string; }

export const MENU_CATEGORIES: BuildCategory[] = [
  { id: 'materials', name: 'Materials', keys: ['guildhall', 'woodcutter', 'sawmill', 'forester', 'quarry', 'storehouse'] },
  { id: 'food', name: 'Food', keys: ['farm', 'mill', 'bakery', 'pigfarm', 'butcher', 'vineyard', 'winery', 'fishery', 'clamdigger', 'tavern'] },
  { id: 'coin', name: 'Coin', keys: ['goldmine', 'coalmine', 'mint', 'market'] },
  { id: 'military', name: 'Military', keys: ['barracks', 'stable', 'engineer', 'monastery', 'ironmine', 'smithy', 'armory', 'watchtower', 'stonetower', 'wall', 'gate'] },
];
