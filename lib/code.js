'use strict';
// Inteligência de código sem dependências: mapa de símbolos (classes, funções, métodos) em 12 linguagens,
// definição e referências, leitura de um símbolo só, grafo de imports e busca por significado (embeddings
// da NVIDIA, com busca por palavras quando não houver chave). Tudo com cache por arquivo (data + tamanho).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const MAX_FILES = 8000;
const MAX_SIZE = 1024 * 1024;
const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|out|target|vendor|\.venv|venv|__pycache__|\.next|\.nuxt|coverage|bin[\\/]Debug|bin[\\/]Release|obj|\.idea|\.vscode|\.rfcode|\.gradle|Pods|\.dart_tool)([\\/]|$)/;
const MINIFIED = /\.min\.(js|css)$|\.map$|\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/;

const LANGS = {
  js: /\.(m|c)?jsx?$/, ts: /\.(m|c)?tsx?$/, py: /\.pyw?$/, java: /\.java$/, cs: /\.cs$/, kt: /\.kts?$/, go: /\.go$/, rs: /\.rs$/,
  php: /\.php$/, rb: /\.rb$/, c: /\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/, sql: /\.sql$/, vue: /\.(vue|svelte)$/, swift: /\.swift$/, dart: /\.dart$/, scala: /\.scala$/,
};
const langOf = (f) => Object.keys(LANGS).find((k) => LANGS[k].test(f)) || null;

// ---------- arquivos ----------
function cacheDir(cwd) {
  const d = path.join(HOME(), 'cache', crypto.createHash('sha1').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 12));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// arquivos de código do projeto: git ls-files (respeita .gitignore) ou varredura pulando pastas geradas
function listCodeFiles(cwd, sub = '.') {
  const root = path.resolve(cwd, sub);
  let files = [];
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '--', sub], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    files = out.split('\n').filter(Boolean).map((f) => path.join(cwd, f));
  } catch {
    const walk = (d) => {
      if (files.length > MAX_FILES * 2) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const f = path.join(d, e.name);
        if (SKIP.test(path.relative(cwd, f))) continue;
        if (e.isDirectory()) walk(f); else files.push(f);
      }
    };
    walk(root);
  }
  return files.filter((f) => langOf(f) && !MINIFIED.test(f) && !SKIP.test(path.relative(cwd, f))).slice(0, MAX_FILES);
}

