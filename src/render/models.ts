// Compatibility barrel: callers keep the original render/models API while
// implementations live in focused, behavior-neutral model modules.
export {
  bakeGroupInto, box, cachedGeo, capsule, circle, cone, cyl, dodeca,
  noOutline, setActiveBiome, sharpOutline, sphere, stdMat, torus,
  withSeededScatter,
} from './modelCore';
export type { SceneMaterial } from './modelCore';

export {
  makeDeco, makeDeposit, makeFieldCrop, makeMountain, makePickup,
  makeRuinWall, makeTree,
} from './sceneryModels';
export type { CropKind } from './sceneryModels';

export {
  makeArrow, makeCavalry, makeCorpse, makeFireball, makeFlag, makeFlame,
  makeHealGlow, makeHero, makePlotMarker, makeRock, makeSiege, makeTraderCaravan,
  makeUnit, makeUnitCorpse,
} from './unitModels';

export { makeBuilding, makeScaffold } from './buildingModels';

export {
  CRITTER_KINDS, makeCritter, makeFish, makePig, makeSkyBird,
} from './faunaModels';
export type { CritterKind } from './faunaModels';
