// The CPU fighter.
//
// The AI is deliberately *not* omniscient: it reads a snapshot of the opponent
// that is `reaction` frames stale, so a Rookie genuinely cannot see a 4-frame
// jab coming while a Master can. Difficulty is otherwise expressed as
// probabilities — how often it blocks correctly, punishes a whiff, respects
// spacing, or throws something out for no reason.

import { DIFFICULTIES, MOVEMENT, STATS } from './config.js';
import { GROUND_MOVES, MOVES, MOVE_REACH } from './moves.js';
import { STATE } from './fighter.js';
import { clamp } from '../core/math.js';

const SNAPSHOT_MAX = 32;

function snapshot(f, out) {
  out.x = f.x;
  out.y = f.y;
  out.state = f.state;
  out.grounded = f.grounded;
  out.health = f.health;
  out.isDown = f.isDown;
  out.blockCrouch = f.blockCrouch;
  out.moveId = f.move ? f.move.id : null;
  out.height = f.move ? f.move.height : null;
  out.moveFrame = f.moveFrame;
  out.mStartup = f.mStartup;
  out.mActive = f.mActive;
  out.mTotal = f.mTotal;
  out.meter = f.meter;
  out.invuln = f.invuln;
  out.blockstun = f.state === STATE.BLOCKSTUN;
  return out;
}

/** Is this (perceived) opponent stuck in frames we can punish? */
function isRecovering(snap) {
  return (
    (snap.state === STATE.ATTACK && snap.moveFrame >= snap.mStartup + snap.mActive) ||
    snap.state === STATE.STUN ||
    snap.state === STATE.LAND ||
    snap.state === STATE.BLOCKSTUN
  );
}

const blankSnap = () => ({
  x: 0, y: 0, state: STATE.IDLE, grounded: true, health: 100, isDown: false,
  blockCrouch: false, moveId: null, height: null, moveFrame: 0,
  mStartup: 0, mActive: 0, mTotal: 0, meter: 0, invuln: 0, blockstun: false,
});

export class AIController {
  /**
   * @param {object} opts
   * @param {string} opts.difficulty  key into DIFFICULTIES
   * @param {object} opts.rng         seeded RNG (from core/rng)
   */
  constructor(opts = {}) {
    this.difficultyId = opts.difficulty ?? 'veteran';
    this.skill = DIFFICULTIES[this.difficultyId] ?? DIFFICULTIES.veteran;
    this.rng = opts.rng;
    this.isAI = true;

    this.history = [];
    for (let i = 0; i < SNAPSHOT_MAX; i++) this.history.push(blankSnap());
    this.cursor = 0;

    this.hold = 0;
    this.plan = 'neutral';
    this.planDir = 0;
    this.blockCrouch = false;
    this.blockHold = 0;
    this.parryNow = false;
    // Two separate books: what the opponent guards (drives our offence) and
    // what keeps hitting us (drives our guard). Lows are too fast to react to
    // at any reaction time, so the only way to defend them is to notice you
    // keep eating them and start crouching — which is what a human does too.
    this.memory = { blockedHigh: 0, blockedLow: 0 };
    this.hurtBy = { low: 1, high: 1 };
    this._wasHurt = false;
    this._sawBlock = false;
    this.lastAttack = null;
    this.attackCooldown = 0;
  }

  /**
   * Called by the match between rounds. Without this the perception buffer
   * still holds last round's final positions, and the AI spends its whole
   * reaction window at the start of a new round acting on where the opponent
   * used to be lying.
   */
  reset() {
    for (const snap of this.history) Object.assign(snap, blankSnap());
    this.cursor = 0;
    this.hold = 0;
    this.blockHold = 0;
    this.attackCooldown = 0;
    this.plan = 'neutral';
    this.parryNow = false;
    this.hurtBy.low = 1;
    this.hurtBy.high = 1;
    this._wasHurt = false;
    this._sawBlock = false;
  }

