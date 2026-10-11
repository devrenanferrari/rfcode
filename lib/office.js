'use strict';
// Documentos do Office sem dependências: gera .pptx (slides com design pronto) e .docx (a partir de markdown),
// e extrai texto de .docx, .pptx, .xlsx, .odt/.odp e .pdf para o agente ler.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { createZip, readZip } = require('./zip');
const { VISUALS, visualType, mix } = require('./pptx-visuals');
const { parseLoose } = require('./jsonfix');

const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // remove caracteres de controle que o XML não aceita
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---------- imagens ----------
function imageInfo(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(1, 4).toString() === 'PNG') return { buf, ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.slice(0, 3).toString() === 'GIF') return { buf, ext: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const marker = buf[p + 1];
      const len = buf.readUInt16BE(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { buf, ext: 'jpeg', w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5) };
      }
      p += 2 + len;
    }
  }
  throw new Error(`Formato de imagem não suportado (use PNG, JPG ou GIF): ${file}`);
}

// Encaixa (w,h) dentro de (bw,bh) mantendo a proporção; devolve { w, h, dx, dy } centralizado.
function fit(w, h, bw, bh) {
  const k = Math.min(bw / w, bh / h);
  const W = Math.round(w * k), H = Math.round(h * k);
  return { w: W, h: H, dx: Math.round((bw - W) / 2), dy: Math.round((bh - H) / 2) };
}

// ---------- PPTX ----------
const EMU = 914400; // por polegada
const SW = 12192000, SH = 6858000; // 16:9 (13,333 x 7,5 pol)
const inch = (v) => Math.round(v * EMU);

const THEMES = {
  escuro: { bg: '0F1115', fg: 'F5F7FA', muted: '9AA3AF', accent: '76B900', surface: '1B1F27' },
  claro: { bg: 'FFFFFF', fg: '111827', muted: '6B7280', accent: '2563EB', surface: 'F1F4F8' },
  azul: { bg: '0B1F3A', fg: 'FFFFFF', muted: 'A9B8D0', accent: '38BDF8', surface: '12305A' },
  terra: { bg: 'FAF7F2', fg: '2B2118', muted: '7C6F64', accent: 'C2410C', surface: 'EFE7DB' },
  roxo: { bg: '16112A', fg: 'F4F1FF', muted: 'A79FC7', accent: 'A78BFA', surface: '231B40' },
  // estilo consultoria (think-cell): fundo branco, tons de azul-marinho
  consultoria: { bg: 'FFFFFF', fg: '0B1F3A', muted: '64748B', accent: '0B3D91', surface: 'EEF2F7' },
  // estilo Napkin: papel claro, cores vivas
  papel: { bg: 'FBF8F1', fg: '1F2937', muted: '6B7280', accent: 'F97316', surface: 'F1ECE0' },
};
// cores para séries e diagramas, combinando com o fundo de cada tema
const PALETTES = {
  escuro: ['76B900', '38BDF8', 'F59E0B', 'F472B6', 'A78BFA', '2DD4BF'],
  claro: ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6', '14B8A6'],
  azul: ['38BDF8', 'FBBF24', '34D399', 'F472B6', 'A78BFA', 'FB923C'],
  terra: ['C2410C', '0F766E', 'B45309', '6D28D9', 'BE123C', '4D7C0F'],
  roxo: ['A78BFA', 'F472B6', '38BDF8', 'FBBF24', '34D399', 'FB923C'],
  consultoria: ['0B3D91', '5B8DEF', 'A7C4F2', 'F2A900', '7A869A', 'D64545'],
  papel: ['F97316', '3B82F6', '10B981', 'EAB308', 'EC4899', '8B5CF6'],
};

