import type { Building, PlayerId, Site, Unit } from '../types';
import type { World } from '../world/World';

/** Tiles a unit reveals around itself. */
const UNIT_SIGHT = 7;
/** Tiles a standing building or construction site reveals. */
const BUILDING_SIGHT = 7;
/** Watchtowers overlook farther — the scouting anchor of a fortified line. */
const TOWER_SIGHT = 12;

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
export class VisionSystem {
  private readonly grids = new Map<PlayerId, Uint8Array>();
  private readonly freshAt = new Map<PlayerId, number>();

  constructor(private readonly world: World, private readonly ports: VisionPorts) {}

  /** Whether `owner` currently sees tile (tx, ty). Cached on a 0.5 s clock. */
  visible(owner: PlayerId, tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.world.W || ty >= this.world.H) return false;
    return this.grid(owner)[ty * this.world.W + tx] === 1;
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
    grid.fill(0);
    for (const unit of this.ports.units()) {
      if (unit.dead || unit.owner !== owner) continue;
      this.stamp(grid, unit.tx, unit.ty, UNIT_SIGHT);
    }
    for (const building of this.ports.buildings()) {
      if (building.removed || building.owner !== owner) continue;
      this.stamp(grid, building.x + 1, building.y + 1, building.def.tower ? TOWER_SIGHT : BUILDING_SIGHT);
    }
    for (const site of this.ports.sites()) {
      if (site.removed || site.owner !== owner) continue;
      this.stamp(grid, site.x + 1, site.y + 1, BUILDING_SIGHT);
    }
    this.freshAt.set(owner, now);
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
