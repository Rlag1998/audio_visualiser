/*
 * evo.js — tournament evolution.
 *
 * The offspring gallery is single-parent: mutate, pick, repeat. A tournament is
 * the full genetic loop: a population of six, head-to-head duels the user
 * judges, and a next generation *bred* from the winners — crossover between two
 * parents, then mutation, with the mutation size decaying each generation so
 * the line converges on what keeps getting picked instead of wandering.
 *
 * Everything here is a pure function of (base network, master seed, the picks).
 * That is what makes an evolved champion sharable: the whole tournament
 * serialises to one lineage entry {t: seed, p: picks} a few dozen bytes long,
 * and replays bit-identically from a URL.
 *
 * One generation is four picks:
 *   three duels     (0|1) over the pairs (0,1) (2,3) (4,5)
 *   one final       (0|1|2) choosing the champion among the three winners
 *
 * The next population is then:
 *   0  the champion, unchanged (elitism — you can never lose what you liked)
 *   1  champion × runner-up A, lightly mutated
 *   2  champion × runner-up B, lightly mutated
 *   3  runner-up A × runner-up B, lightly mutated
 *   4  champion mutated at this generation's sigma
 *   5  champion mutated hard — the wildcard that keeps exploration alive
 */
(function (NW) {
  'use strict';

  var rand = NW.rand;

  var POP = 6;
  var PAIRS = [[0, 1], [2, 3], [4, 5]];
  var PICKS_PER_GEN = 4;

  /* Generation-0 spread: from a nudge to a different animal. */
  var INIT_SIGMA = [0.1, 0.16, 0.22, 0.3, 0.42];

  /* Simulated annealing, roughly: coarse search first, fine tuning later. */
  function sigmaFor(gen) {
    return Math.max(0.045, 0.2 * Math.pow(0.8, gen));
  }

  function initial(base, seed) {
    var rnd = rand.rng(seed >>> 0);
    var pop = [base.clone()];
    for (var i = 0; i < POP - 1; i++) {
      pop.push(base.mutate((rnd() * 4294967295) >>> 0, INIT_SIGMA[i]));
    }
    return pop;
  }

  /* winners: the three duel winners; champIdx: which of them won the final. */
  function breed(winners, champIdx, seed, gen) {
    var rnd = rand.rng((seed ^ Math.imul(gen + 1, 2654435761)) >>> 0);
    function s() { return (rnd() * 4294967295) >>> 0; }
    var champ = winners[champIdx];
    var a = winners[(champIdx + 1) % 3];
    var b = winners[(champIdx + 2) % 3];
    var sg = sigmaFor(gen);
    return [
      champ.clone(),
      champ.crossover(a, s()).mutate(s(), sg * 0.5),
      champ.crossover(b, s()).mutate(s(), sg * 0.5),
      a.crossover(b, s()).mutate(s(), sg * 0.5),
      champ.mutate(s(), sg),
      champ.mutate(s(), sg * 1.9)
    ];
  }

  function winnersOf(pop, picks, off) {
    return [
      pop[PAIRS[0][picks[off] & 1]],
      pop[PAIRS[1][picks[off + 1] & 1]],
      pop[PAIRS[2][picks[off + 2] & 1]]
    ];
  }

  /*
   * Replay a recorded tournament from a base network. Returns the champion of
   * the last complete generation — the base itself if none completed. This is
   * the function buildNet calls when it meets a {t, p} lineage entry.
   */
  function replay(base, seed, picks) {
    var pop = initial(base, seed);
    var champ = base;
    var gen = 0;
    for (var off = 0; off + PICKS_PER_GEN <= picks.length; off += PICKS_PER_GEN, gen++) {
      var w = winnersOf(pop, picks, off);
      var f = Math.min(2, picks[off + 3] | 0);
      champ = w[f];
      pop = breed(w, f, seed, gen);
    }
    return champ;
  }

  NW.evo = {
    POP: POP,
    PAIRS: PAIRS,
    PICKS_PER_GEN: PICKS_PER_GEN,
    sigmaFor: sigmaFor,
    initial: initial,
    breed: breed,
    winnersOf: winnersOf,
    replay: replay
  };
})(window.NW = window.NW || {});
