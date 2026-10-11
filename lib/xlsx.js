'use strict';
// Excel sem dependências: lê .xlsx em linhas (com datas e números de verdade) e gera .xlsx formatado
// (cabeçalho, larguras, formatos de número, fórmulas, totais, filtro e cabeçalho congelado).

const fs = require('fs');
const path = require('path');
const { createZip, readZip } = require('./zip');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const unxml = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// A → 0, Z → 25, AA → 26
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// datas do Excel: dias desde 30/12/1899
const EPOCH = Date.UTC(1899, 11, 30);
const serialToISO = (n) => {
  const d = new Date(EPOCH + Math.round(n * 86400000));
  const iso = d.toISOString();
  return n % 1 ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
};
const isoToSerial = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - EPOCH) / 86400000;
};
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Lê um .xlsx: [{ name, rows: [[valor...]] }]. Números viram number; datas, 'AAAA-MM-DD'. */
function readXlsx(file) {
  const files = readZip(fs.readFileSync(file));
  const get = (k) => (files.get(k) || Buffer.from('')).toString('utf8');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  // estilos de data: cellXfs cujo numFmt é de data
  const styles = get('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt [^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [+m[1], m[2]]));
  const xfs = ((/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles) || [])[1] || '');
  const dateStyle = [...xfs.matchAll(/<xf [^>]*?numFmtId="(\d+)"/g)].map((m) => {
    const id = +m[1];
    if (BUILTIN_DATE.has(id)) return true;
    const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    return /[dy]/i.test(code) && !/^[#0.,%\s]*$/.test(code);
  });
  const wb = get('xl/workbook.xml');
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [...wb.matchAll(/<sheet [^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)].map((m) => {
    let target = rels.get(m[2]) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: unxml(m[1]), file: target.replace(/\/\.\//g, '/') };
  });
  return sheets.map(({ name, file: f }) => {
    const xml = get(f);
    const rows = [];
    for (const r of xml.matchAll(/<row ([^>]*)>([\s\S]*?)<\/row>|<row ([^>]*)\/>/g)) {
      const rn = +(/r="(\d+)"/.exec(r[1] || r[3]) || [])[1] || rows.length + 1;
      const cells = [];
      for (const c of (r[2] || '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs);
        const t = (/t="(\w+)"/.exec(attrs) || [])[1];
        const s = +(/s="(\d+)"/.exec(attrs) || [])[1];
        let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (t === 's') v = shared[+v];
        else if (t === 'inlineStr') v = unxml(inner);
        else if (t === 'str' || t === 'e') v = v != null ? unxml(v) : '';
        else if (t === 'b') v = v === '1';
        else if (v != null) { v = Number(v); if (dateStyle[s]) v = serialToISO(v); }
        cells[ref ? colIndex(ref[1]) : cells.length] = v ?? '';
      }
      rows[rn - 1] = Array.from(cells, (x) => (x == null ? '' : x));
    }
    return { name, rows: Array.from(rows, (x) => x || []) };
  });
}

// ---------- escrita ----------
// formatos prontos (nomes amigáveis) → código do Excel
const FORMATS = {
  inteiro: '#,##0', numero: '#,##0.00', decimal: '#,##0.00', moeda: '"R$" #,##0.00', real: '"R$" #,##0.00', brl: '"R$" #,##0.00',
  dolar: '"US$" #,##0.00', usd: '"US$" #,##0.00', euro: '"€" #,##0.00', percentual: '0.0%', porcentagem: '0.0%', pct: '0.0%',
  data: 'dd/mm/yyyy', datahora: 'dd/mm/yyyy hh:mm', texto: '@',
};
const fmtCode = (f) => (f ? FORMATS[String(f).toLowerCase()] || String(f) : null);

// texto que é número: "1234", "1234.5", "1.234,56", "12,5" (sem zero à esquerda, para não estragar códigos como "00123")
function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || (/^-?0\d/.test(s))) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return null;
}

/**
 * Gera .xlsx. sheets: [{ name, columns?: [nomes], rows: [[...]] ou [{col: valor}], formats?: { coluna: 'moeda'|'percentual'|'data'|código },
 * widths?: { coluna: n }, totals?: true | ['soma'|'media'|...], freeze?: true, filter?: true }]. Texto começando com "=" vira fórmula.
 */
function createXlsx(file, { sheets = [], accent = '1F4E79' } = {}) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('Informe pelo menos uma aba em "sheets".');
  const fmts = new Map(); // código → numFmtId
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>'];
  const xfKey = new Map();
  // estilo para (formato, negrito)
  const styleFor = (code, bold) => {
    if (!code && !bold) return 0;
    const key = `${code || ''}|${bold ? 1 : 0}`;
    if (xfKey.has(key)) return xfKey.get(key);
    let id = 0;
    if (code) {
      const builtin = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '@': 49 }[code];
      if (builtin) id = builtin;
      else { if (!fmts.has(code)) fmts.set(code, 164 + fmts.size); id = fmts.get(code); }
    }
    xfs.push(`<xf numFmtId="${id}" fontId="${bold ? 2 : 0}" fillId="0" borderId="${bold ? 2 : 0}" xfId="0"${id ? ' applyNumberFormat="1"' : ''}${bold ? ' applyFont="1" applyBorder="1"' : ''}/>`);
    xfKey.set(key, xfs.length - 1);
    return xfs.length - 1;
  };

  const names = new Set();
  const out = sheets.map((sh, si) => {
    let name = String(sh.name || `Planilha${si + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Planilha${si + 1}`;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${si + 1}`;
    names.add(name.toLowerCase());
    let rows = Array.isArray(sh.rows) ? sh.rows : [];
    let columns = Array.isArray(sh.columns) ? sh.columns.map(String) : null;
    if (rows.length && rows[0] && !Array.isArray(rows[0]) && typeof rows[0] === 'object') {
      columns ||= [...new Set(rows.flatMap((r) => Object.keys(r)))];
      rows = rows.map((r) => columns.map((c) => r[c]));
    }
    if (!columns && rows.length) { columns = rows[0].map(String); rows = rows.slice(1); }
    columns ||= [];
    const ncol = Math.max(columns.length, ...rows.map((r) => (r || []).length), 1);
    const formats = sh.formats || {};
    const colFmt = Array.from({ length: ncol }, (_, j) => fmtCode(formats[columns[j]] ?? formats[colName(j)] ?? formats[j]));
    // data ISO numa coluna sem formato: formata como data
    rows.forEach((r) => (r || []).forEach((v, j) => { if (!colFmt[j] && typeof v === 'string' && isoToSerial(v.trim()) != null) colFmt[j] = /\d:\d/.test(v) ? FORMATS.datahora : FORMATS.data; }));
    const numericCol = Array.from({ length: ncol }, (_, j) => rows.some((r) => r && asNumber(r[j]) != null) && rows.every((r) => !r || r[j] == null || r[j] === '' || asNumber(r[j]) != null || String(r[j]).startsWith('=')));

    const cell = (v, ref, j, bold) => {
      if (v == null || v === '') return '';
      const s = styleFor(colFmt[j], bold);
      const sAttr = s ? ` s="${s}"` : '';
      if (typeof v === 'string' && v.startsWith('=') && v.length > 1) return `<c r="${ref}"${sAttr}><f>${esc(v.slice(1))}</f></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
      const iso = typeof v === 'string' ? isoToSerial(v.trim()) : null;
      if (iso != null) return `<c r="${ref}"${sAttr}><v>${iso}</v></c>`;
      const n = colFmt[j] === '@' ? null : asNumber(v);
      if (n != null) return `<c r="${ref}"${sAttr}><v>${n}</v></c>`;
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    };

    const xmlRows = [];
    const hasHeader = columns.length > 0;
    if (hasHeader) xmlRows.push(`<row r="1" ht="22" customHeight="1">${columns.map((c, j) => `<c r="${colName(j)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`).join('')}</row>`);
    const first = hasHeader ? 2 : 1;
    rows.forEach((r, i) => {
      const rn = first + i;
      xmlRows.push(`<row r="${rn}">${(r || []).map((v, j) => cell(v, `${colName(j)}${rn}`, j, false)).join('')}</row>`);
    });
    const last = first + rows.length - 1;
    if (sh.totals && rows.length) {
      const rn = last + 1;
      const fnOf = (j) => {
        // porcentagem somada não faz sentido: o padrão nessas colunas é a média
        const want = Array.isArray(sh.totals) ? sh.totals[j] : /%/.test(colFmt[j] || '') ? 'media' : 'soma';
        return { soma: 'SUM', sum: 'SUM', media: 'AVERAGE', média: 'AVERAGE', avg: 'AVERAGE', average: 'AVERAGE', min: 'MIN', max: 'MAX', contagem: 'COUNT', count: 'COUNT' }[String(want || '').toLowerCase()];
      };
      const cells = Array.from({ length: ncol }, (_, j) => {
        const ref = `${colName(j)}${rn}`;
        if (j === 0 && !numericCol[0]) return `<c r="${ref}" s="${styleFor(null, true)}" t="inlineStr"><is><t>Total</t></is></c>`;
        const fn = numericCol[j] && fnOf(j);
        return fn ? `<c r="${ref}" s="${styleFor(colFmt[j], true)}"><f>${fn}(${colName(j)}${first}:${colName(j)}${last})</f></c>` : '';
      });
      xmlRows.push(`<row r="${rn}">${cells.join('')}</row>`);
    }
    // larguras pelo conteúdo
    const widths = Array.from({ length: ncol }, (_, j) => {
      const custom = sh.widths && (sh.widths[columns[j]] ?? sh.widths[colName(j)]);
      if (custom) return Number(custom);
      const len = Math.max(String(columns[j] ?? '').length + 2, ...rows.slice(0, 500).map((r) => {
        const v = r && r[j];
        const n = asNumber(v);
        return n != null ? String(Math.round(n)).length + 6 : String(v ?? '').length;
      }));
      return Math.min(60, Math.max(8, len + 2));
    });
    const freeze = sh.freeze !== false && hasHeader;
    const filter = sh.filter !== false && hasHeader && rows.length > 0;
    const ref = `A1:${colName(ncol - 1)}${Math.max(last, 1)}`;
    const xml = XML_HEAD + `<worksheet xmlns="${NS}" xmlns:r="${NS_R}"><dimension ref="${ref}"/>`
      + `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}>${freeze ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ''}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      + `<sheetData>${xmlRows.join('')}</sheetData>`
      + (filter ? `<autoFilter ref="A1:${colName(ncol - 1)}${last}"/>` : '')
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
    return { name, xml, filter, filterRef: `$A$1:$${colName(ncol - 1)}$${last}`, rows: rows.length };
  });

  const styles = XML_HEAD + `<styleSheet xmlns="${NS}">`
    + (fmts.size ? `<numFmts count="${fmts.size}">${[...fmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts>` : '')
    + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${String(accent).replace('#', '').toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF333333"/></top><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const workbook = XML_HEAD + `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><bookViews><workbookView/></bookViews><sheets>`
    + out.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>'
    + (out.some((s) => s.filter) ? `<definedNames>${out.map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name.replace(/'/g, "''"))}'!${s.filterRef}</definedName>` : '')).join('')}</definedNames>` : '')
    + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  const rels = (items) => XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = [
    { name: '[Content_Types].xml', data: XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + out.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`) },
    { name: 'docProps/core.xml', data: XML_HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>rfcode</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>rfcode</Application></Properties>' },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels(out.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${out.length + 1}" Type="${REL}/styles" Target="styles.xml"/>`) },
    { name: 'xl/styles.xml', data: styles },
    ...out.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, createZip(files));
  return { sheets: out.map((s) => ({ name: s.name, rows: s.rows })) };
}

module.exports = { readXlsx, createXlsx, asNumber, colName, colIndex, serialToISO, isoToSerial, FORMATS };
