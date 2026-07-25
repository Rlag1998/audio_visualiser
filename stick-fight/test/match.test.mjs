// Whole-match invariants. These are the tests that would catch a fight that
// hangs, drifts out of the arena, or stops being reproducible.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Match, PHASE, overlapVolume } from '../src/game/match.js';
import { AIController, DummyController } from '../src/game/ai.js';
import { STATE } from '../src/game/fighter.js';
import { JOINT_NAMES } from '../src/game/skeleton.js';
import { ARCHETYPE_IDS, ARENA, DIFFICULTY_IDS, STATS, TICK } from '../src/game/config.js';
import { simulateMatch, runBatch, buildMatch, roundRobin } from '../src/sim/batch.js';
import { makeRng } from '../src/core/rng.js';

const MAX_FRAMES = 60 * 60 * 6;

function play(opts = {}) {
  const match = buildMatch(opts);
  let frames = 0;
  while (!match.isOver && frames < MAX_FRAMES) {
    match.step(TICK);
    frames++;
  }
  return { match, frames };
}

test('a match always reaches a conclusion', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { match, frames } = play({ seed, a: { archetype: 'boxer' }, b: { archetype: 'brawler' } });
    assert.equal(match.phase, PHASE.MATCH_END, `seed ${seed} never finished`);
    assert.ok(frames < MAX_FRAMES, `seed ${seed} hit the frame ceiling`);
    assert.ok(match.winner === 0 || match.winner === 1, `seed ${seed} ended with no winner`);
    assert.ok(match.fighters[match.winner].wins >= match.winsNeeded);
  }
});

test('the same seed replays exactly', () => {
  for (const seed of [3, 17, 2024]) {
    const a = simulateMatch({ seed, a: { archetype: 'kickboxer' }, b: { archetype: 'duelist' } });
    const b = simulateMatch({ seed, a: { archetype: 'kickboxer' }, b: { archetype: 'duelist' } });
    assert.deepEqual(a, b, `seed ${seed} was not reproducible`);
  }
});

test('different seeds produce genuinely different fights', () => {
  const results = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const s = simulateMatch({ seed, a: { archetype: 'boxer' }, b: { archetype: 'kickboxer' } });
    results.add(`${s.winner}:${s.frames}:${s.health.join('/')}`);
  }
  assert.ok(results.size > 18, `only ${results.size}/24 distinct outcomes — RNG is not reaching the fight`);
});

test('nothing goes NaN and nobody leaves the arena', () => {
  const match = buildMatch({ seed: 991, a: { archetype: 'brawler' }, b: { archetype: 'kickboxer' } });
  const limit = ARENA.halfWidth + 4;
  let frames = 0;
  while (!match.isOver && frames < MAX_FRAMES) {
    match.step(TICK);
    frames++;
    for (const f of match.fighters) {
      assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y), `frame ${frames}: position went NaN`);
      assert.ok(Number.isFinite(f.vx) && Number.isFinite(f.vy), `frame ${frames}: velocity went NaN`);
      assert.ok(Math.abs(f.x) <= limit, `frame ${frames}: ${f.name} escaped to x=${f.x}`);
      assert.ok(f.y >= -0.001, `frame ${frames}: ${f.name} fell through the floor`);
      assert.ok(f.health >= 0 && f.health <= STATS.maxHealth, `frame ${frames}: health=${f.health}`);
      assert.ok(f.stamina >= 0 && f.stamina <= STATS.maxStamina + 0.001, `frame ${frames}: stamina=${f.stamina}`);
      assert.ok(f.meter >= 0 && f.meter <= STATS.maxMeter + 0.001, `frame ${frames}: meter=${f.meter}`);

      if (frames % 17 === 0) {
        const j = f.drawJoints;
        for (const n of JOINT_NAMES) {
          assert.ok(Number.isFinite(j[n].x) && Number.isFinite(j[n].y), `frame ${frames}: joint ${n} NaN`);
        }
      }
    }
  }
  assert.ok(match.isOver);
});

test('fighters never overlap and always face each other', () => {
  const match = buildMatch({ seed: 55 });
  let checked = 0;
  for (let i = 0; i < 4000 && !match.isOver; i++) {
    match.step(TICK);
    const [a, b] = match.fighters;
    if (a.isDown || b.isDown) continue;
    assert.ok(Math.abs(a.x - b.x) > 29, `fighters merged at gap ${Math.abs(a.x - b.x)}`);
    if (a.canAct() && b.canAct() && Math.abs(a.x - b.x) > 2) {
      assert.equal(a.facing, b.x > a.x ? 1 : -1, 'p1 turned its back');
      assert.equal(b.facing, a.x > b.x ? 1 : -1, 'p2 turned its back');
      checked++;
    }
  }
  assert.ok(checked > 50, 'facing was never actually exercised');
});

