// The moveset, expressed as fighting-game frame data.
//
// Every attack is startup -> active -> recovery, measured in 60Hz frames.
//
// Crucially the *animation* is derived from that frame data rather than hand
// timed alongside it. Each move declares four shapes — start, windup, strike,
// end — and buildTrack places them so the limb reaches full extension just
// before the hitbox switches on and holds it until the hitbox switches off.
// Authoring the two independently is how you end up with a hitbox that is live
// while the leg is still tucked, which makes the reach table a lie and the AI
// throw attacks that cannot connect.
//
// Design intent, so the numbers can be re-tuned coherently:
//   * jab      - the poke. Safe on block, tiny damage, starts everything.
//   * cross    - the workhorse. Longest punch.
//   * hook     - close-range commitment. Big damage, punishable if it whiffs.
//   * uppercut - the launcher. Beats jump-ins, shortest reach, awful on block.
//   * lowKick  - must be blocked crouching. Chips guard.
//   * highKick - the head-hunter. Long, very punishable.
//   * sweep    - knocks down. Low, slow, longest normal.
//   * heavy    - meter spender. Guard-breaks, knocks down.
//
// Foot targets are solved with two-bone IK, so a strike pose must keep the foot
// within the leg's reach of the hip or it silently gets clamped short. Run
// `node src/sim/reach.mjs` after touching anything here — `npm test` asserts
// that MOVE_REACH still matches what the skeleton actually does.

import { resolvePose, STANCE } from './pose.js';

const P = (partial) => resolvePose(partial, STANCE);

/**
 * Place the four shapes on a normalised timeline from the move's own frames.
 * The strike lands slightly ahead of the first active frame so the pose blend
 * has converged by the time the hitbox exists.
 */
function buildTrack(startup, active, recovery, shapes) {
  const total = startup + active + recovery;
  const tWind = Math.max(0.02, (startup * 0.5) / total);
  const tStrike = Math.max(tWind + 0.012, (startup - 1.5) / total);
  const tEnd = Math.min(0.97, (startup + active) / total);

  return [
    { t: 0, pose: shapes.start },
    { t: tWind, pose: shapes.windup },
    { t: tStrike, pose: shapes.strike },
    { t: Math.max(tStrike + 0.008, tEnd), pose: shapes.strike },
    { t: 1, pose: shapes.end ?? shapes.start },
  ];
}

const move = (def) => ({
  ...def,
  track: buildTrack(def.startup, def.active, def.recovery, def.shapes),
});

/**
 * @typedef {object} Move
 * @property {string} id
 * @property {string} name
 * @property {number} startup   frames before the hitbox exists
 * @property {number} active    frames the hitbox is live
 * @property {number} recovery  frames after the hitbox before neutral
 * @property {number} damage
 * @property {'high'|'mid'|'low'} height   which guard stops it
 * @property {string} hitJoint
 * @property {number} hitR      hitbox radius around that joint
 * @property {number} kbX       horizontal knockback impulse
 * @property {number} kbY       vertical knockback impulse
 * @property {number} hitstun   frames the victim is stunned for
 * @property {number} blockstun frames the blocker is stuck for
 * @property {number} stamina   stamina cost
 * @property {number} guard     guard damage on block
 */

