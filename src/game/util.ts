import type { BuildingDef, Coord } from '../types';
import { UNITS, type UnitDef } from '../data/units';
import { buildingFootprint } from '../engine/buildingFootprint';

// Front-door tile offset relative to a 2×2 building's top-left, per rotation
// (0 = south, 1 = west, 2 = north, 3 = east). Serfs path to this tile.
const DOOR_OFF = [[-0.5, 1.5], [-1.5, -0.5], [0.5, -1.5], [1.5, 0.5]];

export function doorTile(b: { x: number; y: number; rot?: number }): Coord {
  const o = DOOR_OFF[b.rot || 0];
  return { x: Math.floor(b.x + 1 + o[0]), y: Math.floor(b.y + 1 + o[1]) };
}

export function buildingEntranceTiles(b: { x: number; y: number; rot?: number; def: BuildingDef }): Coord[] {
  if (b.def.entrance === 'none') return [];
  if (b.def.entrance !== 'through') return [doorTile(b)];
  const { width, height } = buildingFootprint(b.def, b.rot);
  const horizontal = ((b.rot ?? 0) & 1) === 0;
  const result: Coord[] = [];
  if (horizontal) {
    for (let x = b.x; x < b.x + width; x++) result.push({ x, y: b.y - 1 });
    for (let x = b.x; x < b.x + width; x++) result.push({ x, y: b.y + height });
  } else {
    for (let y = b.y; y < b.y + height; y++) result.push({ x: b.x - 1, y });
    for (let y = b.y; y < b.y + height; y++) result.push({ x: b.x + width, y });
  }
  return result;
}

/** Display name for a unit kind ('laborer' is shown as Builder). */
export function unitLabel(kind: string): string {
  if (kind === 'laborer') return 'Builder';
  const def = (UNITS as Record<string, UnitDef | undefined>)[kind];
  if (def) return def.name;
  return kind[0].toUpperCase() + kind.slice(1);
}
