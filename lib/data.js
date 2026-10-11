'use strict';
// Análise de dados com SQL: carrega CSV, TSV, Excel e JSON num SQLite em memória (node:sqlite) e roda a consulta.
// Bancos .db/.sqlite abrem só para leitura. Também gera o .xlsx (create_xlsx).

const fs = require('fs');
const path = require('path');
const { readXlsx, createXlsx, asNumber } = require('./xlsx');

// node:sqlite ainda emite aviso de recurso experimental; o aviso não interessa ao usuário.
let sqlite;
function loadSqlite() {
  if (sqlite) return sqlite;
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...rest) { if (/sqlite/i.test(String(w && w.message ? w.message : w))) return; return orig.call(process, w, ...rest); };
  try { sqlite = require('node:sqlite'); } catch { throw new Error('SQLite indisponível nesta versão do Node (precisa do Node 22.5 ou mais novo).'); } finally { process.emitWarning = orig; }
  return sqlite;
}

// ---------- leitura dos arquivos ----------
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  const s = buf.toString('utf8').replace(/^﻿/, '');
  return s.includes('�') ? buf.toString('latin1') : s; // planilha salva em ANSI pelo Excel
}

function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = ['\t', ';', ',', '|'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// [{ table, rows: [[cab...], ...] }] de um arquivo
function loadFile(full, alias) {
  const ext = path.extname(full).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    const sheets = readXlsx(full).filter((s) => s.rows.some((r) => r.length));
    return sheets.map((s, i) => {
      const rows = s.rows.filter((r) => r.some((v) => v !== '' && v != null));
      return { table: sheets.length === 1 ? alias : `${alias}_${slug(s.name) || i + 1}`, rows };
    });
  }
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') {
    const text = decode(fs.readFileSync(full));
    let data = ext === '.json' ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    if (!Array.isArray(data)) data = Array.isArray(Object.values(data).find(Array.isArray)) ? Object.values(data).find(Array.isArray) : [data];
    const cols = [...new Set(data.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : ['valor'])))];
    const val = (v) => (v != null && typeof v === 'object' ? JSON.stringify(v) : v);
    return [{ table: alias, rows: [cols, ...data.map((o) => (o && typeof o === 'object' ? cols.map((c) => val(o[c])) : [o]))] }];
  }
  return [{ table: alias, rows: parseCsv(decode(fs.readFileSync(full))) }];
}

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// cria a tabela: nomes de coluna simplificados (sem acento/espaço) e tipo número quando a coluna inteira é numérica
function createTable(db, table, rows) {
  const header = (rows[0] || []).map((h, i) => slug(h) || `col${i + 1}`);
  const seen = new Map();
  const cols = header.map((h) => { const n = (seen.get(h) || 0) + 1; seen.set(h, n); return n > 1 ? `${h}_${n}` : h; });
  const body = rows.slice(1);
  const numeric = cols.map((_, j) => body.some((r) => r[j] !== '' && r[j] != null) && body.every((r) => r[j] === '' || r[j] == null || asNumber(r[j]) != null));
  db.exec(`DROP TABLE IF EXISTS "${table}"; CREATE TABLE "${table}" (${cols.map((c, j) => `"${c}" ${numeric[j] ? 'REAL' : 'TEXT'}`).join(', ')})`);
  const ins = db.prepare(`INSERT INTO "${table}" VALUES (${cols.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  for (const r of body) ins.run(...cols.map((_, j) => {
    const v = r[j];
    if (v === '' || v == null) return null;
    if (numeric[j]) return asNumber(v);
    return typeof v === 'boolean' ? (v ? 1 : 0) : String(v);
  }));
  db.exec('COMMIT');
  return { table, cols, original: rows[0] || [], numeric, count: body.length };
}

// ---------- saída ----------
const fmtCell = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000)) : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '));
function mdTable(rows, limit = 200) {
  if (!rows.length) return '(nenhuma linha)';
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, limit);
  return [`| ${cols.join(' | ')} |`, `|${cols.map(() => ' --- ').join('|')}|`, ...shown.map((r) => `| ${cols.map((c) => fmtCell(r[c])).join(' | ')} |`)].join('\n')
    + (rows.length > limit ? `\n... mais ${rows.length - limit} linhas (use LIMIT ou save para gravar tudo)` : '');
}

function describeTable(db, info) {
  const lines = [`Tabela "${info.table}": ${info.count} linhas`];
  info.cols.forEach((c, j) => {
    const orig = info.original[j] != null && slug(info.original[j]) !== String(info.original[j]).trim().toLowerCase() ? ` (original: "${info.original[j]}")` : '';
    const st = db.prepare(`SELECT COUNT("${c}") AS n, COUNT(DISTINCT "${c}") AS d${info.numeric[j] ? `, MIN("${c}") AS mn, MAX("${c}") AS mx, AVG("${c}") AS av, SUM("${c}") AS sm` : ''} FROM "${info.table}"`).get();
    let extra = '';
    if (info.numeric[j]) extra = `mín ${fmtCell(st.mn)}, máx ${fmtCell(st.mx)}, média ${fmtCell(st.av)}, soma ${fmtCell(st.sm)}`;
    else {
      const top = db.prepare(`SELECT "${c}" AS v, COUNT(*) AS q FROM "${info.table}" WHERE "${c}" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`).all();
      extra = `${st.d} valores distintos; mais comuns: ${top.map((t) => `${String(t.v).slice(0, 30)} (${t.q})`).join(', ')}`;
    }
    lines.push(`- ${c}${orig} ${info.numeric[j] ? 'número' : 'texto'}${st.n < info.count ? `, ${info.count - st.n} vazios` : ''}: ${extra}`);
  });
  const sample = db.prepare(`SELECT * FROM "${info.table}" LIMIT 3`).all();
  return `${lines.join('\n')}\nExemplo:\n${mdTable(sample)}`;
}

function saveResult(rows, full) {
  const ext = path.extname(full).toLowerCase();
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  if (ext === '.xlsx') return createXlsx(full, { sheets: [{ name: 'Resultado', columns: cols, rows: rows.map((r) => cols.map((c) => r[c])) }] });
  if (ext === '.json') return fs.writeFileSync(full, JSON.stringify(rows, null, 2));
  const q = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(full, '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => q(r[c])).join(';'))].join('\r\n'));
}

/** files: "caminho" | { tabela: "caminho" }. Sem sql: descreve. save: grava o resultado. */
function dataQuery({ files, sql, save } = {}, cwd = process.cwd()) {
  const { DatabaseSync } = loadSqlite();
  if (!files) throw new Error('Informe files: o arquivo (ou { tabela: arquivo }) com os dados.');
  const map = typeof files === 'string' ? { [slug(path.basename(files, path.extname(files))) || 'dados']: files }
    : Array.isArray(files) ? Object.fromEntries(files.map((f) => [slug(path.basename(f, path.extname(f))) || 'dados', f])) : files;
  const entries = Object.entries(map).map(([alias, f]) => [slug(alias) || 'dados', path.resolve(cwd, String(f))]);
  for (const [, full] of entries) if (!fs.existsSync(full)) throw new Error(`Arquivo não encontrado: ${path.relative(cwd, full)}`);
  const dbFiles = entries.filter(([, f]) => /\.(db|sqlite3?|duckdb)$/i.test(f));
  // um banco SQLite sozinho: abre direto, só leitura
  const db = dbFiles.length === 1 && entries.length === 1 ? new DatabaseSync(dbFiles[0][1], { readOnly: true }) : new DatabaseSync(':memory:');
  try {
    const infos = [];
    for (const [alias, full] of entries) {
      if (/\.(db|sqlite3?)$/i.test(full)) {
        if (!(dbFiles.length === 1 && entries.length === 1)) db.exec(`ATTACH DATABASE '${full.replace(/'/g, "''")}' AS "${alias}"`);
        continue;
      }
      for (const t of loadFile(full, alias)) infos.push(createTable(db, t.table, t.rows));
    }
    if (!sql) {
      const parts = infos.map((i) => describeTable(db, i));
      if (dbFiles.length) {
        const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
        parts.push(`Banco ${path.basename(dbFiles[0][1])}:\n${schema.map((s) => s.sql).join(';\n')}`);
      }
      return `${parts.join('\n\n')}\n\nConsulte com sql (SQLite), usando os nomes de tabela e coluna acima.`;
    }
    const stmt = db.prepare(sql);
    if (!/^\s*(select|with|pragma|explain)\b/i.test(sql) && dbFiles.length) throw new Error('Bancos de dados abrem só para leitura: use SELECT.');
    const rows = /^\s*(select|with|pragma|explain|values)\b/i.test(sql) ? stmt.all() : (stmt.run(), []);
    if (save) {
      const out = path.resolve(cwd, save);
      saveResult(rows, out);
      return `${rows.length} linhas gravadas em ${path.relative(cwd, out).replace(/\\/g, '/')}.\n${mdTable(rows, 20)}`;
    }
    return `${rows.length} linha(s)\n${mdTable(rows)}`;
  } catch (e) {
    const tables = (() => { try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name).join(', '); } catch { return ''; } })();
    throw new Error(`${e.message}${tables ? ` (tabelas: ${tables}; rode sem sql para ver as colunas)` : ''}`);
  } finally { db.close(); }
}

