// Unit tests for the fight engine. Everything under src/core, src/game and
// src/sim is DOM-free by design, so it all runs directly under `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Fighter, STATE, makeCmd } from '../src/game/fighter.js';
import { MOVES, MOVE_IDS, MOVE_REACH, sampleTrack, totalFrames } from '../src/game/moves.js';
import { POSE_KEYS, POSES, STANCE, blendPose, resolvePose } from '../src/game/pose.js';
import { Skeleton, solveIK, hurtVolumes, JOINT_NAMES } from '../src/game/skeleton.js';
import { Ragdoll } from '../src/game/ragdoll.js';
import { ARENA, BODY, COMBAT, STATS, TICK } from '../src/game/config.js';
import { makeRng } from '../src/core/rng.js';
import { segPointDist2 } from '../src/core/math.js';
import { measureAll } from '../src/sim/reach.mjs';

// ---------------------------------------------------------------- move data

test('every move has coherent frame data', () => {
  for (const id of MOVE_IDS) {
    const m = MOVES[id];
    assert.equal(m.id, id, `${id}: id field must match its key`);
    assert.ok(m.startup > 0 && m.active > 0 && m.recovery > 0, `${id}: needs all three phases`);
    assert.ok(m.damage > 0, `${id}: needs damage`);
    assert.ok(['high', 'mid', 'low'].includes(m.height), `${id}: bad height "${m.height}"`);
    assert.ok(JOINT_NAMES.includes(m.hitJoint), `${id}: hitJoint "${m.hitJoint}" is not a joint`);
    assert.ok(MOVE_REACH[id] > 0, `${id}: missing a reach entry`);
    assert.ok(m.hitstun >= m.blockstun, `${id}: hitstun should beat blockstun`);
  }
});

test('move pose tracks are sorted, normalised and complete', () => {
  for (const id of MOVE_IDS) {
    const m = MOVES[id];
    assert.ok(m.track.length >= 2, `${id}: needs at least two keys`);
    assert.equal(m.track[0].t, 0, `${id}: track must start at t=0`);
    assert.equal(m.track[m.track.length - 1].t, 1, `${id}: track must end at t=1`);
    for (let i = 1; i < m.track.length; i++) {
      assert.ok(m.track[i].t > m.track[i - 1].t, `${id}: track keys must increase`);
    }
    for (const key of m.track) {
      for (const k of POSE_KEYS) {
        assert.equal(typeof key.pose[k], 'number', `${id}: key at t=${key.t} missing "${k}"`);
      }
    }
  }
});

test('sampleTrack stays finite across the whole move and clamps outside it', () => {
  const out = {};
  for (const id of MOVE_IDS) {
    const m = MOVES[id];
    for (let i = -2; i <= 22; i++) {
      sampleTrack(m, i / 20, out);
      for (const k of POSE_KEYS) {
        assert.ok(Number.isFinite(out[k]), `${id}: ${k} not finite at t=${i / 20}`);
      }
    }
  }
});

test('kicks out-range punches, as the design intends', () => {
  assert.ok(MOVE_REACH.highKick > MOVE_REACH.cross, 'the longest kick should beat the longest punch');
  assert.ok(MOVE_REACH.lowKick > MOVE_REACH.hook);
  assert.ok(MOVE_REACH.uppercut < MOVE_REACH.cross, 'uppercut is the short-range launcher');
});

test('MOVE_REACH matches where the hitbox actually goes', () => {
  // The AI decides whether to throw a move by comparing the gap against
  // MOVE_REACH. When the table and the skeleton disagree the AI throws attacks
  // that physically cannot land — which is exactly what happened when the pose
  // tracks were timed by hand and the limb was still tucked during the active
  // frames. This keeps the two honest.
  for (const { id, reach } of measureAll()) {
    const declared = MOVE_REACH[id];
    assert.ok(
      Math.abs(reach - declared) <= 6,
      `${id}: MOVE_REACH says ${declared} but the hitbox reaches ${reach.toFixed(1)}`,
    );
  }
});

test('every attack has its hitbox where it can hit something', () => {
  // A hurtbox stack runs from the floor to about y=126. A hitbox entirely
  // outside that band is unhittable no matter how the frame data reads.
  for (const { id, low, high } of measureAll()) {
    assert.ok(high > 0, `${id}: hitbox never rises above the floor`);
    assert.ok(low < 140, `${id}: hitbox sits above everything it could hit`);
    if (MOVES[id].height === 'low') {
      assert.ok(low < 45, `${id} is a low, but its hitbox starts at y=${low.toFixed(0)}`);
    }
  }
});

