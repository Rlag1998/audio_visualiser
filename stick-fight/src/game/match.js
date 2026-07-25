// The match: two fighters, a floor, a clock, and the rules that connect them.
//
// Match.step() advances exactly one fixed tick. It is completely deterministic
// given a seed and a pair of controllers, which is what lets the same code run
// both the on-screen fight and the headless batch simulator.

import { ARENA, BODY, COMBAT, ROUND, TICK, PALETTES } from './config.js';
import { Fighter, STATE, makeCmd, clearCmd } from './fighter.js';
import { MOVE_IDS } from './moves.js';
import { makeRng } from '../core/rng.js';
import { dist2, segPointDist2, clamp } from '../core/math.js';

export const PHASE = {
  INTRO: 'intro',
  FIGHT: 'fight',
  KO: 'ko',
  ROUND_END: 'roundEnd',
  MATCH_END: 'matchEnd',
};

const START_X = 118;

function blankStats() {
  const byMove = {};
  for (const id of MOVE_IDS) byMove[id] = { thrown: 0, hit: 0, blocked: 0, damage: 0 };
  return {
    damageDealt: 0,
    damageTaken: 0,
    hits: 0,
    whiffs: 0,
    blocked: 0,
    parries: 0,
    knockdowns: 0,
    kos: 0,
    maxCombo: 0,
    byMove,
  };
}

export class Match {
  /**
   * @param {object} opts
   * @param {number} [opts.seed]
   * @param {object[]} [opts.fighters]  two fighter configs {name, archetype, palette}
   * @param {object[]} [opts.controllers] two controllers with update(self, foe, match)
   * @param {number} [opts.roundTime]
   * @param {number} [opts.winsNeeded]
   */
  constructor(opts = {}) {
    this.seed = opts.seed ?? 1;
    this.rng = makeRng(this.seed);
    this.roundTime = opts.roundTime ?? ROUND.time;
    this.winsNeeded = opts.winsNeeded ?? ROUND.winsNeeded;

    const cfg = opts.fighters ?? [{}, {}];
    this.fighters = [
      new Fighter({
        id: 'p1',
        name: cfg[0].name ?? 'Blue',
        archetype: cfg[0].archetype ?? 'duelist',
        palette: cfg[0].palette ?? PALETTES[0],
        x: -START_X,
        facing: 1,
      }),
      new Fighter({
        id: 'p2',
        name: cfg[1].name ?? 'Red',
        archetype: cfg[1].archetype ?? 'brawler',
        palette: cfg[1].palette ?? PALETTES[2],
        x: START_X,
        facing: -1,
      }),
    ];

    this.controllers = opts.controllers ?? [null, null];
    this.cmds = [makeCmd(), makeCmd()];
    this.stats = [blankStats(), blankStats()];

    this.round = 1;
    this.phase = PHASE.INTRO;
    this.phaseT = ROUND.introFrames;
    this.timeLeft = this.roundTime;
    this.frame = 0;
    this.events = [];
    this.announce = null;
    this.winner = null; // 0 | 1 | null (draw)
    this.lastRoundResult = null;

    this._setAnnounce(`ROUND ${this.round}`, ROUND.introFrames);
  }

  get p1() { return this.fighters[0]; }
  get p2() { return this.fighters[1]; }
  get isOver() { return this.phase === PHASE.MATCH_END; }

  setControllers(a, b) {
    this.controllers = [a, b];
  }

  _setAnnounce(text, frames, tone = 'normal') {
    this.announce = { text, frames, total: frames, tone };
  }

  // ------------------------------------------------------------------- update

  step(dt = TICK) {
    this.events.length = 0;
    this.frame++;

    if (this.announce) {
      this.announce.frames--;
      if (this.announce.frames <= 0) this.announce = null;
    }

    switch (this.phase) {
      case PHASE.INTRO:
        this._stepIntro(dt);
        break;
      case PHASE.FIGHT:
        this._stepFight(dt);
        break;
      case PHASE.KO:
        this._stepKo(dt);
        break;
      case PHASE.ROUND_END:
        this._stepRoundEnd(dt);
        break;
      case PHASE.MATCH_END:
        this._stepIdle(dt);
        break;
      default:
        break;
    }
    return this.events;
  }

  _stepIntro(dt) {
    this._stepIdle(dt);
    this.phaseT--;
    if (this.phaseT === Math.floor(ROUND.introFrames * 0.4)) {
      this._setAnnounce('FIGHT!', 45, 'go');
      this.events.push({ type: 'announce', text: 'FIGHT!' });
    }
    if (this.phaseT <= 0) {
      this.phase = PHASE.FIGHT;
    }
  }

