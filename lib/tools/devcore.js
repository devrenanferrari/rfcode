'use strict';
// Ferramentas centrais de código (sempre disponíveis):
// - apply_patch: aplica um diff unificado (várias arquivos/hunks de uma vez), como fazem Claude Code e Codex.
// - run_tests: descobre sozinho como o projeto roda os testes e roda, resumindo o resultado.

const fs = require('fs');
const path = require('path');
const { run, has } = require('./_exec');

// ---------- apply_patch (diff unificado) ----------
function parsePatch(text) {
  const lines = text.split(/\r?\n/);
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('--- ')) {
      const minus = l.slice(4).trim();
      const plusLine = lines[i + 1] || '';
      if (!plusLine.startsWith('+++ ')) continue;
      i += 1;
      const plus = plusLine.slice(4).trim();
      const strip = (p) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '');
      cur = { from: minus === '/dev/null' ? null : strip(minus), to: plus === '/dev/null' ? null : strip(plus), hunks: [] };
      files.push(cur);
    } else if (l.startsWith('@@') && cur) {
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Error(`Cabeçalho de hunk inválido: ${l}`);
      const oldCount = m[2] === undefined ? 1 : +m[2];
      const newCount = m[4] === undefined ? 1 : +m[4];
      const hunk = { oldStart: +m[1], lines: [] };
      // consome exatamente as linhas que o cabeçalho declara (evita pegar lixo ou a linha em branco final)
      let seenOld = 0; let seenNew = 0;
      while (i + 1 < lines.length && (seenOld < oldCount || seenNew < newCount)) {
        const dl = lines[++i];
        if (dl.startsWith('\\')) continue; // "\ No newline at end of file"
        const c = dl[0];
        if (c === '-') { hunk.lines.push(dl); seenOld += 1; }
        else if (c === '+') { hunk.lines.push(dl); seenNew += 1; }
        else if (c === ' ') { hunk.lines.push(dl); seenOld += 1; seenNew += 1; }
        else if (dl === '') { hunk.lines.push(' '); seenOld += 1; seenNew += 1; } // linha de contexto vazia
        else { i -= 1; break; } // fim do hunk
      }
      cur.hunks.push(hunk);
    }
  }
  if (!files.length) throw new Error('Nenhum arquivo encontrado no patch (esperado formato diff unificado com ---/+++ e @@).');
  return files;
}

function applyHunks(src, hunks) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  let lines = src.length ? src.split(/\r?\n/) : [];
  // aplica de baixo para cima para os índices não deslocarem
  const located = hunks.map((h) => {
    const want = h.lines.filter((x) => x[0] === ' ' || x[0] === '-').map((x) => x.slice(1));
    let at = h.oldStart - 1;
    const matches = (pos) => want.every((w, k) => (lines[pos + k] ?? null) !== null && lines[pos + k].replace(/\s+$/, '') === w.replace(/\s+$/, ''));
    if (!matches(at)) {
      at = -1;
      for (let p = 0; p + want.length <= lines.length; p++) { if (matches(p)) { at = p; break; } }
      if (at < 0) throw new Error(`Não encontrei o contexto do hunk (começava na linha ${h.oldStart}). O arquivo mudou desde o diff?`);
    }
    return { at, h };
  }).sort((a, b) => b.at - a.at);

  for (const { at, h } of located) {
    const out = [];
    for (const dl of h.lines) { if (dl[0] === '+') out.push(dl.slice(1)); else if (dl[0] === ' ') out.push(dl.slice(1)); }
    const removed = h.lines.filter((x) => x[0] === ' ' || x[0] === '-').length;
    lines.splice(at, removed, ...out);
  }
  return lines.join(nl);
}

function applyPatch(a, { cwd }) {
  const text = String(a.patch || '');
  if (!text.trim()) throw new Error('Informe o patch (diff unificado).');
  const files = parsePatch(text);
  const done = [];
  for (const f of files) {
    const rel = f.to || f.from;
    const abs = path.resolve(cwd, rel);
    if (f.from === null) { // novo arquivo
      const content = f.hunks.flatMap((h) => h.lines.filter((x) => x[0] === '+').map((x) => x.slice(1))).join('\n');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content + (content.endsWith('\n') ? '' : '\n'));
      done.push(`criado ${rel}`); continue;
    }
    if (f.to === null) { // apagado
      fs.rmSync(path.resolve(cwd, f.from), { force: true });
      done.push(`apagado ${f.from}`); continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    const out = applyHunks(src, f.hunks);
    fs.writeFileSync(abs, out);
    done.push(`alterado ${rel}`);
  }
  return `Patch aplicado em ${files.length} arquivo(s):\n- ${done.join('\n- ')}`;
}

