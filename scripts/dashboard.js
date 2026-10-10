#!/usr/bin/env node
'use strict';
// Painel do administrador do rfcode: acompanha e dirige o loop de auto-melhoria.
// Servidor HTTP local (só 127.0.0.1), sem dependências. Uso: npm run painel  →  http://127.0.0.1:4517

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { SUGGESTED_MODELS, loadConfig, DEFAULT_MODEL } = require('../lib/agent');

const ROOT = path.resolve(__dirname, '..');
const WT = path.join(ROOT, '.worktrees', 'self-improve');
const DATA = path.join(ROOT, '.self-improve');
const RUNS = path.join(DATA, 'runs');
const CONTROL_FILE = path.join(DATA, 'control.json');
const FOCUS_FILE = path.join(DATA, 'focus.md');
const STATE_FILE = path.join(DATA, 'state.json');
const STATIC = path.join(ROOT, 'dashboard');
const SDD = 'docs/SDD.md';
const BRANCH = 'self-improve';
const PORT = parseInt(process.env.RFCODE_PAINEL_PORT || '4517', 10);
const HOST = '127.0.0.1';

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
function git(args, cwd = ROOT) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 30 * 1024 * 1024 }).trim();
}
const tryGit = (args, cwd) => { try { return git(args, cwd); } catch { return ''; } };

