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
const providers = require('../lib/providers');
const { runDoctor, formatDoctor } = require('../lib/doctor');
const VERSION = require('../package.json').version;

// ---------- cores (paleta da marca, ver lib/tui.js) ----------
const c = { dim: T.muted, bold: T.bold, green: T.green, red: T.red, yellow: T.amber, cyan: T.cyan, magenta: T.lime };
const out = (s) => process.stdout.write(s);

// ---------- readline ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let closed = false;
const lineQueue = [];
const waiters = [];
// agente atual (para receber mensagens digitadas enquanto ele trabalha)
let liveAgent = null;
rl.on('line', (l) => {
  const w = waiters.shift();
  if (w) { w(l); return; }
  // digitou durante uma resposta: vai para a fila e o agente considera no próximo passo
  if (liveAgent && liveAgent.busy && l.trim() && !l.trim().startsWith('/')) {
    const n = liveAgent.queue(l);
    out(`\r\x1b[2K  ${T.lime('↳')} ${T.muted(`na fila (${n}): o rfcode vai considerar no próximo passo`)}\n`);
    return;
  }
  lineQueue.push(l);
});
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

// ---------- provedores ----------
// /provider [id]: escolhe o provedor, pede e valida a chave (ou o endereço) e escolhe o modelo.
async function setupProvider(id, state, cfg) {
  const ids = Object.keys(providers.PROVIDERS);
  if (!id) {
    const fresh = loadConfig();
    // gratuitos primeiro, depois os pagos e os que rodam no computador
    const groups = [
      ['Gratuitos', ids.filter((pid) => providers.PROVIDERS[pid].free && !providers.PROVIDERS[pid].local)],
      ['Pagos', ids.filter((pid) => !providers.PROVIDERS[pid].free && !providers.PROVIDERS[pid].local && pid !== 'custom')],
      ['No seu computador', ids.filter((pid) => providers.PROVIDERS[pid].local)],
      ['Outro', ['custom']],
    ];
    const order = groups.flatMap(([, g]) => g);
    let n = 0;
    for (const [title, g] of groups) {
      console.log(`\n  ${T.bold(title)}`);
      for (const pid of g) {
        const p = providers.PROVIDERS[pid];
        const ready = pid === 'nvidia' ? !!(state.agent.apiKey || fresh.apiKey) : p.needsKey === false ? null : !!providers.keyFor(pid, fresh, { command: false });
        const tag = ready === true ? T.green(' configurado') : '';
        console.log(`    ${T.lime(String(++n).padStart(2))} ${p.name}${tag}${p.freeNote ? T.muted(`  ${p.freeNote}`) : ''}`);
      }
    }
    console.log(T.muted('\n  Os limites gratuitos mudam com frequência; confira no site de cada provedor.'));
    const a = ((await ask(`  número ou nome ${prompt()}`)) || '').trim().toLowerCase();
    id = /^\d+$/.test(a) ? order[+a - 1] : a;
  }
  const p = providers.PROVIDERS[id];
  if (!p) { console.log(c.red(`  Provedor desconhecido. Disponíveis: ${ids.join(', ')}`)); return; }
  if (id === 'nvidia') { state.agent.apiKey = await askApiKey(cfg); }
  else {
    if (id === 'custom') {
      const url = ((await ask(`  endereço base compatível com a API da OpenAI (ex.: https://servidor/v1) ${prompt()}`)) || '').trim();
      if (!url) return;
      const c2 = loadConfig(); c2.baseUrls = { ...(c2.baseUrls || {}), custom: url }; saveConfig(c2);
    }
    if (p.needsAccount) {
      const acc = ((await ask(`  ${p.needsAccount} (no painel do provedor) ${prompt()}`)) || '').trim();
      if (!acc) return;
      const c2 = loadConfig(); c2.vars = { ...(c2.vars || {}), [p.needsAccount]: acc }; saveConfig(c2);
    }
    // GitHub Models: se o GitHub CLI já está logado, não precisa de chave
    if (p.keyCommand && providers.keyFor(id, { useKeyCommand: { [id]: true } })) {
      const use = ((await ask(`  Usar o login do GitHub CLI (gh) como chave? (S/n) ${prompt()}`)) || 's').trim().toLowerCase();
      if (!use.startsWith('n')) {
        const c2 = loadConfig(); c2.useKeyCommand = { ...(c2.useKeyCommand || {}), [id]: true }; saveConfig(c2);
        console.log(c.green('  ok, usando o login do gh'));
      }
    }
    if ((p.needsKey !== false || id === 'custom') && !providers.keyFor(id, loadConfig())) {
      if (p.keyUrl) console.log(c.dim(`  Gere a chave em ${p.keyUrl}`));
      const key = ((await ask(`  API key de ${p.name}${p.needsKey === false ? ' (vazio se não exigir)' : ''} ${prompt()}`)) || '').trim();
      if (!key && p.needsKey !== false) return;
      if (key) {
        out(c.dim('  validando... '));
        const r = await providers.validateKey(id, key, loadConfig());
        if (r === 'invalid') { console.log(c.red('recusada.')); return; }
        console.log(r === 'ok' ? c.green('ok') : c.yellow('sem conexão; salvando assim mesmo'));
        const c2 = loadConfig(); c2.keys = { ...(c2.keys || {}), [id]: key }; saveConfig(c2);
      }
    }
  }
  out(c.dim('  buscando modelos...\n'));
  const live = await providers.listModels(id, loadConfig());
  const options = [...p.models.map(([m, d]) => ({ m, d })), ...live.filter((m) => !p.models.some(([x]) => x === m)).slice(0, 25).map((m) => ({ m, d: '' }))];
  if (!options.length) {
    console.log(c.yellow(`  Nenhum modelo encontrado. ${p.local ? 'Abra o programa e baixe um modelo antes.' : 'Escolha depois com /model ' + id + ':<modelo>.'}`));
    return;
  }
  options.forEach((o, i) => console.log(`    ${T.lime(String(i + 1).padStart(2))} ${o.m} ${c.dim(o.d)}`));
  const a = ((await ask(`  modelo (número ou nome) ${prompt()}`)) || '').trim();
  const chosen = /^\d+$/.test(a) ? (options[+a - 1] || {}).m : a;
  if (!chosen) return;
  const full = providers.formatModel(id, chosen);
  state.agent.model = full;
  const c3 = loadConfig(); c3.model = full; saveConfig(c3);
  console.log(`  ${T.green('✓')} modelo ${T.bold(full)}`);
}

