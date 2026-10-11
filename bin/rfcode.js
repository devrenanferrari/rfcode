#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline');
const {
  Agent, CONFIG_FILE, DEFAULT_MODEL, SUGGESTED_MODELS, loadConfig, saveConfig, validateKey,
} = require('../lib/agent');
const { SessionManager } = require('../lib/sessions');
const { addAllow, suggestRule } = require('../lib/permissions');
const { remember, readUserMemory, userFile: memoryFile } = require('../lib/memory');
const {
  listCommands, parseCommand, expandCustom, reviewFor, PLAN_PREFIX, GO_PROMPT, INIT_PROMPT,
} = require('../lib/commands');

// ---------- cores ----------
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};
const out = (s) => process.stdout.write(s);

// ---------- readline ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let closed = false;
const lineQueue = [];
const waiters = [];
rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else lineQueue.push(l); });
rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
const ask = (q) => new Promise((res) => {
  if (process.stdin.isTTY && !closed) { rl.setPrompt(q); rl.prompt(true); } else out(q);
  if (lineQueue.length) return res(lineQueue.shift());
  if (closed) return res(null);
  waiters.push(res);
});

async function askApiKey(cfg) {
  console.log(c.yellow('\nInforme sua API key da NVIDIA (grátis em https://build.nvidia.com → "Get API Key").'));
  while (true) {
    const answer = await ask(c.bold('NVIDIA API key (nvapi-...): '));
    if (answer === null) process.exit(1);
    const key = answer.trim();
    if (!key.startsWith('nvapi-')) { console.log(c.red('A chave deve começar com "nvapi-".')); continue; }
    out(c.dim('Validando chave... '));
    const r = await validateKey(key);
    if (r === 'invalid') { console.log(c.red('inválida (401/403). Tente de novo.')); continue; }
    console.log(r === 'ok' ? c.green('ok') : c.yellow('sem conexão, salvando mesmo assim'));
    cfg.apiKey = key;
    saveConfig(cfg);
    console.log(c.dim(`Salva em ${CONFIG_FILE}`));
    return key;
  }
}

// ---------- ligação do agente com o terminal ----------
function cliHooks(state) {
  let reasoningShown = false, textStarted = false;
  return {
    onThinking() { reasoningShown = false; textStarted = false; out(c.dim('⠿ pensando...\r')); },
    onResponseStart() { out('\r\x1b[2K'); },
    onReasoning(t) {
      if (!state.showThinking) return;
      if (!reasoningShown) { out(c.dim('\n💭 ')); reasoningShown = true; }
      out(c.dim(t));
    },
    onText(t) {
      if (!textStarted) { out(reasoningShown ? '\n\n' : '\n'); textStarted = true; }
      out(t);
    },
    onAssistantEnd() { if (textStarted || reasoningShown) out('\n'); },
    onToolCall({ label, preview }) {
      console.log(c.cyan(`\n● ${label}`));
      if (preview) {
        for (const l of preview.removed) console.log(c.red('- ' + l));
        for (const l of preview.added) console.log(c.green('+ ' + l));
        if (preview.more) console.log(c.dim(`  ... (+${preview.more} linhas)`));
      }
    },
    async approve({ forced, name, args } = {}) {
      if (forced) console.log(c.red(c.bold('  ⚠ Ação importante (enviar, pagar ou excluir). Confira antes de permitir.')));
      const rule = forced ? '' : suggestRule(name, args);
      const a = ((await ask(c.yellow(`  Permitir? [s]im / [n]ão / [t]odos nesta sessão${rule ? ` / [p]ara sempre (${rule})` : ''}: `))) ?? 'n').trim().toLowerCase();
      if (['t', 'todos', 'a', 'all'].includes(a)) return 'all';
      if (rule && ['p', 'sempre'].includes(a)) { console.log(c.dim(`  Regra salva em ${addAllow(rule)}`)); return 'yes'; }
      if (['s', 'sim', 'y', 'yes', ''].includes(a)) return 'yes';
      const why = ((await ask(c.dim('  Motivo / instrução para o modelo (opcional): '))) || '').trim();
      console.log(c.red('  ✗ negado'));
      return { deny: why };
    },
    onCommandOutput(s) { out(c.dim(s)); },
    async ask({ question, options }) {
      console.log(c.bold(c.cyan(`\n? ${question}`)));
      (options || []).forEach((o, i) => console.log(`  ${c.bold(String(i + 1))}. ${o}`));
      const a = ((await ask(c.cyan(options && options.length ? '  Número ou resposta: ' : '  Resposta: '))) ?? '').trim();
      const n = parseInt(a, 10);
      return options && n >= 1 && n <= options.length && String(n) === a ? options[n - 1] : a;
    },
    onToolResult({ name, output, error }) {
      if (error) { if (!output.startsWith('O usuário NEGOU')) console.log(c.red('  ⎿ ' + output.split('\n')[0])); return; }
      if (name === 'run_command') return;
      const lines = output.split('\n');
      const summary = name === 'read_file'
        ? `${lines.length} linhas lidas`
        : lines.slice(0, 3).join('\n  ') + (lines.length > 3 ? c.dim(` ... (+${lines.length - 3})`) : '');
      console.log(c.dim('  ⎿ ' + summary));
    },
    onRetry(msg) { console.log(c.yellow('\n' + msg)); },
    onError(msg) { out('\r\x1b[2K'); console.log(c.red('\nErro: ' + msg)); },
    onAborted() { out('\r\x1b[2K'); console.log(c.yellow('\n[interrompido]')); },
    onPlan(p) {
      const icon = { done: c.green('☑'), in_progress: c.cyan('◐'), pending: c.dim('☐') };
      if (p.goal) console.log(c.bold(`  🎯 ${p.goal}`));
      for (const s of p.steps) console.log(`  ${icon[s.status]} ${s.status === 'done' ? c.dim(s.text) : s.status === 'in_progress' ? c.bold(s.text) : s.text}`);
      if (p.why) console.log(c.dim(`     ↳ ${p.why}`));
    },
    onUsage(u) { state.usage = u; },
    onDone() { if (state.usage) console.log(c.dim(`  · ${state.usage.total.toLocaleString('pt-BR')} tokens nesta sessão`)); },
  };
}

