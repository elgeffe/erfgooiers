import type { CritterKind } from '../render/models';
import type { BuildingKey, DecoKind, DepositKind } from '../types';

/**
 * Biomes — the landscape a map is cut from. A biome recolours the board
 * (grass, water, rock, sky, horizon), picks the vegetation (tree species mix,
 * meadow flora, ground scatter), selects which critters live there, adds its
 * own worldgen character (extra ridges, impassable forest thickets, permanent
 * snowlines) and hands the audio engine a matching musical mood.
 *
 * Everything is a lookup on this table: World reads `gen`, View reads
 * `palette`/`ambiance`/`critters`, models read the foliage palette, Audio maps
 * the key to a biome mood. Het Gooi is the default and the campaign's home.
 */
export type BiomeKey = 'gooi' | 'ardennes' | 'blackforest' | 'alps'
  | 'winter' | 'polder' | 'seaside' | 'island' | 'hell';

export interface BiomePalette {
  grassA: number; grassB: number;   // meadow dither pair
  water: number;
  scree: number;                    // ground under mountain peaks
  plain: number;                    // the horizon plain disc
  fog: number;
  sky: [string, string, string, string]; // vertical gradient stops, top → horizon
  hillTones: number[];              // rolling horizon domes
  fieldTones: number[];             // patchwork strips beyond the board
  folGreens: number[];              // tree foliage palette
}

export interface BiomeDef {
  key: BiomeKey;
  name: string;
  desc: string;
  palette: BiomePalette;
  /** Weights for the four tree species (conifer, tall pine, broadleaf, birch). */
  treeWeights: [number, number, number, number];
  /** What grows in this biome's dense meadow patches (lavender fields etc.). */
  meadowDeco: DecoKind;
  /** Loose ground scatter: [common, rare] doodads dotted across open ground. */
  scatterDeco: [DecoKind, DecoKind];
  /** Which cosmetic critters may spawn here. */
  critters: CritterKind[];
  /** Buildings that cannot be raised in this landscape (hidden in the menu).
   *  Chosen so no campaign level's objective ever needs a chain its ascension
   *  biome forbids — the economy levels (1-4) always play in Het Gooi. */
  disabledBuildings: BuildingKey[];
  /** The ore-vein mix this ground favours (drawn round-robin per vein). */
  oreWeights: DepositKind[];
  gen: {
    mountainsAdd: number;   // ridge chains added on top of the level's own count
    treeMult: number;       // ×density of tree stands
    denseThickets: number;  // impassable old-growth clusters (Black Forest)
    snowline: boolean;      // every mountain peak carries snow (Alps)
    treeSnow?: boolean;     // every tree carries snow (Winter)
    /** Sea water claims map edges: one coastline ('sea') or all four ('island'). */
    coast?: 'sea' | 'island';
    /** A river rises inland and braids into distributaries as it meets the sea. */
    riverDelta?: boolean;
    /** Straight drainage canals with crossing gaps cut across the flats (Polder). */
    ditches?: number;
    /** Hellscape: peaks smoulder instead of snowing, water is lava (no fish,
     *  no reeds), and the flora reads as scorched. */
    scorched?: boolean;
    /** No mountain tiles ever form here, whatever the level asks for (Texel). */
    flatland?: boolean;
  };
  ambiance: {
    windmill: boolean;      // the horizon postcard windmill (Het Gooi)
    village: boolean;       // the tiny horizon village
    forestRing: boolean;    // a dense dark tree ring instead of open fields
    peakRing: boolean;      // a ring of big snowy massifs on the horizon
    hillBumps: boolean;     // extra near rolling hills (Ardennes)
    /** Open sea on the horizon: half of it ('coast') or all around ('all'). */
    sea?: 'coast' | 'all';
    lighthouse?: boolean;   // a red-banded light turning on the coast (Texel)
    dunes?: boolean;        // a near ring of sandy marram dunes instead of green hills
    whale?: boolean;        // a great whale cruising the horizon sea (Texel)
  };
}