test('the limb is fully extended while the hitbox is live', () => {
  // Guards the buildTrack timing: the strike keyframe must bracket the active
  // window, not land after it.
  for (const id of MOVE_IDS) {
    const m = MOVES[id];
    const total = m.startup + m.active + m.recovery;
    const strikeKeys = m.track.filter((k, i) => i === 2 || i === 3);
    assert.equal(strikeKeys.length, 2);
    assert.ok(
      strikeKeys[0].t <= m.startup / total + 1e-9,
      `${id}: full extension arrives after the hitbox turns on`,
    );
    assert.ok(
      strikeKeys[1].t >= (m.startup + m.active) / total - 1e-9 || strikeKeys[1].t >= 0.97,
      `${id}: extension ends before the hitbox turns off`,
    );
  }
});

// ------------------------------------------------------------------- poses

test('pose blending covers every key and hits both endpoints', () => {
  const a = POSES.idle;
  const b = POSES.crouch;
  const mid = blendPose(a, b, 0.5, {});
  for (const k of POSE_KEYS) {
    assert.ok(Number.isFinite(mid[k]));
    assert.equal(mid[k], (a[k] + b[k]) / 2, `key ${k} did not blend`);
  }
  const start = blendPose(a, b, 0, {});
  const end = blendPose(a, b, 1, {});
  for (const k of POSE_KEYS) {
    assert.equal(start[k], a[k]);
    assert.equal(end[k], b[k]);
  }
});

test('resolvePose fills gaps from the stance', () => {
  const p = resolvePose({ hipY: 12 }, STANCE);
  assert.equal(p.hipY, 12);
  assert.equal(p.torso, STANCE.torso);
  for (const k of POSE_KEYS) assert.equal(typeof p[k], 'number');
});

// -------------------------------------------------------------------- IK

test('two-bone IK reaches its target and keeps both bone lengths', () => {
  const knee = { x: 0, y: 0 };
  const foot = { x: 0, y: 0 };
  const rng = makeRng(99);
  for (let i = 0; i < 400; i++) {
    const hx = rng.range(-50, 50);
    const hy = rng.range(20, 90);
    const tx = rng.range(-70, 70);
    const ty = rng.range(0, 60);
    solveIK(hx, hy, tx, ty, BODY.thigh, BODY.shin, 1, knee, foot);

    const l1 = Math.hypot(knee.x - hx, knee.y - hy);
    const l2 = Math.hypot(foot.x - knee.x, foot.y - knee.y);
    assert.ok(Math.abs(l1 - BODY.thigh) < 0.05, `thigh length drifted: ${l1}`);
    assert.ok(Math.abs(l2 - BODY.shin) < 0.05, `shin length drifted: ${l2}`);

    // Within reach, the foot must land exactly on the target.
    const reach = Math.hypot(tx - hx, ty - hy);
    if (reach < (BODY.thigh + BODY.shin) * 0.99) {
      assert.ok(Math.hypot(foot.x - tx, foot.y - ty) < 0.05, 'foot missed a reachable target');
    }
  }
});

test('IK survives degenerate and unreachable targets', () => {
  const knee = { x: 0, y: 0 };
  const foot = { x: 0, y: 0 };
  solveIK(10, 50, 10, 50, BODY.thigh, BODY.shin, 1, knee, foot); // target on the hip
  assert.ok(Number.isFinite(knee.x) && Number.isFinite(knee.y));
  solveIK(0, 50, 9999, 50, BODY.thigh, BODY.shin, 1, knee, foot); // far out of reach
  assert.ok(Number.isFinite(knee.x) && Number.isFinite(foot.x));
  assert.ok(Math.hypot(foot.x, foot.y - 50) <= BODY.thigh + BODY.shin + 0.1, 'limb over-extended');
});

test('skeleton mirrors cleanly when facing flips', () => {
  const s = new Skeleton();
  const right = { ...s.solve(POSES.idle, 0, 0, 1) };
  const rightHand = { x: right.handF.x, y: right.handF.y };
  const left = s.solve(POSES.idle, 0, 0, -1);
  assert.ok(Math.abs(left.handF.x + rightHand.x) < 1e-9, 'x should mirror');
  assert.ok(Math.abs(left.handF.y - rightHand.y) < 1e-9, 'y should not');
});

