// Global tunables for the Erfgooiers economy sim.
export const W = 48;
export const H = 48;
export const TILE_COST_ROAD = 1;    // pathing cost of a road tile (also the A* heuristic weight)
export const TILE_COST_GRASS = 2.6; // open ground costs far more, so units detour onto roads
export const CARRY_CAP = 3;         // max queued per input slot in a producer
export const OUT_CAP = 5;           // max stored output before a worker idles
export const BUILD_TIME = 8;        // seconds of laborer work to raise a building
export const BASE_SPEED = 2.3;      // tiles/second a unit walks (x1.3 on roads)
