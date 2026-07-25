// Verlet ragdoll used for knockdowns and KOs.
//
// The ragdoll is seeded straight from the animated skeleton's joint positions,
// so the transition from "animated fighter" to "sack of limbs" is seamless.
// Bones are hard distance constraints; a few loose extra constraints stop the
// body folding completely in on itself.

import { ARENA, BODY, PHYS } from './config.js';
import { clamp } from '../core/math.js';
import { JOINT_NAMES } from './skeleton.js';

const ITERATIONS = 8;

/** Bone list: [a, b, stiffness]. Rest lengths come from the seed pose. */
const LINKS = [
  ['hip', 'shoulder', 1],
  ['shoulder', 'neck', 1],
  ['neck', 'head', 1],
  ['shoulder', 'elbowF', 1],
  ['elbowF', 'handF', 1],
  ['shoulder', 'elbowB', 1],
  ['elbowB', 'handB', 1],
  ['hip', 'kneeF', 1],
  ['kneeF', 'footF', 1],
  ['hip', 'kneeB', 1],
  ['kneeB', 'footB', 1],
  // Shape keepers — weak, they just stop the ragdoll collapsing to a point.
  ['hip', 'head', 0.28],
  ['hip', 'handF', 0.06],
  ['hip', 'handB', 0.06],
  ['shoulder', 'kneeF', 0.12],
  ['shoulder', 'kneeB', 0.12],
  ['kneeF', 'kneeB', 0.05],
  ['head', 'handF', 0.03],
  ['head', 'handB', 0.03],
];

const MASS = {
  hip: 3.0, shoulder: 2.4, neck: 1.4, head: 1.6,
  elbowF: 0.7, handF: 0.5, elbowB: 0.7, handB: 0.5,
  kneeF: 1.1, footF: 0.8, kneeB: 1.1, footB: 0.8,
};

export class Ragdoll {
  constructor() {
    this.points = {};
    for (const n of JOINT_NAMES) {
      this.points[n] = { x: 0, y: 0, px: 0, py: 0, m: MASS[n] ?? 1, grounded: false };
    }
    this.links = LINKS.map(([a, b, k]) => ({ a, b, k, len: 0 }));
    this.active = false;
    this.frames = 0;
    this.settled = false;
  }

  /**
   * @param {object} joints  world-space joints from Skeleton
   * @param {number} vx      body velocity to inherit
   * @param {number} vy
   * @param {number} spin    extra angular kick, positive = clockwise-ish
   * @param {number} dt
   */
  seed(joints, vx, vy, spin, dt) {
    const hip = joints.hip;
    for (const n of JOINT_NAMES) {
      const p = this.points[n];
      const j = joints[n];
      p.x = j.x;
      p.y = j.y;
      // Encode velocity as a previous position (verlet). Points further from
      // the hip get more of the spin, which reads as tumbling.
      const rx = j.x - hip.x;
      const ry = j.y - hip.y;
      const svx = vx + -ry * spin;
      const svy = vy + rx * spin;
      p.px = j.x - svx * dt;
      p.py = j.y - svy * dt;
      p.grounded = false;
    }
    for (const l of this.links) {
      const a = joints[l.a];
      const b = joints[l.b];
      l.len = Math.hypot(b.x - a.x, b.y - a.y);
    }
    this.active = true;
    this.frames = 0;
    this.settled = false;
  }

  step(dt) {
    if (!this.active) return;
    this.frames++;

    const g = PHYS.gravity;

    for (const n of JOINT_NAMES) {
      const p = this.points[n];
      const vx = (p.x - p.px) * 0.995;
      const vy = (p.y - p.py) * 0.995;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g * dt * dt;
    }

    for (let i = 0; i < ITERATIONS; i++) {
      this._constrain();
      this._collide();
    }

    // Settle test measures *net* movement across the whole frame, after the
    // constraints have had their say. Measuring raw velocity instead would
    // never settle: gravity re-injects some every frame and the floor eats it.
    let motion = 0;
    for (const n of JOINT_NAMES) {
      const p = this.points[n];
      motion += Math.abs(p.x - p.px) + Math.abs(p.y - p.py);
    }
    this.settled = motion < 0.6 && this.frames > 24;
  }

  _constrain() {
    for (const l of this.links) {
      const a = this.points[l.a];
      const b = this.points[l.b];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      const diff = (d - l.len) / d;
      const wA = 1 / a.m;
      const wB = 1 / b.m;
      const wSum = wA + wB;
      const scale = l.k * diff / wSum;
      dx *= scale;
      dy *= scale;
      a.x += dx * wA;
      a.y += dy * wA;
      b.x -= dx * wB;
      b.y -= dy * wB;
    }
  }

  _collide() {
    const limit = ARENA.halfWidth - 8;
    for (const n of JOINT_NAMES) {
      const p = this.points[n];
      const r = n === 'head' ? BODY.headR : 3;

      if (p.y < r) {
        const vy = p.y - p.py;
        p.y = r;
        // Friction: kill most of the horizontal slide on contact.
        const vx = p.x - p.px;
        p.px = p.x - vx * 0.42;
        // Bounce only if it actually hit hard; otherwise stick, so the pile
        // comes to rest instead of buzzing against the floor forever.
        p.py = vy < -1.2 ? p.y + vy * 0.25 : p.y;
        p.grounded = true;
      } else {
        p.grounded = false;
      }

      if (p.x < -limit) {
        p.x = -limit;
        p.px = p.x + (p.px - p.x) * 0.4;
      } else if (p.x > limit) {
        p.x = limit;
        p.px = p.x + (p.px - p.x) * 0.4;
      }
    }
  }

  /** Where the body ended up, for standing the fighter back up. */
  get hipX() {
    return clamp(this.points.hip.x, -ARENA.halfWidth + ARENA.wallMargin, ARENA.halfWidth - ARENA.wallMargin);
  }

  /** Joint-shaped view so the renderer can draw a ragdoll exactly like a skeleton. */
  get joints() {
    return this.points;
  }

  stop() {
    this.active = false;
  }
}