/** @type {Record<string, Move>} */
export const MOVES = {
  jab: move({
    id: 'jab',
    name: 'Jab',
    startup: 4, active: 3, recovery: 9,
    damage: 6, height: 'high', hitJoint: 'handF', hitR: 12,
    kbX: 105, kbY: 0, hitstun: 13, blockstun: 9,
    stamina: 5, guard: 6,
    shapes: {
      start: P({ hipX: 1, armFU: -46, armFF: 20 }),
      windup: P({ hipX: 0, armFU: -54, armFF: 32 }),
      strike: P({ hipX: 9, torso: 77, armFU: -4, armFF: -1, footFX: 25 }),
      end: P({ hipX: 2, armFU: -52, armFF: 28 }),
    },
  }),

  cross: move({
    id: 'cross',
    name: 'Cross',
    startup: 7, active: 4, recovery: 15,
    damage: 12, height: 'high', hitJoint: 'handB', hitR: 13,
    kbX: 185, kbY: 0, hitstun: 17, blockstun: 11,
    stamina: 10, guard: 11,
    shapes: {
      start: P({ torso: 92, armBU: -78, armBF: 58 }),
      windup: P({ hipX: -3, torso: 95, armBU: -86, armBF: 44 }),
      strike: P({ hipX: 9, torso: 74, armBU: 0, armBF: 2, armFU: -76, armFF: -20, footFX: 26, footBX: -18 }),
      end: P({ hipX: 2, torso: 86 }),
    },
  }),

  hook: move({
    id: 'hook',
    name: 'Hook',
    startup: 11, active: 4, recovery: 19,
    damage: 17, height: 'high', hitJoint: 'handF', hitR: 14,
    kbX: 235, kbY: 60, hitstun: 22, blockstun: 12,
    stamina: 15, guard: 15,
    shapes: {
      start: P({ torso: 90, armFU: -70, armFF: 60 }),
      windup: P({ hipX: -7, torso: 97, armFU: -98, armFF: 98, footBX: -27 }),
      // Elbow high and the forearm folded in — a hook is short, not a reach.
      strike: P({ hipX: 8, torso: 74, armFU: 26, armFF: -44, armBU: -60, armBF: 10, footFX: 27 }),
      end: P({ hipX: 1, torso: 88 }),
    },
  }),

  uppercut: move({
    id: 'uppercut',
    name: 'Uppercut',
    startup: 9, active: 4, recovery: 23,
    damage: 15, height: 'mid', hitJoint: 'handB', hitR: 14,
    kbX: 120, kbY: 470, hitstun: 26, blockstun: 14,
    stamina: 16, guard: 14, launcher: true,
    shapes: {
      start: P({ hipY: 48, torso: 78, armBU: -96, armBF: -70 }),
      windup: P({ hipY: 38, torso: 70, armBU: -106, armBF: -88, footFX: 24 }),
      // Drives up and only a little forward — the shortest attack in the game.
      strike: P({ hipY: 66, hipX: 12, torso: 96, armBU: 18, armBF: 60, armFU: -70, armFF: -20, footFX: 20, footBX: -18 }),
      end: P({ hipY: 56, torso: 86 }),
    },
  }),

  lowKick: move({
    id: 'lowKick',
    name: 'Low Kick',
    startup: 8, active: 4, recovery: 15,
    damage: 10, height: 'low', hitJoint: 'footF', hitR: 13,
    kbX: 135, kbY: 0, hitstun: 16, blockstun: 10,
    stamina: 9, guard: 12,
    shapes: {
      start: P({ hipY: 56, footFX: 24, footFY: 6 }),
      windup: P({ hipY: 54, torso: 92, footFX: 14, footFY: 26, armFU: -70, armFF: -6 }),
      strike: P({
        hipY: 52, torso: 100, hipX: 8, footFX: 68, footFY: 22,
        armFU: -80, armFF: -24, armBU: -98, armBF: -62, footBX: -24,
      }),
      end: P({ hipY: 57, footFX: 22 }),
    },
  }),

  highKick: move({
    id: 'highKick',
    name: 'High Kick',
    startup: 13, active: 5, recovery: 23,
    damage: 19, height: 'high', hitJoint: 'footF', hitR: 14,
    kbX: 290, kbY: 110, hitstun: 25, blockstun: 13,
    stamina: 18, guard: 17,
    shapes: {
      start: P({ hipY: 56, torso: 86 }),
      windup: P({ hipY: 52, torso: 96, footFX: 8, footFY: 34, armFU: -84, armFF: -30 }),
      strike: P({
        hipY: 56, torso: 106, hipX: 16, footFX: 71, footFY: 94,
        armFU: -94, armFF: -48, armBU: -102, armBF: -72, footBX: -20,
      }),
      end: P({ hipY: 56, torso: 88 }),
    },
  }),

  sweep: move({
    id: 'sweep',
    name: 'Sweep',
    startup: 10, active: 5, recovery: 22,
    damage: 9, height: 'low', hitJoint: 'footF', hitR: 14,
    kbX: 165, kbY: 130, hitstun: 20, blockstun: 12,
    stamina: 14, guard: 13, knockdown: true,
    shapes: {
      start: P({ hipY: 48, torso: 78 }),
      windup: P({ hipY: 32, torso: 66, footFX: 16, armFU: -96, armFF: -74, armBU: -100, armBF: -80 }),
      strike: P({
        hipY: 30, torso: 60, hipX: 6, footFX: 69, footFY: 8,
        armFU: -102, armFF: -88, armBU: -106, armBF: -90, footBX: -22,
      }),
      end: P({ hipY: 52, torso: 80 }),
    },
  }),

  heavy: move({
    id: 'heavy',
    name: 'Finisher',
    startup: 16, active: 6, recovery: 26,
    damage: 30, height: 'mid', hitJoint: 'footF', hitR: 17,
    kbX: 430, kbY: 260, hitstun: 34, blockstun: 20,
    stamina: 22, guard: 100, knockdown: true, guardBreak: true, meterCost: 100,
    shapes: {
      start: P({ hipY: 54, torso: 84 }),
      windup: P({ hipY: 40, torso: 98, hipX: -10, footFX: 6, footFY: 10, armFU: -100, armFF: -80, armBU: -104, armBF: -84 }),
      strike: P({
        hipY: 54, torso: 96, hipX: 10, footFX: 72, footFY: 78,
        armFU: -92, armFF: -42, armBU: -98, armBF: -60, footBX: -22,
      }),
      end: P({ hipY: 56, torso: 86 }),
    },
  }),

  airKick: move({
    id: 'airKick',
    name: 'Air Kick',
    startup: 6, active: 8, recovery: 10,
    damage: 13, height: 'high', hitJoint: 'footF', hitR: 14,
    kbX: 175, kbY: 0, hitstun: 18, blockstun: 11,
    stamina: 11, guard: 12, airOnly: true,
    shapes: {
      start: P({ hipY: 56, torso: 84, footFX: 20, footFY: 20 }),
      windup: P({ hipY: 56, torso: 80, footFX: 30, footFY: 30, armFU: -60, armFF: -10 }),
      strike: P({
        hipY: 56, torso: 74, hipX: 6, footFX: 64, footFY: 32,
        armFU: -62, armFF: -12, armBU: -82, armBF: -32, footBX: -22, footBY: 32,
      }),
      end: P({ hipY: 56, torso: 82, footFX: 26, footFY: 22 }),
    },
  }),
};