  /** How often this AI should guess "crouch" when it cannot read the attack. */
  get crouchBias() {
    const total = this.hurtBy.low + this.hurtBy.high;
    // Pulled toward an even guess by skill: a Rookie barely adapts at all.
    const observed = this.hurtBy.low / total;
    return 0.35 + (observed - 0.5) * this.skill.blockSkill * 1.3;
  }

  /** Opponent state as this AI perceives it — `reaction` frames in the past. */
  _perceive(foe) {
    snapshot(foe, this.history[this.cursor % SNAPSHOT_MAX]);
    const delay = Math.min(this.skill.reaction, SNAPSHOT_MAX - 1);
    const idx = (this.cursor - delay + SNAPSHOT_MAX * 2) % SNAPSHOT_MAX;
    this.cursor++;
    return this.history[idx];
  }

  update(cmd, self, foe, match) {
    const seen = this._perceive(foe);
    const rng = this.rng;
    const skill = this.skill;

    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.hold > 0) this.hold--;

    if (self.isDown || self.state === STATE.STUN) {
      this.blockHold = 0;
      return;
    }

    const toFoe = seen.x >= self.x ? 1 : -1;
    const gap = Math.abs(seen.x - self.x);

    // Remember what the opponent guards so the AI can start mixing them up.
    // Counted on the transition into blockstun, not every frame of it, and read
    // from the perceived snapshot so the AI is not quietly cheating.
    if (seen.blockstun && !this._sawBlock) {
      if (seen.blockCrouch) this.memory.blockedLow++;
      else this.memory.blockedHigh++;
    }
    this._sawBlock = seen.blockstun;

    // Remember what is getting through our own guard.
    const hurtNow = self.state === STATE.HURT;
    if (hurtNow && !this._wasHurt) {
      if (self.hurtLow) this.hurtBy.low++;
      else this.hurtBy.high++;
    }
    this._wasHurt = hurtNow;

    // --- continue a combo -----------------------------------------------------
    if (self.state === STATE.ATTACK && self.canCancel) {
      if (rng.chance(skill.comboSkill)) {
        const next = this._pickAttack(self, seen, gap, true);
        if (next && next !== self.move.id) {
          cmd.attack = next;
          return;
        }
      }
      return;
    }

    // Nothing useful to do mid-attack.
    if (self.state === STATE.ATTACK || self.state === STATE.DASH) return;

    // A committed guard: once the AI decides to block it holds through the
    // attack instead of flickering the button on and off every frame.
    if (this.blockHold > 0 && self.exhausted) this.blockHold = 0;
    if (this.blockHold > 0) {
      this.blockHold--;
      cmd.block = true;
      cmd.crouch = this.blockCrouch;
      cmd.parry = this.parryNow;
      return;
    }

    // --- opponent is on the floor: reposition and meaty their wake-up ---------
    if (seen.isDown) {
      if (gap > 62) cmd.x = toFoe;
      else if (gap < 40) cmd.x = -toFoe;
      if (seen.state === STATE.IDLE && seen.invuln > 0 && rng.chance(skill.punishSkill * 0.12)) {
        const m = this._pickAttack(self, seen, gap, false);
        if (m) cmd.attack = m;
      }
      return;
    }

    // --- our own jump-in -------------------------------------------------------
    if (!self.grounded) {
      if (gap < MOVE_REACH.airKick && self.canAttack('airKick') && rng.chance(0.2 + skill.aggression * 0.35)) {
        cmd.attack = 'airKick';
      } else if (gap > 40) {
        cmd.x = toFoe;
      }
      return;
    }

    // --- anti-air --------------------------------------------------------------
    if (!seen.grounded && gap < 90 && rng.chance(skill.punishSkill * 0.5)) {
      if (self.canAttack('uppercut')) {
        cmd.attack = 'uppercut';
        return;
      }
    }

    // --- react to an incoming attack ------------------------------------------
    const incoming =
      seen.state === STATE.ATTACK &&
      seen.moveFrame < seen.mStartup + seen.mActive &&
      gap < (MOVE_REACH[seen.moveId] ?? 70) + 26;

