/*
 * render.js — fields to pixels.
 *
 * Each chunk is rasterised once into a small offscreen canvas (one pixel per
 * tile) and then blitted with nearest-neighbour scaling, so zooming costs
 * nothing and tiles stay crisp. Decorations — trees, rocks, cacti — are drawn
 * in a second pass in world space, only when tiles are big enough to see them.
 */
(function (NW) {
  'use strict';

  var CHUNK = NW.world.CHUNK;
  var clamp = NW.world.clamp;

  function ramp(stops) {
    return function (t, out) {
      t = clamp(t, 0, 1);
      var i = 0;
      while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      var a = stops[i], b = stops[i + 1];
      var u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      u = clamp(u, 0, 1);
      out[0] = a[1][0] + u * (b[1][0] - a[1][0]);
      out[1] = a[1][1] + u * (b[1][1] - a[1][1]);
      out[2] = a[1][2] + u * (b[1][2] - a[1][2]);
      return out;
    };
  }

  var RAMPS = {
    elev: ramp([
      [0.00, [8, 24, 52]], [0.34, [26, 86, 140]], [0.50, [216, 206, 158]],
      [0.62, [104, 152, 78]], [0.76, [150, 134, 92]], [0.88, [124, 116, 110]],
      [1.00, [250, 252, 255]]
    ]),
    moist: ramp([
      [0.0, [122, 92, 48]], [0.35, [200, 186, 130]], [0.6, [96, 168, 150]],
      [1.0, [22, 62, 148]]
    ]),
    temp: ramp([
      [0.0, [58, 92, 176]], [0.3, [110, 178, 200]], [0.55, [226, 216, 150]],
      [0.78, [222, 132, 62]], [1.0, [154, 32, 32]]
    ]),
    slope: ramp([
      [0.0, [24, 30, 36]], [0.5, [180, 148, 96]], [1.0, [255, 236, 214]]
    ]),
    scalar: ramp([
      [0.0, [16, 22, 34]], [0.4, [58, 96, 120]], [0.7, [140, 200, 150]],
      [1.0, [244, 250, 220]]
    ]),
    neuron: ramp([
      [0.0, [30, 62, 148]], [0.35, [66, 148, 190]], [0.5, [14, 16, 22]],
      [0.65, [212, 138, 76]], [1.0, [248, 226, 130]]
    ])
  };

  var DEEP = [6, 22, 46];
  var ICE = [222, 232, 238];

  /* Build (or reuse) the 1px-per-tile raster for a chunk in a given view mode. */
  function rasterize(chunk, mode, opts) {
    var tag = mode + '|' + (opts.contours ? 'c' : '') + (opts.probeTag || '');
    if (chunk.raster && chunk.rasterMode === tag) return chunk.raster;
    var seed = opts.seed || 0;
    var bx = chunk.cx * CHUNK, by = chunk.cy * CHUNK;

    var cv = chunk.raster || document.createElement('canvas');
    cv.width = CHUNK;
    cv.height = CHUNK;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(CHUNK, CHUNK);
    var d = img.data;
    var tmp = [0, 0, 0];
    var n = CHUNK * CHUNK;

    for (var i = 0; i < n; i++) {
      var hn = chunk.hn[i];
      var r, g, b;

      if (mode === 'biome') {
        r = chunk.rgb[i * 3];
        g = chunk.rgb[i * 3 + 1];
        b = chunk.rgb[i * 3 + 2];
        if (hn < 0) {
          /* Water: darken with depth instead of hillshading it. */
          var depth = clamp(-hn / 0.55, 0, 1);
          var k = depth * 0.78;
          r += (DEEP[0] - r) * k;
          g += (DEEP[1] - g) * k;
          b += (DEEP[2] - b) * k;
          /* Shallows: a soft lift over the last of the depth, squared so it fades
           * out rather than ending on a line. Keep it gentle — at full strength it
           * reads as a cyan contour drawn around every coast. */
          var surf = clamp(1 + hn / 0.04, 0, 1);
          surf *= surf;
          r += 15 * surf; g += 17 * surf; b += 11 * surf;
          var ice = clamp((0.14 - chunk.temp[i]) * 8, 0, 1);
          if (ice > 0) {
            r += (ICE[0] - r) * ice;
            g += (ICE[1] - g) * ice;
            b += (ICE[2] - b) * ice;
          }
        } else {
          var sh = chunk.shade[i];
          if (chunk.river[i] > 0.45) sh = 1 + (sh - 1) * 0.3;
          /*
           * Fine grain. Without it a grassland is a flat slab of one colour at
           * high zoom; a per-tile hash nudged by the flora channel gives the
           * ground a weave without inventing any structure that is not there.
           */
          var tx = i % CHUNK, ty = (i / CHUNK) | 0;
          sh *= 0.965 + NW.rand.hash2f(bx + tx, by + ty, seed) * 0.07 +
            (chunk.flora[i] - 0.5) * 0.05;
          r *= sh; g *= sh; b *= sh;
        }
      } else if (mode === 'elev') {
        RAMPS.elev(hn * 0.5 + 0.5, tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
        if (hn > 0) { r *= chunk.shade[i]; g *= chunk.shade[i]; b *= chunk.shade[i]; }
      } else if (mode === 'moist') {
        RAMPS.moist(chunk.moist[i], tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
      } else if (mode === 'temp') {
        RAMPS.temp(chunk.temp[i], tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
      } else if (mode === 'slope') {
        RAMPS.slope(chunk.slope[i], tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
      } else if (mode === 'hydro') {
        var land = hn > 0;
        var base = land ? 22 + chunk.hn[i] * 40 : 10;
        r = base; g = base + (land ? 4 : 14); b = base + (land ? 10 : 44);
        var rv = chunk.river[i];
        if (rv > 0) {
          r += (86 - r) * rv;
          g += (196 - g) * rv;
          b += (236 - b) * rv;
        }
      } else if (mode === 'flora') {
        RAMPS.scalar(chunk.flora[i] * (hn > 0 ? 1 : 0.15), tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
      } else if (mode === 'ore') {
        RAMPS.scalar(chunk.ore[i] * (hn > 0 ? 1 : 0.2), tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
      } else if (mode === 'neuron') {
        var act = chunk.probe ? chunk.probe[i] : 0;
        RAMPS.neuron(act * 0.5 + 0.5, tmp);
        r = tmp[0]; g = tmp[1]; b = tmp[2];
      } else {
        r = g = b = 0;
      }

      if (opts.contours && mode !== 'neuron') {
        /* Darken where a 0.08-elevation band boundary falls between neighbours. */
        var x = i % CHUNK, y = (i / CHUNK) | 0;
        var lv = Math.floor((hn + 1) / 0.08);
        var rt = x < CHUNK - 1 ? chunk.hn[i + 1] : hn;
        var dn = y < CHUNK - 1 ? chunk.hn[i + CHUNK] : hn;
        if (lv !== Math.floor((rt + 1) / 0.08) || lv !== Math.floor((dn + 1) / 0.08)) {
          r *= 0.74; g *= 0.74; b *= 0.74;
        }
      }

      var o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);
    chunk.raster = cv;
    chunk.rasterMode = tag;
    return cv;
  }

  /* ------------------------------------------------------------- decor --- */

  var FOREST = { 9: 1, 10: 1, 11: 1 };

  function tree(ctx, x, y, s, kind, tint) {
    if (kind === 'conifer') {
      ctx.fillStyle = 'rgba(28,20,12,0.45)';
      ctx.fillRect(x - s * 0.06, y - s * 0.05, s * 0.12, s * 0.3);
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 1.05);
      ctx.lineTo(x + s * 0.42, y);
      ctx.lineTo(x - s * 0.42, y);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'palm') {
      ctx.strokeStyle = 'rgba(58,44,26,0.8)';
      ctx.lineWidth = Math.max(1, s * 0.12);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + s * 0.1, y - s * 0.5, x + s * 0.22, y - s * 0.8);
      ctx.stroke();
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(x + s * 0.22, y - s * 0.8, s * 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(38,26,16,0.5)';
      ctx.fillRect(x - s * 0.06, y - s * 0.16, s * 0.12, s * 0.26);
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(x, y - s * 0.42, s * 0.36, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /*
   * Scatter props over the visible part of one chunk. Positions come from the
   * tile hash, never from Math.random, so nothing shifts while you pan.
   */
  function drawDecor(ctx, world, chunk, ox, oy, tilePx, view) {
    if (tilePx < 8) return;
    var seed = NW.rand.hashString(world.key) ^ 0x5bf03635;
    var x0 = Math.max(0, Math.floor((view.left - ox) / tilePx));
    var x1 = Math.min(CHUNK, Math.ceil((view.right - ox) / tilePx));
    var y0 = Math.max(0, Math.floor((view.top - oy) / tilePx));
    var y1 = Math.min(CHUNK, Math.ceil((view.bottom - oy) / tilePx));
    var s = tilePx;

    for (var ty = y0; ty < y1; ty++) {
      for (var tx = x0; tx < x1; tx++) {
        var i = ty * CHUNK + tx;
        if (chunk.hn[i] <= 0.005 || chunk.river[i] > 0.42) continue;
        var bi = chunk.biome[i];
        var wx = chunk.cx * CHUNK + tx, wy = chunk.cy * CHUNK + ty;
        var hv = NW.rand.hash2f(wx, wy, seed);
        var jx = NW.rand.hash2f(wx + 7919, wy, seed) - 0.5;
        var jy = NW.rand.hash2f(wx, wy + 104729, seed) - 0.5;
        var px = ox + (tx + 0.5 + jx * 0.7) * s;
        var py = oy + (ty + 0.75 + jy * 0.5) * s;
        var flora = chunk.flora[i];
        var shade = chunk.shade[i];

        if (FOREST[bi]) {
          var dens = 0.3 + flora * 0.55;
          if (hv > dens) continue;
          var kind = bi === 11 ? 'conifer' : (bi === 10 ? (hv < dens * 0.4 ? 'palm' : 'round') : 'round');
          var base = bi === 10 ? [26, 96, 54] : (bi === 11 ? [44, 92, 74] : [56, 118, 58]);
          var v = 0.75 + hv * 0.5;
          tree(ctx, px, py, s * (0.9 + jy * 0.3), kind,
            'rgb(' + ((base[0] * v * shade) | 0) + ',' + ((base[1] * v * shade) | 0) + ',' + ((base[2] * v * shade) | 0) + ')');
        } else if (bi === 8 || bi === 7 || bi === 12) {
          if (hv > 0.06 + flora * 0.2) continue;
          ctx.strokeStyle = bi === 12 ? 'rgba(196,206,190,0.7)' : 'rgba(72,104,44,0.72)';
          ctx.lineWidth = Math.max(1, s * 0.09);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - s * 0.18, py - s * 0.34);
          ctx.moveTo(px, py);
          ctx.lineTo(px + s * 0.16, py - s * 0.4);
          ctx.stroke();
        } else if (bi === 5 || bi === 6) {
          if (hv > 0.05) continue;
          ctx.strokeStyle = 'rgba(64,104,62,0.85)';
          ctx.lineWidth = Math.max(1.2, s * 0.14);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px, py - s * 0.62);
          ctx.moveTo(px, py - s * 0.34);
          ctx.lineTo(px + s * 0.2, py - s * 0.48);
          ctx.stroke();
        } else if (bi === 13 || bi === 14) {
          if (hv > 0.14) continue;
          ctx.fillStyle = bi === 14 ? 'rgba(150,158,168,0.75)' : 'rgba(96,90,82,0.9)';
          ctx.beginPath();
          ctx.ellipse(px, py - s * 0.15, s * 0.26, s * 0.18, jx, 0, Math.PI * 2);
          ctx.fill();
        } else if (bi === 15) {
          if (hv > 0.3) continue;
          var glow = 0.4 + chunk.ore[i] * 0.6;
          ctx.fillStyle = 'rgba(' + (230 * glow | 0) + ',' + (110 * glow | 0) + ',30,0.85)';
          ctx.fillRect(px - s * 0.12, py - s * 0.2, s * 0.24, s * 0.24);
        }

        /* Mineral glints, the sixth network output made visible. */
        if (tilePx >= 12 && chunk.ore[i] > 0.9 && hv < 0.35) {
          ctx.fillStyle = 'rgba(255,232,150,0.9)';
          ctx.fillRect(px + s * 0.24, py - s * 0.42, Math.max(1, s * 0.1), Math.max(1, s * 0.1));
        }
      }
    }
  }

  /* ---------------------------------------------------------- settlements --- */

  /*
   * Sites come from the shared civ layer (one truth for rendering, dossiers,
   * nations and roads). Cells not yet probed are reported in `misses` so the
   * app can queue them; markers appear as the probes resolve.
   */
  function drawSites(ctx, world, chunk, ox, oy, tilePx, misses) {
    var sites = NW.civ.sitesForChunk(world, chunk, misses);
    if (!sites.length) return;
    var bx = chunk.cx * CHUNK, by = chunk.cy * CHUNK;
    var labels = tilePx >= 5.5;
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    for (var s = 0; s < sites.length; s++) {
      var site = sites[s];
      var px = ox + (site.wx - bx + 0.5) * tilePx;
      var py = oy + (site.wy - by + 0.5) * tilePx;
      var rad = 2.6 + site.rank * 1.6;
      var nation = world.civ.siteNation.get(site.key);

      ctx.fillStyle = 'rgba(12,16,22,0.85)';
      ctx.beginPath();
      ctx.arc(px, py, rad + 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = site.rank === 2 ? '#f2e3c0' : (site.rank === 1 ? '#e0d3b4' : '#c3bda9');
      ctx.beginPath();
      if (site.rank === 2) {
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(12,16,22,0.85)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, py, rad - 2.2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      /* Nation ring, once the town's allegiance has been derived. */
      if (nation) {
        ctx.strokeStyle = nation.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(px, py, rad + 2.6, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (labels) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,11,16,0.9)';
        ctx.strokeText(site.name, px, py - rad - 5);
        ctx.fillStyle = site.rank ? '#f4ecd8' : '#d8d2c2';
        ctx.fillText(site.name, px, py - rad - 5);
      }
    }
    ctx.textAlign = 'left';
  }

  /*
   * Roads, drawn in world space from the civ layer's pathfound polylines.
   * Land runs are solid track; water runs are the ferry — dashed, cooler.
   */
  function drawRoads(ctx, world, vp, tilePx) {
    if (!world.civ || !world.civ.roadList.length) return;
    var lw = Math.max(1, tilePx * 0.16);
    for (var r = 0; r < world.civ.roadList.length; r++) {
      var road = world.civ.roadList[r];
      var bb = road.bbox;
      if (bb[2] < vp.left || bb[0] > vp.right || bb[3] < vp.top || bb[1] > vp.bottom) continue;
      var pts = road.pts;
      var run = null;   /* current stroke: 0 = land, 1 = ferry */
      for (var i = 0; i < pts.length; i++) {
        var x = (pts[i][0] - vp.left) * tilePx;
        var y = (pts[i][1] - vp.top) * tilePx;
        var wet = pts[i][2];
        if (run === null || wet !== run) {
          if (run !== null) ctx.stroke();
          ctx.beginPath();
          if (i > 0) {
            ctx.moveTo((pts[i - 1][0] - vp.left) * tilePx, (pts[i - 1][1] - vp.top) * tilePx);
            ctx.lineTo(x, y);
          } else {
            ctx.moveTo(x, y);
          }
          run = wet;
          ctx.strokeStyle = wet ? 'rgba(150,180,206,0.55)' : 'rgba(168,138,92,0.6)';
          ctx.lineWidth = wet ? lw * 0.8 : lw;
          ctx.setLineDash(wet ? [tilePx * 0.8, tilePx * 0.8] : []);
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (run !== null) ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /* ---------------------------------------------------------- coarse LOD --- */

  /*
   * Shaded RGB for a coarsely sampled region, averaged down by `ss` in each axis.
   *
   * Supersampling matters here: the network puts real detail at a few tiles per
   * cycle, so point-sampling every 6th tile turns a continent into confetti —
   * stray snowcaps and beaches from single samples that happened to land on a
   * peak. Averaging sub-samples is the only honest way to shrink the map.
   */
  function boxBlur(d, w, h) {
    var src = d.slice();
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var o = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          var sum = 0, n = 0;
          for (var dy = -1; dy <= 1; dy++) {
            var yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              sum += src[(yy * w + xx) * 4 + c];
              n++;
            }
          }
          d[o + c] = sum / n;
        }
      }
    }
  }

  /* Box-blur a canvas in place. Used once on a completed minimap. The caller
   * passes its own context so it can have been created with willReadFrequently. */
  function blurCanvas(cv, ctx) {
    ctx = ctx || cv.getContext('2d');
    var img = ctx.getImageData(0, 0, cv.width, cv.height);
    boxBlur(img.data, cv.width, cv.height);
    ctx.putImageData(img, 0, 0);
  }

  function regionToCanvas(region, ss, out, blur) {
    var w = Math.floor(region.w / ss), h = Math.floor(region.h / ss);
    var cv = out || document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(w, h);
    var d = img.data;
    var inv = 1 / (ss * ss);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0;
        for (var sy = 0; sy < ss; sy++) {
          var row = (y * ss + sy) * region.w + x * ss;
          for (var sx = 0; sx < ss; sx++) {
            var i = row + sx;
            var hn = region.hn[i];
            var sh = hn > 0 ? region.shade[i] : 1;
            var dp = hn < 0 ? clamp(-hn / 0.55, 0, 1) * 0.78 : 0;
            r += region.rgb[i * 3] * sh * (1 - dp) + DEEP[0] * dp;
            g += region.rgb[i * 3 + 1] * sh * (1 - dp) + DEEP[1] * dp;
            b += region.rgb[i * 3 + 2] * sh * (1 - dp) + DEEP[2] * dp;
          }
        }
        var o = (y * w + x) * 4;
        d[o] = r * inv;
        d[o + 1] = g * inv;
        d[o + 2] = b * inv;
        d[o + 3] = 255;
      }
    }
    if (blur) boxBlur(d, w, h);
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  NW.render = {
    RAMPS: RAMPS,
    rasterize: rasterize,
    drawDecor: drawDecor,
    drawSites: drawSites,
    drawRoads: drawRoads,
    regionToCanvas: regionToCanvas,
    blurCanvas: blurCanvas
  };
})(window.NW = window.NW || {});
