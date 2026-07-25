#!/usr/bin/env node
// Headless front-end for the simulator. No browser, no canvas — just the fight.
//
//   node src/sim/cli.mjs match [seed] [archA] [archB] [difficulty]
//   node src/sim/cli.mjs batch [matches] [archA] [archB] [difficulty]
//   node src/sim/cli.mjs tournament [matchesPerPair] [difficulty]

import { simulateMatch, runBatch, roundRobin } from './batch.js';
import { ARCHETYPES, DIFFICULTIES } from '../game/config.js';

const [, , cmd = 'batch', ...rest] = process.argv;

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const bar = (v, width = 22) => '#'.repeat(Math.round(v * width)).padEnd(width, '.');

function checkArch(id) {
  if (!ARCHETYPES[id]) {
    console.error(`Unknown archetype "${id}". Options: ${Object.keys(ARCHETYPES).join(', ')}`);
    process.exit(1);
  }
  return id;
}

function checkDiff(id) {
  if (!DIFFICULTIES[id]) {
    console.error(`Unknown difficulty "${id}". Options: ${Object.keys(DIFFICULTIES).join(', ')}`);
    process.exit(1);
  }
  return id;
}

if (cmd === 'match') {
  const seed = Number(rest[0] ?? 1);
  const a = checkArch(rest[1] ?? 'boxer');
  const b = checkArch(rest[2] ?? 'kickboxer');
  const difficulty = checkDiff(rest[3] ?? 'veteran');

  const s = simulateMatch({
    seed,
    a: { archetype: a, difficulty, name: ARCHETYPES[a].name },
    b: { archetype: b, difficulty, name: ARCHETYPES[b].name },
  });

  console.log(`\n  ${s.names[0]} vs ${s.names[1]}  (seed ${seed}, ${difficulty})`);
  console.log(`  rounds ${s.rounds}   ${s.wins[0]}-${s.wins[1]}   ${(s.frames / 60).toFixed(1)}s`);
  console.log(`  winner: ${s.winner === null ? 'draw' : s.names[s.winner]}\n`);
  for (let i = 0; i < 2; i++) {
    const st = s.stats[i];
    console.log(
      `  ${pad(s.names[i], 12)} dmg ${padL(st.damageDealt.toFixed(0), 4)}` +
      `  hits ${padL(st.hits, 3)}  blocked ${padL(st.blocked, 3)}` +
      `  whiffs ${padL(st.whiffs, 3)}  parries ${padL(st.parries, 2)}` +
      `  KD ${padL(st.knockdowns, 2)}  best combo ${st.maxCombo}`,
    );
  }
  console.log('');
} else if (cmd === 'batch') {
  const n = Number(rest[0] ?? 100);
  const a = checkArch(rest[1] ?? 'boxer');
  const b = checkArch(rest[2] ?? 'kickboxer');
  const diffA = checkDiff(rest[3] ?? 'veteran');
  const diffB = checkDiff(rest[4] ?? rest[3] ?? 'veteran');

  const t0 = Date.now();
  const rep = runBatch({
    matches: n,
    seed: 12345,
    a: { archetype: a, difficulty: diffA, name: `${ARCHETYPES[a].name}/${DIFFICULTIES[diffA].name}` },
    b: { archetype: b, difficulty: diffB, name: `${ARCHETYPES[b].name}/${DIFFICULTIES[diffB].name}` },
  });
  const ms = Date.now() - t0;

  console.log(`\n  ${rep.matches} matches, ${diffA} vs ${diffB} AI, ${ms}ms (${(rep.matches / (ms / 1000)).toFixed(0)}/s)`);
  console.log(`  avg match ${rep.avgMatchSeconds}s   draws ${rep.draws}   timeouts ${rep.timeouts}\n`);
  for (const side of rep.sides) {
    console.log(`  ${pad(side.name, 12)} ${bar(side.winRate)} ${(side.winRate * 100).toFixed(1)}%  ` +
      `dmg/match ${padL(side.avgDamagePerMatch, 5)}  acc ${(side.accuracy * 100).toFixed(0)}%  ` +
      `KO ${padL(side.kos, 3)}  parry ${padL(side.parries, 3)}  best combo ${side.bestCombo}`);
  }
  console.log('\n  move usage');
  for (const side of rep.sides) {
    console.log(`\n  ${side.name}`);
    console.log(`    ${pad('move', 10)} ${padL('thrown', 7)} ${padL('hit', 6)} ${padL('blocked', 8)} ${padL('hit%', 6)} ${padL('dmg', 8)}`);
    for (const m of side.moves) {
      if (!m.thrown) continue;
      console.log(`    ${pad(m.id, 10)} ${padL(m.thrown, 7)} ${padL(m.hit, 6)} ${padL(m.blocked, 8)} ${padL((m.hitRate * 100).toFixed(0), 6)} ${padL(m.damage.toFixed(0), 8)}`);
    }
  }
  console.log('');
} else if (cmd === 'tournament') {
  const n = Number(rest[0] ?? 30);
  const difficulty = checkDiff(rest[1] ?? 'veteran');
  const t0 = Date.now();
  const rows = roundRobin({ matchesPerPair: n, difficulty });
  console.log(`\n  Round robin — ${n} matches per pair, ${difficulty} AI (${Date.now() - t0}ms)\n`);
  console.log(`    ${pad('archetype', 12)} ${padL('played', 7)} ${padL('W', 5)} ${padL('L', 5)} ${padL('D', 4)}  win rate`);
  for (const r of rows) {
    console.log(`    ${pad(r.name, 12)} ${padL(r.played, 7)} ${padL(r.wins, 5)} ${padL(r.losses, 5)} ${padL(r.draws, 4)}  ${bar(r.winRate, 18)} ${(r.winRate * 100).toFixed(1)}%`);
  }
  console.log('');
} else {
  console.log(`Usage:
  node src/sim/cli.mjs match [seed] [archA] [archB] [difficulty]
  node src/sim/cli.mjs batch [matches] [archA] [archB] [difficulty]
  node src/sim/cli.mjs tournament [matchesPerPair] [difficulty]

  archetypes:   ${Object.keys(ARCHETYPES).join(', ')}
  difficulties: ${Object.keys(DIFFICULTIES).join(', ')}`);
}
