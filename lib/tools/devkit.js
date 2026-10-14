'use strict';
// Kit de desenvolvimento (sob demanda): análise de projeto, refatoração em massa, diff, consulta a JSON,
// checksums e benchmark. Quase tudo é leitura/cálculo puro; só replace_in_files (ao aplicar) e bench executam.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('node:vm');
const { run } = require('./_exec');

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.worktrees', 'coverage', '.cache']);
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|ps1|sql|json|ya?ml|toml|ini|md|txt|html?|css|scss|vue|svelte)$/i;

function walk(root, { onFile, filter, maxFiles = 20000 }) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE.has(e.name) && !e.name.startsWith('.')) stack.push(full); continue; }
      if (filter && !filter(full)) continue;
      onFile(full);
      if (++count >= maxFiles) return count;
    }
  }
  return count;
}

// ---------- detect_stack ----------
function detectStack(a, { cwd }) {
  const root = a.dir ? path.resolve(cwd, a.dir) : cwd;
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const exists = (f) => fs.existsSync(path.join(root, f));
  const extCount = {};
  walk(root, { filter: (f) => TEXT_EXT.test(f), onFile: (f) => { const e = (f.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase(); extCount[e] = (extCount[e] || 0) + 1; } });
  const topLangs = Object.entries(extCount).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([e, n]) => `${e} (${n})`);

  const out = [`Projeto em ${path.basename(root)}`];
  out.push(`Linguagens por arquivo: ${topLangs.join(', ') || '(nenhuma reconhecida)'}`);

  if (exists('package.json')) {
    let pkg = {}; try { pkg = JSON.parse(read('package.json')); } catch { /* ignora */ }
    const pm = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : exists('bun.lockb') ? 'bun' : 'npm';
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const fw = ['next', 'react', 'vue', 'svelte', '@angular/core', 'astro', 'express', 'fastify', 'nestjs', '@nestjs/core', 'electron', 'vite', 'webpack', 'jest', 'vitest', 'mocha', 'typescript']
      .filter((d) => deps[d]);
    out.push(`Node/JS: gerenciador ${pm}. Scripts: ${Object.keys(pkg.scripts || {}).join(', ') || '(nenhum)'}.`);
    if (fw.length) out.push(`Bibliotecas/frameworks: ${fw.join(', ')}.`);
    if (pkg.scripts) {
      const g = (k) => (pkg.scripts[k] ? `${pm} run ${k}` : '');
      out.push(`Comandos prováveis: testar=${pkg.scripts.test ? `${pm} test` : '?'}, build=${g('build') || '?'}, dev=${g('dev') || g('start') || '?'}.`);
    }
  }
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py')) out.push('Python: veja requirements.txt/pyproject.toml; testes com pytest em geral.');
  if (exists('Cargo.toml')) out.push('Rust: cargo build / cargo test / cargo run.');
  if (exists('go.mod')) out.push('Go: go build ./... / go test ./...');
  if (exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts')) out.push('Java/JVM: Maven (pom.xml) ou Gradle.');
  if (exists('Dockerfile')) out.push('Tem Dockerfile.');
  if (exists('docker-compose.yml') || exists('compose.yaml')) out.push('Tem docker-compose.');
  for (const f of ['README.md', 'RFCODE.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md']) if (exists(f)) { out.push(`Instruções em ${f}.`); }
  return out.join('\n');
}

// ---------- replace_in_files (refatoração em massa) ----------
function replaceInFiles(a, { cwd }) {
  if (!a.pattern) throw new Error('Informe pattern (expressão regular a procurar).');
  const root = a.dir ? path.resolve(cwd, a.dir) : cwd;
  let re;
  try { re = new RegExp(a.pattern, a.flags || 'g'); } catch (e) { throw new Error(`Regex inválida: ${e.message}`); }
  if (!re.flags.includes('g')) re = new RegExp(re.source, re.flags + 'g');
  const repl = a.replacement != null ? String(a.replacement) : '';
  const include = a.include ? new RegExp(a.include) : TEXT_EXT;
  const dry = a.apply !== true;
  const hits = [];
  let changedFiles = 0; let changedCount = 0;
  walk(root, {
    filter: (f) => include.test(f),
    onFile: (f) => {
      let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return; }
      if (txt.length > 2_000_000) return;
      const m = txt.match(re);
      const n = m ? m.length : 0;
      if (!n) return;
      const next = txt.replace(re, repl); // replace nativo já entende $1, $&
      changedFiles += 1; changedCount += n;
      if (hits.length < 20) hits.push(`${path.relative(cwd, f).replace(/\\/g, '/')}: ${n} ocorrência(s)`);
      if (!dry) fs.writeFileSync(f, next);
    },
  });
  const head = `${dry ? 'Prévia (nada alterado)' : 'Aplicado'}: ${changedCount} ocorrência(s) em ${changedFiles} arquivo(s) de "${a.pattern}".`;
  const body = hits.length ? `\n${hits.join('\n')}${changedFiles > hits.length ? `\n... e mais ${changedFiles - hits.length} arquivo(s)` : ''}` : '\n(nenhuma ocorrência)';
  return head + body + (dry && changedCount ? '\n\nPara efetivar, chame de novo com apply: true.' : '');
}

