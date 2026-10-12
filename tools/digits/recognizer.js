// Handwritten number recognizer: groups strokes into digits, normalizes each
// MNIST-style (longest side 20px, centered by mass in 28x28), runs a small MLP.
(function (root) {
  let layers = null;
  function load(model) {
    layers = model.map(L => {
      const bin = atob(L.w), q = new Int8Array(bin.length);
      for (let i = 0; i < bin.length; i++) q[i] = (bin.charCodeAt(i) << 24) >> 24;
      const w = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) w[i] = q[i] * L.scale;
      return { inn: L.in, out: L.out, w, b: Float32Array.from(L.b) };
    });
  }
  function infer(x) { // x: Float32Array(784) in [0,1]
    let h = x;
    layers.forEach((L, li) => {
      const o = new Float32Array(L.out);
      for (let j = 0; j < L.out; j++) o[j] = L.b[j];
      for (let i = 0; i < L.inn; i++) {
        const v = h[i]; if (v === 0) continue;
        const row = i * L.out;
        for (let j = 0; j < L.out; j++) o[j] += v * L.w[row + j];
      }
      if (li < layers.length - 1) for (let j = 0; j < L.out; j++) if (o[j] < 0) o[j] = 0;
      h = o;
    });
    const m = Math.max(...h); let s = 0; const p = h.map(v => { const e = Math.exp(v - m); s += e; return e; });
    return Array.from(p, v => v / s);
  }

  function bbox(pts) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    return { x0: a, y0: b, x1: c, y1: d };
  }
  function groupStrokes(strokes) {
    const items = strokes.filter(s => s.length).map(s => ({ s, ...bbox(s) })).sort((p, q) => p.x0 - q.x0);
    const groups = [];
    for (const it of items) {
      const g = groups[groups.length - 1];
      if (g) {
        const ov = Math.min(g.x1, it.x1) - Math.max(g.x0, it.x0);
        const minW = Math.max(10, Math.min(g.x1 - g.x0, it.x1 - it.x0));
        const cx = (it.x0 + it.x1) / 2;
        if (ov > 0.3 * minW || (cx >= g.x0 && cx <= g.x1)) {
          g.strokes.push(it.s); g.x0 = Math.min(g.x0, it.x0); g.x1 = Math.max(g.x1, it.x1);
          g.y0 = Math.min(g.y0, it.y0); g.y1 = Math.max(g.y1, it.y1); continue;
        }
      }
      groups.push({ strokes: [it.s], x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1 });
    }
    return groups;
  }

  const R = 4, N = 28 * R; // render at 4x, then average down
  let cv = null;
  function draw(ctx, strokes, s, ox, oy) {
    ctx.clearRect(0, 0, N, N);
    ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineWidth = 2.6 * R; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const st of strokes) {
      ctx.beginPath();
      st.forEach(([x, y], i) => { const X = x * s + ox, Y = y * s + oy; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      if (st.length === 1) ctx.lineTo(st[0][0] * s + ox + 0.1, st[0][1] * s + oy);
      ctx.stroke();
    }
    return ctx.getImageData(0, 0, N, N).data;
  }
  function toInput(g) {
    if (!cv) { cv = document.createElement('canvas'); cv.width = cv.height = N; }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const w = g.x1 - g.x0, h = g.y1 - g.y0;
    const s = (20 - 2.6) * R / Math.max(w, h, 1);
    let ox = N / 2 - (g.x0 + w / 2) * s, oy = N / 2 - (g.y0 + h / 2) * s;
    let d = draw(ctx, g.strokes, s, ox, oy);
    let m = 0, mx = 0, my = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const a = d[(y * N + x) * 4 + 3]; m += a; mx += a * x; my += a * y; }
    if (m > 0) { ox += N / 2 - mx / m; oy += N / 2 - my / m; d = draw(ctx, g.strokes, s, ox, oy); }
    const out = new Float32Array(784);
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
      let a = 0;
      for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) a += d[((y * R + dy) * N + x * R + dx) * 4 + 3];
      out[y * 28 + x] = a / (R * R * 255);
    }
    return out;
  }

  // strokes: array of arrays of [x, y]. Returns { text, digits: [{digit, confidence}] }.
  function recognize(strokes) {
    if (!layers) throw new Error('Digit model not loaded');
    const digits = groupStrokes(strokes).map(g => {
      const p = infer(toInput(g));
      let best = 0; p.forEach((v, i) => { if (v > p[best]) best = i; });
      return { digit: best, confidence: p[best] };
    });
    return { text: digits.map(d => d.digit).join(''), digits };
  }
  root.Digits = { load, recognize, infer, groupStrokes };
})(typeof window !== 'undefined' ? window : globalThis);