test('stance keeps both feet on the floor and the head above the hips', () => {
  const s = new Skeleton();
  const j = s.solve(POSES.idle, 0, 0, 1);
  assert.ok(Math.abs(j.footF.y) < 1.5, `front foot floating/sunk at y=${j.footF.y}`);
  assert.ok(Math.abs(j.footB.y) < 1.5, `back foot floating/sunk at y=${j.footB.y}`);
  assert.ok(j.head.y > j.neck.y && j.neck.y > j.hip.y);
});

test('hurt volumes cover head, torso and legs', () => {
  const s = new Skeleton();
  const j = s.solve(POSES.idle, 0, 0, 1);
  const vols = hurtVolumes(j);
  const zones = new Set(vols.map((v) => v.zone));
  assert.ok(zones.has('high') && zones.has('mid') && zones.has('low'));
  for (const v of vols) {
    assert.ok(v.r > 0);
    if (v.kind === 'capsule') assert.ok(Number.isFinite(segPointDist2(v.ax, v.ay, v.bx, v.by, 0, 0)));
  }
});

// ---------------------------------------------------------------- fighters

function makePair() {
  const a = new Fighter({ id: 'a', name: 'A', archetype: 'duelist', x: -40, facing: 1 });
  const b = new Fighter({ id: 'b', name: 'B', archetype: 'duelist', x: 40, facing: -1 });
  return [a, b];
}

/** Put a fighter into a guard state without going through the input layer. */
function guard(f, { crouch = false, parry = false, age = 99 } = {}) {
  f.state = STATE.BLOCK;
  f.blockCrouch = crouch;
  f.parryArmed = parry;
  f.blockAge = age;
  f._blockHeld = true;
}

test('standing guard stops highs, crouching guard stops lows', () => {
  const contact = { x: 0, y: 90 };

  const [a, b] = makePair();
  guard(b);
  assert.equal(b.receiveAttack(MOVES.jab, a, contact).type, 'block', 'standing blocks a high');
  assert.equal(b.receiveAttack(MOVES.uppercut, a, contact).type, 'block', 'standing blocks a mid');

  const [c, d] = makePair();
  guard(d);
  assert.equal(d.receiveAttack(MOVES.sweep, c, contact).type, 'knockdown', 'standing eats a low');

  const [e, f] = makePair();
  guard(f, { crouch: true });
  assert.equal(f.receiveAttack(MOVES.lowKick, e, contact).type, 'block', 'crouching blocks a low');
  assert.equal(f.receiveAttack(MOVES.uppercut, e, contact).type, 'block', 'crouching blocks a mid');

  const [g, h] = makePair();
  guard(h, { crouch: true });
  assert.equal(h.receiveAttack(MOVES.highKick, g, contact).type, 'hit', 'crouching eats a high');
});

test('a parry needs both intent and a fresh guard', () => {
  const contact = { x: 0, y: 90 };

  const [a, b] = makePair();
  guard(b, { parry: true, age: 0 });
  assert.equal(b.receiveAttack(MOVES.jab, a, contact).type, 'parry');
  assert.equal(a.state, STATE.STUN, 'a parry must punish the attacker');

  // Same timing, no intent -> ordinary block.
  const [c, d] = makePair();
  guard(d, { parry: false, age: 0 });
  assert.equal(d.receiveAttack(MOVES.jab, c, contact).type, 'block');

  // Intent, but the guard has been held too long.
  const [e, f] = makePair();
  guard(f, { parry: true, age: COMBAT.parryWindow + 1 });
  assert.equal(f.receiveAttack(MOVES.jab, e, contact).type, 'block');
});

test('holding block does not re-arm the parry window (regression)', () => {
  const [a, b] = makePair();
  const cmd = makeCmd();
  cmd.block = true;
  cmd.parry = true;

  // First press arms the parry.
  b.update(TICK, cmd, null);
  assert.equal(b.blockAge, 0);
  assert.equal(b.parryArmed, true);

  // Eat a hit, sit in blockstun, keep holding — the window must not reopen.
  b.receiveAttack(MOVES.jab, a, { x: 0, y: 90 });
  for (let i = 0; i < 40; i++) b.update(TICK, cmd, null);
  assert.ok(b.blockAge > COMBAT.parryWindow, `blockAge reset to ${b.blockAge} while holding guard`);
  assert.equal(b.receiveAttack(MOVES.jab, a, { x: 0, y: 90 }).type, 'block');
});

