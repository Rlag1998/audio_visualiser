/*
 * ui.js — the readouts: loss curve, biome distribution, network diagram,
 * minimap, and permalink serialisation.
 *
 * These panels exist so the generator is not a black box. Every pixel of the map
 * comes from the forward pass drawn in drawNet(), and the biome bars are the
 * literal softmax the renderer blended to colour that tile.
 */
(function (NW) {
  'use strict';

  var clamp = NW.world.clamp;

  function crisp(canvas) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = canvas.clientWidth || canvas.width;
    var h = parseInt(canvas.getAttribute('height'), 10) || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* Signed activation colour: cool for negative, warm for positive. */
  function actColor(v, alpha) {
    var t = clamp(v, -1, 1);
    var r, g, b;
    if (t >= 0) { r = 26 + t * 216; g = 34 + t * 150; b = 44 + t * 40; }
    else { r = 26 - t * 30; g = 34 - t * 110; b = 44 - t * 196; }
    return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + (alpha === undefined ? 1 : alpha) + ')';
  }

  function facts(el, pairs) {
    var html = '';
    for (var i = 0; i < pairs.length; i++) {
      html += '<div><span>' + pairs[i][0] + '</span><b' +
        (pairs[i][2] ? ' class="' + pairs[i][2] + '"' : '') + '>' + pairs[i][1] + '</b></div>';
    }
    el.innerHTML = html;
  }

  /* --------------------------------------------------------- loss curve --- */

  function drawLoss(canvas, trainer) {
    var c = crisp(canvas), ctx = c.ctx;
    ctx.clearRect(0, 0, c.w, c.h);
    var hist = trainer.history;
    ctx.strokeStyle = '#1c2532';
    ctx.lineWidth = 1;
    for (var g = 1; g < 4; g++) {
      var yy = Math.round(c.h * g / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(c.w, yy); ctx.stroke();
    }
    if (hist.length < 2) {
      ctx.fillStyle = '#5c6a7d';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('training…', 8, c.h / 2);
      return;
    }
    var max = 0;
    for (var i = 0; i < hist.length; i++) max = Math.max(max, hist[i]);
    max = Math.max(max, 0.05);
    var pad = 4;
    ctx.strokeStyle = '#6fd3c7';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (var j = 0; j < hist.length; j++) {
      var x = pad + (c.w - pad * 2) * (j / (trainer.epochs - 1));
      var y = pad + (c.h - pad * 2) * (1 - Math.min(1, hist[j] / max) * 0.98);
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#5c6a7d';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(max.toFixed(2), 4, 10);
    ctx.fillText('loss ' + hist[hist.length - 1].toFixed(4) + '  ep ' + hist.length + '/' + trainer.epochs, 4, c.h - 4);
  }

  /* ------------------------------------------------------- biome probs --- */

  function drawProbs(canvas, probs) {
    var c = crisp(canvas), ctx = c.ctx;
    ctx.clearRect(0, 0, c.w, c.h);
    if (!probs) return;
    var B = NW.biome.BIOMES;
    var order = [];
    for (var i = 0; i < probs.length; i++) order.push(i);
    order.sort(function (a, b) { return probs[b] - probs[a]; });
    var rows = 6;
    var rowH = c.h / rows;
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (var r = 0; r < rows; r++) {
      var id = order[r];
      var p = probs[id];
      var y = r * rowH + rowH / 2;
      var labelW = 104;
      ctx.fillStyle = 'rgb(' + B[id].rgb.join(',') + ')';
      ctx.fillRect(4, y - 4, 8, 8);
      ctx.fillStyle = r === 0 ? '#dfe7f0' : '#8a99ad';
      ctx.fillText(B[id].name.slice(0, 15), 16, y);
      var bw = (c.w - labelW - 34) * p;
      ctx.fillStyle = '#1d2634';
      ctx.fillRect(labelW, y - 4, c.w - labelW - 34, 8);
      ctx.fillStyle = r === 0 ? '#6fd3c7' : '#3f6f72';
      ctx.fillRect(labelW, y - 4, Math.max(1, bw), 8);
      ctx.fillStyle = '#5c6a7d';
      ctx.fillText((p * 100).toFixed(1) + '%', c.w - 30, y);
    }
  }

  /* --------------------------------------------------- network diagram --- */

  function pickIndices(count, maxShown) {
    var idx = [];
    if (count <= maxShown) {
      for (var i = 0; i < count; i++) idx.push(i);
    } else {
      for (var j = 0; j < maxShown; j++) idx.push(Math.round(j * (count - 1) / (maxShown - 1)));
    }
    return idx;
  }

  function drawNet(canvas, net, trace) {
    var c = crisp(canvas), ctx = c.ctx;
    ctx.clearRect(0, 0, c.w, c.h);
    if (!trace) {
      ctx.fillStyle = '#5c6a7d';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('hover the map to trace a forward pass', 10, c.h / 2);
      return;
    }
    var cols = trace.length;
    var maxShown = 13;
    var shown = [];
    for (var l = 0; l < cols; l++) shown.push(pickIndices(trace[l].length, maxShown));

    var padX = 16, padY = 12;
    var colX = [];
    for (var i = 0; i < cols; i++) colX.push(padX + (c.w - padX * 2) * (cols === 1 ? 0 : i / (cols - 1)));
    function nodeY(col, k) {
      var n = shown[col].length;
      if (n === 1) return c.h / 2;
      return padY + (c.h - padY * 2) * (k / (n - 1));
    }

    /* Edges: for each shown target, the strongest few shown incoming weights. */
    for (var t = 1; t < cols; t++) {
      var layer = net.layers[t - 1];
      var srcIdx = shown[t - 1], dstIdx = shown[t];
      for (var dj = 0; dj < dstIdx.length; dj++) {
        var j = dstIdx[dj];
        var cand = [];
        for (var si = 0; si < srcIdx.length; si++) {
          var k = srcIdx[si];
          cand.push([Math.abs(layer.w[k * layer.outDim + j]), layer.w[k * layer.outDim + j], si]);
        }
        cand.sort(function (a, b) { return b[0] - a[0]; });
        var keep = Math.min(4, cand.length);
        for (var q = 0; q < keep; q++) {
          var w = cand[q][1];
          var a = clamp(Math.abs(w) * 0.8, 0.05, 0.55);
          ctx.strokeStyle = w >= 0 ? 'rgba(111,211,199,' + a + ')' : 'rgba(212,124,92,' + a + ')';
          ctx.lineWidth = clamp(Math.abs(w) * 1.4, 0.4, 2);
          ctx.beginPath();
          ctx.moveTo(colX[t - 1], nodeY(t - 1, cand[q][2]));
          ctx.lineTo(colX[t], nodeY(t, dj));
          ctx.stroke();
        }
      }
    }

    for (var col = 0; col < cols; col++) {
      var ids = shown[col];
      for (var m = 0; m < ids.length; m++) {
        var v = trace[col][ids[m]];
        var rad = col === 0 || col === cols - 1 ? 4 : 4.5;
        ctx.beginPath();
        ctx.arc(colX[col], nodeY(col, m), rad, 0, Math.PI * 2);
        ctx.fillStyle = actColor(v);
        ctx.fill();
        ctx.strokeStyle = 'rgba(190,205,220,0.35)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ctx.fillStyle = '#4c5a6d';
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      var label = col === 0 ? 'in' + trace[0].length
        : (col === cols - 1 ? 'out' : 'h' + col);
      ctx.fillText(label, colX[col], c.h - 2);
      if (trace[col].length > maxShown) ctx.fillText('·' + trace[col].length, colX[col], 8);
      ctx.textAlign = 'left';
    }
  }

  /* ------------------------------------------------------------ minimap --- */

  function drawMinimap(canvas, src, origin, span, cam, view) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0b0f16';
    ctx.fillRect(0, 0, W, H);
    if (!origin) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, W, H);

    /* Viewport rectangle, in minimap pixels. */
    var s = W / span;
    var vx = (cam.x - view.wTiles / 2 - origin.x0) * s;
    var vy = (cam.y - view.hTiles / 2 - origin.y0) * s;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(vx) + 0.5, Math.round(vy) + 0.5,
      Math.max(3, view.wTiles * s), Math.max(3, view.hTiles * s));
  }

  /* -------------------------------------------------------- permalinks --- */

  function encodeSpec(spec) {
    var o = {
      s: spec.seed,
      d: spec.depth,
      w: spec.width,
      g: +spec.gain.toFixed(3),
      z: spec.z.map(function (v) { return +v.toFixed(3); }),
      c: spec.scale,
      l: +spec.sea.toFixed(3),
      a: +spec.auth.toFixed(3),
      r: +spec.rivers.toFixed(3),
      m: spec.lineage.map(function (st) { return [st[0], +st[1].toFixed(3)]; })
    };
    return encodeURIComponent(JSON.stringify(o));
  }

  function decodeSpec(str) {
    try {
      var o = JSON.parse(decodeURIComponent(str));
      var spec = NW.world.defaultSpec(String(o.s == null ? 'orpheus' : o.s));
      if (o.d) spec.depth = clamp(o.d | 0, 1, 6);
      if (o.w) spec.width = clamp(o.w | 0, 4, 64);
      if (o.g) spec.gain = clamp(+o.g, 0.2, 4);
      if (Array.isArray(o.z)) for (var i = 0; i < 4; i++) spec.z[i] = clamp(+o.z[i] || 0, -3, 3);
      if (o.c) spec.scale = clamp(+o.c, 20, 4000);
      if (o.l !== undefined) spec.sea = clamp(+o.l, -1, 1);
      if (o.a !== undefined) spec.auth = clamp(+o.a, 0, 1);
      if (o.r !== undefined) spec.rivers = clamp(+o.r, 0, 6);
      if (Array.isArray(o.m)) {
        spec.lineage = o.m.slice(0, 64).map(function (st) {
          return [st[0] >>> 0, clamp(+st[1] || 0, 0, 2)];
        });
      }
      return spec;
    } catch (e) {
      return null;
    }
  }

  NW.ui = {
    crisp: crisp,
    facts: facts,
    actColor: actColor,
    drawLoss: drawLoss,
    drawProbs: drawProbs,
    drawNet: drawNet,
    drawMinimap: drawMinimap,
    encodeSpec: encodeSpec,
    decodeSpec: decodeSpec
  };
})(window.NW = window.NW || {});
