import type * as THREE from 'three';
import type { FlowField } from './engine/flowfield';

export type ItemKey =
  | 'trunk' | 'timber' | 'stone' | 'wheat' | 'flour'
  | 'bread' | 'goldore' | 'coal' | 'coin'
  | 'grape' | 'wine' | 'meat' | 'sausage' | 'fish' | 'clam'
  | 'iron' | 'weapon' | 'armor';

export type BuildingKey =
  | 'storehouse' | 'guildhall' | 'woodcutter' | 'forester' | 'sawmill' | 'quarry'
  | 'farm' | 'mill' | 'bakery' | 'goldmine' | 'coalmine' | 'mint'
  | 'vineyard' | 'winery' | 'pigfarm' | 'butcher' | 'tavern' | 'fishery' | 'clamdigger'
  | 'barracks' | 'stable' | 'engineer' | 'ironmine' | 'smithy' | 'armory' | 'watchtower'
  | 'stonetower' | 'wall' | 'gate' | 'monastery'
  | 'market'
  | 'banditcamp' | 'enemywatchtower' | 'enemycastle' | 'enemywall' | 'enemygate';

export type NodeKind = 'tree' | 'plant' | 'stone' | 'gold' | 'coal' | 'iron' | 'field' | 'fish';

/** Stable owner identity for the two allied co-op economies. */
export type PlayerId = 'p1' | 'p2';
export const PLAYER_IDS: readonly PlayerId[] = ['p1', 'p2'];

/** Simulation owner. Diplomacy is derived separately so p1/p2 remain allied. */
export type OwnerId = PlayerId | 'enemy' | 'wild';

/** Which side a unit or building belongs to. Economy workers are always 'player'. */
export type Faction = 'player' | 'enemy' | 'wild';
export type Formation = 'box' | 'line' | 'column' | 'split';

/** A player-issued command to a controllable unit (hero / soldiers). */
export interface UnitOrder {
  type: 'move' | 'attack' | 'attackMove';
  x: number; y: number;
  foe: Unit | null;
  /** Explicit structure focus for a siege order. Kept on queued orders so a
   *  Shift-chained attack cannot degrade into a generic attack-move. */
  building: Building | null;
  /** Shared flow field of the group order this came from: the whole selection
   *  derives paths from one flood instead of one A* each. Nulled per unit the
   *  moment the field cannot serve it (falls back to a budgeted global A*). */
  field?: FlowField | null;
}

/** Purely decorative ground scatter (no gameplay effect). */
export type DecoKind = 'lavender' | 'flowers' | 'bush' | 'reed' | 'lily'
  | 'heather' | 'fern' | 'mushroom' | 'edelweiss'
  | 'tulip' | 'dunegrass' | 'winterberry' | 'snowdrift' | 'bones' | 'embers';

/** Which mesh builder in render/models.ts renders a building. */
export type ModelKind = 'cottage' | 'windmill' | 'farm' | 'barn' | 'mine' | 'tavern' | 'castle' | 'guildhall';

export interface ItemDef { name: string; color: string; hex: number; }

export interface GatherDef { node: NodeKind; out: ItemKey | null; time: number; range: number; }
export interface RecipeDef {
  inp: Partial<Record<ItemKey, number>>;
  out: ItemKey;
  time: number;
  /** Completed output enters global storage immediately instead of requiring a serf haul. */
  globalOutput?: boolean;
}
/** A tavern feeds nearby workers any of several foods; capacity caps how many it serves. */
export interface TavernDef { foods: ItemKey[]; capacity: number; time: number; }

/** One trainable unit at a barracks/guild hall: its own cost & training time. */
export interface TrainDef { kind: string; cost: Partial<Record<ItemKey, number>>; time: number; desc?: string; }
/** A barracks/guild hall trains units, each with its own cost and time. */
export interface MilitaryDef { units: TrainDef[]; }

/** A tower building looses arrows at hostile fighters in range on its own. */
export interface TowerDef { range: number; dmg: number; rate: number; }

export interface BuildingDef {
  name: string;
  desc: string;
  cost: Partial<Record<ItemKey, number>>;
  roof: number;
  wall: number;
  model: ModelKind;
  accent?: number;             // decorative accent (ore chunks, chimney glow…)
  store?: boolean;
  gather?: GatherDef;
  recipe?: RecipeDef;
  tavern?: TavernDef;
  fields?: boolean;
  plots?: number;              // max crop/pasture plots the player may attach
  worker?: string;
  wcolor?: number;
  hp?: number;                 // max structure HP (combat); defaults to 100
  coastal?: boolean;           // only exists where the map has a sea coast (biome gen)
  military?: MilitaryDef;      // barracks: trainable military units
  trainer?: MilitaryDef;       // guild hall: trainable civilian workers
  tower?: TowerDef;            // watchtowers/keeps: automatic arrow fire
  bulwark?: boolean;           // fortification: razing it never counts as a stronghold
  gate?: boolean;              // its own faction walks through; enemies must break it
  entrance?: 'none' | 'through'; // default front door; through = two-wide on both faces
}