// ---------- diff (gera diff unificado) ----------
function lcsDiff(aLines, bLines) {
  const n = aLines.length; const m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push([' ', aLines[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', aLines[i]]); i++; }
    else { ops.push(['+', bLines[j]]); j++; }
  }
  while (i < n) ops.push(['-', aLines[i++]]);
  while (j < m) ops.push(['+', bLines[j++]]);
  return ops;
}

function makeDiff(a, { cwd }) {
  const get = (f, t) => (t != null ? String(t) : (f ? fs.readFileSync(path.resolve(cwd, f), 'utf8') : ''));
  const A = get(a.a_file, a.a_text);
  const B = get(a.b_file, a.b_text);
  if (a.a_file == null && a.a_text == null) throw new Error('Informe a_file ou a_text (lado A).');
  const ops = lcsDiff(A.split('\n'), B.split('\n'));
  if (!ops.some((o) => o[0] !== ' ')) return 'Sem diferenças.';
  const nameA = a.a_file || 'a'; const nameB = a.b_file || 'b';
  const body = ops.map(([s, l]) => `${s}${l}`).join('\n');
  return `--- ${nameA}\n+++ ${nameB}\n${body}`;
}

// ---------- json_query ----------
function jsonQuery(a, { cwd }) {
  let data;
  if (a.file) { data = JSON.parse(fs.readFileSync(path.resolve(cwd, a.file), 'utf8')); }
  else if (a.json !== undefined) { data = typeof a.json === 'string' ? JSON.parse(a.json) : a.json; }
  else throw new Error('Informe file (arquivo .json) ou json (valor).');
  const q = String(a.query || 'data').trim();
  if (/\b(require|process|global|import|eval|Function|constructor|__proto__|fetch|while\s*\(\s*true)/.test(q)) throw new Error('Consulta não permitida.');
  let result;
  try { result = vm.runInNewContext(`(()=>{"use strict"; return (${q}); })()`, { data, Math, JSON, Object, Array, Number, String, Date }, { timeout: 1000 }); }
  catch (e) { throw new Error(`Erro na consulta: ${e.message}`); }
  const out = typeof result === 'object' && result !== null ? JSON.stringify(result, null, 2) : String(result);
  return out.length > 12000 ? `${out.slice(0, 12000)}\n... [truncado]` : out;
}

// ---------- hash ----------
function doHash(a, { cwd }) {
  const algo = (a.algorithm || 'sha256').toLowerCase();
  if (!crypto.getHashes().includes(algo)) throw new Error(`Algoritmo desconhecido: ${algo}`);
  let buf;
  if (a.file) buf = fs.readFileSync(path.resolve(cwd, a.file));
  else if (a.text != null) buf = Buffer.from(String(a.text), 'utf8');
  else throw new Error('Informe file ou text.');
  return `${algo}: ${crypto.createHash(algo).update(buf).digest('hex')}  (${buf.length} bytes)`;
}

// ---------- bench ----------
function bench(a, { cwd, signal }) {
  const cmd = String(a.command || '').trim();
  if (!cmd) throw new Error('Informe command (comando a medir).');
  const runs = Math.max(1, Math.min(50, Number(a.runs) || 5));
  const sh = process.platform === 'win32' ? ['cmd', ['/c', cmd]] : ['bash', ['-lc', cmd]];
  const times = [];
  let lastCode = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const r = run(sh[0], sh[1], { cwd, signal, timeout: 600000 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(ms); lastCode = r.code;
    if (r.code !== 0 && !a.ignore_errors) return `O comando falhou (código ${r.code}) na execução ${i + 1}. Abortei o benchmark.\n\n${r.out}`;
  }
  times.sort((x, y) => x - y);
  const sum = times.reduce((s, x) => s + x, 0);
  const fmt = (n) => `${n.toFixed(1)} ms`;
  return `Benchmark de "${cmd}" (${runs} execuções, código final ${lastCode}):\n`
    + `min ${fmt(times[0])} | mediana ${fmt(times[Math.floor(times.length / 2)])} | média ${fmt(sum / times.length)} | max ${fmt(times[times.length - 1])}`;
}

module.exports = {
  defs: [
    { name: 'detect_stack', description: 'Analisa o projeto e resume a stack: linguagens predominantes, gerenciador de pacotes, scripts, frameworks e os comandos prováveis de testar/buildar/rodar. Use no começo para se situar rápido; combine com learn para guardar o que descobrir.', parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Subpasta a analisar (padrão: raiz)' } } } },
    { name: 'replace_in_files', description: 'Busca e substitui por expressão regular em vários arquivos de código (refatoração em massa). Por padrão faz uma PRÉVIA sem alterar nada; chame com apply: true para efetivar. include limita por regex no caminho; dir limita a subpasta. replacement aceita grupos ($1).', parameters: { type: 'object', properties: { pattern: { type: 'string' }, replacement: { type: 'string' }, flags: { type: 'string', description: 'Flags da regex, ex.: "gi"' }, include: { type: 'string', description: 'Regex no caminho do arquivo' }, dir: { type: 'string' }, apply: { type: 'boolean', description: 'true efetiva (padrão: só prévia)' } }, required: ['pattern'] } },
    { name: 'diff', description: 'Gera um diff unificado entre dois textos ou dois arquivos (lado A e lado B). Útil para revisar mudanças ou produzir um patch para apply_patch.', parameters: { type: 'object', properties: { a_file: { type: 'string' }, b_file: { type: 'string' }, a_text: { type: 'string' }, b_text: { type: 'string' } } } },
    { name: 'json_query', description: 'Lê um JSON (de arquivo ou inline) e avalia uma expressão JavaScript sobre ele (acessível como "data"), num sandbox sem acesso a sistema. Ex.: query "data.items.length" ou "data.users.map(u=>u.name)".', parameters: { type: 'object', properties: { file: { type: 'string' }, json: { description: 'JSON inline (string ou valor)' }, query: { type: 'string', description: 'Expressão sobre "data" (padrão: data)' } } } },
    { name: 'hash', description: 'Calcula o checksum (md5, sha1, sha256...) de um arquivo ou texto, para verificar integridade. algorithm padrão sha256.', parameters: { type: 'object', properties: { file: { type: 'string' }, text: { type: 'string' }, algorithm: { type: 'string' } } } },
    { name: 'bench', description: 'Mede o tempo de um comando rodando-o várias vezes e reporta min/mediana/média/max. runs padrão 5. Para benchmark de performance.', parameters: { type: 'object', properties: { command: { type: 'string' }, runs: { type: 'number' }, ignore_errors: { type: 'boolean' } }, required: ['command'] } },
  ],
  run(name, a, ctx) {
    switch (name) {
      case 'detect_stack': return detectStack(a, ctx);
      case 'replace_in_files': return replaceInFiles(a, ctx);
      case 'diff': return makeDiff(a, ctx);
      case 'json_query': return jsonQuery(a, ctx);
      case 'hash': return doHash(a, ctx);
      case 'bench': return bench(a, ctx);
      default: throw new Error(`desconhecida: ${name}`);
    }
  },
  describe(name, a) {
    if (name === 'replace_in_files') return `Substituir(${String(a.pattern || '').slice(0, 40)}${a.apply ? ' [aplicar]' : ' [prévia]'})`;
    if (name === 'bench') return `Bench(${String(a.command || '').slice(0, 50)})`;
    if (name === 'diff') return `Diff(${a.a_file || 'A'} vs ${a.b_file || 'B'})`;
    if (name === 'json_query') return `JSON(${String(a.query || 'data').slice(0, 40)})`;
    if (name === 'hash') return `Hash(${a.algorithm || 'sha256'} ${a.file || 'texto'})`;
    return `Stack(${a.dir || '.'})`;
  },
  // só escrevem/executam: replace_in_files quando apply, e bench (roda comando). O resto é leitura.
  needsApproval: (name, a) => (name === 'replace_in_files' && a && a.apply === true) || name === 'bench',
  group: {
    name: 'dev', desc: 'kit de dev: analisar stack, refatorar em massa (regex), diff, consultar JSON, checksums e benchmark',
    hint: /\b(refatora|substitu|regex|express[aã]o regular|stack|arquitetura|detectar|checksum|hash|sha256|md5|benchmark|medir tempo|performance|diff|json)\b/i,
  },
  _test: { detectStack, replaceInFiles, makeDiff, jsonQuery, doHash, lcsDiff },
};