const hex = (c, fallback) => {
  const v = String(c || '').replace('#', '').trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(v) ? v : fallback;
};
const luminance = (h) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// **negrito** vira runs separados
function runs(text, { size, color, bold = false, italic = false, font }) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter((x) => x !== '');
  if (!parts.length) parts.push('');
  return parts.map((part) => {
    const b = bold || /^\*\*[^*]+\*\*$/.test(part);
    const t = part.replace(/^\*\*([^*]+)\*\*$/, '$1');
    return `<a:r><a:rPr lang="pt-BR" sz="${size}"${b ? ' b="1"' : ''}${italic ? ' i="1"' : ''} dirty="0">`
      + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${font ? `<a:latin typeface="${xmlEsc(font)}"/>` : ''}</a:rPr>`
      + `<a:t>${xmlEsc(t)}</a:t></a:r>`;
  }).join('');
}

function lnXml(color, w, dash, arrow) {
  if (!color) return '<a:ln><a:noFill/></a:ln>';
  const end = (k) => (arrow === k || arrow === 'both' ? `<a:${k === 'end' ? 'tail' : 'head'}End type="triangle" w="med" len="med"/>` : '');
  return `<a:ln w="${Math.round(w)}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${dash ? `<a:prstDash val="${dash}"/>` : ''}${end('start')}${end('end')}</a:ln>`;
}

const R = Math.round;
class SlideBuilder {
  constructor(theme) { this.t = theme; this.shapes = []; this.id = 2; this.images = []; }
  nextId() { return this.id++; }
  xfrm(x, y, w, h, { rot, flipH, flipV } = {}) {
    return `<a:xfrm${rot ? ` rot="${R(rot * 60000)}"` : ''}${flipH ? ' flipH="1"' : ''}${flipV ? ' flipV="1"' : ''}>`
      + `<a:off x="${R(x)}" y="${R(y)}"/><a:ext cx="${Math.max(0, R(w))}" cy="${Math.max(0, R(h))}"/></a:xfrm>`;
  }
  rect(x, y, w, h, color, { round = 0 } = {}) {
    this.shape(round ? 'roundRect' : 'rect', x, y, w, h, { fill: color, adj: round ? { adj: round } : {} });
  }
  // paras: [{ text, size, color, bold, italic, bullet, level, align, spaceBefore }]
  paras(paras, font) {
    if (!paras || !paras.length) return '<a:p><a:endParaRPr lang="pt-BR" dirty="0"/></a:p>';
    return paras.map((p) => {
      const lvl = p.level || 0;
      const bullet = p.bullet
        ? `<a:buClr><a:srgbClr val="${this.t.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${lvl ? '–' : '•'}"/>`
        : '<a:buNone/>';
      const mar = p.bullet ? ` marL="${inch(0.32 + lvl * 0.4)}" indent="${-inch(0.32)}"` : '';
      return `<a:p><a:pPr algn="${p.align || 'l'}"${mar}><a:lnSpc><a:spcPct val="${p.line || 105000}"/></a:lnSpc>`
        + `<a:spcBef><a:spcPts val="${p.spaceBefore ?? 0}"/></a:spcBef>${bullet}</a:pPr>`
        + runs(p.text, { size: p.size, color: p.color || this.t.fg, bold: p.bold, italic: p.italic, font: p.font || font })
        + `<a:endParaRPr lang="pt-BR" sz="${p.size}" dirty="0"/></a:p>`;
    }).join('');
  }
  text(x, y, w, h, paras, { anchor = 't', font } = {}) {
    const id = this.nextId();
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Texto ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr>${this.xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
      + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${this.paras(paras, font)}</p:txBody></p:sp>`);
  }
  // forma pronta do PowerPoint (rect, roundRect, ellipse, chevron, homePlate, trapezoid, triangle, pie...), com texto opcional
  shape(prst, x, y, w, h, { fill, line, lineW = 12700, dash, alpha, adj = {}, paras, anchor = 'ctr', inset = 0.08, rot, flipH, flipV, font } = {}) {
    const id = this.nextId();
    const av = Object.entries(adj).map(([k, v]) => `<a:gd name="${k}" fmla="val ${R(v)}"/>`).join('');
    const fillX = fill ? `<a:solidFill><a:srgbClr val="${fill}">${alpha != null ? `<a:alpha val="${R(alpha * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>` : '<a:noFill/>';
    const ins = inch(inset);
    const tx = paras ? `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${this.paras(paras, font)}</p:txBody>` : '';
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Forma ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${this.xfrm(x, y, w, h, { rot, flipH, flipV })}`
      + `<a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom>${fillX}${lnXml(line, lineW, dash)}</p:spPr>${tx}</p:sp>`);
  }
  // linha reta; arrow: 'end' | 'start' | 'both'
  line(x1, y1, x2, y2, { color, w = 12700, dash, arrow } = {}) {
    const id = this.nextId();
    this.shapes.push(`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Linha ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>`
      + this.xfrm(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), { flipH: x2 < x1, flipV: y2 < y1 })
      + `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${lnXml(color || this.t.muted, w, dash, arrow)}</p:spPr></p:cxnSp>`);
  }
  // linha com vários pontos (gráfico de linha, setas em cotovelo ou curvas)
  path(points, { color, w = 12700, dash, arrow, fill, closed } = {}) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const W = Math.max(1, R(Math.max(...xs) - x0)), H = Math.max(1, R(Math.max(...ys) - y0));
    const pt = ([x, y]) => `<a:pt x="${R(x - x0)}" y="${R(y - y0)}"/>`;
    const d = `<a:moveTo>${pt(points[0])}</a:moveTo>` + points.slice(1).map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`).join('') + (closed ? '<a:close/>' : '');
    const id = this.nextId();
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Caminho ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${this.xfrm(x0, y0, W, H)}`
      + `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}"${fill ? '' : ' fill="none"'}>${d}</a:path></a:pathLst></a:custGeom>`
      + `${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>'}${lnXml(color || this.t.fg, w, dash, arrow)}</p:spPr></p:sp>`);
  }
  // tabela nativa (editável). grid: linhas de células { text, bold, fill, color, size, align }
  table(x, y, widths, rowH, grid, lineColor) {
    const id = this.nextId();
    const W = widths.reduce((a, v) => a + v, 0);
    const cell = (c) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${c.align || 'l'}"/>`
      + runs(c.text, { size: c.size, color: c.color || this.t.fg, bold: c.bold }) + `<a:endParaRPr lang="pt-BR" sz="${c.size}" dirty="0"/></a:p></a:txBody>`
      + `<a:tcPr marL="${inch(0.1)}" marR="${inch(0.1)}" marT="${inch(0.04)}" marB="${inch(0.04)}" anchor="ctr">`
      + '<a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="0"><a:noFill/></a:lnT>'
      + `<a:lnB w="6350"><a:solidFill><a:srgbClr val="${lineColor}"/></a:solidFill></a:lnB>`
      + `${c.fill ? `<a:solidFill><a:srgbClr val="${c.fill}"/></a:solidFill>` : '<a:noFill/>'}</a:tcPr></a:tc>`;
    this.shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Tabela ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
      + `<p:xfrm><a:off x="${R(x)}" y="${R(y)}"/><a:ext cx="${R(W)}" cy="${R(rowH * grid.length)}"/></p:xfrm>`
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>'
      + `<a:tblGrid>${widths.map((w) => `<a:gridCol w="${R(w)}"/>`).join('')}</a:tblGrid>`
      + grid.map((row) => `<a:tr h="${R(rowH)}">${row.map(cell).join('')}</a:tr>`).join('')
      + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>');
  }
  image(file, x, y, bw, bh) {
    const info = imageInfo(file);
    const f = fit(info.w, info.h, bw, bh);
    const rid = `rId${this.images.length + 2}`;
    this.images.push({ rid, ...info });
    const id = this.nextId();
    this.shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Imagem ${id}" descr="${xmlEsc(path.basename(file))}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
      + `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
      + `<p:spPr><a:xfrm><a:off x="${x + f.dx}" y="${y + f.dy}"/><a:ext cx="${f.w}" cy="${f.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`);
  }
  xml(bg) {
    return XML_HEAD + `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>`
      + `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      + '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
      + this.shapes.join('') + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }
}

// Tamanho da fonte dos tópicos conforme a quantidade de texto (PowerPoint só reduz sozinho ao editar).
function bulletSize(items, base = 2400) {
  const chars = items.reduce((s, x) => s + String(x).length, 0);
  const n = items.length;
  if (n <= 3 && chars < 200) return base + 400; // poucos tópicos: fonte maior ocupa melhor o slide
  if (n <= 4 && chars < 220) return base;
  if (n <= 6 && chars < 380) return base - 400;
  if (n <= 8 && chars < 560) return base - 600;
  return base - 800;
}

function bulletParas(items, size, t, spaceBefore = 900) {
  return (items || []).map((raw) => {
    const s = String(raw);
    const level = /^(\s{2,}|\t)/.test(s) ? 1 : 0;
    return { text: s.trim().replace(/^[-*•]\s+/, ''), bullet: true, level, size: level ? size - 300 : size, color: level ? t.muted : t.fg, spaceBefore };
  });
}

const MX = inch(0.75); // margem lateral
const CW = SW - 2 * MX;

function addTitle(b, t, title) {
  // títulos de ação (frase com a conclusão) são longos: a fonte diminui para caber em duas linhas
  const size = title.length > 90 ? 2200 : title.length > 64 ? 2600 : title.length > 48 ? 3000 : 3600;
  b.text(MX, inch(0.45), CW, inch(1.05), [{ text: title, size, bold: true }], { anchor: 'b' });
  b.rect(MX, inch(1.62), inch(0.9), inch(0.07), t.accent);
}

function addFooter(b, t, n, total, footer) {
  if (footer) b.text(MX, SH - inch(0.55), inch(8), inch(0.3), [{ text: footer, size: 1100, color: t.muted }]);
  b.text(SW - MX - inch(1.5), SH - inch(0.55), inch(1.5), inch(0.3), [{ text: `${n} / ${total}`, size: 1100, color: t.muted, align: 'r' }]);
}

function buildSlide(s, t, n, total, opts, baseDir) {
  const b = new SlideBuilder(t);
  const type = visualType(s.type) || s.type || (n === 1 ? 'capa' : 'topicos');
  const resolveImg = (p) => path.resolve(baseDir, p);
  let bg = t.bg;
  const content = !['capa', 'secao', 'encerramento'].includes(type);
  // a mensagem principal (takeaway) e a fonte ocupam o rodapé do conteúdo
  const takeaway = content && s.takeaway ? String(s.takeaway) : '';
  const source = content && s.source ? String(s.source) : '';
  const top = inch(2.0);
  const tkH = takeaway.length > 100 ? inch(0.85) : inch(0.6); // duas linhas quando a conclusão é longa
  const bodyH = SH - top - inch(0.9) - (takeaway ? tkH + inch(0.25) : 0) - (source && !takeaway ? inch(0.2) : 0);

  if (type === 'capa' || type === 'encerramento') {
    const center = type === 'encerramento';
    b.rect(0, SH - inch(0.18), SW, inch(0.18), t.accent);
    if (!center) b.rect(MX, inch(2.35), inch(0.12), inch(2.3), t.accent);
    const x = center ? MX : MX + inch(0.45);
    const w = center ? CW : CW - inch(0.45);
    b.text(x, inch(1.6), w, inch(2.0), [{ text: s.title || opts.title || '', size: (s.title || '').length > 40 ? 4400 : 5400, bold: true, align: center ? 'ctr' : 'l', line: 95000 }], { anchor: 'b' });
    if (s.subtitle) b.text(x, inch(3.75), w, inch(1.2), [{ text: s.subtitle, size: 2200, color: t.muted, align: center ? 'ctr' : 'l' }]);
    const meta = [s.author || opts.author, s.date || opts.date].filter(Boolean).join('  ·  ');
    if (meta) b.text(x, SH - inch(1.25), w, inch(0.4), [{ text: meta, size: 1400, color: t.muted, align: center ? 'ctr' : 'l' }]);
  } else if (type === 'secao') {
    bg = t.accent;
    const ink = luminance(t.accent) > 0.55 ? '111111' : 'FFFFFF';
    if (s.number != null) b.text(MX, inch(1.6), CW, inch(1.3), [{ text: String(s.number).padStart(2, '0'), size: 7200, bold: true, color: ink }], { anchor: 'b' });
    b.text(MX, inch(3.0), CW, inch(1.6), [{ text: s.title || '', size: 4400, bold: true, color: ink }]);
    if (s.subtitle) b.text(MX, inch(4.5), CW, inch(1), [{ text: s.subtitle, size: 2000, color: ink }]);
  } else if (type === 'duas_colunas') {
    addTitle(b, t, s.title || '');
    const cols = (s.columns || [s.left || [], s.right || []]).slice(0, 2);
    const heads = s.column_titles || [];
    const gap = inch(0.35), w = (CW - gap) / 2;
    const size = bulletSize(cols.reduce((m, c) => ((c || []).join('').length > m.join('').length ? c : m), []), 2200);
    cols.forEach((items, i) => {
      const x = MX + i * (w + gap);
      b.rect(x, top, w, bodyH, t.surface, { round: 4000 });
      const paras = [];
      if (heads[i]) paras.push({ text: heads[i], size: 2000, bold: true, color: t.accent });
      paras.push(...bulletParas(items, size, t, 700));
      b.text(x + inch(0.35), top + inch(0.3), w - inch(0.7), bodyH - inch(0.6), paras);
    });
  } else if (type === 'imagem') {
    addTitle(b, t, s.title || '');
    const items = s.bullets || [];
    if (items.length) {
      const iw = Math.round(CW * 0.55);
      b.image(resolveImg(s.image), MX, top, iw, bodyH);
      b.text(MX + iw + inch(0.4), top, CW - iw - inch(0.4), bodyH, bulletParas(items, bulletSize(items, 2000), t), { anchor: 'ctr' });
    } else {
      b.image(resolveImg(s.image), MX, top, CW, bodyH - (s.caption ? inch(0.5) : 0));
    }
    if (s.caption) b.text(MX, SH - inch(1.25), CW, inch(0.4), [{ text: s.caption, size: 1300, color: t.muted, align: items.length ? 'l' : 'ctr', italic: true }]);
  } else if (type === 'citacao') {
    b.text(MX, inch(0.9), inch(2), inch(1.6), [{ text: '“', size: 16000, bold: true, color: t.accent }]);
    b.text(MX + inch(0.6), inch(2.2), CW - inch(1.2), inch(2.8), [{ text: s.quote || s.title || '', size: (s.quote || '').length > 160 ? 2600 : 3200, italic: true }], { anchor: 'ctr' });
    if (s.author) b.text(MX + inch(0.6), inch(5.2), CW - inch(1.2), inch(0.5), [{ text: '— ' + s.author, size: 1800, color: t.muted }]);
  } else if (type === 'numeros') {
    addTitle(b, t, s.title || '');
    const stats = (s.stats || []).slice(0, 4);
    const gap = inch(0.3), k = Math.max(1, stats.length), w = (CW - gap * (k - 1)) / k;
    // a fonte do número encolhe para caber numa linha do cartão
    const longest = Math.max(1, ...stats.map((st) => String(st.value ?? '').length));
    const statSize = Math.max(2400, Math.min(k > 3 ? 4400 : 5400, Math.floor(((w - inch(0.6)) / EMU) * 72 * 100 / (longest * 0.6))));
    stats.forEach((st, i) => {
      const x = MX + i * (w + gap);
      b.rect(x, top + inch(0.4), w, Math.min(inch(3.2), bodyH - inch(0.45)), t.surface, { round: 5000 });
      b.text(x + inch(0.3), top + inch(0.8), w - inch(0.6), inch(1.4), [{ text: String(st.value ?? ''), size: statSize, bold: true, color: t.accent }], { anchor: 'b' });
      let ly = top + inch(2.35);
      if (st.delta != null && st.delta !== '') {
        // variação: ▲ verde para alta, ▼ vermelho para queda (good diz se a variação é boa: custo caindo é bom)
        const d = String(st.delta).trim();
        const down = /^[-−▼]/.test(d);
        const good = st.good != null ? !!st.good : !down;
        b.text(x + inch(0.3), ly, w - inch(0.6), inch(0.4), [{ text: `${down ? '▼' : '▲'} ${d.replace(/^[▲▼]\s*/, '')}`, size: 1500, bold: true, color: good ? t.up : t.down }]);
        ly += inch(0.45);
      }
      b.text(x + inch(0.3), ly, w - inch(0.6), inch(0.9), [{ text: String(st.label ?? ''), size: 1600, color: t.muted }]);
    });
    if (s.note && !takeaway) b.text(MX, SH - inch(1.3), CW, inch(0.5), [{ text: s.note, size: 1400, color: t.muted }]);
  } else if (VISUALS[type]) {
    addTitle(b, t, s.title || '');
    VISUALS[type](b, t, s, { x: MX, y: top, w: CW, h: bodyH });
  } else { // topicos
    addTitle(b, t, s.title || '');
    const items = s.bullets || (s.text ? [s.text] : []);
    const paras = s.text && !s.bullets
      ? [{ text: s.text, size: s.text.length > 400 ? 1800 : 2200, line: 120000 }]
      : bulletParas(items, bulletSize(items), t);
    b.text(MX, top, CW, bodyH, paras);
  }
  if (takeaway) {
    // barra com a conclusão do slide, como nos decks de consultoria
    const y = top + bodyH + inch(0.2), h = tkH;
    b.shape('rect', MX, y, CW, h, { fill: mix(t.accent, t.bg, 0.85) });
    b.shape('rect', MX, y, inch(0.08), h, { fill: t.accent });
    b.text(MX + inch(0.3), y, CW - inch(0.5), h, [{ text: takeaway, size: takeaway.length > 100 ? 1400 : 1600, bold: true }], { anchor: 'ctr' });
  }
  if (source) b.text(MX, SH - inch(0.82), CW - inch(1.8), inch(0.28), [{ text: `Fonte: ${source.replace(/^fonte:\s*/i, '')}`, size: 1000, color: t.muted }], { anchor: 'b' });
  if (content) addFooter(b, t, n, total, source ? '' : opts.footer);
  return { xml: b.xml(bg), images: b.images, notes: s.notes ? String(s.notes) : '' };
}

const pptxStatic = {
  presProps: XML_HEAD + `<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`,
  viewProps: XML_HEAD + `<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
  tableStyles: XML_HEAD + `<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  layout: XML_HEAD + `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Em branco"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  layoutRels: XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  masterRels: XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
};

function masterXml() {
  return XML_HEAD + `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>`
    + '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>'
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';
}

const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function notesMasterXml() {
  return XML_HEAD + `<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Imagem do slide"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Anotações"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="pt-BR"/></a:p></p:txBody></p:sp></p:spTree></p:cSld>'
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>';
}

function notesSlideXml(text) {
  const paras = String(text).split(/\n+/).map((p) => `<a:p><a:r><a:rPr lang="pt-BR" dirty="0"/><a:t>${xmlEsc(p)}</a:t></a:r></a:p>`).join('');
  return XML_HEAD + `<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${GRP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Imagem do slide"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Anotações"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

function themeXml(t, font) {
  const c = (name, val) => `<a:${name}><a:srgbClr val="${val}"/></a:${name}>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return XML_HEAD + `<a:theme xmlns:a="${NS_A}" name="rfcode"><a:themeElements><a:clrScheme name="rfcode">`
    + c('dk1', '000000') + c('lt1', 'FFFFFF') + c('dk2', t.fg) + c('lt2', t.bg)
    + c('accent1', t.accent) + c('accent2', '2563EB') + c('accent3', 'F59E0B') + c('accent4', 'EF4444') + c('accent5', '8B5CF6') + c('accent6', '14B8A6')
    + c('hlink', '2563EB') + c('folHlink', '7C3AED') + '</a:clrScheme>'
    + `<a:fontScheme name="rfcode"><a:majorFont><a:latin typeface="${xmlEsc(font)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>`
    + `<a:minorFont><a:latin typeface="${xmlEsc(font)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="rfcode"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>`
    + `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${solid}</a:ln>`).join('')}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function docProps(title, extra) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    core: XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${xmlEsc(title)}</dc:title><dc:creator>rfcode</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    app: XML_HEAD + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>rfcode</Application>${extra || ''}</Properties>`,
  };
}

const rootRels = (main) => XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="${main}"/>`
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const IMG_TYPES = '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>';

/**
 * Gera um .pptx. spec: { title, theme, accent, font, footer, author, date, slides: [ { type, title, subtitle, bullets,
 * text, columns, column_titles, image, caption, quote, author, stats, note, number } ] }
 */
// O modelo nem sempre segue o formato: slides como texto JSON, tipo como chave ({ grafico: {...} }),
// gráfico sem type. Tudo isso vira o formato esperado em vez de gerar slides vazios.
const SLIDE_TYPES = ['capa', 'secao', 'topicos', 'duas_colunas', 'imagem', 'numeros', 'citacao', 'encerramento', 'grafico', 'processo', 'linha_do_tempo', 'funil', 'piramide', 'matriz', 'ciclo', 'cartoes', 'hub', 'venn', 'tabela', 'agenda', 'mercado'];
// Nomes alternativos e erros de digitação comuns para os tipos de slide.
const TYPE_ALIASES = {
  dois_colunas: 'duas_colunas', two_columns: 'duas_colunas', colunas_duplas: 'duas_colunas', comparacao: 'duas_colunas', comparison: 'duas_colunas',
  bullets: 'topicos', texto: 'topicos', text: 'topicos', lista: 'topicos', list: 'topicos', conteudo: 'topicos', content: 'topicos', resumo: 'topicos',
  cover: 'capa', title: 'capa', titulo: 'capa', section: 'secao', divider: 'secao', quote: 'citacao', image: 'imagem', picture: 'imagem',
  kpi: 'numeros', kpis: 'numeros', stats: 'numeros', metricas: 'numeros', indicadores: 'numeros', closing: 'encerramento', end: 'encerramento', fim: 'encerramento',
  grafico_barras: 'grafico', bar_chart: 'grafico', line_chart: 'grafico', pie_chart: 'grafico', etapas: 'processo', steps: 'processo', fluxo: 'processo',
  cronologia: 'linha_do_tempo', timeline: 'linha_do_tempo', cards: 'cartoes', pilares: 'cartoes', table: 'tabela', comparativo: 'tabela',
};
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
function resolveType(t, i) {
  if (t == null || t === '') return '';
  const k = String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_');
  if (SLIDE_TYPES.includes(k)) return k;
  if (TYPE_ALIASES[k]) return TYPE_ALIASES[k];
  if (visualType(k)) return visualType(k);
  const near = SLIDE_TYPES.map((x) => [x, lev(k, x)]).sort((a, b) => a[1] - b[1])[0];
  if (near && near[1] <= 2) return near[0];
  throw new Error(`Slide ${i + 1}: tipo "${t}" não existe. Tipos: ${SLIDE_TYPES.join(', ')}.`);
}
// itens que deveriam ser texto mas vieram como objeto ({ bullets: [...] }, { text }, { title })
const flatText = (x) => (x && typeof x === 'object' ? (Array.isArray(x.bullets) ? x.bullets.map(flatText) : x.text || x.title || x.label || '') : x);
const flatList = (arr) => (Array.isArray(arr) ? arr.flatMap((x) => [].concat(flatText(x))).filter((x) => x !== '' && x != null) : arr);

// campos mínimos de cada tipo: sem eles o slide sairia em branco
const REQUIRED = {
  topicos: (s) => (s.bullets && s.bullets.length) || s.text, duas_colunas: (s) => Array.isArray(s.columns) && s.columns.some((c) => c && c.length),
  numeros: (s) => s.stats && s.stats.length, imagem: (s) => s.image, citacao: (s) => s.quote || s.title,
  grafico: (s) => s.chart || (s.charts && s.charts.length) || s.values || s.series || s.items,
};

function normalizeSlide(raw, i) {
  let s = raw;
  if (typeof s === 'string') s = { title: s };
  if (!s || typeof s !== 'object') return { title: '' };
  s = { ...s };
  if (s.type) s.type = resolveType(s.type, i);
  if (!s.type) {
    const key = Object.keys(s).find((k) => (SLIDE_TYPES.includes(k) || visualType(k)) && s[k] && typeof s[k] === 'object');
    if (key) {
      const type = visualType(key) || key;
      const val = s[key];
      delete s[key];
      if (type === 'grafico') s = { ...s, type, ...(Array.isArray(val) ? { charts: val } : { chart: val }) };
      else if (Array.isArray(val)) s = { ...s, type, items: val };
      else s = { ...val, ...s, type };
    } else if (s.chart || s.charts) s.type = 'grafico';
    else if (s.stats) s.type = 'numeros';
    else if (s.steps) s.type = 'processo';
    else if (s.events) s.type = 'linha_do_tempo';
    else if (s.headers && s.rows) s.type = 'tabela';
    else if (s.quote) s.type = 'citacao';
    else if (s.columns) s.type = 'duas_colunas';
    else if (s.image) s.type = 'imagem';
  }
  if (s.content && !s.bullets && !s.text) {
    if (Array.isArray(s.content)) s.bullets = s.content; else s.text = String(s.content);
  }
  if (typeof s.bullets === 'string') s.bullets = s.bullets.split(/\n+/).filter(Boolean);
  if (!s.type && i > 0 && !s.bullets && !s.text) throw new Error(`Slide ${i + 1} sem conteúdo: informe type e os campos do tipo (ex.: { "type": "grafico", "chart": {...} }).`);
  if (!s.type) s.type = i === 0 ? 'capa' : 'topicos';
  if (Array.isArray(s.bullets)) s.bullets = flatList(s.bullets);
  if (Array.isArray(s.columns)) s.columns = s.columns.map((c) => flatList(Array.isArray(c) ? c : [c]));
  if (s.type === 'topicos' && !REQUIRED.topicos(s) && Array.isArray(s.columns)) s.type = 'duas_colunas';
  if (REQUIRED[s.type] && !REQUIRED[s.type](s)) {
    const guess = s.chart || s.charts ? 'grafico' : s.stats ? 'numeros' : s.steps ? 'processo' : s.events ? 'linha_do_tempo'
      : s.headers && s.rows ? 'tabela' : s.columns ? 'duas_colunas' : s.cards ? 'cartoes' : s.levels ? 'piramide' : null;
    if (guess) s.type = guess;
  }
  const req = REQUIRED[s.type];
  if (req && !req(s)) throw new Error(`Slide ${i + 1} ("${s.title || s.type}") ficaria vazio: o tipo ${s.type} precisa dos seus campos (veja a descrição da ferramenta).`);
  // subtítulo do gráfico igual ao título do slide só repete texto
  const same = (a, b) => a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  if (s.chart && same(s.chart.title, s.title)) s.chart = { ...s.chart, title: undefined };
  return s;
}

// "mÃªs" é "mês" em UTF-8 lido como Latin-1 (Get-Content do PowerShell 5.1). Desfaz quando reconhece o padrão.
function fixMojibake(text) {
  if (!/Ã[\u0080-\u00BF]|Â[\u00A0-\u00BF]/.test(text)) return text;
  const fixed = Buffer.from(text, 'latin1').toString('utf8');
  return fixed.includes('\uFFFD') ? text : fixed;
}

function parseSlides(v) {
  if (typeof v === 'string') {
    v = fixMojibake(v);
    try { v = parseLoose(v); } catch { throw new Error('"slides" deve ser uma lista de objetos (JSON válido).'); }
  }
  if (v && !Array.isArray(v) && Array.isArray(v.slides)) v = v.slides;
  return Array.isArray(v) ? v : [];
}

// Lê JSON salvo por scripts (UTF-8 com ou sem BOM, ou UTF-16 do PowerShell).
function readJsonFile(file) {
  const buf = fs.readFileSync(file);
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.slice(2).toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.slice(2)).swap16().toString('utf16le');
  else text = buf.toString('utf8').replace(/^\uFEFF/, '');
  text = fixMojibake(text);
  try { return parseLoose(text); } catch (e) { throw new Error(`JSON inválido em ${path.basename(file)}.`); }
}

function createPptx(file, spec = {}, baseDir = process.cwd()) {
  if (spec.spec_file) spec = { ...readJsonFile(path.resolve(baseDir, spec.spec_file)), ...Object.fromEntries(Object.entries(spec).filter(([k]) => k !== 'spec_file' && k !== 'slides')) };
  const slides = parseSlides(spec.slides).map(normalizeSlide);
  spec = { ...spec, slides };
  if (!slides.length) throw new Error('Informe pelo menos um slide em "slides".');
  const themeName = THEMES[spec.theme] ? spec.theme : 'escuro';
  const t = { ...THEMES[themeName] };
  t.accent = hex(spec.accent, t.accent);
  t.palette = [...PALETTES[themeName]];
  if (spec.accent) t.palette = [t.accent, ...t.palette.filter((c) => c !== t.accent)];
  const dark = luminance(t.bg) < 0.4;
  t.dim = mix(t.surface, t.muted, 0.45);
  t.up = dark ? '4ADE80' : '16A34A';
  t.down = dark ? 'F87171' : 'DC2626';
  const font = spec.font || 'Segoe UI';
  const entries = [];
  const slideOut = [];
  let imgN = 0;
  slides.forEach((s, i) => {
    let built;
    try { built = buildSlide(s || {}, t, i + 1, slides.length, spec, baseDir); } catch (e) { throw new Error(`Slide ${i + 1} ("${(s && (s.title || s.type)) || ''}"): ${e.message}`); }
    const { xml, images, notes } = built;
    const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    for (const im of images) {
      imgN++;
      const name = `image${imgN}.${im.ext}`;
      rels.push(`<Relationship Id="${im.rid}" Type="${REL}/image" Target="../media/${name}"/>`);
      entries.push({ name: `ppt/media/${name}`, data: im.buf, late: true });
    }
    if (notes) rels.push(`<Relationship Id="rId${images.length + 2}" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`);
    slideOut.push({ xml, notes, rels: XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` });
  });
  const n = slideOut.length;
  const withNotes = slideOut.some((x) => x.notes);
  const ct = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + IMG_TYPES
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
    + '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>'
    + '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'
    + slideOut.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
    + (withNotes ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>'
      + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + slideOut.map((x, i) => (x.notes ? `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : '')).join('') : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const pres = XML_HEAD + `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + (withNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${n + 6}"/></p:notesMasterIdLst>` : '')
    + `<p:sldIdLst>${slideOut.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const presRels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`
    + slideOut.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 2}" Type="${REL}/presProps" Target="presProps.xml"/>`
    + `<Relationship Id="rId${n + 3}" Type="${REL}/viewProps" Target="viewProps.xml"/>`
    + `<Relationship Id="rId${n + 4}" Type="${REL}/theme" Target="theme/theme1.xml"/>`
    + `<Relationship Id="rId${n + 5}" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`
    + (withNotes ? `<Relationship Id="rId${n + 6}" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>` : '') + '</Relationships>';
  const props = docProps(spec.title || (slides[0] && slides[0].title) || 'Apresentação', `<Slides>${n}</Slides>`);
  const files = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rootRels('ppt/presentation.xml') },
    { name: 'docProps/core.xml', data: props.core },
    { name: 'docProps/app.xml', data: props.app },
    { name: 'ppt/presentation.xml', data: pres },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/presProps.xml', data: pptxStatic.presProps },
    { name: 'ppt/viewProps.xml', data: pptxStatic.viewProps },
    { name: 'ppt/tableStyles.xml', data: pptxStatic.tableStyles },
    { name: 'ppt/theme/theme1.xml', data: themeXml(t, font) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml() },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: pptxStatic.masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: pptxStatic.layout },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: pptxStatic.layoutRels },
    ...slideOut.flatMap((s, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data: s.xml },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: s.rels },
    ]),
    ...entries,
  ];
  if (withNotes) {
    const rels = (items) => XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
    files.push(
      { name: 'ppt/notesMasters/notesMaster1.xml', data: notesMasterXml() },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/>`) },
      { name: 'ppt/theme/theme2.xml', data: themeXml(THEMES.claro, font) },
      ...slideOut.flatMap((x, i) => (x.notes ? [
        { name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: notesSlideXml(x.notes) },
        { name: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, data: rels(`<Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${i + 1}.xml"/>`) },
      ] : [])),
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, createZip(files));
  const notesN = slideOut.filter((x) => x.notes).length;
  const res = notesN ? { slides: n, images: imgN, notes: notesN } : { slides: n, images: imgN };
  Object.defineProperty(res, 'spec', { value: spec }); // para a revisão, sem aparecer no resultado
  return res;
}

