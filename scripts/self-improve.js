#!/usr/bin/env node
'use strict';
// Loop de auto-melhoria do rfcode (ver docs/SDD.md, seção 6).
//
// Trabalha numa git worktree separada, implementa tarefas do backlog com o próprio agente,
// roda os testes, dá ao agente chances de corrigir falhas e só faz commit se todos os portões passarem.
// Tudo o que acontece vira evento em .self-improve/runs/<id>.jsonl, que o painel (npm run painel) mostra ao vivo.
// Nunca faz push nem merge.
//
// Uso: node scripts/self-improve.js [--iterations N] [--model ID] [--fallback-model ID] [--task T05]

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Agent, loadConfig, DEFAULT_MODEL } = require('../lib/agent');

const ROOT = path.resolve(__dirname, '..');
const BRANCH = 'self-improve';
const WT = path.join(ROOT, '.worktrees', 'self-improve');
const DATA = path.join(ROOT, '.self-improve');
const RUNS = path.join(DATA, 'runs');
const STATE_FILE = path.join(DATA, 'state.json');
const CONTROL_FILE = path.join(DATA, 'control.json');
const FOCUS_FILE = path.join(DATA, 'focus.md');
const SDD = 'docs/SDD.md';
const TEST_GLOB = 'test/**/*.test.js';
const TEST_SCRIPT = `node --test "${TEST_GLOB}"`;
const PROTECTED = ['test/core.test.js', 'scripts/self-improve.js', 'scripts/dashboard.js', SDD];
const ITERATION_TIMEOUT_MS = 25 * 60 * 1000;
const MAX_STEPS = 70;
const REPAIR_ROUNDS = 2;
const MAX_FAILURES = 2;
const CODE_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'run_command', 'git_status', 'git_diff', 'git_log', 'update_plan'];
const ALLOWED_COMMANDS = [
  /^npm (run )?test(\s+--\s+[\w./\\ -]+)?$/,
  /^node --test( "?[\w./\\*-]+"?)*$/,
  /^node --check [\w./\\-]+$/,
  /^git (status|diff|log|show)( [\w./\\:~^ -]*)?$/,
];

// ---------- utilitários ----------
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
function git(args, cwd = WT) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

// ---------- eventos (alimentam o painel) ----------
let RUN_ID = null;
let runFile = null;
function emit(type, data = {}) {
  const ev = { ts: new Date().toISOString(), run: RUN_ID, type, ...data };
  if (runFile) fs.appendFileSync(runFile, JSON.stringify(ev) + '\n');
  return ev;
}
function log(line) { console.log(line); }
function updateRunIndex(patch) {
  const idx = readJson(path.join(RUNS, 'index.json'), []);
  let r = idx.find((x) => x.id === RUN_ID);
  if (!r) { r = { id: RUN_ID, tasks: [] }; idx.unshift(r); }
  Object.assign(r, patch);
  writeJson(path.join(RUNS, 'index.json'), idx.slice(0, 200));
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag, def) => { const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def; };
  return {
    iterations: Math.max(1, parseInt(get('--iterations', '3'), 10)),
    model: get('--model', null),
    fallbackModel: get('--fallback-model', null), // ex.: z-ai/glm-5.3 (mais forte, mas lento no plano grátis)
    task: get('--task', null),
  };
}

