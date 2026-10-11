'use strict';
// Gráficos e diagramas desenhados com formas nativas do PowerPoint (editáveis, sem imagens).
// Gráficos no estilo think-cell: colunas, empilhado, barras, linha, pizza, rosca e cascata, com rótulos
// diretos, seta de CAGR e seta de diferença. Diagramas: processo, linha do tempo, funil, pirâmide,
// matriz 2x2, ciclo, cartões, hub, venn, tabela e agenda.

const EMU = 914400;
const inch = (v) => Math.round(v * EMU);

const luminance = (h) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ink = (bg) => (luminance(bg) > 0.55 ? '111111' : 'FFFFFF');
// mistura duas cores hex (k = 0 → a, k = 1 → b)
const mix = (a, b, k) => [0, 2, 4].map((i) => {
  const v = Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k);
  return v.toString(16).padStart(2, '0');
}).join('').toUpperCase();
const hexOr = (c, fb) => {
  const v = String(c || '').replace('#', '').trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(v) ? v : fb;
};
const pal = (t, i) => t.palette[i % t.palette.length];
// largura aproximada de um texto (tamanho em centésimos de ponto)
const textW = (s, size) => Math.round(String(s).length * (size / 100) * 0.62 * 12700);

function fmtNum(v, f = {}) {
  const n = Number(v);
  const d = f.decimals ?? (Math.abs(n) < 10 && n % 1 ? 1 : (n % 1 && Math.abs(n) < 100 ? 1 : 0));
  const s = Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${n < 0 ? '-' : ''}${f.prefix || ''}${s}${f.suffix || ''}`;
}
// cor de texto legível sobre o fundo (cores claras da paleta escurecem no fundo claro e vice-versa)
const readable = (col, t) => (Math.abs(luminance(col) - luminance(t.bg)) < 0.3 ? mix(col, t.fg, 0.55) : col);
// maior fonte (até base) em que a palavra mais longa cabe na largura e o texto cabe em maxLines linhas
function fitSize(text, width, base, min = 1000, maxLines = 2) {
  const words = String(text || '').split(/\s+/);
  for (let sz = base; sz > min; sz -= 100) {
    const longest = Math.max(...words.map((w) => textW(w, sz)));
    if (longest <= width && textW(text, sz) <= width * maxLines) return sz;
  }
  return min;
}
// número grande vindo cru (15000000000) vira "15 bi"; texto fica como está
function compact(v, prefix = '') {
  if (typeof v !== 'number' && !/^-?d{5,}(.d+)?$/.test(String(v ?? '').trim())) return String(v ?? '');
  const n = Number(v), a = Math.abs(n);
  const [d, u] = a >= 1e9 ? [1e9, ' bi'] : a >= 1e6 ? [1e6, ' mi'] : a >= 1e4 ? [1e3, ' mil'] : [1, ''];
  return fmtNum(n / d, { prefix, suffix: u, decimals: (n / d) % 1 ? 1 : 0 });
}
const fmtOf = (c) => ({ prefix: c.prefix || '', suffix: c.suffix ?? c.unit ?? '', decimals: c.decimals });

// ---------- dados ----------
// Listas que chegam em outro formato: "825 915 1005" (ConvertTo-Json do PowerShell), "1;2;3", { jan: 1, fev: 2 }.
function asList(x) {
  if (Array.isArray(x)) return x;
  if (x == null || x === '') return [];
  if (typeof x === 'object') return Object.values(x);
  const s = String(x).trim();
  if (/^\[.*\]$/.test(s)) { try { return JSON.parse(s); } catch { /* segue */ } }
  return s.split(/\s*;\s*|\s*\|\s*|\s+/.test(s) ? /\s*;\s*|\s*\|\s*|\s+/ : /\s*,\s*/).filter(Boolean);
}
const toNum = (x) => (typeof x === 'number' ? x : Number(String(x).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')));

function chartData(c) {
  let cats = asList(c.categories || c.labels).map(String);
  const rawSer = c.series && !Array.isArray(c.series) && typeof c.series === 'object'
    ? Object.entries(c.series).map(([name, values]) => ({ name, values })) // { "Receita": [..] }
    : asList(c.series);
  if (!cats.length && c.values && !Array.isArray(c.values) && typeof c.values === 'object') cats = Object.keys(c.values);
  let ser = rawSer.length ? rawSer : [{ name: c.name || '', values: c.values }];
  ser = ser.map((s) => ({ name: String(s.name ?? ''), values: asList(s.values ?? s.data).map(toNum), color: s.color }));
  const n = cats.length || ser[0].values.length;
  if (!n) throw new Error('Gráfico sem dados: informe categories e series[{name, values}] (ou values).');
  for (const s of ser) {
    if (s.values.length !== n) throw new Error(`Gráfico: a série "${s.name}" tem ${s.values.length} valores para ${n} categorias.`);
    if (s.values.some((v) => !Number.isFinite(v))) throw new Error(`Gráfico: a série "${s.name}" tem valores que não são números.`);
  }
  const all = ser.flatMap((s) => s.values);
  if (/%/.test(String(c.suffix ?? c.unit ?? '')) && !/100/.test(String(c.type || '')) && all.some((x) => x !== 0) && all.every((x) => Math.abs(x) <= 1)) {
    ser.forEach((s) => { s.values = s.values.map((x) => x * 100); });
  }
  return { cats: cats.length ? cats : ser[0].values.map((_, i) => String(i + 1)), ser };
}

// cor da barra: série com cor própria > destaque > paleta
function barColor(t, c, ser, s, i) {
  if (ser[s].color) return hexOr(ser[s].color, pal(t, s));
  if (ser.length === 1) {
    if (c.highlight != null) return [].concat(c.highlight).includes(i) ? t.accent : t.dim;
    return t.accent;
  }
  return pal(t, s);
}

function legend(b, t, ser, x, y, colorOf) {
  let cx = x;
  ser.forEach((s, i) => {
    const col = colorOf(i);
    b.shape('rect', cx, y + inch(0.07), inch(0.16), inch(0.16), { fill: col });
    const w = textW(s.name, 1200) + inch(0.3);
    b.text(cx + inch(0.24), y, w, inch(0.3), [{ text: s.name, size: 1200, color: t.muted }], { anchor: 'ctr' });
    cx += w + inch(0.3);
  });
}

// ---------- gráficos ----------
function columns(b, t, c, X, Y, W, H) {
  const { cats, ser } = chartData(c);
  const type = String(c.type || '');
  const stacked = /empilhad|stack/.test(type);
  const pct = /100/.test(type);
  const f = pct ? { suffix: '%', decimals: 0 } : fmtOf(c);
  const n = cats.length;
  let data = ser.map((s) => s.values);
  if (pct) data = data.map((vals) => vals.map((v, i) => { const tot = ser.reduce((a, s2) => a + s2.values[i], 0); return tot ? (v / tot) * 100 : 0; }));
  const totals = cats.map((_, i) => data.reduce((a, v) => a + Math.max(0, v[i]), 0));
  const colorOf = (s, i = -1) => barColor(t, c, ser, s, i);
  const legendH = ser.length > 1 ? inch(0.45) : 0;
  if (legendH) legend(b, t, ser, X, Y, (s) => colorOf(s));
  const diff = c.diff ? [].concat(c.diff.from ?? c.diff[0], c.diff.to ?? c.diff[1]).map(Number) : null;
  if (diff) W -= inch(1.1); // espaço para a seta de diferença
  const top = Y + legendH + inch(c.cagr ? 1.0 : 0.45);
  const bottom = Y + H - inch(0.5);
  const all = stacked ? totals : data.flat();
  const maxV = Math.max(0, ...all), minV = stacked ? 0 : Math.min(0, ...all);
  const k = (bottom - top) / ((maxV - minV) || 1);
  const zero = top + maxV * k;
  const slot = W / n, gw = slot * (n > 8 ? 0.7 : 0.6);
  const bw = stacked ? gw : gw / ser.length;
  const fs = n > 10 ? 1000 : n > 6 ? 1200 : 1400;
  const tops = [];
  const lbl = (x, y, w, text, opts = {}) => b.text(x - inch(0.25), y, w + inch(0.5), inch(0.32), [{ text, size: opts.size || fs, bold: opts.bold, color: opts.color, align: 'ctr' }], { anchor: opts.anchor || 'b' });
  cats.forEach((cat, i) => {
    const gx = X + slot * i + (slot - gw) / 2;
    if (stacked) {
      let acc = 0;
      data.forEach((vals, s) => {
        const v = vals[i];
        if (!(v > 0)) return;
        const y0 = zero - (acc + v) * k, hh = v * k;
        const col = colorOf(s, i);
        b.shape('rect', gx, y0, bw, hh, { fill: col, line: t.bg, lineW: 9525 });
        if (hh > inch(0.26)) b.text(gx, y0, bw, hh, [{ text: fmtNum(v, f), size: fs - 200, color: ink(col), align: 'ctr' }], { anchor: 'ctr' });
        acc += v;
      });
      const ty = zero - acc * k;
      if (!pct) lbl(gx, ty - inch(0.36), bw, fmtNum(acc, f), { bold: true });
      tops.push(ty - (pct ? inch(0.05) : inch(0.4)));
    } else {
      let hi = zero;
      data.forEach((vals, s) => {
        const v = vals[i], bx = gx + s * bw, hh = Math.abs(v) * k;
        const y0 = v >= 0 ? zero - hh : zero;
        b.shape('rect', bx + bw * 0.04, y0, bw * 0.92, Math.max(hh, 1), { fill: colorOf(s, i) });
        const ly = v >= 0 ? y0 - inch(0.34) : y0 + hh + inch(0.02);
        lbl(bx, ly, bw, fmtNum(v, f), { size: ser.length > 2 ? fs - 200 : fs, bold: ser.length === 1, anchor: v >= 0 ? 'b' : 't' });
        hi = Math.min(hi, ly);
      });
      tops.push(hi - inch(0.04));
    }
    b.text(X + slot * i, bottom + inch(0.08), slot, inch(0.42), [{ text: cat, size: fs, color: t.muted, align: 'ctr' }]);
  });
  b.line(X, zero, X + W, zero, { color: t.muted, w: 9525 });
  const cx = (i) => X + slot * i + slot / 2;
  if (c.cagr) {
    const [i0, i1] = Array.isArray(c.cagr) ? c.cagr.map(Number) : [0, n - 1];
    const v0 = totals[i0], v1 = totals[i1];
    if (v0 > 0 && v1 > 0 && i1 > i0) {
      const rate = (Math.pow(v1 / v0, 1 / (i1 - i0)) - 1) * 100;
      const yA = top - inch(0.62);
      b.path([[cx(i0), tops[i0]], [cx(i0), yA], [cx(i1), yA], [cx(i1), tops[i1]]], { color: t.fg, w: 12700, arrow: 'end' });
      const lw = inch(1.9), lh = inch(0.36);
      b.shape('roundRect', (cx(i0) + cx(i1)) / 2 - lw / 2, yA - lh / 2, lw, lh, {
        fill: t.bg, line: t.fg, adj: { adj: 50000 }, inset: 0.02,
        paras: [{ text: `CAGR ${rate >= 0 ? '+' : ''}${fmtNum(rate, { decimals: 1 })}%`, size: 1300, bold: true, align: 'ctr' }],
      });
    }
  }
  if (diff && totals[diff[0]] != null && totals[diff[1]] != null) {
    const [a, z] = diff;
    const va = stacked ? totals[a] : data[0][a], vz = stacked ? totals[z] : data[0][z];
    const ya = zero - va * k, yz = zero - vz * k;
    const xr = X + W + inch(0.25);
    b.line(cx(a) + bw / 2, ya, xr, ya, { color: t.muted, w: 9525, dash: 'dash' });
    b.line(cx(z) + bw / 2, yz, xr, yz, { color: t.muted, w: 9525, dash: 'dash' });
    b.line(xr, ya, xr, yz, { color: t.fg, w: 15875, arrow: 'end' });
    const d = va ? (vz / va - 1) * 100 : 0;
    b.shape('roundRect', xr + inch(0.1), (ya + yz) / 2 - inch(0.18), inch(0.95), inch(0.36), {
      fill: t.bg, line: t.fg, adj: { adj: 50000 }, inset: 0.02,
      paras: [{ text: `${d >= 0 ? '+' : ''}${fmtNum(d, { decimals: Math.abs(d) < 10 ? 1 : 0 })}%`, size: 1300, bold: true, align: 'ctr' }],
    });
  }
}

function bars(b, t, c, X, Y, W, H) {
  const { cats, ser } = chartData(c);
  const f = fmtOf(c);
  const n = cats.length;
  const legendH = ser.length > 1 ? inch(0.45) : 0;
  const colorOf = (s, i = -1) => barColor(t, c, ser, s, i);
  if (legendH) legend(b, t, ser, X, Y, (s) => colorOf(s));
  const fs = n > 10 ? 1100 : 1400;
  const labW = Math.min(W * 0.32, Math.max(...cats.map((x) => textW(x, fs))) + inch(0.25));
  const valW = inch(1.1), x0 = X + labW, plotW = W - labW - valW;
  const maxV = Math.max(0.0001, ...ser.flatMap((s) => s.values));
  const rowH = (H - legendH) / n, bh = (rowH * 0.66) / ser.length;
  cats.forEach((cat, i) => {
    const ry = Y + legendH + rowH * i;
    b.text(X, ry, labW - inch(0.15), rowH, [{ text: cat, size: fs, align: 'r' }], { anchor: 'ctr' });
    ser.forEach((s, k) => {
      const v = s.values[i], w = Math.max(1, (Math.max(0, v) / maxV) * plotW);
      const y0 = ry + (rowH - bh * ser.length) / 2 + k * bh;
      b.shape('rect', x0, y0, w, bh * 0.9, { fill: colorOf(k, i) });
      b.text(x0 + w + inch(0.08), y0 - inch(0.05), valW, bh * 0.9 + inch(0.1), [{ text: fmtNum(v, f), size: ser.length > 1 ? fs - 200 : fs, bold: ser.length === 1 }], { anchor: 'ctr' });
    });
  });
  b.line(x0, Y + legendH, x0, Y + H, { color: t.muted, w: 9525 });
}

function lines(b, t, c, X, Y, W, H) {
  const { cats, ser } = chartData(c);
  const f = fmtOf(c);
  const n = cats.length;
  const multi = ser.length > 1;
  const plotW = W - (multi ? inch(2.0) : inch(0.4));
  const top = Y + inch(0.4), bottom = Y + H - inch(0.5);
  const all = ser.flatMap((s) => s.values);
  let maxV = Math.max(...all), minV = c.zero === false ? Math.min(...all) : Math.min(0, ...all);
  if (c.zero === false) { const pad = (maxV - minV || 1) * 0.1; maxV += pad; minV -= pad; }
  const k = (bottom - top) / ((maxV - minV) || 1);
  const slot = plotW / n;
  const px = (i) => X + slot * i + slot / 2, py = (v) => bottom - (v - minV) * k;
  const fs = n > 10 ? 1000 : 1200;
  b.line(X, bottom, X + plotW, bottom, { color: t.muted, w: 9525 });
  const every = n > 14 ? Math.ceil(n / 10) : 1;
  cats.forEach((cat, i) => {
    if (i % every === 0 || i === n - 1) b.text(px(i) - slot * every / 2, bottom + inch(0.08), slot * every, inch(0.4), [{ text: cat, size: fs, color: t.muted, align: 'ctr' }]);
  });
  const ends = [];
  ser.forEach((s, k2) => {
    const col = s.color ? hexOr(s.color, pal(t, k2)) : (multi ? pal(t, k2) : t.accent);
    const pts = s.values.map((v, i) => [px(i), py(v)]);
    b.path(pts, { color: col, w: 31750 });
    const dot = inch(n > 16 ? 0.07 : 0.12);
    if (n <= 24) pts.forEach(([x, y]) => b.shape('ellipse', x - dot / 2, y - dot / 2, dot, dot, { fill: col, line: t.bg, lineW: 9525 }));
    if (!multi && n <= 12) s.values.forEach((v, i) => b.text(px(i) - inch(0.6), py(v) - inch(0.4), inch(1.2), inch(0.3), [{ text: fmtNum(v, f), size: fs, bold: true, align: 'ctr' }], { anchor: 'b' }));
    if (multi) ends.push({ y: pts[n - 1][1], col, text: `${s.name}  ${fmtNum(s.values[n - 1], f)}` });
  });
  // rótulos no fim das linhas, afastados para não sobrepor
  ends.sort((a, z) => a.y - z.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < inch(0.3)) ends[i].y = ends[i - 1].y + inch(0.3);
  ends.forEach((e) => b.text(X + plotW + inch(0.15), e.y - inch(0.15), inch(1.85), inch(0.3), [{ text: e.text, size: 1200, bold: true, color: e.col }], { anchor: 'ctr' }));
}

function pie(b, t, c, X, Y, W, H, donut) {
  const { cats, ser } = chartData(c);
  const f = fmtOf(c);
  const vals = ser[0].values.map((v) => Math.max(0, v));
  const tot = vals.reduce((a, v) => a + v, 0);
  if (!tot) throw new Error('Gráfico de pizza: a soma dos valores é zero.');
  const D = Math.min(H, W * (W < inch(7) ? 0.4 : 0.46));
  const px = X + inch(0.2), py = Y + (H - D) / 2, cx = px + D / 2, cy = py + D / 2;
  const colorOf = (i) => (c.colors && c.colors[i] ? hexOr(c.colors[i], pal(t, i))
    : c.highlight != null ? ([].concat(c.highlight).includes(i) ? t.accent : mix(t.dim, t.bg, (i % 3) * 0.18)) : pal(t, i));
  let acc = 0;
  vals.forEach((v, i) => {
    const share = v / tot;
    if (!share) return;
    const col = colorOf(i);
    const a0 = 270 + acc * 360, a1 = 270 + (acc + share) * 360;
    if (share > 0.9999) b.shape('ellipse', px, py, D, D, { fill: col });
    else b.shape('pie', px, py, D, D, { fill: col, line: t.bg, lineW: 19050, adj: { adj1: Math.round((a0 % 360) * 60000), adj2: Math.round((a1 % 360) * 60000) } });
    if (share >= 0.05) {
      const mid = (((a0 + a1) / 2) * Math.PI) / 180, r = donut ? D * 0.39 : D * 0.31;
      b.text(cx + r * Math.cos(mid) - inch(0.5), cy + r * Math.sin(mid) - inch(0.17), inch(1.0), inch(0.34),
        [{ text: `${fmtNum(share * 100, { decimals: 0 })}%`, size: 1300, bold: true, color: ink(col), align: 'ctr' }], { anchor: 'ctr' });
    }
    acc += share;
  });
  if (donut) {
    const hole = D * 0.56;
    b.shape('ellipse', cx - hole / 2, cy - hole / 2, hole, hole, { fill: t.bg });
    const ctext = String(c.center ?? fmtNum(tot, f));
    b.text(cx - hole / 2, cy - inch(0.45), hole, inch(0.55), [{ text: ctext, size: fitSize(ctext, hole * 0.9, 2600, 1200, 1), bold: true, align: 'ctr' }], { anchor: 'b' });
    if (c.center_label) b.text(cx - hole / 2, cy + inch(0.12), hole, inch(0.4), [{ text: c.center_label, size: 1200, color: t.muted, align: 'ctr' }]);
  }
  const lx = px + D + inch(W < inch(7) ? 0.35 : 0.7), lw = Math.min(X + W - lx, inch(4.8));
  const rowH = Math.min(inch(0.55), H / vals.length), ly = Y + (H - rowH * vals.length) / 2;
  // valores já em porcentagem somando ~100: mostra só uma vez
  const isPct = /%/.test(f.suffix) && Math.abs(tot - 100) < 1.5;
  const narrow = lw < inch(3.2);
  const valW = isPct || narrow ? inch(0.75) : inch(1.9);
  const fsz = narrow ? 1300 : 1500;
  vals.forEach((v, i) => {
    const y = ly + rowH * i;
    b.shape('rect', lx, y + rowH / 2 - inch(0.1), inch(0.2), inch(0.2), { fill: colorOf(i) });
    b.text(lx + inch(0.32), y, Math.max(inch(0.6), lw - inch(0.32) - valW), rowH, [{ text: cats[i], size: fsz }], { anchor: 'ctr' });
    const pctTxt = `${fmtNum((v / tot) * 100, { decimals: 0 })}%`;
    const txt = isPct ? `**${pctTxt}**` : narrow ? `**${fmtNum(v, f)}**` : `**${fmtNum(v, f)}**  ${pctTxt}`;
    b.text(lx + lw - valW, y, valW, rowH, [{ text: txt, size: fsz - 100, color: t.muted, align: 'r' }], { anchor: 'ctr' });
  });
}

function waterfall(b, t, c, X, Y, W, H) {
  const src = Array.isArray(c.items) && c.items.length ? c.items
    : (c.categories || c.labels || []).map((label, i) => ({ label, value: (c.values || (c.series && c.series[0] && c.series[0].values) || [])[i], total: (c.totals || []).includes(i) }));
  if (!src.length) throw new Error('Cascata sem dados: informe items[{label, value, total?}].');
  const f = fmtOf(c);
  let run = 0;
  const segs = src.map((it) => {
    if (it.total) { const v = it.value != null ? Number(it.value) : run; run = v; return { a: 0, b: v, v, total: true, label: String(it.label ?? '') }; }
    const v = Number(it.value);
    if (!Number.isFinite(v)) throw new Error(`Cascata: o item "${it.label}" não tem valor numérico.`);
    const a = run; run += v; return { a, b: run, v, label: String(it.label ?? '') };
  });
  const lv = segs.flatMap((s) => [s.a, s.b]);
  const maxV = Math.max(0, ...lv), minV = Math.min(0, ...lv);
  const top = Y + inch(0.45), bottom = Y + H - inch(0.5);
  const k = (bottom - top) / ((maxV - minV) || 1);
  const yv = (v) => top + (maxV - v) * k;
  const n = segs.length, slot = W / n, bw = slot * 0.62;
  const fs = n > 9 ? 1100 : 1300;
  segs.forEach((s, i) => {
    const gx = X + slot * i + (slot - bw) / 2;
    const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
    const col = s.total ? t.accent : s.v >= 0 ? t.up : t.down;
    b.shape('rect', gx, yv(hi), bw, Math.max(1, (hi - lo) * k), { fill: col });
    const text = s.total ? fmtNum(s.v, f) : `${s.v >= 0 ? '+' : ''}${fmtNum(s.v, f)}`;
    b.text(gx - inch(0.25), yv(hi) - inch(0.34), bw + inch(0.5), inch(0.32), [{ text, size: fs, bold: true, align: 'ctr' }], { anchor: 'b' });
    b.text(X + slot * i, bottom + inch(0.08), slot, inch(0.42), [{ text: s.label, size: fs - 100, color: t.muted, align: 'ctr' }]);
    if (i < n - 1) b.line(gx + bw, yv(s.b), gx + slot, yv(s.b), { color: t.muted, w: 9525, dash: 'dash' });
  });
  b.line(X, yv(0), X + W, yv(0), { color: t.muted, w: 9525 });
}

const CHARTS = {
  colunas: columns, empilhado: columns, empilhado100: columns, barras: bars, linha: lines, cascata: waterfall,
  pizza: (b, t, c, ...r) => pie(b, t, c, ...r, false), rosca: (b, t, c, ...r) => pie(b, t, c, ...r, true),
};
const CHART_ALIASES = { column: 'colunas', columns: 'colunas', stacked: 'empilhado', stacked100: 'empilhado100', bar: 'barras', bars: 'barras', line: 'linha', pie: 'pizza', donut: 'rosca', waterfall: 'cascata' };

function drawChart(b, t, c, X, Y, W, H) {
  const type = CHART_ALIASES[c.type] || c.type || 'colunas';
  const fn = CHARTS[type];
  if (!fn) throw new Error(`Tipo de gráfico desconhecido: ${c.type}. Use: ${Object.keys(CHARTS).join(', ')}.`);
  let y = Y, h = H;
  if (c.title) { b.text(X, Y, W, inch(0.36), [{ text: c.title, size: 1400, bold: true, color: t.muted }]); y += inch(0.45); h -= inch(0.45); }
  fn(b, t, { ...c, type }, X, y, W, h);
}

// ---------- diagramas ----------
const asItems = (arr) => (arr || []).map((x) => (typeof x === 'string' ? { title: x } : x || {}));

function processo(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const steps = asItems(s.steps || s.items).slice(0, 7);
  const n = steps.length;
  if (!n) throw new Error('processo: informe steps[{title, text}].');
  const ch = inch(1.1), d = ch * 0.35, gap = inch(0.06);
  const cw = (W + (n - 1) * (d - gap)) / n;
  const longest = Math.max(0, ...steps.map((st) => String(st.text || '').length + (st.bullets || []).join(' ').length));
  const textH = Math.min(H - ch - inch(0.3), inch(0.5 + (longest / Math.max(1, (cw / EMU) * 10)) * 0.32));
  const y0 = Y + Math.max(0, (H - ch - inch(0.3) - textH) / 2);
  steps.forEach((st, i) => {
    const x = X + i * (cw - d + gap);
    const fill = s.monochrome ? mix(t.accent, t.bg, (i / Math.max(1, n)) * 0.5) : pal(t, i);
    const title = st.title || `${i + 1}`;
    b.shape(i === 0 ? 'homePlate' : 'chevron', x, y0, cw, ch, {
      fill, adj: { adj: 35000 }, inset: 0.05,
      paras: [{ text: title, size: fitSize(title, cw - d * 2 - inch(0.1), n > 5 ? 1400 : 1700, 1000), bold: true, color: ink(fill), align: 'ctr' }],
    });
    const body = [{ text: String(i + 1).padStart(2, '0'), size: 1200, bold: true, color: readable(fill, t) }];
    if (st.text) body.push({ text: st.text, size: n > 5 ? 1300 : 1500, color: t.fg, line: 110000, spaceBefore: 300 });
    for (const bl of st.bullets || []) body.push({ text: bl, size: n > 5 ? 1200 : 1400, bullet: true, color: t.muted, spaceBefore: 400 });
    if (body.length) b.text(x + (i ? d : 0) + inch(0.05), y0 + ch + inch(0.3), cw - d - inch(0.1), H - ch - inch(0.5), body);
  });
}

function linhaDoTempo(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const ev = asItems(s.events || s.items).slice(0, 8);
  const n = ev.length;
  if (!n) throw new Error('linha_do_tempo: informe events[{date, title, text}].');
  const ly = Y + Math.max(inch(1.2), H * 0.38), slot = W / n, dd = inch(0.36);
  b.line(X, ly, X + W, ly, { color: t.muted, w: 28575 });
  ev.forEach((e, i) => {
    const cx = X + slot * (i + 0.5), col = pal(t, i);
    b.shape('ellipse', cx - dd / 2, ly - dd / 2, dd, dd, { fill: col, line: t.bg, lineW: 28575 });
    const date = String(e.date ?? '');
    b.text(cx - slot / 2 + inch(0.05), ly - inch(1.0), slot - inch(0.1), inch(0.65), [{ text: date, size: fitSize(date, slot - inch(0.2), n > 6 ? 1800 : 2400, 1200, 1), bold: true, color: readable(col, t), align: 'ctr' }], { anchor: 'b' });
    b.line(cx, ly + dd / 2, cx, ly + inch(0.38), { color: t.surface, w: 9525 });
    const body = [{ text: e.title || '', size: n > 6 ? 1400 : 1700, bold: true, align: 'ctr' }];
    if (e.text) body.push({ text: e.text, size: n > 6 ? 1200 : 1400, color: t.muted, align: 'ctr', spaceBefore: 500 });
    b.text(cx - slot / 2 + inch(0.06), ly + inch(0.38), slot - inch(0.12), H - inch(1.6), body);
  });
}

function funil(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const st = asItems(s.stages || s.items).slice(0, 7);
  const n = st.length;
  if (!n) throw new Error('funil: informe stages[{label, value}].');
  const fw = W * 0.56, gap = inch(0.08);
  const rowH = Math.min(inch(0.95), (H - gap * (n - 1)) / n);
  const y0 = Y + (H - (rowH * n + gap * (n - 1))) / 2;
  const width = (i) => fw * (1 - (0.6 * i) / n);
  const nums = st.map((x) => Number(String(x.value ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')));
  st.forEach((e, i) => {
    const wT = width(i), wB = width(i + 1), y = y0 + i * (rowH + gap);
    const x = X + (fw - wT) / 2, fill = s.monochrome === false ? pal(t, i) : mix(t.accent, t.bg, (i / n) * 0.55);
    const ss = Math.min(wT, rowH);
    b.shape('trapezoid', x, y, wT, rowH, { fill, flipV: true, adj: { adj: Math.round((((wT - wB) / 2) * 100000) / ss) } });
    const label = e.label || e.title || '';
    b.text(X + (fw - wB) / 2, y, wB, rowH, [{ text: `**${label}**${e.value != null ? `  ${e.value}` : ''}`, size: rowH < inch(0.7) ? 1300 : 1600, color: ink(fill), align: 'ctr' }], { anchor: 'ctr' });
    const side = [];
    if (i > 0 && nums[i] > 0 && nums[i - 1] > 0) side.push({ text: `${fmtNum((nums[i] / nums[i - 1]) * 100, { decimals: 0 })}% da etapa anterior`, size: 1300, bold: true, color: t.accent });
    if (e.text) side.push({ text: e.text, size: 1300, color: t.muted });
    if (side.length) b.text(X + fw + inch(0.4), y, W - fw - inch(0.4), rowH, side, { anchor: 'ctr' });
  });
}

function piramide(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const lv = asItems(s.levels || s.items).slice(0, 6);
  const n = lv.length;
  if (!n) throw new Error('piramide: informe levels[{title, text}] (o primeiro é o topo).');
  const pw = Math.min(W * 0.5, H * 1.2), gap = inch(0.06);
  const rowH = (H - gap * (n - 1)) / n, cx = X + pw / 2;
  const wAt = (y) => (pw * (y - Y)) / H;
  lv.forEach((e, i) => {
    const yT = Y + i * (rowH + gap), wT = wAt(yT), wB = wAt(yT + rowH);
    const fill = s.monochrome === false ? pal(t, i) : mix(t.accent, t.bg, (i / n) * 0.55);
    if (i === 0) b.shape('triangle', cx - wB / 2, yT, wB, rowH, { fill });
    else b.shape('trapezoid', cx - wB / 2, yT, wB, rowH, { fill, adj: { adj: Math.round((((wB - wT) / 2) * 100000) / Math.min(wB, rowH)) } });
    const tw = i === 0 ? wB * 0.62 : wT * 0.92 + (wB - wT) * 0.3;
    const label = e.title || e.label || '';
    b.text(cx - tw / 2, yT + (i === 0 ? rowH * 0.42 : 0), tw, i === 0 ? rowH * 0.58 : rowH, [{ text: label, size: fitSize(label, tw, rowH < inch(0.7) ? 1300 : 1600, 900, i === 0 ? 1 : 2), bold: true, color: ink(fill), align: 'ctr' }], { anchor: 'ctr' });
    if (e.text) {
      const ym = yT + rowH / 2, tx = X + pw + inch(0.5);
      b.line(cx + (wT + wB) / 4 + inch(0.1), ym, tx - inch(0.1), ym, { color: t.muted, w: 9525, dash: 'sysDot' });
      b.text(tx, yT, X + W - tx, rowH, [{ text: e.text, size: 1400 }], { anchor: 'ctr' });
    }
  });
}

function matriz(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const q = asItems(s.quadrants).slice(0, 4);
  while (q.length < 4) q.push({});
  const pts = s.points || [];
  const mh = H - inch(0.5), mw = Math.min(W - inch(0.6), mh * 1.9);
  const mx = X + inch(0.6) + (W - inch(0.6) - mw) / 2, my = Y, gap = inch(0.08);
  const qw = (mw - gap) / 2, qh = (mh - gap) / 2;
  q.forEach((e, i) => {
    const x = mx + (i % 2) * (qw + gap), y = my + Math.floor(i / 2) * (qh + gap);
    const hl = s.highlight === i;
    const fill = hl ? mix(t.accent, t.bg, 0.78) : t.surface;
    b.shape('rect', x, y, qw, qh, { fill });
    const body = [{ text: e.title || '', size: pts.length ? 1300 : 1700, bold: true, color: hl ? t.accent : t.fg }];
    if (!pts.length) {
      if (e.text) body.push({ text: e.text, size: 1300, color: t.muted, spaceBefore: 500 });
      for (const it of e.items || []) body.push({ text: it, size: 1300, bullet: true, spaceBefore: 400 });
    }
    b.text(x + inch(0.2), y + inch(0.15), qw - inch(0.4), qh - inch(0.3), body);
  });
  b.line(mx - inch(0.2), my + mh, mx - inch(0.2), my, { color: t.fg, w: 15875, arrow: 'end' });
  b.line(mx, my + mh + inch(0.2), mx + mw, my + mh + inch(0.2), { color: t.fg, w: 15875, arrow: 'end' });
  if (s.y_label) b.shape('rect', mx - inch(0.45) - mh / 2, my + mh / 2 - inch(0.18), mh, inch(0.36), { rot: 270, inset: 0, paras: [{ text: s.y_label, size: 1300, bold: true, color: t.muted, align: 'ctr' }] });
  if (s.x_label) b.text(mx, my + mh + inch(0.25), mw, inch(0.3), [{ text: s.x_label, size: 1300, bold: true, color: t.muted, align: 'ctr' }]);
  pts.forEach((p, i) => {
    const d = inch(0.32 * (Number(p.size) || 1));
    const px = mx + Math.min(1, Math.max(0, Number(p.x))) * mw, py = my + (1 - Math.min(1, Math.max(0, Number(p.y)))) * mh;
    b.shape('ellipse', px - d / 2, py - d / 2, d, d, { fill: readable(pal(t, i), t), alpha: 0.9 });
    b.text(px + d / 2 + inch(0.05), py - inch(0.15), inch(2.2), inch(0.3), [{ text: p.label || '', size: 1200, bold: true }], { anchor: 'ctr' });
  });
}

function ciclo(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const st = asItems(s.steps || s.items).slice(0, 8);
  const n = st.length;
  if (n < 2) throw new Error('ciclo: informe pelo menos 2 steps.');
  const cw = inch(n > 5 ? 2.0 : 2.4), chh = inch(n > 5 ? 0.85 : 1.0);
  const cx = X + W / 2, cy = Y + H / 2;
  const rx = Math.min(W / 2 - cw / 2, (H / 2 - chh / 2) * 1.8), ry = H / 2 - chh / 2;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const at = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  const inside = ([x, y], i) => { const [ox, oy] = at(ang(i)); return Math.abs(x - ox) < cw / 2 + inch(0.08) && Math.abs(y - oy) < chh / 2 + inch(0.08); };
  // setas curvas ao longo da elipse, de um cartão ao próximo
  for (let i = 0; i < n; i++) {
    const a0 = ang(i), a1 = ang(i) + (2 * Math.PI) / n, pts = [];
    for (let k = 0; k <= 40; k++) { const p = at(a0 + ((a1 - a0) * k) / 40); if (!inside(p, i) && !inside(p, (i + 1) % n)) pts.push(p); }
    if (pts.length > 1) b.path(pts, { color: t.muted, w: 19050, arrow: 'end' });
  }
  if (s.center) {
    const d = Math.min(rx, ry) * 0.9;
    b.shape('ellipse', cx - d / 2, cy - d / 2, d, d, { fill: t.surface, inset: 0.02, paras: [{ text: s.center, size: fitSize(s.center, d * 0.72, 1800, 1000), bold: true, align: 'ctr' }] });
  }
  st.forEach((e, i) => {
    const [x, y] = at(ang(i)), fill = pal(t, i);
    const body = [{ text: e.title || '', size: 1400, bold: true, color: ink(fill), align: 'ctr' }];
    if (e.text) body.push({ text: e.text, size: 1100, color: ink(fill), align: 'ctr' });
    b.shape('roundRect', x - cw / 2, y - chh / 2, cw, chh, { fill, adj: { adj: 20000 }, paras: body, inset: 0.06 });
  });
}

function cartoes(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const it = asItems(s.cards || s.items).slice(0, 8);
  const n = it.length;
  if (!n) throw new Error('cartoes: informe cards[{title, text, icon?}].');
  const cols = n <= 4 ? n : n <= 6 ? 3 : 4, rows = Math.ceil(n / cols), gap = inch(0.25);
  const cw = (W - gap * (cols - 1)) / cols;
  const longest = Math.max(0, ...it.map((e) => String(e.text || '').length));
  const need = inch(1.55 + (longest / Math.max(1, (cw / EMU) * 9)) * 0.3);
  const ch = Math.min((H - gap * (rows - 1)) / rows, Math.max(inch(2.7), need));
  const y0 = Y + (H - (ch * rows + gap * (rows - 1))) / 2;
  it.forEach((e, i) => {
    const x = X + (i % cols) * (cw + gap), y = y0 + Math.floor(i / cols) * (ch + gap), col = pal(t, i);
    b.shape('roundRect', x, y, cw, ch, { fill: t.surface, adj: { adj: 6000 } });
    b.shape('rect', x, y + inch(0.25), inch(0.07), inch(0.55), { fill: col });
    let ty = y + inch(0.25);
    if (e.value != null) {
      b.text(x + inch(0.3), ty, cw - inch(0.5), inch(0.7), [{ text: compact(e.value, s.prefix), size: fitSize(String(e.value), cw - inch(0.5), 3200, 1800, 1), bold: true, color: readable(col, t) }], { anchor: 'ctr' });
      ty += inch(0.85);
    } else {
      const d = inch(0.55);
      b.shape('ellipse', x + inch(0.3), ty, d, d, { fill: col, inset: 0, paras: [{ text: e.icon || String(i + 1), size: e.icon ? 1800 : 1600, bold: true, color: ink(col), align: 'ctr' }] });
      ty += d + inch(0.2);
    }
    const body = [{ text: e.title || '', size: fitSize(e.title, cw - inch(0.55), rows > 1 ? 1600 : 1900, 1200), bold: true }];
    if (e.text) body.push({ text: e.text, size: rows > 1 ? 1300 : 1500, color: t.muted, spaceBefore: 500, line: 110000 });
    b.text(x + inch(0.3), ty, cw - inch(0.55), y + ch - ty - inch(0.15), body);
  });
}

function hub(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const it = asItems(s.items || s.spokes).slice(0, 8);
  const n = it.length;
  if (!n) throw new Error('hub: informe center e items[{title, text}].');
  const cw = inch(2.5), chh = inch(0.95);
  const cx = X + W / 2, cy = Y + H / 2, rx = W / 2 - cw / 2, ry = H / 2 - chh / 2;
  const d = Math.min(H * 0.38, inch(2.0));
  const pos = it.map((_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
  pos.forEach(([x, y]) => b.line(cx, cy, x, y, { color: t.muted, w: 15875 }));
  b.shape('ellipse', cx - d / 2, cy - d / 2, d, d, { fill: t.accent, inset: 0.02, paras: [{ text: s.center || '', size: fitSize(s.center, d * 0.72, 1800, 1000), bold: true, color: ink(t.accent), align: 'ctr' }] });
  it.forEach((e, i) => {
    const [x, y] = pos[i];
    const body = [{ text: e.title || '', size: 1400, bold: true, align: 'ctr' }];
    if (e.text) body.push({ text: e.text, size: 1100, color: t.muted, align: 'ctr' });
    b.shape('roundRect', x - cw / 2, y - chh / 2, cw, chh, { fill: t.surface, line: pal(t, i), lineW: 22225, adj: { adj: 18000 }, paras: body, inset: 0.06 });
  });
}

function venn(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const sets = asItems(s.sets || s.items).slice(0, 3);
  const vcol = (i) => (i === 0 ? t.accent : pal(t, i + 1));
  const n = sets.length;
  if (n < 2) throw new Error('venn: informe 2 ou 3 sets[{title, text}].');
  const D = Math.min(H * (n === 3 ? 0.66 : 0.9), W * 0.42);
  const cx = X + W / 2, cy = Y + H / 2;
  const centers = n === 2 ? [[cx - D * 0.3, cy], [cx + D * 0.3, cy]]
    : [[cx - D * 0.3, cy - D * 0.2], [cx + D * 0.3, cy - D * 0.2], [cx, cy + D * 0.32]];
  centers.forEach(([x, y], i) => b.shape('ellipse', x - D / 2, y - D / 2, D, D, { fill: vcol(i), alpha: 0.28, line: vcol(i), lineW: 19050 }));
  centers.forEach(([x, y], i) => {
    const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1;
    const lx = x + (dx / len) * D * 0.18, ly = y + (dy / len) * D * 0.18;
    const body = [{ text: sets[i].title || '', size: 1600, bold: true, align: 'ctr' }];
    if (sets[i].text) body.push({ text: sets[i].text, size: 1200, color: t.muted, align: 'ctr' });
    b.text(lx - D * 0.3, ly - D * 0.2, D * 0.6, D * 0.4, body, { anchor: 'ctr' });
  });
  if (s.center) b.text(cx - inch(0.9), cy - (n === 3 ? 0 : inch(0.3)), inch(1.8), inch(0.6), [{ text: s.center, size: 1400, bold: true, color: t.accent, align: 'ctr' }], { anchor: 'ctr' });
}

function tabela(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const headers = (s.headers || []).map(String);
  const rows = (s.rows || []).map((r) => (Array.isArray(r) ? r : [r]).map((c) => String(c ?? '')));
  const cols = Math.max(headers.length, ...rows.map((r) => r.length));
  if (!cols || !rows.length) throw new Error('tabela: informe headers[] e rows[[...]].');
  const len = (j) => Math.max(4, headers[j] ? headers[j].length : 0, ...rows.map((r) => (r[j] || '').length));
  const weights = Array.from({ length: cols }, (_, j) => Math.min(40, len(j)));
  const sum = weights.reduce((a, v) => a + v, 0);
  const widths = weights.map((v) => Math.round((W * v) / sum));
  const nr = rows.length + (headers.length ? 1 : 0);
  const rowH = Math.min(inch(0.55), Math.floor(H / nr));
  const fs = nr > 12 ? 1050 : nr > 8 ? 1200 : 1400;
  const num = (c) => /^[\s\-+−]?[R$€US\s]*[\d.,]+\s*(%|x|mi|bi|mil|k|pp)?$/i.test(c.trim());
  const grid = [];
  if (headers.length) grid.push(Array.from({ length: cols }, (_, j) => ({ text: headers[j] || '', bold: true, fill: t.accent, color: ink(t.accent), size: fs, align: j && rows.every((r) => num(r[j] || '0')) ? 'r' : 'l' })));
  rows.forEach((r, i) => grid.push(Array.from({ length: cols }, (_, j) => {
    const hl = s.highlight_row === i || s.highlight_col === j;
    const c = r[j] || '';
    return { text: c, bold: j === 0 || s.highlight_row === i, size: fs, color: t.fg, align: j && num(c) ? 'r' : 'l',
      fill: hl ? mix(t.accent, t.bg, 0.8) : i % 2 ? t.surface : t.bg };
  })));
  b.table(X, Y, widths, rowH, grid, t.muted);
}

function agenda(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const it = asItems(s.items || s.bullets).slice(0, 10);
  const n = it.length;
  if (!n) throw new Error('agenda: informe items[].');
  const cols = n > 5 ? 2 : 1, per = Math.ceil(n / cols), gap = inch(0.5);
  const cw = (W - gap * (cols - 1)) / cols, rh = Math.min(inch(1.0), H / per);
  it.forEach((e, i) => {
    const x = X + Math.floor(i / per) * (cw + gap), y = Y + (i % per) * rh;
    const cur = s.current === i;
    b.text(x, y, inch(1.0), rh, [{ text: String(i + 1).padStart(2, '0'), size: 2800, bold: true, color: cur ? t.accent : t.muted }], { anchor: 'ctr' });
    const body = [{ text: e.title || '', size: 2000, bold: true, color: cur ? t.accent : t.fg }];
    if (e.text) body.push({ text: e.text, size: 1300, color: t.muted });
    b.text(x + inch(1.05), y, cw - inch(1.05), rh, body, { anchor: 'ctr' });
    if (i % per < per - 1 && i < n - 1) b.line(x + inch(1.05), y + rh, x + cw, y + rh, { color: t.surface, w: 9525 });
  });
}

// Tamanho de mercado (TAM/SAM/SOM): círculos concêntricos apoiados na base, do maior para o menor.
function mercado(b, t, s, { x: X, y: Y, w: W, h: H }) {
  const lv = asItems(s.levels || s.items).slice(0, 4);
  const n = lv.length;
  if (!n) throw new Error('mercado: informe levels[{label, value, text}] do maior (TAM) para o menor (SOM).');
  const D0 = Math.min(H, W * 0.5), k = n > 3 ? 0.7 : 0.66;
  const ds = lv.map((_, i) => D0 * Math.pow(k, i));
  const cx = X + D0 / 2, bottom = Y + H;
  const fillOf = (i) => mix(t.accent, t.bg, 0.78 - (0.62 * i) / Math.max(1, n - 1));
  lv.forEach((e, i) => b.shape('ellipse', cx - ds[i] / 2, bottom - ds[i], ds[i], ds[i], { fill: fillOf(i), line: t.bg, lineW: 19050 }));
  lv.forEach((e, i) => {
    const d = ds[i], fill = fillOf(i), top = bottom - d, last = i === n - 1;
    const band = last ? d : d - ds[i + 1];
    const ty = last ? top + d / 2 - inch(0.45) : top + inch(0.08);
    const th = last ? inch(0.9) : Math.max(inch(0.5), band - inch(0.1));
    const tw = last ? d * 0.85 : d * 0.55;
    const label = e.label || e.title || '';
    const value = compact(e.value, s.prefix);
    b.text(cx - tw / 2, ty, tw, th, [
      { text: value, size: fitSize(value, tw, last ? 2000 : 2200, 1000, 1), bold: true, color: ink(fill), align: 'ctr' },
      { text: label, size: fitSize(label, tw, 1300, 900, 1), color: ink(fill), align: 'ctr' },
    ], { anchor: last ? 'ctr' : 't' });
    if (e.text) {
      const ym = last ? top + d / 2 : top + band / 2, tx = X + D0 + inch(0.6);
      b.line(cx + (last ? d / 2 : tw / 2) + inch(0.1), ym, tx - inch(0.1), ym, { color: t.muted, w: 9525, dash: 'sysDot' });
      b.text(tx, ym - inch(0.4), X + W - tx, inch(0.8), [{ text: `**${label}**  ${e.text}`, size: 1400 }], { anchor: 'ctr' });
    }
  });
}

const DIAGRAMS = { processo, linha_do_tempo: linhaDoTempo, funil, piramide, matriz, ciclo, cartoes, hub, venn, tabela, agenda, mercado };
const DIAGRAM_ALIASES = { market: 'mercado', tam: 'mercado', tam_sam_som: 'mercado', process: 'processo', timeline: 'linha_do_tempo', funnel: 'funil', pyramid: 'piramide', matrix: 'matriz', cycle: 'ciclo', cards: 'cartoes', table: 'tabela', chart: 'grafico' };

// Slide "grafico": um ou dois gráficos, com painel de destaques opcional à direita.
function grafico(b, t, s, box) {
  const charts = Array.isArray(s.charts) && s.charts.length ? s.charts.slice(0, 2) : [s.chart || s];
  const side = s.insights || s.bullets;
  let { x, y, w, h } = box;
  if (side && side.length) {
    const pw = w * 0.34, px = x + w - pw;
    b.shape('roundRect', px, y, pw, h, { fill: t.surface, adj: { adj: 5000 } });
    const paras = [{ text: s.insights_title || 'Destaques', size: 1500, bold: true, color: t.accent }];
    side.forEach((it) => paras.push({ text: it, size: side.join('').length > 260 ? 1300 : 1500, bullet: true, spaceBefore: 900 }));
    b.text(px + inch(0.3), y + inch(0.3), pw - inch(0.55), h - inch(0.5), paras);
    w -= pw + inch(0.4);
  }
  const gap = inch(0.5), cw = (w - gap * (charts.length - 1)) / charts.length;
  charts.forEach((c, i) => drawChart(b, t, c, x + i * (cw + gap), y, cw, h));
}

const VISUALS = { grafico, ...DIAGRAMS };
const visualType = (type) => {
  const k = DIAGRAM_ALIASES[type] || type;
  return VISUALS[k] ? k : null;
};

module.exports = { VISUALS, visualType, drawChart, fmtNum, mix, ink, luminance };