// ---------- DOCX (a partir de markdown) ----------
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

// **negrito**, *itálico* e `código` em runs do Word
function wRuns(text, base = '') {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0, m;
  const push = (t, rpr) => { if (t) out.push(`<w:r>${rpr || base ? `<w:rPr>${base}${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index), '');
    const tok = m[0];
    if (tok.startsWith('**')) push(tok.slice(2, -2), '<w:b/>');
    else if (tok.startsWith('`')) push(tok.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F1F3F5"/>');
    else push(tok.slice(1, -1), '<w:i/>');
    last = m.index + tok.length;
  }
  push(text.slice(last), '');
  return out.join('') || '<w:r><w:t></w:t></w:r>';
}

const wPara = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;

function docxStyles(font) {
  const f = xmlEsc(font);
  const h = (id, name, size, color, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
    + `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${id === 'Title' ? 0 : +id.slice(-1) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return XML_HEAD + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/><w:sz w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + h('Title', 'Title', 52, '111827', 0) + h('Heading1', 'heading 1', 34, '1F3A60', 360) + h('Heading2', 'heading 2', 28, '1F3A60', 280) + h('Heading3', 'heading 3', 24, '374151', 200)
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="9CA3AF"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`).join('')
    + '</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>';
}

/** Gera .docx a partir de markdown: títulos, parágrafos, listas, tabelas, citações, código, imagens ![](caminho) e quebra de página (\pagebreak). */
function createDocx(file, { markdown = '', title, font = 'Calibri' } = {}, baseDir = process.cwd()) {
  const body = [];
  const images = [];
  const nums = []; // { id, abs }
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  if (title) body.push(wPara(wRuns(title), '<w:pStyle w:val="Title"/>'));
  let i = 0, listNum = null, listKind = null;
  const newList = (kind) => {
    const id = nums.length + 1;
    nums.push({ id, abs: kind === 'ol' ? 1 : 0 });
    listNum = id; listKind = kind;
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    const isList = /^\s*([-*+]|\d+[.)])\s+/.test(line);
    if (!isList) { listNum = null; listKind = null; }
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      for (const c of code.length ? code : ['']) body.push(wPara(`<w:r><w:t xml:space="preserve">${xmlEsc(c)}</w:t></w:r>`, '<w:pStyle w:val="Code"/>'));
      body.push(wPara(''));
      continue;
    }
    if (!line.trim()) { i++; continue; }
    if (/^\\pagebreak\s*$/.test(line)) { body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); i++; continue; }
    if ((m = /^(#{1,3})\s+(.*)/.exec(line))) { body.push(wPara(wRuns(m[2]), `<w:pStyle w:val="Heading${m[1].length}"/>`)); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      body.push(wPara('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr>'));
      i++; continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(line.trim()))) {
      const info = imageInfo(path.resolve(baseDir, m[2]));
      const maxW = 6 * EMU, k = Math.min(1, maxW / (info.w * 9525));
      const cx = Math.round(info.w * 9525 * k), cy = Math.round(info.h * 9525 * k);
      const rid = `rIdImg${images.length + 1}`, n = images.length + 1;
      images.push({ rid, name: `image${n}.${info.ext}`, buf: info.buf });
      body.push(wPara(`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Imagem ${n}" descr="${xmlEsc(m[1])}"/>`
        + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${images[n - 1].name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      '<w:jc w:val="center"/>'));
      if (m[1]) body.push(wPara(wRuns(m[1], '<w:i/><w:color w:val="6B7280"/><w:sz w:val="18"/>'), '<w:jc w:val="center"/>'));
      i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const cols = Math.max(...rows.map((r) => r.length));
      const tw = Math.floor(9000 / cols);
      body.push('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>'
        + `<w:tblGrid>${('<w:gridCol w:w="' + tw + '"/>').repeat(cols)}</w:tblGrid>`
        + rows.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="${tw}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"/>' : ''}</w:tcPr>`
          + wPara(wRuns(r[ci] || '', ri === 0 ? '<w:b/>' : ''), '<w:spacing w:after="0"/>') + '</w:tc>').join('')}</w:tr>`).join('')
        + '</w:tbl>');
      body.push(wPara(''));
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)/.exec(line))) {
      const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (listNum === null || kind !== listKind) newList(kind);
      const lvl = Math.min(2, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      body.push(wPara(wRuns(m[3]), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${listNum}"/></w:numPr>`));
      i++; continue;
    }
    if ((m = /^>\s?(.*)/.exec(line))) { body.push(wPara(wRuns(m[1]), '<w:pStyle w:val="Quote"/>')); i++; continue; }
    // parágrafo: junta linhas seguidas
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*\||!\[|\\pagebreak)/.test(lines[i])) para.push(lines[i++].trim());
    body.push(wPara(wRuns(para.join(' '))));
  }
  const lvls = (fmt) => [0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>`
    + `<w:lvlText w:val="${fmt === 'bullet' ? ['•', '–', '▪'][l] : `%${l + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const numbering = XML_HEAD + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum>`
    + nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abs}"/>${n.abs ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`).join('')
    + '</w:numbering>';
  const doc = XML_HEAD + `<w:document ${W_NS}><w:body>${body.join('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const docRels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/>`
    + images.map((im) => `<Relationship Id="${im.rid}" Type="${REL}/image" Target="media/${im.name}"/>`).join('') + '</Relationships>';
  const ct = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + IMG_TYPES
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const props = docProps(title || 'Documento');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, createZip([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rootRels('word/document.xml') },
    { name: 'docProps/core.xml', data: props.core },
    { name: 'docProps/app.xml', data: props.app },
    { name: 'word/document.xml', data: doc },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: docxStyles(font) },
    { name: 'word/numbering.xml', data: numbering },
    ...images.map((im) => ({ name: `word/media/${im.name}`, data: im.buf })),
  ]));
  return { paragraphs: body.length, images: images.length };
}

