#!/usr/bin/env node
'use strict';
// Loop de auto-melhoria do rfcode (ver docs/SDD.md, seção 6).
// Trabalha numa git worktree separada, implementa a próxima tarefa do backlog com o próprio agente,
// roda os testes e só faz commit se todos os portões de qualidade passarem. Nunca faz push nem merge.
//
// Uso: npm run self-improve -- [--iterations N] [--model ID] [--task T05]

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Agent, loadConfig, DEFAULT_MODEL } = require('../lib/agent');

const ROOT = path.resolve(__dirname, '..');
const BRANCH = 'self-improve';
const WT = path.join(ROOT, '.worktrees', 'self-improve');
const LOG_DIR = path.join(ROOT, '.self-improve');
const STATE_FILE = path.join(LOG_DIR, 'state.json');
const SDD = 'docs/SDD.md';
const TEST_SCRIPT = 'node --test "test/**/*.test.js"';
const PROTECTED = ['test/core.test.js', 'scripts/self-improve.js', SDD];
const ITERATION_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_FAILURES = 2;
const CODE_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'run_command'];
const ALLOWED_COMMANDS = [
  /^npm (run )?test(\s+--\s+[\w./\\ -]+)?$/,
  /^node --test( [\w./\\-]+)*$/,
  /^node --check [\w./\\-]+$/,
  /^git (status|diff|log|show)( [\w./\\:~^ -]*)?$/,
];

// ---------- utilitários ----------
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
function git(args, cwd = WT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function log(line) {
  console.log(line);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, 'log.md'), line.replace(/\x1b\[\d+m/g, '') + '\n');
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { failures: {} }; } }
function saveState(s) { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag, def) => { const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def; };
  return {
    iterations: Math.max(1, parseInt(get('--iterations', '3'), 10)),
    model: get('--model', null),
    // na 2ª tentativa de uma tarefa usa um modelo mais forte
    fallbackModel: get('--fallback-model', null), // ex.: z-ai/glm-5.3 (mais forte, mas lento no plano grátis)
    task: get('--task', null),
  };
}

// Roda npm test e devolve { ok, pass, fail, output }
function runTests(cwd) {
  const r = spawnSync(process.execPath, ['--test', 'test/**/*.test.js'], { cwd, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const num = (k) => { const m = out.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? parseInt(m[1], 10) : 0; };
  return { ok: r.status === 0, pass: num('pass'), fail: num('fail'), output: out };
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
  if (git(['status', '--porcelain'], ROOT)) {
    // só os arquivos versionados importam; a worktree parte do último commit de main
    log(c.yellow('Aviso: há mudanças não commitadas em main; a worktree usa o último commit.'));
  }
  if (!fs.existsSync(WT)) {
    const branches = git(['branch', '--list', BRANCH], ROOT);
    fs.mkdirSync(path.dirname(WT), { recursive: true });
    if (branches) git(['worktree', 'add', WT, BRANCH], ROOT);
    else git(['worktree', 'add', '-b', BRANCH, WT, 'main'], ROOT);
  }
  // descarta restos de uma execução interrompida
  git(['reset', '--hard', 'HEAD']);
  git(['clean', '-fd']);
  // traz novidades de main (tarefas novas no SDD, correções feitas à mão)
  try {
    const behind = git(['rev-list', '--count', `${BRANCH}..main`]);
    if (behind !== '0') {
      git(['merge', '--no-edit', '-q', 'main']);
      log(c.dim(`Branch ${BRANCH} atualizada com ${behind} commit(s) de main.`));
    }
  } catch (e) {
    try { git(['merge', '--abort']); } catch {}
    log(c.yellow(`Não foi possível juntar main em ${BRANCH} (conflito). Resolva à mão: cd .worktrees/self-improve && git merge main`));
  }
}

function gatesCheck(before) {
  const changed = git(['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3).trim().replace(/\\/g, '/'));
  if (!changed.length) return { ok: false, reason: 'nenhuma alteração feita' };
  const touched = PROTECTED.filter((p) => changed.includes(p));
  if (touched.length) return { ok: false, reason: `arquivos protegidos alterados: ${touched.join(', ')}` };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WT, 'package.json'), 'utf8'));
    if (!pkg.scripts || pkg.scripts.test !== TEST_SCRIPT) return { ok: false, reason: 'scripts.test do package.json foi alterado' };
  } catch (e) { return { ok: false, reason: 'package.json inválido: ' + e.message }; }
  const t = runTests(WT);
  if (!t.ok) {
    const fails = t.output.split('\n').filter((l) => /^not ok|error:|Error/.test(l.trim())).slice(0, 8).join('\n');
    return { ok: false, reason: `testes falharam (${t.fail} falhas)\n${fails}` };
  }
  if (t.pass < before.pass) return { ok: false, reason: `número de testes diminuiu (${before.pass} → ${t.pass})` };
  return { ok: true, tests: t, changed };
}