    if (incoming) {
      if (rng.chance(skill.blockSkill)) {
        // Guessing the height right is a separate, harder check — that is the
        // mixup game. High skill AI reads it, low skill AI eats sweeps.
        const readHeight = rng.chance(0.45 + skill.blockSkill * 0.5);
        this.blockCrouch = readHeight ? seen.height === 'low' : rng.chance(this.crouchBias);
        this.parryNow = rng.chance(skill.parrySkill);
        this.blockHold = rng.int(7, 15);
        cmd.block = true;
        cmd.crouch = this.blockCrouch;
        cmd.parry = this.parryNow;
        return;
      }
      // Or beat them to it with something faster.
      if (rng.chance(skill.punishSkill * 0.3) && self.canAttack('jab') && gap < MOVE_REACH.jab) {
        cmd.attack = 'jab';
        return;
      }
    }

    // Standing in the danger zone with nothing better to do? Respect it.
    // This is the proactive guard that reaction time alone can never provide.
    if (
      !isRecovering(seen) && gap < 92 && this.attackCooldown <= 0 &&
      rng.chance(skill.blockSkill * 0.09)
    ) {
      this.blockCrouch = rng.chance(this.crouchBias);
      this.parryNow = rng.chance(skill.parrySkill * 0.5);
      this.blockHold = rng.int(8, 20);
      cmd.block = true;
      cmd.crouch = this.blockCrouch;
      cmd.parry = this.parryNow;
      return;
    }

    // --- punish a whiff / recovery --------------------------------------------
    if (isRecovering(seen) && rng.chance(skill.punishSkill)) {
      if (this._trySuper(cmd, self, seen, gap, true)) return;
      const m = this._pickAttack(self, seen, gap, false);
      if (m) {
        cmd.attack = m;
        return;
      }
      // Out of range to punish — close the distance fast.
      if (gap > 70) {
        if (rng.chance(0.4) && self.stamina > MOVEMENT.dashCost * 2) cmd.dash = toFoe;
        else cmd.x = toFoe;
        return;
      }
    }

    // --- exhausted: back off and breathe ---------------------------------------
    if (self.exhausted) {
      if (gap < 130) cmd.x = -toFoe;
      cmd.block = gap < 90;
      return;
    }

    // --- neutral game ----------------------------------------------------------
    if (this.hold <= 0) {
      this._replan(self, seen, gap, toFoe);
    }

    switch (this.plan) {
      case 'approach':
        cmd.x = this.planDir;
        break;
      case 'retreat':
        cmd.x = this.planDir;
        if (rng.chance(0.03)) cmd.block = true;
        break;
      case 'turtle':
        cmd.block = true;
        cmd.crouch = this.blockCrouch;
        break;
      case 'jumpIn':
        cmd.jump = true;
        cmd.x = this.planDir;
        this.hold = 0;
        break;
      case 'dashIn':
        cmd.dash = this.planDir;
        this.hold = 0;
        break;
      default:
        break;
    }