// ---------- leitura de documentos ----------
const unxml = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function docxText(xml) {
  return unxml(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t'))
    .replace(/\n{3,}/g, '\n\n').trim();
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

function xlsxText(files) {
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const wb = (files.get('xl/workbook.xml') || '').toString('utf8');
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => unxml(m[1]));
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  return sheets.map((k, si) => {
    const xml = files.get(k).toString('utf8');
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs);
        const type = /t="(\w+)"/.exec(attrs);
        let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (type && type[1] === 's') v = shared[+v];
        else if (type && type[1] === 'inlineStr') v = unxml(inner);
        else if (v != null) v = unxml(v);
        const idx = ref ? colIndex(ref[1]) : cells.length;
        cells[idx] = v ?? '';
      }
      rows.push(Array.from(cells, (x) => (x == null ? '' : String(x).includes(';') ? `"${x}"` : x)).join(';'));
    }
    return `## Planilha: ${names[si] || k}\n${rows.join('\n')}`;
  }).join('\n\n');
}

// PDF: usa pdftotext se existir; senão extrai o texto das streams (funciona com a maioria dos PDFs com texto).
function pdfText(file) {
  try { return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* sem pdftotext */ }
  const buf = fs.readFileSync(file);
  const out = [];
  const src = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.slice(start, end);
    try { data = zlib.inflateSync(data); } catch { /* stream sem compressão */ }
    const s = data.toString('latin1');
    if (!/\b(Tj|TJ)\b/.test(s)) continue;
    const txt = [];
    for (const t of s.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|(T\*|Td|TD|ET)/g)) {
      if (t[3]) { txt.push('\n'); continue; }
      const raw = t[1] != null ? [...t[1].matchAll(/\(((?:[^)\\]|\\.)*)\)/g)].map((x) => x[1]).join('') : t[2];
      txt.push(raw.replace(/\\([nrt()\\])/g, (_, c) => ({ n: '\n', r: '', t: '\t' }[c] ?? c)).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
    }
    out.push(txt.join('').replace(/\n\s*\n+/g, '\n'));
  }
  const text = out.join('\n').trim();
  return text || '(não consegui extrair texto deste PDF; ele pode ser só imagem/escaneado)';
}