export const MOVE_IDS = Object.keys(MOVES);

/** Ground normals the AI and input layer can pick from. */
export const GROUND_MOVES = ['jab', 'cross', 'hook', 'uppercut', 'lowKick', 'highKick', 'sweep'];

export const totalFrames = (m) => m.startup + m.active + m.recovery;

/**
 * How far each move's hitbox actually reaches, from the fighter's root, with
 * the hitbox radius included. The AI plans with these numbers, so they are
 * measured from the skeleton rather than guessed — see src/sim/reach.mjs, and
 * the test that keeps them honest.
 */
export const MOVE_REACH = {
  jab: 79,
  cross: 82,
  hook: 73,
  uppercut: 59,
  lowKick: 81,
  highKick: 85,
  sweep: 83,
  heavy: 89,
  airKick: 78,
};

/**
 * Sample a move's pose track at normalised time t. Keys are sorted by
 * construction, so a linear scan is both correct and fast enough.
 */
export function sampleTrack(move, t, out) {
  const track = move.track;
  if (t <= track[0].t) return copyInto(track[0].pose, out);
  const last = track[track.length - 1];
  if (t >= last.t) return copyInto(last.pose, out);

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const k = span <= 1e-9 ? 0 : (t - a.t) / span;
      const p = out || {};
      for (const key in a.pose) p[key] = a.pose[key] + (b.pose[key] - a.pose[key]) * k;
      return p;
    }
  }
  return copyInto(last.pose, out);
}

function copyInto(pose, out) {
  if (!out) return { ...pose };
  for (const key in pose) out[key] = pose[key];
  return out;
}
