// Deterministic Lehmer RNG, split into named streams so a cosmetic call in one
// system can never reshape another system's output. A run seed + level index
// must fully determine that level's map (see `levelSeed`), which only holds if
// worldgen pulls exclusively from `worldRng` and nothing else touches it.
//
// Reproducibility rule: any new rnd() call site in worldgen must use `worldRng`;
// gameplay uses `simRng`; purely visual scatter (mesh offsets, clouds, road
// variants) uses `uiRng`. Keep call order within a stream stable.
export class Rng {
  private s = 1337;

  constructor(seed = 1337) { this.reseed(seed); }

  /** Reseed the stream. Any positive integer works; 0 is nudged to a safe value. */
  reseed(seed: number): void {
    this.s = (seed >>> 0) % 2147483647;
    if (this.s <= 0) this.s += 2147483646;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.s = (this.s * 16807) % 2147483647;
    return (this.s - 1) / 2147483646;
  }

  /** Integer in [0, n). */
  int(n: number): number { return Math.floor(this.next() * n); }

  /** Float in [a, b). */
  range(a: number, b: number): number { return a + this.next() * (b - a); }
}

// map generation only — reseeded to `levelSeed` at the start of every level
export const worldRng = new Rng();
// gameplay events (growth jitter, hunger, planting) — reseeded per level
export const simRng = new Rng();
// purely cosmetic scatter — reseeded per level so a map looks identical on replay
export const uiRng = new Rng();

/** A run seed + level index → the deterministic seed for that level's map. */
export function levelSeed(runSeed: number, levelIndex: number): number {
  // xmur3-style mix so adjacent levels land on wildly different maps
  let h = (runSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (levelIndex + 1), 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h = (h ^ (h >>> 16)) >>> 0;
  return (h % 2147483646) + 1;
}