// ---------- estado ----------
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function running() {
  const ctl = readJson(CONTROL_FILE, {});
  if (ctl.running && ctl.running.pid && alive(ctl.running.pid)) return ctl.running;
  return null;
}
function sddPath() { return fs.existsSync(path.join(WT, SDD)) ? path.join(WT, SDD) : path.join(ROOT, SDD); }
function readTasks() {
  const text = fs.readFileSync(sddPath(), 'utf8');
  const re = /^### \[( |x|!)\] (T\d+)\s*[—:-]\s*(.+)$/gm;
  const tasks = [];
  let m;
  while ((m = re.exec(text))) tasks.push({ state: m[1], id: m[2], title: m[3].trim(), index: m.index });
  for (let i = 0; i < tasks.length; i++) {
    const end = i + 1 < tasks.length ? tasks[i + 1].index : text.length;
    const body = text.slice(tasks[i].index, end).trim().split('\n').slice(1).join('\n').trim();
    tasks[i].body = body;
    delete tasks[i].index;
  }
  // tarefas novas que ainda só existem no main
  if (sddPath() !== path.join(ROOT, SDD)) {
    const mainText = fs.readFileSync(path.join(ROOT, SDD), 'utf8');
    const re2 = /^### \[( |x|!)\] (T\d+)\s*[—:-]\s*(.+)$/gm;
    while ((m = re2.exec(mainText))) {
      if (!tasks.some((t) => t.id === m[2])) tasks.push({ state: m[1], id: m[2], title: m[3].trim(), body: '(nova, entra na próxima rodada)' });
    }
  }
  return tasks;
}
function branchInfo() {
  const exists = !!tryGit(['branch', '--list', BRANCH]);
  if (!exists) return { exists, ahead: [], behind: 0 };
  const log = tryGit(['log', '--pretty=format:%h\x1f%ar\x1f%s', `main..${BRANCH}`]);
  const ahead = log ? log.split('\n').map((l) => { const [hash, when, subject] = l.split('\x1f'); return { hash, when, subject }; }) : [];
  const behind = +tryGit(['rev-list', '--count', `${BRANCH}..main`]) || 0;
  return { exists, ahead, behind };
}
function state() {
  const st = readJson(STATE_FILE, { failures: {} });
  const cfg = loadConfig();
  return {
    running: running(),
    stopRequested: !!readJson(CONTROL_FILE, {}).stop,
    next: readJson(CONTROL_FILE, {}).next || null,
    focus: fs.existsSync(FOCUS_FILE) ? fs.readFileSync(FOCUS_FILE, 'utf8') : '',
    tasks: readTasks().map((t) => (t.state === 'x'
      ? { ...t, failures: 0, lastFailure: null }
      : { ...t, failures: (st.failures || {})[t.id] || 0, lastFailure: (st.lastFailure || {})[t.id] || null })),
    branch: branchInfo(),
    mainHead: tryGit(['log', '-1', '--pretty=format:%h %s']),
    runs: readJson(path.join(RUNS, 'index.json'), []).slice(0, 30),
    models: SUGGESTED_MODELS.map(([id, desc]) => ({ id, desc })),
    defaultModel: cfg.model || DEFAULT_MODEL,
    hasKey: !!(cfg.apiKey || process.env.NVIDIA_API_KEY),
  };
}
function readRun(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('id inválido');
  const f = path.join(RUNS, `${id}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------- ações ----------
function startRun({ iterations, model, task }) {
  if (running()) throw new Error('Já existe uma rodada em andamento.');
  const args = [path.join(ROOT, 'scripts', 'self-improve.js'), '--iterations', String(Math.min(Math.max(+iterations || 1, 1), 50))];
  if (model) args.push('--model', String(model));
  if (task && /^T\d+$/.test(task)) args.push('--task', task);
  fs.mkdirSync(DATA, { recursive: true });
  const out = fs.openSync(path.join(DATA, 'runner.log'), 'a');
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  return { pid: child.pid };
}
function addTask({ title, body, acceptance }) {
  title = String(title || '').trim().replace(/\s+/g, ' ');
  if (!title) throw new Error('Informe o título da tarefa.');
  const ids = readTasks().map((t) => +t.id.slice(1));
  const all = fs.readFileSync(path.join(ROOT, SDD), 'utf8');
  for (const m of all.matchAll(/^### \[[ x!]\] T(\d+)/gm)) ids.push(+m[1]);
  const id = 'T' + String(Math.max(0, ...ids) + 1).padStart(2, '0');
  let block = `\n### [ ] ${id}: ${title}\n${String(body || '').trim() || title + '.'}\n`;
  if (String(acceptance || '').trim()) block += `**Aceite:** ${String(acceptance).trim()}\n`;
  fs.writeFileSync(path.join(ROOT, SDD), all.replace(/\s*$/, '\n') + block);
  git(['commit', '-q', '-m', `docs(SDD): nova tarefa ${id} pelo painel`, '--', SDD]);
  return { id };
}
function reopenTask(id) {
  if (running()) throw new Error('Aguarde a rodada terminar.');
  if (!/^T\d+$/.test(id) || !fs.existsSync(WT)) throw new Error('Tarefa ou worktree inválida.');
  const f = path.join(WT, SDD);
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(new RegExp(`^### \\[!\\] ${id}\\b(.*)\\n> Bloqueada.*\\n`, 'm'), `### [ ] ${id}$1\n`);
  s = s.replace(new RegExp(`^### \\[!\\] ${id}\\b`, 'm'), `### [ ] ${id}`);
  fs.writeFileSync(f, s);
  git(['commit', '-q', '-m', `chore(${id}): reaberta pelo painel`, '--', SDD], WT);
  const st = readJson(STATE_FILE, { failures: {} });
  delete st.failures[id];
  writeJson(STATE_FILE, st);
  return { ok: true };
}
function merge() {
  if (running()) throw new Error('Aguarde a rodada terminar antes de aceitar.');
  const ahead = branchInfo().ahead.length;
  if (!ahead) throw new Error('Não há commits novos para aceitar.');
  try {
    git(['merge', '--no-ff', '-q', '-m', `Merge ${BRANCH}: ${ahead} melhoria(s) aceita(s) pelo painel`, BRANCH]);
  } catch (e) {
    tryGit(['merge', '--abort']);
    throw new Error('Merge falhou: ' + String(e.stderr || e.message).split('\n').slice(0, 4).join(' '));
  }
  return { merged: ahead, head: tryGit(['log', '-1', '--pretty=format:%h %s']) };
}
function commitDiff(hash) {
  if (!/^[0-9a-f]{4,40}$/.test(hash)) throw new Error('hash inválido');
  const out = git(['show', '--stat', '--patch', '--no-color', '--format=%h %s%n%an · %ar%n%n%b', hash]);
  return out.length > 200000 ? out.slice(0, 200000) + '\n... [truncado]' : out;
}
function liveDiff() {
  if (!fs.existsSync(WT)) return '';
  const tracked = tryGit(['diff', '--no-color'], WT);
  const untracked = tryGit(['ls-files', '--others', '--exclude-standard'], WT);
  let out = tracked;
  for (const f of untracked ? untracked.split('\n') : []) {
    try { out += `\n\n+++ ${f} (novo)\n` + fs.readFileSync(path.join(WT, f), 'utf8').split('\n').map((l) => '+' + l).join('\n'); } catch {}
  }
  return out.length > 200000 ? out.slice(0, 200000) + '\n... [truncado]' : out;
}

// ---------- servidor ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    // junta os bytes antes de decodificar: um caractere UTF-8 pode vir partido entre dois pedaços
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { chunks.push(d); size += d.length; if (size > 1e6) req.destroy(); });
    req.on('end', () => {
      const b = Buffer.concat(chunks).toString('utf8');
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // só aceita acesso pelo próprio computador (protege contra DNS rebinding)
  const host = String(req.headers.host || '');
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'host não permitido' });
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST') {
      // cabeçalho próprio obriga preflight CORS, que não é permitido: sites externos não conseguem chamar a API
      if (req.headers['x-rfcode'] !== '1') return send(res, 403, { error: 'cabeçalho ausente' });
      const body = await readBody(req);
      switch (p) {
        case '/api/start': return send(res, 200, startRun(body));
        case '/api/stop': writeJson(CONTROL_FILE, { ...readJson(CONTROL_FILE, {}), stop: true }); return send(res, 200, { ok: true });
        case '/api/focus': fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FOCUS_FILE, String(body.text || '')); return send(res, 200, { ok: true });
        case '/api/next': writeJson(CONTROL_FILE, { ...readJson(CONTROL_FILE, {}), next: /^T\d+$/.test(body.task) ? body.task : null }); return send(res, 200, { ok: true });
        case '/api/task': return send(res, 200, addTask(body));
        case '/api/reopen': return send(res, 200, reopenTask(body.task));
        case '/api/merge': return send(res, 200, merge());
        default: return send(res, 404, { error: 'rota desconhecida' });
      }
    }
    if (p === '/api/state') return send(res, 200, state());
    if (p === '/api/run') return send(res, 200, readRun(url.searchParams.get('id') || ''));
    if (p === '/api/commit') return send(res, 200, { diff: commitDiff(url.searchParams.get('hash') || '') });
    if (p === '/api/live-diff') return send(res, 200, { diff: liveDiff() });
    if (p === '/api/stream') {
      // SSE: novos eventos da rodada indicada, a partir de uma posição do arquivo
      const id = url.searchParams.get('id') || '';
      if (!/^[\w-]+$/.test(id)) return send(res, 400, { error: 'id inválido' });
      const file = path.join(RUNS, `${id}.jsonl`);
      let pos = 0;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const tick = () => {
        try {
          const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
          if (size > pos) {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            fs.closeSync(fd);
            const text = buf.toString('utf8');
            const lastNl = text.lastIndexOf('\n');
            if (lastNl >= 0) {
              pos += Buffer.byteLength(text.slice(0, lastNl + 1));
              for (const line of text.slice(0, lastNl).split('\n')) if (line.trim()) res.write(`data: ${line}\n\n`);
            }
          }
        } catch {}
      };
      tick();
      const iv = setInterval(tick, 700);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(iv); clearInterval(ping); });
      return;
    }
    // arquivos estáticos do painel
    const file = path.join(STATIC, p === '/' ? 'index.html' : p);
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'não encontrado', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`Painel já está aberto em http://${HOST}:${PORT}`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  rfcode · painel do administrador\n  ${url}\n  (Ctrl+C para fechar o painel; rodadas iniciadas continuam em segundo plano)\n`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  }
});
