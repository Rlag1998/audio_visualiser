// A single fighter: state machine, movement physics, animation and the
// receiving end of combat. No DOM, no rendering, no randomness except what is
// handed in — so a Fighter is fully deterministic and testable under Node.

import {
  ARCHETYPES, ARENA, COMBAT, MOVEMENT, PHYS, STATS,
} from './config.js';
import { POSES, STANCE, blendPose, copyPose, makePose, resolvePose } from './pose.js';
import { MOVES, sampleTrack, totalFrames } from './moves.js';
import { Skeleton, hurtVolumes } from './skeleton.js';
import { Ragdoll } from './ragdoll.js';
import { clamp, damp, sign } from '../core/math.js';

export const STATE = {
  IDLE: 'idle',
  WALK: 'walk',
  CROUCH: 'crouch',
  BLOCK: 'block',
  BLOCKSTUN: 'blockstun',
  JUMP: 'jump',
  LAND: 'land',
  DASH: 'dash',
  ATTACK: 'attack',
  HURT: 'hurt',
  STUN: 'stun',
  DOWN: 'down',
  KO: 'ko',
  VICTORY: 'victory',
};

/**
 * Neutral command. Both the keyboard layer and the AI fill one of these in.
 * `parry` is the intent to parry rather than just guard — a human always has
 * it (their timing is the skill), the AI only rolls it on its parry stat.
 */
export function makeCmd() {
  return { x: 0, crouch: false, block: false, parry: false, jump: false, dash: 0, attack: null };
}

export function clearCmd(c) {
  c.x = 0;
  c.crouch = false;
  c.block = false;
  c.parry = false;
  c.jump = false;
  c.dash = 0;
  c.attack = null;
  return c;
}

let nextUid = 1;

export class Fighter {
  constructor(opts = {}) {
    this.uid = nextUid++;
    this.id = opts.id ?? 'p1';
    this.name = opts.name ?? 'Fighter';
    this.archetypeId = opts.archetype ?? 'duelist';
    this.arch = ARCHETYPES[this.archetypeId] ?? ARCHETYPES.duelist;
    this.palette = opts.palette ?? { body: '#5ee7ff', accent: '#0ea5c6', trail: 'rgba(94,231,255,0.55)' };

    this.skeleton = new Skeleton();
    this.ragdoll = new Ragdoll();
    this.pose = copyPose(STANCE, makePose());
    this._target = makePose();
    this._scratch = makePose();
    this.volumes = [];
    this.events = [];

    this.reset(opts.x ?? 0, opts.facing ?? 1);
  }

  // ---------------------------------------------------------------- lifecycle

  reset(x, facing) {
    this.x = x;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.facing = facing;
    this.grounded = true;

    this.health = STATS.maxHealth;
    this.stamina = STATS.maxStamina;
    this.guard = STATS.maxGuard;
    this.meter = 0;

    this.state = STATE.IDLE;
    this.stateT = 0;
    this.move = null;
    this.moveFrame = 0;
    this.moveHit = false;
    this.mStartup = 0;
    this.mActive = 0;
    this.mTotal = 0;
    this.chain = 0;
    this.canCancel = false;

    this.hitstop = 0;
    this.invuln = 0;
    this.blockAge = 999;
    this.blockCrouch = false;
    this.parryArmed = false;
    this._blockHeld = false;
    this._driving = false;
    this.hurtLow = false;
    this.dashDir = 1;
    this.exhausted = false;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboDamage = 0;
    this.stepPhase = 0;
    this.age = 0;
    this.downTimer = 0;
    this.wins = 0;

    this.ragdoll.stop();
    copyPose(STANCE, this.pose);
    this.events.length = 0;
    this._solve();
  }

  /** Reset only the per-round state, keeping round wins. */
  resetRound(x, facing) {
    const wins = this.wins;
    this.reset(x, facing);
    this.wins = wins;
  }