// ---------- uma iteração ----------
async function iteration(apiKey, baseModel, fallbackModel, forcedTask, state) {
  const sdd = fs.readFileSync(path.join(WT, SDD), 'utf8');
  const tasks = readTasks(sdd);
  const task = forcedTask ? tasks.find((t) => t.id === forcedTask) : tasks.find((t) => t.state === ' ');
  if (!task) return 'fim';

  const previous = state.lastFailure && state.lastFailure[task.id];
  const model = previous && fallbackModel ? fallbackModel : baseModel;
  const before = runTests(WT);
  if (!before.ok) { log(c.red('Os testes já estão falhando na worktree; abortando.')); return 'erro'; }

  log(`\n## ${new Date().toISOString()}: ${task.id}: ${task.title}`);
  log(c.dim(`modelo: ${model} · testes antes: ${before.pass}`));

  const agent = new Agent({
    apiKey, model, cwd: WT, tools: CODE_TOOLS,
    systemExtra: `# Modo de auto-melhoria
Você está melhorando o PRÓPRIO código do rfcode, seguindo o SDD em docs/SDD.md.
Regras:
- Leia docs/SDD.md (seções 2 a 4) e os arquivos relevantes antes de mudar algo.
- Implemente SOMENTE a tarefa indicada, com mudanças pequenas e coerentes com o estilo do código.
- Escreva os testes de aceite em test/<tema>.test.js usando node:test, sem rede (simule fetch quando preciso).
- Arquivos protegidos (NÃO edite): ${PROTECTED.join(', ')}.
- Comandos permitidos: npm test, node --test <arquivos>, node --check <arquivo>, git status/diff/log/show.
- Rode npm test antes de terminar e corrija até passar.
- Não use dependências externas.
- Em repositórios git temporários de teste, configure a identidade antes de commitar: git config user.name "rfcode-test" e git config user.email "test@rfcode.local" (a máquina pode não ter identidade global).
- No Windows: espere processos filhos terminarem antes de apagar pastas temporárias (use execFileSync ou await) e apague com fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }).`,
  });

  const timer = setTimeout(() => { log(c.yellow('Tempo da iteração esgotado; interrompendo.')); agent.abort(); }, ITERATION_TIMEOUT_MS);
  let finalText = '';
  const retryNote = previous
    ? `\n\nATENÇÃO: uma tentativa anterior desta tarefa foi REJEITADA. Motivo:\n${previous}\nEvite repetir esse erro.`
    : '';
  await agent.send(`Implemente a tarefa do SDD abaixo.\n\n${task.body}${retryNote}`, {
    approve: async (info) => {
      const d = policy(info);
      log(`- ${info.label}${d === 'yes' ? '' : c.red(' ✗ negado: ' + d.deny)}`);
      return d;
    },
    onToolCall: (info) => { if (!['write_file', 'edit_file', 'run_command'].includes(info.name)) log(c.dim(`- ${info.label}`)); },
    onText: (t) => { finalText += t; },
    onAssistantEnd: () => { if (finalText.trim()) log(c.dim('  ' + finalText.trim().split('\n').join('\n  '))); finalText = ''; },
    onRetry: (m) => log(c.yellow(m)),
    onError: (m) => log(c.red('Erro do agente: ' + m)),
  });
  clearTimeout(timer);

  const g = gatesCheck(before);
  if (g.ok) {
    markTask(task.id, 'x', `Feito pelo loop em ${new Date().toISOString().slice(0, 10)} (${model}).`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', `feat(${task.id}): ${task.title} [self-improve]\n\nArquivos: ${g.changed.join(', ')}\nTestes: ${g.tests.pass} passando.`]);
    delete state.failures[task.id];
    if (state.lastFailure) delete state.lastFailure[task.id];
    log(c.green(`✔ ${task.id} aceita: ${g.tests.pass} testes passando, commit ${git(['rev-parse', '--short', 'HEAD'])}`));
    return 'ok';
  }

  log(c.red(`✗ ${task.id} rejeitada: ${g.reason}`));
  git(['reset', '--hard', 'HEAD']);
  git(['clean', '-fd']);
  state.failures[task.id] = (state.failures[task.id] || 0) + 1;
  state.lastFailure = state.lastFailure || {};
  state.lastFailure[task.id] = g.reason.slice(0, 2000);
  if (state.failures[task.id] >= MAX_FAILURES) {
    markTask(task.id, '!', `Bloqueada pelo loop após ${MAX_FAILURES} tentativas. Último motivo: ${g.reason.split('\n')[0]}`);
    git(['commit', '-q', '-am', `chore(${task.id}): marcada como bloqueada [self-improve]`]);
    log(c.yellow(`${task.id} marcada como bloqueada [!] para revisão humana.`));
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

  ensureWorktree();
  const state = loadState();
  log(c.bold(`\n# Auto-melhoria rfcode: ${new Date().toLocaleString('pt-BR')} (${opts.iterations} iterações)`));

  let stop = false;
  process.on('SIGINT', () => { stop = true; log(c.yellow('Interrompido pelo usuário; terminando após a iteração atual.')); });

  for (let i = 0; i < opts.iterations && !stop; i++) {
    const r = await iteration(apiKey, model, opts.fallbackModel, i === 0 ? opts.task : null, state);
    saveState(state);
    if (r === 'fim') { log(c.green('Backlog concluído: não há tarefas pendentes.')); break; }
    if (r === 'erro') break;
  }

  const ahead = git(['rev-list', '--count', `main..${BRANCH}`], ROOT);
  log(`\nBranch ${c.bold(BRANCH)} está ${ahead} commit(s) à frente de main.`);
  log(c.dim(`Revisar:  git log --stat main..${BRANCH}`));
  log(c.dim(`Aceitar:  git merge ${BRANCH}`));
}

main().catch((e) => { console.error(c.red(e.stack || e.message)); process.exit(1); });
