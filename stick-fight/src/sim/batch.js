// Headless batch simulation.
//
// The exact same Match/Fighter/AI code that runs on screen is run here with no
// renderer attached, thousands of frames per millisecond-ish, so you can ask
// "is the Kickboxer actually better than the Brawler?" and get a real answer
// instead of a vibe. Because everything is seeded, results are reproducible.

import { Match, PHASE } from '../game/match.js';
import { AIController } from '../game/ai.js';
import { ARCHETYPES, DIFFICULTIES, PALETTES, TICK } from '../game/config.js';
import { MOVE_IDS } from '../game/moves.js';
import { makeRng } from '../core/rng.js';
import { round2 } from '../core/math.js';

/** Hard ceiling so a pathological match can never hang the page. */
const MAX_FRAMES = 60 * 60 * 6;

export function buildMatch({ seed = 1, a = {}, b = {}, roundTime, winsNeeded } = {}) {
  const rngA = makeRng(seed ^ 0x1234567);
  const rngB = makeRng(seed ^ 0x89abcdef);

  const match = new Match({
    seed,
    roundTime,
    winsNeeded,
    fighters: [
      {
        name: a.name ?? ARCHETYPES[a.archetype ?? 'duelist'].name,
        archetype: a.archetype ?? 'duelist',
        palette: a.palette ?? PALETTES[0],
      },
      {
        name: b.name ?? ARCHETYPES[b.archetype ?? 'brawler'].name,
        archetype: b.archetype ?? 'brawler',
        palette: b.palette ?? PALETTES[2],
      },
    ],
  });

  match.setControllers(
    new AIController({ difficulty: a.difficulty ?? 'veteran', rng: rngA }),
    new AIController({ difficulty: b.difficulty ?? 'veteran', rng: rngB }),
  );
  return match;
}

/** Run one match to completion. Returns the match summary. */
export function simulateMatch(opts = {}) {
  const match = buildMatch(opts);
  let frames = 0;
  while (!match.isOver && frames < MAX_FRAMES) {
    match.step(TICK);
    frames++;
  }
  const summary = match.summary();
  summary.timedOut = frames >= MAX_FRAMES;
  return summary;
}

