/*
 * world.js — turning a network into terrain.
 *
 * A world is fully described by its WorldSpec (seed, topology, mutation lineage,
 * latent vector, a few global dials). From the spec we build the CPPN, and from
 * the CPPN we sample regions of tiles. Chunks are cached; nothing is stored on
 * disk and nothing is precomputed, so the map is unbounded in every direction.
 */
(function (NW) {
  'use strict';

  var IN_DIM = 16;      /* see encodePoint below */
  var OUT_DIM = 6;      /* elevation, moisture, temperature, river, flora, ore */
  var CHUNK = 32;       /* tiles per chunk edge */
  var MAX_CHUNKS = 400; /* LRU ceiling; ~17 MB of fields and rasters */
  var AUX = 4;          /* noise channels kept for the authority blend */

  var LIGHT = [-0.55, -0.70, 0.45];
  var RELIEF = 34;      /* vertical exaggeration used for hillshading */
  var SLOPE_K = 16.5;   /* per-tile gradient at which slope reads as 1.0 */

  var NORM_SAMPLES = 2048;
  var NORM_BINS = 256;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /*
   * Hypsometric curve: turns a uniform [0,1] rank into a height in [-1,1] with
   * the shape real planets have. Read it as a budget — 44% of the surface is
   * below sea level, a quarter of it is coastal lowland, and only the last 1.5%
   * reaches the peaks. A single power curve cannot express both a broad lowland
   * and rare summits, so the control points are given explicitly.
   */
  var HYPSO = [
    [0.000, -1.00], [0.120, -0.55], [0.300, -0.18], [0.440, 0.00],
    [0.700, 0.12], [0.860, 0.32], [0.950, 0.55], [0.985, 0.78], [1.000, 1.00]
  ];

  function hypso(u) {
    if (u <= 0) return -1;
    if (u >= 1) return 1;
    var i = 0;
    while (i < HYPSO.length - 2 && u > HYPSO[i + 1][0]) i++;
    var a = HYPSO[i], b = HYPSO[i + 1];
    return a[1] + (u - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
  }

  /*
   * Blending two ranks by weighted average would be wrong: the mean of two
   * independent uniforms is not uniform, it bunches around 0.5. At authority 0.8
   * that quietly deleted every mountain and abyss from the map, because the
   * hypsometric curve was then only ever fed middling ranks.
   *
   * So the blend happens in a Gaussian-ish space instead — logit each rank, mix,
   * rescale so the variance is preserved, and squash back. The marginal
   * distribution is then the same at every setting of the dial, which is the only
   * way "network vs noise" can be an honest comparison.
   */
  var LOGIT_S = 0.5513;   /* logistic -> unit-variance scale factor */

  function toZ(u) {
    u = clamp(u, 1e-4, 1 - 1e-4);
    return Math.log(u / (1 - u)) * LOGIT_S;
  }

  function fromZ(z) { return 1 / (1 + Math.exp(-z / LOGIT_S)); }

  function defaultSpec(seedText) {
    return {
      seed: seedText,
      depth: 3,
      width: 24,
      gain: 1.9,
      lineage: [],
      z: [0, 0, 0, 0],
      scale: 260,
      sea: 0.0,
      auth: 0.8,
      rivers: 1.0
    };
  }

  function cloneSpec(spec) {
    return {
      seed: spec.seed,
      depth: spec.depth,
      width: spec.width,
      gain: spec.gain,
      lineage: spec.lineage.map(function (s) { return s.slice(); }),
      z: spec.z.slice(),
      scale: spec.scale,
      sea: spec.sea,
      auth: spec.auth,
      rivers: spec.rivers
    };
  }

  /* Everything that changes terrain values (as opposed to how we colour them). */
  function specKey(spec) {
    return [
      spec.seed, spec.depth, spec.width, spec.gain.toFixed(3),
      spec.lineage.map(function (s) { return s[0] + ':' + s[1]; }).join(','),
      spec.z.map(function (v) { return v.toFixed(4); }).join(','),
      spec.scale, spec.sea.toFixed(4), spec.auth.toFixed(4), spec.rivers.toFixed(3)
    ].join('|');
  }

  function buildNet(spec) {
    var sizes = [];
    for (var i = 0; i < spec.depth; i++) sizes.push(spec.width);
    sizes.push(OUT_DIM);
    var net = new NW.nn.FieldNet(IN_DIM, sizes, NW.rand.hashString(spec.seed), spec.gain);
    /* Replay the mutation lineage: this is what makes an evolved world sharable. */
    for (var m = 0; m < spec.lineage.length; m++) {
      net = net.mutate(spec.lineage[m][0] >>> 0, spec.lineage[m][1]);
    }
    return net;
  }

  /*
   * `reuseNorm` skips the normalisation pass and adopts another world's measured
   * statistics. Measuring costs 2048 forward passes — 30ms at the default
   * topology, 120ms at the largest — which is fine once per committed change but
   * ruinous when a slider fires sixty input events a second. So interactions
   * borrow the previous world's statistics and re-measure when the drag ends.
   */
  function World(spec, classifier, reuseNorm, normSamples) {
    this.spec = cloneSpec(spec);
    this.key = specKey(this.spec);
    this.classifier = classifier;
    this.net = buildNet(this.spec);
    var s = NW.rand.hashString(this.spec.seed);
    this.noiseA = new NW.rand.Noise(s ^ 0x1b873593);
    this.noiseB = new NW.rand.Noise(s ^ 0x85ebca6b);
    this.noiseC = new NW.rand.Noise(s ^ 0xc2b2ae35);
    this.noiseD = new NW.rand.Noise(s ^ 0x27d4eb2f);
    this.chunks = new Map();
    this.genMs = 0;
    this.genCount = 0;
    this._bufs = {};
    if (reuseNorm) {
      this.lut = reuseNorm.lut;
      this.rivBeta = reuseNorm.rivBeta;
    } else {
      this.buildNormalizer(normSamples || NORM_SAMPLES);
    }
  }

  World.prototype._buf = function (name, Type, len) {
    var b = this._bufs[name];
    if (!b || b.length < len || b.constructor !== Type) {
      b = new Type(len);
      this._bufs[name] = b;
    }
    return b;
  };

  /*
   * Octave counts for a given sample spacing. Point-sampling a 4-octave fbm every
   * 9th tile aliases into confetti, so coarse views drop the octaves finer than
   * their own Nyquist limit. Cheaper and quieter at the same time.
   */
  World.prototype.octaves = function (step) {
    var S = this.spec.scale;
    function oct(f, lac, maxO) {
      var k = Math.log((S / f) / (2.5 * step)) / Math.log(lac);
      return clamp(Math.floor(k) + 1, 1, maxO);
    }
    return {
      a: oct(0.42, 2.03, 4),
      b: oct(1.9, 2.03, 4),
      r: oct(1.15, 2.11, 4),
      l: oct(0.12, 2.03, 3)
    };
  };

  var FULL_OCT = { a: 4, b: 4, r: 4, l: 3 };

  /*
   * Feature encoding: the CPPN's input vector for one point.
   *
   *   0-5   sinusoids of position, including two skewed cross terms. These give
   *         the network something smooth and periodic to compose with, which is
   *         where the organic banding and symmetry come from.
   *   6-11  gradient-noise channels (continental, detail, domain-warped, ridged,
   *         very-low-frequency, and one product term). Noise supplies the
   *         non-repeating detail that pure sinusoids cannot.
   *   12-15 the latent vector z. Constant across the map, so sliding z morphs the
   *         entire planet without touching a single weight.
   */
  World.prototype.encodePoint = function (X, o, aux, ao, xv, yv, oc) {
    var p = this.spec;
    var A = this.noiseA, B = this.noiseB, C = this.noiseC, D = this.noiseD;
    oc = oc || FULL_OCT;

    var nc = A.fbm(xv * 0.42, yv * 0.42, oc.a);
    var nd = B.fbm(xv * 1.9, yv * 1.9, oc.b);
    var wq = C.at(xv * 0.9 + nc * 0.7, yv * 0.9 - nd * 0.35);
    var nr = D.ridged(xv * 1.15, yv * 1.15, oc.r);
    var nl = A.fbm(xv * 0.12 + 40.5, yv * 0.12 - 17.25, oc.l);

    X[o] = Math.sin(xv);
    X[o + 1] = Math.cos(xv);
    X[o + 2] = Math.sin(yv);
    X[o + 3] = Math.cos(yv);
    X[o + 4] = Math.sin(1.73 * xv + 0.41 * yv);
    X[o + 5] = Math.cos(1.29 * yv - 0.67 * xv);
    X[o + 6] = nc;
    X[o + 7] = nd;
    X[o + 8] = wq;
    X[o + 9] = nr;
    X[o + 10] = nl;
    X[o + 11] = nc * nd * 1.6;
    X[o + 12] = p.z[0];
    X[o + 13] = p.z[1];
    X[o + 14] = p.z[2];
    X[o + 15] = p.z[3];

    /* Kept for the noise end of the "network authority" blend. */
    aux[ao] = clamp(nl * 1.05 + nc * 0.62 + nr * 0.12, -1, 1);
    aux[ao + 1] = nd;
    aux[ao + 2] = wq;
    aux[ao + 3] = nr;
  };

  World.prototype.encodeRegion = function (X, aux, x0, y0, W, H, step) {
    var inv = 1 / this.spec.scale;
    var oc = this.octaves(step);
    for (var gy = 0; gy < H; gy++) {
      var yv = (y0 + (gy - 1) * step) * inv;
      for (var gx = 0; gx < W; gx++) {
        var gi = gy * W + gx;
        this.encodePoint(X, gi * IN_DIM, aux, gi * AUX, (x0 + (gx - 1) * step) * inv, yv, oc);
      }
    }
  };

  /*
   * Percentile normalisation.
   *
   * A randomly weighted deep network does not produce a nicely spread output —
   * tanh stacks pile most of their mass near ±1, which straight off the net gives
   * a planet that is all abyss and all snowcap with nothing in between. So we
   * sample a couple of thousand scattered points once per world, measure the
   * empirical distribution of each output channel, and store it as a lookup
   * table from raw value to rank in [0, 1].
   *
   * The rank is what the terrain is built from. This changes nothing about *where*
   * the network puts its features — every contour, coastline and ridge is still
   * exactly a level set of the network — it only fixes how those levels map onto
   * heights and climates, so every seed yields a legible world.
   */
  World.prototype.buildNormalizer = function (samples) {
    var n = samples || NORM_SAMPLES;
    var X = new Float32Array(n * IN_DIM);
    var aux = new Float32Array(n * AUX);
    var rnd = NW.rand.rng(NW.rand.hashString('norm:' + this.key));
    var inv = 1 / this.spec.scale;
    /* Scatter over a span far wider than any single screen, so the statistics
     * describe the whole planet rather than whatever is under the camera. */
    var span = Math.max(6000, this.spec.scale * 40);
    for (var i = 0; i < n; i++) {
      this.encodePoint(X, i * IN_DIM, aux, i * AUX,
        (rnd() - 0.5) * span * inv, (rnd() - 0.5) * span * inv);
    }
    var out = this.net.forward(X, n);

    /*
     * Channels 0..OUT_DIM-1 are the network's outputs; the rest are the raw noise
     * channels. The noise needs the same treatment — an fbm's values bunch around
     * zero, so feeding it to the hypsometric curve unmeasured yields a world with
     * no abyss and no summits, which would make the authority dial look like the
     * network was doing all the work.
     */
    var lut = new Float32Array((OUT_DIM + AUX) * NORM_BINS);
    var col = new Float64Array(n);
    for (var c = 0; c < OUT_DIM + AUX; c++) {
      if (c < OUT_DIM) for (var s = 0; s < n; s++) col[s] = out[s * OUT_DIM + c];
      else for (var s2 = 0; s2 < n; s2++) col[s2] = aux[s2 * AUX + (c - OUT_DIM)];
      var sorted = Array.prototype.slice.call(col).sort(function (a, b) { return a - b; });
      var p = 0;
      for (var b = 0; b < NORM_BINS; b++) {
        var v = -1 + 2 * b / (NORM_BINS - 1);
        while (p < n && sorted[p] <= v) p++;
        lut[c * NORM_BINS + b] = p / n;
      }
    }
    this.lut = lut;

    /*
     * All six outputs are linear reads of the same hidden layer, so they arrive
     * correlated — and when the river channel correlates with elevation, its
     * zero-crossings land on the shoreline and every river reads as a coastal
     * outline instead of drainage. Measure that correlation and keep only the
     * part of the river channel that elevation does not explain.
     */
    var s0 = 0, s3 = 0, s00 = 0, s33 = 0, s03 = 0;
    for (var q = 0; q < n; q++) {
      var a0 = this.rank(0, out[q * OUT_DIM]) - 0.5;
      var a3 = this.rank(3, out[q * OUT_DIM + 3]) - 0.5;
      s0 += a0; s3 += a3; s00 += a0 * a0; s33 += a3 * a3; s03 += a0 * a3;
    }
    var v0 = s00 / n - (s0 / n) * (s0 / n);
    var cov = s03 / n - (s0 / n) * (s3 / n);
    this.rivBeta = v0 > 1e-6 ? clamp(cov / v0, -1.2, 1.2) : 0;
  };

  /* The measured statistics, for another world to borrow mid-interaction. */
  World.prototype.norm = function () {
    return { lut: this.lut, rivBeta: this.rivBeta };
  };

  /* Raw channel value -> rank in [0,1], linearly interpolated between LUT bins. */
  World.prototype.rank = function (c, v) {
    var t = (v + 1) * 0.5 * (NORM_BINS - 1);
    if (t <= 0) return this.lut[c * NORM_BINS];
    if (t >= NORM_BINS - 1) return this.lut[c * NORM_BINS + NORM_BINS - 1];
    var i = t | 0, f = t - i, o = c * NORM_BINS + i;
    return this.lut[o] + f * (this.lut[o + 1] - this.lut[o]);
  };

  /*
   * Sample a rectangle of tiles. `step` > 1 gives a coarse overview (used by the
   * minimap and the evolution thumbnails) through exactly the same pipeline the
   * full-detail chunks use, so a thumbnail never lies about the world.
   *
   * A one-sample halo is added around the request because slope, hillshading and
   * river width all need neighbours.
   */
  World.prototype.buildRegion = function (x0, y0, w, h, step) {
    var t0 = performance.now();
    var p = this.spec;
    var W = w + 2, H = h + 2, n = W * H;

    var X = this._buf('X', Float32Array, n * IN_DIM);
    var aux = this._buf('aux', Float32Array, n * AUX);
    this.encodeRegion(X, aux, x0, y0, W, H, step);

    var out = this.net.forward(X, n);

    /*
     * Fields on the haloed grid. The network's rank is blended with the noise
     * channel's rank — in rank space, not value space, so the land/sea split and
     * the climate spread stay identical however far the authority dial is turned.
     * That makes the dial an honest A/B between "network" and "plain fbm noise".
     */
    var elevG = this._buf('elevG', Float32Array, n);
    var rivG = this._buf('rivG', Float32Array, n);
    var moistG = this._buf('moistG', Float32Array, n);
    var tempG = this._buf('tempG', Float32Array, n);
    var floraG = this._buf('floraG', Float32Array, n);
    var oreG = this._buf('oreG', Float32Array, n);
    var auth = p.auth, noiseW = 1 - auth;
    var pure = auth > 0.999, noNet = auth < 0.001;
    var beta = this.rivBeta || 0;
    var vnorm = 1 / Math.sqrt(auth * auth + noiseW * noiseW);
    var wa = auth * vnorm, wn = noiseW * vnorm;
    for (var i = 0; i < n; i++) {
      var o = i * OUT_DIM, a = i * AUX;
      var e, m, t, fl, or_;
      if (pure) {
        e = this.rank(0, out[o]);
        m = this.rank(1, out[o + 1]);
        t = this.rank(2, out[o + 2]);
        fl = this.rank(4, out[o + 4]);
        or_ = this.rank(5, out[o + 5]);
      } else if (noNet) {
        e = this.rank(6, aux[a]);
        m = this.rank(7, aux[a + 1]);
        t = this.rank(8, aux[a + 2]);
        fl = this.rank(7, aux[a + 1]);
        or_ = this.rank(9, aux[a + 3]);
      } else {
        e = fromZ(wa * toZ(this.rank(0, out[o])) + wn * toZ(this.rank(6, aux[a])));
        m = fromZ(wa * toZ(this.rank(1, out[o + 1])) + wn * toZ(this.rank(7, aux[a + 1])));
        t = fromZ(wa * toZ(this.rank(2, out[o + 2])) + wn * toZ(this.rank(8, aux[a + 2])));
        fl = auth * this.rank(4, out[o + 4]) + noiseW * this.rank(7, aux[a + 1]);
        or_ = auth * this.rank(5, out[o + 5]) + noiseW * this.rank(9, aux[a + 3]);
      }
      elevG[i] = hypso(e);
      moistG[i] = m;
      tempG[i] = t;
      floraG[i] = fl;
      oreG[i] = or_;
      /* Rivers need a signed field whose zero set is the median contour, with the
       * elevation-explained part removed (see buildNormalizer). */
      var rr = (this.rank(3, out[o + 3]) - 0.5) - beta * (this.rank(0, out[o]) - 0.5);
      rivG[i] = auth * rr * 2 + noiseW * (this.rank(9, aux[a + 3]) * 2 - 1);
    }

    var count = w * h;
    var f = {
      x0: x0, y0: y0, w: w, h: h, step: step,
      elev: new Float32Array(count),
      hn: new Float32Array(count),
      moist: new Float32Array(count),
      temp: new Float32Array(count),
      slope: new Float32Array(count),
      river: new Float32Array(count),
      flora: new Float32Array(count),
      ore: new Float32Array(count),
      shade: new Float32Array(count),
      biome: new Uint8Array(count),
      rgb: new Uint8ClampedArray(count * 3)
    };

    var R = NW.biome.PALETTE_R, G = NW.biome.PALETTE_G, Bl = NW.biome.PALETTE_B;
    var K = NW.biome.K;
    var cin = new Float32Array(5);
    var gscale = 1 / (2 * step);
    var slopeK = SLOPE_K;
    var lx = LIGHT[0], ly = LIGHT[1], lz = LIGHT[2];

    for (var iy = 0; iy < h; iy++) {
      for (var ix = 0; ix < w; ix++) {
        var gi = (iy + 1) * W + (ix + 1);
        var ti = iy * w + ix;

        var e = elevG[gi];
        var dx = (elevG[gi + 1] - elevG[gi - 1]) * gscale;
        var dy = (elevG[gi + W] - elevG[gi - W]) * gscale;
        var mag = Math.sqrt(dx * dx + dy * dy);
        var slope = clamp(mag * slopeK, 0, 1);

        var hn = clamp(e - p.sea, -1, 1);

        /* Temperature falls with altitude — the one bit of physics we impose. */
        var temp = clamp(tempG[gi] - Math.max(0, hn) * 0.42, 0, 1);
        var moist = moistG[gi];

        /*
         * Rivers: the network's fourth output is read as a signed field, and its
         * zero-crossings are the watercourses. Distance to the crossing is
         * |r|/|grad r|, so channels stay a couple of tiles wide however
         * stretched the field is locally.
         */
        var river = 0;
        if (hn > 0.01) {
          var rx = (rivG[gi + 1] - rivG[gi - 1]) * gscale;
          var ry = (rivG[gi + W] - rivG[gi - W]) * gscale;
          var rmag = Math.sqrt(rx * rx + ry * ry) + 1e-9;
          var dist = Math.abs(rivG[gi]) / rmag;
          /* Widen a little when sampling coarsely so rivers stay visible on the
           * minimap, but cap it — unclamped, a step-9 overview turns all blue. */
          var width = (0.8 + (1 - hn) * 0.9) * p.rivers * Math.min(step, 2.5);
          /*
           * Every zero-crossing of the channel is a watercourse, and there are far
           * more of them than a map at this scale should draw — left ungated they
           * cover the continent in a uniform net of threads that reads as contour
           * lines. Two smooth gates fix it without touching the geometry: rivers
           * run where it rains, and they fade with altitude, so what survives is
           * drainage basins with trunks in the lowlands.
           */
          river = clamp(1 - dist / width, 0, 1) *
            clamp((moist - 0.38) * 6, 0, 1) *
            clamp(1.25 - hn * 1.1, 0, 1);
        }

        /* Lambertian hillshade, normalised so flat ground sits at 1.0. */
        var nx = -dx * RELIEF, ny = -dy * RELIEF;
        var nlen = Math.sqrt(nx * nx + ny * ny + 1);
        var lam = (nx * lx + ny * ly + lz) / nlen;
        f.shade[ti] = clamp(1 + (lam - lz) * 1.05, 0.6, 1.34);

        f.elev[ti] = e;
        f.hn[ti] = hn;
        f.moist[ti] = moist;
        f.temp[ti] = temp;
        f.slope[ti] = slope;
        f.river[ti] = river;
        f.flora[ti] = floraG[gi];
        f.ore[ti] = oreG[gi];

        /* The learned part: a softmax over biomes, blended straight into colour. */
        cin[0] = hn; cin[1] = moist; cin[2] = temp; cin[3] = slope; cin[4] = river;
        var pr = this.classifier.predict(cin);
        var cr = 0, cg = 0, cb = 0, best = 0, bestP = -1;
        for (var k = 0; k < K; k++) {
          var pk = pr[k];
          cr += pk * R[k];
          cg += pk * G[k];
          cb += pk * Bl[k];
          if (pk > bestP) { bestP = pk; best = k; }
        }
        f.biome[ti] = best;
        f.rgb[ti * 3] = cr;
        f.rgb[ti * 3 + 1] = cg;
        f.rgb[ti * 3 + 2] = cb;
      }
    }

    /* Only full-size regions are worth reporting; a 1-tile probe would skew it. */
    if (count >= 256) {
      this.genMs = performance.now() - t0;
      this.genCount++;
    }
    return f;
  };

  World.prototype.chunkKey = function (cx, cy) { return cx + ',' + cy; };

  World.prototype.getChunk = function (cx, cy) {
    var k = this.chunkKey(cx, cy);
    var c = this.chunks.get(k);
    if (c) {
      /* Touch for LRU. */
      this.chunks.delete(k);
      this.chunks.set(k, c);
    }
    return c;
  };

  World.prototype.makeChunk = function (cx, cy) {
    var f = this.buildRegion(cx * CHUNK, cy * CHUNK, CHUNK, CHUNK, 1);
    f.cx = cx;
    f.cy = cy;
    f.raster = null;
    f.rasterMode = null;
    f.sites = null;
    this.chunks.set(this.chunkKey(cx, cy), f);
    while (this.chunks.size > MAX_CHUNKS) {
      var oldest = this.chunks.keys().next().value;
      this.chunks.delete(oldest);
    }
    return f;
  };

  /* One tile, on demand, without touching the chunk cache — for the inspector. */
  World.prototype.probe = function (wx, wy) {
    var f = this.buildRegion(wx, wy, 1, 1, 1);
    var X = this._buf('X', Float32Array, 9 * IN_DIM);
    var vec = new Float32Array(IN_DIM);
    /* Centre sample of the 3x3 haloed grid encoded by buildRegion. */
    for (var i = 0; i < IN_DIM; i++) vec[i] = X[(1 * 3 + 1) * IN_DIM + i];
    var cin = new Float32Array([f.hn[0], f.moist[0], f.temp[0], f.slope[0], f.river[0]]);
    var probs = this.classifier.predict(cin, new Float32Array(NW.biome.K));
    return {
      wx: wx, wy: wy,
      fields: f,
      input: vec,
      trace: this.net.trace(vec),
      cin: cin,
      probs: probs
    };
  };

  /*
   * Activation map for a single hidden neuron over a chunk. This is the honest
   * answer to "what is the network actually computing" — every visible feature
   * of the world is a weighted sum of pictures like these.
   */
  World.prototype.probeNeuron = function (cx, cy, layer, neuron) {
    var W = CHUNK + 2, H = CHUNK + 2, n = W * H;
    var X = this._buf('pX', Float32Array, n * IN_DIM);
    var aux = this._buf('pAux', Float32Array, n * AUX);
    this.encodeRegion(X, aux, cx * CHUNK, cy * CHUNK, W, H, 1);
    var act = this.net.forward(X, n, layer);
    var oD = layer < 0 ? IN_DIM : this.net.layers[layer].outDim;
    var idx = Math.min(neuron, oD - 1);
    var outArr = new Float32Array(CHUNK * CHUNK);
    for (var iy = 0; iy < CHUNK; iy++) {
      for (var ix = 0; ix < CHUNK; ix++) {
        outArr[iy * CHUNK + ix] = act[((iy + 1) * W + (ix + 1)) * oD + idx];
      }
    }
    return outArr;
  };

  NW.world = {
    CHUNK: CHUNK,
    IN_DIM: IN_DIM,
    OUT_DIM: OUT_DIM,
    World: World,
    defaultSpec: defaultSpec,
    cloneSpec: cloneSpec,
    specKey: specKey,
    buildNet: buildNet,
    clamp: clamp
  };
})(window.NW = window.NW || {});