  // ------------------------------------------------------------------ queries

  get isDefeated() {
    return this.state === STATE.KO;
  }

  get isDown() {
    return this.state === STATE.DOWN || this.state === STATE.KO;
  }

  get isBlockingState() {
    return this.state === STATE.BLOCK || this.state === STATE.BLOCKSTUN;
  }

  get isAttacking() {
    return this.state === STATE.ATTACK;
  }

  /** True while the current attack's hitbox is live. */
  get moveActive() {
    return (
      this.state === STATE.ATTACK &&
      this.moveFrame >= this.mStartup &&
      this.moveFrame < this.mStartup + this.mActive
    );
  }

  /** True while the fighter is committed but cannot yet hit — the punish window. */
  get isVulnerableFrames() {
    return this.state === STATE.ATTACK && !this.moveActive;
  }

  canAct() {
    return (
      this.state === STATE.IDLE ||
      this.state === STATE.WALK ||
      this.state === STATE.CROUCH ||
      this.state === STATE.BLOCK
    );
  }

  canAttack(id) {
    const m = MOVES[id];
    if (!m) return false;
    if (this.exhausted) return false;
    if (m.meterCost && this.meter < m.meterCost) return false;
    if (this.stamina < this._cost(m)) return false;
    if (m.airOnly) return !this.grounded;
    return this.grounded;
  }

  _cost(m) {
    return m.stamina / this.arch.staminaMul;
  }

  /** Distance from this fighter's root to another's, signed toward facing. */
  gapTo(other) {
    return Math.abs(other.x - this.x);
  }

  // -------------------------------------------------------------------- update

  update(dt, cmd, world) {
    this.events.length = 0;

    if (this.hitstop > 0) {
      this.hitstop--;
      this._solve();
      return;
    }

    this.age++;
    this._timers(dt);

    if (this.state === STATE.KO) {
      this.ragdoll.step(dt);
      this._solve();
      return;
    }
    if (this.state === STATE.DOWN) {
      this.ragdoll.step(dt);
      this.downTimer++;
      if (this.downTimer >= COMBAT.downFrames || (this.ragdoll.settled && this.downTimer > COMBAT.downFrames * 0.6)) {
        this._getUp();
      }
      this._solve();
      return;
    }

    this._action(dt, cmd || makeCmd());
    this._physics(dt);
    this._animate(dt);
    this._solve();
  }

  _timers(dt) {
    if (this.invuln > 0) this.invuln--;
    if (this.comboTimer > 0) {
      this.comboTimer--;
      if (this.comboTimer === 0) {
        this.combo = 0;
        this.comboDamage = 0;
      }
    }
    this.blockAge++;

    // Stamina / guard recover faster when you are not throwing hands.
    const resting = this.state === STATE.IDLE || this.state === STATE.CROUCH || this.state === STATE.BLOCK;
    const mul = resting ? STATS.restBonus : 1;
    if (this.state !== STATE.ATTACK) {
      this.stamina = Math.min(STATS.maxStamina, this.stamina + STATS.staminaRegen * mul * dt);
    }
    this.guard = Math.min(STATS.maxGuard, this.guard + STATS.guardRegen * dt);

    if (this.exhausted && this.stamina > STATS.maxStamina * 0.32) this.exhausted = false;
    else if (!this.exhausted && this.stamina <= STATS.exhaustedThreshold) this.exhausted = true;
  }

