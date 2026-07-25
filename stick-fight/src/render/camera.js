// World -> screen transform, plus the two things that sell an impact:
// a camera that breathes with the action and a shake that decays fast.

import { ARENA } from '../game/config.js';
import { clamp, damp } from '../core/math.js';

export class Camera {
  constructor() {
    this.x = 0;
    this.zoom = 1;
    this.targetX = 0;
    this.targetZoom = 1;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.rot = 0;
    this.width = 960;
    this.height = 540;
    this.groundFrac = 0.84;
    this.seed = 1;
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
  }

  /** Frame the two fighters: centred between them, zoomed to fit the gap. */
  track(a, b, dt) {
    const mid = (a.x + b.x) / 2;
    const gap = Math.abs(a.x - b.x);
    const height = Math.max(a.y, b.y);

    // Frame the pair with a comfortable margin, then pull back as they split.
    const fit = this.width / (gap + 360);
    this.targetZoom = clamp(Math.min(fit, this.width / 540), 0.8, 2.1);
    this.targetX = mid;
    this.targetYLift = clamp(height * 0.35, 0, 90);

    // Do not let the camera show the void beyond the arena.
    const halfView = this.width / 2 / this.targetZoom;
    const limit = Math.max(0, ARENA.halfWidth + 40 - halfView);
    this.targetX = clamp(this.targetX, -limit, limit);

    const k = damp(6, dt);
    this.x += (this.targetX - this.x) * k;
    this.zoom += (this.targetZoom - this.zoom) * damp(3.5, dt);
    this.lift = (this.lift ?? 0) + ((this.targetYLift ?? 0) - (this.lift ?? 0)) * damp(4, dt);

    if (this.shake > 0.01) {
      // Deterministic-ish pseudo noise; no need for a real RNG here.
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      const n1 = ((this.seed >> 8) % 1000) / 500 - 1;
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      const n2 = ((this.seed >> 8) % 1000) / 500 - 1;
      this.shakeX = n1 * this.shake;
      this.shakeY = n2 * this.shake * 0.7;
      this.rot = n1 * this.shake * 0.0009;
      this.shake *= Math.exp(-9 * dt);
    } else {
      this.shake = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      this.rot = 0;
    }
  }

  addShake(amount) {
    this.shake = Math.min(38, this.shake + amount);
  }

  get groundY() {
    return this.height * this.groundFrac;
  }

  /** Apply the camera to a 2D context. Call inside save()/restore(). */
  apply(ctx) {
    ctx.translate(this.width / 2 + this.shakeX, this.groundY + this.shakeY + (this.lift ?? 0));
    if (this.rot) ctx.rotate(this.rot);
    ctx.scale(this.zoom, -this.zoom); // flip y so world +y is up
    ctx.translate(-this.x, 0);
  }

  /** World point -> screen point (for HUD elements pinned to fighters). */
  toScreen(wx, wy) {
    return {
      x: this.width / 2 + this.shakeX + (wx - this.x) * this.zoom,
      y: this.groundY + this.shakeY + (this.lift ?? 0) - wy * this.zoom,
    };
  }
}
