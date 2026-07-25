// A small pooled particle system. Purely cosmetic — nothing in here can ever
// influence the simulation, which is why the headless simulator never touches
// it.

const MAX = 900;

const KIND = {
  SPARK: 0,
  DUST: 1,
  RING: 2,
  SHARD: 3,
  STAR: 4,
};

export class Particles {
  constructor() {
    this.pool = new Array(MAX);
    for (let i = 0; i < MAX; i++) {
      this.pool[i] = {
        alive: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 1, size: 1, rot: 0, spin: 0,
        r: 255, g: 255, b: 255, gravity: 1, drag: 1,
      };
    }
    this.cursor = 0;
    this.rand = 12345;
  }

  _rand() {
    this.rand = (this.rand * 1664525 + 1013904223) & 0x7fffffff;
    return (this.rand >>> 8) / 8388608;
  }

  _range(a, b) {
    return a + this._rand() * (b - a);
  }

  _spawn() {
    let slot = null;
    for (let i = 0; i < MAX; i++) {
      const p = this.pool[(this.cursor + i) % MAX];
      if (!p.alive) {
        this.cursor = (this.cursor + i + 1) % MAX;
        slot = p;
        break;
      }
    }
    if (!slot) {
      // Everything is busy: steal the oldest slot rather than drop the effect.
      slot = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % MAX;
    }
    // Reset to defaults. Emitters only set the fields they care about, so a
    // recycled slot would otherwise inherit the last particle's motion — which
    // is how a shockwave ring ends up falling out of frame instead of expanding.
    slot.alive = true;
    slot.vx = 0;
    slot.vy = 0;
    slot.rot = 0;
    slot.spin = 0;
    slot.size = 1;
    slot.gravity = 0;
    slot.drag = 0;
    return slot;
  }

  clear() {
    for (const p of this.pool) p.alive = false;
  }

  // ------------------------------------------------------------------ emitters

  /** The main "that connected" burst. */
  impact(x, y, dir, power = 1, color = [255, 226, 150]) {
    const n = Math.round(10 + power * 16);
    for (let i = 0; i < n; i++) {
      const p = this._spawn();
      const ang = this._range(-1.2, 1.2) + (dir > 0 ? 0 : Math.PI);
      const speed = this._range(90, 420) * (0.6 + power * 0.7);
      p.kind = KIND.SPARK;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed + this._range(20, 180);
      p.life = p.maxLife = this._range(0.18, 0.46);
      p.size = this._range(1.6, 4.2) * (0.7 + power * 0.5);
      p.gravity = 1;
      p.drag = 2.2;
      p.r = color[0];
      p.g = color[1];
      p.b = color[2];
    }

    const ring = this._spawn();
    ring.kind = KIND.RING;
    ring.x = x;
    ring.y = y;
    ring.vx = 0;
    ring.vy = 0;
    ring.life = ring.maxLife = 0.22 + power * 0.1;
    ring.size = 8 + power * 16;
    ring.r = color[0];
    ring.g = color[1];
    ring.b = color[2];
  }

  /** Sparks that scatter off a raised guard. */
  block(x, y, dir) {
    for (let i = 0; i < 12; i++) {
      const p = this._spawn();
      const ang = this._range(-0.9, 0.9) + (dir > 0 ? Math.PI : 0);
      const speed = this._range(120, 340);
      p.kind = KIND.SHARD;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed + this._range(40, 200);
      p.life = p.maxLife = this._range(0.14, 0.32);
      p.size = this._range(2, 5);
      p.rot = this._rand() * 6.28;
      p.spin = this._range(-14, 14);
      p.gravity = 1.1;
      p.drag = 2.6;
      p.r = 190;
      p.g = 214;
      p.b = 255;
    }
  }

  /** The bright, slow burst of a successful parry. */
  parry(x, y) {
    for (let i = 0; i < 22; i++) {
      const p = this._spawn();
      const ang = (i / 22) * Math.PI * 2;
      const speed = this._range(160, 300);
      p.kind = KIND.STAR;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed;
      p.life = p.maxLife = this._range(0.3, 0.6);
      p.size = this._range(2.5, 5);
      p.rot = ang;
      p.spin = this._range(-6, 6);
      p.gravity = 0.15;
      p.drag = 2.8;
      p.r = 255;
      p.g = 248;
      p.b = 210;
    }
    const ring = this._spawn();
    ring.kind = KIND.RING;
    ring.x = x;
    ring.y = y;
    ring.life = ring.maxLife = 0.34;
    ring.size = 34;
    ring.r = 255;
    ring.g = 244;
    ring.b = 190;
  }

  /** Floor dust for landings, dashes and bodies hitting the deck. */
  dust(x, y, dir = 0, amount = 8, power = 1) {
    for (let i = 0; i < amount; i++) {
      const p = this._spawn();
      const ang = dir === 0 ? this._range(0, Math.PI) : this._range(-0.6, 0.6) + (dir > 0 ? 0 : Math.PI);
      const speed = this._range(30, 170) * power;
      p.kind = KIND.DUST;
      p.x = x + this._range(-8, 8);
      p.y = y + this._range(0, 6);
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.abs(Math.sin(ang)) * speed * 0.55 + this._range(10, 50);
      p.life = p.maxLife = this._range(0.35, 0.85);
      p.size = this._range(5, 14) * power;
      p.gravity = 0.12;
      p.drag = 1.5;
      p.r = 150;
      p.g = 152;
      p.b = 168;
    }
  }

  // -------------------------------------------------------------------- update

  update(dt) {
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      p.vy -= 900 * p.gravity * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.kind === KIND.DUST && p.y < 2) {
        p.y = 2;
        p.vy *= -0.1;
        p.vx *= 0.8;
      }
    }
  }

  /** Draw in world space (the camera transform is already applied). */
  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.alive) continue;
      const t = p.life / p.maxLife;
      const a = t * t;

      switch (p.kind) {
        case KIND.RING: {
          const grow = 1 + (1 - t) * 2.4;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${a * 0.8})`;
          ctx.lineWidth = Math.max(0.6, 4 * t);
          ctx.arc(p.x, p.y, p.size * grow, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case KIND.DUST: {
          ctx.globalCompositeOperation = 'source-over';
          ctx.beginPath();
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a * 0.22})`;
          ctx.arc(p.x, p.y, p.size * (1.4 - t * 0.4), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'lighter';
          break;
        }
        case KIND.SHARD: {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.fillRect(-p.size, -p.size * 0.28, p.size * 2, p.size * 0.56);
          ctx.restore();
          break;
        }
        case KIND.STAR: {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          const s = p.size;
          ctx.beginPath();
          ctx.moveTo(-s * 2.4, 0);
          ctx.lineTo(0, s * 0.5);
          ctx.lineTo(s * 2.4, 0);
          ctx.lineTo(0, -s * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        default: {
          // Streaked spark: length follows velocity, which reads as speed.
          const len = Math.min(16, Math.hypot(p.vx, p.vy) * 0.02);
          const nx = p.vx === 0 && p.vy === 0 ? 0 : p.vx / (Math.hypot(p.vx, p.vy) || 1);
          const ny = p.vy === 0 && p.vx === 0 ? 0 : p.vy / (Math.hypot(p.vx, p.vy) || 1);
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.lineWidth = p.size * t;
          ctx.lineCap = 'round';
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - nx * len, p.y - ny * len);
          ctx.stroke();
          break;
        }
      }
    }
    ctx.restore();
  }
}
