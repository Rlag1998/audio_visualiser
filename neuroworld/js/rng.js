/*
 * rng.js — deterministic randomness and gradient noise.
 *
 * Everything in NeuroWorld must be reproducible from a seed: the same seed has
 * to rebuild the same network weights, the same noise fields and therefore the
 * same planet, on any machine. So no Math.random() past this file.
 */
(function (NW) {
  'use strict';

  /* FNV-1a over the string, so human-typed seeds land all over the 32-bit range. */
  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* mulberry32: tiny, fast, good enough for weights and jitter. */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Box-Muller. Weight init and mutation both want normals, not uniforms. */
  function gauss(rand) {
    var u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* Integer hash used for per-tile decisions (tree here? rock there?). */
  function hash2(x, y, seed) {
    var h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return h >>> 0;
  }

  function hash2f(x, y, seed) {
    return hash2(x, y, seed) / 4294967296;
  }

  var GN = 512;
  var GCOS = new Float32Array(GN);
  var GSIN = new Float32Array(GN);
  for (var g = 0; g < GN; g++) {
    var a = (g / GN) * Math.PI * 2;
    GCOS[g] = Math.cos(a);
    GSIN[g] = Math.sin(a);
  }

  /*
   * Perlin-style gradient noise. Gradients come from the integer hash, so the
   * field is infinite, tileless and needs no precomputed permutation table.
   */
  function Noise(seed) {
    this.seed = seed >>> 0;
  }

  Noise.prototype.at = function (x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    var u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    var v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    var s = this.seed;

    var i00 = hash2(x0, y0, s) & (GN - 1);
    var i10 = hash2(x0 + 1, y0, s) & (GN - 1);
    var i01 = hash2(x0, y0 + 1, s) & (GN - 1);
    var i11 = hash2(x0 + 1, y0 + 1, s) & (GN - 1);

    var n00 = GCOS[i00] * fx + GSIN[i00] * fy;
    var n10 = GCOS[i10] * (fx - 1) + GSIN[i10] * fy;
    var n01 = GCOS[i01] * fx + GSIN[i01] * (fy - 1);
    var n11 = GCOS[i11] * (fx - 1) + GSIN[i11] * (fy - 1);

    var a0 = n00 + u * (n10 - n00);
    var a1 = n01 + u * (n11 - n01);
    return (a0 + v * (a1 - a0)) * 1.4142;
  };

  /* Fractal sum. `oct` octaves, each half the amplitude and ~double the rate. */
  Noise.prototype.fbm = function (x, y, oct, lac, gain) {
    lac = lac || 2.03;
    gain = gain || 0.5;
    var sum = 0, amp = 1, norm = 0, fx = x, fy = y;
    for (var i = 0; i < oct; i++) {
      sum += amp * this.at(fx, fy);
      norm += amp;
      amp *= gain;
      fx *= lac;
      fy *= lac;
      /* Rotate each octave a little so the layers do not line up into grids. */
      var t = fx * 0.8776 - fy * 0.4794;
      fy = fx * 0.4794 + fy * 0.8776;
      fx = t;
    }
    return sum / norm;
  };

  /* Ridged variant: creases where the field crosses zero. Good for mountains. */
  Noise.prototype.ridged = function (x, y, oct) {
    var sum = 0, amp = 1, norm = 0, fx = x, fy = y;
    for (var i = 0; i < oct; i++) {
      var n = 1 - 2 * Math.abs(this.at(fx, fy));
      sum += amp * n;
      norm += amp;
      amp *= 0.5;
      fx *= 2.11;
      fy *= 2.11;
    }
    return sum / norm;
  };

  NW.rand = {
    hashString: hashString,
    rng: rng,
    gauss: gauss,
    hash2: hash2,
    hash2f: hash2f,
    Noise: Noise
  };
})(window.NW = window.NW || {});