function readDocument(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return pdfText(file);
  const files = readZip(fs.readFileSync(file));
  if (ext === '.docx' || ext === '.docm' || ext === '.dotx') return docxText(files.get('word/document.xml').toString('utf8'));
  if (ext === '.pptx' || ext === '.potx') {
    const slides = [...files.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
    return slides.map((k, i) => {
      const xml = files.get(k).toString('utf8');
      const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => unxml(t[1])).join('')).filter(Boolean);
      const notesKey = `ppt/notesSlides/notesSlide${k.match(/(\d+)\.xml/)[1]}.xml`;
      const notes = files.get(notesKey) ? [...files.get(notesKey).toString('utf8').matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => unxml(t[1])).join(' ') : '';
      return `## Slide ${i + 1}\n${paras.join('\n')}${notes ? `\n(notas: ${notes})` : ''}`;
    }).join('\n\n');
  }
  if (ext === '.xlsx' || ext === '.xlsm') return xlsxText(files);
  if (ext === '.odt' || ext === '.odp' || ext === '.ods') {
    return unxml(files.get('content.xml').toString('utf8').replace(/<text:tab\/>/g, '\t').replace(/<\/text:(p|h)>/g, '\n')).trim();
  }
  throw new Error(`Formato não suportado: ${ext}. Use read_file para arquivos de texto.`);
}