// ---------- comandos ----------
// Devolve { send, display } quando o comando vira um pedido ao agente.
async function handleCommand(state, cfg, line) {
  const raw = line.slice(1).split(/\s+/)[0].toLowerCase();
  const parsed = parseCommand(line) || { name: raw, args: '' };
  // /sessions e /resume têm comportamento próprio na CLI (listar e retomar por número)
  const cmd = raw === 'sessions' || raw === 'resume' ? raw : parsed.name;
  const arg = parsed.args;
  const agent = state.agent;
  switch (cmd) {
    case 'help': {
      console.log('\n' + c.bold('Comandos:'));
      for (const k of listCommands(agent.cwd, 'cli')) {
        const name = `/${k.name}${k.args ? ' ' + k.args : ''}`;
        console.log(`  ${name.padEnd(20)} ${k.desc}${k.custom ? c.dim(' (personalizado)') : ''}`);
      }
      console.log(`  ${'/models'.padEnd(20)} lista modelos sugeridos`);
      console.log(`  ${'/sessions'.padEnd(20)} lista as 10 últimas conversas; /resume <n> retoma uma`);
      console.log(c.dim('Comandos personalizados: .rfcode/commands/<nome>.md no projeto ou ~/.rfcode/commands ($ARGUMENTS = texto depois do comando).'));
      console.log(c.dim('Dica: termine uma linha com \\ para continuar escrevendo na próxima. Ctrl+C interrompe a resposta.'));
      return null;
    }
    case 'new':
      agent.clear();
      agent.planOnly = false;
      agent.sessionManager = new SessionManager({ cwd: agent.cwd });
      console.log(c.dim('Conversa nova.'));
      return null;
    case 'history':
      return handleCommand(state, cfg, '/sessions');
    case 'plan':
      if (!arg) { console.log(c.yellow('Use /plan <pedido>. O rfcode investiga e propõe um plano sem alterar nada; depois /go executa.')); return null; }
      agent.planOnly = true;
      console.log(c.yellow('Modo plano: nada será alterado até você digitar /go.'));
      return { send: PLAN_PREFIX + arg };
    case 'go':
      if (!agent.planOnly) { console.log(c.yellow('Nenhum plano aguardando. Use /plan <pedido> primeiro.')); return null; }
      agent.planOnly = false;
      return { send: GO_PROMPT };
    case 'init':
      return { send: INIT_PROMPT };
    case 'review': {
      const r = reviewFor(agent.cwd);
      if (r.reason) { console.log(c.dim('Nada para revisar: ' + r.reason)); return null; }
      return { send: r.send };
    }
    case 'memory': {
      if (arg) { console.log(c.green(remember(arg, 'usuario'))); return null; }
      const mem = readUserMemory();
      console.log(mem ? c.dim(memoryFile() + '\n') + mem : c.dim('A memória ainda está vazia. Diga "lembre que..." ou use /memory <texto>.'));
      return null;
    }
    case 'compact':
      if (agent.messages.length < 4) { console.log(c.dim('A conversa ainda é curta; não precisa resumir.')); return null; }
      out(c.dim('Resumindo a conversa... '));
      try {
        await agent.compact();
        agent.sessionManager.save(agent.messages);
        console.log(c.green('pronto.'));
      } catch (e) { console.log(c.red(e.message)); }
      return null;
    case 'model':
      if (arg) { agent.model = arg; cfg.model = arg; saveConfig(cfg); }
      console.log(`Modelo: ${c.bold(agent.model)}`);
      return;
    case 'models':
      for (const [m, d] of SUGGESTED_MODELS) console.log(`  ${m === agent.model ? c.green('●') : ' '} ${c.bold(m)} ${c.dim('— ' + d)}`);
      console.log(c.dim('  Outros: https://build.nvidia.com/models (precisa suportar tool calling)'));
      return;
    case 'key':
      agent.apiKey = await askApiKey(cfg);
      return;
    case 'clear':
      agent.clear();
      console.log(c.dim('Conversa limpa.'));
      return;
    case 'undo':
      console.log(agent.undo());
      return;
    case 'auto':
      agent.autoApprove = !agent.autoApprove;
      console.log(`Aprovação automática: ${agent.autoApprove ? c.green('ligada') : c.yellow('desligada')}`);
      return;
    case 'think':
      state.showThinking = !state.showThinking;
      console.log(`Mostrar raciocínio: ${state.showThinking ? 'sim' : 'não'}`);
      return;
    case 'cd':
      try {
        process.chdir(path.resolve(agent.cwd, arg || '.'));
        agent.cwd = process.cwd();
        console.log(c.dim(agent.cwd));
      } catch (e) { console.log(c.red(e.message)); }
      return;
    case 'sessions': {
      const list = agent.sessionManager.list().filter((s) => s.id !== agent.sessionManager.id);
      if (!list.length) { console.log(c.dim('Nenhuma sessão salva.')); return; }
      console.log(c.bold('Sessões salvas (mais recentes primeiro):'));
      list.slice(0, 10).forEach((s, i) => {
        const when = new Date(s.updated).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        console.log(`  ${c.bold(String(i + 1).padStart(2))}. ${s.title} ${c.dim(`· ${when} · ${s.count} msgs · ${path.basename(s.cwd || '')}`)}`);
      });
      if (list.length > 10) console.log(c.dim(`  … e mais ${list.length - 10}`));
      console.log(c.dim('  Use /resume <n> para continuar uma delas.'));
      return;
    }
    case 'resume': {
      const list = agent.sessionManager.list().filter((s) => s.id !== agent.sessionManager.id);
      const n = parseInt(arg || '1', 10);
      const s = list[n - 1];
      if (!s) { console.log(c.red(`Sessão ${arg || 1} não encontrada (há ${list.length}). Veja /sessions.`)); return; }
      const messages = agent.sessionManager.load(s.file);
      if (!messages) { console.log(c.red('Falha ao carregar a sessão.')); return; }
      agent.messages = messages;
      console.log(c.green(`Retomando "${s.title}" (${messages.length} mensagens).`));
      if (s.cwd && s.cwd !== agent.cwd) console.log(c.yellow(`  Atenção: a sessão era da pasta ${s.cwd}. Use /cd para voltar a ela, se quiser.`));
      return;
    }
    case 'exit': case 'quit': case 'sair':
      rl.close(); process.exit(0);
    default: {
      const text = expandCustom(cmd, arg, agent.cwd);
      if (text) return { send: text };
      console.log(c.red(`Comando desconhecido: /${cmd}. Use /help.`));
    }
  }
  return null;
}

