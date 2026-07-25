// Screen-space HUD: health, stamina, super meter, round pips, clock, combo
// counters and the announcer. Drawn after the camera transform is popped, so
// everything here is in CSS pixels.

import { PHASE } from '../game/match.js';
import { STATS } from '../game/config.js';
import { clamp, damp } from '../core/math.js';

const FONT = '"Segoe UI", Roboto, system-ui, sans-serif';

export class Hud {
  constructor() {
    this.ghost = [100, 100];
    this.shownHealth = [100, 100];
    this.combo = [{ n: 0, life: 0, dmg: 0 }, { n: 0, life: 0, dmg: 0 }];
    this.announceScale = 0;
  }

  reset() {
    this.ghost = [100, 100];
    this.shownHealth = [100, 100];
    for (const c of this.combo) {
      c.n = 0;
      c.life = 0;
      c.dmg = 0;
    }
  }

  draw(ctx, match, view, dt) {
    const W = view.width;
    const H = view.height;

    for (let i = 0; i < 2; i++) {
      const f = match.fighters[i];
      this.shownHealth[i] += (f.health - this.shownHealth[i]) * damp(26, dt);
      if (this.ghost[i] > f.health) this.ghost[i] -= Math.max(6, (this.ghost[i] - f.health) * 2.2) * dt;
      else this.ghost[i] = f.health;

      // Combo popups follow the fighter taking the beating.
      const attacker = match.fighters[1 - i];
      if (attacker.combo >= 2) {
        const c = this.combo[i];
        c.n = attacker.combo;
        c.dmg = attacker.comboDamage;
        c.life = 1.1;
      }
      const c = this.combo[i];
      if (c.life > 0) c.life -= dt;
    }

    ctx.save();
    ctx.textBaseline = 'middle';

    this._drawBars(ctx, match, W, H, 0);
    this._drawBars(ctx, match, W, H, 1);
    this._drawClock(ctx, match, W);
    this._drawCombos(ctx, match, view);
    this._drawAnnounce(ctx, match, W, H, dt);

    ctx.restore();
  }

