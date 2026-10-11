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

const { c: T, banner, MarkdownStream, Spinner, toolLine, prompt } = require('../lib/tui');
const VERSION = require('../package.json').version;

// ---------- cores (paleta da marca, ver lib/tui.js) ----------
const c = { dim: T.muted, bold: T.bold, green: T.green, red: T.red, yellow: T.amber, cyan: T.cyan, magenta: T.lime };
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
  console.log(c.yellow('\nInforme sua API key da NVIDIA. Para gerar uma, acesse https://build.nvidia.com e clique em "Get API Key".'));
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
  const spin = new Spinner(out);
  let md = null, reasoningShown = false, cmdOpen = false, cmdTail = '\n';
  const endText = () => { if (md) { md.flush(); md = null; } };
  const endCmd = () => { if (cmdOpen) { if (!cmdTail.endsWith('\n')) out('\n'); cmdOpen = false; } };
  // caminhos dentro da pasta de trabalho aparecem relativos ("src/a.js" em vez de "C:\...\src\a.js")
  const rel = (label) => {
    const cwd = state.agent.cwd;
    return label.split(cwd + path.sep).join('').split(cwd.replace(/\\/g, '/') + '/').join('');
  };
  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n));
  return {
    onThinking() { reasoningShown = false; spin.start('pensando'); },
    onResponseStart() { spin.stop(); },
    onReasoning(t) {
      if (!state.showThinking) return;
      spin.stop();
      if (!reasoningShown) { out(`\n  ${T.muted('✻ raciocínio')}\n  `); reasoningShown = true; }
      out(T.muted(t.replace(/\n/g, '\n  ')));
    },
    onText(t) {
      spin.stop();
      if (!md) { out(reasoningShown ? '\n\n' : '\n'); md = new MarkdownStream(out); }
      md.push(t);
    },
    onAssistantEnd() { endText(); if (reasoningShown) out('\n'); },
    onToolCall({ name, label, preview }) {
      spin.stop();
      endText();
      endCmd();
      if (name === 'update_plan') return; // o plano aparece em onPlan
      console.log(toolLine(rel(label)));
      if (preview) {
        for (const l of preview.removed) console.log(`    ${T.red('- ' + l)}`);
        for (const l of preview.added) console.log(`    ${T.green('+ ' + l)}`);
        if (preview.more) console.log(`    ${T.muted(`… mais ${preview.more} linhas`)}`);
      }
      spin.start('executando');
    },
    async approve({ forced, name, args } = {}) {
      spin.stop();
      if (forced) console.log(`  ${T.red('⚠')} ${T.bold(T.red('Ação importante (enviar, pagar ou excluir). Confira antes de permitir.'))}`);
      const rule = forced ? '' : suggestRule(name, args);
      const key = (k, txt) => `${T.lime(T.bold(k))} ${T.muted(txt)}`;
      console.log(`  ${T.amber('?')} ${T.bold('Permitir?')}  ${key('s', 'sim')}  ${key('n', 'não')}  ${key('t', 'tudo nesta conversa')}${rule ? `  ${key('p', 'sempre: ' + rule)}` : ''}`);
      const a = ((await ask(`    ${prompt()}`)) ?? 'n').trim().toLowerCase();
      let r;
      if (['t', 'todos', 'tudo', 'a', 'all'].includes(a)) r = 'all';
      else if (rule && ['p', 'sempre'].includes(a)) { console.log(`    ${T.muted('regra salva em ' + addAllow(rule))}`); r = 'yes'; }
      else if (['s', 'sim', 'y', 'yes', ''].includes(a)) r = 'yes';
      if (r) { spin.start('executando'); return r; }
      const why = ((await ask(`    ${T.muted('o que fazer em vez disso? (opcional)')} ${prompt()}`)) || '').trim();
      console.log(`    ${T.red('✗ negado')}`);
      return { deny: why };
    },
    onCommandOutput(s) {
      spin.stop();
      if (!cmdOpen) { out('    '); cmdOpen = true; }
      out(T.muted(s.replace(/\r?\n(?!$)/g, '\n    ')));
      cmdTail = s;
    },
    async ask({ question, options }) {
      spin.stop();
      endText();
      console.log(`\n  ${T.lime('?')} ${T.bold(question)}`);
      (options || []).forEach((o, i) => console.log(`    ${T.lime(String(i + 1))} ${o}`));
      const a = ((await ask(`    ${options && options.length ? T.muted('número ou resposta') + ' ' : ''}${prompt()}`)) ?? '').trim();
      const n = parseInt(a, 10);
      return options && n >= 1 && n <= options.length && String(n) === a ? options[n - 1] : a;
    },
    onToolResult({ name, output, error }) {
      spin.stop();
      endCmd();
      if (error) {
        if (output.startsWith('O usuário NEGOU')) return;
        console.log(`    ${T.red('✗ ' + output.replace(/^Erro:\s*/, '').split('\n')[0].slice(0, 160))}`);
        return;
      }
      if (name === 'update_plan') return;
      if (name === 'run_command') {
        const code = /\[exit code: (-?\d+|null)\]\s*$/.exec(output);
        if (code) console.log(`    ${code[1] === '0' ? T.green('✓ ok') : T.amber(`⎿ saiu com código ${code[1]}`)}`);
        return;
      }
      const lines = output.split('\n');
      const summary = name === 'read_file' ? `${lines.length} linhas` : lines[0].slice(0, 140) + (lines.length > 1 ? ` (+${lines.length - 1} linhas)` : '');
      console.log(`    ${T.muted('⎿ ' + summary)}`);
    },
    onRetry(msg) { spin.stop(); console.log(`  ${T.amber('↻')} ${T.muted(msg)}`); },
    onError(msg) { spin.stop(); endText(); console.log(`\n  ${T.red('✗')} ${T.red(msg)}`); },
    onAborted() { spin.stop(); endText(); console.log(`\n  ${T.amber('■ interrompido')}`); },
    onPlan(p) {
      spin.stop();
      const done = p.steps.filter((s) => s.status === 'done').length;
      const icon = { done: T.green('✓'), in_progress: T.lime('▸'), pending: T.muted('○') };
      console.log(`\n  ${T.lime('◆')} ${T.bold(p.goal || 'Plano')} ${T.muted(`${done}/${p.steps.length}`)}`);
      for (const s of p.steps) console.log(`    ${icon[s.status]} ${s.status === 'done' ? T.muted(s.text) : s.status === 'in_progress' ? T.bold(s.text) : s.text}`);
      if (p.why) console.log(`    ${T.muted('↳ ' + p.why)}`);
      spin.start('executando');
    },
    onUsage(u) { state.usage = u; },
    onDone() {
      spin.stop();
      endText();
      endCmd();
      const secs = state.t0 ? Math.round((Date.now() - state.t0) / 1000) : 0;
      const parts = [state.usage && `${fmtTokens(state.usage.total)} tokens na conversa`, secs && `${secs}s`].filter(Boolean);
      if (parts.length) console.log(`\n  ${T.muted('· ' + parts.join(' · '))}`);
    },
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
      for (const [m, d] of SUGGESTED_MODELS) console.log(`  ${m === agent.model ? c.green('●') : ' '} ${c.bold(m)}  ${c.dim(d)}`);
      console.log(c.dim('  Outros modelos: https://build.nvidia.com/models (é preciso suportar chamadas de ferramenta)'));
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
    console.log(`rfcode ${VERSION}
Agente de IA para o terminal, com os modelos de build.nvidia.com.

Uso:
  rfcode                   modo interativo na pasta atual
  rfcode "tarefa"          executa a tarefa e continua no modo interativo
  rfcode -p "tarefa"       executa a tarefa e sai (aprovação automática)
  rfcode -c, --continue    retoma a última conversa desta pasta
  rfcode --key             configura uma nova API key
  rfcode --model <id>      usa outro modelo

Desenvolvimento:
  rfcode --self-improve [--iterations N]
  rfcode --painel

API key: ${CONFIG_FILE} ou variável de ambiente NVIDIA_API_KEY`);
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

  if (!argv.includes('-p')) out(banner({ version: VERSION, model, cwd: process.cwd(), memory: !!readUserMemory() }));

  let apiKey = cfg.apiKey || process.env.NVIDIA_API_KEY;
  const ki = argv.indexOf('--key');
  if (ki >= 0) argv.splice(ki, 1);
  if (!apiKey || ki >= 0) apiKey = await askApiKey(cfg);

  const state = { agent: new Agent({ apiKey, model, cwd: process.cwd(), saveSession: true }), showThinking: false };
  const hooks = cliHooks(state);
  const run = (text) => { state.t0 = Date.now(); return state.agent.send(text, hooks); };

  // --continue / -c: retoma a última conversa desta pasta
  const ci = argv.findIndex((a) => a === '--continue' || a === '-c');
  if (ci >= 0) {
    argv.splice(ci, 1);
    const sm = state.agent.sessionManager;
    const last = sm.list().find((s) => s.cwd === process.cwd());
    const msgs = last && sm.load(last.file);
    if (msgs) { state.agent.messages = msgs; console.log(`  ${T.green('↺')} retomando ${T.bold(last.title)} ${T.muted(`(${msgs.length} mensagens)`)}`); }
    else console.log(`  ${T.muted('nenhuma conversa anterior nesta pasta')}`);
  }

  process.on('SIGINT', () => {
    if (state.agent.busy) state.agent.abort();
    else { console.log(''); process.exit(0); }
  });
  rl.on('SIGINT', () => process.emit('SIGINT'));

  const pi = argv.indexOf('-p');
  if (pi >= 0) {
    state.agent.autoApprove = true;
    await run(argv.slice(pi + 1).join(' '));
    rl.close();
    process.exit(0);
  }
  if (argv.length) await run(argv.join(' '));

  while (true) {
    let input = await ask(`\n${prompt()}`);
    if (input === null) break;
    while (input.endsWith('\\')) {
      const more = await ask(`${T.muted('·')} `);
      if (more === null) break;
      input = input.slice(0, -1) + '\n' + more;
    }
    input = input.trim();
    if (!input) continue;
    if (input.startsWith('/')) {
      const r = await handleCommand(state, cfg, input);
      if (r && r.send) await run(r.send);
      continue;
    }
    await run(input);
  }
  process.exit(0);
}

main().catch((e) => { console.error(c.red(e.stack || e.message)); process.exit(1); });
