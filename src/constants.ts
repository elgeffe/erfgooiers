// Global tunables for the Erfgooiers economy sim.
export const W = 48;
export const H = 48;
export const TILE_COST_ROAD = 1;    // pathing cost of a road tile (also the A* heuristic weight)
export const TILE_COST_GRASS = 2.6; // open ground costs far more, so units detour onto roads
export const CARRY_CAP = 3;         // max queued per input slot in a producer
export const OUT_CAP = 5;           // max stored output before a worker idles
export const BUILD_TIME = 8;        // seconds of laborer work to raise a building
export const BASE_SPEED = 2.3;      // tiles/second a unit walks (x1.3 on roads)
export const ROAD_STONE_COST = 1;   // stone consumed from the storehouse per road tile
export const PLOT_RANGE = 6;        // how far (tiles) a plot may sit from its farm/vineyard/pig farm
export const MAX_UNITS = 11000;     // hard simulation cap; command transport must support the same selection size

// Rendering look & performance — see docs/graphics-upgrade-plan.md.
export const GRAPHICS = {
  toon: true,               // cel-shaded MeshToonMaterial everywhere; off = the old flat Lambert look
  toonBands: 3,             // how many flat light bands the toon shading quantizes into
  outlines: false,          // ink edges via OutlineEffect — off: expanded backfaces read soft/mushy, the clean cel look works better bare
  outlineThickness: 0.0022, // screen-space edge width (NDC; constant at any zoom with the ortho camera)
  outlineColor: 0x241c14,   // warm ink — softer than pure black
  outlineAlpha: 0.85,
};
