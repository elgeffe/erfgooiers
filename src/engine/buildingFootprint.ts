import type { BuildingDef, Coord } from '../types';

export interface FootprintOwner {
  x: number;
  y: number;
  rot?: number;
  def: BuildingDef;
}

/** Rotated logical footprint dimensions in tiles. */
export function buildingFootprint(def: BuildingDef, rot = 0): { width: number; height: number } {
  const base = def.footprint ?? { width: 2, height: 2 };
  return (rot & 1) === 0
    ? base
    : { width: base.height, height: base.width };
}

/** Centre in tile-coordinate space, where integer coordinates are tile centres. */
export function buildingFootprintCenter(owner: FootprintOwner): Coord {
  const { width, height } = buildingFootprint(owner.def, owner.rot);
  return { x: owner.x + (width - 1) / 2, y: owner.y + (height - 1) / 2 };
}

/** Stable representative tile at the middle of a footprint (south/east on even spans). */
export function buildingFootprintAnchor(owner: FootprintOwner): Coord {
  const { width, height } = buildingFootprint(owner.def, owner.rot);
  return { x: owner.x + Math.floor(width / 2), y: owner.y + Math.floor(height / 2) };
}

/** Every occupied tile, in deterministic row-major order. */
export function buildingFootprintTiles(owner: FootprintOwner): Coord[] {
  const { width, height } = buildingFootprint(owner.def, owner.rot);
  const result: Coord[] = [];
  for (let y = owner.y; y < owner.y + height; y++) {
    for (let x = owner.x; x < owner.x + width; x++) result.push({ x, y });
  }
  return result;
}