// ---------- símbolos ----------
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'new', 'typeof', 'await', 'with', 'sizeof', 'elif', 'foreach', 'using', 'lock', 'synchronized', 'super', 'this']);
const RULES = {
  js: [
    [/^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
    [/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
    [/^\s+(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*#?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{=]+)?\s*\{/, 'method'],
    [/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/, 'method'],
    [/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()/, 'function'],
  ],
  py: [[/^(\s*)class\s+(\w+)/, 'class'], [/^(\s*)(?:async\s+)?def\s+(\w+)/, 'function']],
  java: [
    [/^\s*(?:(?:public|private|protected|static|final|abstract|sealed|partial|internal|data|open)\s+)*(?:class|interface|enum|record|struct)\s+(\w+)/, 'class'],
    [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|native|default|suspend|open|inline)\s+)+(?:<[^>]+>\s+)?[\w<>[\],.?\s]+?\s+(\w+)\s*\([^;]*$/, 'method'],
    [/^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/, 'method'],
  ],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*[(\[]/, 'function'], [/^type\s+(\w+)\s+(?:struct|interface)/, 'class']],
  rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, 'function'], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/, 'class'], [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w:]+)/, 'impl']],
  php: [[/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/, 'class'], [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)\s*\(/, 'function']],
  rb: [[/^(\s*)(?:class|module)\s+([\w:]+)/, 'class'], [/^(\s*)def\s+(?:self\.)?([\w?!=]+)/, 'function']],
  c: [[/^\s*(?:class|struct|union|namespace)\s+(\w+)(?!.*;\s*$)/, 'class'], [/^(?!\s*(?:if|for|while|switch|return|else|do)\b)[\w:*&<>,~\s]+?\b([\w~]+(?:::[\w~]+)*)\s*\([^;]*\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override)?\s*\{?\s*$/, 'function']],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view|function|procedure|trigger|index)\s+(?:if\s+not\s+exists\s+)?([\w."[\]]+)/i, 'object']],
  swift: [[/^\s*(?:public\s+|private\s+|open\s+|internal\s+|final\s+)*(?:class|struct|enum|protocol|extension)\s+(\w+)/, 'class'], [/^\s*(?:(?:public|private|internal|open|static|override|mutating|@\w+)\s+)*func\s+(\w+)/, 'function']],
  dart: [[/^\s*(?:abstract\s+)?class\s+(\w+)/, 'class'], [/^\s*(?:static\s+)?(?:Future<[^>]*>|void|[\w<>?]+)\s+(\w+)\s*\([^;]*\{?\s*$/, 'method']],
};
RULES.ts = RULES.js; RULES.vue = RULES.js; RULES.cs = RULES.java; RULES.kt = RULES.java; RULES.scala = [[/^\s*(?:case\s+)?(?:class|object|trait)\s+(\w+)/, 'class'], [/^\s*(?:override\s+)?def\s+(\w+)/, 'function']];

function extractSymbols(text, lang) {
  const rules = RULES[lang] || [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const stack = []; // classes abertas, por indentação (para dizer de qual classe é o método)
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    const t = line.trim();
    if (inBlockComment) { if (t.includes('*/')) inBlockComment = false; continue; }
    if (t.startsWith('/*') && !t.includes('*/')) { inBlockComment = true; continue; }
    if (!t || t.startsWith('//') || t.startsWith('#') && lang !== 'py' && lang !== 'rb' || t.startsWith('*') || t.startsWith('--')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && indent <= stack[stack.length - 1].indent && !/^[)}\]]/.test(t)) stack.pop();
    for (const [re, kind] of rules) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[m.length - 1];
      if (!name || KEYWORDS.has(name)) continue;
      if (kind === 'method' && !stack.length && !['java', 'cs', 'kt', 'dart'].includes(lang) && /^\s+/.test(line) === false) continue;
      // função auxiliar declarada dentro de outra função (JS/TS): ruído no mapa
      if (['js', 'ts', 'vue'].includes(lang) && kind !== 'method' && kind !== 'class' && indent > 0 && !stack.length) continue;
      if (['js', 'ts', 'vue'].includes(lang) && kind === 'method' && !stack.length && indent > 2) continue;
      const parent = stack.length ? stack[stack.length - 1].name : null;
      const realKind = (kind === 'function' && parent && ['py', 'rb', 'php'].includes(lang)) ? 'method' : kind;
      out.push({ name, kind: realKind, line: i + 1, parent: realKind === 'method' ? parent : null, signature: t.replace(/\s*\{\s*$/, '').slice(0, 140) });
      if (['class', 'impl'].includes(kind)) stack.push({ name, indent });
      break;
    }
  }
  return out;
}

// índice do projeto: { arquivo: { mtime, size, lines, lang, symbols, imports } } com cache em disco
function buildIndex(cwd, sub = '.') {
  const file = path.join(cacheDir(cwd), 'symbols.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* sem cache */ }
  const files = listCodeFiles(cwd, sub);
  let changed = false;
  const index = {};
  for (const f of files) {
    const rel = path.relative(cwd, f).replace(/\\/g, '/');
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_SIZE) continue;
    const c = cache[rel];
    if (c && c.mtime === st.mtimeMs && c.size === st.size) { index[rel] = c; continue; }
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lang = langOf(f);
    index[rel] = { mtime: st.mtimeMs, size: st.size, lines: text.split('\n').length, lang, symbols: extractSymbols(text, lang), imports: extractImports(text, lang) };
    changed = true;
  }
  if (changed || Object.keys(cache).length !== Object.keys(index).length) {
    try { fs.writeFileSync(file, JSON.stringify(sub === '.' ? index : { ...cache, ...index })); } catch { /* cache é opcional */ }
  }
  return index;
}