const DATA_TOOL_DEFS = [
  {
    name: 'data_query',
    description: 'Analisa dados com SQL (SQLite) direto de CSV, TSV, Excel (.xlsx, cada aba vira tabela_aba), JSON e bancos .db/.sqlite (só leitura). '
      + 'Use para somar, agrupar, filtrar, cruzar e conferir números em vez de escrever scripts. Sem sql: mostra colunas (nomes simplificados, sem acento), tipos, estatísticas e exemplo. '
      + 'Com sql: devolve o resultado em tabela. save: grava o resultado em .csv, .xlsx ou .json.',
    parameters: {
      type: 'object',
      properties: {
        files: { description: 'Arquivo ("vendas.csv") ou mapa { tabela: arquivo } para cruzar vários', anyOf: [{ type: 'string' }, { type: 'object' }] },
        sql: { type: 'string', description: 'Consulta SQLite, ex.: SELECT regiao, SUM(receita) AS receita FROM vendas GROUP BY 1 ORDER BY 2 DESC' },
        save: { type: 'string', description: 'Opcional: arquivo de saída (.csv, .xlsx ou .json)' },
      },
      required: ['files'],
    },
  },
  {
    name: 'create_xlsx',
    description: 'Cria planilha Excel (.xlsx) formatada: cabeçalho destacado, larguras automáticas, filtro, cabeçalho congelado, formatos e fórmulas. '
      + 'sheets: [{ name, columns: [..], rows: [[..]] ou [{coluna: valor}], formats?: { coluna: "moeda"|"percentual"|"data"|"inteiro"|"numero"|código Excel }, totals?: true, widths? }]. '
      + 'Texto que começa com "=" vira fórmula (em inglês: =SUM(C2:C9)). Datas no formato AAAA-MM-DD. Percentual em fração (0,25 = 25%). '
      + 'Para salvar o resultado de uma consulta, use data_query com save.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo de saída (.xlsx)' },
        sheets: { type: 'array', items: { type: 'object' } },
      },
      required: ['path', 'sheets'],
    },
  },
];
const DATA_TOOLS = new Set(DATA_TOOL_DEFS.map((t) => t.name));

function runDataTool(name, args, cwd) {
  if (name === 'data_query') return dataQuery(args, cwd);
  if (name === 'create_xlsx') {
    const full = path.resolve(cwd, args.path || '');
    if (!/\.xlsx$/i.test(full)) throw new Error('O caminho deve terminar em .xlsx');
    let sheets = args.sheets;
    if (typeof sheets === 'string') sheets = JSON.parse(sheets);
    const r = createXlsx(full, { sheets });
    return `Planilha criada: ${path.relative(cwd, full).replace(/\\/g, '/')} (${r.sheets.map((s) => `${s.name}: ${s.rows} linhas`).join(', ')}).`;
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

function dataDescribe(name, a = {}) {
  if (name === 'data_query') return `Dados(${typeof a.files === 'string' ? a.files : Object.values(a.files || {}).join(', ')}${a.sql ? `: ${String(a.sql).replace(/\s+/g, ' ').slice(0, 70)}` : ''})`;
  if (name === 'create_xlsx') return `Excel(${a.path})`;
  return null;
}

module.exports = { DATA_TOOL_DEFS, DATA_TOOLS, runDataTool, dataDescribe, dataQuery, parseCsv };
