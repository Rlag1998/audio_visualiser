/*
 * main.js — application: camera, chunk streaming, evolution, input, wiring.
 */
(function (NW) {
  'use strict';

  var CHUNK = NW.world.CHUNK;
  var clamp = NW.world.clamp;
  var $ = function (id) { return document.getElementById(id); };

  var VIEWS = ['biome', 'elev', 'moist', 'temp', 'slope', 'hydro', 'flora', 'ore', 'neuron'];

  var app = {
    spec: null,
    world: null,
    trainer: null,
    cam: { x: 0, y: 0, tilePx: 7 },
    mode: 'biome',
    opts: { decor: true, places: true, contours: false, grid: false, smooth: false },
    probe: { layer: 0, neuron: 0 },
    queue: [],
    preview: null,
    lowres: false,
    drift: false,
    driftT: 0,
    hover: null,
    hoverInfo: null,
    candidates: [],
    candQueue: [],
    candJob: null,
    tour: null,
    civMisses: [],
    civQueued: null,
    civRoadQueue: [],
    dossier: null,
    mm: null,
    mmJob: null,
    keys: {},
    fps: 0,
    texSeed: 0,
    basisKey: '',
    perSample: 0,
    missing: 0,
    lastFrame: 0,
    statTick: 0,
    hoverTick: 0,
    factTick: 0
  };

  var map = $('map');
  var mctx = map.getContext('2d');
  var dpr = 1;
  var cssW = 0, cssH = 0;

  /* --------------------------------------------------------------- boot --- */

  function startTraining(seed, label) {
    app.trainer = new NW.biome.Trainer(seed, {});
    $('boot').classList.remove('gone');
    $('boot').querySelector('.boot-sub').textContent = label;
    $('bootFill').style.width = '0%';
  }

  function finishTraining() {
    var t = app.trainer;
    NW.ui.facts($('clsFacts'), [
      ['topology', t.net.sizes.join(' → ')],
      ['parameters', t.net.layers.reduce(function (a, l) { return a + l.w.length + l.b.length; }, 0)],
      ['train samples', t.data.n],
      ['final loss', t.loss.toFixed(4)],
      ['oracle agreement', (t.accuracy * 100).toFixed(1) + '%']
    ]);
    NW.ui.drawLoss($('lossCanvas'), t);
    $('boot').classList.add('gone');
    rebuildWorld(true);
  }

  /* -------------------------------------------------------------- world --- */

  /*
   * Swap in a world for the current spec. `reuse` borrows the previous world's
   * normalisation instead of re-measuring it — correct enough for a preview while
   * a control is being dragged, and the difference is measured away on release.
   */
  function swapWorld(reuse) {
    app.world = new NW.world.World(app.spec, app.trainer.net,
      reuse && app.world ? app.world.norm() : null);
    app.texSeed = NW.rand.hashString(app.world.key) ^ 0x5bf03635;
  }

  function rebuildWorld(alsoCandidates) {
    swapWorld(false);
    app.civQueued = null;
    if (app.dossier) closeDossier();
    app.queue.length = 0;
    /* Keep the old minimap on screen; the key check below rebuilds it in the
     * background rather than blanking the HUD on every slider release. */
    app.mmJob = null;
    app.hoverInfo = null;
    refreshNetFacts();
    refreshProbeSelectors();
    writeHash();
    if (alsoCandidates) spawnCandidates();
  }

  function refreshNetFacts() {
    var net = app.world.net;
    var sizes = [NW.world.IN_DIM].concat(net.layers.map(function (l) { return l.outDim; }));
    var counts = {};
    for (var l = 0; l < net.layers.length - 1; l++) {
      for (var j = 0; j < net.layers[l].outDim; j++) {
        var nm = net.actName(l, j);
        counts[nm] = (counts[nm] || 0) + 1;
      }
    }
    var mix = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (k) { return k + '×' + counts[k]; }).join(' ');
    /* A chunk is uninterruptible work; past ~30ms it no longer fits in a frame
     * and streaming visibly lags, so say so rather than letting it feel broken. */
    var cost = perSampleMs() * CHUNK_SAMPLES;
    NW.ui.facts($('netFacts'), [
      ['topology', sizes.join(' → ')],
      ['weights', net.weightCount()],
      ['activations', mix],
      ['mutation steps', app.spec.lineage.length],
      ['chunk cost', cost.toFixed(1) + ' ms / ' + (CHUNK * CHUNK) + ' tiles' +
        (cost > 30 ? ' — heavy' : ''), cost > 30 ? 'warn' : '']
    ]);
  }

  function refreshProbeSelectors() {
    var net = app.world.net;
    var selL = $('selLayer'), selN = $('selNeuron');
    var keepL = Math.min(app.probe.layer, net.layers.length - 2);
    selL.innerHTML = '';
    for (var l = 0; l < net.layers.length - 1; l++) {
      var o = document.createElement('option');
      o.value = l;
      o.textContent = 'h' + (l + 1);
      selL.appendChild(o);
    }
    app.probe.layer = Math.max(0, keepL);
    selL.value = app.probe.layer;
    var w = net.layers[app.probe.layer].outDim;
    selN.innerHTML = '';
    for (var j = 0; j < w; j++) {
      var oo = document.createElement('option');
      oo.value = j;
      oo.textContent = '#' + j;
      selN.appendChild(oo);
    }
    app.probe.neuron = Math.min(app.probe.neuron, w - 1);
    selN.value = app.probe.neuron;
  }

  function writeHash() {
    try {
      history.replaceState(null, '', '#' + NW.ui.encodeSpec(app.spec));
    } catch (e) { /* file:// can refuse replaceState; the app works regardless. */ }
  }

  /* ------------------------------------------------------------ drawing --- */

  /*
   * Measured when the stage actually changes size, not once a frame. Reading
   * geometry every frame forces a synchronous layout of the whole document, and
   * anything that dirties the panel — a slider label, a stat line — then makes
   * that layout expensive. It cost 40ms a frame while dragging the latent vector.
   */
  function measureStage() {
    var stage = map.parentNode;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cssW = Math.max(1, Math.floor(stage.clientWidth));
    cssH = Math.max(1, Math.floor(stage.clientHeight));
    if (map.width !== Math.round(cssW * dpr) || map.height !== Math.round(cssH * dpr)) {
      map.width = Math.round(cssW * dpr);
      map.height = Math.round(cssH * dpr);
    }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function watchStage() {
    measureStage();
    if (window.ResizeObserver) {
      new ResizeObserver(measureStage).observe(map.parentNode);
    } else {
      window.addEventListener('resize', measureStage);
    }
  }

  function viewport() {
    var wT = cssW / app.cam.tilePx, hT = cssH / app.cam.tilePx;
    return {
      wTiles: wT, hTiles: hT,
      left: app.cam.x - wT / 2, top: app.cam.y - hT / 2,
      right: app.cam.x + wT / 2, bottom: app.cam.y + hT / 2
    };
  }

  /*
   * Coarse level of detail: one downsampled region standing in for the whole
   * viewport. Used when zoomed out past the point where chunks could stream in,
   * and while the latent vector or a terrain dial is being dragged.
   *
   * The result is cached with a margin around the viewport, so small pans reuse
   * it instead of rebuilding.
   */
  var previewCanvas = document.createElement('canvas');
  var PREVIEW_PAD = 0.16;

  /*
   * Every coarse-sampling budget in the app is expressed in milliseconds, not in
   * samples, because the cost of a sample depends on the network the user chose:
   * a 5x48 CPPN is six times the work of the default. Sizing these in samples
   * meant the largest topology turned a 55ms preview into a 200ms one and a
   * thumbnail into a 1.6-second freeze. The chunk timer is the calibration.
   */
  var CHUNK_SAMPLES = (CHUNK + 2) * (CHUNK + 2);

  /*
   * Calibrated only on chunk builds, which are a fixed size, and carried across
   * world swaps because the cost per sample follows the topology rather than the
   * world. Measuring it from the preview instead would be circular — the preview
   * would size itself from its own last cost and drift.
   */
  function noteChunkCost(ms) {
    var v = ms / CHUNK_SAMPLES;
    app.perSample = app.perSample ? app.perSample * 0.7 + v * 0.3 : v;
  }

  function perSampleMs() {
    return app.perSample || 17 / CHUNK_SAMPLES;
  }

  function samplesFor(ms, lo, hi) {
    return clamp(Math.round(ms / perSampleMs()), lo, hi);
  }

  /*
   * Two qualities. As a backdrop under chunks that have not arrived yet it is on
   * screen for a few hundred milliseconds, so it is built cheap — its rebuild is
   * the longest frame in a pan, and halving it halves that spike. When it *is*
   * the picture — dragging a dial, animating z — it gets the full budget.
   */
  function previewPlan(vp, quality) {
    /*
     * The margin exists so a pan can reuse the cached preview. While a control is
     * being dragged the camera is still, so the margin is pure waste — dropping it
     * buys back a third of the samples and spends them on resolution instead.
     */
    var pad = quality === 'backdrop' ? PREVIEW_PAD : 0.02;
    var tilesW = vp.wTiles * (1 + 2 * pad);
    var tilesH = vp.hTiles * (1 + 2 * pad);
    var area = tilesW * tilesH;

    /*
     * Budget in samples taken, not pixels produced, and never supersampled: the
     * preview is only ever on screen while something is moving — a drag, a morph,
     * terrain streaming in — and motion hides the aliasing that a still image
     * would show. Spending the budget on resolution instead is the better trade,
     * and it is four times the pixels for the same work. (The minimap and the
     * offspring thumbnails are stills, and those do supersample.)
     */
    var samples = samplesFor(quality === 'backdrop' ? 13 : 45, 800, 30000);
    /* Fractional, because rounding the step to an integer at these scales throws
     * away up to half the budget — sqrt(area/samples) of 2.5 becomes 3. */
    var step = Math.max(1, Math.sqrt(area / samples));
    var w = Math.ceil(tilesW / step) + 1;
    var h = Math.ceil(tilesH / step) + 1;
    return {
      quality: quality, step: step, sub: step, ss: 1, w: w, h: h,
      x0: Math.floor((vp.left - vp.wTiles * pad) / step) * step,
      y0: Math.floor((vp.top - vp.hTiles * pad) / step) * step
    };
  }

  function drawPreview(vp, quality) {
    var plan = previewPlan(vp, quality);
    var p = app.preview;
    var stale = !p || p.key !== app.world.key || p.quality !== plan.quality ||
      p.step !== plan.step || p.ss !== plan.ss ||
      vp.left < p.x0 || vp.top < p.y0 ||
      vp.right > p.x0 + p.w * p.step || vp.bottom > p.y0 + p.h * p.step;

    if (stale) {
      var region = app.world.buildRegion(plan.x0, plan.y0, plan.w * plan.ss, plan.h * plan.ss, plan.sub);
      NW.render.regionToCanvas(region, plan.ss, previewCanvas);
      app.preview = p = {
        key: app.world.key, quality: plan.quality, step: plan.step, ss: plan.ss,
        w: plan.w, h: plan.h, x0: plan.x0, y0: plan.y0
      };
    }

    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(previewCanvas,
      (p.x0 - vp.left) * app.cam.tilePx, (p.y0 - vp.top) * app.cam.tilePx,
      p.w * p.step * app.cam.tilePx, p.h * p.step * app.cam.tilePx);
  }

  function ensureChunks(vp) {
    var c0x = Math.floor(vp.left / CHUNK), c1x = Math.floor(vp.right / CHUNK);
    var c0y = Math.floor(vp.top / CHUNK), c1y = Math.floor(vp.bottom / CHUNK);
    var wanted = [];
    for (var cy = c0y; cy <= c1y; cy++) {
      for (var cx = c0x; cx <= c1x; cx++) {
        if (!app.world.getChunk(cx, cy)) {
          var dx = (cx + 0.5) * CHUNK - app.cam.x, dy = (cy + 0.5) * CHUNK - app.cam.y;
          wanted.push([cx, cy, dx * dx + dy * dy]);
        }
      }
    }
    /*
     * Once everything on screen exists, spend the leftover budget on a one-chunk
     * ring just outside the viewport, so panning reveals finished terrain instead
     * of black squares.
     */
    if (!wanted.length) {
      for (var py = c0y - 1; py <= c1y + 1; py++) {
        for (var px = c0x - 1; px <= c1x + 1; px++) {
          if (py > c0y - 1 && py < c1y + 1 && px > c0x - 1 && px < c1x + 1) continue;
          if (!app.world.getChunk(px, py)) {
            var pdx = (px + 0.5) * CHUNK - app.cam.x, pdy = (py + 0.5) * CHUNK - app.cam.y;
            wanted.push([px, py, pdx * pdx + pdy * pdy]);
          }
        }
      }
    }
    wanted.sort(function (a, b) { return a[2] - b[2]; });
    app.queue = wanted;

    /* Generate nearest-first inside a frame budget so panning never stalls. */
    var t0 = performance.now();
    while (app.queue.length && performance.now() - t0 < 11) {
      var job = app.queue.shift();
      app.world.makeChunk(job[0], job[1]);
      noteChunkCost(app.world.genMs);
    }

    /* Count what is still missing on screen — the prefetch ring does not count. */
    var missing = 0;
    for (var my = c0y; my <= c1y; my++) {
      for (var mx = c0x; mx <= c1x; mx++) if (!app.world.getChunk(mx, my)) missing++;
    }
    app.missing = missing;
    return { c0x: c0x, c1x: c1x, c0y: c0y, c1y: c1y, missing: missing };
  }

  function drawWorld(vp) {
    var range = ensureChunks(vp);
    var tp = app.cam.tilePx;
    var probeTag = app.mode === 'neuron' ? ('n' + app.probe.layer + '.' + app.probe.neuron) : '';

    /*
     * Anything not yet generated shows the coarse preview rather than a black
     * square: pan into new territory and the map arrives blurred, then sharpens
     * chunk by chunk. Only paid for while something is actually missing.
     */
    if (range.missing && app.mode === 'biome') drawPreview(vp, 'backdrop');

    /*
     * Changing the probed neuron invalidates every visible chunk's activation
     * map at once. Re-running them all in one frame is a couple of hundred
     * milliseconds, so they refresh a few per frame like everything else — the
     * map ripples over to the new neuron instead of stopping dead.
     */
    var probeBudget = Math.max(1, Math.floor(samplesFor(11, 1, 40000) / CHUNK_SAMPLES));

    mctx.imageSmoothingEnabled = !!app.opts.smooth;
    for (var cy = range.c0y; cy <= range.c1y; cy++) {
      for (var cx = range.c0x; cx <= range.c1x; cx++) {
        var ox = (cx * CHUNK - vp.left) * tp;
        var oy = (cy * CHUNK - vp.top) * tp;
        var x = Math.round(ox), y = Math.round(oy);
        var w = Math.round(ox + CHUNK * tp) - x;
        var h = Math.round(oy + CHUNK * tp) - y;
        var ch = app.world.getChunk(cx, cy);
        if (!ch) {
          if (app.mode !== 'biome') {
            mctx.fillStyle = '#0a0e14';
            mctx.fillRect(x, y, w, h);
          }
          continue;
        }
        if (app.mode === 'neuron' && ch.probeTag !== probeTag) {
          if (probeBudget <= 0) continue;
          probeBudget--;
          ch.probe = app.world.probeNeuron(cx, cy, app.probe.layer, app.probe.neuron);
          ch.probeTag = probeTag;
          ch.rasterMode = null;
        }
        var raster = NW.render.rasterize(ch, app.mode, {
          contours: app.opts.contours,
          probeTag: probeTag,
          seed: app.texSeed
        });
        mctx.drawImage(raster, 0, 0, CHUNK, CHUNK, x, y, w, h);
      }
    }

    /* Overlays, back to front: props, then roads, then place markers on top. */
    if (app.mode === 'biome' && (app.opts.decor || app.opts.places)) {
      var bounds = { left: 0, top: 0, right: cssW, bottom: cssH };
      for (var dy2 = range.c0y; dy2 <= range.c1y; dy2++) {
        for (var dx2 = range.c0x; dx2 <= range.c1x; dx2++) {
          var c2 = app.world.getChunk(dx2, dy2);
          if (c2 && app.opts.decor) {
            NW.render.drawDecor(mctx, app.world, c2,
              (dx2 * CHUNK - vp.left) * tp, (dy2 * CHUNK - vp.top) * tp, tp, bounds);
          }
        }
      }
      if (app.opts.places && tp >= 3.5) {
        NW.render.drawRoads(mctx, app.world, vp, tp);
        app.civMisses.length = 0;
        for (var sy = range.c0y; sy <= range.c1y; sy++) {
          for (var sx = range.c0x; sx <= range.c1x; sx++) {
            var c3 = app.world.getChunk(sx, sy);
            if (c3) {
              NW.render.drawSites(mctx, app.world, c3,
                (sx * CHUNK - vp.left) * tp, (sy * CHUNK - vp.top) * tp, tp, app.civMisses);
            }
          }
        }
      }
    }

    if (app.opts.grid) {
      mctx.strokeStyle = 'rgba(120,180,200,0.28)';
      mctx.lineWidth = 1;
      mctx.font = '9px ui-monospace, monospace';
      mctx.fillStyle = 'rgba(140,200,215,0.55)';
      for (var gx = range.c0x; gx <= range.c1x + 1; gx++) {
        var lx = Math.round((gx * CHUNK - vp.left) * tp) + 0.5;
        mctx.beginPath(); mctx.moveTo(lx, 0); mctx.lineTo(lx, cssH); mctx.stroke();
      }
      for (var gy = range.c0y; gy <= range.c1y + 1; gy++) {
        var ly = Math.round((gy * CHUNK - vp.top) * tp) + 0.5;
        mctx.beginPath(); mctx.moveTo(0, ly); mctx.lineTo(cssW, ly); mctx.stroke();
      }
      for (var ty = range.c0y; ty <= range.c1y; ty++) {
        for (var tx = range.c0x; tx <= range.c1x; tx++) {
          mctx.fillText(tx + ',' + ty,
            (tx * CHUNK - vp.left) * tp + 4, (ty * CHUNK - vp.top) * tp + 12);
        }
      }
    }
  }

  /* ------------------------------------------------------------ minimap --- */

  /*
   * The minimap covers 640 tiles — sixteen thousand samples, a third of a second
   * of solid work. Doing that in one go stutters the whole app every time you pan
   * far enough to need a new one, so it is built a band at a time into a back
   * buffer, only in frames where no terrain chunk is waiting, and swapped in when
   * complete. The visible minimap never goes blank and nothing ever stalls.
   */
  var MM_N = 128, MM_STEP = 5;
  var MM_SPAN = MM_N * MM_STEP;

  function mmBuffer() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = MM_N;
    /* The completed buffer is read back once for the blur; the hint keeps Chrome
     * from warning and keeps the canvas on the CPU where the readback is cheap. */
    return { cv: cv, ctx: cv.getContext('2d', { willReadFrequently: true }) };
  }

  var mmFront = mmBuffer();
  var mmBack = mmBuffer();

  function updateMinimap(vp) {
    var wantX = Math.round(app.cam.x - MM_SPAN / 2);
    var wantY = Math.round(app.cam.y - MM_SPAN / 2);

    if (!app.mmJob) {
      var stale = !app.mm || app.mm.key !== app.world.key ||
        Math.abs(app.cam.x - (app.mm.x0 + MM_SPAN / 2)) > MM_SPAN * 0.2 ||
        Math.abs(app.cam.y - (app.mm.y0 + MM_SPAN / 2)) > MM_SPAN * 0.2;
      if (stale) app.mmJob = { x0: wantX, y0: wantY, row: 0, key: app.world.key };
    }

    if (app.mmJob && !app.missing && !app.lowres) {
      var job = app.mmJob;
      if (job.key !== app.world.key) {
        app.mmJob = null;
      } else {
        var rows = Math.min(clamp(Math.round(samplesFor(12, 300, 6000) / MM_N), 2, 24),
          MM_N - job.row);
        var region = app.world.buildRegion(
          job.x0, job.y0 + job.row * MM_STEP, MM_N, rows, MM_STEP);
        var band = NW.render.regionToCanvas(region, 1, null, false);
        mmBack.ctx.drawImage(band, 0, job.row);
        job.row += rows;
        if (job.row >= MM_N) {
          /* Blur once at the end: banding a 3x3 filter would seam every band. */
          NW.render.blurCanvas(mmBack.cv, mmBack.ctx);
          var t = mmFront;
          mmFront = mmBack;
          mmBack = t;
          app.mm = { x0: job.x0, y0: job.y0, key: job.key };
          app.mmJob = null;
        }
      }
    }

    NW.ui.drawMinimap($('minimap'), mmFront.cv, app.mm, MM_SPAN, app.cam, vp);
  }

  /* ----------------------------------------------------------- evolution --- */

  function spawnCandidates() {
    var rnd = NW.rand.rng((NW.rand.hashString(app.world.key) ^ (app.spec.lineage.length * 2654435761)) >>> 0);
    var sigma = parseFloat($('rngSigma').value);
    app.candidates = [{ spec: NW.world.cloneSpec(app.spec), parent: true }];
    for (var i = 0; i < 5; i++) {
      var s = NW.world.cloneSpec(app.spec);
      s.lineage.push([(rnd() * 4294967295) >>> 0, sigma]);
      app.candidates.push({ spec: s, parent: false });
    }
    var g = $('gallery');
    g.innerHTML = '';
    app.candQueue = [];
    app.candJob = null;
    for (var c = 0; c < app.candidates.length; c++) {
      var cv = document.createElement('canvas');
      cv.width = CAND_PX;
      cv.height = CAND_PX;
      if (app.candidates[c].parent) {
        cv.className = 'parent';
        cv.title = 'current world (the parent)';
      } else {
        cv.title = 'adopt this mutation';
      }
      cv.dataset.idx = c;
      g.appendChild(cv);
      app.candidates[c].canvas = cv;
      app.candQueue.push(c);
    }
  }

  /*
   * Thumbnails are centred on the camera and cover a couple of feature periods,
   * supersampled 2x — a thumbnail you cannot tell apart from its siblings is
   * useless for choosing a parent. That is 31k samples each, so like the minimap
   * they are built a band at a time, with the band sized to the current cost of a
   * sample. Each candidate measures its own statistics, at a third of the usual
   * sample count: normalising a mutant against its parent's distribution would
   * disguise exactly the change you are being asked to judge.
   */
  var CAND_PX = 88, CAND_SS = 2, CAND_NORM = 768;

  function pumpCandidates() {
    if (!app.candJob) {
      if (!app.candQueue.length) return;
      var cand = app.candidates[app.candQueue.shift()];
      var span = cand.spec.scale * 2.4;
      app.candJob = {
        cand: cand,
        world: new NW.world.World(cand.spec, app.trainer.net, null, CAND_NORM),
        span: span,
        sub: span / (CAND_PX * CAND_SS),
        row: 0
      };
      return;   /* building the network and its statistics is this frame's share */
    }

    var job = app.candJob;
    var n = CAND_PX * CAND_SS;
    var rows = clamp(Math.round(samplesFor(14, 400, 20000) / n), CAND_SS, n);
    rows -= rows % CAND_SS;                 /* keep bands aligned to the downsample */
    rows = Math.min(Math.max(rows, CAND_SS), n - job.row);

    var region = job.world.buildRegion(
      Math.round(app.cam.x - job.span / 2),
      Math.round(app.cam.y - job.span / 2) + job.row * job.sub,
      n, rows, job.sub);
    var band = NW.render.regionToCanvas(region, CAND_SS, null);
    job.cand.canvas.getContext('2d').drawImage(band, 0, job.row / CAND_SS);

    job.row += rows;
    if (job.row >= n) app.candJob = null;
  }

  function adopt(idx) {
    var cand = app.candidates[idx];
    if (!cand || cand.parent) return;
    app.spec = NW.world.cloneSpec(cand.spec);
    rebuildWorld(true);
  }

  /* ------------------------------------------------------------ inspector --- */

  function updateInspector() {
    if (!app.hover) return;
    var vp = viewport();
    var wx = Math.floor(vp.left + app.hover.x / app.cam.tilePx);
    var wy = Math.floor(vp.top + app.hover.y / app.cam.tilePx);
    var info = app.world.probe(wx, wy);
    app.hoverInfo = info;

    var f = info.fields;
    var best = 0;
    for (var k = 1; k < info.probs.length; k++) if (info.probs[k] > info.probs[best]) best = k;
    var B = NW.biome.BIOMES[best];

    NW.ui.facts($('insFields'), [
      ['tile', wx + ', ' + wy],
      ['biome (argmax)', B.name],
      ['confidence', (info.probs[best] * 100).toFixed(1) + '%'],
      ['height', f.elev[0].toFixed(3) + '  (rel ' + f.hn[0].toFixed(3) + ')'],
      ['moisture', f.moist[0].toFixed(3)],
      ['temperature', f.temp[0].toFixed(3)],
      ['slope', f.slope[0].toFixed(3)],
      ['river', f.river[0].toFixed(3)],
      ['flora / ore', f.flora[0].toFixed(2) + ' / ' + f.ore[0].toFixed(2)]
    ]);
    NW.ui.drawNet($('netCanvas'), app.world.net, info.trace);
    NW.ui.drawProbs($('probCanvas'), info.probs);

    var tip = $('tooltip');
    tip.classList.remove('hidden');
    tip.innerHTML = '<b>' + B.name + '</b> ' + (info.probs[best] * 100).toFixed(0) + '%<br>' +
      'h ' + f.hn[0].toFixed(2) + '  m ' + f.moist[0].toFixed(2) +
      '  t ' + f.temp[0].toFixed(2) + (f.river[0] > 0.2 ? '<br>river ' + f.river[0].toFixed(2) : '');
    var tx = app.hover.x + 14, ty = app.hover.y + 14;
    if (tx > cssW - 190) tx = app.hover.x - 176;
    if (ty > cssH - 70) ty = app.hover.y - 62;
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }

  /* ---------------------------------------------------------------- loop --- */

  function frame(now) {
    requestAnimationFrame(frame);

    if (!app.trainer.done) {
      var was = app.trainer.pump(14);
      $('bootFill').style.width = (app.trainer.progress() * 100).toFixed(1) + '%';
      $('bootStat').textContent = 'epoch ' + app.trainer.epoch + '/' + app.trainer.epochs +
        '   loss ' + (app.trainer.loss ? app.trainer.loss.toFixed(4) : '—');
      if (app.trainer.history.length) NW.ui.drawLoss($('lossCanvas'), app.trainer);
      if (was) finishTraining();
      return;
    }
    if (!app.world) return;

    /* While the tournament overlay covers the map, the only work that matters
     * is its thumbnails; skip the map entirely (and save phone batteries). */
    if (app.tour) {
      app.lastFrame = now;
      tourPump();
      return;
    }

    var dt = app.lastFrame ? Math.min(0.1, (now - app.lastFrame) / 1000) : 0.016;
    app.lastFrame = now;
    app.fps = app.fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;

    /* Keyboard pan, in screen pixels per second so it feels the same at any zoom. */
    var pan = 620 * dt / app.cam.tilePx;
    if (app.keys.w) app.cam.y -= pan;
    if (app.keys.s) app.cam.y += pan;
    if (app.keys.a) app.cam.x -= pan;
    if (app.keys.d) app.cam.x += pan;

    if (app.drift) {
      app.driftT += dt * 0.13;
      var t = app.driftT;
      setZ([
        Math.sin(t) * 1.1,
        Math.sin(t * 0.73 + 1.1) * 1.1,
        Math.cos(t * 0.51) * 0.9,
        Math.sin(t * 0.37 + 2.2) * 0.9
      ], true);
    }

    /*
     * While a dial or the latent vector is moving, every cached chunk is already
     * invalid, so there is nothing to stream — draw the coarse region only.
     */
    var vp = viewport();
    mctx.clearRect(0, 0, cssW, cssH);
    if (app.lowres) {
      app.queue.length = 0;
      drawPreview(vp, 'full');
    } else {
      drawWorld(vp);
    }

    updateMinimap(vp);
    if (!app.lowres && !app.missing) {
      /* Idle-frame jobs, in order of what the user is most likely looking at. */
      pumpDossier();
      civPump();
      if (app.basisKey !== basisKey()) buildBasisSheet();
      else pumpCandidates();
    }

    if (app.hover && !app.lowres && now - app.hoverTick > 55) {
      app.hoverTick = now;
      updateInspector();
    }

    if (now - app.statTick > 120) {
      app.statTick = now;
      $('stats').textContent =
        'fps ' + app.fps.toFixed(0) + '   chunks ' + app.world.chunks.size +
        '   gen ' + (perSampleMs() * CHUNK_SAMPLES).toFixed(1) + 'ms\n' +
        'zoom ' + app.cam.tilePx.toFixed(1) + 'px   weights ' + app.world.net.weightCount() +
        '   queue ' + app.queue.length;
      $('hudCoords').textContent =
        'x ' + Math.round(app.cam.x) + '  y ' + Math.round(app.cam.y) +
        '   ' + MM_SPAN + ' tiles across';
      /* The measured chunk cost only exists after some chunks have been built. */
      if (app.world.genCount && now - app.factTick > 900) {
        app.factTick = now;
        refreshNetFacts();
      }
    }
  }

  /* --------------------------------------------------------------- input --- */

  /*
   * `syncInputs` writes the values back into the range inputs — needed when drift
   * or the jump button moved them, skipped when the user is dragging one, since
   * writing to an input mid-drag dirties layout for no visible gain.
   */
  function setZ(z, syncInputs) {
    app.spec.z = z;
    for (var i = 0; i < 4; i++) {
      if (syncInputs) $('z' + i).value = z[i];
      $('vz' + i).textContent = z[i].toFixed(2);
    }
    swapWorld(app.drift || app.lowres);
  }

  /*
   * Sliders apply live against a coarse preview while dragging, then commit to
   * full-resolution chunks once the value settles. Terrain dials invalidate every
   * cached chunk, so doing it the other way round would drop the framerate to a
   * crawl.
   *
   * The end of a drag is detected by a quiet period, not by the `change` event:
   * Chrome fires `change` on a range input on *every* drag step, not on release.
   * Trusting it meant each step re-measured the world's statistics, respawned all
   * six offspring, and flipped the preview between its two qualities — each flip
   * invalidating the other's cache, so the preview rebuilt at full resolution
   * every single frame. That alone was 90ms a frame on the latent sliders.
   */
  var COMMIT_MS = 200;
  var commitTimer = null;

  function beginInteraction() {
    app.lowres = true;
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(endInteraction, COMMIT_MS);
  }

  function endInteraction() {
    commitTimer = null;
    if (app.drift) return;      /* drift owns lowres; there is nothing to settle */
    app.lowres = false;
    rebuildWorld(false);
    spawnCandidates();
  }

  function bindSlider(id, label, fmt, apply) {
    var el = $(id);
    var lbl = $(label);
    function live() {
      var v = parseFloat(el.value);
      lbl.textContent = fmt(v);
      apply(v);
      beginInteraction();
    }
    el.addEventListener('input', live);
    el.addEventListener('change', live);
    lbl.textContent = fmt(parseFloat(el.value));
  }

  function wire() {
    /* seed + topology */
    $('seedInput').addEventListener('change', function () {
      app.spec.seed = $('seedInput').value || 'orpheus';
      app.spec.lineage = [];
      rebuildWorld(true);
    });
    $('seedDice').addEventListener('click', newBrain);
    $('btnEvolve').addEventListener('click', function () {
      /* Take the first mutant straight away — the impatient path through evolution. */
      adopt(1);
    });
    $('selDepth').addEventListener('change', function () {
      app.spec.depth = parseInt(this.value, 10);
      app.spec.lineage = [];
      rebuildWorld(true);
    });
    $('selWidth').addEventListener('change', function () {
      app.spec.width = parseInt(this.value, 10);
      app.spec.lineage = [];
      rebuildWorld(true);
    });

    bindSlider('rngGain', 'vGain', function (v) { return v.toFixed(2); }, function (v) {
      app.spec.gain = v;
      app.spec.lineage = [];
      swapWorld(app.lowres);
    });
    bindSlider('rngScale', 'vScale', function (v) { return String(v | 0); }, function (v) {
      app.spec.scale = v;
      swapWorld(app.lowres);
    });
    bindSlider('rngSea', 'vSea', function (v) { return v.toFixed(2); }, function (v) {
      app.spec.sea = v;
      swapWorld(app.lowres);
    });
    bindSlider('rngAuth', 'vAuth', function (v) { return (v * 100).toFixed(0) + '%'; }, function (v) {
      app.spec.auth = v;
      swapWorld(app.lowres);
    });
    bindSlider('rngRivers', 'vRivers', function (v) { return v.toFixed(2); }, function (v) {
      app.spec.rivers = v;
      swapWorld(app.lowres);
    });
    bindSlider('rngSigma', 'vSigma', function (v) { return v.toFixed(2); }, function () {});

    for (var i = 0; i < 4; i++) {
      (function (k) {
        var el = $('z' + k);
        el.addEventListener('input', function () {
          var z = app.spec.z.slice();
          z[k] = parseFloat(el.value);
          setZ(z, false);
          beginInteraction();
        });
      })(i);
    }

    $('btnRandZ').addEventListener('click', function () {
      var rnd = NW.rand.rng((Math.abs(app.cam.x * 7919 + app.cam.y * 104729) | 0) ^ (app.spec.lineage.length + 17));
      setZ([0, 1, 2, 3].map(function () { return +(rnd() * 2.6 - 1.3).toFixed(2); }), true);
      rebuildWorld(false);
      spawnCandidates();
    });

    $('btnDrift').addEventListener('click', toggleDrift);

    $('btnSpawn').addEventListener('click', spawnCandidates);
    $('btnTour').addEventListener('click', function () {
      $('panel').classList.remove('open');
      tourOpen();
    });
    $('tourClose').addEventListener('click', tourClose);
    $('dosClose').addEventListener('click', closeDossier);
    $('tourCards').addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.tour-card') : null;
      if (card && app.tour && app.tour.phase !== 'rest') tourPick(parseInt(card.dataset.idx, 10));
    });
    $('tourFoot').addEventListener('click', function (e) {
      if (e.target.id === 'tourKeep') tourNextGen();
      if (e.target.id === 'tourAdopt') tourAdopt();
    });
    $('btnBack').addEventListener('click', function () {
      if (!app.spec.lineage.length) return;
      app.spec.lineage.pop();
      rebuildWorld(true);
    });
    $('gallery').addEventListener('click', function (e) {
      if (e.target.dataset && e.target.dataset.idx !== undefined) adopt(parseInt(e.target.dataset.idx, 10));
    });

    $('selView').addEventListener('change', function () {
      app.mode = this.value;
      $('neuronPick').classList.toggle('hidden', app.mode !== 'neuron');
    });
    $('selLayer').addEventListener('change', function () {
      app.probe.layer = parseInt(this.value, 10);
      app.basisKey = '';
      var w = app.world.net.layers[app.probe.layer].outDim;
      var selN = $('selNeuron');
      selN.innerHTML = '';
      for (var j = 0; j < w; j++) {
        var o = document.createElement('option');
        o.value = j;
        o.textContent = '#' + j;
        selN.appendChild(o);
      }
      app.probe.neuron = Math.min(app.probe.neuron, w - 1);
      selN.value = app.probe.neuron;
    });
    $('selNeuron').addEventListener('change', function () {
      app.probe.neuron = parseInt(this.value, 10);
      markBasisSelection();
    });

    $('basis').addEventListener('click', function (e) {
      if (!e.target.dataset || e.target.dataset.neuron === undefined) return;
      app.probe.neuron = parseInt(e.target.dataset.neuron, 10);
      $('selNeuron').value = app.probe.neuron;
      markBasisSelection();
      /* Clicking a tile is a request to look at it, so show it on the map. */
      app.mode = 'neuron';
      $('selView').value = 'neuron';
      $('neuronPick').classList.remove('hidden');
    });

    $('chkDecor').addEventListener('change', function () { app.opts.decor = this.checked; });
    $('chkPlaces').addEventListener('change', function () { app.opts.places = this.checked; });
    $('chkGrid').addEventListener('change', function () { app.opts.grid = this.checked; });
    $('chkSmooth').addEventListener('change', function () { app.opts.smooth = this.checked; });
    $('chkContours').addEventListener('change', function () {
      app.opts.contours = this.checked;
      app.world.chunks.forEach(function (c) { c.rasterMode = null; });
    });

    $('btnRetrain').addEventListener('click', function () {
      startTraining((NW.rand.hashString(String(Date.now())) ^ 0x33) >>> 0, 'Retraining the biome network');
    });

    $('btnLink').addEventListener('click', function () {
      writeHash();
      var url = location.href;
      /* Clipboard and prompt are both blocked in some embeddings; the hash is
       * updated either way, so degrade quietly rather than throwing. */
      function fallback() {
        try { window.prompt('Permalink:', url); } catch (e) { /* sandboxed */ }
        flash();
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(flash, fallback);
        } else {
          fallback();
        }
      } catch (e) {
        fallback();
      }
    });

    $('btnPng').addEventListener('click', function () {
      var a = document.createElement('a');
      a.download = 'neuroworld-' + app.spec.seed + '-' + Math.round(app.cam.x) + '_' + Math.round(app.cam.y) + '.png';
      a.href = map.toDataURL('image/png');
      a.click();
    });

    $('btnPanel').addEventListener('click', function () { $('panel').classList.toggle('open'); });

    /* First-run hint: goes on the first real interaction, or after a while. */
    var hintGone = false;
    function dropHint() {
      if (hintGone) return;
      hintGone = true;
      $('hint').classList.add('gone');
    }
    $('hintClose').addEventListener('click', dropHint);
    map.addEventListener('pointerdown', dropHint);
    map.addEventListener('wheel', dropHint, { passive: true });
    window.addEventListener('keydown', dropHint);
    setTimeout(dropHint, 16000);

    /* Zoom buttons: the only way to zoom on a touch screen, handy on a trackpad. */
    function zoomBy(f) { app.cam.tilePx = clamp(app.cam.tilePx * f, 3, 34); }
    $('zoomIn').addEventListener('click', function () { zoomBy(1.35); });
    $('zoomOut').addEventListener('click', function () { zoomBy(1 / 1.35); });

    /*
     * Mouse and touch, unified through pointer events. One pointer drags; a
     * second turns the gesture into a pinch, anchored so the terrain between
     * the fingers stays between the fingers. A touch tap (no drag) inspects the
     * tile — the tooltip and forward-pass panel have no hover on a phone
     * otherwise. touch-action: none in the CSS keeps the browser's own pan and
     * double-tap zoom from fighting all of this.
     */
    var pts = new Map();
    var dragging = false, lastX = 0, lastY = 0, moved = 0;
    var pinch = null;

    function ptsArr() { return Array.from(pts.values()); }

    function startPinch() {
      var a = ptsArr();
      var r = map.getBoundingClientRect();
      var mx = (a[0].x + a[1].x) / 2 - r.left;
      var my = (a[0].y + a[1].y) / 2 - r.top;
      var vp = viewport();
      return {
        d0: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1,
        t0: app.cam.tilePx,
        wx: vp.left + mx / app.cam.tilePx,
        wy: vp.top + my / app.cam.tilePx
      };
    }

    map.addEventListener('pointerdown', function (e) {
      /* Synthetic pointer ids (tests, some stylus drivers) can be uncapturable. */
      try { map.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        dragging = true;
        moved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
        map.classList.add('dragging');
      } else if (pts.size === 2) {
        dragging = false;
        pinch = startPinch();
      }
    });

    map.addEventListener('pointermove', function (e) {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var r = map.getBoundingClientRect();
      app.hover = { x: e.clientX - r.left, y: e.clientY - r.top };

      if (pinch && pts.size >= 2) {
        var a = ptsArr();
        var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
        app.cam.tilePx = clamp(pinch.t0 * d / pinch.d0, 3, 34);
        /* Re-anchor: the world point that started under the midpoint follows it. */
        var mx = (a[0].x + a[1].x) / 2 - r.left;
        var my = (a[0].y + a[1].y) / 2 - r.top;
        app.cam.x = pinch.wx - mx / app.cam.tilePx + (cssW / app.cam.tilePx) / 2;
        app.cam.y = pinch.wy - my / app.cam.tilePx + (cssH / app.cam.tilePx) / 2;
        moved = 99;
        return;
      }
      if (dragging) {
        var dx = e.clientX - lastX, dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        app.cam.x -= dx / app.cam.tilePx;
        app.cam.y -= dy / app.cam.tilePx;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });

    function endPointer(e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) {
        /* Two fingers down to one: carry on as a drag from where it is. */
        var a = ptsArr()[0];
        dragging = true;
        lastX = a.x;
        lastY = a.y;
        return;
      }
      if (pts.size === 0) {
        if (moved < 8 && e.type === 'pointerup') {
          var r = map.getBoundingClientRect();
          var cx2 = e.clientX - r.left, cy2 = e.clientY - r.top;
          var hit = siteHit(cx2, cy2);
          if (hit) {
            openDossier(hit);
          } else if (app.dossier) {
            closeDossier();
          } else if (e.pointerType !== 'mouse') {
            app.hover = { x: cx2, y: cy2 };
            app.hoverTick = 0;   /* inspect the tapped tile right away */
          }
        }
        dragging = false;
        map.classList.remove('dragging');
      }
    }
    map.addEventListener('pointerup', endPointer);
    map.addEventListener('pointercancel', endPointer);
    map.addEventListener('pointerleave', function (e) {
      /* A finger lifting fires pointerleave too; only a mouse actually left. */
      if (e.pointerType !== 'mouse') return;
      app.hover = null;
      $('tooltip').classList.add('hidden');
    });

    map.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = map.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var vp = viewport();
      var wx = vp.left + mx / app.cam.tilePx;
      var wy = vp.top + my / app.cam.tilePx;
      var f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      app.cam.tilePx = clamp(app.cam.tilePx * f, 3, 34);
      /* Keep the tile under the cursor pinned. */
      var vp2 = { wTiles: cssW / app.cam.tilePx, hTiles: cssH / app.cam.tilePx };
      app.cam.x = wx - (mx / app.cam.tilePx) + vp2.wTiles / 2;
      app.cam.y = wy - (my / app.cam.tilePx) + vp2.hTiles / 2;
    }, { passive: false });

    $('minimap').addEventListener('click', function (e) {
      if (!app.mm) return;
      var r = this.getBoundingClientRect();
      app.cam.x = app.mm.x0 + ((e.clientX - r.left) / r.width) * MM_SPAN;
      app.cam.y = app.mm.y0 + ((e.clientY - r.top) / r.height) * MM_SPAN;
    });

    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      var k = e.key.toLowerCase();
      /* Inside the tournament the keyboard belongs to it: 1/2/3 pick, Esc leaves. */
      if (k === 'escape' && app.dossier) { closeDossier(); return; }
      if (app.tour) {
        if (k === 'escape') tourClose();
        if (k >= '1' && k <= '3' && app.tour.phase !== 'rest') {
          var cardsEls = $('tourCards').children;
          var ci = parseInt(k, 10) - 1;
          if (cardsEls[ci]) tourPick(parseInt(cardsEls[ci].dataset.idx, 10));
        }
        return;
      }
      /* A focused button fires its own click on space; do not toggle twice. */
      if (k === ' ' && e.target.tagName === 'BUTTON') return;
      if (k === 'w' || k === 'arrowup') app.keys.w = true;
      if (k === 's' || k === 'arrowdown') app.keys.s = true;
      if (k === 'a' || k === 'arrowleft') app.keys.a = true;
      if (k === 'd' || k === 'arrowright') app.keys.d = true;
      if (k === 'r') newBrain();
      if (k === 'n') adopt(1);
      if (k === 'g') { $('chkGrid').checked = !$('chkGrid').checked; app.opts.grid = $('chkGrid').checked; }
      if (k === 'm') {
        var i = (VIEWS.indexOf(app.mode) + 1) % VIEWS.length;
        app.mode = VIEWS[i];
        $('selView').value = app.mode;
        $('neuronPick').classList.toggle('hidden', app.mode !== 'neuron');
      }
      if (k === ' ') { e.preventDefault(); toggleDrift(); }
      if (k === '+' || k === '=') app.cam.tilePx = clamp(app.cam.tilePx * 1.2, 3, 34);
      if (k === '-') app.cam.tilePx = clamp(app.cam.tilePx / 1.2, 3, 34);
    });
    window.addEventListener('keyup', function (e) {
      var k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') app.keys.w = false;
      if (k === 's' || k === 'arrowdown') app.keys.s = false;
      if (k === 'a' || k === 'arrowleft') app.keys.a = false;
      if (k === 'd' || k === 'arrowright') app.keys.d = false;
    });
  }

  function flash() {
    var b = $('btnLink');
    b.classList.add('on');
    setTimeout(function () { b.classList.remove('on'); }, 700);
  }

  function toggleDrift() {
    app.drift = !app.drift;
    app.lowres = app.drift;
    $('btnDrift').classList.toggle('on', app.drift);
    if (!app.drift) {
      rebuildWorld(false);
      spawnCandidates();
    }
  }

  function newBrain() {
    var words = ['orpheus', 'kalyx', 'vesper', 'tundra', 'ossian', 'mirren', 'halcyon',
      'cinder', 'quillon', 'sable', 'lumen', 'thalos', 'nyx', 'perigee', 'brackish'];
    var rnd = NW.rand.rng((performance.now() * 1000) | 0);
    var seed = words[(rnd() * words.length) | 0] + '-' + ((rnd() * 46656) | 0).toString(36);
    $('seedInput').value = seed;
    app.spec.seed = seed;
    app.spec.lineage = [];
    rebuildWorld(true);
  }

  /*
   * The contact sheet: every neuron of the probed layer over the same patch of
   * map. This is the closest the app gets to showing what the network *is* —
   * the terrain is a weighted sum of these pictures, and mutating a weight
   * changes how much of one of them ends up in the ground under your cursor.
   *
   * One forward pass produces all of them, so the whole sheet costs about what a
   * single chunk does. The activation buffer it returns belongs to the network
   * and is reused by the next forward pass, so it is drained here and now.
   */
  var BASIS_PX = 40;

  function buildBasisSheet() {
    var layer = app.probe.layer;
    var net = app.world.net;
    var step = Math.max(1, Math.round(app.spec.scale * 1.6 / BASIS_PX));
    var g = app.world.probeLayerGrid(
      Math.round(app.cam.x - BASIS_PX * step / 2),
      Math.round(app.cam.y - BASIS_PX * step / 2),
      BASIS_PX, step, layer);

    var host = $('basis');
    host.innerHTML = '';
    var ramp = NW.render.RAMPS.neuron;
    var tmp = [0, 0, 0];
    for (var j = 0; j < g.oD; j++) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = BASIS_PX;
      var ctx = cv.getContext('2d');
      var img = ctx.createImageData(BASIS_PX, BASIS_PX);
      for (var i = 0; i < BASIS_PX * BASIS_PX; i++) {
        ramp(g.act[i * g.oD + j] * 0.5 + 0.5, tmp);
        img.data[i * 4] = tmp[0];
        img.data[i * 4 + 1] = tmp[1];
        img.data[i * 4 + 2] = tmp[2];
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      cv.dataset.neuron = j;
      cv.title = '#' + j + '   ' + net.actName(layer, j);
      if (j === app.probe.neuron) cv.className = 'sel';
      host.appendChild(cv);
    }
    $('basisLayer').textContent = 'h' + (layer + 1);
    app.basisKey = basisKey();
  }

  function basisKey() {
    return app.world.key + '|' + app.probe.layer + '|' +
      Math.round(app.cam.x / 200) + ',' + Math.round(app.cam.y / 200);
  }

  function markBasisSelection() {
    var kids = $('basis').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].className = (+kids[i].dataset.neuron === app.probe.neuron) ? 'sel' : '';
    }
  }

  /* ------------------------------------------------------- civilisation --- */

  /*
   * The civ layer fills in like everything else: budgeted, idle-frame work.
   * Priority is what the user can see — site probes for on-screen cells first,
   * then each known town's allegiance, trade partners and roads, one costly
   * item per frame so the map never hitches while the atlas thickens.
   */
  function civPump() {
    if (!app.world || app.mode !== 'biome' || !app.opts.places) return;
    var civ = NW.civ.civOf(app.world);
    var end = performance.now() + 6;

    /* 1. resolve site probes the renderer reported missing */
    while (app.civMisses.length && performance.now() < end) {
      var cell = app.civMisses.pop();
      NW.civ.siteAt(app.world, cell[0], cell[1]);
    }
    if (performance.now() >= end) return;

    /* 2. one heavier item: a town's nation, or one road to a trade partner */
    if (!app.civQueued || app.civQueued.world !== app.world) {
      app.civQueued = { world: app.world, done: new Set(), roads: [] };
    }
    var q = app.civQueued;
    if (q.roads.length) {
      var job = q.roads.shift();
      NW.civ.roadBetween(app.world, job[0], job[1]);
      return;
    }
    /* Nearest unprocessed town to the camera gets its allegiance and roads. */
    var found = null, fd = Infinity;
    civ.sites.forEach(function (site) {
      if (!site || q.done.has(site.key)) return;
      var d = Math.abs(site.wx - app.cam.x) + Math.abs(site.wy - app.cam.y);
      if (d < fd && d < 1400) { fd = d; found = site; }
    });
    if (found) {
      /* A town's allegiance needs its 3x3 provinces surveyed; a cold province
       * is ~24 probes, and nine at once was a 200ms frame. One per frame. */
      var pvx = Math.floor(found.gx / NW.civ.PROV), pvy = Math.floor(found.gy / NW.civ.PROV);
      for (var py = -1; py <= 1; py++) {
        for (var px = -1; px <= 1; px++) {
          if (!civ.provs.has((pvx + px) + ',' + (pvy + py))) {
            NW.civ.provCapital(app.world, pvx + px, pvy + py);
            return;
          }
        }
      }
      q.done.add(found.key);
      NW.civ.nationOf(app.world, found);
      var partners = NW.civ.nearestSites(app.world, found, 2, 5);
      for (var i = 0; i < partners.length; i++) q.roads.push([found, partners[i]]);
    }
  }

  /* ----------------------------------------------------------- dossier --- */

  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function openDossier(site) {
    app.dossier = { site: site, done: false };
    $('dossier').classList.remove('hidden');
    $('dosName').textContent = site.name;
    $('dosBody').innerHTML =
      '<div class="dos-sub">' + esc(site.culture.folk) + ' ' +
      (site.kind === 'coast' ? 'harbour' : site.kind === 'river' ? 'ford-town'
        : site.kind === 'high' ? 'hold' : site.kind === 'wood' ? 'forest town'
        : site.kind === 'dry' ? 'well-town' : 'market town') +
      ' · consulting the atlas&hellip;</div>';
  }

  function closeDossier() {
    app.dossier = null;
    $('dossier').classList.add('hidden');
  }

  /*
   * The first click on a region pays for its provinces (a few dozen probes).
   * That work is sliced across frames here; the dossier renders when done.
   */
  function pumpDossier() {
    var d = app.dossier;
    if (!d || d.done) return;
    var end = performance.now() + 13;
    var pvx = Math.floor(d.site.gx / NW.civ.PROV), pvy = Math.floor(d.site.gy / NW.civ.PROV);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        NW.civ.provCapital(app.world, pvx + dx, pvy + dy);
        if (performance.now() > end) return;   /* resume next frame */
      }
    }
    var doc = NW.civ.dossier(app.world, d.site);
    d.done = true;
    renderDossier(doc);
    /* roads to this town's partners are now the most interesting thing to build */
    if (app.civQueued && app.civQueued.world === app.world) {
      for (var i = 0; i < doc.trade.partners.length; i++) {
        app.civQueued.roads.unshift([d.site, doc.trade.partners[i].site]);
      }
    }
  }

  function renderDossier(d) {
    var s = d.site, f = d.faith;
    var kindWord = s.kind === 'coast' ? 'harbour' : s.kind === 'river' ? 'ford-town'
      : s.kind === 'high' ? 'hold' : s.kind === 'wood' ? 'forest town'
      : s.kind === 'dry' ? 'well-town' : 'market town';
    var html = '';

    html += '<div class="dos-sub">' + esc(s.culture.folk) + ' ' + kindWord +
      ' · pop. ~' + d.population + ' · founded Y.' + d.founded +
      ' · now Y.' + d.year + ', ' + esc(d.era) + '</div>';

    html += '<h4><i style="background:' + d.nation.color + '"></i>' + esc(d.nation.name) + '</h4>';
    html += '<p>' + (d.nation.capital.key === s.key
      ? 'Capital of the realm.'
      : 'Sworn to the capital at <b>' + esc(d.nation.capital.name) + '</b>.') +
      ' Founded Y.' + d.nation.founded + '.</p>';

    html += '<h4>Culture &amp; tongue</h4>';
    html += '<p>' + esc(s.culture.folk) + ', speakers of ' + esc(s.culture.tongue) +
      ' in the <b>' + esc(s.culture.dialect.name) + '</b>; known for ' +
      esc(s.culture.craft) + '. They build in ' + esc(s.culture.architecture) +
      ', and their table is ' + esc(s.culture.table) + '.</p>';
    html += '<p>They hold to ' + esc(s.culture.values.slice(0, 2).join(', ')) +
      ', and — as their country teaches — ' + esc(s.culture.values[2]) + '.</p>';

    html += '<h4>Faith</h4>';
    html += '<p>' + esc(f.deity) + ' — ' + esc(f.creed) + '. Rites: ' + esc(f.rites) +
      '. Taboo: ' + esc(f.taboo) + '.' +
      (d.localShrine ? ' This town ' + esc(d.localShrine) + '.' : '') + '</p>';

    html += '<h4>Clans</h4><ul>';
    for (var c = 0; c < d.clans.length; c++) {
      var cl = d.clans[c];
      html += '<li><b>clan ' + esc(cl.name) + '</b> — totem ' + esc(cl.totem) +
        ', holds ' + esc(cl.seat) + ', trades in ' + esc(cl.trade) + '</li>';
    }
    html += '</ul>';

    html += '<h4>People of note</h4><ul>';
    for (var pi = 0; pi < d.people.length; pi++) {
      var pe = d.people[pi];
      html += '<li><b>' + esc(pe.name) + '</b> of clan ' + esc(pe.clan) +
        ', ' + esc(pe.role) + ' (b. Y.' + pe.born + ')' +
        (pe.line ? ' — ' + esc(pe.line) : '') + '</li>';
    }
    html += '</ul>';

    if (d.artifacts.length) {
      html += '<h4>Treasures</h4><ul>';
      for (var ai = 0; ai < d.artifacts.length; ai++) {
        var art = d.artifacts[ai];
        html += '<li><b>' + esc(art.name) + '</b> — ' + esc(art.material) +
          ', made Y.' + art.made + ' by ' + esc(art.maker) + '; ' + esc(art.purpose) + '</li>';
      }
      html += '</ul>';
    }

    html += '<h4>Trade</h4>';
    html += '<p>Sends out ' + esc(d.trade.exports.join(', ')) +
      (d.trade.imports.length ? '; buys in ' + esc(d.trade.imports.join(', ')) : '') + '.</p>';
    if (d.trade.partners.length) {
      html += '<ul>';
      for (var ti = 0; ti < d.trade.partners.length; ti++) {
        var tp2 = d.trade.partners[ti];
        var dist = Math.round(Math.hypot(tp2.site.wx - s.wx, tp2.site.wy - s.wy));
        html += '<li><b>' + esc(tp2.site.name) + '</b> (' + dist + ' tiles away) sends ' +
          esc(tp2.sends) + ', takes ' + esc(tp2.takes) + '</li>';
      }
      html += '</ul>';
    }

    html += '<h4>Chronicle of ' + esc(d.nation.shortName) + '</h4><ul class="dos-chron">';
    for (var hi = 0; hi < d.history.length; hi++) {
      html += '<li><b>Y.' + d.history[hi].y + '</b> ' + esc(d.history[hi].t) + '</li>';
    }
    html += '</ul>';

    $('dosBody').innerHTML = html;
  }

  /* Hit-test the cached, visible settlements around a screen point. */
  function siteHit(px, py) {
    if (!app.world || !app.world.civ) return null;
    var vp = viewport();
    var tp = app.cam.tilePx;
    var g0x = Math.floor(vp.left / NW.civ.CELL) - 1, g1x = Math.floor(vp.right / NW.civ.CELL) + 1;
    var g0y = Math.floor(vp.top / NW.civ.CELL) - 1, g1y = Math.floor(vp.bottom / NW.civ.CELL) + 1;
    var best = null, bd = 18 * 18;
    for (var gy = g0y; gy <= g1y; gy++) {
      for (var gx = g0x; gx <= g1x; gx++) {
        var site = app.world.civ.sites.get(gx + ',' + gy);
        if (!site) continue;
        var sx = (site.wx + 0.5 - vp.left) * tp, sy2 = (site.wy + 0.5 - vp.top) * tp;
        var d2 = (sx - px) * (sx - px) + (sy2 - py) * (sy2 - py);
        if (d2 < bd) { bd = d2; best = site; }
      }
    }
    return best;
  }

  /* --------------------------------------------------------- tournament --- */

  /*
   * The controller owns only presentation state; every genetic operation lives
   * in evo.js so that the replay in world.js is, by construction, the same code
   * path the user clicked through. The overlay records picks; picks ARE the
   * genome of the champion.
   */
  /*
   * No supersampling here, unlike the other stills: a duel card is ~300 CSS px,
   * so 144 native pixels point-sampled (octaves already Nyquist-dropped) then
   * box-blurred looks as good as 132 supersampled — at 40% of the cost, which
   * is the difference between cards that fill in a second and cards you wait on.
   */
  var TOUR_PX = 144, TOUR_SS = 1;

  function tourOpen() {
    var seed = (NW.rand.rng((performance.now() * 1000) | 0)() * 4294967295) >>> 0;
    var t = {
      seed: seed,
      picks: [],
      gen: 0,
      duel: 0,
      phase: 'duel',
      winners: [],        /* winner population indices for the current gen */
      champIdx: -1,
      startSpec: NW.world.cloneSpec(app.spec),
      pop: NW.evo.initial(app.world.net, seed),
      thumbs: [],
      jobs: []
    };
    app.tour = t;
    tourSpawnThumbs();
    tourRender();
    $('tour').classList.remove('hidden');
  }

  function tourClose() {
    app.tour = null;
    $('tour').classList.add('hidden');
  }

  /* One thumbnail world+canvas per individual; rendered in bands like the rest. */
  function tourSpawnThumbs() {
    var t = app.tour;
    var span = t.startSpec.scale * 2.4;
    t.thumbs = [];
    t.jobs = [];
    for (var i = 0; i < t.pop.length; i++) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = TOUR_PX;
      t.thumbs.push(cv);
      t.jobs.push({
        world: new NW.world.World(t.startSpec, app.trainer.net, null, 768, t.pop[i]),
        canvas: cv,
        x0: Math.round(app.cam.x - span / 2),
        y0: Math.round(app.cam.y - span / 2),
        sub: span / (TOUR_PX * TOUR_SS),
        row: 0
      });
    }
  }

  /* Which individuals are on screen right now — those thumbnails render first. */
  function tourVisible() {
    var t = app.tour;
    if (t.phase === 'duel') return NW.evo.PAIRS[t.duel].slice();
    if (t.phase === 'final') return t.winners.slice();
    return [t.winners[t.champIdx]];
  }

  function tourPump() {
    var t = app.tour;
    if (!t) return;
    /* The map is not rendering while the overlay is up, so its whole frame
     * budget goes to the thumbnails. */
    var end = performance.now() + 24;
    var vis = tourVisible();
    var order = vis.slice();
    for (var i = 0; i < t.jobs.length; i++) if (order.indexOf(i) < 0) order.push(i);
    while (performance.now() < end) {
      /* Among what is on screen, feed the least-finished thumbnail, so both
       * duel cards fill together instead of one completing while the other is
       * still blank; off-screen ones queue behind. */
      var job = null;
      for (var o = 0; o < order.length; o++) {
        var j = t.jobs[order[o]];
        if (!j || j.row >= TOUR_PX * TOUR_SS) continue;
        if (o < vis.length) {
          if (!job || j.row < job.row) job = j;
        } else {
          if (!job) job = j;
          break;
        }
      }
      if (!job) return;
      var n = TOUR_PX * TOUR_SS;
      var rows = clamp(Math.round(samplesFor(11, 400, 20000) / n), TOUR_SS, n);
      rows -= rows % TOUR_SS;
      rows = Math.min(Math.max(rows, TOUR_SS), n - job.row);
      var region = job.world.buildRegion(job.x0, job.y0 + job.row * job.sub, n, rows, job.sub);
      var band = NW.render.regionToCanvas(region, TOUR_SS, null);
      job.canvas.getContext('2d').drawImage(band, 0, job.row / TOUR_SS);
      job.row += rows;
      if (job.row >= n) NW.render.blurCanvas(job.canvas);
    }
  }

  function tourCard(popIdx, label, extraClass) {
    var t = app.tour;
    var card = document.createElement('div');
    card.className = 'tour-card' + (extraClass ? ' ' + extraClass : '');
    card.dataset.idx = popIdx;
    card.appendChild(t.thumbs[popIdx]);
    var lab = document.createElement('div');
    lab.className = 'lab';
    lab.textContent = label;
    card.appendChild(lab);
    return card;
  }

  function tourRender() {
    var t = app.tour;
    var cards = $('tourCards');
    var foot = $('tourFoot');
    cards.innerHTML = '';
    foot.innerHTML = '';
    $('tourInfo').textContent = 'generation ' + (t.gen + 1) +
      ' · σ ' + NW.evo.sigmaFor(t.gen).toFixed(2);

    if (t.phase === 'duel') {
      $('tourPrompt').innerHTML = 'Duel ' + (t.duel + 1) + ' of 3 — <b>tap the world you prefer</b>';
      var pair = NW.evo.PAIRS[t.duel];
      cards.appendChild(tourCard(pair[0], t.gen === 0 && pair[0] === 0 ? 'current world' : 'contender 1'));
      cards.appendChild(tourCard(pair[1], 'contender 2'));
    } else if (t.phase === 'final') {
      $('tourPrompt').innerHTML = 'Final — <b>crown this generation\u2019s champion</b>';
      for (var i = 0; i < 3; i++) cards.appendChild(tourCard(t.winners[i], 'winner ' + (i + 1)));
    } else {
      $('tourPrompt').innerHTML = 'Champion of generation ' + (t.gen + 1) +
        ' — breed from it, or adopt it as the world';
      cards.appendChild(tourCard(t.winners[t.champIdx], 'champion', 'champ'));
      var note = document.createElement('div');
      note.className = 'tour-foot-note';
      note.textContent = 'next generation: champion kept + 3 crossbreeds of the winners + 2 mutants';
      foot.appendChild(note);
      var keep = document.createElement('button');
      keep.className = 'btn';
      keep.id = 'tourKeep';
      keep.textContent = '\u21bb breed the next generation';
      foot.appendChild(keep);
      var adopt = document.createElement('button');
      adopt.className = 'btn on';
      adopt.id = 'tourAdopt';
      adopt.textContent = '\u2713 adopt this champion';
      foot.appendChild(adopt);
    }
  }

  function tourPick(popIdx) {
    var t = app.tour;
    if (t.phase === 'duel') {
      var pair = NW.evo.PAIRS[t.duel];
      var side = popIdx === pair[1] ? 1 : 0;
      t.picks.push(side);
      t.winners.push(pair[side]);
      t.duel++;
      t.phase = t.duel >= 3 ? 'final' : 'duel';
    } else if (t.phase === 'final') {
      var f = Math.max(0, t.winners.indexOf(popIdx));
      t.picks.push(f);
      t.champIdx = f;
      t.phase = 'rest';
    }
    tourRender();
  }

  function tourNextGen() {
    var t = app.tour;
    var w = [t.pop[t.winners[0]], t.pop[t.winners[1]], t.pop[t.winners[2]]];
    t.pop = NW.evo.breed(w, t.champIdx, t.seed, t.gen);
    t.gen++;
    t.duel = 0;
    t.winners = [];
    t.champIdx = -1;
    t.phase = 'duel';
    tourSpawnThumbs();
    tourRender();
  }

  function tourAdopt() {
    var t = app.tour;
    app.spec = NW.world.cloneSpec(t.startSpec);
    app.spec.lineage.push({ t: t.seed, p: t.picks.slice() });
    tourClose();
    rebuildWorld(true);
  }

  function buildLegend() {
    var html = '';
    for (var i = 0; i < NW.biome.BIOMES.length; i++) {
      var bm = NW.biome.BIOMES[i];
      html += '<div><i style="background:rgb(' + bm.rgb.join(',') + ')"></i>' +
        '<span>' + bm.name + '</span></div>';
    }
    $('legend').innerHTML = html;
  }

  /* ---------------------------------------------------------------- init --- */

  function init() {
    var fromHash = location.hash.length > 2 ? NW.ui.decodeSpec(location.hash.slice(1)) : null;
    app.spec = fromHash || NW.world.defaultSpec($('seedInput').value || 'orpheus');
    $('seedInput').value = app.spec.seed;
    $('selDepth').value = String(app.spec.depth);
    $('selWidth').value = String(app.spec.width);
    $('rngGain').value = app.spec.gain;
    $('rngScale').value = app.spec.scale;
    $('rngSea').value = app.spec.sea;
    $('rngAuth').value = app.spec.auth;
    $('rngRivers').value = app.spec.rivers;
    for (var i = 0; i < 4; i++) {
      $('z' + i).value = app.spec.z[i];
      $('vz' + i).textContent = app.spec.z[i].toFixed(2);
    }
    wire();
    watchStage();
    buildLegend();
    NW.ui.drawNet($('netCanvas'), null, null);
    startTraining(1337, 'Training the biome network');
    requestAnimationFrame(frame);
  }

  /* Exposed for the console: NW.app.spec, NW.app.world, NW.app.trainer. */
  NW.app = app;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.NW = window.NW || {});