// ---------- definições das ferramentas ----------
const OFFICE_TOOL_DEFS = [
  {
    name: 'create_pptx',
    description: 'Cria uma apresentação PowerPoint (.pptx) com design profissional, gráficos e diagramas nativos (editáveis). '
      + 'Escreva como consultor: título de ação (frase com a conclusão do slide), uma ideia por slide, pouco texto. Prefira visuais a listas: '
      + 'números → grafico ou numeros; etapas → processo; datas → linha_do_tempo; comparação → tabela ou matriz; conversão → funil; hierarquia → piramide; '
      + 'pilares/benefícios → cartoes; relações → hub, ciclo ou venn. Em todo slide de conteúdo pode haver takeaway (conclusão em destaque), source (fonte) e notes (roteiro do apresentador).\n'
      + 'Tipos: capa (title, subtitle, author, date); secao (title, number, subtitle); agenda (items[{title,text}], current?); '
      + 'topicos (bullets[] ou text; 2 espaços no início = subtópico); duas_colunas (columns[[..],[..]], column_titles[]); imagem (image, bullets?, caption?); '
      + 'numeros (stats[{value,label,delta?,good?}] até 4; delta "+12%"); citacao (quote, author); encerramento (title, subtitle); '
      + 'grafico (chart: {type, title?, categories[], series[{name, values[]}] ou values[], prefix?, suffix?, decimals?, highlight?: índice, cagr?: true, diff?: [de, até]}, '
      + 'ou charts: [2 gráficos lado a lado], insights?: [destaques ao lado]). chart.type: colunas, empilhado, empilhado100, barras, linha (zero:false para não começar do zero), '
      + 'pizza, rosca (center, center_label), cascata (items[{label, value, total?}]); '
      + 'processo (steps[{title,text}] até 7); linha_do_tempo (events[{date,title,text}] até 8); funil (stages[{label,value,text?}]); '
      + 'piramide (levels[{title,text}], topo primeiro); matriz (quadrants[4]{title,items?} na ordem sup.esq, sup.dir, inf.esq, inf.dir, x_label, y_label, points?[{label,x:0-1,y:0-1,size?}], highlight?); '
      + 'ciclo (steps[{title,text}], center?); cartoes (cards[{title,text,icon? emoji, value?}] até 8); hub (center, items[{title,text}]); '
      + 'venn (sets[{title,text}] 2 ou 3, center?); tabela (headers[], rows[[..]], highlight_row?, highlight_col?); mercado (TAM/SAM/SOM: levels[{label, value, text}] do maior para o menor). **negrito** funciona nos textos. '
      + 'Temas: consultoria (estilo think-cell), papel (estilo Napkin), claro, escuro, azul, terra, roxo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo de saída (.pptx)' },
        spec_file: { type: 'string', description: 'Opcional: arquivo .json com a apresentação inteira ({ title, theme, slides }), útil quando um script calcula os dados. Substitui slides.' },
        title: { type: 'string' },
        theme: { type: 'string', enum: Object.keys(THEMES), description: 'Padrão: escuro' },
        accent: { type: 'string', description: 'Cor de destaque em hex, ex. #2563EB (opcional)' },
        font: { type: 'string', description: 'Fonte (padrão Segoe UI)' },
        footer: { type: 'string', description: 'Rodapé dos slides internos (opcional)' },
        author: { type: 'string' },
        date: { type: 'string' },
        slides: { type: 'array', items: { type: 'object' } },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_docx',
    description: 'Cria um documento Word (.docx) a partir de markdown: # títulos, parágrafos, listas (- e 1.), tabelas |a|b|, > citações, ```código```, '
      + 'imagens ![legenda](caminho.png), **negrito**, *itálico* e \\pagebreak para quebra de página.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo de saída (.docx)' },
        title: { type: 'string', description: 'Título no topo (opcional)' },
        markdown: { type: 'string' },
        font: { type: 'string', description: 'Fonte (padrão Calibri)' },
      },
      required: ['path', 'markdown'],
    },
  },
  {
    name: 'read_document',
    description: 'Extrai o texto de documentos: .pdf, .docx, .pptx (por slide, com notas), .xlsx (planilhas como linhas separadas por ;), .odt/.odp/.ods.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];
const OFFICE_TOOLS = new Set(OFFICE_TOOL_DEFS.map((t) => t.name));

// Revisão do roteiro: o que deixa um deck fraco (paredes de texto, nenhum visual, títulos vagos).
function reviewDeck(slides = []) {
  const tips = [];
  const content = slides.filter((s) => s && !['capa', 'secao', 'encerramento', 'agenda'].includes(s.type || ''));
  const plain = content.filter((s) => !s.type || ['topicos', 'duas_colunas'].includes(s.type));
  if (content.length >= 4 && plain.length / content.length > 0.6) {
    tips.push(`${plain.length} de ${content.length} slides são só texto. Troque parte por visuais (grafico, processo, linha_do_tempo, cartoes, tabela, matriz...).`);
  }
  if (slides.length >= 6 && !slides.some((s) => s && s.notes)) tips.push('Nenhum slide tem notes; acrescente o roteiro do apresentador nos principais slides.');
  // título de ação: frase com a conclusão ("Nordeste gera 42% da receita"), não um rótulo ("Receita por região")
  const generic = content.filter((s) => s.title && String(s.title).split(/\s+/).length <= 4 && !/\d/.test(s.title));
  if (content.length >= 3 && generic.length / content.length > 0.5) {
    tips.push(`Títulos como "${generic[0].title}" só descrevem o assunto. Use títulos de ação com a conclusão e o número (ex.: "Nordeste gera 42% da receita e cresce 2x mais rápido").`);
  }
  const charts = content.filter((s) => s.type === 'grafico');
  const data = content.filter((s) => ['grafico', 'numeros', 'tabela'].includes(s.type));
  if (data.length >= 2 && !content.some((s) => s.source)) tips.push('Slides com dados não citam a fonte; preencha source (ex.: "ABVE, 2025") nos slides com números.');
  if (charts.length >= 3 && charts.filter((s) => s.takeaway).length < charts.length / 2) tips.push('Gráficos sem takeaway: diga em uma frase o que cada gráfico prova.');
  const pies = charts.filter((s) => [].concat(s.chart || [], s.charts || []).some((c) => /pizza|rosca|pie|donut/.test(c.type || '') && (c.categories || c.labels || c.values || []).length <= 2));
  if (pies.length) tips.push(`Pizza com 2 fatias (slide ${slides.indexOf(pies[0]) + 1}) informa pouco; use numeros ou junte com outro gráfico em charts.`);
  const cats = (s) => JSON.stringify(((s.chart || (s.charts || [])[0] || {}).categories) || null);
  for (let i = 1; i < slides.length; i++) {
    const a = slides[i - 1], b = slides[i];
    if (a && b && a.type === 'grafico' && b.type === 'grafico' && cats(a) !== 'null' && cats(a) === cats(b) && !a.charts && !b.charts) {
      tips.push(`Slides ${i} e ${i + 1} mostram as mesmas categorias; junte em um slide (séries no mesmo gráfico ou charts lado a lado).`);
      break;
    }
  }
  slides.forEach((s, i) => {
    if (!s) return;
    const n = i + 1;
    const bullets = s.bullets || [];
    if (bullets.length > 6) tips.push(`Slide ${n}: ${bullets.length} tópicos; divida em dois slides ou use um visual.`);
    const long = bullets.filter((b) => String(b).length > 140).length;
    if (long) tips.push(`Slide ${n}: ${long} tópico(s) muito longo(s); resuma em frases curtas e leve o detalhe para notes.`);
    if (s.text && String(s.text).length > 500) tips.push(`Slide ${n}: parágrafo muito longo para slide.`);
    if (s.title && String(s.title).length > 110) tips.push(`Slide ${n}: título longo demais; mantenha a conclusão em até ~90 caracteres.`);
  });
  return tips.slice(0, 6);
}

function runOfficeTool(name, args, cwd) {
  const full = path.resolve(cwd, args.path || '');
  const rel = path.relative(cwd, full).replace(/\\/g, '/');
  if (name === 'read_document') return readDocument(full);
  if (name === 'create_pptx') {
    if (!/\.pptx$/i.test(full)) throw new Error('O caminho deve terminar em .pptx');
    const r = createPptx(full, args, cwd);
    const tips = reviewDeck(r.spec.slides);
    return `Apresentação criada: ${rel} (${r.slides} slides${r.images ? `, ${r.images} imagens` : ''}${r.notes ? `, ${r.notes} com notas` : ''}).`
      + (tips.length ? `\nPontos a melhorar (refaça o arquivo se fizer sentido):\n- ${tips.join('\n- ')}` : '');
  }
  if (name === 'create_docx') {
    if (!/\.docx$/i.test(full)) throw new Error('O caminho deve terminar em .docx');
    const r = createDocx(full, args, cwd);
    return `Documento criado: ${rel} (${r.paragraphs} blocos${r.images ? `, ${r.images} imagens` : ''}).`;
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

function officeDescribe(name, a = {}) {
  if (name === 'create_pptx') return `PowerPoint(${a.path}, ${a.spec_file ? a.spec_file : `${Array.isArray(a.slides) ? a.slides.length : 0} slides`})`;
  if (name === 'create_docx') return `Word(${a.path})`;
  if (name === 'read_document') return `ReadDoc(${a.path})`;
  return null;
}

module.exports = {
  createPptx, createDocx, readDocument, imageInfo, THEMES,
  OFFICE_TOOL_DEFS, OFFICE_TOOLS, runOfficeTool, officeDescribe,
};