  _action(dt, cmd) {
    // Track the guard button across frames: the parry window only opens on a
    // fresh press, otherwise holding block would parry every other hit.
    const blockHeldLast = this._blockHeld;
    this._blockHeld = !!cmd.block;

    switch (this.state) {
      case STATE.HURT:
      case STATE.BLOCKSTUN:
      case STATE.STUN:
      case STATE.LAND: {
        this.stateT--;
        if (this.stateT <= 0) this.state = this.grounded ? STATE.IDLE : STATE.JUMP;
        return;
      }

      case STATE.DASH: {
        this.stateT--;
        if (this.stateT > MOVEMENT.dashRecovery) {
          this.vx = this.dashDir * MOVEMENT.dashSpeed;
          this._driving = true;
        } else {
          this._driving = false;
        }
        if (this.stateT <= 0) this.state = STATE.IDLE;
        return;
      }

      case STATE.ATTACK: {
        this.moveFrame++;
        const inRecovery = this.moveFrame >= this.mStartup + this.mActive;

        // Chain cancel: landing a hit buys you the rest of the recovery.
        if (
          inRecovery && this.canCancel && cmd.attack &&
          cmd.attack !== this.move.id && this.chain < 4 && this.canAttack(cmd.attack)
        ) {
          this._startAttack(cmd.attack, this.chain + 1);
          return;
        }
        if (this.moveFrame >= this.mTotal) {
          if (!this.moveHit) this.events.push({ type: 'whiff', move: this.move });
          this.move = null;
          this.chain = 0;
          this.canCancel = false;
          this.state = this.grounded ? STATE.IDLE : STATE.JUMP;
        }
        return;
      }

      case STATE.JUMP: {
        // Air control + air attack.
        if (cmd.attack && this.canAttack('airKick')) {
          this._startAttack('airKick', 0);
          return;
        }
        if (cmd.x !== 0) {
          this.vx += cmd.x * MOVEMENT.airControl * dt * 6;
          this.vx = clamp(this.vx, -MOVEMENT.walkFwd * 1.6, MOVEMENT.walkFwd * 1.6);
        }
        return;
      }

      default:
        break;
    }

    // ---- grounded, actionable ------------------------------------------------
    this._driving = false;

    if (cmd.attack && this.canAttack(cmd.attack)) {
      this._startAttack(cmd.attack, 0);
      return;
    }

    if (cmd.dash !== 0 && this.stamina >= MOVEMENT.dashCost && !this.exhausted) {
      this.dashDir = cmd.dash;
      this.stamina -= MOVEMENT.dashCost;
      this.stateT = MOVEMENT.dashFrames + MOVEMENT.dashRecovery;
      this.state = STATE.DASH;
      this.events.push({ type: 'dash' });
      return;
    }

    if (cmd.jump && this.grounded) {
      this.vy = MOVEMENT.jumpVel;
      this.grounded = false;
      this.state = STATE.JUMP;
      if (cmd.x !== 0) this.vx = cmd.x * MOVEMENT.walkFwd * 1.15;
      this.events.push({ type: 'jump' });
      return;
    }

    if (cmd.block && !this.exhausted) {
      if (!blockHeldLast) {
        this.blockAge = 0;
        this.parryArmed = !!cmd.parry;
      }
      this.blockCrouch = cmd.crouch;
      this.state = STATE.BLOCK;
      this.vx *= 0.8;
      return;
    }

    if (cmd.crouch) {
      this.state = STATE.CROUCH;
      if (cmd.x !== 0) {
        this.vx = cmd.x * MOVEMENT.crouchSpeed;
        this._driving = true;
      }
      return;
    }

    if (cmd.x !== 0) {
      const forward = cmd.x === this.facing;
      let speed = forward ? MOVEMENT.walkFwd : MOVEMENT.walkBack;
      speed *= this.arch.speedMul;
      if (this.exhausted) speed *= 0.62;
      this.vx = cmd.x * speed;
      this._driving = true;
      this.state = STATE.WALK;
      return;
    }

    this.state = STATE.IDLE;
  }

