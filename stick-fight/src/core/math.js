// Small numeric helpers shared by the whole simulation.
// Everything here is pure and DOM-free so it can run under Node for tests.

export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Fraction of the way from `a` to `b`, clamped to [0,1]. Returns 0 if a === b. */
export const invLerp = (a, b, v) => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Shortest signed difference between two angles, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const angleLerp = (a, b, t) => a + angleDelta(a, b) * t;

/** Squared distance — used in the hot hit-detection path to avoid sqrt. */
export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/**
 * Squared distance from point p to the segment ab, plus the closest point.
 * Capsule hit tests are just this compared against (r1 + r2)^2.
 */
export function segPointDist2(ax, ay, bx, by, px, py) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 1e-9) t = clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return dist2(px, py, cx, cy);
}

/** Round to a fixed number of decimals — keeps reported stats tidy. */
export const round2 = (v, places = 2) => {
  const m = 10 ** places;
  return Math.round(v * m) / m;
};
