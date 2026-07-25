// Keyboard (and optional gamepad) input, mapped onto the same command object
// the AI produces. Nothing downstream knows or cares which one filled it in.

import { STATE } from '../game/fighter.js';

/** Two full control layouts so two people can share one keyboard. */
export const LAYOUTS = {
  p1: {
    label: 'Player 1',
    left: ['KeyA'],
    right: ['KeyD'],
    up: ['KeyW'],
    down: ['KeyS'],
    block: ['Space'],
    jab: ['KeyJ'],
    punch: ['KeyK'],
    kick: ['KeyL'],
    bigKick: ['KeyI'],
    finisher: ['KeyU'],
  },
  p2: {
    label: 'Player 2',
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    block: ['ShiftRight', 'Numpad0', 'Quote'],
    jab: ['Numpad1', 'Comma'],
    punch: ['Numpad2', 'Period'],
    kick: ['Numpad3', 'Slash'],
    bigKick: ['Numpad5', 'Semicolon'],
    finisher: ['NumpadEnter', 'Backslash'],
  },
};

/** Human-readable control reference, used by the help panel. */
export const CONTROL_HELP = [
  ['Move / turn', 'A D', '← →'],
  ['Jump', 'W', '↑'],
  ['Crouch', 'S', '↓'],
  ['Dash', 'double-tap A / D', 'double-tap ← / →'],
  ['Guard (tap = parry)', 'Space', 'R-Shift / Num0'],
  ['Jab', 'J', 'Num1 / ,'],
  ['Punch (+crouch = uppercut)', 'K', 'Num2 / .'],
  ['Kick (+crouch = sweep)', 'L', 'Num3 / /'],
  ['High kick', 'I', 'Num5 / ;'],
  ['Finisher (needs full meter)', 'U', 'NumEnter / \\'],
];

const DOUBLE_TAP_MS = 260;

/**
 * Every key either layout binds, derived rather than hand-listed — a hardcoded
 * list drifts, and a missed binding means the browser keeps its default. `/`
 * opening Firefox's quick-find mid-fight is the sort of thing that causes.
 */
const GAME_KEYS = new Set(
  Object.values(LAYOUTS).flatMap((layout) =>
    Object.values(layout).filter(Array.isArray).flat(),
  ),
);

export class Keyboard {
  constructor(target = globalThis) {
    this.down = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each consume
    this.lastTap = new Map();
    this.doubleTap = new Map();
    // Off by default: while a menu is up the game must not swallow Space,
    // arrows or `/`, or the panels stop being keyboard-operable.
    this.enabled = false;

    this._onDown = (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      const code = e.code;
      if (this._isGameKey(code)) e.preventDefault();
      this.down.add(code);
      this.pressed.add(code);

      const now = performance.now();
      const last = this.lastTap.get(code) ?? -1e9;
      if (now - last < DOUBLE_TAP_MS) this.doubleTap.set(code, now);
      this.lastTap.set(code, now);
    };
    this._onUp = (e) => {
      this.down.delete(e.code);
    };
    this._onBlur = () => {
      this.down.clear();
      this.pressed.clear();
    };

    target.addEventListener('keydown', this._onDown, { passive: false });
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);
    this._target = target;
  }

  _isGameKey(code) {
    return GAME_KEYS.has(code);
  }

  /**
   * Synthesise a key press. Touch controls route through here so on-screen
   * buttons get identical treatment to real keys — including the double-tap
   * detection that dashes depend on.
   */
  press(code) {
    if (this.down.has(code)) return;
    this.down.add(code);
    this.pressed.add(code);
    const now = performance.now();
    const last = this.lastTap.get(code) ?? -1e9;
    if (now - last < DOUBLE_TAP_MS) this.doubleTap.set(code, now);
    this.lastTap.set(code, now);
  }

  release(code) {
    this.down.delete(code);
  }

  isDown(codes) {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(codes) {
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  consumedDoubleTap(codes) {
    for (const c of codes) {
      const t = this.doubleTap.get(c);
      if (t !== undefined && performance.now() - t < DOUBLE_TAP_MS) {
        this.doubleTap.delete(c);
        return true;
      }
    }
    return false;
  }

  endFrame() {
    this.pressed.clear();
  }

  /** Enable only while a fight is actually taking input. */
  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    this.down.clear();
    this.pressed.clear();
    this.doubleTap.clear();
  }

  destroy() {
    this._target.removeEventListener('keydown', this._onDown);
    this._target.removeEventListener('keyup', this._onUp);
    this._target.removeEventListener('blur', this._onBlur);
  }
}

