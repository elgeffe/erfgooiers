// Deterministic Lehmer RNG shared across worldgen and mesh scatter so a given
// seed always produces the same map. Keep call order stable for reproducibility.
let seed = 1337;

export function rnd(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

export function reseed(s: number): void {
  seed = s;
}
