import type { Building, PlayerId, Site, Unit } from '../types';
import type { World } from '../world/World';
import { buildingFootprintAnchor } from '../engine/buildingFootprint';

/** Tiles a unit reveals around itself. */
const UNIT_SIGHT = 7;
/** Tiles a standing building or construction site reveals. */
const BUILDING_SIGHT = 7;
/** Watchtowers overlook FAR farther — the whole point of building one is the
 *  extended view, so the ring must read clearly beyond ordinary sight. */
const TOWER_SIGHT = 15;

interface VisionPorts {
  now: () => number;
  buildings: () => readonly Building[];
  sites: () => readonly Site[];
  units: () => readonly Unit[];
}

/**
 * Per-player fog-of-war visibility, derived on demand from that player's own
 * units, buildings and sites. This is presentation/information state, NOT sim
 * state: the deterministic simulation never reads it, so replays and gameplay
 * fingerprints are untouched whether fog is on or off. Its two consumers are
 * the renderer (hiding hostile meshes from the local seat) and AI perception
 * (the fairness boundary — a CPU seat sees exactly what its assets see).
 */
/** Per-tile fog level for the renderer's veil. */
export const enum FogLevel {
  /** Never scouted — the darkest veil. */
  Unexplored = 0,
  /** Seen before, out of sight now — a lighter veil (terrain remembered). */
  Explored = 1,
  /** In sight this instant — no veil. */
  Visible = 2,
}

export class VisionSystem {
  private readonly grids = new Map<PlayerId, Uint8Array>();
  /** Sticky "ever seen" memory per owner — never cleared, so scouted ground
   *  stays a light veil instead of snapping back to black. */
  private readonly explored = new Map<PlayerId, Uint8Array>();
  private readonly freshAt = new Map<PlayerId, number>();
  /** Bumped whenever a grid is rebuilt, so the renderer only re-uploads the
   *  fog texture when visibility actually changed. */
  private readonly revisions = new Map<PlayerId, number>();

  constructor(private readonly world: World, private readonly ports: VisionPorts) {}

  /** Whether `owner` currently sees tile (tx, ty). Cached on a 0.5 s clock. */
  visible(owner: PlayerId, tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.world.W || ty >= this.world.H) return false;
    return this.grid(owner)[ty * this.world.W + tx] === 1;
  }

  /** The renderer's three-state veil for tile (tx, ty). */
  fogLevel(owner: PlayerId, tx: number, ty: number): FogLevel {
    if (tx < 0 || ty < 0 || tx >= this.world.W || ty >= this.world.H) return FogLevel.Unexplored;
    const i = ty * this.world.W + tx;
    if (this.grid(owner)[i] === 1) return FogLevel.Visible;
    return (this.explored.get(owner)?.[i] ?? 0) === 1 ? FogLevel.Explored : FogLevel.Unexplored;
  }

  /** Monotonic revision of `owner`'s vision — changes when the grid rebuilds. */
  revision(owner: PlayerId): number {
    this.grid(owner); // ensure the 0.5 s refresh has run
    return this.revisions.get(owner) ?? 0;
  }

  private grid(owner: PlayerId): Uint8Array {
    const now = this.ports.now();
    let grid = this.grids.get(owner);
    const fresh = this.freshAt.get(owner);
    if (grid && fresh !== undefined && now - fresh < 0.5) return grid;
    if (!grid) {
      grid = new Uint8Array(this.world.W * this.world.H);
      this.grids.set(owner, grid);
    }
    let explored = this.explored.get(owner);
    if (!explored) {
      explored = new Uint8Array(this.world.W * this.world.H);
      this.explored.set(owner, explored);
    }
    grid.fill(0);
    for (const unit of this.ports.units()) {
      if (unit.dead || unit.owner !== owner) continue;
      this.stamp(grid, unit.tx, unit.ty, UNIT_SIGHT);
    }
    for (const building of this.ports.buildings()) {
      if (building.removed || building.owner !== owner) continue;
      const center = buildingFootprintAnchor(building);
      this.stamp(grid, center.x, center.y, building.def.tower ? TOWER_SIGHT : BUILDING_SIGHT);
    }
    for (const site of this.ports.sites()) {
      if (site.removed || site.owner !== owner) continue;
      const center = buildingFootprintAnchor(site);
      this.stamp(grid, center.x, center.y, BUILDING_SIGHT);
    }
    for (let i = 0; i < grid.length; i++) if (grid[i]) explored[i] = 1;
    this.freshAt.set(owner, now);
    this.revisions.set(owner, (this.revisions.get(owner) ?? 0) + 1);
    return grid;
  }

  /** Fill a disc of revealed tiles around (cx, cy). */
  private stamp(grid: Uint8Array, cx: number, cy: number, radius: number): void {
    const { W, H } = this.world;
    const r2 = radius * radius;
    const y0 = Math.max(0, cy - radius), y1 = Math.min(H - 1, cy + radius);
    const x0 = Math.max(0, cx - radius), x1 = Math.min(W - 1, cx + radius);
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) grid[y * W + x] = 1;
      }
    }
  }
}
