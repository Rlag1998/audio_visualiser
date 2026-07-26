/*
 * nn.js — the two neural networks.
 *
 *   FieldNet   an untrained CPPN (compositional pattern producing network).
 *              Random weights + a random activation function per neuron. It is
 *              never trained; its *shape* is the terrain. Mutating its weights
 *              mutates the planet, which is what makes worlds evolvable.
 *
 *   Classifier a small MLP that IS trained, here in the browser, with Adam and
 *              cross-entropy, to read (height, moisture, temperature, slope,
 *              river) and answer "which biome". Because it answers with a
 *              softmax instead of an if-chain, biome borders come out blended.
 */
(function (NW) {
  'use strict';

  var rand = NW.rand;

  /* ---------------------------------------------------------------- CPPN --- */

  /*
   * Activation zoo. Every one is bounded to roughly [-1, 1] so deep stacks stay
   * stable, and each contributes a different visual signature: sin gives bands
   * and repeats, gauss gives blobs and coastlines, fold gives creases and
   * ridges, softsign gives soft gradients.
   */
  var ACTS = [
    { name: 'tanh', fn: function (x) { return Math.tanh(x); } },
    { name: 'sin', fn: function (x) { return Math.sin(x * 2.2); } },
    { name: 'gauss', fn: function (x) { return Math.exp(-x * x * 2) * 2 - 1; } },
    { name: 'softsign', fn: function (x) { return x / (1 + Math.abs(x)); } },
    { name: 'fold', fn: function (x) { return 2 * Math.abs(Math.tanh(x)) - 1; } },
    { name: 'crease', fn: function (x) { return 1 - 2 * Math.abs(Math.sin(x * 1.6)); } },
    { name: 'step', fn: function (x) { return 2 / (1 + Math.exp(-4 * x)) - 1; } }
  ];

  function FieldNet(inDim, sizes, seed, gain) {
    this.inDim = inDim;
    this.outDim = sizes[sizes.length - 1];
    this.layers = [];
    var rnd = rand.rng(seed);
    var prev = inDim;
    for (var l = 0; l < sizes.length; l++) {
      var out = sizes[l];
      var last = l === sizes.length - 1;
      var layer = {
        inDim: prev,
        outDim: out,
        w: new Float32Array(prev * out),
        b: new Float32Array(out),
        acts: new Uint8Array(out)
      };
      /* Wide init on purpose: near-zero weights make flat, boring worlds. */
      var sigma = (gain || 1.9) / Math.sqrt(prev);
      for (var i = 0; i < layer.w.length; i++) layer.w[i] = rand.gauss(rnd) * sigma;
      for (var j = 0; j < out; j++) {
        layer.b[j] = rand.gauss(rnd) * 0.45;
        /* Output neurons stay tanh so downstream code can trust the range. */
        layer.acts[j] = last ? 0 : (rnd() * ACTS.length) | 0;
      }
      this.layers.push(layer);
      prev = out;
    }
    this._bufA = null;
    this._bufB = null;
    this._bufN = 0;
  }

  FieldNet.prototype._buffers = function (n) {
    if (this._bufN >= n && this._bufA) return;
    var width = this.inDim;
    for (var l = 0; l < this.layers.length; l++) width = Math.max(width, this.layers[l].outDim);
    this._bufA = new Float32Array(n * width);
    this._bufB = new Float32Array(n * width);
    this._bufN = n;
  };

  /*
   * Forward pass over a whole batch of sample points at once. `X` is n rows of
   * inDim floats. Weights are stored input-major so the innermost loop walks
   * contiguous memory, which is the difference between a chunk taking 15ms and
   * 60ms.
   *
   * `stopAt` returns the output of that layer instead of the final one, which is
   * how the neuron probe reads hidden activations. stopAt < 0 returns the inputs.
   */
  FieldNet.prototype.forward = function (X, n, stopAt) {
    var last = (stopAt === undefined || stopAt === null || stopAt >= this.layers.length)
      ? this.layers.length - 1 : stopAt;
    if (last < 0) return X;
    this._buffers(n);
    var src = X, dst = this._bufA;
    for (var l = 0; l <= last; l++) {
      var la = this.layers[l];
      var iD = la.inDim, oD = la.outDim, w = la.w, b = la.b, acts = la.acts;
      for (var i = 0; i < n; i++) {
        var si = i * iD, di = i * oD;
        for (var j = 0; j < oD; j++) dst[di + j] = b[j];
        for (var k = 0; k < iD; k++) {
          var xv = src[si + k];
          if (xv === 0) continue;
          var wr = k * oD;
          for (var j2 = 0; j2 < oD; j2++) dst[di + j2] += xv * w[wr + j2];
        }
        for (var j3 = 0; j3 < oD; j3++) dst[di + j3] = ACTS[acts[j3]].fn(dst[di + j3]);
      }
      if (l < last) {
        src = dst;
        dst = (dst === this._bufA) ? this._bufB : this._bufA;
      }
    }
    return dst;
  };

  /* Single point, plus every hidden activation — used by the network inspector. */
  FieldNet.prototype.trace = function (x) {
    var acts = [Array.prototype.slice.call(x)];
    var cur = x;
    for (var l = 0; l < this.layers.length; l++) {
      var la = this.layers[l];
      var out = new Float32Array(la.outDim);
      for (var j = 0; j < la.outDim; j++) {
        var s = la.b[j];
        for (var k = 0; k < la.inDim; k++) s += cur[k] * la.w[k * la.outDim + j];
        out[j] = ACTS[la.acts[j]].fn(s);
      }
      acts.push(Array.prototype.slice.call(out));
      cur = out;
    }
    return acts;
  };

  FieldNet.prototype.clone = function () {
    var c = Object.create(FieldNet.prototype);
    c.inDim = this.inDim;
    c.outDim = this.outDim;
    c.layers = this.layers.map(function (la) {
      return {
        inDim: la.inDim,
        outDim: la.outDim,
        w: la.w.slice(),
        b: la.b.slice(),
        acts: la.acts.slice()
      };
    });
    c._bufA = null;
    c._bufB = null;
    c._bufN = 0;
    return c;
  };

  /*
   * One step of asexual evolution: jitter every weight, and occasionally swap a
   * neuron's activation function (which changes the world's character far more
   * than any weight nudge). Driven by an explicit seed so a lineage of
   * mutations replays exactly from a permalink.
   */
  FieldNet.prototype.mutate = function (seed, sigma) {
    var c = this.clone();
    var rnd = rand.rng(seed);
    for (var l = 0; l < c.layers.length; l++) {
      var la = c.layers[l];
      for (var i = 0; i < la.w.length; i++) la.w[i] += rand.gauss(rnd) * sigma;
      for (var j = 0; j < la.outDim; j++) {
        la.b[j] += rand.gauss(rnd) * sigma * 0.5;
        var isLast = l === c.layers.length - 1;
        if (!isLast && rnd() < sigma * 0.35) la.acts[j] = (rnd() * ACTS.length) | 0;
      }
    }
    return c;
  };

  FieldNet.prototype.weightCount = function () {
    return this.layers.reduce(function (a, la) { return a + la.w.length + la.b.length; }, 0);
  };

  FieldNet.prototype.actName = function (layer, neuron) {
    return ACTS[this.layers[layer].acts[neuron]].name;
  };

  /* ---------------------------------------------------------- Classifier --- */

  /*
   * Trainable MLP: tanh hidden layers, softmax output, Adam. Weights are stored
   * output-major here because training touches single samples far more often
   * than it touches batches.
   */
  function Classifier(sizes, seed) {
    this.sizes = sizes.slice();
    this.L = sizes.length - 1;
    this.layers = [];
    var rnd = rand.rng(seed);
    for (var l = 0; l < this.L; l++) {
      var iD = sizes[l], oD = sizes[l + 1];
      var s = Math.sqrt(2 / (iD + oD));
      var w = new Float32Array(iD * oD);
      for (var i = 0; i < w.length; i++) w[i] = rand.gauss(rnd) * s;
      this.layers.push({
        inDim: iD,
        outDim: oD,
        w: w,
        b: new Float32Array(oD),
        mw: new Float32Array(iD * oD),
        vw: new Float32Array(iD * oD),
        mb: new Float32Array(oD),
        vb: new Float32Array(oD),
        a: new Float32Array(oD),
        d: new Float32Array(oD)
      });
    }
    this.step = 0;
  }

  Classifier.prototype.predict = function (x, out) {
    var cur = x;
    for (var l = 0; l < this.L; l++) {
      var la = this.layers[l];
      var a = la.a;
      var last = l === this.L - 1;
      for (var j = 0; j < la.outDim; j++) {
        var s = la.b[j], wr = j * la.inDim;
        for (var k = 0; k < la.inDim; k++) s += cur[k] * la.w[wr + k];
        a[j] = last ? s : Math.tanh(s);
      }
      if (last) {
        var max = -Infinity;
        for (var m = 0; m < la.outDim; m++) if (a[m] > max) max = a[m];
        var sum = 0;
        for (var e = 0; e < la.outDim; e++) { a[e] = Math.exp(a[e] - max); sum += a[e]; }
        for (var n = 0; n < la.outDim; n++) a[n] /= sum;
      }
      cur = a;
    }
    if (out) { for (var o = 0; o < cur.length; o++) out[o] = cur[o]; return out; }
    return cur;
  };

  /* One Adam step on a single sample. Returns the cross-entropy loss. */
  Classifier.prototype.learn = function (x, label, lr) {
    var p = this.predict(x);
    var loss = -Math.log(Math.max(p[label], 1e-9));
    var top = this.layers[this.L - 1];
    for (var j = 0; j < top.outDim; j++) top.d[j] = p[j] - (j === label ? 1 : 0);

    for (var l = this.L - 1; l >= 0; l--) {
      var la = this.layers[l];
      var inp = l === 0 ? x : this.layers[l - 1].a;
      if (l > 0) {
        var below = this.layers[l - 1];
        for (var k = 0; k < below.outDim; k++) {
          var g = 0;
          for (var j2 = 0; j2 < la.outDim; j2++) g += la.d[j2] * la.w[j2 * la.inDim + k];
          below.d[k] = g * (1 - below.a[k] * below.a[k]);
        }
      }
      this.step++;
      var t = this.step;
      var b1c = 1 - Math.pow(0.9, t), b2c = 1 - Math.pow(0.999, t);
      for (var j3 = 0; j3 < la.outDim; j3++) {
        var dz = la.d[j3], wr = j3 * la.inDim;
        for (var k2 = 0; k2 < la.inDim; k2++) {
          var idx = wr + k2;
          var gr = dz * inp[k2];
          la.mw[idx] = 0.9 * la.mw[idx] + 0.1 * gr;
          la.vw[idx] = 0.999 * la.vw[idx] + 0.001 * gr * gr;
          la.w[idx] -= lr * (la.mw[idx] / b1c) / (Math.sqrt(la.vw[idx] / b2c) + 1e-8);
        }
        la.mb[j3] = 0.9 * la.mb[j3] + 0.1 * dz;
        la.vb[j3] = 0.999 * la.vb[j3] + 0.001 * dz * dz;
        la.b[j3] -= lr * (la.mb[j3] / b1c) / (Math.sqrt(la.vb[j3] / b2c) + 1e-8);
      }
    }
    return loss;
  };

  NW.nn = {
    ACTS: ACTS,
    FieldNet: FieldNet,
    Classifier: Classifier
  };
})(window.NW = window.NW || {});