  _startAttack(id, chain) {
    const m = MOVES[id];
    const scale = 1 / this.arch.speedMul;
    this.move = m;
    this.moveFrame = 0;
    this.moveHit = false;
    this.canCancel = false;
    this.chain = chain;
    this.mStartup = Math.max(2, Math.round(m.startup * scale));
    this.mActive = Math.max(2, Math.round(m.active * scale));
    this.mTotal = this.mStartup + this.mActive + Math.max(3, Math.round(m.recovery * scale));
    this.state = STATE.ATTACK;
    this.stamina = Math.max(0, this.stamina - this._cost(m));
    if (m.meterCost) this.meter = Math.max(0, this.meter - m.meterCost);
    if (this.grounded) this.vx *= 0.35;
    this.events.push({ type: 'swing', move: m });
  }

  _physics(dt) {
    if (!this.grounded) {
      this.vy += PHYS.gravity * dt;
      this.vx -= this.vx * Math.min(1, PHYS.airFriction * dt);
    } else if (!this._driving) {
      this.vx -= this.vx * Math.min(1, PHYS.groundFriction * dt);
      if (Math.abs(this.vx) < 1) this.vx = 0;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.y <= 0) {
      const wasAir = !this.grounded;
      this.y = 0;
      this.vy = 0;
      this.grounded = true;
      if (wasAir) this._onLand();
    } else {
      this.grounded = false;
    }

    const limit = ARENA.halfWidth - ARENA.wallMargin;
    if (this.x < -limit) {
      this.x = -limit;
      if (this.vx < 0) this.vx = 0;
    } else if (this.x > limit) {
      this.x = limit;
      if (this.vx > 0) this.vx = 0;
    }
  }

  _onLand() {
    this.events.push({ type: 'land' });
    if (this.state === STATE.HURT) {
      // Juggled fighters hit the floor hard.
      this._knockDown(this.vx * 0.5, 60, sign(this.vx) * 0.06);
      return;
    }
    if (this.state === STATE.ATTACK) {
      this.move = null;
      this.chain = 0;
    }
    if (this.state !== STATE.STUN) {
      this.state = STATE.LAND;
      this.stateT = MOVEMENT.landFrames;
    }
  }

  // ------------------------------------------------------------------ combat