// ---------- run_tests (descobre e roda) ----------
function detectTestCmd(cwd, { e2e = false } = {}) {
  const read = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };
  const exists = (f) => fs.existsSync(path.join(cwd, f));
  if (exists('package.json')) {
    let pkg = {}; try { pkg = JSON.parse(read('package.json')); } catch { /* ignora */ }
    const pm = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : exists('bun.lockb') ? 'bun' : 'npm';
    const scripts = pkg.scripts || {};
    if (e2e) {
      const e2eScript = ['test:e2e', 'e2e', 'test:integration'].find((s) => scripts[s]);
      if (e2eScript) return { cmd: `${pm} run ${e2eScript}`, kind: 'e2e' };
      if (exists('playwright.config.ts') || exists('playwright.config.js')) return { cmd: 'npx --yes playwright test', kind: 'e2e (playwright)' };
      if (exists('cypress.config.ts') || exists('cypress.config.js')) return { cmd: 'npx --yes cypress run', kind: 'e2e (cypress)' };
    }
    if (scripts.test) return { cmd: `${pm} test`, kind: 'node' };
  }
  if (exists('Cargo.toml')) return { cmd: 'cargo test', kind: 'rust' };
  if (exists('go.mod')) return { cmd: 'go test ./...', kind: 'go' };
  if (exists('pytest.ini') || exists('tox.ini') || exists('pyproject.toml') || exists('tests') || exists('test')) {
    if (has('pytest') || has('python3') || has('python')) return { cmd: has('pytest') ? 'pytest -q' : `${has('python3') ? 'python3' : 'python'} -m pytest -q`, kind: 'python' };
  }
  if (exists('Makefile') && /^test:/m.test(read('Makefile'))) return { cmd: 'make test', kind: 'make' };
  return null;
}

function runTests(a, { cwd, signal }) {
  const det = a.command ? { cmd: String(a.command), kind: 'custom' } : detectTestCmd(cwd, { e2e: a.e2e === true });
  if (!det) throw new Error(a.e2e ? 'Não achei testes e2e (script test:e2e, Playwright ou Cypress). Passe command.' : 'Não descobri como rodar os testes aqui. Passe command com o comando (ex.: "npm test", "pytest -q").');
  const sh = process.platform === 'win32' ? ['cmd', ['/c', det.cmd]] : ['bash', ['-lc', det.cmd]];
  const { code, out } = run(sh[0], sh[1], { cwd, signal, timeout: 900000 });
  const status = code === 0 ? 'PASSOU' : `FALHOU (código ${code})`;
  return `Testes (${det.kind}): ${det.cmd}\nResultado: ${status}\n\n${out || '(sem saída)'}`;
}

module.exports = {
  defs: [
    {
      name: 'apply_patch',
      description: 'Aplica um diff unificado (patch) a vários arquivos de uma vez, como Claude Code e Codex: cabeçalhos ---/+++ e hunks @@. '
        + 'Cria arquivo novo quando a origem é /dev/null, apaga quando o destino é /dev/null, e localiza o contexto mesmo se as linhas tiverem deslocado um pouco. '
        + 'Útil para mudanças grandes e coordenadas. Para uma edição simples num arquivo, edit_file/multi_edit continuam melhores.',
      parameters: { type: 'object', properties: { patch: { type: 'string', description: 'O diff unificado completo' } }, required: ['patch'] },
    },
    {
      name: 'run_tests',
      description: 'Descobre sozinho como este projeto roda os testes (npm/pnpm/yarn test, cargo test, go test, pytest, make test) e roda, '
        + 'resumindo se passou ou falhou e mostrando a saída. e2e: true procura testes end-to-end (script test:e2e, Playwright ou Cypress). '
        + 'Passe command para forçar um comando específico. Use para verificar o que você mudou.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Comando de teste a forçar (opcional)' }, e2e: { type: 'boolean', description: 'Rodar os testes end-to-end' } } },
    },
  ],
  run(name, a, ctx) { return name === 'apply_patch' ? applyPatch(a, ctx) : runTests(a, ctx); },
  describe: (name, a) => (name === 'apply_patch' ? `Patch(${(String(a.patch || '').match(/\n\+\+\+ /g) || []).length || 1} arquivo)` : `Testes(${a.command || 'auto'})`),
  needsApproval: () => true, // apply_patch escreve arquivos; run_tests executa comandos
  _test: { parsePatch, applyHunks, detectTestCmd },
};
