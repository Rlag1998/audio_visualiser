/*
 * biome.js — biome definitions, the rule oracle, and the training loop.
 *
 * The oracle is a hand-written if-chain. We never ship it to the renderer;
 * instead it labels a few thousand random samples and the MLP in nn.js learns
 * from those labels. The point is not that a network is a better classifier
 * than an if-chain — it is that a network *generalises*: it emits a probability
 * over all 16 biomes, so coastlines, treelines and desert margins come out as
 * gradients, and the learned decision surface bends in ways nobody typed in.
 */
(function (NW) {
  'use strict';

  var BIOMES = [
    { id: 0, name: 'Abyssal Ocean', rgb: [11, 38, 74] },
    { id: 1, name: 'Ocean', rgb: [18, 68, 118] },
    { id: 2, name: 'Shelf Sea', rgb: [44, 116, 164] },
    { id: 3, name: 'River', rgb: [70, 138, 178] },
    { id: 4, name: 'Beach', rgb: [219, 205, 163] },
    { id: 5, name: 'Desert', rgb: [216, 190, 138] },
    { id: 6, name: 'Steppe', rgb: [186, 177, 131] },
    { id: 7, name: 'Savanna', rgb: [158, 158, 106] },
    { id: 8, name: 'Grassland', rgb: [112, 151, 80] },
    { id: 9, name: 'Temperate Forest', rgb: [64, 113, 64] },
    { id: 10, name: 'Rainforest', rgb: [34, 88, 54] },
    { id: 11, name: 'Taiga', rgb: [55, 97, 79] },
    { id: 12, name: 'Tundra', rgb: [148, 158, 140] },
    { id: 13, name: 'Bare Rock', rgb: [139, 132, 121] },
    { id: 14, name: 'Snow', rgb: [237, 243, 246] },
    { id: 15, name: 'Volcanic', rgb: [78, 46, 42] }
  ];

  var K = BIOMES.length;

  var PALETTE_R = new Float32Array(K);
  var PALETTE_G = new Float32Array(K);
  var PALETTE_B = new Float32Array(K);
  for (var i = 0; i < K; i++) {
    PALETTE_R[i] = BIOMES[i].rgb[0];
    PALETTE_G[i] = BIOMES[i].rgb[1];
    PALETTE_B[i] = BIOMES[i].rgb[2];
  }

  /*
   * The oracle. Inputs are already normalised: h is height relative to sea
   * level in [-1, 1], the rest are [0, 1].
   */
  function oracle(h, m, t, slope, river) {
    if (h < -0.42) return 0;
    if (h < -0.12) return 1;
    if (h < 0) return 2;
    if (river > 0.55 && h < 0.7) return 3;
    if (h < 0.02 && slope < 0.35) return t < 0.18 ? 12 : 4;
    if (t > 0.82 && h > 0.35 && m < 0.4) return 15;
    if (h > 0.75 && t < 0.55) return 14;
    if (h > 0.55 || (slope > 0.85 && h > 0.25)) return t < 0.3 ? 14 : 13;
    if (t < 0.2) return 12;
    if (t < 0.42) return m > 0.34 ? 11 : 12;
    if (m < 0.18) return t > 0.55 ? 5 : 6;
    if (m < 0.4) return t > 0.62 ? 7 : 8;
    if (m < 0.68) return t < 0.52 ? 11 : 9;
    return t > 0.6 ? 10 : 9;
  }

  /*
   * Training samples. Two thirds are uniform over the input cube so the network
   * has an answer for anything a strange planet throws at it; one third is
   * drawn from clustered "plausible climate" points so the regions that
   * actually get rendered are the ones it fits best.
   */
  function buildDataset(seed, count) {
    var rnd = NW.rand.rng(seed);
    var X = new Float32Array(count * 5);
    var Y = new Uint8Array(count);
    for (var i = 0; i < count; i++) {
      var h, m, t, s, r;
      if (rnd() < 0.66) {
        h = rnd() * 2 - 1;
        m = rnd();
        t = rnd();
        s = rnd() * rnd();
        r = rnd() < 0.2 ? rnd() : 0;
      } else {
        h = Math.tanh((rnd() + rnd() + rnd() - 1.5) * 1.6);
        var band = rnd();
        t = Math.min(1, Math.max(0, band - Math.max(0, h) * 0.4 + (rnd() - 0.5) * 0.15));
        m = Math.min(1, Math.max(0, 0.5 + (rnd() - 0.5) * 1.3 + (t - 0.5) * 0.3));
        s = Math.min(1, Math.abs(h) * rnd() * 1.5);
        r = rnd() < 0.12 ? 0.55 + rnd() * 0.45 : rnd() * 0.3;
      }
      var o = i * 5;
      X[o] = h; X[o + 1] = m; X[o + 2] = t; X[o + 3] = s; X[o + 4] = r;
      Y[i] = oracle(h, m, t, s, r);
    }
    return { X: X, Y: Y, n: count };
  }

  /*
   * Time-sliced trainer. Browsers hate a one-second synchronous loop, so the
   * app pumps this from the animation frame and shows a progress bar; the user
   * watches the loss come down before the first planet appears.
   */
  function Trainer(seed, opts) {
    opts = opts || {};
    this.seed = seed >>> 0;
    this.data = buildDataset(this.seed ^ 0x9e3779b9, opts.samples || 5200);
    this.net = new NW.nn.Classifier([5, 20, 18, K], this.seed);
    this.epochs = opts.epochs || 26;
    this.lr = opts.lr || 0.012;
    this.epoch = 0;
    this.cursor = 0;
    this.loss = 0;
    this._lossAcc = 0;
    this._lossN = 0;
    this.history = [];
    this.accuracy = 0;
    this.done = false;
    this.order = new Int32Array(this.data.n);
    for (var i = 0; i < this.data.n; i++) this.order[i] = i;
    this._shuffle();
  }

  Trainer.prototype._shuffle = function () {
    var rnd = NW.rand.rng((this.seed + this.epoch * 7919) >>> 0);
    for (var i = this.order.length - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var t = this.order[i];
      this.order[i] = this.order[j];
      this.order[j] = t;
    }
  };

  Trainer.prototype.progress = function () {
    return Math.min(1, (this.epoch + this.cursor / this.data.n) / this.epochs);
  };

  /* Runs for at most `ms` milliseconds. Returns true when training finishes. */
  Trainer.prototype.pump = function (ms) {
    if (this.done) return true;
    var end = performance.now() + ms;
    var x = new Float32Array(5);
    var lrDecay = 1;
    do {
      /* Cosine-ish decay keeps the last epochs from bouncing around a minimum. */
      lrDecay = 0.15 + 0.85 * (1 - this.progress());
      for (var step = 0; step < 96; step++) {
        if (this.cursor >= this.data.n) {
          this.epoch++;
          this.cursor = 0;
          this.loss = this._lossN ? this._lossAcc / this._lossN : 0;
          this.history.push(this.loss);
          this._lossAcc = 0;
          this._lossN = 0;
          if (this.epoch >= this.epochs) {
            this.accuracy = this.evaluate();
            this.done = true;
            return true;
          }
          this._shuffle();
        }
        var idx = this.order[this.cursor++];
        var o = idx * 5;
        x[0] = this.data.X[o];
        x[1] = this.data.X[o + 1];
        x[2] = this.data.X[o + 2];
        x[3] = this.data.X[o + 3];
        x[4] = this.data.X[o + 4];
        this._lossAcc += this.net.learn(x, this.data.Y[idx], this.lr * lrDecay);
        this._lossN++;
      }
    } while (performance.now() < end);
    return false;
  };

  /* Agreement with the oracle on a held-out draw — reported honestly in the UI. */
  Trainer.prototype.evaluate = function () {
    var test = buildDataset((this.seed ^ 0x51ed270b) >>> 0, 2000);
    var x = new Float32Array(5), hit = 0;
    for (var i = 0; i < test.n; i++) {
      var o = i * 5;
      x[0] = test.X[o]; x[1] = test.X[o + 1]; x[2] = test.X[o + 2];
      x[3] = test.X[o + 3]; x[4] = test.X[o + 4];
      var p = this.net.predict(x);
      var best = 0;
      for (var j = 1; j < K; j++) if (p[j] > p[best]) best = j;
      if (best === test.Y[i]) hit++;
    }
    return hit / test.n;
  };

  NW.biome = {
    BIOMES: BIOMES,
    K: K,
    PALETTE_R: PALETTE_R,
    PALETTE_G: PALETTE_G,
    PALETTE_B: PALETTE_B,
    oracle: oracle,
    Trainer: Trainer
  };
})(window.NW = window.NW || {});
