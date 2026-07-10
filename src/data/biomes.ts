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
export type BiomeKey = 'gooi' | 'ardennes' | 'blackforest' | 'alps';

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
  };
  ambiance: {
    windmill: boolean;      // the horizon postcard windmill (Het Gooi)
    village: boolean;       // the tiny horizon village
    forestRing: boolean;    // a dense dark tree ring instead of open fields
    peakRing: boolean;      // a ring of big snowy massifs on the horizon
    hillBumps: boolean;     // extra near rolling hills (Ardennes)
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
};

/**
 * The campaign's ascension journey: climbing the ladder marches the run into
 * harsher lands. The economy arc (levels 1-4) always stays in Het Gooi so
 * production objectives remain honest; the combat arc migrates.
 *   Hard      → levels 5-6 cross into the Ardennes
 *   Very Hard → …and the Black Forest swallows levels 7-8
 *   Absurd    → …and the run ends among the peaks of the Alps (9-10)
 */
export function campaignBiome(ascension: number, levelIndex: number): BiomeKey {
  if (levelIndex <= 4 || ascension <= 0) return 'gooi';
  if (ascension >= 3 && levelIndex >= 9) return 'alps';
  if (ascension >= 2 && levelIndex >= 7) return 'blackforest';
  return 'ardennes';
}

/** Pick a tree species index (0..3) by this biome's weights. */
export function pickTreeKind(biome: BiomeDef, r: number): number {
  const w = biome.treeWeights;
  const total = w[0] + w[1] + w[2] + w[3];
  let roll = r * total;
  for (let i = 0; i < 4; i++) { roll -= w[i]; if (roll < 0) return i; }
  return 0;
}