export class HumanController {
  /**
   * @param {Keyboard} keyboard
   * @param {'p1'|'p2'} layoutId
   * @param {number} [gamepadIndex] optional gamepad slot to merge in
   */
  constructor(keyboard, layoutId = 'p1', gamepadIndex = null) {
    this.kb = keyboard;
    this.layout = LAYOUTS[layoutId] ?? LAYOUTS.p1;
    this.layoutId = layoutId;
    this.gamepadIndex = gamepadIndex;
    this.isHuman = true;
    this._padPrev = {};
  }

  _pad() {
    if (this.gamepadIndex == null || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    return pads ? pads[this.gamepadIndex] : null;
  }

  update(cmd, self, foe, match) {
    const kb = this.kb;
    const L = this.layout;

    let left = kb.isDown(L.left);
    let right = kb.isDown(L.right);
    let up = kb.wasPressed(L.up);
    let down = kb.isDown(L.down);
    let block = kb.isDown(L.block);
    let blockTap = kb.wasPressed(L.block);

    let jab = kb.wasPressed(L.jab);
    let punch = kb.wasPressed(L.punch);
    let kick = kb.wasPressed(L.kick);
    let bigKick = kb.wasPressed(L.bigKick);
    let finisher = kb.wasPressed(L.finisher);

    let dash = 0;
    if (kb.consumedDoubleTap(L.left)) dash = -1;
    else if (kb.consumedDoubleTap(L.right)) dash = 1;

    // Optional gamepad, merged on top of the keyboard.
    const pad = this._pad();
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (ax < -0.4 || pad.buttons[14]?.pressed) left = true;
      if (ax > 0.4 || pad.buttons[15]?.pressed) right = true;
      const edge = (i) => {
        const now = !!pad.buttons[i]?.pressed;
        const was = !!this._padPrev[i];
        this._padPrev[i] = now;
        return now && !was;
      };
      const held = (i) => !!pad.buttons[i]?.pressed;
      if (edge(0)) up = true;
      if (held(1) || (pad.axes[1] ?? 0) > 0.5 || held(13)) down = true;
      if (held(6) || held(4)) block = true;
      if (edge(6) || edge(4)) blockTap = true;
      if (edge(2)) jab = true;
      if (edge(3)) punch = true;
      if (edge(7)) kick = true;
      if (edge(5)) bigKick = true;
      if (edge(9)) finisher = true;
    }

    cmd.x = (right ? 1 : 0) - (left ? 1 : 0);
    cmd.crouch = down && self.grounded;
    cmd.jump = up;
    cmd.dash = dash;
    // A human's parry is their own timing — the intent is always there, the
    // guard just has to be freshly pressed when the hit arrives.
    cmd.block = block;
    cmd.parry = block;

    if (blockTap) cmd.parry = true;

    // Attacks. Airborne, every button becomes the air kick.
    let attack = null;
    if (!self.grounded) {
      if (jab || punch || kick || bigKick) attack = 'airKick';
    } else if (finisher) {
      attack = 'heavy';
    } else if (jab) {
      attack = 'jab';
    } else if (punch) {
      attack = cmd.crouch ? 'uppercut' : 'cross';
    } else if (kick) {
      attack = cmd.crouch ? 'sweep' : 'lowKick';
    } else if (bigKick) {
      attack = 'highKick';
    }

    // Holding a direction while pressing punch gives you the hook — a bit of
    // depth for players who go looking for it.
    if (attack === 'cross' && cmd.x === self.facing) attack = 'hook';

    cmd.attack = attack;
  }
}