  /** Fighters keep breathing but take no input. */
  _stepIdle(dt) {
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      clearCmd(this.cmds[i]);
      f.update(dt, this.cmds[i], this);
    }
    this._faceOff();
    this._separate();
  }

  _stepFight(dt) {
    // 1. controllers decide
    for (let i = 0; i < 2; i++) {
      const ctrl = this.controllers[i];
      const cmd = this.cmds[i];
      clearCmd(cmd);
      if (ctrl) ctrl.update(cmd, this.fighters[i], this.fighters[1 - i], this);
    }

    // 2. fighters advance
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      f.update(dt, this.cmds[i], this);
      for (const ev of f.events) {
        if (ev.type === 'swing') this.noteThrow(i, ev.move.id);
        else if (ev.type === 'whiff') this.stats[i].whiffs++;
        this.events.push({ ...ev, fighter: f, index: i });
      }
    }

    // 3. world constraints
    this._faceOff();
    this._separate();

    // 4. combat
    this._resolveHits(0, 1);
    this._resolveHits(1, 0);

    // 5. clock
    this.timeLeft = Math.max(0, this.timeLeft - dt);

    // 6. round end conditions
    const koIdx = this.fighters.findIndex((f) => f.state === STATE.KO);
    if (koIdx >= 0) {
      this.stats[1 - koIdx].kos++;
      this._beginKo(1 - koIdx);
      return;
    }
    if (this.timeLeft <= 0) {
      const a = this.p1.health;
      const b = this.p2.health;
      const winner = a === b ? null : a > b ? 0 : 1;
      this._setAnnounce('TIME UP', 90, 'time');
      this.events.push({ type: 'timeup' });
      this._endRound(winner, 'time');
    }
  }

  _beginKo(winnerIdx) {
    this.phase = PHASE.KO;
    this.phaseT = ROUND.koFrames;
    this._setAnnounce('K.O.', ROUND.koFrames, 'ko');
    // Note: named distinctly from the fighter-level 'ko' event, which carries a
    // `fighter` reference that consumers rely on.
    this.events.push({ type: 'roundKo', winner: winnerIdx });
    this._pendingWinner = winnerIdx;
  }

  _stepKo(dt) {
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const cmd = clearCmd(this.cmds[i]);
      f.update(dt, cmd, this);
    }
    this._separate();
    this.phaseT--;
    if (this.phaseT <= 0) this._endRound(this._pendingWinner, 'ko');
  }

  _endRound(winnerIdx, reason) {
    this.lastRoundResult = { round: this.round, winner: winnerIdx, reason };
    if (winnerIdx !== null && winnerIdx !== undefined) {
      this.fighters[winnerIdx].wins++;
      this.fighters[winnerIdx].state = STATE.VICTORY;
    }
    this.phase = PHASE.ROUND_END;
    this.phaseT = ROUND.roundEndFrames;

    const champion = this.fighters.findIndex((f) => f.wins >= this.winsNeeded);
    if (champion >= 0) {
      this.winner = champion;
      this._setAnnounce(`${this.fighters[champion].name} WINS`, ROUND.roundEndFrames, 'win');
      this.events.push({ type: 'matchEnd', winner: champion });
    }
  }

  _stepRoundEnd(dt) {
    this._stepIdle(dt);
    this.phaseT--;
    if (this.phaseT > 0) return;

    if (this.winner !== null) {
      this.phase = PHASE.MATCH_END;
      return;
    }
    this._nextRound();
  }

  /** Reset the current round in place, keeping the score. Used by training mode. */
  restartRound() {
    this.p1.resetRound(-START_X, 1);
    this.p2.resetRound(START_X, -1);
    this.timeLeft = this.roundTime;
    this.phase = PHASE.FIGHT;
    this.phaseT = 0;
    this.announce = null;
    this._pendingWinner = null;
  }

  _nextRound() {
    this.round++;
    this.p1.resetRound(-START_X, 1);
    this.p2.resetRound(START_X, -1);
    this.timeLeft = this.roundTime;
    this.phase = PHASE.INTRO;
    this.phaseT = ROUND.introFrames;
    this._setAnnounce(`ROUND ${this.round}`, ROUND.introFrames);
    this.events.push({ type: 'roundStart', round: this.round });
  }

  // ------------------------------------------------------------- world rules

  /** Fighters always turn to face each other while they are free to move. */
  _faceOff() {
    const [a, b] = this.fighters;
    const dx = b.x - a.x;
    if (Math.abs(dx) < 1) return;
    const dir = dx > 0 ? 1 : -1;
    if (this._canTurn(a)) a.facing = dir;
    if (this._canTurn(b)) b.facing = -dir;
  }

  _canTurn(f) {
    return (
      f.state === STATE.IDLE ||
      f.state === STATE.WALK ||
      f.state === STATE.CROUCH ||
      f.state === STATE.BLOCK ||
      f.state === STATE.LAND
    );
  }

  /** Soft body collision so fighters cannot occupy the same space. */
  _separate() {
    const [a, b] = this.fighters;
    if (a.isDown || b.isDown) return;
    const minGap = BODY.bodyR * 2;
    const dx = b.x - a.x;
    const d = Math.abs(dx);
    if (d >= minGap || d < 1e-6) return;

    const push = (minGap - d) / 2;
    const dir = dx > 0 ? 1 : -1;
    const limit = ARENA.halfWidth - ARENA.wallMargin;
    a.x = clamp(a.x - dir * push, -limit, limit);
    b.x = clamp(b.x + dir * push, -limit, limit);

    // If one of them is pinned to a wall, shove the other one the whole way.
    if (Math.abs(a.x) >= limit - 0.01) b.x = clamp(a.x + dir * minGap, -limit, limit);
    else if (Math.abs(b.x) >= limit - 0.01) a.x = clamp(b.x - dir * minGap, -limit, limit);
  }

  _resolveHits(ai, di) {
    const attacker = this.fighters[ai];
    const defender = this.fighters[di];
    if (!attacker.moveActive || attacker.moveHit) return;

    const move = attacker.move;
    const joint = attacker.skeleton.joints[move.hitJoint];
    if (!joint) return;

    const contact = overlapVolume(joint.x, joint.y, move.hitR, defender.volumes);
    if (!contact) return;

    const result = defender.receiveAttack(move, attacker, contact);
    if (!result) return;

    attacker.onHitLanded(result);
    this._recordHit(ai, di, result);
    this.events.push({
      type: 'contact',
      result: result.type,
      damage: result.damage,
      counter: !!result.counter,
      x: result.x,
      y: result.y,
      dir: defender.x >= attacker.x ? 1 : -1,
      move,
      attacker,
      defender,
      attackerIndex: ai,
    });
  }

  _recordHit(ai, di, result) {
    const sa = this.stats[ai];
    const sd = this.stats[di];
    const mv = sa.byMove[result.move.id];

    switch (result.type) {
      case 'block':
      case 'guardBreak':
        sa.blocked++;
        if (mv) mv.blocked++;
        break;
      case 'parry':
        sd.parries++;
        break;
      default:
        sa.hits++;
        if (mv) mv.hit++;
        break;
    }
    if (result.damage > 0) {
      sa.damageDealt += result.damage;
      sd.damageTaken += result.damage;
      if (mv) mv.damage += result.damage;
    }
    if (result.type === 'knockdown' || result.type === 'ko') sa.knockdowns++;
    sa.maxCombo = Math.max(sa.maxCombo, this.fighters[ai].combo);
  }

  /** Called by controllers when they commit to a move, for whiff accounting. */
  noteThrow(index, moveId) {
    const s = this.stats[index];
    if (s.byMove[moveId]) s.byMove[moveId].thrown++;
  }

  summary() {
    return {
      seed: this.seed,
      rounds: this.round,
      frames: this.frame,
      winner: this.winner,
      names: [this.p1.name, this.p2.name],
      wins: [this.p1.wins, this.p2.wins],
      health: [Math.round(this.p1.health), Math.round(this.p2.health)],
      stats: this.stats,
    };
  }
}

/**
 * Circle-vs-hurtvolume test. Returns the contact point (on the volume) or null.
 * Kept as a free function so the batch simulator can reuse it in isolation.
 */
export function overlapVolume(x, y, r, volumes) {
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i];
    if (v.kind === 'circle') {
      const rr = r + v.r;
      if (dist2(x, y, v.x, v.y) <= rr * rr) {
        return { x: (x + v.x) / 2, y: (y + v.y) / 2, zone: v.zone };
      }
    } else {
      const rr = r + v.r;
      if (segPointDist2(v.ax, v.ay, v.bx, v.by, x, y) <= rr * rr) {
        return { x, y, zone: v.zone };
      }
    }
  }
  return null;
}
