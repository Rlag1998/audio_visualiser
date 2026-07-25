// The moveset, expressed as fighting-game frame data.
//
// Every attack is startup -> active -> recovery, measured in 60Hz frames. The
// pose track is keyed on normalised time across the whole move, so a move that
// gets sped up by an archetype keeps its shape. `hitJoint` names the skeleton
// joint that carries the hitbox while the move is active.
//
// Design intent, so the numbers can be re-tuned coherently:
//   * jab      - the poke. Safe on block, tiny damage, starts everything.
//   * cross    - the workhorse. Slightly negative on block.
//   * hook     - commitment. Big damage, punishable if it whiffs.
//   * uppercut - the launcher. Beats jump-ins, awful on block.
//   * lowKick  - must be blocked crouching. Chips guard.
//   * highKick - the head-hunter. Longest normal, very punishable.
//   * sweep    - knocks down. Low, slow, huge reward.
//   * heavy    - meter spender. Guard-breaks, knocks down, wall-splats.

import { resolvePose, STANCE } from './pose.js';

const P = (partial) => resolvePose(partial, STANCE);

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
 * @property {boolean} [knockdown]
 * @property {boolean} [launcher]
 * @property {boolean} [guardBreak]
 * @property {number} [meterCost]
 * @property {Array<{t:number,pose:object}>} track
 */

