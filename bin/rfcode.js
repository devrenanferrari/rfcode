#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline');
const {
  Agent, CONFIG_FILE, DEFAULT_MODEL, SUGGESTED_MODELS, loadConfig, saveConfig, validateKey,
} = require('../lib/agent');

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
    async approve() {
      const a = ((await ask(c.yellow('  Permitir? [s]im / [n]ão / [t]odos nesta sessão: '))) ?? 'n').trim().toLowerCase();
      if (['t', 'todos', 'a', 'all'].includes(a)) return 'all';
      if (['s', 'sim', 'y', 'yes', ''].includes(a)) return 'yes';
      const why = ((await ask(c.dim('  Motivo / instrução para o modelo (opcional): '))) || '').trim();
      console.log(c.red('  ✗ negado'));
      return { deny: why };
    },
    onCommandOutput(s) { out(c.dim(s)); },
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
  };
}

// ---------- comandos ----------
async function handleCommand(state, cfg, line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const agent = state.agent;
  switch (cmd) {
    case 'help':
      console.log(`
${c.bold('Comandos:')}
  /help             esta ajuda
  /model [nome]     mostra ou troca o modelo
  /models           lista modelos sugeridos
  /key              trocar a API key da NVIDIA
  /clear            limpa a conversa
  /auto             liga/desliga aprovação automática de edições e comandos
  /think            mostra/oculta o raciocínio do modelo
  /cd <dir>         muda o diretório de trabalho
  /exit             sair
${c.dim('Dica: termine uma linha com \\ para continuar escrevendo na próxima. Ctrl+C interrompe a resposta.')}`);
      return;
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
    case 'exit': case 'quit': case 'sair':
      rl.close(); process.exit(0);
    default:
      console.log(c.red(`Comando desconhecido: /${cmd}. Use /help.`));
  }
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
  rfcode --key           pede uma nova API key da NVIDIA
  rfcode --model <nome>  usa outro modelo

API key: ${CONFIG_FILE} (ou variável de ambiente NVIDIA_API_KEY)`);
    process.exit(0);
  }

  let model = cfg.model || DEFAULT_MODEL;
  const mi = argv.indexOf('--model');
  if (mi >= 0 && argv[mi + 1]) { model = argv[mi + 1]; argv.splice(mi, 2); }

  console.log(c.magenta(c.bold('\n  ╭───────────────────────────╮\n  │   rfcode  ·  NVIDIA free  │\n  ╰───────────────────────────╯')));

  let apiKey = cfg.apiKey || process.env.NVIDIA_API_KEY;
  const ki = argv.indexOf('--key');
  if (ki >= 0) argv.splice(ki, 1);
  if (!apiKey || ki >= 0) apiKey = await askApiKey(cfg);

  const state = { agent: new Agent({ apiKey, model, cwd: process.cwd() }), showThinking: false };
  const hooks = cliHooks(state);

  console.log(c.dim(`  modelo: ${model}\n  pasta:  ${process.cwd()}\n  /help para comandos\n`));

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
    if (input.startsWith('/')) { await handleCommand(state, cfg, input); continue; }
    await state.agent.send(input, hooks);
  }
  process.exit(0);
}

main().catch((e) => { console.error(c.red(e.stack || e.message)); process.exit(1); });