// ---------- imports ----------
function extractImports(text, lang) {
  const out = new Set();
  const add = (s) => { if (s) out.add(s); };
  if (['js', 'ts', 'vue'].includes(lang)) {
    for (const m of text.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*|import\s+)['"]([^'"]+)['"]/g)) add(m[1]);
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import|^\s*import\s+([\w.]+)/gm)) add(m[1] || m[2]);
  } else if (['java', 'kt', 'scala'].includes(lang)) {
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) add(m[1]);
  } else if (lang === 'cs') {
    for (const m of text.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)) add(m[1]);
  } else if (lang === 'go') {
    for (const m of text.matchAll(/"([\w./-]+)"/g)) if (/import/.test(text.slice(Math.max(0, m.index - 300), m.index))) add(m[1]);
  } else if (lang === 'rs') {
    for (const m of text.matchAll(/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm)) add(m[1]);
  } else if (lang === 'php') {
    for (const m of text.matchAll(/^\s*use\s+([\w\\]+)|(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/gm)) add(m[1] || m[2]);
  } else if (lang === 'rb') {
    for (const m of text.matchAll(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm)) add(m[1]);
  } else if (lang === 'c') {
    for (const m of text.matchAll(/^\s*#\s*include\s+["<]([^">]+)[">]/gm)) add(m[1]);
  }
  return [...out].slice(0, 200);
}

// liga cada import a um arquivo do projeto (relativos de JS/TS/Python/Ruby/C; pacotes ficam de fora)
function resolveImport(fromRel, spec, index) {
  const files = Object.keys(index);
  const dir = path.posix.dirname(fromRel);
  const tryList = [];
  // relativo estilo JS/Ruby/C ("./x", "../x"); ".x" sem barra é import relativo do Python (tratado abaixo)
  if (/^\.\.?\//.test(spec)) {
    const base = path.posix.normalize(path.posix.join(dir, spec));
    tryList.push(base, ...['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.vue', '.h', '.hpp'].map((e) => base + e), ...['/index.js', '/index.ts', '/index.tsx', '/__init__.py'].map((e) => base + e));
  }
  if (/^\.*[\w.]+$/.test(spec) && !spec.includes('/')) {
    // python "pacote.modulo" e ".modulo"
    const dots = (/^\.+/.exec(spec) || [''])[0].length;
    const mod = spec.slice(dots).replace(/\./g, '/');
    let base = dots ? dir : '';
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    const p = (base ? `${base}/` : '') + mod;
    tryList.push(`${p}.py`, `${p}/__init__.py`);
    // java/kotlin/c#: Classe = arquivo
    const cls = spec.split('.').pop();
    const hit = files.find((f) => f.endsWith(`/${cls}.java`) || f.endsWith(`/${cls}.kt`) || f.endsWith(`/${cls}.cs`));
    if (hit && /\./.test(spec)) tryList.push(hit);
  }
  if (!spec.startsWith('.') && /\.(h|hpp)$/.test(spec)) tryList.push(...files.filter((f) => f.endsWith('/' + spec) || f === spec));
  return tryList.find((f) => index[f]) || null;
}

// grafo: { arquivo: { usa: [...], usadoPor: [...] } }
function importGraph(index) {
  const g = {};
  for (const f of Object.keys(index)) g[f] = { usa: [], usadoPor: [] };
  for (const [f, info] of Object.entries(index)) {
    for (const spec of info.imports || []) {
      const to = resolveImport(f, spec, index);
      if (to && to !== f) { g[f].usa.push(to); g[to].usadoPor.push(f); }
    }
  }
  return g;
}

// ---------- ferramentas ----------
function codeMap(cwd, { path: sub = '.', symbols = true } = {}) {
  const index = buildIndex(cwd, sub);
  const files = Object.keys(index).sort();
  if (!files.length) return 'Nenhum arquivo de código encontrado.';
  const totalLines = files.reduce((a, f) => a + index[f].lines, 0);
  const langs = {};
  for (const f of files) langs[index[f].lang] = (langs[index[f].lang] || 0) + 1;
  const header = `${files.length} arquivos, ${totalLines.toLocaleString('pt-BR')} linhas (${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}: ${n}`).join(', ')})`;
  const fmtFile = (f) => {
    const info = index[f];
    if (!symbols || !info.symbols.length) return `${f} (${info.lines} l.)`;
    const top = info.symbols.filter((s) => s.kind !== 'method');
    const methods = info.symbols.filter((s) => s.kind === 'method');
    const parts = top.map((s) => {
      const ms = methods.filter((m) => m.parent === s.name).map((m) => `${m.name}:${m.line}`);
      return `${s.kind === 'class' ? 'class ' : s.kind === 'type' ? 'type ' : ''}${s.name}:${s.line}${ms.length ? ` { ${ms.slice(0, 30).join(', ')}${ms.length > 30 ? ` +${ms.length - 30}` : ''} }` : ''}`;
    });
    const orphans = methods.filter((m) => !top.some((s) => s.name === m.parent));
    if (orphans.length) parts.push(...orphans.slice(0, 20).map((m) => `${m.name}:${m.line}`));
    return `${f} (${info.lines} l.): ${parts.slice(0, 60).join(', ')}${parts.length > 60 ? ` +${parts.length - 60}` : ''}`;
  };
  let body = files.map(fmtFile).join('\n');
  if (body.length > 14000) {
    // projeto grande: resumo por pasta e convite a detalhar
    const dirs = {};
    for (const f of files) {
      const d = f.includes('/') ? f.split('/').slice(0, Math.min(2, f.split('/').length - 1)).join('/') : '.';
      (dirs[d] ||= { files: 0, lines: 0, symbols: 0 });
      dirs[d].files++; dirs[d].lines += index[f].lines; dirs[d].symbols += index[f].symbols.length;
    }
    body = `Projeto grande: resumo por pasta (rode code_map com path para ver os símbolos de uma pasta).\n${Object.entries(dirs).sort((a, b) => b[1].lines - a[1].lines).map(([d, v]) => `${d}/  ${v.files} arquivos, ${v.lines} linhas, ${v.symbols} símbolos`).join('\n')}`;
    const g = importGraph(index);
    const central = Object.entries(g).sort((a, b) => b[1].usadoPor.length - a[1].usadoPor.length).slice(0, 12).filter(([, v]) => v.usadoPor.length);
    if (central.length) body += `\n\nArquivos mais usados (centrais na arquitetura):\n${central.map(([f, v]) => `${f} (usado por ${v.usadoPor.length})`).join('\n')}`;
  }
  return `${header}\nFormato: arquivo (linhas): símbolo:linha { métodos:linha }\n${body}`;
}

function findSymbol(cwd, { name, kind } = {}) {
  if (!name) throw new Error('Informe name.');
  const index = buildIndex(cwd);
  const q = String(name).toLowerCase().replace(/^.*[.:#]/, '');
  const parentQ = /[.:#]/.test(name) ? String(name).toLowerCase().split(/[.:#]+/)[0] : null;
  const hits = [];
  for (const [f, info] of Object.entries(index)) {
    for (const s of info.symbols) {
      const n = s.name.toLowerCase();
      const exact = n === q;
      if (!exact && !n.includes(q)) continue;
      if (kind && s.kind !== kind) continue;
      if (parentQ && (s.parent || '').toLowerCase() !== parentQ) continue;
      hits.push({ ...s, file: f, score: exact ? 0 : 1 });
    }
  }
  hits.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
  if (!hits.length) return `Nenhuma definição de "${name}". Tente code_search (por significado) ou find_references.`;
  return hits.slice(0, 40).map((h) => `${h.file}:${h.line}  ${h.kind}${h.parent ? ` de ${h.parent}` : ''}  ${h.signature}`).join('\n') + (hits.length > 40 ? `\n... mais ${hits.length - 40}` : '');
}

function findReferences(cwd, { name, path: sub = '.' } = {}) {
  if (!name || !/^[\w$.:]+$/.test(name)) throw new Error('Informe name (identificador).');
  const word = String(name).split(/[.:]/).pop();
  const re = new RegExp(`(^|[^\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`);
  const index = buildIndex(cwd, sub);
  const out = [];
  let total = 0;
  for (const f of Object.keys(index).sort()) {
    let text;
    try { text = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { continue; }
    if (!text.includes(word)) continue;
    const defs = new Set(index[f].symbols.filter((s) => s.name === word).map((s) => s.line));
    const lines = text.split(/\r?\n/);
    const hits = [];
    // ignora menções em comentários ("// soma com desconto")
    const noComment = (l) => l.replace(/\/\/.*$/, '').replace(/^\s*(#|\*|\/\*|--).*$/, '').replace(/\s#\s.*$/, '');
    lines.forEach((l, i) => { if (re.test(noComment(l)) && !defs.has(i + 1)) hits.push(`  ${i + 1}: ${l.trim().slice(0, 160)}`); });
    if (hits.length) { total += hits.length; out.push(`${f} (${hits.length})\n${hits.slice(0, 15).join('\n')}${hits.length > 15 ? `\n  ... mais ${hits.length - 15}` : ''}`); }
    if (total > 400) break;
  }
  return out.length ? `${total} usos de ${word} em ${out.length} arquivos:\n${out.join('\n')}` : `Nenhum uso de ${word} além da definição.`;
}

// corpo completo de uma função/classe: chaves balanceadas ou indentação (Python, Ruby)
function symbolRange(lines, start, lang) {
  if (lang === 'py') {
    const ind = lines[start].length - lines[start].trimStart().length;
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (lines[i].length - lines[i].trimStart().length <= ind) break;
      end = i;
    }
    return end;
  }
  if (lang === 'rb') {
    const ind = lines[start].length - lines[start].trimStart().length;
    for (let i = start + 1; i < lines.length; i++) if (/^\s*end\b/.test(lines[i]) && lines[i].length - lines[i].trimStart().length === ind) return i;
    return Math.min(lines.length - 1, start + 80);
  }
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) {
    // ignora chaves dentro de strings e comentários simples
    const l = lines[i].replace(/\/\/.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const ch of l) {
      if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && i > start && /;\s*$/.test(l) && !/[({,]\s*$/.test(lines[start])) return i; // declaração sem corpo
    if (i - start > 3000) break;
  }
  return Math.min(lines.length - 1, start + 200);
}

function readSymbol(cwd, { name, path: p } = {}) {
  if (!name) throw new Error('Informe name.');
  const index = buildIndex(cwd);
  const q = String(name).replace(/^.*[.:#]/, '');
  const parentQ = /[.:#]/.test(name) ? String(name).split(/[.:#]+/)[0] : null;
  let hits = [];
  for (const [f, info] of Object.entries(index)) {
    if (p && !f.toLowerCase().includes(String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())) continue;
    for (const s of info.symbols) if (s.name === q && (!parentQ || s.parent === parentQ)) hits.push({ ...s, file: f, lang: info.lang });
  }
  if (!hits.length) return `Não achei a definição de "${name}"${p ? ` em ${p}` : ''}. Use find_symbol para procurar nomes parecidos.`;
  if (hits.length > 1 && !p && !parentQ) hits = hits.slice(0, 1).concat(hits.slice(1));
  const h = hits[0];
  const lines = fs.readFileSync(path.join(cwd, h.file), 'utf8').split(/\r?\n/);
  let from = h.line - 1;
  // comentários e decorators logo acima
  while (from > 0 && /^\s*(\/\/|\*|\/\*\*|#|@|\/\/\/|""")/.test(lines[from - 1])) from--;
  const end = symbolRange(lines, h.line - 1, h.lang);
  const MAXL = 400;
  const body = lines.slice(from, Math.min(end + 1, from + MAXL)).map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join('\n');
  const more = hits.length > 1 ? `\n\nOutras definições com esse nome: ${hits.slice(1, 8).map((x) => `${x.file}:${x.line}`).join(', ')} (use path para escolher).` : '';
  return `${h.file}:${h.line}-${end + 1} (${h.kind}${h.parent ? ` de ${h.parent}` : ''})\n${body}${end + 1 - from > MAXL ? `\n... (${end + 1 - from - MAXL} linhas a mais; use read_file com offset)` : ''}${more}`;
}

function codeDeps(cwd, { path: p } = {}) {
  const index = buildIndex(cwd);
  const g = importGraph(index);
  if (!p) {
    const central = Object.entries(g).sort((a, b) => b[1].usadoPor.length - a[1].usadoPor.length).slice(0, 20).filter(([, v]) => v.usadoPor.length);
    const entry = Object.entries(g).filter(([, v]) => !v.usadoPor.length && v.usa.length).sort((a, b) => b[1].usa.length - a[1].usa.length).slice(0, 10);
    return `Arquivos mais usados (núcleo):\n${central.map(([f, v]) => `- ${f} (usado por ${v.usadoPor.length}, usa ${v.usa.length})`).join('\n') || '(nenhum import interno encontrado)'}`
      + `\n\nPontos de entrada prováveis (usam outros e ninguém os importa):\n${entry.map(([f, v]) => `- ${f} (usa ${v.usa.length})`).join('\n') || '(nenhum)'}`;
  }
  const rel = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const f = g[rel] ? rel : Object.keys(g).find((x) => x.endsWith(rel));
  if (!f) throw new Error(`Arquivo não encontrado no índice: ${p}`);
  const ext = (index[f].imports || []).filter((s) => !resolveImport(f, s, index));
  // impacto: quem depende direta ou indiretamente (útil antes de mudar uma função central)
  const seen = new Set(); const queue = [...g[f].usadoPor];
  while (queue.length && seen.size < 500) { const x = queue.shift(); if (seen.has(x) || x === f) continue; seen.add(x); queue.push(...g[x].usadoPor); }
  return `${f}\nUsa (do projeto): ${g[f].usa.join(', ') || 'nada'}\nUsa (pacotes externos): ${ext.slice(0, 30).join(', ') || 'nada'}\nUsado por: ${g[f].usadoPor.join(', ') || 'ninguém'}`
    + `\nImpacto de mudar (dependentes diretos e indiretos): ${seen.size} arquivo(s)${seen.size ? `: ${[...seen].slice(0, 40).join(', ')}${seen.size > 40 ? '...' : ''}` : ''}`;
}

// ---------- busca por significado ----------
function chunksFor(cwd, index) {
  const chunks = [];
  for (const [f, info] of Object.entries(index)) {
    let lines;
    try { lines = fs.readFileSync(path.join(cwd, f), 'utf8').split(/\r?\n/); } catch { continue; }
    const tops = info.symbols.filter((s) => s.kind !== 'type').sort((a, b) => a.line - b.line);
    const covered = new Set();
    for (const s of tops) {
      const end = Math.min(symbolRange(lines, s.line - 1, info.lang), s.line - 1 + 80);
      const text = lines.slice(s.line - 1, end + 1).join('\n');
      for (let i = s.line - 1; i <= end; i++) covered.add(i);
      chunks.push({ file: f, line: s.line, end: end + 1, name: s.parent ? `${s.parent}.${s.name}` : s.name, text: `${f} ${s.parent ? s.parent + '.' : ''}${s.name}\n${text}`.slice(0, 3000) });
    }
    // o resto do arquivo (constantes, configuração, código solto) em blocos de 60 linhas
    for (let i = 0; i < lines.length; i += 60) {
      const seg = []; for (let k = i; k < Math.min(i + 60, lines.length); k++) if (!covered.has(k)) seg.push(lines[k]);
      const t = seg.join('\n').trim();
      if (t.length > 80) chunks.push({ file: f, line: i + 1, end: Math.min(i + 60, lines.length), name: '', text: `${f}\n${t}`.slice(0, 3000) });
    }
  }
  return chunks.slice(0, 6000);
}

const words = (t) => (String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z_][a-z0-9_]{2,}/g) || [])
  .flatMap((w) => [w, ...w.split('_'), ...w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')]).filter((w) => w.length > 2);

// busca por palavras (BM25 simples) quando não há embeddings
function keywordSearch(chunks, query, k) {
  const q = [...new Set(words(query))];
  const N = chunks.length;
  const df = new Map();
  const toks = chunks.map((c) => { const w = words(c.text); new Set(w).forEach((x) => df.set(x, (df.get(x) || 0) + 1)); return w; });
  const avg = toks.reduce((a, t) => a + t.length, 0) / Math.max(1, N);
  return chunks.map((c, i) => {
    const tf = new Map(); toks[i].forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    let s = 0;
    for (const w of q) { const f = tf.get(w) || 0; if (!f) continue; const idf = Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * toks[i].length / avg)); }
    return { c, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
}

// o modelo de embeddings é multimodal: "data:image/..." ou URL de imagem no texto vira pedido de imagem e dá erro
const sanitize = (t) => String(t)
  .replace(/data:[a-z]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[dados]')
  .replace(/https?:\/\/\S+?\.(png|jpe?g|gif|webp|svg|bmp|ico)\b\S*/gi, '[imagem]')
  .replace(/data:image\/[\w.+-]+/gi, '[imagem]');

async function embedBatch(texts, type, ep) {
  try { return await embed(texts, type, ep); } catch (e) {
    if (!/HTTP 400/.test(e.message)) throw e;
    if (texts.length === 1) return [null];
    // um trecho problemático não derruba o lote: tenta um a um e deixa vetor vazio para o que falhar
    const out = [];
    for (const t of texts) { try { out.push((await embed([t], type, ep))[0]); } catch { out.push(null); } }
    return out;
  }
}

async function embed(texts, type, ep) {
  texts = texts.map(sanitize);
  const res = await fetch(`${ep.baseUrl}/embeddings`, {
    method: 'POST', headers: ep.headers,
    body: JSON.stringify({ model: ep.model, input: texts, input_type: type, encoding_format: 'float', truncate: 'END' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return j.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

async function codeSearch(cwd, { query, limit = 8, path: sub = '.' } = {}, { embedEndpoint, onProgress } = {}) {
  if (!query) throw new Error('Informe query (o que procura, em linguagem natural).');
  const index = buildIndex(cwd, sub);
  const chunks = chunksFor(cwd, index);
  if (!chunks.length) return 'Nenhum código para pesquisar.';
  let ranked, how;
  if (embedEndpoint) {
    try {
      const file = path.join(cacheDir(cwd), 'embeddings.json');
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primeira vez */ }
      const hash = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
      const missing = chunks.filter((c) => !(hash(c.text) in cache)); // 0 = trecho que o modelo recusou (não tenta de novo)
      for (let i = 0; i < missing.length; i += 48) {
        if (onProgress) onProgress(`Indexando o código para busca por significado: ${Math.min(i + 48, missing.length)}/${missing.length} trechos...`);
        const vecs = await embedBatch(missing.slice(i, i + 48).map((c) => c.text), 'passage', embedEndpoint);
        missing.slice(i, i + 48).forEach((c, k) => { cache[hash(c.text)] = vecs[k] ? Array.from(vecs[k], (v) => Math.round(v * 10000) / 10000) : 0; });
      }
      if (missing.length) {
        const live = new Set(chunks.map((c) => hash(c.text)));
        for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
        fs.writeFileSync(file, JSON.stringify(cache));
      }
      const [qv] = await embed([query], 'query', embedEndpoint);
      // mistura significado (embeddings) com palavras exatas: nomes de função e termos técnicos pesam
      const kw = new Map(keywordSearch(chunks, query, 60).map((x, i) => [x.c, 1 - i / 60]));
      ranked = chunks.map((c) => ({ c, s: (cache[hash(c.text)] ? cos(qv, cache[hash(c.text)]) : 0) + 0.15 * (kw.get(c) || 0) })).sort((a, b) => b.s - a.s).slice(0, limit);
      how = 'por significado';
    } catch (e) {
      ranked = keywordSearch(chunks, query, limit);
      how = `por palavras (embeddings indisponíveis: ${e.message.slice(0, 80)})`;
    }
  } else {
    ranked = keywordSearch(chunks, query, limit);
    how = 'por palavras';
  }
  if (!ranked.length) return `Nada encontrado para "${query}".`;
  return `Busca ${how}, ${chunks.length} trechos indexados. Melhores resultados:\n` + ranked.map(({ c }, i) => {
    const preview = c.text.split('\n').slice(1, 7).map((l) => `    ${l.slice(0, 140)}`).join('\n');
    return `${i + 1}. ${c.file}:${c.line}-${c.end}${c.name ? ` (${c.name})` : ''}\n${preview}`;
  }).join('\n') + '\nAbra o trecho completo com read_symbol ou read_file.';
}

module.exports = { listCodeFiles, extractSymbols, extractImports, buildIndex, importGraph, codeMap, findSymbol, findReferences, readSymbol, codeDeps, codeSearch, keywordSearch, langOf };