/** @type {Record<string, Move>} */
export const MOVES = {
  jab: {
    id: 'jab',
    name: 'Jab',
    startup: 4, active: 3, recovery: 9,
    damage: 6, height: 'high', hitJoint: 'handF', hitR: 12,
    kbX: 105, kbY: 0, hitstun: 13, blockstun: 9,
    stamina: 5, guard: 6,
    track: [
      { t: 0, pose: P({ hipX: 1, armFU: -46, armFF: 20 }) },
      { t: 0.25, pose: P({ hipX: 8, torso: 78, armFU: -6, armFF: -2, footFX: 24 }) },
      { t: 0.44, pose: P({ hipX: 9, torso: 77, armFU: -4, armFF: -1, footFX: 25 }) },
      { t: 1, pose: P({ hipX: 2, armFU: -52, armFF: 28 }) },
    ],
  },

  cross: {
    id: 'cross',
    name: 'Cross',
    startup: 7, active: 4, recovery: 15,
    damage: 12, height: 'high', hitJoint: 'handB', hitR: 13,
    kbX: 185, kbY: 0, hitstun: 17, blockstun: 11,
    stamina: 10, guard: 11,
    track: [
      { t: 0, pose: P({ torso: 92, armBU: -78, armBF: 58 }) },
      { t: 0.22, pose: P({ hipX: -2, torso: 94, armBU: -84, armBF: 40 }) },
      { t: 0.36, pose: P({ hipX: 13, torso: 74, armBU: -2, armBF: 2, armFU: -74, armFF: -18, footFX: 27, footBX: -18 }) },
      { t: 0.5, pose: P({ hipX: 14, torso: 73, armBU: 0, armBF: 2, armFU: -76, armFF: -20, footFX: 28, footBX: -18 }) },
      { t: 1, pose: P({ hipX: 2, torso: 86 }) },
    ],
  },

  hook: {
    id: 'hook',
    name: 'Hook',
    startup: 11, active: 4, recovery: 19,
    damage: 17, height: 'high', hitJoint: 'handF', hitR: 14,
    kbX: 235, kbY: 60, hitstun: 22, blockstun: 12,
    stamina: 15, guard: 15,
    track: [
      { t: 0, pose: P({ torso: 90, armFU: -70, armFF: 60 }) },
      { t: 0.3, pose: P({ hipX: -6, torso: 96, armFU: -96, armFF: 96, footBX: -26 }) },
      { t: 0.46, pose: P({ hipX: 10, torso: 76, armFU: -14, armFF: 44, footFX: 26 }) },
      { t: 0.56, pose: P({ hipX: 13, torso: 72, armFU: 4, armFF: 4, footFX: 28 }) },
      { t: 1, pose: P({ hipX: 1, torso: 88 }) },
    ],
  },

  uppercut: {
    id: 'uppercut',
    name: 'Uppercut',
    startup: 9, active: 4, recovery: 23,
    damage: 15, height: 'mid', hitJoint: 'handB', hitR: 14,
    kbX: 120, kbY: 470, hitstun: 26, blockstun: 14,
    stamina: 16, guard: 14, launcher: true,
    track: [
      { t: 0, pose: P({ hipY: 46, torso: 78, armBU: -96, armBF: -70 }) },
      { t: 0.26, pose: P({ hipY: 38, torso: 70, armBU: -104, armBF: -86, footFX: 24 }) },
      { t: 0.42, pose: P({ hipY: 64, hipX: 8, torso: 96, armBU: 62, armBF: 88, footFX: 20, footBX: -18 }) },
      { t: 0.52, pose: P({ hipY: 66, hipX: 9, torso: 98, armBU: 70, armBF: 92, footFX: 19, footBX: -18 }) },
      { t: 1, pose: P({ hipY: 56, torso: 86 }) },
    ],
  },

  lowKick: {
    id: 'lowKick',
    name: 'Low Kick',
    startup: 8, active: 4, recovery: 15,
    damage: 10, height: 'low', hitJoint: 'footF', hitR: 13,
    kbX: 135, kbY: 0, hitstun: 16, blockstun: 10,
    stamina: 9, guard: 12,
    track: [
      { t: 0, pose: P({ hipY: 56, footFX: 24, footFY: 6 }) },
      { t: 0.3, pose: P({ hipY: 54, torso: 92, footFX: 14, footFY: 26, armFU: -70, armFF: -6 }) },
      { t: 0.44, pose: P({ hipY: 52, torso: 98, hipX: -4, footFX: 62, footFY: 16, armFU: -78, armFF: -22, armBU: -96, armBF: -60 }) },
      { t: 0.56, pose: P({ hipY: 52, torso: 99, hipX: -4, footFX: 64, footFY: 15, armFU: -80, armFF: -24, armBU: -98, armBF: -62 }) },
      { t: 1, pose: P({ hipY: 57, footFX: 22 }) },
    ],
  },

  highKick: {
    id: 'highKick',
    name: 'High Kick',
    startup: 13, active: 5, recovery: 23,
    damage: 19, height: 'high', hitJoint: 'footF', hitR: 14,
    kbX: 290, kbY: 110, hitstun: 25, blockstun: 13,
    stamina: 18, guard: 17,
    track: [
      { t: 0, pose: P({ hipY: 56, torso: 86 }) },
      { t: 0.26, pose: P({ hipY: 52, torso: 96, footFX: 8, footFY: 34, armFU: -84, armFF: -30 }) },
      { t: 0.44, pose: P({ hipY: 54, torso: 104, hipX: -6, footFX: 50, footFY: 92, armFU: -92, armFF: -46, armBU: -100, armBF: -70, footBX: -18 }) },
      { t: 0.58, pose: P({ hipY: 54, torso: 106, hipX: -6, footFX: 54, footFY: 96, armFU: -94, armFF: -48, armBU: -102, armBF: -72, footBX: -18 }) },
      { t: 1, pose: P({ hipY: 56, torso: 88 }) },
    ],
  },

  sweep: {
    id: 'sweep',
    name: 'Sweep',
    startup: 10, active: 5, recovery: 22,
    damage: 9, height: 'low', hitJoint: 'footF', hitR: 14,
    kbX: 165, kbY: 130, hitstun: 20, blockstun: 12,
    stamina: 14, guard: 13, knockdown: true,
    track: [
      { t: 0, pose: P({ hipY: 48, torso: 78 }) },
      { t: 0.28, pose: P({ hipY: 30, torso: 66, footFX: 16, armFU: -96, armFF: -74, armBU: -100, armBF: -80 }) },
      { t: 0.44, pose: P({ hipY: 28, torso: 62, hipX: -8, footFX: 66, footFY: 4, armFU: -100, armFF: -86, armBU: -104, armBF: -88 }) },
      { t: 0.6, pose: P({ hipY: 28, torso: 60, hipX: -8, footFX: 68, footFY: 3, armFU: -102, armFF: -88, armBU: -106, armBF: -90 }) },
      { t: 1, pose: P({ hipY: 52, torso: 80 }) },
    ],
  },

  heavy: {
    id: 'heavy',
    name: 'Finisher',
    startup: 16, active: 6, recovery: 26,
    damage: 30, height: 'mid', hitJoint: 'footF', hitR: 17,
    kbX: 430, kbY: 260, hitstun: 34, blockstun: 20,
    stamina: 22, guard: 100, knockdown: true, guardBreak: true, meterCost: 100,
    track: [
      { t: 0, pose: P({ hipY: 54, torso: 84 }) },
      { t: 0.22, pose: P({ hipY: 40, torso: 98, hipX: -10, footFX: 6, footFY: 10, armFU: -100, armFF: -80, armBU: -104, armBF: -84 }) },
      { t: 0.42, pose: P({ hipY: 62, torso: 76, hipX: 6, footFX: 30, footFY: 70, armFU: 40, armFF: 86, armBU: 20, armBF: 70 }) },
      { t: 0.54, pose: P({ hipY: 60, torso: 92, hipX: -4, footFX: 62, footFY: 74, armFU: -90, armFF: -40, armBU: -96, armBF: -58 }) },
      { t: 0.66, pose: P({ hipY: 58, torso: 94, hipX: -4, footFX: 66, footFY: 70, armFU: -92, armFF: -42, armBU: -98, armBF: -60 }) },
      { t: 1, pose: P({ hipY: 56, torso: 86 }) },
    ],
  },

  airKick: {
    id: 'airKick',
    name: 'Air Kick',
    startup: 6, active: 8, recovery: 10,
    damage: 13, height: 'high', hitJoint: 'footF', hitR: 14,
    kbX: 175, kbY: 0, hitstun: 18, blockstun: 11,
    stamina: 11, guard: 12, airOnly: true,
    track: [
      { t: 0, pose: P({ hipY: 56, torso: 84, footFX: 20, footFY: 20 }) },
      { t: 0.3, pose: P({ hipY: 56, torso: 76, footFX: 54, footFY: 34, armFU: -60, armFF: -10, armBU: -80, armBF: -30, footBX: -20, footBY: 30 }) },
      { t: 0.7, pose: P({ hipY: 56, torso: 74, footFX: 58, footFY: 30, armFU: -62, armFF: -12, armBU: -82, armBF: -32, footBX: -22, footBY: 32 }) },
      { t: 1, pose: P({ hipY: 56, torso: 82, footFX: 26, footFY: 22 }) },
    ],
  },
};

export const MOVE_IDS = Object.keys(MOVES);

/** Ground normals the AI and input layer can pick from. */
export const GROUND_MOVES = ['jab', 'cross', 'hook', 'uppercut', 'lowKick', 'highKick', 'sweep'];

export const totalFrames = (m) => m.startup + m.active + m.recovery;

/** Rough reach of a move, measured from the fighter's root, in world units. */
export const MOVE_REACH = {
  jab: 66,
  cross: 74,
  hook: 62,
  uppercut: 52,
  lowKick: 78,
  highKick: 86,
  sweep: 82,
  heavy: 88,
  airKick: 74,
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
