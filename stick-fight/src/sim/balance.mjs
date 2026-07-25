#!/usr/bin/env node
// Balance harness.
//
// A single round robin is noisy — at 100 matches per pairing one standard
// deviation is still about 3 points, which is enough to make a perfectly even
// roster look broken (or a broken one look fine). This runs the whole round
// robin across several seeds and reports the mean, so a tuning change can be
// judged against something stable.
//
//   node src/sim/balance.mjs
//   node src/sim/balance.mjs 80 veteran
//   node src/sim/balance.mjs 80 veteran '{"duelist":{"defenseMul":0.9}}'
//
// The third argument patches ARCHETYPES in memory, so a candidate tuning can be
// measured without editing config.js first.

import { ARCHETYPES, DIFFICULTIES } from '../game/config.js';
import { roundRobin } from './batch.js';

const perPair = Number(process.argv[2] ?? 60);
const difficulty = process.argv[3] ?? 'veteran';
const overrides = process.argv[4] ? JSON.parse(process.argv[4]) : null;

if (!DIFFICULTIES[difficulty]) {
  console.error(`Unknown difficulty "${difficulty}". Options: ${Object.keys(DIFFICULTIES).join(', ')}`);
  process.exit(1);
}

if (overrides) {
  for (const [id, patch] of Object.entries(overrides)) {
    if (!ARCHETYPES[id]) {
      console.error(`Unknown archetype "${id}" in overrides.`);
      process.exit(1);
    }
    Object.assign(ARCHETYPES[id], patch);
  }
}

const SEEDS = [12345, 999, 4242, 31337, 8675309];

const samples = new Map();
const t0 = Date.now();

for (const seed of SEEDS) {
  for (const row of roundRobin({ matchesPerPair: perPair, difficulty, seed })) {
    if (!samples.has(row.archetype)) samples.set(row.archetype, []);
    samples.get(row.archetype).push(row.winRate);
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

const rows = [...samples.entries()].map(([id, xs]) => ({
  id,
  name: ARCHETYPES[id].name,
  mean: mean(xs),
  spread: stdev(xs),
  best: Math.max(...xs),
  worst: Math.min(...xs),
  runs: xs,
}));
rows.sort((a, b) => b.mean - a.mean);

const totalMatches = perPair * (rows.length * (rows.length - 1) / 2) * SEEDS.length;
const worstDeviation = Math.max(...rows.map((r) => Math.abs(r.mean - 0.5)));

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const bar = (v) => {
  // Centred on 50%: left of centre is under-powered, right is over-powered.
  const width = 30;
  const mid = width / 2;
  const pos = Math.round(Math.max(0, Math.min(width, mid + (v - 0.5) * width * 2.5)));
  const cells = new Array(width).fill('.');
  cells[mid] = '|';
  cells[Math.min(width - 1, pos)] = '#';
  return cells.join('');
};

console.log(`\n  Balance across ${SEEDS.length} seeds x ${perPair} matches per pairing ` +
  `(${totalMatches} matches, ${Date.now() - t0}ms)\n`);
console.log(`    ${pad('archetype', 11)} ${padL('mean', 7)} ${padL('sd', 6)} ${padL('worst', 7)} ${padL('best', 7)}   under <-- 50% --> over`);
for (const r of rows) {
  console.log(
    `    ${pad(r.name, 11)} ${padL((r.mean * 100).toFixed(1), 6)}% ${padL((r.spread * 100).toFixed(1), 5)}% ` +
    `${padL((r.worst * 100).toFixed(1), 6)}% ${padL((r.best * 100).toFixed(1), 6)}%   ${bar(r.mean)}`,
  );
}
console.log(`\n  worst deviation from even: ${(worstDeviation * 100).toFixed(1)} points`);
console.log(`  ${worstDeviation <= 0.04 ? 'BALANCED — within 4 points' : 'NEEDS WORK — outside 4 points'}\n`);