export const BIOMES: Record<BiomeKey, BiomeDef> = {
  gooi: {
    key: 'gooi', name: 'Het Gooi', desc: 'Sunlit meadows, lavender and one far-off windmill',
    palette: {
      grassA: 0x6fae52, grassB: 0x89c266, water: 0x36648f, scree: 0x83837e,
      plain: 0x7da866, fog: 0xd4e4df,
      sky: ['#4e9bd0', '#82bddd', '#bddbea', '#f0e9d3'],
      hillTones: [0x91b879, 0x7da86f, 0x709a73, 0x668c7b],
      fieldTones: [0x91ae61, 0xb3ad62, 0x779d59, 0xc0a86a, 0x88a968],
      folGreens: [0x4e7a3a, 0x557f38, 0x476f36, 0x5f8c40, 0x6a9a44],
    },
    treeWeights: [1, 1, 1, 1],
    meadowDeco: 'lavender',
    scatterDeco: ['flowers', 'bush'],
    critters: ['rabbit', 'fox', 'hedgehog', 'mouse', 'duck', 'cat', 'frog'],
    disabledBuildings: [],
    oreWeights: ['stone', 'stone', 'gold', 'coal', 'iron'],
    gen: { mountainsAdd: 0, treeMult: 1, denseThickets: 0, snowline: false },
    ambiance: { windmill: true, village: true, forestRing: false, peakRing: false, hillBumps: false },
  },

  ardennes: {
    key: 'ardennes', name: 'The Ardennes', desc: 'Rolling wooded hills, heather and ferns',
    palette: {
      grassA: 0x74a04b, grassB: 0x8fae57, water: 0x3d6684, scree: 0x7e7a70,
      plain: 0x72985c, fog: 0xd3ddcc,
      sky: ['#5e97c2', '#8fb8d2', '#c3d6d8', '#ece2c8'],
      hillTones: [0x7fa060, 0x6e9158, 0x5f8355, 0x557b5e],
      fieldTones: [0x86a055, 0x9d9a54, 0x6f9350, 0xa8935c, 0x7c9a5b],
      folGreens: [0x4a7034, 0x5b7a32, 0x6d7f36, 0x8a7a35, 0x9a6b30],
    },
    treeWeights: [2, 1, 4, 2],
    meadowDeco: 'heather',
    scatterDeco: ['fern', 'bush'],
    critters: ['deer', 'squirrel', 'fox', 'rabbit', 'hedgehog'],
    // too cold and clouded for grapes
    disabledBuildings: ['vineyard', 'winery'],
    // old iron country: the veins run red
    oreWeights: ['stone', 'iron', 'iron', 'coal', 'gold'],
    gen: { mountainsAdd: 3, treeMult: 1.3, denseThickets: 0, snowline: false },
    ambiance: { windmill: false, village: true, forestRing: false, peakRing: false, hillBumps: true },
  },

  blackforest: {
    key: 'blackforest', name: 'The Black Forest', desc: 'Deep dark pines, mushrooms — and thickets no one passes',
    palette: {
      grassA: 0x557d43, grassB: 0x648b4a, water: 0x2d5468, scree: 0x6b6a63,
      plain: 0x48663f, fog: 0xb9c8b4,
      sky: ['#41708f', '#6f9aa8', '#a3bcae', '#d5d3b4'],
      hillTones: [0x53704a, 0x475f45, 0x3d5442, 0x364b42],
      fieldTones: [0x5d7c48, 0x6b8449, 0x50704a, 0x77854d, 0x5a7850],
      folGreens: [0x2e4d28, 0x35582c, 0x2a462a, 0x3d612f, 0x315227],
    },
    treeWeights: [3, 5, 1, 1],
    meadowDeco: 'fern',
    scatterDeco: ['mushroom', 'fern'],
    critters: ['deer', 'squirrel', 'fox', 'hedgehog', 'mouse'],
    // no open farmland under the canopy: you live on pigs, fish and what the
    // forest gives — bread only from your start stores
    disabledBuildings: ['farm', 'mill', 'bakery', 'vineyard', 'winery'],
    // charcoal country
    oreWeights: ['stone', 'coal', 'coal', 'iron', 'gold'],
    gen: { mountainsAdd: 1, treeMult: 1.8, denseThickets: 6, snowline: false },
    ambiance: { windmill: false, village: false, forestRing: true, peakRing: false, hillBumps: false },
  },

  alps: {
    key: 'alps', name: 'The Alps', desc: 'High meadows under snowbound peaks, edelweiss and thin air',
    palette: {
      grassA: 0x7cae6b, grassB: 0x95c07c, water: 0x4a7d9e, scree: 0x8d8d8a,
      plain: 0x84a878, fog: 0xdfe8ec,
      sky: ['#3d7fc4', '#79b0dd', '#c6dcea', '#f4f2e6'],
      hillTones: [0x9aa793, 0x8f9c92, 0xb8bcb4, 0xd9dcd8],
      fieldTones: [0x8cae72, 0xa3b478, 0x7ba46c, 0xb4b98a, 0x93b07a],
      folGreens: [0x3f6d3a, 0x4a7a40, 0x557f45, 0x466f3c, 0x51823f],
    },
    treeWeights: [4, 3, 0, 1],
    meadowDeco: 'edelweiss',
    scatterDeco: ['edelweiss', 'bush'],
    critters: ['ibex', 'marmot', 'rabbit', 'fox'],
    // grapes and pigs don't survive the altitude; hardy grain on high meadows does
    disabledBuildings: ['vineyard', 'winery', 'pigfarm', 'butcher'],
    // the mountains are made of building stone
    oreWeights: ['stone', 'stone', 'stone', 'iron', 'gold', 'coal'],
    gen: { mountainsAdd: 5, treeMult: 0.7, denseThickets: 0, snowline: true },
    ambiance: { windmill: false, village: false, forestRing: false, peakRing: true, hillBumps: false },
  },

  winter: {
    key: 'winter', name: 'Winter', desc: 'The land under snow — bare birches, red berries and chimney smoke',
    palette: {
      grassA: 0xdde4de, grassB: 0xecf0ea, water: 0x3e6a86, scree: 0x9aa0a2,
      plain: 0xdbe2dd, fog: 0xe8eef2,
      sky: ['#7fa8c9', '#a8c4d8', '#d3e0e6', '#f2efe4'],
      hillTones: [0xd9e0da, 0xcdd6d1, 0xc0cbc9, 0xb3c0c2],
      fieldTones: [0xdfe5dd, 0xd2dad2, 0xe7ebe2, 0xc9d3cd, 0xdae0d6],
      folGreens: [0x2f5136, 0x3a5c3c, 0x2c4a34, 0x44684a, 0x39573f],
    },
    treeWeights: [4, 3, 0, 3],
    meadowDeco: 'winterberry',
    scatterDeco: ['snowdrift', 'winterberry'],
    critters: ['fox', 'rabbit', 'deer', 'mouse'],
    // frozen fields and vines: you live on pigs, fish and your start stores
    disabledBuildings: ['farm', 'mill', 'bakery', 'vineyard', 'winery'],
    // the cold burns through coal
    oreWeights: ['stone', 'coal', 'coal', 'iron', 'gold'],
    gen: { mountainsAdd: 2, treeMult: 0.9, denseThickets: 0, snowline: true, treeSnow: true },
    ambiance: { windmill: false, village: true, forestRing: false, peakRing: false, hillBumps: false },
  },

  polder: {
    key: 'polder', name: 'The Polder', desc: 'Land won from the water — tulips, ditches and a big Dutch sky',
    palette: {
      grassA: 0x63a85c, grassB: 0x7fbc6a, water: 0x4a7391, scree: 0x8b8a80,
      plain: 0x6ba463, fog: 0xdce7e4,
      sky: ['#4d95cd', '#84bade', '#c2dcec', '#f2ecd8'],
      hillTones: [0x84b46e, 0x76a868, 0x699c6b, 0x5f8f70],
      fieldTones: [0xc2454f, 0xd9a437, 0x7fae5c, 0xb85c9e, 0x8fb066],
      folGreens: [0x4d7c3b, 0x5a8a3f, 0x467337, 0x639145, 0x548140],
    },
    treeWeights: [1, 0, 3, 4],
    meadowDeco: 'tulip',
    scatterDeco: ['flowers', 'reed'],
    critters: ['duck', 'heron', 'rabbit', 'cat', 'frog'],
    // too wet and too windy for grapes below sea level
    disabledBuildings: ['vineyard', 'winery'],
    // clay ground: what stone there is, you prize
    oreWeights: ['stone', 'stone', 'coal', 'iron', 'gold'],
    gen: { mountainsAdd: 0, treeMult: 0.6, denseThickets: 0, snowline: false, ditches: 5 },
    ambiance: { windmill: true, village: true, forestRing: false, peakRing: false, hillBumps: false },
  },

  seaside: {
    key: 'seaside', name: 'The Zeeland Delta', desc: 'Where the river braids into the sea — dunes, gulls and salt wind',
    palette: {
      grassA: 0x8fae62, grassB: 0xa5bd6f, water: 0x3a6e8c, scree: 0xcbb98a,
      plain: 0x9cb077, fog: 0xdfe9e8,
      sky: ['#4b9ccc', '#83c0de', '#c4dfea', '#f4eed7'],
      hillTones: [0xd8c894, 0xccbb85, 0xbfae7c, 0xa9a578],
      fieldTones: [0x9cae66, 0xb8ad6a, 0x86a35e, 0xc4ac72, 0x93a96b],
      folGreens: [0x557d3d, 0x628a42, 0x4b7239, 0x6f9448, 0x5c8340],
    },
    treeWeights: [2, 1, 2, 3],
    meadowDeco: 'dunegrass',
    scatterDeco: ['dunegrass', 'bush'],
    critters: ['gull', 'duck', 'heron', 'rabbit', 'fox'],
    // salt wind strips the vines
    disabledBuildings: ['vineyard', 'winery'],
    oreWeights: ['stone', 'stone', 'iron', 'coal', 'gold'],
    gen: { mountainsAdd: 0, treeMult: 0.7, denseThickets: 0, snowline: false, coast: 'sea', riverDelta: true },
    ambiance: { windmill: true, village: true, forestRing: false, peakRing: false, hillBumps: false, sea: 'coast', dunes: true },
  },

  island: {
    key: 'island', name: 'Texel', desc: 'Dunes, sheep and a striped lighthouse — the sea on every side',
    palette: {
      grassA: 0x84b063, grassB: 0x9cc172, water: 0x41708f, scree: 0xd3c193,
      plain: 0x4a7898, fog: 0xe2ebee,
      sky: ['#4293c9', '#7cbcdd', '#c0dcea', '#f2eddb'],
      hillTones: [0xdccf9e, 0xd0c28f, 0xc2b482, 0xb0a97e],
      fieldTones: [0x96b168, 0xafb06e, 0x84a660, 0xc9b57c, 0x8fac6a],
      folGreens: [0x527a3c, 0x5f8841, 0x497038, 0x6b9147, 0x58803f],
    },
    treeWeights: [1, 1, 2, 4],
    meadowDeco: 'dunegrass',
    scatterDeco: ['dunegrass', 'flowers'],
    critters: ['sheep', 'gull', 'rabbit', 'seal', 'duck'],
    // nothing tall survives the North Sea wind
    disabledBuildings: ['vineyard', 'winery'],
    oreWeights: ['stone', 'stone', 'gold', 'iron', 'coal'],
    // dune country is flat as a pancake: no mountain ever breaks the skyline
    gen: { mountainsAdd: 0, treeMult: 0.5, denseThickets: 0, snowline: false, coast: 'island', flatland: true },
    // no horizon village: past the beach there is only the sea
    ambiance: { windmill: false, village: false, forestRing: false, peakRing: false, hillBumps: false, sea: 'all', lighthouse: true, dunes: true, whale: true },
  },

  hell: {
    key: 'hell', name: 'Hell', desc: 'Ash plains, rivers of fire and smouldering peaks — nothing kind grows here',
    palette: {
      grassA: 0x4a3a38, grassB: 0x5c4640, water: 0xd8551e, scree: 0x3f3236,
      plain: 0x453538, fog: 0x5a3c34,
      sky: ['#2b1518', '#4a1f1a', '#7a3520', '#c26a2e'],
      hillTones: [0x4d3336, 0x422b2f, 0x372428, 0x2e1e22],
      fieldTones: [0x54403a, 0x61443a, 0x48362f, 0x6b4a35, 0x503b31],
      folGreens: [0x4a2f22, 0x5c3826, 0x3f2a1e, 0x6b3d24, 0x55321f],
    },
    treeWeights: [3, 4, 0, 1],
    meadowDeco: 'embers',
    scatterDeco: ['bones', 'embers'],
    critters: [], // nothing lives here that you'd want to pet
    // nothing grows and nothing swims: pigs (of a sort) and your stores
    disabledBuildings: ['farm', 'mill', 'bakery', 'vineyard', 'winery', 'fishery'],
    // brimstone country
    oreWeights: ['coal', 'coal', 'iron', 'gold', 'stone'],
    gen: { mountainsAdd: 6, treeMult: 0.4, denseThickets: 0, snowline: false, scorched: true },
    ambiance: { windmill: false, village: false, forestRing: false, peakRing: true, hillBumps: false },
  },
};