// ---------- ligação do agente com o terminal ----------
// aviso do sistema (tarefa agendada terminou)
function notifyDone(title, text) {
  try { require('../lib/mission').notify(title, text); } catch { /* opcional */ }
}

// abre um arquivo gerado (dashboard) no navegador padrão
function openInBrowser(file) {
  const { exec } = require('child_process');
  const q = `"${file}"`;
  exec(process.platform === 'win32' ? `start "" ${q}` : process.platform === 'darwin' ? `open ${q}` : `xdg-open ${q}`, { windowsHide: true }, () => {});
}

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
    onOpenFile: ({ path: file }) => openInBrowser(file),
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
    onQueued(texts) { spin.stop(); console.log(`  ${T.lime('↳')} ${T.muted(`${texts.length > 1 ? texts.length + ' mensagens recebidas' : 'mensagem recebida'}; ajustando o trabalho`)}`); spin.start('pensando'); },
    onDone() {
      spin.stop();
      endText();
      endCmd();
      const secs = state.t0 ? Math.round((Date.now() - state.t0) / 1000) : 0;
      const u = state.usage;
      const parts = [
        u && u.window && `contexto ${Math.min(100, Math.round((u.context / u.window) * 100))}%`,
        u && `${fmtTokens(u.total)} tokens na conversa`,
        secs && `${secs}s`,
      ].filter(Boolean);
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
    case 'uso': console.log(require('../lib/usage').usageSummary().replace(/^/gm, '  ')); return null;
    case 'export': {
      if (!agent.messages.length) { console.log(c.dim('  A conversa está vazia.')); return null; }
      console.log(c.green(`  Conversa salva em ${require('../lib/commands').exportConversation(agent, arg)}`));
      return null;
    }
    case 'agendar': {
      try {
        const r = require('../lib/commands').scheduleCommand(arg, { cwd: agent.cwd, model: agent.model, srcRoot: path.join(__dirname, '..') });
        console.log(r.text.replace(/^/gm, '  '));
        if (r.send) return { send: r.send };
      } catch (e) { console.log(c.red('  ' + e.message)); }
      return null;
    }
    case 'missao': {
      try {
        const r = require('../lib/commands').missionCommand(arg, { cwd: agent.cwd, model: agent.model, aliasUsed: raw, start: (m) => require('../lib/mission').startDetached(agent.cwd, m, { script: __filename }) });
        console.log(r.text.replace(/^/gm, '  '));
      } catch (e) { console.log(c.red('  ' + e.message)); }
      return null;
    }
    case 'entender': return { send: require('../lib/commands').UNDERSTAND_PROMPT(arg) };
    case 'commit': return { send: require('../lib/commands').COMMIT_PROMPT + (arg ? `\n\nInstruções do usuário: ${arg}` : '') };
    case 'pr': return { send: require('../lib/commands').PR_PROMPT + (arg ? `\n\nBranch base: ${arg}` : '') };
    case 'mcp': {
      const r = require('../lib/commands').mcpCommand(arg, { cwd: agent.cwd, agent });
      console.log(r.text.replace(/^/gm, '  '));
      if (r.login) {
        try { console.log((await agent.mcpLogin(r.login, (u) => console.log(c.dim(`  Se o navegador não abrir: ${u}`)))).replace(/^/gm, '  ')); }
        catch (e) { console.log(c.red(`  ${e.message}`)); }
      }
      return null;
    }
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
    case 'models': {
      if (arg) {
        const id = arg.toLowerCase();
        if (!providers.PROVIDERS[id]) { console.log(c.red(`Provedor desconhecido: ${id}. Disponíveis: ${Object.keys(providers.PROVIDERS).join(', ')}`)); return null; }
        out(c.dim(`  buscando modelos de ${providers.PROVIDERS[id].name}...\n`));
        const list = await providers.listModels(id, loadConfig());
        if (!list.length) { console.log(c.yellow(`  não consegui listar. Configure com /provider ${id}`)); return null; }
        for (const m of list.slice(0, 80)) console.log(`  ${c.bold(providers.formatModel(id, m))}`);
        if (list.length > 80) console.log(c.dim(`  ... e mais ${list.length - 80}`));
        console.log(c.dim('  Escolha com /model <id>.'));
        return null;
      }
      const cfgNow = loadConfig();
      const groups = providers.configuredProviders({ ...cfgNow, keys: { ...(cfgNow.keys || {}), nvidia: agent.apiKey || cfgNow.apiKey } });
      for (const l of await providers.detectLocal()) {
        groups.push({ name: providers.PROVIDERS[l.provider].name, models: l.models.slice(0, 20).map((m) => ({ id: providers.formatModel(l.provider, m), desc: 'local' })) });
      }
      for (const g of groups) {
        console.log(`\n  ${T.bold(g.name)}`);
        for (const m of g.models) console.log(`    ${m.id === agent.model ? c.green('●') : ' '} ${c.bold(m.id)}  ${c.dim(m.desc)}`);
      }
      console.log(c.dim('\n  Outros provedores: /provider. Lista completa: /models <provedor>.'));
      return null;
    }
    case 'provider':
      await setupProvider(arg, state, cfg);
      return null;
    case 'skills': {
      try {
        const r = require('../lib/commands').skillsCommand(arg, { cwd: agent.cwd });
        if (r.send) return { send: r.send };
        console.log(r.text.replace(/^/gm, '  '));
      } catch (e) { console.log(c.red('  ' + e.message)); }
      return null;
    }
    case 'config': {
      console.log(require('../lib/commands').configSummary(agent.cwd, agent).replace(/^/gm, '  '));
      return null;
    }
    case 'doctor': {
      out(c.dim('  verificando...\n'));
      const items = await runDoctor({ cfg: loadConfig(), model: agent.model, version: VERSION });
      console.log(formatDoctor(items, { color: { ok: T.green, warn: T.amber, fail: T.red } }).replace(/^/gm, '  '));
      return null;
    }
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

  // execução de tarefa agendada (chamada pelo Agendador de Tarefas ou pelo cron)
  const si = argv.indexOf('--run-schedule');
  if (si >= 0) {
    const sched = require('../lib/schedule');
    const job = sched.list().find((j) => j.id === argv[si + 1]);
    if (!job) process.exit(1);
    process.chdir(job.cwd);
    const agent = new Agent({ apiKey: cfg.apiKey || process.env.NVIDIA_API_KEY, model: job.model || cfg.model || DEFAULT_MODEL, cwd: job.cwd, saveSession: true });
    agent.autoApprove = true;
    agent.interactive = false;
    let text = '', failed = '';
    const inicio = new Date().toISOString();
    const noop = () => {};
    await agent.send(`Tarefa agendada (${job.quando}), executada sem ninguém olhando: ${job.task}\nNão faça nada irreversível sem regra explícita; registre o que precisar de uma pessoa. Termine com um resumo curto do resultado.`, {
      onText: (t) => { text += t; }, onResponseStart: () => { text = ''; }, onError: (e) => { failed = String(e); },
      onAssistantEnd: noop, onThinking: noop, onReasoning: noop, onToolCall: noop, onToolResult: noop, onCommandOutput: noop, onUsage: noop, onPlan: noop, onInfo: noop, onRetry: noop, onAborted: noop, onDone: noop, onQueued: noop,
      approve: async () => ({ deny: 'Tarefa agendada sem supervisão: ação irreversível não permitida.' }),
    });
    const out = sched.outputFile(job.id);
    require('fs').writeFileSync(out, `# ${job.task}\n\n${new Date(inicio).toLocaleString('pt-BR')} · ${job.quando} · ${agent.model}\n\n${failed ? `**Falhou:** ${failed}\n\n` : ''}${text.trim()}\n`);
    sched.recordRun(job.id, { inicio, fim: new Date().toISOString(), ok: !failed, saida: out });
    notifyDone(failed ? 'rfcode: tarefa agendada falhou' : 'rfcode: tarefa agendada concluída', job.task.slice(0, 120));
    process.exit(failed ? 1 : 0);
  }
  if (argv[0] === 'agendar' || argv[0] === 'agendamentos') {
    const r = require('../lib/commands').scheduleCommand(argv.slice(1).join(' '), { cwd: process.cwd(), model: cfg.model, srcRoot: path.join(__dirname, '..') });
    console.log(r.text);
    process.exit(0);
  }

  // processo da missão (iniciado em segundo plano por /missao ou "rfcode missao")
  const ri = argv.indexOf('--run-mission');
  if (ri >= 0) {
    const mission = require('../lib/mission');
    const stamp = () => new Date().toLocaleTimeString('pt-BR');
    const m = await mission.run(process.cwd(), argv[ri + 1], {
      log: (t) => console.log(`[${stamp()}] ${t}`),
      createAgent: ({ model }) => new Agent({ apiKey: cfg.apiKey || process.env.NVIDIA_API_KEY, model: model || cfg.model || DEFAULT_MODEL, cwd: process.cwd(), saveSession: true }),
    });
    console.log(`[${stamp()}] fim: ${m.status}`);
    process.exit(0);
  }
  if (argv[0] === 'missao' || argv[0] === 'missão' || argv[0] === 'mission') {
    const { missionCommand } = require('../lib/commands');
    const mi = argv.indexOf('--model');
    const model = mi >= 0 ? argv[mi + 1] : cfg.model;
    if (mi >= 0) argv.splice(mi, 2);
    if (argv.includes('--primeiro-plano')) {
      // em primeiro plano (útil em servidores e no CI)
      const mission = require('../lib/mission');
      const objetivo = argv.slice(1).filter((a) => a !== '--primeiro-plano').join(' ');
      let horas = 24; const o = objetivo.replace(/--horas[= ](\d+(?:[.,]\d+)?)/, (x, h) => { horas = Number(h.replace(',', '.')); return ''; }).trim();
      const m = mission.create(process.cwd(), { objetivo: o, horas, modelo: model });
      const done = await mission.run(process.cwd(), m.id, { createAgent: ({ model: mm }) => new Agent({ apiKey: cfg.apiKey || process.env.NVIDIA_API_KEY, model: mm || model || DEFAULT_MODEL, cwd: process.cwd(), saveSession: true }) });
      console.log(require('../lib/mission').status(process.cwd(), done.id));
      process.exit(done.status === 'concluida' ? 0 : 1);
    }
    const start = (m) => require('../lib/mission').startDetached(process.cwd(), m, { script: __filename });
    const r = missionCommand(argv.slice(1).join(' '), { cwd: process.cwd(), start, model });
    console.log(r.text);
    process.exit(0);
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`rfcode ${VERSION}
Agente de IA para o terminal, com os modelos de build.nvidia.com.

Uso:
  rfcode                   modo interativo na pasta atual
  rfcode "tarefa"          executa a tarefa e continua no modo interativo
  rfcode -p "tarefa"       executa a tarefa e sai (aprovação automática; código de saída 1 em erro)
      --json               eventos e resultado em JSON, um por linha (para scripts e CI)
      --output <arquivo>   grava a resposta final no arquivo
      --max-steps <n>      limita o número de ações
      git diff | rfcode -p "revise"   o que chega pela entrada padrão vira contexto
  rfcode missao "objetivo" --horas 24   tarefa longa e autônoma em segundo plano (status, parar, retomar)
  rfcode -c, --continue    retoma a última conversa desta pasta
  rfcode --key             configura uma nova API key da NVIDIA
  rfcode --model <id>      usa outro modelo (ex.: groq:llama-3.3-70b-versatile, ollama:qwen3:8b)
  rfcode --doctor          verifica o ambiente, as chaves e as ferramentas

Provedores: NVIDIA (padrão), OpenRouter, Groq, OpenAI, Anthropic, Gemini, DeepSeek, Mistral,
Ollama e LM Studio (locais) e qualquer servidor compatível com a API da OpenAI. Use /provider.

Desenvolvimento:
  rfcode --self-improve [--iterations N]
  rfcode --painel

API key: ${CONFIG_FILE} ou variável de ambiente NVIDIA_API_KEY`);
    process.exit(0);
  }

  if (argv.includes('--doctor')) {
    const items = await runDoctor({ cfg, model: cfg.model, version: VERSION });
    console.log(formatDoctor(items, { color: { ok: T.green, warn: T.amber, fail: T.red } }));
    process.exit(items.some((i) => i.status === 'fail') ? 1 : 0);
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
  const { provider } = providers.parseModel(model);
  // a chave da NVIDIA só é pedida quando o modelo é da NVIDIA; outros provedores usam /provider
  // primeira execução: nenhum provedor configurado. Oferece os gratuitos em vez de exigir a chave da NVIDIA.
  const nothingConfigured = !apiKey && !providers.configuredProviders(cfg).length && ki < 0 && !argv.includes('-p');
  if (nothingConfigured) {
    console.log(`\n  ${T.bold('Bem-vindo ao rfcode.')} Para começar, escolha um provedor de IA. Todos abaixo têm uso gratuito:`);
    console.log(`    ${T.lime('1')} NVIDIA ${T.muted('(recomendado: vários modelos, inclusive Kimi K3 e Nemotron)')}`);
    console.log(`    ${T.lime('2')} Outro provedor ${T.muted('(Groq, Gemini, Cerebras, GitHub Models, OpenRouter, Hugging Face, Ollama...)')}`);
    const a = ((await ask(`  1 ou 2 ${prompt()}`)) || '1').trim();
    if (a === '2') {
      const tmp = { agent: new Agent({ apiKey: '', model, cwd: process.cwd(), saveSession: false }) };
      await setupProvider(null, tmp, cfg);
      model = tmp.agent.model;
      Object.assign(cfg, loadConfig());
    } else apiKey = await askApiKey(cfg);
  } else if (provider === 'nvidia' && (!apiKey || ki >= 0)) apiKey = await askApiKey(cfg);
  else if (provider !== 'nvidia' && providers.PROVIDERS[provider].needsKey !== false && !providers.keyFor(provider, cfg)) {
    console.log(`  ${T.amber('!')} ${T.muted(`falta a API key de ${providers.PROVIDERS[provider].name}: use /provider ${provider}`)}`);
  }

  const state = { agent: new Agent({ apiKey, model, cwd: process.cwd(), saveSession: true }), showThinking: false };
  liveAgent = state.agent;
  const hooks = cliHooks(state);
  // depois de cada resposta, mensagens que ficaram na fila (ex.: depois de Ctrl+C) viram o próximo pedido
  const drain = async () => {
    const left = state.agent.pendingUser ? state.agent.pendingUser.splice(0) : [];
    if (left.length) { state.t0 = Date.now(); await state.agent.send(left.join('\n\n'), hooks); await drain(); }
  };
  const run = async (text) => { state.t0 = Date.now(); await state.agent.send(text, hooks); await drain(); };
  const resume = async () => { state.t0 = Date.now(); await state.agent.resume(hooks); await drain(); };

  // --continue / -c: retoma a última conversa desta pasta
  const ci = argv.findIndex((a) => a === '--continue' || a === '-c');
  const sm = state.agent.sessionManager;
  const last = sm.list().find((s) => s.cwd === process.cwd());
  let offerResume = false;
  if (ci >= 0) {
    argv.splice(ci, 1);
    const msgs = last && sm.load(last.file);
    if (msgs) {
      state.agent.messages = msgs;
      console.log(`  ${T.green('↺')} retomando ${T.bold(last.title)} ${T.muted(`(${msgs.length} mensagens)`)}`);
      offerResume = last.status === 'running' && state.agent.interrupted;
    } else console.log(`  ${T.muted('nenhuma conversa anterior nesta pasta')}`);
  } else if (!argv.includes('-p') && last && last.status === 'running' && Date.now() - Date.parse(last.updated) < 12 * 3600 * 1000) {
    // a última tarefa desta pasta parou no meio (terminal fechado, queda): oferece continuar
    const msgs = sm.load(last.file);
    if (msgs) {
      state.agent.messages = msgs;
      if (state.agent.interrupted) {
        console.log(`  ${T.amber('!')} a última tarefa nesta pasta foi interrompida: ${T.bold(last.title)}`);
        offerResume = true;
      } else { state.agent.messages = []; state.agent.sessionManager = new SessionManager({ cwd: process.cwd() }); }
    }
  }

  process.on('SIGINT', () => {
    if (state.agent.busy) state.agent.abort();
    else { console.log(''); process.exit(0); }
  });
  rl.on('SIGINT', () => process.emit('SIGINT'));

  if (offerResume) {
    const a = ((await ask(`  continuar de onde parou? ${T.lime('s')}/${T.lime('n')} ${prompt()}`)) ?? 'n').trim().toLowerCase();
    if (['', 's', 'sim', 'y', 'yes'].includes(a)) await resume();
    else if (ci < 0) { state.agent.messages = []; state.agent.sessionManager = new SessionManager({ cwd: process.cwd() }); }
  }

  const pi = argv.indexOf('-p');
  if (pi >= 0) {
    state.agent.autoApprove = true;
    state.agent.interactive = false; // sem navegador nem perguntas: conectores sem login avisam em vez de abrir o login
    // opções do modo automação (CI, scripts, outras ferramentas)
    const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
    const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
    const json = flag('--json');
    const outFile = opt('--output');
    const maxSteps = Number(opt('--max-steps'));
    if (maxSteps > 0) state.agent.maxSteps = maxSteps;
    let task = argv.slice(argv.indexOf('-p') + 1).join(' ');
    // conteúdo enviado por pipe (git diff | rfcode -p "revise") entra como contexto
    if (!process.stdin.isTTY) {
      const piped = await new Promise((resolve) => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => resolve(d)); setTimeout(() => resolve(d), 3000); });
      if (piped.trim()) task += `\n\nConteúdo recebido pela entrada padrão:\n\`\`\`\n${piped.slice(0, 200000)}\n\`\`\``;
    }
    let failed = '';
    let finalText = '';
    const t0 = Date.now();
    const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    const h = json ? {
      onText: (t) => { finalText += t; }, onResponseStart: () => { finalText = ''; }, onAssistantEnd: () => {}, onThinking: () => {}, onReasoning: () => {},
      onToolCall: (i) => emit({ type: 'tool', name: i.name, description: i.description }), onToolResult: (r) => emit({ type: 'tool_result', name: r.name, error: !!r.error, output: String(r.output).slice(0, 2000) }),
      onCommandOutput: () => {}, onUsage: () => {}, onPlan: (p) => emit({ type: 'plan', plan: p }), onInfo: (t) => emit({ type: 'info', text: t }), onRetry: (t) => emit({ type: 'retry', text: t }),
      onError: (e) => { failed = String(e); emit({ type: 'error', text: failed }); }, onAborted: () => { failed = 'interrompido'; }, onDone: () => {}, onQueued: () => {}, approve: async () => 'yes',
    } : { ...hooks, onText: (t) => { finalText += t; hooks.onText(t); }, onResponseStart: () => { finalText = ''; hooks.onResponseStart(); }, onError: (e) => { failed = String(e); hooks.onError(e); } };
    state.t0 = Date.now();
    await state.agent.send(task, h);
    if (outFile) require('fs').writeFileSync(path.resolve(outFile), finalText.trim() + '\n');
    if (json) emit({ type: 'done', ok: !failed, error: failed || undefined, text: finalText.trim(), model: state.agent.model, tokens: state.agent.usage.total, seconds: Math.round((Date.now() - t0) / 1000), files: [...(state.agent.touched || [])] });
    rl.close();
    // código de saída: 0 deu certo, 1 erro (CI e scripts sabem que falhou)
    process.exit(failed ? 1 : 0);
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
