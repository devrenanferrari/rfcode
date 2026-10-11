'use strict';
// Documentos do Office sem dependências: gera .pptx (slides com design pronto) e .docx (a partir de markdown),
// e extrai texto de .docx, .pptx, .xlsx, .odt/.odp e .pdf para o agente ler.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { createZip, readZip } = require('./zip');

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

class SlideBuilder {
  constructor(theme) { this.t = theme; this.shapes = []; this.id = 2; this.images = []; }
  nextId() { return this.id++; }
  rect(x, y, w, h, color, { round = 0 } = {}) {
    const id = this.nextId();
    const geom = round ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${round}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Forma ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>${geom}`
      + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
  }
  // paras: [{ text, size, color, bold, italic, bullet, level, align, spaceBefore }]
  text(x, y, w, h, paras, { anchor = 't', font } = {}) {
    const id = this.nextId();
    const body = paras.map((p) => {
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
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Texto ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
      + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`);
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
  b.text(MX, inch(0.5), CW, inch(1.0), [{ text: title, size: title.length > 48 ? 3000 : 3600, bold: true }], { anchor: 'b' });
  b.rect(MX, inch(1.62), inch(0.9), inch(0.07), t.accent);
}

function addFooter(b, t, n, total, footer) {
  if (footer) b.text(MX, SH - inch(0.55), inch(8), inch(0.3), [{ text: footer, size: 1100, color: t.muted }]);
  b.text(SW - MX - inch(1.5), SH - inch(0.55), inch(1.5), inch(0.3), [{ text: `${n} / ${total}`, size: 1100, color: t.muted, align: 'r' }]);
}

function buildSlide(s, t, n, total, opts, baseDir) {
  const b = new SlideBuilder(t);
  const type = s.type || (n === 1 ? 'capa' : 'topicos');
  const resolveImg = (p) => path.resolve(baseDir, p);
  let bg = t.bg;
  const top = inch(2.0), bodyH = SH - top - inch(0.9);

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
      b.rect(x, top + inch(0.4), w, inch(3.2), t.surface, { round: 5000 });
      b.text(x + inch(0.3), top + inch(0.8), w - inch(0.6), inch(1.4), [{ text: String(st.value ?? ''), size: statSize, bold: true, color: t.accent }], { anchor: 'b' });
      b.text(x + inch(0.3), top + inch(2.35), w - inch(0.6), inch(1.1), [{ text: String(st.label ?? ''), size: 1600, color: t.muted }]);
    });
    if (s.note) b.text(MX, SH - inch(1.3), CW, inch(0.5), [{ text: s.note, size: 1400, color: t.muted }]);
  } else { // topicos
    addTitle(b, t, s.title || '');
    const items = s.bullets || (s.text ? [s.text] : []);
    const paras = s.text && !s.bullets
      ? [{ text: s.text, size: s.text.length > 400 ? 1800 : 2200, line: 120000 }]
      : bulletParas(items, bulletSize(items), t);
    b.text(MX, top, CW, bodyH, paras);
  }
  if (type !== 'capa' && type !== 'secao' && type !== 'encerramento') addFooter(b, t, n, total, opts.footer);
  return { xml: b.xml(bg), images: b.images };
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
function createPptx(file, spec = {}, baseDir = process.cwd()) {
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  if (!slides.length) throw new Error('Informe pelo menos um slide em "slides".');
  const t = { ...(THEMES[spec.theme] || THEMES.escuro) };
  t.accent = hex(spec.accent, t.accent);
  const font = spec.font || 'Segoe UI';
  const entries = [];
  const slideOut = [];
  let imgN = 0;
  slides.forEach((s, i) => {
    const { xml, images } = buildSlide(s || {}, t, i + 1, slides.length, spec, baseDir);
    const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    for (const im of images) {
      imgN++;
      const name = `image${imgN}.${im.ext}`;
      rels.push(`<Relationship Id="${im.rid}" Type="${REL}/image" Target="../media/${name}"/>`);
      entries.push({ name: `ppt/media/${name}`, data: im.buf, late: true });
    }
    slideOut.push({ xml, rels: XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` });
  });
  const n = slideOut.length;
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
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const pres = XML_HEAD + `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${slideOut.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const presRels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`
    + slideOut.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 2}" Type="${REL}/presProps" Target="presProps.xml"/>`
    + `<Relationship Id="rId${n + 3}" Type="${REL}/viewProps" Target="viewProps.xml"/>`
    + `<Relationship Id="rId${n + 4}" Type="${REL}/theme" Target="theme/theme1.xml"/>`
    + `<Relationship Id="rId${n + 5}" Type="${REL}/tableStyles" Target="tableStyles.xml"/></Relationships>`;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, createZip(files));
  return { slides: n, images: imgN };
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
    description: 'Cria uma apresentação PowerPoint (.pptx) com design pronto. Escreva conteúdo de verdade: títulos curtos, 3 a 6 tópicos por slide, frases objetivas. '
      + 'Tipos de slide: capa (title, subtitle, author, date), secao (title, number, subtitle), topicos (title, bullets[] — use 2 espaços no início para subtópico — ou text), '
      + 'duas_colunas (title, columns[[...],[...]], column_titles[]), imagem (title, image: caminho PNG/JPG, bullets?, caption?), '
      + 'numeros (title, stats[{value,label}] até 4, note?), citacao (quote, author), encerramento (title, subtitle). **negrito** funciona nos textos.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo de saída (.pptx)' },
        title: { type: 'string' },
        theme: { type: 'string', enum: Object.keys(THEMES), description: 'Padrão: escuro' },
        accent: { type: 'string', description: 'Cor de destaque em hex, ex. #2563EB (opcional)' },
        font: { type: 'string', description: 'Fonte (padrão Segoe UI)' },
        footer: { type: 'string', description: 'Rodapé dos slides internos (opcional)' },
        author: { type: 'string' },
        date: { type: 'string' },
        slides: { type: 'array', items: { type: 'object' } },
      },
      required: ['path', 'slides'],
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

function runOfficeTool(name, args, cwd) {
  const full = path.resolve(cwd, args.path || '');
  const rel = path.relative(cwd, full).replace(/\\/g, '/');
  if (name === 'read_document') return readDocument(full);
  if (name === 'create_pptx') {
    if (!/\.pptx$/i.test(full)) throw new Error('O caminho deve terminar em .pptx');
    const r = createPptx(full, args, cwd);
    return `Apresentação criada: ${rel} (${r.slides} slides${r.images ? `, ${r.images} imagens` : ''}). Para conferir o conteúdo use read_document.`;
  }
  if (name === 'create_docx') {
    if (!/\.docx$/i.test(full)) throw new Error('O caminho deve terminar em .docx');
    const r = createDocx(full, args, cwd);
    return `Documento criado: ${rel} (${r.paragraphs} blocos${r.images ? `, ${r.images} imagens` : ''}).`;
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

function officeDescribe(name, a = {}) {
  if (name === 'create_pptx') return `PowerPoint(${a.path}, ${Array.isArray(a.slides) ? a.slides.length : 0} slides)`;
  if (name === 'create_docx') return `Word(${a.path})`;
  if (name === 'read_document') return `ReadDoc(${a.path})`;
  return null;
}

module.exports = {
  createPptx, createDocx, readDocument, imageInfo, THEMES,
  OFFICE_TOOL_DEFS, OFFICE_TOOLS, runOfficeTool, officeDescribe,
};
