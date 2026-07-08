import type * as THREE from 'three';

export type ItemKey =
  | 'trunk' | 'timber' | 'stone' | 'wheat' | 'flour'
  | 'bread' | 'goldore' | 'coal' | 'coin';

export type BuildingKey =
  | 'storehouse' | 'woodcutter' | 'forester' | 'sawmill' | 'quarry'
  | 'farm' | 'mill' | 'bakery' | 'goldmine' | 'coalmine' | 'mint';

export type NodeKind = 'tree' | 'plant' | 'stone' | 'gold' | 'coal' | 'field';

/** Purely decorative ground scatter (no gameplay effect). */
export type DecoKind = 'lavender' | 'flowers' | 'bush' | 'reed' | 'lily';

/** Which mesh builder in render/models.ts renders a building. */
export type ModelKind = 'cottage' | 'windmill' | 'farm' | 'barn' | 'mine';

export interface ItemDef { name: string; color: string; hex: number; }

export interface GatherDef { node: NodeKind; out: ItemKey | null; time: number; range: number; }
export interface RecipeDef { inp: Partial<Record<ItemKey, number>>; out: ItemKey; time: number; }

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
  fields?: boolean;
  worker?: string;
  wcolor?: number;
}

export interface Coord { x: number; y: number; }

export interface Tree { growth: number; reserved: boolean; meshes: THREE.Object3D[]; s: number; kind: number; }
export interface Deposit { kind: 'stone' | 'gold' | 'coal'; amt: number; meshes: THREE.Object3D[]; }
export interface Deco { kind: DecoKind; meshes: THREE.Object3D[]; }
export interface Field { farm: Building; growth: number; meshes: THREE.Object3D[]; }
/** A gold pile on the map; serfs (later the hero) walk over and collect it. */
export interface Pickup { gold: number; reserved: boolean; meshes: THREE.Object3D[]; }

export interface Tile {
  type: 'grass' | 'water';
  road: boolean;
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
  stock?: Record<string, number>;
  removed?: boolean;
  isSite?: false;
}

export interface Site {
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
  removed?: boolean;
}

export interface Task { from: any; to: any; item: string; phase: 'pickup' | 'deliver'; }

export interface Unit {
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
}

/** UI/Controls interaction mode. */
export type Mode =
  | { type: 'build'; key: BuildingKey }
  | { type: 'road' }
  | { type: 'demolish' }
  | null;