    // In range and willing? Throw something.
    if (this.attackCooldown <= 0 && !seen.isDown) {
      if (this._trySuper(cmd, self, seen, gap, false)) return;
      const eager = rng.chance(this.skill.aggression * (this.plan === 'approach' ? 0.16 : 0.1));
      if (eager) {
        const m = this._pickAttack(self, seen, gap, false);
        if (m) {
          cmd.attack = m;
          cmd.block = false;
          this.attackCooldown = 4;
          this.lastAttack = m;
          return;
        }
      }
      // Occasional deliberate mistake: a raw move from too far out.
      if (rng.chance(this.skill.mistake * 0.02)) {
        // Deliberately ignore range: this is the AI throwing something it has
        // no business throwing. Passing a larger gap would filter *more* moves
        // out, which is the opposite of a mistake.
        const m = this._pickAttack(self, seen, 0, false);
        if (m) {
          cmd.attack = m;
          this.attackCooldown = 8;
        }
      }
    }
  }

  _replan(self, seen, gap, toFoe) {
    const rng = this.rng;
    const skill = this.skill;
    const healthEdge = self.health - seen.health;

    // Preferred range: just outside the opponent's jab, inside our own best poke.
    const ideal = 70 + (1 - skill.spacing) * 40;
    const r = rng.next();

    if (gap > ideal + 45) {
      // Far: close in, sometimes with a dash or a jump.
      if (r < 0.08 * skill.aggression && self.stamina > 40) this.plan = 'dashIn';
      else if (r < 0.11 * skill.aggression) this.plan = 'jumpIn';
      else this.plan = 'approach';
      this.planDir = toFoe;
      this.hold = rng.int(10, 24);
      return;
    }

    if (gap < 44) {
      // Too close to breathe — back out or hold guard.
      this.plan = r < 0.55 ? 'retreat' : 'turtle';
      this.planDir = -toFoe;
      this.blockCrouch = rng.chance(this.crouchBias);
      this.hold = rng.int(8, 18);
      return;
    }

    // In the pocket. Winning fighters can afford to wait; losing ones press.
    const press = skill.aggression + (healthEdge < -20 ? 0.25 : 0) - (healthEdge > 25 ? 0.2 : 0);
    if (r < press * 0.6) {
      this.plan = 'approach';
      this.planDir = toFoe;
    } else if (r < press * 0.6 + 0.22) {
      this.plan = 'retreat';
      this.planDir = -toFoe;
    } else if (r < press * 0.6 + 0.34) {
      this.plan = 'turtle';
      this.blockCrouch = rng.chance(this.crouchBias);
    } else {
      this.plan = 'neutral';
    }
    this.hold = rng.int(9, 22);
  }

  _trySuper(cmd, self, seen, gap, guaranteed) {
    if (self.meter < STATS.maxMeter) return false;
    if (!self.canAttack('heavy')) return false;
    if (gap > MOVE_REACH.heavy) return false;
    const p = guaranteed ? this.skill.meterSkill : this.skill.meterSkill * 0.08;
    if (!this.rng.chance(p)) return false;
    cmd.attack = 'heavy';
    this.attackCooldown = 10;
    return true;
  }

  _pickAttack(self, seen, gap, chaining) {
    const opts = [];
    const weights = [];
    const memTotal = this.memory.blockedHigh + this.memory.blockedLow + 1;
    const highBias = this.memory.blockedHigh / memTotal;

    for (const id of GROUND_MOVES) {
      if (!self.canAttack(id)) continue;
      if (chaining && id === self.move?.id) continue;
      const reach = MOVE_REACH[id];
      if (gap > reach) continue;

      // Archetype preference dominates: a boxer should look like a boxer even
      // when a kick would technically be the better spacing answer.
      let w = (self.arch.weights[id] ?? 1) ** 1.6;

      // Spacing skill: prefer the move whose reach best matches the gap.
      const slack = clamp((reach - gap) / reach, 0, 1);
      w *= 1 - this.skill.spacing * slack * 0.45;

      // Mixup: if they keep blocking high, start going low (and vice versa).
      const m = MOVES[id];
      if (m.height === 'low') w *= 1 + highBias * this.skill.blockSkill * 1.6;
      else if (m.height === 'high') w *= 1 + (1 - highBias) * this.skill.blockSkill * 0.9;

      // Combos want fast starters, not committal swings.
      if (chaining) w *= 12 / (m.startup + 6);

      // Do not throw a slow move when they are about to recover.
      if (seen.state === STATE.ATTACK) {
        const left = seen.mTotal - seen.moveFrame;
        if (m.startup > left + 6) w *= 0.25;
      }

      opts.push(id);
      weights.push(Math.max(0.01, w));
    }

    if (!opts.length) return null;
    const id = this.rng.weighted(opts, weights);
    // If the only thing in range is a move this fighter has no business
    // throwing, usually step in and look for a better option instead.
    if ((self.arch.weights[id] ?? 1) < 0.6 && this.rng.chance(0.55)) return null;
    return id;
  }
}

/** A do-nothing controller, useful for training-dummy mode. */
export class DummyController {
  constructor(opts = {}) {
    this.block = opts.block ?? false;
    this.isAI = true;
  }

  update(cmd, self) {
    if (this.block && self.canAct()) cmd.block = true;
  }
}