function emptyAgg(name) {
  const byMove = {};
  for (const id of MOVE_IDS) byMove[id] = { thrown: 0, hit: 0, blocked: 0, damage: 0 };
  return {
    name,
    matchWins: 0,
    roundWins: 0,
    damageDealt: 0,
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

function fold(agg, stats, fighter) {
  agg.roundWins += fighter.wins;
  agg.damageDealt += stats.damageDealt;
  agg.hits += stats.hits;
  agg.whiffs += stats.whiffs;
  agg.blocked += stats.blocked;
  agg.parries += stats.parries;
  agg.knockdowns += stats.knockdowns;
  agg.kos += stats.kos;
  agg.maxCombo = Math.max(agg.maxCombo, stats.maxCombo);
  for (const id of MOVE_IDS) {
    const s = stats.byMove[id];
    const t = agg.byMove[id];
    t.thrown += s.thrown;
    t.hit += s.hit;
    t.blocked += s.blocked;
    t.damage += s.damage;
  }
}

/**
 * An incremental batch runner. Call `runChunk()` from a timer or rAF so the
 * page keeps breathing while thousands of fights resolve.
 */
export class BatchRunner {
  constructor(opts = {}) {
    this.opts = opts;
    this.total = opts.matches ?? 100;
    this.seed = opts.seed ?? 1;
    this.done = 0;
    this.draws = 0;
    this.frames = 0;
    this.timeouts = 0;
    this.agg = [
      emptyAgg(opts.a?.name ?? ARCHETYPES[opts.a?.archetype ?? 'duelist'].name),
      emptyAgg(opts.b?.name ?? ARCHETYPES[opts.b?.archetype ?? 'brawler'].name),
    ];
    this.finished = false;
  }

  get progress() {
    return this.total === 0 ? 1 : this.done / this.total;
  }

  /** Run up to `n` more matches. Returns true when the batch is complete. */
  runChunk(n = 8) {
    const end = Math.min(this.total, this.done + n);
    while (this.done < end) {
      const summary = simulateMatch({
        seed: (this.seed + this.done * 7919) >>> 0,
        a: this.opts.a,
        b: this.opts.b,
        roundTime: this.opts.roundTime,
        winsNeeded: this.opts.winsNeeded,
      });
      this.frames += summary.frames;
      if (summary.timedOut) this.timeouts++;
      if (summary.winner === null) this.draws++;
      else this.agg[summary.winner].matchWins++;

      for (let i = 0; i < 2; i++) {
        this.agg[i].roundWins += summary.wins[i];
        const s = summary.stats[i];
        this.agg[i].damageDealt += s.damageDealt;
        this.agg[i].hits += s.hits;
        this.agg[i].whiffs += s.whiffs;
        this.agg[i].blocked += s.blocked;
        this.agg[i].parries += s.parries;
        this.agg[i].knockdowns += s.knockdowns;
        this.agg[i].kos += s.kos;
        this.agg[i].maxCombo = Math.max(this.agg[i].maxCombo, s.maxCombo);
        for (const id of MOVE_IDS) {
          const src = s.byMove[id];
          const dst = this.agg[i].byMove[id];
          dst.thrown += src.thrown;
          dst.hit += src.hit;
          dst.blocked += src.blocked;
          dst.damage += src.damage;
        }
      }
      this.done++;
    }
    this.finished = this.done >= this.total;
    return this.finished;
  }

  report() {
    const n = Math.max(1, this.done);
    const side = (i) => {
      const a = this.agg[i];
      const moves = MOVE_IDS.map((id) => {
        const m = a.byMove[id];
        const landed = m.hit + m.blocked;
        return {
          id,
          thrown: m.thrown,
          hit: m.hit,
          blocked: m.blocked,
          damage: round2(m.damage, 1),
          hitRate: m.thrown ? round2(m.hit / m.thrown, 3) : 0,
          contactRate: m.thrown ? round2(landed / m.thrown, 3) : 0,
        };
      }).sort((x, y) => y.thrown - x.thrown);

      return {
        name: a.name,
        matchWins: a.matchWins,
        winRate: round2(a.matchWins / n, 3),
        roundWins: a.roundWins,
        avgDamagePerMatch: round2(a.damageDealt / n, 1),
        avgHitsPerMatch: round2(a.hits / n, 1),
        accuracy: a.hits + a.whiffs + a.blocked > 0
          ? round2(a.hits / (a.hits + a.whiffs + a.blocked), 3)
          : 0,
        parries: a.parries,
        knockdowns: a.knockdowns,
        kos: a.kos,
        bestCombo: a.maxCombo,
        moves,
      };
    };

    return {
      matches: this.done,
      draws: this.draws,
      timeouts: this.timeouts,
      avgMatchSeconds: round2(this.frames / n / 60, 1),
      sides: [side(0), side(1)],
    };
  }
}

/** Blocking convenience wrapper — used by the CLI and the tests. */
export function runBatch(opts = {}) {
  const runner = new BatchRunner(opts);
  while (!runner.runChunk(64));
  return runner.report();
}

/**
 * Round-robin every archetype against every other at a fixed difficulty.
 * Incremental for the same reason BatchRunner is: a meaningful sample size is
 * several thousand matches, and the page has to stay responsive throughout.
 */
export class RoundRobinRunner {
  constructor({ matchesPerPair = 20, difficulty = 'veteran', seed = 7 } = {}) {
    this.ids = Object.keys(ARCHETYPES);
    this.matchesPerPair = matchesPerPair;
    this.difficulty = difficulty;
    this.seed = seed;

    this.pairs = [];
    for (let i = 0; i < this.ids.length; i++) {
      for (let j = i + 1; j < this.ids.length; j++) this.pairs.push([this.ids[i], this.ids[j]]);
    }

    this.table = {};
    for (const id of this.ids) {
      this.table[id] = {
        archetype: id, name: ARCHETYPES[id].name,
        wins: 0, losses: 0, draws: 0, damage: 0,
      };
    }

    this.pairIndex = 0;
    this.runner = null;
    this.finished = this.pairs.length === 0;
  }

  get progress() {
    if (this.finished) return 1;
    const inner = this.runner ? this.runner.progress : 0;
    return (this.pairIndex + inner) / this.pairs.length;
  }

  get label() {
    const pair = this.pairs[Math.min(this.pairIndex, this.pairs.length - 1)];
    return pair ? `${ARCHETYPES[pair[0]].name} vs ${ARCHETYPES[pair[1]].name}` : '';
  }

  runChunk(n = 8) {
    if (this.finished) return true;
    if (!this.runner) {
      const [x, y] = this.pairs[this.pairIndex];
      this.runner = new BatchRunner({
        matches: this.matchesPerPair,
        seed: this.seed + this.pairIndex * 1009,
        a: { archetype: x, difficulty: this.difficulty, name: ARCHETYPES[x].name },
        b: { archetype: y, difficulty: this.difficulty, name: ARCHETYPES[y].name },
      });
    }
    if (this.runner.runChunk(n)) {
      const [x, y] = this.pairs[this.pairIndex];
      const rep = this.runner.report();
      this.table[x].wins += rep.sides[0].matchWins;
      this.table[y].wins += rep.sides[1].matchWins;
      this.table[x].losses += rep.sides[1].matchWins;
      this.table[y].losses += rep.sides[0].matchWins;
      this.table[x].draws += rep.draws;
      this.table[y].draws += rep.draws;
      this.table[x].damage += rep.sides[0].avgDamagePerMatch * rep.matches;
      this.table[y].damage += rep.sides[1].avgDamagePerMatch * rep.matches;

      this.runner = null;
      this.pairIndex++;
      if (this.pairIndex >= this.pairs.length) this.finished = true;
    }
    return this.finished;
  }

  report() {
    const rows = Object.values(this.table).map((r) => ({
      ...r,
      played: r.wins + r.losses + r.draws,
      winRate: round2(r.wins / Math.max(1, r.wins + r.losses + r.draws), 3),
      damage: round2(r.damage, 0),
    }));
    rows.sort((a, b) => b.winRate - a.winRate);
    return rows;
  }
}

/** Blocking wrapper — used by the CLI and the tests. */
export function roundRobin(opts = {}) {
  const runner = new RoundRobinRunner(opts);
  while (!runner.runChunk(32));
  return runner.report();
}

export { PHASE };