test('rounds are scored and the match ends at the win limit', () => {
  const { match } = play({ seed: 8 });
  const total = match.p1.wins + match.p2.wins;
  assert.ok(total >= match.winsNeeded && total <= match.winsNeeded * 2 - 1, `odd round tally: ${total}`);
  assert.ok(match.round <= match.winsNeeded * 2 - 1, `too many rounds: ${match.round}`);
});

test('a fighter with no controller just stands there', () => {
  const match = new Match({ seed: 5 });
  match.setControllers(null, null);
  for (let i = 0; i < 600; i++) match.step(TICK);
  assert.equal(match.p1.health, STATS.maxHealth);
  assert.equal(match.p2.health, STATS.maxHealth);
  assert.equal(match.p1.state, STATE.IDLE);
});

test('a training dummy that only blocks still takes chip damage', () => {
  const match = new Match({ seed: 11 });
  match.setControllers(
    new AIController({ difficulty: 'master', rng: makeRng(3) }),
    new DummyController({ block: true }),
  );
  for (let i = 0; i < 3000 && !match.isOver; i++) match.step(TICK);
  assert.ok(match.p2.health < STATS.maxHealth, 'the attacker never connected at all');
  assert.ok(match.stats[0].hits + match.stats[0].blocked > 5, 'no offence happened');
});

test('every archetype and difficulty combination runs clean', () => {
  for (const arch of ARCHETYPE_IDS) {
    for (const diff of DIFFICULTY_IDS) {
      const s = simulateMatch({
        seed: 404,
        a: { archetype: arch, difficulty: diff },
        b: { archetype: 'duelist', difficulty: 'veteran' },
      });
      assert.equal(s.timedOut, false, `${arch}/${diff} timed out`);
      assert.ok(s.winner === 0 || s.winner === 1, `${arch}/${diff} produced no winner`);
    }
  }
});

test('stronger difficulty wins more often', () => {
  const rep = runBatch({
    matches: 40,
    seed: 202,
    a: { archetype: 'duelist', difficulty: 'rookie' },
    b: { archetype: 'duelist', difficulty: 'master' },
  });
  assert.ok(
    rep.sides[1].winRate > 0.7,
    `master only won ${rep.sides[1].winRate * 100}% against rookie — the difficulty curve is broken`,
  );
});

test('batch reports add up', () => {
  const rep = runBatch({ matches: 20, seed: 77 });
  assert.equal(rep.matches, 20);
  assert.equal(rep.sides[0].matchWins + rep.sides[1].matchWins + rep.draws, 20);
  assert.ok(rep.avgMatchSeconds > 1 && rep.avgMatchSeconds < 200);
  assert.equal(rep.timeouts, 0);
  for (const side of rep.sides) {
    assert.ok(side.moves.length > 0);
    for (const m of side.moves) {
      assert.ok(m.hit + m.blocked <= m.thrown, `${m.id}: landed more than it threw`);
      assert.ok(m.hitRate >= 0 && m.hitRate <= 1);
    }
  }
});

test('no archetype is grossly over- or under-powered', () => {
  // A guard rail, not a precision instrument. Tuned balance sits within ~2
  // points of even (see `npm run balance`), but a single 30-match-per-pairing
  // round robin has a standard deviation of several points, so the band here is
  // deliberately wide: it catches "someone set defenseMul to 0.5", not drift.
  const totals = new Map();
  for (const seed of [12345, 999]) {
    for (const row of roundRobin({ matchesPerPair: 30, difficulty: 'veteran', seed })) {
      const prev = totals.get(row.archetype) ?? [];
      prev.push(row.winRate);
      totals.set(row.archetype, prev);
    }
  }
  assert.equal(totals.size, 4);
  for (const [id, rates] of totals) {
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    assert.ok(
      mean > 0.35 && mean < 0.65,
      `${id} won ${(mean * 100).toFixed(1)}% of its round robin — the roster is badly skewed`,
    );
  }
});

test('overlapVolume detects contact and reports a sane point', () => {
  const vols = [
    { kind: 'circle', x: 0, y: 100, r: 12, zone: 'high' },
    { kind: 'capsule', ax: 0, ay: 40, bx: 0, by: 90, r: 13, zone: 'mid' },
  ];
  assert.equal(overlapVolume(0, 100, 10, vols).zone, 'high');
  assert.equal(overlapVolume(20, 60, 10, vols).zone, 'mid');
  assert.equal(overlapVolume(300, 300, 10, vols), null);
  const c = overlapVolume(5, 100, 10, vols);
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
});