// ---------- main ----------
async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`rfcode — agente de código no terminal com modelos gratuitos da NVIDIA

Uso:
  rfcode                 abre o modo interativo no diretório atual
  rfcode "tarefa"        executa uma tarefa e continua no modo interativo
  rfcode -p "tarefa"     executa uma tarefa e sai (aprovação automática)
  rfcode --continue      retoma a última conversa desta pasta (atalho: -c)
  rfcode --key           pede uma nova API key da NVIDIA
  rfcode --model <nome>  usa outro modelo
  rfcode --self-improve [--iterations N]  roda o loop de auto-melhoria do SDD
  rfcode --painel        abre o painel do administrador (acompanhar e dirigir a auto-melhoria)

API key: ${CONFIG_FILE} (ou variável de ambiente NVIDIA_API_KEY)`);
    process.exit(0);
  }

  if (argv[0] === '--painel') {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'dashboard.js'), '--open'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (argv[0] === '--self-improve') {
    // repassa para o loop de auto-melhoria (scripts/self-improve.js)
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'self-improve.js'), ...argv.slice(1)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  let model = cfg.model || DEFAULT_MODEL;
  const mi = argv.indexOf('--model');
  if (mi >= 0 && argv[mi + 1]) { model = argv[mi + 1]; argv.splice(mi, 2); }

  console.log(c.magenta(c.bold('\n  ╭───────────────────────────╮\n  │   rfcode  ·  NVIDIA free  │\n  ╰───────────────────────────╯')));

  let apiKey = cfg.apiKey || process.env.NVIDIA_API_KEY;
  const ki = argv.indexOf('--key');
  if (ki >= 0) argv.splice(ki, 1);
  if (!apiKey || ki >= 0) apiKey = await askApiKey(cfg);

  const state = { agent: new Agent({ apiKey, model, cwd: process.cwd(), saveSession: true }), showThinking: false };
  const hooks = cliHooks(state);

  console.log(c.dim(`  modelo: ${model}\n  pasta:  ${process.cwd()}\n  /help para comandos\n`));

  // --continue / -c: retoma a última conversa desta pasta
  const ci = argv.findIndex((a) => a === '--continue' || a === '-c');
  if (ci >= 0) {
    argv.splice(ci, 1);
    const sm = state.agent.sessionManager;
    const last = sm.list().find((s) => s.cwd === process.cwd());
    const msgs = last && sm.load(last.file);
    if (msgs) { state.agent.messages = msgs; console.log(c.green(`  Retomando "${last.title}" (${msgs.length} mensagens).\n`)); }
    else console.log(c.dim('  Nenhuma conversa anterior nesta pasta.\n'));
  }

  process.on('SIGINT', () => {
    if (state.agent.busy) state.agent.abort();
    else { console.log('\nAté mais!'); process.exit(0); }
  });
  rl.on('SIGINT', () => process.emit('SIGINT'));

  const pi = argv.indexOf('-p');
  if (pi >= 0) {
    state.agent.autoApprove = true;
    await state.agent.send(argv.slice(pi + 1).join(' '), hooks);
    rl.close();
    process.exit(0);
  }
  if (argv.length) await state.agent.send(argv.join(' '), hooks);

  while (true) {
    let input = await ask(c.bold(c.magenta('\n> ')));
    if (input === null) break;
    while (input.endsWith('\\')) {
      const more = await ask(c.dim('  '));
      if (more === null) break;
      input = input.slice(0, -1) + '\n' + more;
    }
    input = input.trim();
    if (!input) continue;
    if (input.startsWith('/')) {
      const r = await handleCommand(state, cfg, input);
      if (r && r.send) await state.agent.send(r.send, hooks);
      continue;
    }
    await state.agent.send(input, hooks);
  }
  process.exit(0);
}

main().catch((e) => { console.error(c.red(e.stack || e.message)); process.exit(1); });