export interface Coord { x: number; y: number; }

export interface Tree {
  growth: number; reserved: boolean; meshes: THREE.Object3D[]; s: number; kind: number;
  /** Old-growth thicket (Black Forest): impassable, unharvestable, unbuildable. */
  dense?: boolean;
}
export type DepositKind = 'stone' | 'gold' | 'coal' | 'iron';
export interface Deposit { kind: DepositKind; amt: number; meshes: THREE.Object3D[]; }
export interface Deco { kind: DecoKind; meshes: THREE.Object3D[]; }
export interface Field { farm: Building; growth: number; meshes: THREE.Object3D[]; }
/** A gold pile on the map; serfs (later the hero) walk over and collect it. */
export interface Pickup { gold: number; reserved: boolean; meshes: THREE.Object3D[]; }

export interface Tile {
  type: 'grass' | 'water' | 'rock';
  road: boolean;
  roadOwner: PlayerId | null;
  lake: boolean;               // part of the big fish-stocked lake (not a pond)
  rock?: 'peak' | 'wall';      // rock tiles: impassable mountain or a ruined wall
  b: Building | null;
  site: Site | null;
  tree: Tree | null;
  dep: Deposit | null;
  field: Field | null;
  deco: Deco | null;
  pickup: Pickup | null;
  cshade: number;
}

export interface Building {
  id: number;
  owner: OwnerId;
  key: BuildingKey;
  def: BuildingDef;
  x: number; y: number; rot: number;
  active: boolean;
  inp: Record<string, number>;
  out: Record<string, number>;
  incoming: Record<string, number>;
  prog: number;
  working: boolean;
  worker: Unit | null;
  fieldsList: Coord[];
  mesh: THREE.Group;
  name: string;
  faction: Faction;
  hp: number;
  maxHp: number;
  stock?: Record<string, number>;
  fedUnits?: Unit[];           // taverns: who was served last cycle (for the inspector)
  trainQ?: string[];           // barracks: queued unit kinds being trained
  rally?: Coord;               // barracks: where freshly trained fighters march to
  rallyMesh?: THREE.Object3D;  // the flag marking the rally point
  priority?: boolean;          // player-flagged: serfs feed & empty this building first
  removed?: boolean;
  marketItem?: ItemKey;
  marketAmount?: number;
  marketTimer?: number;
  isSite?: false;
}

export interface Site {
  id: number;
  owner: PlayerId;
  key: BuildingKey;
  def: BuildingDef;
  x: number; y: number; rot: number;
  needs: Record<string, number>;
  delivered: Record<string, number>;
  incoming: Record<string, number>;
  progress: number;
  ready: boolean;
  builder: Unit | null;
  mesh: THREE.Group;
  frame: THREE.Group;
  isSite: true;
  name: string;
  priority?: boolean;          // player-flagged: get materials & a builder first
  removed?: boolean;
}

export interface Task { from: any; to: any; item: string; phase: 'pickup' | 'deliver'; }

export interface Unit {
  id: number;
  owner: OwnerId;
  role: string;
  roleName: string;
  colorHex: number;
  mesh: THREE.Group;
  itemMesh: THREE.Mesh;
  tx: number; ty: number;
  path: Coord[] | null;
  pathI: number;
  task: Task | null;
  carrying: string | null;
  collect: Coord | null;
  home: Building | null;
  wstate: string;
  timer: number;
  target: any;
  hunger: number;
  bob: number;
  status: string;
  // ---- combat (economy workers use defaults: player faction, dmg 0) ----
  faction: Faction;
  spd: number;          // base walk speed (tiles/s)
  hp: number;
  maxHp: number;
  dmg: number;          // damage per hit (0 = non-combatant)
  range: number;        // attack reach in tiles
  atkCd: number;        // seconds between attacks
  atkTimer: number;     // cooldown remaining
  dead: boolean;        // flagged this tick, swept after the update pass
  raider: boolean;      // enemy that marches on the castle (vs. camp guards that hold)
  foe: Unit | null;     // current combat target (unit)
  foeB: Building | null; // current combat target (building)
  order: UnitOrder | null;
  orderQueue: UnitOrder[]; // shift-chained commands, pulled in as each order completes
  obeyT: number;        // seconds a fresh move order suppresses re-aggro (commands overrule combat)
  special: number;      // boss ability cooldown (dragon fire breath)
  anchor: Coord | null; // wild beasts & camp guards roam around (and leash to) this
  lungeT: number;       // melee swing animation timer (little hop toward the foe)
  hpBar: THREE.Object3D | null;
  sepI: number;         // transient index within the crowd-separation pass (avoids a per-tick Map)
}

/** UI/Controls interaction mode. */
export type Mode =
  | { type: 'build'; key: BuildingKey }
  | { type: 'road' }
  | { type: 'plot'; building: Building }
  | { type: 'demolish' }
  | null;
