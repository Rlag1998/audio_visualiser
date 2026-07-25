// A pose is a flat bag of numbers describing the skeleton in *facing space*
// (+x is whichever way the fighter is looking). Arms are authored as absolute
// segment angles in degrees; legs are authored as foot targets and solved with
// two-bone IK, which makes stances and kicks far easier to hand-tune than
// chains of joint angles.

export const POSE_KEYS = [
  'hipX', // hip offset forward/back from the root (the point between the feet)
  'hipY', // hip height above the floor
  'torso', // torso segment angle: 90 = straight up, <90 leans forward
  'head', // head segment angle
  'armFU', // front arm, shoulder -> elbow
  'armFF', // front arm, elbow -> hand
  'armBU', // back arm, shoulder -> elbow
  'armBF', // back arm, elbow -> hand
  'footFX', // front foot target, forward of root
  'footFY', // front foot target, above floor
  'footBX',
  'footBY',
];

const N = POSE_KEYS.length;

export function makePose(values = {}) {
  const p = {};
  for (const k of POSE_KEYS) p[k] = values[k] ?? 0;
  return p;
}

/** Fill any missing keys from `base` (usually the neutral stance). */
export function resolvePose(partial, base) {
  const p = {};
  for (const k of POSE_KEYS) p[k] = partial[k] ?? base[k];
  return p;
}

/** Linear blend of two fully-resolved poses. Writes into `out` if provided. */
export function blendPose(a, b, t, out) {
  const p = out || {};
  for (let i = 0; i < N; i++) {
    const k = POSE_KEYS[i];
    p[k] = a[k] + (b[k] - a[k]) * t;
  }
  return p;
}

export function copyPose(src, out) {
  const p = out || {};
  for (let i = 0; i < N; i++) p[POSE_KEYS[i]] = src[POSE_KEYS[i]];
  return p;
}

/** Neutral fighting stance — every other pose is authored as a delta from this. */
export const STANCE = makePose({
  hipX: 0,
  hipY: 58,
  torso: 84,
  head: 94,
  armFU: -58,
  armFF: 34,
  armBU: -74,
  armBF: 46,
  footFX: 21,
  footFY: 0,
  footBX: -22,
  footBY: 0,
});

/** Named non-attack poses. Anything omitted falls back to STANCE. */
export const POSES = {
  idle: resolvePose({}, STANCE),

  walkFwd: resolvePose({ hipX: 4, torso: 82 }, STANCE),
  walkBack: resolvePose({ hipX: -4, torso: 88 }, STANCE),

  crouch: resolvePose({
    hipY: 34,
    torso: 74,
    head: 86,
    armFU: -46,
    armFF: 22,
    armBU: -66,
    armBF: 34,
    footFX: 24,
    footBX: -24,
  }, STANCE),

  block: resolvePose({
    hipX: -3,
    hipY: 55,
    torso: 92,
    head: 96,
    armFU: -34,
    armFF: 62,
    armBU: -48,
    armBF: 74,
    footFX: 17,
    footBX: -25,
  }, STANCE),

  crouchBlock: resolvePose({
    hipY: 33,
    torso: 82,
    head: 90,
    armFU: -28,
    armFF: 58,
    armBU: -42,
    armBF: 70,
    footFX: 22,
    footBX: -24,
  }, STANCE),

  jump: resolvePose({
    hipY: 56,
    torso: 88,
    armFU: 34,
    armFF: 78,
    armBU: 18,
    armBF: 66,
    footFX: 20,
    footFY: 30,
    footBX: -12,
    footBY: 16,
  }, STANCE),

  fall: resolvePose({
    hipY: 57,
    torso: 80,
    armFU: 8,
    armFF: 58,
    armBU: -10,
    armBF: 44,
    footFX: 26,
    footFY: 16,
    footBX: -20,
    footBY: 26,
  }, STANCE),

  land: resolvePose({
    hipY: 40,
    torso: 76,
    armFU: -30,
    armFF: 10,
    armBU: -52,
    armBF: 18,
    footFX: 26,
    footBX: -26,
  }, STANCE),

  dash: resolvePose({
    hipX: 8,
    hipY: 50,
    torso: 66,
    head: 78,
    armFU: -84,
    armFF: -30,
    armBU: -20,
    armBF: 40,
    footFX: 32,
    footFY: 12,
    footBX: -30,
    footBY: 6,
  }, STANCE),

  hurtHigh: resolvePose({
    hipX: -6,
    hipY: 55,
    torso: 104,
    head: 122,
    armFU: -6,
    armFF: 48,
    armBU: -24,
    armBF: 70,
    footFX: 14,
    footBX: -30,
  }, STANCE),

  hurtLow: resolvePose({
    hipX: -4,
    hipY: 46,
    torso: 66,
    head: 62,
    armFU: -78,
    armFF: -34,
    armBU: -86,
    armBF: -20,
    footFX: 12,
    footBX: -28,
  }, STANCE),

  stunned: resolvePose({
    hipX: -2,
    hipY: 52,
    torso: 98,
    head: 112,
    armFU: -96,
    armFF: -66,
    armBU: -88,
    armBF: -54,
    footFX: 26,
    footBX: -26,
  }, STANCE),

  exhausted: resolvePose({
    hipY: 50,
    torso: 70,
    head: 78,
    armFU: -86,
    armFF: -58,
    armBU: -92,
    armBF: -64,
    footFX: 24,
    footBX: -26,
  }, STANCE),

  victory: resolvePose({
    hipY: 59,
    torso: 92,
    head: 96,
    armFU: 64,
    armFF: 96,
    armBU: 58,
    armBF: 92,
    footFX: 18,
    footBX: -20,
  }, STANCE),
};
