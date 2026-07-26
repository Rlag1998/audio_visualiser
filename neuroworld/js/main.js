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
    opts: { decor: true, contours: false, grid: false, smooth: false },
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
    minimap: null,
    keys: {},
    fps: 0,
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

  function rebuildWorld(alsoCandidates) {
    app.world = new NW.world.World(app.spec, app.trainer.net);
    app.queue.length = 0;
    app.minimap = null;
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
    NW.ui.facts($('netFacts'), [
      ['topology', sizes.join(' → ')],
      ['weights', net.weightCount()],
      ['activations', mix],
      ['mutation steps', app.spec.lineage.length],
      ['chunk cost', app.world.genMs.toFixed(1) + ' ms / ' + (CHUNK * CHUNK) + ' tiles']
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

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    var r = map.parentNode.getBoundingClientRect();
    cssW = Math.max(1, Math.floor(r.width));
    cssH = Math.max(1, Math.floor(r.height));
    if (map.width !== Math.round(cssW * dpr) || map.height !== Math.round(cssH * dpr)) {
      map.width = Math.round(cssW * dpr);
      map.height = Math.round(cssH * dpr);
    }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
   * The result is cached with a margin around the viewport, so an idle zoomed-out
   * map costs nothing per frame and small pans reuse it. While something is
   * animating we drop the supersampling and shrink the budget instead: motion
   * hides the aliasing that a still image would show.
   */
  var previewCanvas = document.createElement('canvas');
  var PREVIEW_PAD = 0.16;

  function previewPlan(vp) {
    var tilesW = vp.wTiles * (1 + 2 * PREVIEW_PAD);
    var tilesH = vp.hTiles * (1 + 2 * PREVIEW_PAD);
    var step = Math.max(1, Math.round(Math.sqrt(tilesW * tilesH / 6000)));
    var ss = step >= 4 ? 2 : 1;
    var sub = step / ss;
    var w = Math.ceil(tilesW / step) + 1;
    var h = Math.ceil(tilesH / step) + 1;
    return {
      step: step, sub: sub, ss: ss, w: w, h: h,
      x0: Math.floor((vp.left - vp.wTiles * PREVIEW_PAD) / step) * step,
      y0: Math.floor((vp.top - vp.hTiles * PREVIEW_PAD) / step) * step
    };
  }

  function drawPreview(vp) {
    var plan = previewPlan(vp);
    var p = app.preview;
    var stale = !p || p.key !== app.world.key || p.step !== plan.step || p.ss !== plan.ss ||
      vp.left < p.x0 || vp.top < p.y0 ||
      vp.right > p.x0 + p.w * p.step || vp.bottom > p.y0 + p.h * p.step;

    if (stale) {
      var region = app.world.buildRegion(plan.x0, plan.y0, plan.w * plan.ss, plan.h * plan.ss, plan.sub);
      NW.render.regionToCanvas(region, plan.ss, previewCanvas);
      app.preview = p = {
        key: app.world.key, step: plan.step, ss: plan.ss,
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
    }

    /* Count what is still missing on screen — the prefetch ring does not count. */
    var missing = 0;
    for (var my = c0y; my <= c1y; my++) {
      for (var mx = c0x; mx <= c1x; mx++) if (!app.world.getChunk(mx, my)) missing++;
    }
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
    if (range.missing && app.mode === 'biome') drawPreview(vp);

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
          ch.probe = app.world.probeNeuron(cx, cy, app.probe.layer, app.probe.neuron);
          ch.probeTag = probeTag;
          ch.rasterMode = null;
        }
        var raster = NW.render.rasterize(ch, app.mode, {
          contours: app.opts.contours,
          probeTag: probeTag
        });
        mctx.drawImage(raster, 0, 0, CHUNK, CHUNK, x, y, w, h);
      }
    }

    if (app.opts.decor && app.mode === 'biome') {
      var bounds = { left: 0, top: 0, right: cssW, bottom: cssH };
      for (var dy2 = range.c0y; dy2 <= range.c1y; dy2++) {
        for (var dx2 = range.c0x; dx2 <= range.c1x; dx2++) {
          var c2 = app.world.getChunk(dx2, dy2);
          if (c2) {
            NW.render.drawDecor(mctx, app.world, c2,
              (dx2 * CHUNK - vp.left) * tp, (dy2 * CHUNK - vp.top) * tp, tp, bounds);
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

  var MM_SAMPLES = 176, MM_STEP = 4;

  function updateMinimap(vp) {
    var span = MM_SAMPLES * MM_STEP;
    var need = !app.minimap ||
      Math.abs(app.cam.x - (app.minimap.x0 + span / 2)) > span * 0.22 ||
      Math.abs(app.cam.y - (app.minimap.y0 + span / 2)) > span * 0.22;
    if (need && !app.lowres) {
      var x0 = Math.round(app.cam.x - span / 2);
      var y0 = Math.round(app.cam.y - span / 2);
      app.minimap = app.world.buildRegion(x0, y0, MM_SAMPLES, MM_SAMPLES, MM_STEP);
    }
    NW.ui.drawMinimap($('minimap'), app.minimap, app.cam, vp);
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
   * One candidate thumbnail per frame. They are centred on the camera and cover a
   * couple of feature periods, supersampled 2x — a thumbnail you cannot tell apart
   * from its siblings is useless for choosing a parent.
   */
  var CAND_PX = 88, CAND_SS = 2;

  function pumpCandidates() {
    if (!app.candQueue.length) return;
    var idx = app.candQueue.shift();
    var cand = app.candidates[idx];
    var w = new NW.world.World(cand.spec, app.trainer.net);
    var span = cand.spec.scale * 2.4;
    var sub = span / (CAND_PX * CAND_SS);
    var region = w.buildRegion(
      Math.round(app.cam.x - span / 2), Math.round(app.cam.y - span / 2),
      CAND_PX * CAND_SS, CAND_PX * CAND_SS, sub);
    NW.render.regionToCanvas(region, CAND_SS, cand.canvas);
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
    resize();

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
      ]);
    }

    /*
     * While a dial or the latent vector is moving, every cached chunk is already
     * invalid, so there is nothing to stream — draw the coarse region only.
     */
    var vp = viewport();
    mctx.clearRect(0, 0, cssW, cssH);
    if (app.lowres) {
      app.queue.length = 0;
      drawPreview(vp);
    } else {
      drawWorld(vp);
    }

    updateMinimap(vp);
    if (!app.lowres) pumpCandidates();

    if (app.hover && !app.lowres && now - app.hoverTick > 55) {
      app.hoverTick = now;
      updateInspector();
    }

    if (now - app.statTick > 120) {
      app.statTick = now;
      $('stats').textContent =
        'fps ' + app.fps.toFixed(0) + '   chunks ' + app.world.chunks.size +
        '   gen ' + app.world.genMs.toFixed(1) + 'ms\n' +
        'zoom ' + app.cam.tilePx.toFixed(1) + 'px   weights ' + app.world.net.weightCount() +
        '   queue ' + app.queue.length;
      $('hudCoords').textContent =
        'x ' + Math.round(app.cam.x) + '  y ' + Math.round(app.cam.y) +
        '   ' + (MM_SAMPLES * MM_STEP) + ' tiles across';
      /* The measured chunk cost only exists after some chunks have been built. */
      if (app.world.genCount && now - app.factTick > 900) {
        app.factTick = now;
        refreshNetFacts();
      }
    }
  }

  /* --------------------------------------------------------------- input --- */

  function setZ(z) {
    app.spec.z = z;
    for (var i = 0; i < 4; i++) {
      $('z' + i).value = z[i];
      $('vz' + i).textContent = z[i].toFixed(2);
    }
    /* Reuse the normalisation while animating; it is re-measured when z settles. */
    app.world = new NW.world.World(app.spec, app.trainer.net,
      app.drift && app.world ? app.world.lut : null);
    app.minimap = null;
  }

  /*
   * Sliders apply live against a coarse preview while dragging, then commit to
   * full-resolution chunks on release. Terrain dials invalidate every cached
   * chunk, so doing it the other way round would drop the framerate to a crawl.
   */
  function bindSlider(id, label, fmt, apply) {
    var el = $(id);
    var lbl = $(label);
    function commit() {
      var v = parseFloat(el.value);
      lbl.textContent = fmt(v);
      apply(v);
    }
    el.addEventListener('input', function () {
      app.lowres = true;
      commit();
    });
    el.addEventListener('change', function () {
      app.lowres = false;
      commit();
      rebuildWorld(false);
      spawnCandidates();
    });
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
      app.world = new NW.world.World(app.spec, app.trainer.net);
      app.minimap = null;
    });
    bindSlider('rngScale', 'vScale', function (v) { return String(v | 0); }, function (v) {
      app.spec.scale = v;
      app.world = new NW.world.World(app.spec, app.trainer.net);
      app.minimap = null;
    });
    bindSlider('rngSea', 'vSea', function (v) { return v.toFixed(2); }, function (v) {
      app.spec.sea = v;
      app.world = new NW.world.World(app.spec, app.trainer.net);
      app.minimap = null;
    });
    bindSlider('rngAuth', 'vAuth', function (v) { return (v * 100).toFixed(0) + '%'; }, function (v) {
      app.spec.auth = v;
      app.world = new NW.world.World(app.spec, app.trainer.net);
      app.minimap = null;
    });
    bindSlider('rngRivers', 'vRivers', function (v) { return v.toFixed(2); }, function (v) {
      app.spec.rivers = v;
      app.world = new NW.world.World(app.spec, app.trainer.net);
      app.minimap = null;
    });
    bindSlider('rngSigma', 'vSigma', function (v) { return v.toFixed(2); }, function () {});

    for (var i = 0; i < 4; i++) {
      (function (k) {
        var el = $('z' + k);
        el.addEventListener('input', function () {
          app.lowres = true;
          var z = app.spec.z.slice();
          z[k] = parseFloat(el.value);
          setZ(z);
        });
        el.addEventListener('change', function () {
          app.lowres = false;
          rebuildWorld(false);
          spawnCandidates();
        });
      })(i);
    }

    $('btnRandZ').addEventListener('click', function () {
      var rnd = NW.rand.rng((Math.abs(app.cam.x * 7919 + app.cam.y * 104729) | 0) ^ (app.spec.lineage.length + 17));
      setZ([0, 1, 2, 3].map(function () { return +(rnd() * 2.6 - 1.3).toFixed(2); }));
      rebuildWorld(false);
      spawnCandidates();
    });

    $('btnDrift').addEventListener('click', toggleDrift);

    $('btnSpawn').addEventListener('click', spawnCandidates);
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
    });

    $('chkDecor').addEventListener('change', function () { app.opts.decor = this.checked; });
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
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(flash, function () { window.prompt('Permalink:', url); });
      } else {
        window.prompt('Permalink:', url);
      }
    });

    $('btnPng').addEventListener('click', function () {
      var a = document.createElement('a');
      a.download = 'neuroworld-' + app.spec.seed + '-' + Math.round(app.cam.x) + '_' + Math.round(app.cam.y) + '.png';
      a.href = map.toDataURL('image/png');
      a.click();
    });

    $('btnPanel').addEventListener('click', function () { $('panel').classList.toggle('open'); });

    /* Zoom buttons: the only way to zoom on a touch screen, handy on a trackpad. */
    function zoomBy(f) { app.cam.tilePx = clamp(app.cam.tilePx * f, 3, 34); }
    $('zoomIn').addEventListener('click', function () { zoomBy(1.35); });
    $('zoomOut').addEventListener('click', function () { zoomBy(1 / 1.35); });

    /* mouse / touch */
    var dragging = false, lastX = 0, lastY = 0, moved = 0;
    map.addEventListener('pointerdown', function (e) {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      map.classList.add('dragging');
      map.setPointerCapture(e.pointerId);
    });
    map.addEventListener('pointermove', function (e) {
      var r = map.getBoundingClientRect();
      app.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (dragging) {
        var dx = e.clientX - lastX, dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        app.cam.x -= dx / app.cam.tilePx;
        app.cam.y -= dy / app.cam.tilePx;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });
    function endDrag() {
      dragging = false;
      map.classList.remove('dragging');
    }
    map.addEventListener('pointerup', endDrag);
    map.addEventListener('pointercancel', endDrag);
    map.addEventListener('pointerleave', function () {
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
      if (!app.minimap) return;
      var r = this.getBoundingClientRect();
      var span = MM_SAMPLES * MM_STEP;
      app.cam.x = app.minimap.x0 + ((e.clientX - r.left) / r.width) * span;
      app.cam.y = app.minimap.y0 + ((e.clientY - r.top) / r.height) * span;
    });

    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      var k = e.key.toLowerCase();
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
    NW.ui.drawNet($('netCanvas'), null, null);
    startTraining(1337, 'Training the biome network');
    requestAnimationFrame(frame);
  }

  /* Exposed for the console: NW.app.spec, NW.app.world, NW.app.trainer. */
  NW.app = app;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.NW = window.NW || {});
