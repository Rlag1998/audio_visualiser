// Canvas renderer: backdrop, fighters, impact effects.
//
// The renderer is a pure consumer of simulation state. It never writes back to
// a Fighter or a Match, which is why the exact same match can be run with no
// renderer attached at all.

import { ARENA, BODY, STATS } from '../game/config.js';
import { STATE } from '../game/fighter.js';
import { Camera } from './camera.js';
import { Particles } from './particles.js';
import { makeRng } from '../core/rng.js';
import { clamp } from '../core/math.js';

const SEGMENTS_BACK = [
  ['hip', 'kneeB', 9.5],
  ['kneeB', 'footB', 7.5],
];
const SEGMENTS_BACK_ARM = [
  ['shoulder', 'elbowB', 7.5],
  ['elbowB', 'handB', 6.5],
];
const SEGMENTS_FRONT_LEG = [
  ['hip', 'kneeF', 10.5],
  ['kneeF', 'footF', 8.5],
];
const SEGMENTS_FRONT_ARM = [
  ['shoulder', 'elbowF', 8.5],
  ['elbowF', 'handF', 7.5],
];

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const shade = (hex, amount) => {
  const [r, g, b] = hexToRgb(hex);
  const f = (v) => Math.round(clamp(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount, 0, 255));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = new Camera();
    this.particles = new Particles();
    this.fx = new Map(); // per-fighter cosmetic state, keyed by uid
    this.flashScreen = 0;
    this.time = 0;
    this.showDebug = false;
    this.reducedFx = false;
    this._buildBackdrop(1);
    this.resize();
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width || this.canvas.clientWidth || 960));
    const h = Math.max(200, Math.round(rect.height || this.canvas.clientHeight || 540));
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.cssWidth = w;
    this.cssHeight = h;
    this.camera.resize(w, h);
  }

  /** Procedural skyline, generated once from a fixed seed so it never flickers. */
  _buildBackdrop(seed) {
    const rng = makeRng(seed);
    const layer = (count, spread, minH, maxH) => {
      const out = [];
      let x = -spread;
      while (x < spread) {
        const w = rng.range(40, 120);
        out.push({
          x,
          w,
          h: rng.range(minH, maxH),
          lit: rng.chance(0.55),
          windows: Math.floor(rng.range(2, 6)),
        });
        x += w + rng.range(8, 46);
      }
      return out.slice(0, count * 4);
    };
    this.layers = [
      { depth: 0.12, y: 40, color: '#131a2b', items: layer(40, 1600, 120, 340) },
      { depth: 0.26, y: 18, color: '#0e1422', items: layer(40, 1400, 80, 240) },
      { depth: 0.45, y: 0, color: '#0a0f1a', items: layer(40, 1200, 50, 150) },
    ];
    this.stars = [];
    for (let i = 0; i < 90; i++) {
      this.stars.push({
        x: rng.range(-1400, 1400),
        y: rng.range(140, 520),
        r: rng.range(0.5, 1.7),
        tw: rng.range(0, 6.28),
      });
    }
  }

  _state(f) {
    let s = this.fx.get(f.uid);
    if (!s) {
      s = { trail: [], flash: 0, afterimages: [] };
      this.fx.set(f.uid, s);
    }
    return s;
  }

  /** Turn simulation events into sparks, shake and flashes. */
  handleEvents(events) {
    for (const ev of events) {
      if (ev.type === 'contact') {
        const power = clamp(ev.damage / 22, 0.25, 1.6);
        const heavy = ev.move.knockdown || ev.move.guardBreak;
        switch (ev.result) {
          case 'block':
          case 'guardBreak':
            this.particles.block(ev.x, ev.y, ev.dir);
            this.camera.addShake(3 + power * 3);
            break;
          case 'parry':
            this.particles.parry(ev.x, ev.y);
            this.camera.addShake(7);
            this.flashScreen = Math.max(this.flashScreen, 0.35);
            break;
          default: {
            const color = ev.counter ? [255, 170, 140] : [255, 228, 160];
            this.particles.impact(ev.x, ev.y, ev.dir, power, color);
            this.camera.addShake(5 + power * (heavy ? 16 : 8));
            this._state(ev.defender).flash = 1;
            if (heavy || ev.result === 'ko') {
              this.flashScreen = Math.max(this.flashScreen, ev.result === 'ko' ? 0.6 : 0.3);
            }
            break;
          }
        }
      } else if (!ev.fighter) {
        // Match-level notices (round transitions, the clock) carry no fighter.
        continue;
      } else if (ev.type === 'land') {
        this.particles.dust(ev.fighter.x, 0, 0, 7, 0.9);
      } else if (ev.type === 'dash') {
        this.particles.dust(ev.fighter.x, 0, -ev.fighter.facing, 10, 1.1);
      } else if (ev.type === 'knockdown' || ev.type === 'ko') {
        this.particles.dust(ev.fighter.x, 0, 0, 16, 1.5);
        this.camera.addShake(ev.type === 'ko' ? 20 : 12);
      }
    }
  }

  draw(match, dt) {
    const ctx = this.ctx;
    this.time += dt;

    const [a, b] = match.fighters;
    this.camera.track(a, b, dt);
    this.particles.update(dt);
    this.flashScreen = Math.max(0, this.flashScreen - dt * 2.6);

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    this._drawSky(ctx);

    ctx.save();
    this.camera.apply(ctx);

    this._drawFloor(ctx);

    for (const f of match.fighters) this._drawShadow(ctx, f);
    for (const f of match.fighters) this._drawReflection(ctx, f, dt);
    for (const f of match.fighters) this._drawFighter(ctx, f, dt);

    this.particles.draw(ctx);
    if (this.showDebug) this._drawDebug(ctx, match);

    ctx.restore();

    this._drawForeground(ctx);
    ctx.restore();
  }

  // ---------------------------------------------------------------- backdrop

  _drawSky(ctx) {
    const w = this.cssWidth;
    const h = this.cssHeight;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#070a14');
    g.addColorStop(0.45, '#111a2e');
    g.addColorStop(0.78, '#2a2440');
    g.addColorStop(1, '#3a2b3d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const cam = this.camera;

    // Stars
    ctx.save();
    for (const s of this.stars) {
      const x = w / 2 + (s.x - cam.x * 0.04) * 0.5;
      if (x < -10 || x > w + 10) continue;
      const y = cam.groundY - s.y * 0.75;
      if (y < -10 || y > h) continue;
      const tw = 0.55 + 0.45 * Math.sin(this.time * 1.6 + s.tw);
      ctx.fillStyle = `rgba(214,226,255,${0.55 * tw})`;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Moon
    const mx = w / 2 + (240 - cam.x * 0.05) * 0.6;
    const my = cam.groundY - 330;
    const mg = ctx.createRadialGradient(mx, my, 6, mx, my, 96);
    mg.addColorStop(0, 'rgba(255,246,222,0.95)');
    mg.addColorStop(0.22, 'rgba(255,238,200,0.35)');
    mg.addColorStop(1, 'rgba(255,238,200,0)');
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.arc(mx, my, 96, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fdf3dc';
    ctx.beginPath();
    ctx.arc(mx, my, 26, 0, Math.PI * 2);
    ctx.fill();

    // Parallax skyline
    for (const layer of this.layers) {
      ctx.fillStyle = layer.color;
      const baseY = cam.groundY - layer.y * 0.5;
      for (const b of layer.items) {
        const x = w / 2 + (b.x - cam.x * layer.depth) * 0.85;
        if (x + b.w < -20 || x > w + 20) continue;
        ctx.fillRect(x, baseY - b.h, b.w, b.h + 40);
        if (b.lit && layer.depth > 0.2) {
          ctx.fillStyle = 'rgba(255,214,140,0.10)';
          for (let i = 0; i < b.windows; i++) {
            const wy = baseY - b.h + 14 + i * 18;
            if (wy > baseY - 6) break;
            ctx.fillRect(x + 8, wy, b.w - 16, 6);
          }
          ctx.fillStyle = layer.color;
        }
      }
    }
  }

  _drawFloor(ctx) {
    const half = ARENA.halfWidth;

    // The mat.
    const g = ctx.createLinearGradient(0, 0, 0, -260);
    g.addColorStop(0, 'rgba(28,32,48,1)');
    g.addColorStop(1, 'rgba(10,12,20,1)');
    ctx.fillStyle = g;
    ctx.fillRect(-2600, -400, 5200, 400);

    // Perspective lines running away from the camera.
    ctx.strokeStyle = 'rgba(120,150,220,0.10)';
    ctx.lineWidth = 1.5;
    for (let i = -12; i <= 12; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 80, 0);
      ctx.lineTo(i * 240, -320);
      ctx.stroke();
    }
    for (let i = 1; i <= 5; i++) {
      const y = -i * i * 12;
      ctx.beginPath();
      ctx.globalAlpha = 1 - i / 6;
      ctx.moveTo(-2600, y);
      ctx.lineTo(2600, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The fighting surface line and the ring boundary.
    ctx.strokeStyle = 'rgba(150,190,255,0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-half - 400, 0);
    ctx.lineTo(half + 400, 0);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,120,140,0.35)';
    ctx.lineWidth = 3;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * half, 0);
      ctx.lineTo(s * half, 150);
      ctx.stroke();
    }
  }

  _drawForeground(ctx) {
    const w = this.cssWidth;
    const h = this.cssHeight;
    if (this.flashScreen > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flashScreen * 0.5})`;
      ctx.fillRect(0, 0, w, h);
    }
    const v = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.25, w / 2, h * 0.55, h * 0.95);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }

  // ---------------------------------------------------------------- fighters

  _drawShadow(ctx, f) {
    const lift = clamp(1 - f.y / 260, 0.25, 1);
    const w = 34 * lift;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.42 * lift})`;
    ctx.beginPath();
    ctx.ellipse(f.ragdoll.active ? f.ragdoll.points.hip.x : f.x, 1, w, 6 * lift, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawReflection(ctx, f, dt) {
    if (this.reducedFx) return;
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.scale(1, -0.42);
    this._drawBody(ctx, f, true);
    ctx.restore();
  }

  _drawFighter(ctx, f, dt) {
    const s = this._state(f);
    s.flash = Math.max(0, s.flash - dt * 5);

    this._updateTrail(f, s, dt);
    this._drawTrail(ctx, f, s);
    this._drawBody(ctx, f, false);

    // Meter-full aura.
    if (f.meter >= STATS.maxMeter && !f.isDown) {
      const j = f.drawJoints;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.35 + 0.25 * Math.sin(this.time * 7);
      ctx.strokeStyle = `rgba(255,210,120,${pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(j.hip.x, j.hip.y - 4, 30, 62, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  _updateTrail(f, s, dt) {
    if (f.moveActive && f.move) {
      const j = f.skeleton.joints[f.move.hitJoint];
      s.trail.push({ x: j.x, y: j.y, life: 0.22 });
    }
    for (let i = s.trail.length - 1; i >= 0; i--) {
      s.trail[i].life -= dt;
      if (s.trail[i].life <= 0) s.trail.splice(i, 1);
    }
    if (s.trail.length > 24) s.trail.splice(0, s.trail.length - 24);
  }

  _drawTrail(ctx, f, s) {
    if (s.trail.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < s.trail.length; i++) {
      const p0 = s.trail[i - 1];
      const p1 = s.trail[i];
      const t = i / s.trail.length;
      ctx.strokeStyle = f.palette.trail;
      ctx.globalAlpha = t * 0.7 * (p1.life / 0.22);
      ctx.lineWidth = 2 + t * 9;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBody(ctx, f, flat) {
    const j = f.drawJoints;
    const s = this._state(f);
    const ko = f.state === STATE.KO;

    const body = ko ? shade(f.palette.body, -0.45) : f.palette.body;
    const back = shade(f.palette.body, -0.42);
    const flash = s.flash;

    const stroke = (segs, color, widthMul = 1) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [an, bn, w] of segs) {
        const p = j[an];
        const q = j[bn];
        // Dark outline first, then the coloured core on top.
        ctx.strokeStyle = 'rgba(6,8,14,0.92)';
        ctx.lineWidth = w * widthMul + 4;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.lineWidth = w * widthMul;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    };

    ctx.save();
    if (flash > 0 && !flat) {
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 18 * flash;
    }

    stroke(SEGMENTS_BACK, back);
    stroke(SEGMENTS_BACK_ARM, back);
    stroke([['hip', 'shoulder', 13], ['shoulder', 'neck', 10]], body);

    // Head
    ctx.strokeStyle = 'rgba(6,8,14,0.92)';
    ctx.lineWidth = 4;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(j.head.x, j.head.y, BODY.headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    stroke(SEGMENTS_FRONT_LEG, body);
    stroke(SEGMENTS_FRONT_ARM, body);

    // Hands and feet caps.
    ctx.fillStyle = shade(f.palette.body, 0.2);
    for (const n of ['handF', 'footF']) {
      ctx.beginPath();
      ctx.arc(j[n].x, j[n].y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Facing tell: a small brow on the leading side of the head.
    if (!ko && !flat) {
      const fx = f.ragdoll.active ? 1 : f.facing;
      ctx.strokeStyle = 'rgba(8,10,18,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(j.head.x, j.head.y, BODY.headR - 1.5, fx > 0 ? -0.9 : Math.PI + 0.9, fx > 0 ? 0.35 : Math.PI - 0.35, fx < 0);
      ctx.stroke();
    }

    // Hit flash overlay.
    if (flash > 0 && !flat) {
      ctx.globalAlpha = flash * 0.75;
      ctx.globalCompositeOperation = 'lighter';
      stroke([...SEGMENTS_BACK, ...SEGMENTS_BACK_ARM, ...SEGMENTS_FRONT_LEG, ...SEGMENTS_FRONT_ARM,
        ['hip', 'shoulder', 13], ['shoulder', 'neck', 10]], 'rgba(255,255,255,0.85)', 0.6);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.arc(j.head.x, j.head.y, BODY.headR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Guard sheen.
    if ((f.state === STATE.BLOCK || f.state === STATE.BLOCKSTUN) && !flat) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(150,200,255,${f.state === STATE.BLOCKSTUN ? 0.75 : 0.35})`;
      ctx.lineWidth = 3;
      const cx = j.hip.x + f.facing * 20;
      const cy = j.hip.y + (f.blockCrouch ? 6 : 22);
      ctx.beginPath();
      ctx.arc(cx, cy, 34, f.facing > 0 ? -1.1 : Math.PI + 1.1, f.facing > 0 ? 1.1 : Math.PI - 1.1, f.facing < 0);
      ctx.stroke();
      ctx.restore();
    }

    // Stun stars.
    if (f.state === STATE.STUN && !flat) {
      ctx.save();
      ctx.fillStyle = '#ffe07a';
      for (let i = 0; i < 3; i++) {
        const ang = this.time * 5 + (i / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(j.head.x + Math.cos(ang) * 20, j.head.y + 16 + Math.sin(ang) * 5, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _drawDebug(ctx, match) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const f of match.fighters) {
      ctx.strokeStyle = 'rgba(80,255,140,0.6)';
      for (const v of f.volumes) {
        ctx.beginPath();
        if (v.kind === 'circle') ctx.arc(v.x, v.y, v.r, 0, Math.PI * 2);
        else {
          ctx.moveTo(v.ax, v.ay);
          ctx.lineTo(v.bx, v.by);
        }
        ctx.stroke();
      }
      if (f.moveActive && f.move) {
        const j = f.skeleton.joints[f.move.hitJoint];
        ctx.strokeStyle = 'rgba(255,80,80,0.9)';
        ctx.beginPath();
        ctx.arc(j.x, j.y, f.move.hitR, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
