#!/usr/bin/env node
// Measures the real reach of every move by performing it and watching where the
// hitbox actually goes.
//
// MOVE_REACH is what the AI uses to decide "am I close enough to throw this?",
// so if it disagrees with the skeleton the AI throws attacks that physically
// cannot connect. This tool is the ground truth; `npm test` asserts against it.

import { Fighter, makeCmd } from '../game/fighter.js';
import { MOVES, MOVE_IDS, MOVE_REACH } from '../game/moves.js';
import { TICK } from '../game/config.js';

/**
 * Simulate one move in isolation and return the furthest forward the hitbox
 * gets (measured from the fighter's root, hitbox radius included) while the
 * move is active.
 */
export function measureReach(id) {
  const move = MOVES[id];
  const f = new Fighter({ x: 0, facing: 1 });
  if (move.airOnly) {
    f.grounded = false;
    f.y = 60;
  }
  if (move.meterCost) f.meter = 100;

  f._startAttack(id, 0);
  const cmd = makeCmd();
  let max = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < 120 && f.state === 'attack'; i++) {
    f.update(TICK, cmd, null);
    if (!f.moveActive) continue;
    const j = f.skeleton.joints[move.hitJoint];
    max = Math.max(max, j.x - f.x + move.hitR);
    minY = Math.min(minY, j.y - move.hitR);
    maxY = Math.max(maxY, j.y + move.hitR);
  }
  return { id, reach: max, low: minY, high: maxY };
}

export const measureAll = () => MOVE_IDS.map(measureReach);

if (import.meta.url === `file://${process.argv[1]}`) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log('\n  Measured hitbox reach vs the MOVE_REACH table the AI plans with\n');
  console.log(`    ${pad('move', 11)} ${padL('declared', 9)} ${padL('actual', 8)} ${padL('delta', 8)} ${padL('height', 14)}`);
  let worst = 0;
  for (const m of measureAll()) {
    const declared = MOVE_REACH[m.id];
    const delta = m.reach - declared;
    worst = Math.max(worst, Math.abs(delta));
    const flag = Math.abs(delta) > 6 ? '  <-- off' : '';
    console.log(
      `    ${pad(m.id, 11)} ${padL(declared, 9)} ${padL(m.reach.toFixed(1), 8)} ${padL(delta.toFixed(1), 8)} ` +
      `${padL(`${m.low.toFixed(0)}..${m.high.toFixed(0)}`, 14)}${flag}`,
    );
  }
  console.log(`\n  worst disagreement: ${worst.toFixed(1)} units\n`);
}
