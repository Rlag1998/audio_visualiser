// Turns a pose into world-space joint positions.
//
// Arms are forward kinematics (authored segment angles); legs are two-bone IK
// toward authored foot targets. Joint objects are allocated once per skeleton
// and mutated in place — a full match solves this ~10k times, so it stays off
// the allocator.

import { BODY } from './config.js';
import { DEG, clamp } from '../core/math.js';

export const JOINT_NAMES = [
  'hip', 'neck', 'head', 'shoulder',
  'elbowF', 'handF', 'elbowB', 'handB',
  'kneeF', 'footF', 'kneeB', 'footB',
];

/**
 * Two-bone IK. Solves for the mid joint given a root and an end-effector
 * target. `bend` is +1 to push the mid joint toward +x of the root->target
 * axis (knees forward), -1 for the other way.
 * Writes the mid joint into `out` and returns the (possibly clamped) target.
 */
export function solveIK(rx, ry, tx, ty, l1, l2, bend, out, endOut) {
  let dx = tx - rx;
  let dy = ty - ry;
  let d = Math.hypot(dx, dy);

  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.abs(l1 - l2) + 0.001;

  if (d < 1e-6) {
    // Degenerate: target sits on the root. Push it straight down.
    dx = 0;
    dy = -1;
    d = 1;
  }
  const ux = dx / d;
  const uy = dy / d;

  // Clamp the target into the reachable annulus so the limb never breaks.
  const cd = clamp(d, minReach, maxReach);
  const ex = rx + ux * cd;
  const ey = ry + uy * cd;

  const a = (cd * cd + l1 * l1 - l2 * l2) / (2 * cd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // Perpendicular to the root->target axis, rotated +90 degrees.
  const nx = -uy;
  const ny = ux;

  out.x = rx + ux * a + nx * h * bend;
  out.y = ry + uy * a + ny * h * bend;

  if (endOut) {
    endOut.x = ex;
    endOut.y = ey;
  }
  return cd;
}

export class Skeleton {
  constructor() {
    this.joints = {};
    for (const n of JOINT_NAMES) this.joints[n] = { x: 0, y: 0 };
    this.facing = 1;
    this.rootX = 0;
    this.rootY = 0;
  }

  /**
   * @param {object} pose  fully resolved pose (facing space)
   * @param {number} rootX world x of the point between the feet
   * @param {number} rootY world y of that point (0 on the floor, >0 airborne)
   * @param {number} facing +1 looking right, -1 looking left
   */
  solve(pose, rootX, rootY, facing) {
    this.facing = facing;
    this.rootX = rootX;
    this.rootY = rootY;

    const j = this.joints;
    const f = facing;

    // --- torso chain -------------------------------------------------------
    const hipX = rootX + f * pose.hipX;
    const hipY = rootY + pose.hipY;
    j.hip.x = hipX;
    j.hip.y = hipY;

    const ta = pose.torso * DEG;
    const tcx = Math.cos(ta) * f;
    const tcy = Math.sin(ta);
    j.neck.x = hipX + tcx * BODY.torsoLen;
    j.neck.y = hipY + tcy * BODY.torsoLen;
    j.shoulder.x = hipX + tcx * BODY.torsoLen * BODY.neckFrac;
    j.shoulder.y = hipY + tcy * BODY.torsoLen * BODY.neckFrac;

    const ha = pose.head * DEG;
    j.head.x = j.neck.x + Math.cos(ha) * f * BODY.neckToHead;
    j.head.y = j.neck.y + Math.sin(ha) * BODY.neckToHead;

    // --- arms (FK) ---------------------------------------------------------
    this._arm(pose.armFU, pose.armFF, j.shoulder, j.elbowF, j.handF, f);
    this._arm(pose.armBU, pose.armBF, j.shoulder, j.elbowB, j.handB, f);

    // --- legs (IK) ---------------------------------------------------------
    // Knees bend "forward" in facing space, which is +x before mirroring.
    const bend = f;
    solveIK(
      hipX, hipY,
      rootX + f * pose.footFX, rootY + pose.footFY,
      BODY.thigh, BODY.shin, bend, j.kneeF, j.footF,
    );
    solveIK(
      hipX, hipY,
      rootX + f * pose.footBX, rootY + pose.footBY,
      BODY.thigh, BODY.shin, bend, j.kneeB, j.footB,
    );

    return j;
  }

  _arm(upperDeg, foreDeg, shoulder, elbow, hand, f) {
    const ua = upperDeg * DEG;
    elbow.x = shoulder.x + Math.cos(ua) * f * BODY.upperArm;
    elbow.y = shoulder.y + Math.sin(ua) * BODY.upperArm;
    const fa = foreDeg * DEG;
    hand.x = elbow.x + Math.cos(fa) * f * BODY.foreArm;
    hand.y = elbow.y + Math.sin(fa) * BODY.foreArm;
  }

  /** Copy joint positions into a plain object (used to seed the ragdoll). */
  snapshot() {
    const out = {};
    for (const n of JOINT_NAMES) out[n] = { x: this.joints[n].x, y: this.joints[n].y };
    return out;
  }
}

/**
 * Hurt volumes, rebuilt from the current skeleton. Head is a circle, the rest
 * are capsules. Arms are deliberately not hurtboxes so that whiffing past an
 * outstretched guard feels fair.
 */
export function hurtVolumes(joints, out = []) {
  out.length = 0;
  out.push({ kind: 'circle', x: joints.head.x, y: joints.head.y, r: BODY.headR + 2, zone: 'high' });
  out.push({
    kind: 'capsule',
    ax: joints.hip.x, ay: joints.hip.y,
    bx: joints.neck.x, by: joints.neck.y,
    r: 13, zone: 'mid',
  });
  for (const [knee, foot] of [[joints.kneeF, joints.footF], [joints.kneeB, joints.footB]]) {
    out.push({
      kind: 'capsule',
      ax: joints.hip.x, ay: joints.hip.y,
      bx: knee.x, by: knee.y,
      r: 9, zone: 'low',
    });
    out.push({
      kind: 'capsule',
      ax: knee.x, ay: knee.y,
      bx: foot.x, by: foot.y,
      r: 8, zone: 'low',
    });
  }
  return out;
}