test('knockback decays even when the victim was walking (regression)', () => {
  // `_driving` used to survive the transition into HURT, which told the physics
  // step the fighter was moving under its own power and skipped ground
  // friction — so a fighter hit mid-walk slid at full knockback speed.
  const [a, b] = makePair();
  const walk = makeCmd();
  walk.x = -1;
  for (let i = 0; i < 5; i++) b.update(TICK, walk, null);
  assert.equal(b.state, STATE.WALK);

  b.receiveAttack(MOVES.cross, a, { x: 0, y: 90 });
  const launch = Math.abs(b.vx);
  assert.ok(launch > 50, 'expected real knockback to measure decay against');

  const idle = makeCmd();
  b.hitstop = 0;
  for (let i = 0; i < 8; i++) b.update(TICK, idle, null);
  assert.ok(Math.abs(b.vx) < launch * 0.85, `knockback did not decay: ${launch} -> ${Math.abs(b.vx)}`);
});

test('chip damage can finish a round', () => {
  const [a, b] = makePair();
  b.health = 0.5;
  guard(b);
  const r = b.receiveAttack(MOVES.hook, a, { x: 0, y: 90 });
  assert.equal(r.type, 'ko', 'a blocked hit on an empty health bar must still end it');
  assert.equal(r.chip, true);
  assert.equal(b.health, 0);
  assert.equal(b.state, STATE.KO);
});

test('guard breaks when the guard meter runs out', () => {
  const [a, b] = makePair();
  let broke = false;
  for (let i = 0; i < 30 && !broke; i++) {
    guard(b);
    const r = b.receiveAttack(MOVES.hook, a, { x: 0, y: 90 });
    if (r.type === 'guardBreak') broke = true;
  }
  assert.ok(broke, 'repeated blocking should eventually break the guard');
  assert.equal(b.state, STATE.STUN);
});

test('the finisher breaks a guard outright and cannot be parried', () => {
  const [a, b] = makePair();
  guard(b, { parry: true, age: 0 });
  const r = b.receiveAttack(MOVES.heavy, a, { x: 0, y: 90 });
  assert.equal(r.type, 'guardBreak');
});

test('knockdowns and KOs hand control to the ragdoll', () => {
  const [a, b] = makePair();
  assert.equal(b.receiveAttack(MOVES.sweep, a, { x: 0, y: 30 }).type, 'knockdown');
  assert.equal(b.state, STATE.DOWN);
  assert.ok(b.ragdoll.active);

  const [c, d] = makePair();
  d.health = 4;
  assert.equal(d.receiveAttack(MOVES.cross, c, { x: 0, y: 90 }).type, 'ko');
  assert.equal(d.state, STATE.KO);
  assert.equal(d.health, 0, 'health must never go negative');
  assert.ok(d.isDefeated && d.isDown);
});

test('a downed fighter gets back up, inside the arena, briefly invulnerable', () => {
  const [a, b] = makePair();
  b.receiveAttack(MOVES.sweep, a, { x: 0, y: 30 });
  for (let i = 0; i < 200 && b.state === STATE.DOWN; i++) b.update(TICK, makeCmd(), null);
  assert.equal(b.state, STATE.IDLE, 'never got up');
  assert.ok(b.invuln > 0, 'wake-up should be protected');
  assert.ok(Math.abs(b.x) <= ARENA.halfWidth, 'woke up outside the arena');
  assert.equal(b.ragdoll.active, false);
});

test('invulnerable and downed fighters cannot be hit', () => {
  const [a, b] = makePair();
  b.invuln = 10;
  assert.equal(b.receiveAttack(MOVES.jab, a, { x: 0, y: 90 }), null);
  b.invuln = 0;
  b.receiveAttack(MOVES.sweep, a, { x: 0, y: 30 });
  assert.equal(b.receiveAttack(MOVES.jab, a, { x: 0, y: 90 }), null, 'no hitting them while down');
});

test('combo scaling means later hits do less', () => {
  const [a, b] = makePair();
  const first = b.receiveAttack(MOVES.jab, a, { x: 0, y: 90 }).damage;
  a.combo = 6;
  b.state = STATE.IDLE;
  const later = b.receiveAttack(MOVES.jab, a, { x: 0, y: 90 }).damage;
  assert.ok(later < first, `combo scaling not applied (${later} >= ${first})`);
  assert.ok(later >= first * COMBAT.minComboScale * 0.9, 'scaling floor not respected');
});