// Roda os testes e devolve { ok, pass, fail, failures, output }
function runTests(cwd) {
  const r = spawnSync(process.execPath, ['--test', TEST_GLOB], { cwd, encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true });
  const out = (r.stdout || '') + (r.stderr || '');
  const num = (k) => { const m = out.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? parseInt(m[1], 10) : 0; };
  const failures = [];
  const lines = out.split('\n');
  lines.forEach((l, i) => {
    const m = l.match(/^\s*not ok \d+ - (.+)$/);
    if (m && !/^test[\\/]/.test(m[1])) {
      const err = lines.slice(i + 1, i + 12).find((x) => /^\s*error:/.test(x));
      failures.push({ name: m[1].trim(), error: err ? err.replace(/^\s*error:\s*/, '').replace(/^['"]|['"]$/g, '').slice(0, 300) : '' });
    }
  });
  return { ok: r.status === 0, pass: num('pass'), fail: num('fail'), failures, output: out };
}

// ---------- SDD ----------
function readTasks(sddText) {
  const tasks = [];
  const re = /^### \[( |x|!)\] (T\d+)\s*[—:-]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(sddText))) tasks.push({ state: m[1], id: m[2], title: m[3].trim(), index: m.index });
  for (let i = 0; i < tasks.length; i++) {
    const end = i + 1 < tasks.length ? tasks[i + 1].index : sddText.length;
    tasks[i].body = sddText.slice(tasks[i].index, end).trim();
  }
  return tasks;
}
function markTask(id, state, note) {
  const file = path.join(WT, SDD);
  let s = fs.readFileSync(file, 'utf8');
  s = s.replace(new RegExp(`^### \\[[ x!]\\] ${id}\\b`, 'm'), `### [${state}] ${id}`);
  if (note) s = s.replace(new RegExp(`(^### \\[${state === '!' ? '!' : 'x'}\\] ${id}.*$)`, 'm'), `$1\n> ${note}`);
  fs.writeFileSync(file, s);
}

// ---------- o que está sendo codado ----------
// Lista arquivos alterados (+/-) e as funções/testes que aparecem nas linhas adicionadas.
function codeChanges() {
  try {
    git(['add', '-A', '--intent-to-add']);
    const numstat = git(['diff', '--numstat']);
    const files = numstat ? numstat.split('\n').map((l) => {
      const [a, r, p] = l.split('\t');
      return { path: p, added: +a || 0, removed: +r || 0 };
    }) : [];
    const patch = git(['diff', '-U0', '--no-color']);
    const symbols = [];
    let file = '';
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const l = line.slice(1);
      let m;
      if ((m = l.match(/^\s*(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/))) symbols.push({ kind: 'função', name: m[1], file });
      else if ((m = l.match(/^\s*(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/))) symbols.push({ kind: 'função', name: m[1], file });
      else if ((m = l.match(/^\s*class\s+([\w$]+)/))) symbols.push({ kind: 'classe', name: m[1], file });
      else if ((m = l.match(/^\s{2}(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{\s*$/)) && !/^(if|for|while|switch|catch|function)$/.test(m[1])) symbols.push({ kind: 'método', name: m[1], file });
      else if ((m = l.match(/^\s*test\(\s*['"`](.+?)['"`]/))) symbols.push({ kind: 'teste', name: m[1], file });
      else if ((m = l.match(/^\s*name:\s*'([a-z_]+)'/)) && /lib\//.test(file)) symbols.push({ kind: 'ferramenta', name: m[1], file });
    }
    return { files, symbols };
  } catch {
    return { files: [], symbols: [] };
  }
}

// ---------- política de aprovação ----------
function policy(info) {
  const { name, args } = info;
  if (name === 'write_file' || name === 'edit_file') {
    const full = path.resolve(WT, args.path || '');
    const rel = path.relative(WT, full).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { deny: 'Só é permitido editar arquivos dentro do repositório.' };
    if (rel.startsWith('.git/') || rel === '.git') return { deny: 'Não edite a pasta .git.' };
    if (PROTECTED.includes(rel)) return { deny: `${rel} é protegido (ver SDD seção 4). Crie testes em outro arquivo.` };
    return 'yes';
  }
  if (name === 'run_command') {
    const cmd = String(args.command || '').trim();
    if (/[;&|<>`$]/.test(cmd) || !ALLOWED_COMMANDS.some((re) => re.test(cmd))) {
      return { deny: 'Comando não permitido no loop. Permitidos: npm test, node --test <arquivos>, node --check <arquivo>, git status/diff/log/show.' };
    }
    return 'yes';
  }
  return { deny: 'Ferramenta não permitida no loop.' };
}

// ---------- preparação ----------
function ensureWorktree() {
  if (!fs.existsSync(WT)) {
    const branches = git(['branch', '--list', BRANCH], ROOT);
    fs.mkdirSync(path.dirname(WT), { recursive: true });
    if (branches) git(['worktree', 'add', WT, BRANCH], ROOT);
    else git(['worktree', 'add', '-b', BRANCH, WT, 'main'], ROOT);
  }
  // descarta restos de uma execução interrompida
  git(['reset', '-q', '--hard', 'HEAD']);
  git(['clean', '-fdq']);
  // traz novidades de main (tarefas novas no SDD, correções feitas à mão)
  try {
    const behind = git(['rev-list', '--count', `${BRANCH}..main`]);
    if (behind !== '0') {
      git(['merge', '--no-edit', '-q', 'main']);
      emit('info', { text: `Branch ${BRANCH} atualizada com ${behind} commit(s) de main.` });
    }
  } catch {
    try { git(['merge', '--abort']); } catch {}
    emit('warn', { text: `Não foi possível juntar main em ${BRANCH} (conflito). Resolva à mão em .worktrees/self-improve.` });
  }
}

// Arquivos alterados na worktree. Usa -z e não apara a saída: o formato é "XY caminho" e o espaço inicial
// de "XY" faz parte da linha (aparar cortaria a 1ª letra do 1º caminho e enganaria a proteção de arquivos).
function changedFiles() {
  const raw = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd: WT, encoding: 'utf8', windowsHide: true });
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    files.push(e.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') files.push(parts[++i]); // renomeado: o caminho de origem vem em seguida
  }
  return files.filter(Boolean).map((f) => f.replace(/\\/g, '/'));
}

function gatesCheck(before, task) {
  const changed = changedFiles();
  if (!changed.length) return { ok: false, kind: 'vazio', reason: 'nenhuma alteração feita' };
  const touched = PROTECTED.filter((p) => changed.includes(p));
  if (touched.length) return { ok: false, kind: 'protegido', reason: `arquivos protegidos alterados: ${touched.join(', ')}` };
  // rascunhos e arquivos temporários não entram no repositório
  const junk = changed.filter((f) => /(^|\/)(temp|tmp|scratch|rascunho|debug)[\w.-]*$/i.test(f) || /\.(log|bak|orig)$/i.test(f));
  if (junk.length) return { ok: false, kind: 'lixo', reason: `arquivos temporários no repositório: ${junk.join(', ')}. Apague-os (ou não os crie): só código, testes e docs entram.` };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WT, 'package.json'), 'utf8'));
    if (!pkg.scripts || pkg.scripts.test !== TEST_SCRIPT) return { ok: false, kind: 'pacote', reason: 'scripts.test do package.json foi alterado' };
  } catch (e) { return { ok: false, kind: 'pacote', reason: 'package.json inválido: ' + e.message }; }
  const t = runTests(WT);
  emit('tests', { pass: t.pass, fail: t.fail, failures: t.failures, before: before.pass });
  if (!t.ok) {
    const list = t.failures.map((f) => `- ${f.name}: ${f.error}`).join('\n') || t.output.split('\n').filter((l) => /Error|error:/.test(l)).slice(0, 8).join('\n');
    return { ok: false, kind: 'testes', reason: `testes falharam (${t.fail} falhas)\n${list}`, tests: t };
  }
  if (t.pass < before.pass) return { ok: false, kind: 'menos-testes', reason: `número de testes diminuiu (${before.pass} → ${t.pass})` };
  // tarefa com critério de aceite exige teste novo
  if (task && /\*\*Aceite:\*\*/.test(task.body) && t.pass <= before.pass) {
    return { ok: false, kind: 'sem-teste', reason: `a tarefa tem critério de aceite, mas nenhum teste novo foi adicionado (antes ${before.pass}, agora ${t.pass}). Escreva o teste de aceite em test/<tema>.test.js.` };
  }
  return { ok: true, tests: t, changed };
}

// ---------- controle pelo painel ----------
function control() { return readJson(CONTROL_FILE, {}); }
function setControl(patch) { writeJson(CONTROL_FILE, { ...control(), ...patch }); }

function pickTask(tasks, forced) {
  const ctl = control();
  const want = forced || ctl.next;
  if (want) {
    const t = tasks.find((x) => x.id === want && x.state !== 'x');
    if (ctl.next) setControl({ next: null });
    if (t) return t;
  }
  return tasks.find((t) => t.state === ' ');
}

function goalOf(task) {
  // primeira frase do corpo da tarefa = objetivo
  const body = task.body.split('\n').slice(1).join(' ').replace(/\*\*/g, '').trim();
  const first = body.split(/(?<=[.!?])\s/)[0] || task.title;
  return first.slice(0, 300);
}

// ---------- uma iteração ----------
async function iteration(apiKey, baseModel, fallbackModel, forcedTask, state) {
  const sdd = fs.readFileSync(path.join(WT, SDD), 'utf8');
  const tasks = readTasks(sdd);
  const task = pickTask(tasks, forcedTask);
  if (!task) return 'fim';

  const previous = state.lastFailure && state.lastFailure[task.id];
  const attempt = (state.failures[task.id] || 0) + 1;
  const model = previous && fallbackModel ? fallbackModel : baseModel;
  const focus = fs.existsSync(FOCUS_FILE) ? fs.readFileSync(FOCUS_FILE, 'utf8').trim() : '';

  emit('phase', { phase: 'preparando' });
  const before = runTests(WT);
  if (!before.ok) { emit('error', { text: 'Os testes já estão falhando na worktree; abortando.' }); return 'erro'; }

  emit('task_start', {
    task: { id: task.id, title: task.title, body: task.body }, goal: goalOf(task), model, attempt,
    previousFailure: previous || null, focus: focus || null, testsBefore: before.pass,
  });
  log(`\n${c.bold(`▶ ${task.id}: ${task.title}`)} ${c.dim(`(tentativa ${attempt}, ${model})`)}`);

  const agent = new Agent({
    apiKey, model, cwd: WT, tools: CODE_TOOLS, maxSteps: MAX_STEPS, planReminderEvery: 5,
    systemExtra: `# Modo de auto-melhoria
Você está melhorando o PRÓPRIO código do rfcode, seguindo o SDD em docs/SDD.md. Um administrador acompanha tudo ao vivo num painel.
${focus ? `\n## Direção do administrador (prioridade máxima)\n${focus}\n` : ''}
## Transparência (obrigatório)
- Primeiro passo: chame update_plan com goal (o objetivo da tarefa) e 3 a 7 passos concretos.
- Atualize update_plan sempre que concluir ou começar um passo, preenchendo "why" com o motivo do passo atual.
- Antes de cada ferramenta, escreva uma frase curta: o que vai fazer e por quê.

## Regras
- Implemente SOMENTE a tarefa indicada, com mudanças pequenas e no estilo do código existente.
- Meta do projeto: paridade com o Claude Code (docs/CLAUDE_CODE_PARITY.md). Siga os exemplos: lib/git.js + test/git.test.js mostram como criar ferramentas e testá-las; test/plan.test.js mostra como simular a API (fetch) sem rede.
- Escreva os testes de aceite em test/<tema>.test.js usando node:test.
- Arquivos protegidos (NÃO edite): ${PROTECTED.join(', ')}.
- Comandos permitidos: npm test, node --test <arquivos>, node --check <arquivo>, git status/diff/log/show. Use git_status/git_diff para revisar.
- Rode npm test antes de terminar e corrija até passar. Não use dependências externas.
- Não deixe arquivos temporários ou de rascunho no repositório (temp_*, tmp*, *.log): eles fazem a tarefa ser rejeitada.
- Em repositórios git temporários de teste, configure user.name e user.email antes de commitar.
- No Windows, apague pastas temporárias com fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) e só depois que os processos filhos terminarem.`,
  });

  // parar pelo painel ou por tempo
  let stopReason = null;
  const watcher = setInterval(() => { if (control().stop && !stopReason) { stopReason = 'parado pelo administrador'; agent.abort(); } }, 1500);
  const timer = setTimeout(() => { stopReason = 'tempo da iteração esgotado'; agent.abort(); }, ITERATION_TIMEOUT_MS);

  let said = '';
  const hooks = {
    approve: async (info) => {
      const d = policy(info);
      if (d !== 'yes') { emit('denied', { id: info.id, label: info.label, reason: d.deny }); log(c.red(`  ✗ ${info.label}: ${d.deny}`)); }
      return d;
    },
    onThinking: () => emit('thinking'),
    onText: (t) => { said += t; },
    onAssistantEnd: () => { if (said.trim()) emit('say', { text: said.trim() }); said = ''; },
    onPlan: (p) => { emit('plan', p); const cur = p.steps.find((s) => s.status === 'in_progress'); if (cur) log(c.cyan(`  ◐ ${cur.text}`)); },
    onToolCall: (info) => {
      const a = info.args || {};
      emit('tool', { id: info.id, name: info.name, label: info.label, reason: info.reason, target: a.path || a.command || a.pattern || null });
      log(c.dim(`  • ${info.label}`));
    },
    onToolResult: (r) => {
      emit('tool_result', { id: r.id, name: r.name, ok: !r.error, summary: String(r.output).split('\n').slice(0, 3).join('\n').slice(0, 400) });
      if (!r.error && (r.name === 'write_file' || r.name === 'edit_file')) emit('code', codeChanges());
    },
    onUsage: (u) => emit('usage', u),
    onRetry: (m) => emit('warn', { text: m }),
    onError: (m) => emit('agent_error', { text: m }),
  };

  emit('phase', { phase: 'trabalhando' });
  const retryNote = previous ? `\n\nATENÇÃO: uma tentativa anterior desta tarefa foi REJEITADA. Motivo:\n${previous}\nEvite repetir esse erro.` : '';
  await agent.send(`Implemente a tarefa do SDD abaixo.\n\n${task.body}${retryNote}`, hooks);

  // portões + rodadas de reparo: o agente recebe as falhas e tenta corrigir antes do veredito
  emit('phase', { phase: 'validando' });
  let g = gatesCheck(before, task);
  for (let round = 1; !g.ok && !stopReason && round <= REPAIR_ROUNDS && ['testes', 'menos-testes', 'vazio', 'pacote', 'sem-teste', 'lixo'].includes(g.kind); round++) {
    emit('repair', { round, reason: g.reason });
    log(c.yellow(`  ↻ reparo ${round}: ${g.reason.split('\n')[0]}`));
    emit('phase', { phase: 'corrigindo' });
    const msg = g.kind === 'vazio'
      ? 'Nenhuma alteração foi feita no repositório. Implemente a tarefa agora: escreva o código e os testes.'
      : `A validação automática falhou:\n${g.reason}\n\nCorrija o problema (leia os arquivos envolvidos, ajuste o código ou o teste) e rode npm test de novo.`;
    await agent.send(msg, hooks);
    emit('phase', { phase: 'validando' });
    g = gatesCheck(before, task);
  }
  clearInterval(watcher);
  clearTimeout(timer);
  if (stopReason && !g.ok) g = { ok: false, kind: 'parado', reason: stopReason };

  const changes = codeChanges();
  if (g.ok) {
    emit('phase', { phase: 'commit' });
    markTask(task.id, 'x', `Feito pelo loop em ${new Date().toISOString().slice(0, 10)} (${model}).`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', `feat(${task.id}): ${task.title} [self-improve]\n\nArquivos: ${g.changed.join(', ')}\nTestes: ${g.tests.pass} passando.`]);
    const commit = git(['rev-parse', '--short', 'HEAD']);
    delete state.failures[task.id];
    if (state.lastFailure) delete state.lastFailure[task.id];
    emit('verdict', { task: task.id, accepted: true, commit, tests: g.tests.pass, testsBefore: before.pass, changes, usage: agent.usage });
    log(c.green(`  ✔ ${task.id} aceita: ${g.tests.pass} testes passando, commit ${commit}`));
    return 'ok';
  }

  emit('verdict', { task: task.id, accepted: false, reason: g.reason, kind: g.kind, changes, usage: agent.usage });
  log(c.red(`  ✗ ${task.id} rejeitada: ${g.reason.split('\n')[0]}`));
  git(['reset', '-q', '--hard', 'HEAD']);
  git(['clean', '-fdq']);
  if (g.kind === 'parado') return 'parado';
  state.failures[task.id] = attempt;
  state.lastFailure = state.lastFailure || {};
  state.lastFailure[task.id] = g.reason.slice(0, 2000);
  if (attempt >= MAX_FAILURES) {
    markTask(task.id, '!', `Bloqueada pelo loop após ${MAX_FAILURES} tentativas. Último motivo: ${g.reason.split('\n')[0]}`);
    git(['commit', '-q', '-am', `chore(${task.id}): marcada como bloqueada [self-improve]`]);
    emit('blocked', { task: task.id });
  }
  return 'falhou';
}

// ---------- main ----------
async function main() {
  const opts = parseArgs();
  const cfg = loadConfig();
  const apiKey = cfg.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) { console.error('Configure a API key primeiro: rode `rfcode --key`.'); process.exit(1); }
  const model = opts.model || cfg.model || DEFAULT_MODEL;

  RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(RUNS, { recursive: true });
  runFile = path.join(RUNS, `${RUN_ID}.jsonl`);
  setControl({ stop: false, running: { id: RUN_ID, pid: process.pid, started: new Date().toISOString() } });
  updateRunIndex({ start: new Date().toISOString(), model, iterations: opts.iterations, status: 'rodando' });
  emit('run_start', { iterations: opts.iterations, model, fallbackModel: opts.fallbackModel });
  log(c.bold(`# Auto-melhoria rfcode: ${opts.iterations} iteração(ões), modelo ${model}`));
  log(c.dim(`  eventos: ${path.relative(ROOT, runFile)} · painel: npm run painel`));

  let status = 'concluído';
  try {
    ensureWorktree();
    const state = readJson(STATE_FILE, { failures: {} });
    process.on('SIGINT', () => setControl({ stop: true }));
    for (let i = 0; i < opts.iterations; i++) {
      if (control().stop) { status = 'parado'; break; }
      const r = await iteration(apiKey, model, opts.fallbackModel, i === 0 ? opts.task : null, state);
      writeJson(STATE_FILE, state);
      const verdicts = fs.readFileSync(runFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'verdict');
      updateRunIndex({ tasks: verdicts.map((v) => ({ id: v.task, accepted: v.accepted })) });
      if (r === 'fim') { emit('info', { text: 'Backlog concluído: não há tarefas pendentes.' }); break; }
      if (r === 'erro') { status = 'erro'; break; }
      if (r === 'parado') { status = 'parado'; break; }
    }
  } catch (e) {
    status = 'erro';
    emit('error', { text: e.message });
    console.error(c.red(e.stack || e.message));
  } finally {
    let ahead = '?';
    try { ahead = git(['rev-list', '--count', `main..${BRANCH}`], ROOT); } catch {}
    emit('run_end', { status, ahead: +ahead || 0 });
    updateRunIndex({ end: new Date().toISOString(), status });
    setControl({ stop: false, running: null });
    log(`\nBranch ${c.bold(BRANCH)}: ${ahead} commit(s) à frente de main. Revise e aceite pelo painel (npm run painel).`);
  }
}

main();