  _drawBars(ctx, match, W, H, side) {
    const f = match.fighters[side];
    const margin = Math.max(14, W * 0.022);
    const barW = Math.min(430, W / 2 - margin - 58);
    const barH = Math.max(16, Math.min(22, H * 0.036));
    const x = side === 0 ? margin : W - margin - barW;
    const y = margin + 18;
    const dir = side === 0 ? -1 : 1; // which end recedes

    const track = (yy, hh) => {
      ctx.fillStyle = 'rgba(6,9,18,0.72)';
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      roundRect(ctx, x - 2, yy - 2, barW + 4, hh + 4, 4);
      ctx.fill();
      ctx.stroke();
    };

    const fill = (yy, hh, frac, style) => {
      const w = Math.max(0, barW * clamp(frac, 0, 1));
      const fx = dir === -1 ? x : x + barW - w;
      ctx.fillStyle = style;
      roundRect(ctx, fx, yy, w, hh, 3);
      ctx.fill();
    };

    // Health, with the classic trailing "damage taken" ghost.
    track(y, barH);
    fill(y, barH, this.ghost[side] / STATS.maxHealth, 'rgba(255,86,86,0.85)');

    const hp = this.shownHealth[side] / STATS.maxHealth;
    const g = ctx.createLinearGradient(x, y, x + barW, y);
    if (hp > 0.45) {
      g.addColorStop(0, '#7dff9a');
      g.addColorStop(1, '#22c55e');
    } else if (hp > 0.2) {
      g.addColorStop(0, '#ffe066');
      g.addColorStop(1, '#f59e0b');
    } else {
      g.addColorStop(0, '#ff9b7a');
      g.addColorStop(1, '#ef4444');
    }
    fill(y, barH, hp, g);

    // Stamina.
    const sy = y + barH + 5;
    track(sy, 6);
    fill(sy, 6, f.stamina / STATS.maxStamina, f.exhausted ? '#ff7b7b' : 'rgba(120,200,255,0.9)');

    // Super meter — glows when it is ready to spend.
    const my = sy + 11;
    track(my, 6);
    const ready = f.meter >= STATS.maxMeter;
    if (ready) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,208,102,0.9)';
      ctx.shadowBlur = 12;
      fill(my, 6, 1, '#ffd166');
      ctx.restore();
    } else {
      fill(my, 6, f.meter / STATS.maxMeter, 'rgba(255,209,102,0.75)');
    }

    // Name, archetype and round pips.
    ctx.font = `600 ${Math.max(12, barH * 0.72)}px ${FONT}`;
    ctx.fillStyle = f.palette.body;
    ctx.textAlign = side === 0 ? 'left' : 'right';
    const nameX = side === 0 ? x : x + barW;
    ctx.fillText(f.name.toUpperCase(), nameX, y - 14);

    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = 'rgba(220,230,255,0.55)';
    ctx.fillText(f.arch.name, nameX + (side === 0 ? 0 : 0), my + 18);

    // Pips. Training runs with an absurd win limit, so cap what we draw.
    const pipR = 5;
    const pips = Math.min(match.winsNeeded, 5);
    for (let i = 0; i < pips; i++) {
      const px = side === 0 ? x + barW - i * 16 : x + i * 16;
      ctx.beginPath();
      ctx.arc(px, my + 18, pipR, 0, Math.PI * 2);
      ctx.fillStyle = i < f.wins ? '#ffd166' : 'rgba(255,255,255,0.16)';
      ctx.fill();
    }

    if (ready) {
      ctx.font = `700 10px ${FONT}`;
      ctx.fillStyle = '#ffd166';
      ctx.textAlign = side === 0 ? 'left' : 'right';
      ctx.fillText('FINISHER READY', nameX, my + 34);
    }
  }

  _drawClock(ctx, match, W) {
    const t = Math.ceil(match.timeLeft);
    // Training mode runs on an effectively infinite clock — show that instead
    // of a meaningless three-digit countdown.
    const untimed = match.roundTime > 300;
    const cx = W / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `800 ${!untimed && t <= 10 ? 42 : 36}px ${FONT}`;
    ctx.fillStyle = !untimed && t <= 10 ? '#ff6b6b' : '#eef3ff';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 10;
    ctx.fillText(untimed ? '∞' : String(t), cx, 42);
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = 'rgba(220,230,255,0.6)';
    ctx.fillText(untimed ? 'TRAINING' : `ROUND ${match.round}`, cx, 68);
    ctx.restore();
  }

  _drawCombos(ctx, match, view) {
    // The K.O. card owns the screen — never stack a combo popup under it.
    if (match.announce && (match.announce.tone === 'ko' || match.announce.tone === 'win')) return;
    for (let i = 0; i < 2; i++) {
      const c = this.combo[i];
      if (c.life <= 0 || c.n < 2) continue;
      const f = match.fighters[i];
      const p = view.camera.toScreen(f.x, 170);
      const t = clamp(c.life / 1.1, 0, 1);
      const pop = 1 + (1 - t) * 0.12 + Math.max(0, t - 0.85) * 2.2;

      ctx.save();
      ctx.translate(p.x, p.y - (1 - t) * 24);
      ctx.scale(pop, pop);
      ctx.textAlign = 'center';
      ctx.globalAlpha = clamp(t * 2, 0, 1);
      ctx.font = `900 30px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 4;
      ctx.strokeText(`${c.n}`, 0, 0);
      ctx.fillText(`${c.n}`, 0, 0);
      ctx.font = `800 13px ${FONT}`;
      ctx.fillStyle = '#ffd166';
      ctx.strokeText('HIT COMBO', 0, 18);
      ctx.fillText('HIT COMBO', 0, 18);
      ctx.font = `700 11px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(`${Math.round(c.dmg)} dmg`, 0, 33);
      ctx.restore();
    }
  }

  _drawAnnounce(ctx, match, W, H, dt) {
    const a = match.announce;
    if (!a) {
      this.announceScale += (0 - this.announceScale) * damp(14, dt);
      return;
    }
    const t = 1 - a.frames / a.total;
    const pop = clamp(t * 6, 0, 1) * (1 + Math.max(0, 0.25 - t) * 1.6);
    const fade = a.frames < 18 ? a.frames / 18 : 1;

    const colors = {
      normal: '#eef3ff',
      go: '#8affc1',
      ko: '#ff5f6d',
      time: '#ffd166',
      win: '#ffd166',
    };

    ctx.save();
    ctx.translate(W / 2, H * 0.36);
    ctx.scale(pop, pop);
    ctx.globalAlpha = fade;
    ctx.textAlign = 'center';
    ctx.font = `900 ${a.tone === 'ko' ? 84 : 54}px ${FONT}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(a.text, 0, 0);
    ctx.fillStyle = colors[a.tone] ?? colors.normal;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = a.tone === 'ko' ? 26 : 12;
    ctx.fillText(a.text, 0, 0);
    ctx.restore();
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export { PHASE };
