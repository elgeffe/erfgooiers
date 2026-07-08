import type { Coord } from '../types';

// Front-door tile offset relative to a 2×2 building's top-left, per rotation
// (0 = south, 1 = west, 2 = north, 3 = east). Serfs path to this tile.
const DOOR_OFF = [[-0.5, 1.5], [-1.5, -0.5], [0.5, -1.5], [1.5, 0.5]];

export function doorTile(b: { x: number; y: number; rot?: number }): Coord {
  const o = DOOR_OFF[b.rot || 0];
  return { x: Math.floor(b.x + 1 + o[0]), y: Math.floor(b.y + 1 + o[1]) };
}