  /**
   * Resolve an incoming attack against this fighter.
   * @returns {null|{type:string, damage:number, x:number, y:number, move:object}}
   *          null means "no interaction" (invulnerable / already down).
   */
  receiveAttack(move, attacker, contact) {
    if (this.invuln > 0 || this.isDown) return null;

    const away = sign(this.x - attacker.x) || attacker.facing;
    const facingAttacker = this.facing * (attacker.x - this.x) > 0;
    const blocking =
      (this.state === STATE.BLOCK || this.state === STATE.BLOCKSTUN) &&
      facingAttacker && this.grounded && !this.exhausted;
    const crouchBlock = blocking && this.blockCrouch;
    const guardOk =
      blocking &&
      (move.height === 'mid' || (crouchBlock ? move.height === 'low' : move.height === 'high'));

    const base = move.damage * attacker.arch.damageMul * this.arch.defenseMul;

    // --- parry ---------------------------------------------------------------
    if (guardOk && this.parryArmed && this.blockAge <= COMBAT.parryWindow && !move.guardBreak) {
      this.guard = STATS.maxGuard;
      this.meter = Math.min(STATS.maxMeter, this.meter + 18);
      this.hitstop = COMBAT.blockHitstop;
      this.blockAge = COMBAT.parryWindow + 1;
      this.parryArmed = false;
      attacker.stagger(COMBAT.parryStun);
      return { type: 'parry', damage: 0, x: contact.x, y: contact.y, move };
    }

    // --- block ---------------------------------------------------------------
    if (guardOk) {
      const chip = base * COMBAT.chip;
      this.health = Math.max(0, this.health - chip);
      this.guard -= move.guard;
      this.stamina = Math.max(0, this.stamina - move.guard * 0.4);
      this.vx = away * move.kbX * 0.35;
      this.hitstop = COMBAT.blockHitstop;
      this.state = STATE.BLOCKSTUN;
      this.stateT = move.blockstun;

      if (this.guard <= 0 || move.guardBreak) {
        this.guard = STATS.maxGuard * 0.5;
        this.stagger(COMBAT.guardBreakStun);
        return { type: 'guardBreak', damage: chip, x: contact.x, y: contact.y, move };
      }
      return { type: 'block', damage: chip, x: contact.x, y: contact.y, move };
    }

    // --- clean hit -----------------------------------------------------------
    let dmg = base;
    const counter = this.isVulnerableFrames;
    if (counter) dmg *= COMBAT.counterBonus;
    if (this.exhausted) dmg *= COMBAT.exhaustedDamageMul;
    dmg *= Math.max(COMBAT.minComboScale, COMBAT.comboScaling ** attacker.combo);
    dmg = Math.round(dmg * 10) / 10;

    this.health = Math.max(0, this.health - dmg);
    this.meter = Math.min(STATS.maxMeter, this.meter + dmg * STATS.meterOnTake);
    this.hitstop = move.guardBreak || move.knockdown ? COMBAT.heavyHitstop : COMBAT.hitstop;
    this.combo = 0;
    this.comboTimer = 0;

    const kbx = away * move.kbX;
    if (this.health <= 0) {
      this._ko(kbx * 1.5, move.kbY + 260, away * -0.14);
      return { type: 'ko', damage: dmg, counter, x: contact.x, y: contact.y, move };
    }

    if (move.knockdown) {
      this._knockDown(kbx, move.kbY + 130, away * -0.1);
      return { type: 'knockdown', damage: dmg, counter, x: contact.x, y: contact.y, move };
    }

    if (move.launcher) {
      this.vx = kbx * 0.5;
      this.vy = move.kbY;
      this.grounded = false;
      this.state = STATE.HURT;
      this.stateT = move.hitstun + 20;
      this.hurtLow = false;
      return { type: 'launch', damage: dmg, counter, x: contact.x, y: contact.y, move };
    }

    this.vx = kbx;
    if (!this.grounded) this.vy = Math.max(this.vy, 40);
    this.state = STATE.HURT;
    this.stateT = move.hitstun + (counter ? 5 : 0);
    this.hurtLow = move.height === 'low';
    this.move = null;
    return { type: 'hit', damage: dmg, counter, x: contact.x, y: contact.y, move };
  }

  /** Freeze a fighter in place — used by parries and guard breaks. */
  stagger(frames) {
    if (this.isDown) return;
    this.state = STATE.STUN;
    this.stateT = frames;
    this.move = null;
    this.moveHit = true;
    this.vx *= 0.3;
    this.combo = 0;
  }

  _knockDown(vx, vy, spin) {
    this.ragdoll.seed(this.skeleton.joints, vx, vy, spin, 1 / 60);
    this.state = STATE.DOWN;
    this.downTimer = 0;
    this.move = null;
    this.grounded = false;
    this.vx = 0;
    this.vy = 0;
    this.combo = 0;
    this.events.push({ type: 'knockdown' });
  }

  _ko(vx, vy, spin) {
    this.ragdoll.seed(this.skeleton.joints, vx, vy, spin, 1 / 60);
    this.state = STATE.KO;
    this.move = null;
    this.grounded = false;
    this.vx = 0;
    this.vy = 0;
    this.events.push({ type: 'ko' });
  }

  _getUp() {
    this.x = this.ragdoll.hipX;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.grounded = true;
    this.ragdoll.stop();
    this.state = STATE.IDLE;
    this.invuln = COMBAT.wakeupInvuln;
    this.stamina = Math.max(this.stamina, STATS.maxStamina * 0.35);
    this.guard = Math.max(this.guard, STATS.maxGuard * 0.6);
    copyPose(POSES.crouch, this.pose);
    this.events.push({ type: 'wakeup' });
  }

