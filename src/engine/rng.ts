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

// Browsers do not expose the CPU RDRAND instruction. Web Crypto is the correct
// browser entropy surface: implementations seed it from the operating system,
// which may itself mix hardware entropy. Keep a tiny xorshift fallback for old
// or restricted contexts where crypto.getRandomValues is unavailable.
let fallbackState = ((Date.now() ^ 0x9e3779b9) >>> 0) || 0x6d2b79f5;
function fallbackWord(): number {
  fallbackState ^= fallbackState << 13;
  fallbackState ^= fallbackState >>> 17;
  fallbackState ^= fallbackState << 5;
  return fallbackState >>> 0;
}

/** Unpredictable seed for a new run, always in the Lehmer-safe range. */
export function randomSeed(): number {
  let word: number;
  try {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') throw new Error('Web Crypto unavailable');
    const words = new Uint32Array(1);
    cryptoApi.getRandomValues(words);
    word = words[0];
  } catch {
    word = fallbackWord();
  }
  return (word % 2147483646) + 1;
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
