// Deterministic RNG. Every decision the simulation makes draws from one of
// these, so a given seed always replays the exact same fight — which is what
// makes the headless batch simulator meaningful.

/** mulberry32 — small, fast, good enough distribution for game logic. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  if (a === 0) a = 0x9e3779b9;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    /** Float in [lo, hi). */
    range: (lo, hi) => lo + next() * (hi - lo),
    /** Integer in [lo, hi]. */
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    /** True with probability p. */
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    /** Weighted pick. `weights[i]` corresponds to `arr[i]`; negatives are treated as 0. */
    weighted(arr, weights) {
      let total = 0;
      for (let i = 0; i < arr.length; i++) total += Math.max(0, weights[i] || 0);
      if (total <= 0) return arr[Math.floor(next() * arr.length) % arr.length];
      let r = next() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= Math.max(0, weights[i] || 0);
        if (r <= 0) return arr[i];
      }
      return arr[arr.length - 1];
    },
    /** Current internal state — lets callers snapshot/restore a run. */
    get state() {
      return a;
    },
    set state(v) {
      a = v >>> 0;
    },
  };
}

/** Non-deterministic seed for "just give me a random fight" cases. */
export const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;