  /** Called by the match when this fighter's attack connects. */
  onHitLanded(result) {
    this.moveHit = true;
    this.canCancel = result.type === 'hit' || result.type === 'launch' || result.type === 'block';
    if (result.type !== 'block' && result.type !== 'parry') {
      this.combo++;
      this.comboDamage += result.damage;
      this.comboTimer = COMBAT.comboWindow;
    }
    this.meter = Math.min(STATS.maxMeter, this.meter + result.damage * STATS.meterOnDeal);
    this.hitstop = result.move.guardBreak || result.move.knockdown ? COMBAT.heavyHitstop : COMBAT.hitstop;
  }

  // --------------------------------------------------------------- animation

  _animate(dt) {
    const t = this._target;
    let rate = 22;

    switch (this.state) {
      case STATE.ATTACK: {
        const prog = this.mTotal > 0 ? this.moveFrame / this.mTotal : 0;
        sampleTrack(this.move, clamp(prog, 0, 1), t);
        rate = 40;
        break;
      }
      case STATE.WALK: {
        this._walkPose(sign(this.vx) === this.facing ? 1 : -1, dt, t);
        rate = 26;
        break;
      }
      case STATE.CROUCH:
        copyPose(POSES.crouch, t);
        rate = 26;
        break;
      case STATE.BLOCK:
      case STATE.BLOCKSTUN:
        copyPose(this.blockCrouch ? POSES.crouchBlock : POSES.block, t);
        rate = this.state === STATE.BLOCKSTUN ? 34 : 28;
        break;
      case STATE.JUMP:
        copyPose(this.vy > 0 ? POSES.jump : POSES.fall, t);
        rate = 14;
        break;
      case STATE.LAND:
        copyPose(POSES.land, t);
        rate = 30;
        break;
      case STATE.DASH:
        copyPose(POSES.dash, t);
        t.hipX = POSES.dash.hipX * (this.dashDir === this.facing ? 1 : -1);
        rate = 30;
        break;
      case STATE.HURT:
        copyPose(this.hurtLow ? POSES.hurtLow : POSES.hurtHigh, t);
        rate = 32;
        break;
      case STATE.STUN: {
        copyPose(POSES.stunned, t);
        const wob = Math.sin(this.age * 0.34) * 6;
        t.torso += wob;
        t.head += wob * 1.4;
        rate = 14;
        break;
      }
      case STATE.VICTORY:
        copyPose(POSES.victory, t);
        rate = 12;
        break;
      default: {
        copyPose(this.exhausted ? POSES.exhausted : POSES.idle, t);
        const breathe = Math.sin(this.age * (this.exhausted ? 0.14 : 0.062));
        t.hipY += breathe * (this.exhausted ? 3.2 : 1.3);
        t.torso += breathe * (this.exhausted ? 2.4 : 0.8);
        t.armFU += breathe * 2.2;
        t.armBU -= breathe * 1.8;
        rate = 16;
        break;
      }
    }

    blendPose(this.pose, t, damp(rate, dt), this.pose);
  }

  _walkPose(dir, dt, out) {
    this.stepPhase += (Math.abs(this.vx) * dt) / 30;
    const a = this.stepPhase * Math.PI * 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    copyPose(dir > 0 ? POSES.walkFwd : POSES.walkBack, out);
    out.footFX += s * 16;
    out.footFY += Math.max(0, c) * 14;
    out.footBX -= s * 16;
    out.footBY += Math.max(0, -c) * 14;
    out.hipY -= Math.abs(s) * 2.5;
    out.armFU -= s * 12;
    out.armFF -= s * 6;
    out.armBU += s * 12;
    out.armBF += s * 6;
    out.torso -= s * 2;
    return out;
  }

  _solve() {
    this.skeleton.solve(this.pose, this.x, this.y, this.facing);
    hurtVolumes(this.skeleton.joints, this.volumes);
  }

  /** Joints to draw — the ragdoll takes over once the fighter is on the floor. */
  get drawJoints() {
    return this.ragdoll.active ? this.ragdoll.points : this.skeleton.joints;
  }
}