test('attacks cost stamina and exhaustion locks them out', () => {
  const f = new Fighter({ x: 0, facing: 1 });
  const before = f.stamina;
  f._startAttack('highKick', 0);
  assert.ok(f.stamina < before);
  f.stamina = 1;
  f._timers(TICK);
  assert.equal(f.exhausted, true);
  assert.equal(f.canAttack('jab'), false, 'exhausted fighters cannot attack');
});

test('the finisher needs a full meter', () => {
  const f = new Fighter({ x: 0, facing: 1 });
  f.meter = 0;
  assert.equal(f.canAttack('heavy'), false);
  f.meter = STATS.maxMeter;
  assert.equal(f.canAttack('heavy'), true);
});

test('air moves are air-only and ground moves are ground-only', () => {
  const f = new Fighter({ x: 0, facing: 1 });
  assert.equal(f.canAttack('airKick'), false, 'no air kick on the ground');
  assert.equal(f.canAttack('jab'), true);
  f.grounded = false;
  assert.equal(f.canAttack('airKick'), true);
  assert.equal(f.canAttack('jab'), false, 'no ground jab in the air');
});

test('a fighter stays inside the arena however hard it is hit', () => {
  const f = new Fighter({ x: 0, facing: 1 });
  const cmd = makeCmd();
  f.vx = 99999;
  for (let i = 0; i < 400; i++) f.update(TICK, cmd, null);
  assert.ok(Math.abs(f.x) <= ARENA.halfWidth - ARENA.wallMargin + 0.001, `escaped to x=${f.x}`);
  f.vx = -99999;
  for (let i = 0; i < 400; i++) f.update(TICK, cmd, null);
  assert.ok(Math.abs(f.x) <= ARENA.halfWidth - ARENA.wallMargin + 0.001, `escaped to x=${f.x}`);
});

test('a jump comes back down', () => {
  const f = new Fighter({ x: 0, facing: 1 });
  const cmd = makeCmd();
  cmd.jump = true;
  f.update(TICK, cmd, null);
  assert.equal(f.grounded, false);
  cmd.jump = false;
  let peak = 0;
  for (let i = 0; i < 240 && !f.grounded; i++) {
    f.update(TICK, cmd, null);
    peak = Math.max(peak, f.y);
  }
  assert.ok(f.grounded, 'still airborne after 4 seconds');
  assert.ok(peak > 40, `jump barely left the floor (${peak})`);
  assert.equal(f.y, 0);
});

// ------------------------------------------------------------------ ragdoll

test('ragdoll keeps its bones, stays on the floor and inside the walls', () => {
  const s = new Skeleton();
  const joints = s.solve(POSES.idle, 0, 0, 1);
  const rag = new Ragdoll();
  rag.seed(joints, 900, 500, 0.4, TICK);

  const rest = rag.links.map((l) => l.len);
  for (let i = 0; i < 600; i++) rag.step(TICK);

  for (const name of JOINT_NAMES) {
    const p = rag.points[name];
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${name} went non-finite`);
    assert.ok(p.y >= -0.6, `${name} sank through the floor (y=${p.y})`);
    assert.ok(Math.abs(p.x) <= ARENA.halfWidth, `${name} left the arena (x=${p.x})`);
  }
  rag.links.forEach((l, i) => {
    if (l.k < 1) return; // soft shape-keepers are allowed to stretch
    const d = Math.hypot(rag.points[l.b].x - rag.points[l.a].x, rag.points[l.b].y - rag.points[l.a].y);
    assert.ok(Math.abs(d - rest[i]) < rest[i] * 0.25 + 1, `bone ${l.a}-${l.b} stretched to ${d} from ${rest[i]}`);
  });
  assert.ok(rag.settled, 'ragdoll should come to rest within 10 seconds');
});

// ---------------------------------------------------------------------- rng

test('seeded RNG replays exactly and spreads across the unit interval', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 5000; i++) {
    const v = a.next();
    assert.equal(v, b.next());
    assert.ok(v >= 0 && v < 1);
    buckets[Math.floor(v * 10)]++;
  }
  for (const n of buckets) assert.ok(n > 300, `bucket badly under-filled: ${n}`);
});

test('weighted picks respect zero weights', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 200; i++) {
    assert.notEqual(rng.weighted(['a', 'b', 'c'], [1, 0, 1]), 'b');
  }
  assert.equal(rng.weighted(['only'], [0]), 'only', 'all-zero weights still return something');
});