/**
 * The campaign's ascension journey: climbing the ladder marches the run into
 * stranger and harsher lands. The economy arc (levels 1-4) always stays in
 * Het Gooi so production objectives remain honest; the combat arc migrates —
 * every combat level's goal (survive/slay/destroy) is biome-proof, so no
 * land's building bans can strand an objective.
 *   Hard      → the march leaves home: the Polder (5), then the Ardennes
 *   Very Hard → level 7 follows the Delta coast; the Black Forest swallows 8+
 *   Absurd    → the hunt crosses to Texel (6), and the run ends in the Alps
 *   Grim      → winter falls on the high march (level 9 freezes over)
 *   Infernal  → the dragon's hoard lies at the gates of Hell (level 10)
 */
export function campaignBiome(ascension: number, levelIndex: number): BiomeKey {
  if (levelIndex <= 4 || ascension <= 0) return 'gooi';
  if (levelIndex === 5) return 'polder';
  if (levelIndex === 6) return ascension >= 3 ? 'island' : 'ardennes';
  if (levelIndex === 7) return ascension >= 2 ? 'seaside' : 'ardennes';
  if (levelIndex === 8) return ascension >= 2 ? 'blackforest' : 'ardennes';
  if (levelIndex === 9) {
    if (ascension >= 4) return 'winter';
    if (ascension >= 3) return 'alps';
    return ascension >= 2 ? 'blackforest' : 'ardennes';
  }
  // level 10 — the run's last stand
  if (ascension >= 5) return 'hell';
  if (ascension >= 3) return 'alps';
  return ascension >= 2 ? 'blackforest' : 'ardennes';
}

/** Pick a tree species index (0..3) by this biome's weights. */
export function pickTreeKind(biome: BiomeDef, r: number): number {
  const w = biome.treeWeights;
  const total = w[0] + w[1] + w[2] + w[3];
  let roll = r * total;
  for (let i = 0; i < 4; i++) { roll -= w[i]; if (roll < 0) return i; }
  return 0;
}
