// On-screen controls for phones and tablets.
//
// These do not talk to the game directly — they synthesise key presses into the
// same Keyboard instance the physical keys feed. That means one input path to
// reason about: dashes still come from double taps, guard is still a held key,
// and the parry window still keys off a fresh press.
//
// The left pad is an analogue-ish stick rather than four buttons: you can slide
// between directions without lifting, and diagonals (jump-forward, crouch-back)
// fall out for free.

import { LAYOUTS } from './input.js';

const P1 = LAYOUTS.p1;

/** Virtual control -> the key code it stands in for. */
const BINDINGS = {
  up: P1.up[0],
  down: P1.down[0],
  left: P1.left[0],
  right: P1.right[0],
  guard: P1.block[0],
  jab: P1.jab[0],
  punch: P1.punch[0],
  kick: P1.kick[0],
  highKick: P1.bigKick[0],
  finisher: P1.finisher[0],
};

const BUTTONS = [
  { id: 'guard', label: 'GUARD', cls: 'guard' },
  { id: 'jab', label: 'JAB', cls: 'a' },
  { id: 'punch', label: 'PUNCH', cls: 'b' },
  { id: 'kick', label: 'KICK', cls: 'c' },
  { id: 'highKick', label: 'HIGH', cls: 'd' },
  { id: 'finisher', label: 'FINISH', cls: 'finisher' },
];

/** Dead zone before the stick counts as pushed, in px. */
const DEAD_X = 14;
const DEAD_Y = 20;

export class TouchControls {
  /**
   * @param {HTMLElement} root  container to build the controls inside
   * @param {import('./input.js').Keyboard} keyboard  where presses are sent
   */
  constructor(root, keyboard) {
    this.root = root;
    this.kb = keyboard;
    this.active = false;
    this.dirs = new Set();
    this.stickPointer = null;
    this._build();
  }

  _build() {
    this.root.textContent = '';

    // --- left: movement stick -------------------------------------------------
    const pad = document.createElement('div');
    pad.className = 'tc-pad';
    pad.innerHTML =
      '<div class="tc-ring"></div><div class="tc-knob"></div>' +
      '<span class="tc-hint tc-up">JUMP</span><span class="tc-hint tc-down">CROUCH</span>';
    this.pad = pad;
    this.knob = pad.querySelector('.tc-knob');

    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      this.stickPointer = e.pointerId;
      this._stick(e);
    });
    pad.addEventListener('pointermove', (e) => {
      if (this.stickPointer !== e.pointerId) return;
      e.preventDefault();
      this._stick(e);
    });
    const endStick = (e) => {
      if (this.stickPointer !== e.pointerId) return;
      this.stickPointer = null;
      this._setDirs([]);
      this.knob.style.transform = '';
    };
    pad.addEventListener('pointerup', endStick);
    pad.addEventListener('pointercancel', endStick);
    pad.addEventListener('lostpointercapture', endStick);

    // --- right: attacks -------------------------------------------------------
    const cluster = document.createElement('div');
    cluster.className = 'tc-buttons';
    this.buttonEls = {};

    for (const def of BUTTONS) {
      const b = document.createElement('button');
      b.className = `tc-btn tc-${def.cls}`;
      b.textContent = def.label;
      b.type = 'button';
      this.buttonEls[def.id] = b;

      const down = (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('held');
        this.kb.press(BINDINGS[def.id]);
      };
      const up = (e) => {
        e.preventDefault();
        b.classList.remove('held');
        this.kb.release(BINDINGS[def.id]);
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      // Never let a long press raise the context menu mid-fight.
      b.addEventListener('contextmenu', (e) => e.preventDefault());

      cluster.append(b);
    }

    this.root.append(pad, cluster);
  }

  _stick(e) {
    const r = this.pad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);

    const next = [];
    if (dx < -DEAD_X) next.push('left');
    else if (dx > DEAD_X) next.push('right');
    // Jump needs a more deliberate push than crouch — an accidental jump in
    // this game costs you a whole punish.
    if (dy < -DEAD_Y) next.push('up');
    else if (dy > DEAD_X) next.push('down');

    this._setDirs(next);

    const max = r.width * 0.28;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, max / len);
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  _setDirs(next) {
    const wanted = new Set(next);
    for (const d of this.dirs) {
      if (!wanted.has(d)) this.kb.release(BINDINGS[d]);
    }
    for (const d of wanted) {
      // press() is idempotent while held, so re-pressing a direction the player
      // never released does not spuriously register as a double tap.
      if (!this.dirs.has(d)) this.kb.press(BINDINGS[d]);
    }
    this.dirs = wanted;
  }

  /** Release everything — used when the fight is paused or torn down. */
  releaseAll() {
    for (const d of this.dirs) this.kb.release(BINDINGS[d]);
    this.dirs = new Set();
    this.stickPointer = null;
    if (this.knob) this.knob.style.transform = '';
    for (const [id, el] of Object.entries(this.buttonEls)) {
      el.classList.remove('held');
      this.kb.release(BINDINGS[id]);
    }
  }

  setVisible(on) {
    this.active = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.releaseAll();
  }

  /** Light the finisher button only when there is meter to spend. */
  syncMeter(ready) {
    if (this._meterReady === ready) return;
    this._meterReady = ready;
    this.buttonEls.finisher.classList.toggle('ready', ready);
  }
}

/** Best-effort guess at whether this device wants on-screen controls. */
export function prefersTouchControls() {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
  return !!(coarse || noHover || ('ontouchstart' in window && navigator.maxTouchPoints > 0));
}
