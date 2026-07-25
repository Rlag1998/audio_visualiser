// Procedural sound. Every effect is synthesised from oscillators and a noise
// buffer at runtime, so the project ships with no audio assets at all.
//
// The AudioContext is created lazily on the first user gesture, which keeps
// browser autoplay policies happy.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.5;
    this.noise = null;
    this._lastAt = new Map();
  }

  /** Safe to call repeatedly; only the first call inside a gesture matters. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused by every percussive effect.
    const len = Math.floor(this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff) - 1;
    }
    this.noise = buf;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && this.enabled) this.master.gain.value = v;
  }

  get t() {
    return this.ctx.currentTime;
  }

  /** Rate-limit a sound so overlapping events cannot stack into a scream. */
  _throttle(key, ms) {
    const now = this.ctx ? this.ctx.currentTime * 1000 : 0;
    const last = this._lastAt.get(key) ?? -1e9;
    if (now - last < ms) return false;
    this._lastAt.set(key, now);
    return true;
  }

  _noiseBurst({ dur = 0.12, gain = 0.5, type = 'lowpass', freq = 900, q = 1, sweepTo = null, delay = 0 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    const t0 = this.t + delay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    if (sweepTo != null) {
      filter.frequency.setValueAtTime(freq, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
    }
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  _tone({ freq = 220, to = null, dur = 0.2, gain = 0.3, type = 'sine', delay = 0 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    const t0 = this.t + delay;
    osc.frequency.setValueAtTime(freq, t0);
    if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // ------------------------------------------------------------------ effects

  swing(weight = 1) {
    if (!this.ready() || !this._throttle('swing', 45)) return;
    this._noiseBurst({
      dur: 0.1 + weight * 0.06,
      gain: 0.1 + weight * 0.06,
      type: 'bandpass',
      freq: 1400 - weight * 400,
      q: 1.4,
      sweepTo: 320,
    });
  }

  hit(power = 1, counter = false) {
    if (!this.ready()) return;
    this._noiseBurst({ dur: 0.1 + power * 0.05, gain: 0.32 + power * 0.2, type: 'lowpass', freq: 1600, sweepTo: 220 });
    this._tone({ freq: 150 - power * 30, to: 46, dur: 0.16 + power * 0.08, gain: 0.34, type: 'sine' });
    if (counter) this._tone({ freq: 900, to: 420, dur: 0.12, gain: 0.14, type: 'square' });
  }

  heavy() {
    if (!this.ready()) return;
    this._noiseBurst({ dur: 0.26, gain: 0.5, type: 'lowpass', freq: 2200, sweepTo: 140 });
    this._tone({ freq: 110, to: 32, dur: 0.4, gain: 0.45, type: 'sine' });
    this._tone({ freq: 320, to: 90, dur: 0.22, gain: 0.16, type: 'sawtooth' });
  }

  block() {
    if (!this.ready() || !this._throttle('block', 40)) return;
    this._noiseBurst({ dur: 0.07, gain: 0.24, type: 'highpass', freq: 2400 });
    this._tone({ freq: 620, to: 380, dur: 0.07, gain: 0.12, type: 'square' });
  }

  parry() {
    if (!this.ready()) return;
    this._tone({ freq: 1320, to: 1980, dur: 0.14, gain: 0.2, type: 'triangle' });
    this._tone({ freq: 1980, dur: 0.3, gain: 0.12, type: 'sine', delay: 0.04 });
    this._noiseBurst({ dur: 0.14, gain: 0.16, type: 'highpass', freq: 3200 });
  }

  guardBreak() {
    if (!this.ready()) return;
    this._noiseBurst({ dur: 0.3, gain: 0.4, type: 'bandpass', freq: 1800, q: 0.6, sweepTo: 300 });
    this._tone({ freq: 260, to: 70, dur: 0.35, gain: 0.28, type: 'sawtooth' });
  }

  jump() {
    if (!this.ready() || !this._throttle('jump', 90)) return;
    this._noiseBurst({ dur: 0.09, gain: 0.12, type: 'bandpass', freq: 700, sweepTo: 1500 });
  }

  land(power = 1) {
    if (!this.ready() || !this._throttle('land', 60)) return;
    this._noiseBurst({ dur: 0.13, gain: 0.14 * power, type: 'lowpass', freq: 500, sweepTo: 120 });
  }

  dash() {
    if (!this.ready() || !this._throttle('dash', 90)) return;
    this._noiseBurst({ dur: 0.16, gain: 0.16, type: 'bandpass', freq: 500, q: 0.8, sweepTo: 1800 });
  }

  knockdown() {
    if (!this.ready()) return;
    this._noiseBurst({ dur: 0.3, gain: 0.3, type: 'lowpass', freq: 700, sweepTo: 90 });
    this._tone({ freq: 90, to: 40, dur: 0.4, gain: 0.3, type: 'sine' });
  }

  ko() {
    if (!this.ready()) return;
    this.heavy();
    this._tone({ freq: 440, to: 60, dur: 1.1, gain: 0.3, type: 'sawtooth', delay: 0.06 });
    this._tone({ freq: 220, to: 30, dur: 1.3, gain: 0.22, type: 'triangle', delay: 0.06 });
  }

  announce(kind = 'round') {
    if (!this.ready()) return;
    if (kind === 'go') {
      this._tone({ freq: 660, dur: 0.14, gain: 0.2, type: 'triangle' });
      this._tone({ freq: 990, dur: 0.28, gain: 0.2, type: 'triangle', delay: 0.1 });
    } else if (kind === 'win') {
      [523, 659, 784, 1047].forEach((f, i) => this._tone({ freq: f, dur: 0.35, gain: 0.16, type: 'triangle', delay: i * 0.1 }));
    } else {
      this._tone({ freq: 392, dur: 0.2, gain: 0.16, type: 'triangle' });
      this._tone({ freq: 523, dur: 0.3, gain: 0.16, type: 'triangle', delay: 0.14 });
    }
  }

  ui() {
    if (!this.ready() || !this._throttle('ui', 40)) return;
    this._tone({ freq: 880, to: 1200, dur: 0.05, gain: 0.07, type: 'square' });
  }

  ready() {
    return !!(this.ctx && this.enabled && this.noise);
  }

  /** Map a frame of match events onto sounds. */
  playEvents(events) {
    if (!this.ready()) return;
    for (const ev of events) {
      switch (ev.type) {
        case 'swing':
          this.swing(ev.move.damage / 20);
          break;
        case 'jump':
          this.jump();
          break;
        case 'dash':
          this.dash();
          break;
        case 'land':
          this.land(0.8);
          break;
        case 'knockdown':
          this.knockdown();
          break;
        case 'contact':
          if (ev.result === 'block') this.block();
          else if (ev.result === 'parry') this.parry();
          else if (ev.result === 'guardBreak') this.guardBreak();
          else if (ev.result === 'ko') this.ko();
          else if (ev.move.knockdown || ev.move.guardBreak) this.heavy();
          else this.hit(ev.damage / 18, ev.counter);
          break;
        case 'roundStart':
          this.announce('round');
          break;
        case 'announce':
          this.announce('go');
          break;
        case 'matchEnd':
          this.announce('win');
          break;
        default:
          break;
      }
    }
  }
}
