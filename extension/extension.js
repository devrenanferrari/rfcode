'use strict';
// Extensão do VS Code: painel de chat do rfcode na barra lateral, comandos "/" e controle remoto pelo celular.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Agent, DEFAULT_MODEL, SUGGESTED_MODELS, loadConfig, saveConfig, validateKey, describeCall, previewCall } = require('../lib/agent');
const { SessionManager, replayEvents, deleteSession } = require('../lib/sessions');
const { listCommands, expandCustom, reviewFor, PLAN_PREFIX, GO_PROMPT, INIT_PROMPT } = require('../lib/commands');
const { panelBody } = require('../lib/panel');
const { RemoteServer, firewallStatus, allowFirewall, DEFAULT_PORT } = require('../lib/remote');
const { qrSvg } = require('../lib/qr');
const { addAllow, suggestRule } = require('../lib/permissions');
const providers = require('../lib/providers');
const { runDoctor, formatDoctor } = require('../lib/doctor');
const log = require('../lib/log');
const VERSION = require('../package.json').version;
const { remember, readUserMemory, userFile: memoryFile } = require('../lib/memory');

// Diagnósticos do VS Code (erros e avisos do editor) como ferramenta do agente.
const VSCODE_TOOLS = {
  defs: [{
    name: 'get_diagnostics',
    description: 'Lista os erros e avisos que o VS Code mostra (TypeScript, ESLint, Python, etc.) no formato arquivo:linha: [erro|aviso] mensagem. '
      + 'Sem path, traz os do projeto todo. Use depois de editar para conferir se não quebrou nada.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Arquivo (opcional)' } } },
  }],
  async run(name, args) {
    const sev = ['erro', 'aviso', 'info', 'dica'];
    const all = args.path
      ? [[vscode.Uri.file(path.resolve(workspaceCwd(), args.path)), vscode.languages.getDiagnostics(vscode.Uri.file(path.resolve(workspaceCwd(), args.path)))]]
      : vscode.languages.getDiagnostics();
    const lines = [];
    for (const [uri, list] of all) {
      for (const d of list) {
        if (d.severity > 1) continue; // só erros e avisos
        lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}: [${sev[d.severity]}] ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`);
      }
    }
    return lines.length ? lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n... e mais ${lines.length - 200}` : '') : 'Nenhum erro ou aviso no VS Code.';
  },
};

// Conteúdo proposto (antes de aprovar) servido como documento virtual para o diff do editor.
const proposedDocs = new Map();
const proposedProvider = { provideTextDocumentContent: (uri) => proposedDocs.get(uri.query) || '' };

const SECRET_KEY = 'rfcode.nvidiaApiKey';

function workspaceCwd() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : os.homedir();
}
function settings() { return vscode.workspace.getConfiguration('rfcode'); }

class ChatViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.agent = null;
    this.pending = new Map(); // aprovações aguardando resposta (do painel ou do celular)
    this.asks = new Map();    // perguntas (ask_user) aguardando resposta
    this.calls = new Map();   // id -> { name, args } das ações pendentes (para o diff e para a regra)
    this.remote = null;
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'rfcode.remote';
    context.subscriptions.push(this.status, { dispose: () => this.remote?.stop() });
  }

  // ---------- API key ----------
  async getApiKey(forceAsk = false) {
    if (!forceAsk) {
      let key = await this.context.secrets.get(SECRET_KEY);
      if (!key) {
        // reaproveita a chave configurada na CLI (~/.rfcode/config.json)
        key = loadConfig().apiKey;
        if (key) await this.context.secrets.store(SECRET_KEY, key);
      }
      if (key) return key;
    }
    while (true) {
      const input = await vscode.window.showInputBox({
        title: 'rfcode: API key da NVIDIA',
        prompt: 'Gere a chave em https://build.nvidia.com (Get API Key)',
        placeHolder: 'nvapi-...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().startsWith('nvapi-') ? null : 'A chave deve começar com "nvapi-"'),
      });
      if (!input) return null;
      const key = input.trim();
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'rfcode: validando chave...' },
        () => validateKey(key));
      if (r === 'invalid') {
        vscode.window.showErrorMessage('rfcode: chave inválida (401/403). Tente de novo.');
        continue;
      }
      await this.context.secrets.store(SECRET_KEY, key);
      const cfg = loadConfig();
      cfg.apiKey = key;
      saveConfig(cfg);
      if (this.agent) this.agent.apiKey = key;
      vscode.window.showInformationMessage('rfcode: API key salva.');
      this.post({ type: 'keyStatus', hasKey: true });
      return key;
    }
  }

  async setApiKey() { await this.getApiKey(true); }

  ensureAgent(apiKey = '') {
    if (!this.agent) this.agent = new Agent({ apiKey, model: settings().get('model') || DEFAULT_MODEL, cwd: workspaceCwd(), saveSession: true, extraTools: VSCODE_TOOLS });
    return this.agent;
  }

  // ---------- webview ----------
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m, 'local').catch((e) => this.post({ type: 'error', text: e.message })));
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('chat.css')}">
<title>rfcode</title>
</head>
<body data-logo="${uri('logo.svg')}">${panelBody()}
  <script nonce="${nonce}" src="${uri('markdown.js')}"></script>
  <script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }

  // Para o painel do VS Code e para os celulares conectados.
  post(msg) {
    this.view?.webview.postMessage(msg);
    this.remote?.broadcast(msg);
  }
  postLocal(msg) { this.view?.webview.postMessage(msg); }

  // Modelos dos provedores configurados (e dos servidores locais detectados), agrupados por provedor.
  async modelList(model, local = this.localModels || []) {
    const cfg = loadConfig();
    const nv = (await this.context.secrets.get(SECRET_KEY)) || cfg.apiKey || '';
    const groups = providers.configuredProviders({ ...cfg, keys: { ...(cfg.keys || {}), nvidia: nv } })
      .filter((g) => !providers.PROVIDERS[g.id].local);
    const list = groups.flatMap((g) => g.models.map((m) => ({ ...m, group: g.name })));
    for (const l of local) {
      for (const m of l.models.slice(0, 30)) list.push({ id: providers.formatModel(l.provider, m), desc: 'local', group: providers.PROVIDERS[l.provider].name });
    }
    if (!list.some((m) => m.id === model)) list.unshift({ id: model, desc: 'atual', group: 'Atual' });
    return list;
  }

  async initMessage() {
    const cfg = loadConfig();
    const model = this.agent?.model || settings().get('model') || DEFAULT_MODEL;
    const { provider } = providers.parseModel(model);
    const nv = (await this.context.secrets.get(SECRET_KEY)) || cfg.apiKey;
    const hasKey = provider === 'nvidia' ? !!nv : providers.PROVIDERS[provider].needsKey === false || !!providers.keyFor(provider, cfg);
    return {
      type: 'init', model, models: await this.modelList(model), cwd: workspaceCwd(), hasKey,
      autoApprove: this.agent ? this.agent.autoApprove : settings().get('autoApprove') || false,
      commands: listCommands(workspaceCwd(), 'ui'),
      mode: this.agent?.planOnly ? 'plan' : '',
      remote: !!this.remote?.running,
    };
  }

  async init() {
    this.postLocal(await this.initMessage());
    // Ollama / LM Studio ligados: entram no seletor (sem travar a abertura do painel)
    providers.detectLocal().then(async (local) => {
      this.localModels = local;
      if (local.length) {
        const model = this.agent?.model || settings().get('model') || DEFAULT_MODEL;
        this.post({ type: 'models', model, models: await this.modelList(model, local) });
      }
    }).catch(() => {});
    // Ao abrir o VS Code: volta para a última conversa desta pasta; se ela parou no meio, oferece continuar.
    if (!this.agent && !this.checkedResume) {
      this.checkedResume = true;
      const last = new SessionManager().list().find((x) => x.cwd === workspaceCwd());
      if (last && Date.now() - Date.parse(last.updated) < 12 * 3600 * 1000) {
        await this.openSession(last.id);
        if (last.status === 'running' && this.agent?.interrupted) this.postLocal({ type: 'resumable', title: last.title });
      }
    }
  }

  // Celular novo: manda o estado atual e a conversa em andamento só para ele.
  async remoteConnected(send) {
    send(await this.initMessage());
    if (this.agent?.messages.length) send({ type: 'replay', events: replayEvents(this.agent.messages, { describe: describeCall, preview: previewCall }) });
    for (const id of this.pending.keys()) send({ type: 'approval', id, forced: false });
    if (this.agent?.busy) send({ type: 'thinking' });
    this.updateRemoteStatus();
    this.postLocal({ type: 'remoteClients', clients: this.remote.count, connected: true });
  }

  async onMessage(m, from = 'local') {
    switch (m.type) {
      case 'ready': return this.init();
      case 'resume': return this.resume();
      case 'discardResume':
        if (this.agent && !this.agent.busy) { this.agent.repairHistory(); this.agent.sessionManager.save(this.agent.messages, 'done'); }
        return undefined;
      case 'send': return this.send(m.text);
      case 'command': return this.runCommand(m.name, m.args || '');
      case 'stop': return this.stop();
      case 'newChat': return this.newChat();
      case 'setKey': return from === 'local' ? this.setApiKey() : undefined;
      case 'setModel': return this.setModel(m.model);
      case 'setAuto': return this.setAuto(!!m.value);
      case 'approval': {
        const p = this.pending.get(m.id);
        if (m.decision === 'rule') {
          const c = this.calls.get(m.id);
          if (c) {
            const rule = suggestRule(c.name, c.args);
            const file = addAllow(rule);
            this.post({ type: 'info', text: `Regra salva: "${rule}" não pede mais aprovação (${file}).` });
          }
          m.decision = 'yes';
        }
        if (p) { this.pending.delete(m.id); p(m.decision === 'deny' ? { deny: m.reason || '' } : m.decision); }
        this.post({ type: 'approvalDone', id: m.id });
        if (m.decision === 'all') this.post({ type: 'autoChanged', value: true });
        return undefined;
      }
      case 'answer': {
        const a = this.asks.get(m.id);
        if (a) { this.asks.delete(m.id); a(String(m.text || '')); }
        this.post({ type: 'askDone', id: m.id, text: String(m.text || '') });
        return undefined;
      }
      case 'showDiff': return from === 'local' ? this.showDiff(m.id) : undefined;
      case 'history': return this.sendHistory();
      case 'openSession': return this.openSession(m.id);
      case 'deleteSession':
        deleteSession(m.id);
        return this.sendHistory();
      case 'remoteStop': return this.stopRemote();
      case 'remoteFirewall': {
        if (from !== 'local' || !this.remote) return undefined;
        const r = await allowFirewall(this.remote.port);
        if (r === 'cancelled') this.postLocal({ type: 'info', text: 'Liberação do firewall cancelada. Sem ela o celular não consegue conectar.' });
        return this.showRemote();
      }
      case 'copy':
        if (from === 'local') await vscode.env.clipboard.writeText(String(m.text || ''));
        return undefined;
      case 'openFile': {
        if (from !== 'local') return undefined;
        const full = path.resolve(this.agent ? this.agent.cwd : workspaceCwd(), m.path);
        const doc = await vscode.workspace.openTextDocument(full);
        return vscode.window.showTextDocument(doc, { preview: true });
      }
      default: return undefined;
    }
  }

  async setModel(model) {
    if (!model) return;
    await settings().update('model', model, vscode.ConfigurationTarget.Global);
    if (this.agent) this.agent.model = model;
    this.post({ type: 'modelChanged', model });
  }

  async setAuto(value) {
    await settings().update('autoApprove', value, vscode.ConfigurationTarget.Global);
    if (this.agent) this.agent.autoApprove = value;
    this.post({ type: 'autoChanged', value });
  }

  // ---------- comandos "/" ----------
  async runCommand(name, args) {
    const info = (text) => this.post({ type: 'info', text });
    const agent = this.agent;
    switch (name) {
      case 'new': return this.newChat();
      case 'history': return this.sendHistory();
      case 'model':
        if (args) { await this.setModel(args); return info(`Modelo: ${args}`); }
        return info(`Modelo atual: ${agent?.model || settings().get('model') || DEFAULT_MODEL}. Use /model <id> para trocar.`);
      case 'auto': {
        const v = !(agent ? agent.autoApprove : settings().get('autoApprove'));
        await this.setAuto(v);
        return info(`Aprovação automática ${v ? 'ligada' : 'desligada'}.`);
      }
      case 'undo': return info(agent ? agent.undo() : 'Nada para desfazer.');
      case 'plan':
        if (!args) return info('Use /plan <pedido>: o rfcode investiga e propõe um plano sem alterar nada; depois /go executa.');
        this.ensureAgent().planOnly = true;
        this.post({ type: 'mode', mode: 'plan' });
        return this.send(PLAN_PREFIX + args, `/plan ${args}`);
      case 'go':
        if (!agent?.planOnly) return info('Nenhum plano aguardando. Use /plan <pedido> primeiro.');
        agent.planOnly = false;
        this.post({ type: 'mode', mode: '' });
        return this.send(GO_PROMPT, '/go');
      case 'init': return this.send(INIT_PROMPT, '/init');
      case 'uso': return info(require('../lib/usage').usageSummary());
      case 'export': {
        if (!agent || !agent.messages.length) return info('A conversa está vazia.');
        const out = require('../lib/commands').exportConversation(agent, args);
        vscode.window.showTextDocument(vscode.Uri.file(out), { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return info(`Conversa salva em ${out}`);
      }
      case 'agendar': {
        try {
          const r = require('../lib/commands').scheduleCommand(args, { cwd: workspaceCwd(), model: agent?.model || settings().get('model'), srcRoot: this.context.extensionPath });
          info(r.text);
          if (r.send) return this.send(r.send, '/agendamento rodar');
          return;
        } catch (e) { return this.post({ type: 'error', text: e.message }); }
      }
      case 'missao': {
        try {
          const script = path.join(this.context.extensionPath, 'bin', 'rfcode.js');
          // dentro do VS Code o executável é o Electron: ELECTRON_RUN_AS_NODE faz ele rodar como Node
          const start = (m) => require('../lib/mission').startDetached(workspaceCwd(), m, { script, env: { ELECTRON_RUN_AS_NODE: '1' } });
          return info(require('../lib/commands').missionCommand(args, { cwd: workspaceCwd(), start, model: agent?.model || settings().get('model') }).text);
        } catch (e) { return this.post({ type: 'error', text: e.message }); }
      }
      case 'entender': return this.send(require('../lib/commands').UNDERSTAND_PROMPT(args), `/entender${args ? ' ' + args : ''}`);
      case 'commit': return this.send(require('../lib/commands').COMMIT_PROMPT + (args ? `\n\nInstruções do usuário: ${args}` : ''), `/commit${args ? ' ' + args : ''}`);
      case 'pr': return this.send(require('../lib/commands').PR_PROMPT + (args ? `\n\nBranch base: ${args}` : ''), `/pr${args ? ' ' + args : ''}`);
      case 'skills': {
        try {
          const r = require('../lib/commands').skillsCommand(args, { cwd: workspaceCwd() });
          return r.send ? this.send(r.send, `/skills ${args}`) : info(r.text);
        } catch (e) { return this.post({ type: 'error', text: e.message }); }
      }
      case 'config': return info(require('../lib/commands').configSummary(workspaceCwd(), agent));
      case 'mcp': {
        const r = require('../lib/commands').mcpCommand(args, { cwd: workspaceCwd(), agent });
        info(r.text);
        if (r.login && agent) {
          try { info(await agent.mcpLogin(r.login, (u) => { vscode.env.openExternal(vscode.Uri.parse(u)); info(`Se o navegador não abrir: ${u}`); })); }
          catch (e) { this.post({ type: 'error', text: e.message }); }
        }
        return;
      }
      case 'review': {
        const r = reviewFor(workspaceCwd());
        if (r.reason) return info('Nada para revisar: ' + r.reason);
        return this.send(r.send, '/review');
      }
      case 'compact': {
        if (!agent || agent.messages.length < 4) return info('A conversa ainda é curta; não precisa resumir.');
        info('Resumindo a conversa…');
        try {
          const before = JSON.stringify(agent.messages).length;
          await agent.compact();
          agent.sessionManager.save(agent.messages);
          return info(`Conversa resumida: de ${Math.round(before / 1000)} mil para ${Math.round(JSON.stringify(agent.messages).length / 1000)} mil caracteres. Pode continuar.`);
        } catch (e) { return this.post({ type: 'error', text: 'Não consegui resumir: ' + e.message }); }
      }
      case 'memory': {
        if (args) return info(remember(args, 'usuario'));
        const mem = readUserMemory();
        return info(mem ? `Memória (${memoryFile()}):
${mem}` : 'A memória ainda está vazia. Diga "lembre que..." numa conversa, ou use /memory <texto>.');
      }
      case 'remote': return this.remote?.running ? this.showRemote() : this.startRemote();
      case 'key': return this.setApiKey();
      case 'provider': return this.setupProvider(args || undefined);
      case 'models': {
        if (args) {
          const id = args.trim().toLowerCase();
          if (!providers.PROVIDERS[id]) return info(`Provedor desconhecido: ${id}. Disponíveis: ${Object.keys(providers.PROVIDERS).join(', ')}.`);
          const list = await providers.listModels(id, loadConfig());
          return info(list.length ? `Modelos em ${providers.PROVIDERS[id].name} (${list.length}):\n${list.slice(0, 60).map((m) => '  ' + providers.formatModel(id, m)).join('\n')}${list.length > 60 ? '\n  ...' : ''}\nUse /model <id> para escolher.`
            : `Não consegui listar os modelos de ${providers.PROVIDERS[id].name}. Configure com /provider ${id}.`);
        }
        const model = agent?.model || settings().get('model') || DEFAULT_MODEL;
        const list = await this.modelList(model);
        return info(`Modelos disponíveis:\n${list.map((m) => `  ${m.id}${m.desc ? '  (' + m.desc + ')' : ''}`).join('\n')}\nOutros provedores: /provider. Lista completa de um provedor: /models <provedor>.`);
      }
      case 'doctor': {
        info('Verificando o ambiente...');
        const items = await runDoctor({ cfg: loadConfig(), model: agent?.model || settings().get('model'), version: VERSION });
        return info(formatDoctor(items));
      }
      default: {
        const text = expandCustom(name, args, workspaceCwd());
        if (text) return this.send(text, `/${name}${args ? ' ' + args : ''}`);
        return this.post({ type: 'error', text: `Comando desconhecido: /${name}. Digite /help para ver a lista.` });
      }
    }
  }

  // ---------- controle remoto ----------
  async startRemote() {
    const media = path.join(this.context.extensionPath, 'media');
    this.remote = new RemoteServer({
      mediaDir: media,
      onMessage: (m) => this.onMessage(m, 'remote').catch((e) => this.post({ type: 'error', text: e.message })),
      onConnect: (send) => this.remoteConnected(send),
      onDisconnect: () => {
        this.updateRemoteStatus();
        this.postLocal({ type: 'remoteClients', clients: this.remote?.count || 0, connected: false });
      },
    });
    try {
      await this.remote.start(settings().get('remotePort') || DEFAULT_PORT);
    } catch (e) {
      this.remote = null;
      return this.post({ type: 'error', text: 'Não consegui ligar o controle remoto: ' + e.message });
    }
    this.updateRemoteStatus();
    return this.showRemote();
  }

  showRemote() {
    const urls = this.remote.urls();
    if (!urls.length) return this.postLocal({ type: 'error', text: 'Não achei uma rede local (Wi-Fi ou cabo). Conecte o PC a uma rede e tente de novo.' });
    return this.postLocal({
      type: 'remote', on: true, url: urls[0].url, others: urls.slice(1).map((u) => u.url), qr: qrSvg(urls[0].url, { scale: 4 }),
      clients: this.remote.count, firewall: firewallStatus(this.remote.port),
    });
  }

  stopRemote() {
    if (!this.remote) return;
    this.remote.stop();
    this.remote = null;
    this.updateRemoteStatus();
    this.postLocal({ type: 'remote', on: false });
  }

  updateRemoteStatus() {
    if (!this.remote?.running) { this.status.hide(); return; }
    const n = this.remote.count;
    this.status.text = `$(device-mobile) rfcode remoto${n ? ` · ${n}` : ''}`;
    this.status.tooltip = 'Controle remoto do rfcode ligado. Clique para ver o QR code ou desligar.';
    this.status.show();
  }

  // ---------- histórico ----------
  sendHistory() {
    const items = new SessionManager().list().slice(0, 200)
      .map(({ id, title, cwd, updated, count }) => ({ id, title, cwd, updated, count }));
    this.post({ type: 'history', items, current: this.agent?.sessionManager.id, cwd: workspaceCwd() });
  }

  async openSession(id) {
    if (this.agent?.busy) { this.post({ type: 'info', text: 'Espere a resposta atual terminar (ou pare) para abrir outra conversa.' }); return; }
    const apiKey = (await this.context.secrets.get(SECRET_KEY)) || loadConfig().apiKey || '';
    const agent = this.ensureAgent(apiKey);
    const messages = agent.sessionManager.load(id);
    if (!messages) { this.post({ type: 'error', text: 'Não consegui abrir essa conversa.' }); return; }
    agent.clear();
    agent.planOnly = false;
    agent.messages = messages;
    this.post({ type: 'mode', mode: '' });
    this.post({ type: 'replay', events: replayEvents(messages, { describe: describeCall, preview: previewCall }) });
  }

  newChat() {
    this.stop();
    if (this.agent) {
      this.agent.clear();
      this.agent.planOnly = false;
      this.agent.sessionManager = new SessionManager({ cwd: workspaceCwd() });
    }
    this.post({ type: 'mode', mode: '' });
    this.post({ type: 'cleared', cwd: workspaceCwd() });
  }

  stop() {
    this.agent?.abort();
    for (const [, resolve] of this.pending) resolve('no');
    this.pending.clear();
    for (const [, resolve] of this.asks) resolve('');
    this.asks.clear();
  }

  // Abre o diff (arquivo atual x proposta do agente) no editor, antes de aprovar.
  async showDiff(id) {
    const c = this.calls.get(id);
    if (!c || !this.agent) return;
    let p;
    try { p = this.agent.proposedContent(c.name, c.args); } catch (e) { this.postLocal({ type: 'error', text: 'Não deu para montar o diff: ' + e.message }); return; }
    if (!p) return;
    const key = crypto.randomBytes(6).toString('hex');
    proposedDocs.set(key + 'a', p.before);
    proposedDocs.set(key + 'b', p.after);
    const name = path.basename(p.path);
    const left = vscode.Uri.from({ scheme: 'rfcode-proposed', path: '/' + name, query: key + 'a' });
    const right = vscode.Uri.from({ scheme: 'rfcode-proposed', path: '/' + name, query: key + 'b' });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name}: atual ↔ proposta do rfcode`, { preview: true });
  }

  // display: o que aparece como mensagem do usuário (ex.: "/review" em vez do prompt inteiro com o diff)
  async send(text, display) {
    if (!text || !text.trim()) return;
    const nvKey = (await this.context.secrets.get(SECRET_KEY)) || loadConfig().apiKey || '';
    const agent = this.ensureAgent(nvKey);
    // durante o trabalho: a mensagem entra na fila e o agente a considera no próximo passo
    if (agent.busy) {
      agent.queue(text);
      this.post({ type: 'user', text: display || text, queued: true });
      return;
    }
    const model = settings().get('model') || DEFAULT_MODEL;
    if (!(await this.ensureProvider(model))) {
      this.post({ type: 'error', text: 'Configure o provedor do modelo para usar o rfcode (/provider).' });
      this.post({ type: 'done' });
      return;
    }
    agent.apiKey = (await this.context.secrets.get(SECRET_KEY)) || loadConfig().apiKey || '';
    agent.cwd = workspaceCwd();
    agent.model = model;
    agent.autoApprove = settings().get('autoApprove') || agent.autoApprove;

    this.post({ type: 'user', text: display || text });
    await agent.send(text, this.agentHooks());
    await this.drainQueue();
  }

  // Mensagens que ficaram na fila quando a resposta parou (ex.: o usuário clicou em Parar): viram o próximo pedido.
  async drainQueue() {
    const agent = this.agent;
    const left = agent && agent.pendingUser ? agent.pendingUser.splice(0) : [];
    if (!left.length || agent.busy) return;
    this.post({ type: 'queued', count: left.length });
    this.post({ type: 'thinking' });
    await agent.send(left.join('\n\n'), this.agentHooks());
    await this.drainQueue();
  }

  // Continua a tarefa que parou no meio (VS Code recarregado, processo encerrado).
  async resume() {
    const agent = this.agent;
    if (!agent || agent.busy || !agent.interrupted) return;
    if (!(await this.ensureProvider(agent.model))) return;
    agent.apiKey = (await this.context.secrets.get(SECRET_KEY)) || loadConfig().apiKey || '';
    this.post({ type: 'resuming' });
    await agent.resume(this.agentHooks());
    await this.drainQueue();
  }

  // O provedor do modelo está pronto? Se faltar a chave, pede (sem trocar o modelo escolhido).
  async ensureProvider(model) {
    const { provider } = providers.parseModel(model);
    if (provider === 'nvidia') return !!(await this.getApiKey());
    const p = providers.PROVIDERS[provider];
    const cfg = loadConfig();
    if (provider === 'custom' && !providers.baseUrlFor('custom', cfg)) return !!(await this.setupProvider('custom', { keepModel: true }));
    if (p.needsKey === false || providers.keyFor(provider, cfg)) return true;
    return !!(await this.setupProvider(provider, { keepModel: true }));
  }

  // Escolhe e configura um provedor: chave (validada), endereço (personalizado) e modelo.
  async setupProvider(id, { keepModel = false } = {}) {
    const cfg = loadConfig();
    if (!id) {
      const nv = (await this.context.secrets.get(SECRET_KEY)) || cfg.apiKey;
      const item = ([pid, p]) => {
        const ready = pid === 'nvidia' ? !!nv : p.needsKey === false ? (pid === 'custom' ? !!providers.baseUrlFor('custom', cfg) : null) : !!providers.keyFor(pid, cfg, { command: false });
        return { label: p.name, description: ready === true ? 'configurado' : '', detail: p.freeNote || (p.local ? 'roda no seu computador, sem internet' : ''), pid };
      };
      const all = Object.entries(providers.PROVIDERS);
      const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
      // gratuitos primeiro
      const items = [
        sep('Gratuitos'), ...all.filter(([, p]) => p.free && !p.local).map(item),
        sep('Pagos'), ...all.filter(([id, p]) => !p.free && !p.local && id !== 'custom').map(item),
        sep('No seu computador'), ...all.filter(([, p]) => p.local).map(item),
        sep('Outro'), item(['custom', providers.PROVIDERS.custom]),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'rfcode: provedor de modelos', placeHolder: 'Escolha o provedor' });
      if (!pick) return null;
      id = pick.pid;
    }
    id = String(id).toLowerCase();
    const p = providers.PROVIDERS[id];
    if (!p) { this.post({ type: 'error', text: `Provedor desconhecido: ${id}. Disponíveis: ${Object.keys(providers.PROVIDERS).join(', ')}.` }); return null; }
    if (id === 'custom') {
      const url = await vscode.window.showInputBox({
        title: 'rfcode: provedor personalizado', prompt: 'Endereço base compatível com a API da OpenAI (ex.: https://meu-servidor/v1)',
        value: (cfg.baseUrls || {}).custom || '', ignoreFocusOut: true,
      });
      if (!url) return null;
      const c = loadConfig();
      c.baseUrls = { ...(c.baseUrls || {}), custom: url.trim() };
      saveConfig(c);
    }
    if (p.needsAccount) {
      const acc = await vscode.window.showInputBox({ title: `rfcode: ${p.needsAccount}`, prompt: `${p.needsAccount} (no painel de ${p.name})`, value: (cfg.vars || {})[p.needsAccount] || '', ignoreFocusOut: true });
      if (!acc) return null;
      const c = loadConfig(); c.vars = { ...(c.vars || {}), [p.needsAccount]: acc.trim() }; saveConfig(c);
    }
    // GitHub Models: aproveita o login do GitHub CLI quando existe
    if (p.keyCommand && !providers.keyFor(id, cfg, { command: false }) && providers.keyFor(id, { useKeyCommand: { [id]: true } })) {
      const use = await vscode.window.showQuickPick(['Usar o login do GitHub CLI (gh)', 'Informar um token'], { title: `rfcode: ${p.name}` });
      if (!use) return null;
      if (use.startsWith('Usar')) { const c = loadConfig(); c.useKeyCommand = { ...(c.useKeyCommand || {}), [id]: true }; saveConfig(c); }
    }
    if (id === 'nvidia') {
      if (!(await this.getApiKey(true))) return null;
    } else if ((p.needsKey !== false || id === 'custom') && !providers.keyFor(id, loadConfig())) {
      const input = await vscode.window.showInputBox({
        title: `rfcode: API key de ${p.name}`, password: true, ignoreFocusOut: true,
        prompt: p.keyUrl ? `Gere a chave em ${p.keyUrl}` : 'API key (deixe vazio se o servidor não exigir)',
      });
      if (input === undefined) return null;
      const key = input.trim();
      if (!key && p.needsKey !== false) return null;
      if (key) {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'rfcode: validando a chave...' },
          () => providers.validateKey(id, key, loadConfig()));
        if (r === 'invalid') { vscode.window.showErrorMessage(`rfcode: a chave foi recusada por ${p.name}.`); return null; }
        const c = loadConfig();
        c.keys = { ...(c.keys || {}), [id]: key };
        saveConfig(c);
      }
    } else if (p.local) {
      const models = await providers.listModels(id, loadConfig(), { timeout: 1500 });
      if (!models.length) {
        vscode.window.showWarningMessage(`rfcode: ${p.name} não está respondendo em ${p.baseUrl}. Abra o programa e baixe um modelo antes.`);
        return null;
      }
    }
    if (keepModel) return true;
    const live = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'rfcode: buscando os modelos...' },
      () => providers.listModels(id, loadConfig()));
    const items = p.models.map(([m, d]) => ({ label: m, description: d }));
    const rest = live.filter((m) => !p.models.some(([x]) => x === m));
    if (rest.length) items.push({ label: 'Disponíveis no provedor', kind: vscode.QuickPickItemKind.Separator }, ...rest.map((m) => ({ label: m })));
    let modelId;
    if (items.length) {
      const pick = await vscode.window.showQuickPick(items, { title: `rfcode: modelo de ${p.name}`, placeHolder: 'Escolha o modelo (precisa suportar chamadas de ferramenta)' });
      modelId = pick && pick.label;
    } else {
      modelId = await vscode.window.showInputBox({ title: 'rfcode: modelo', prompt: 'Nome do modelo', ignoreFocusOut: true });
    }
    if (!modelId) return true;
    const full = providers.formatModel(id, modelId.trim());
    await this.setModel(full);
    this.post({ type: 'models', model: full, models: await this.modelList(full) });
    this.post({ type: 'info', text: `Modelo: ${full} (${p.name})` });
    return true;
  }

  // Ganchos do agente para o painel (usados por send e resume).
  // dashboard (ou outro HTML gerado) num painel ao lado; reaproveita o painel do mesmo arquivo
  openArtifact(file, title) {
    this.artifacts = this.artifacts || new Map();
    let panel = this.artifacts.get(file);
    if (!panel) {
      panel = vscode.window.createWebviewPanel('rfcodeArtifact', title || path.basename(file), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.dirname(file))] });
      panel.onDidDispose(() => this.artifacts.delete(file));
      panel.webview.onDidReceiveMessage((m) => { if (m && m.type === 'openExternal') vscode.env.openExternal(vscode.Uri.file(file)); });
      this.artifacts.set(file, panel);
    }
    panel.title = title || path.basename(file);
    // barra fina com o caminho e o botão "Abrir no navegador"
    const bar = `<div style="position:sticky;top:0;z-index:99;display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 12px;font:12px system-ui;background:#1f2937;color:#e5e7eb">`
      + `<span>${path.basename(file)}</span><button onclick="acquireVsCodeApi().postMessage({type:'openExternal'})" style="font:inherit;padding:3px 10px;border-radius:6px;border:0;cursor:pointer">Abrir no navegador</button></div>`;
    try {
      const html = fs.readFileSync(file, 'utf8');
      panel.webview.html = html.replace(/<body([^>]*)>/i, (m) => `${m}${bar}`);
    } catch (e) { panel.webview.html = `<p>Não consegui abrir ${file}: ${e.message}</p>`; }
    panel.reveal(vscode.ViewColumn.Beside, true);
  }

  agentHooks() {
    return {
      onOpenFile: ({ path: file, title }) => this.openArtifact(file, title),
      onQueued: (texts) => this.post({ type: 'queued', count: texts.length }),
      onThinking: () => this.post({ type: 'thinking' }),
      onResponseStart: () => this.post({ type: 'responseStart' }),
      onReasoning: (t) => this.post({ type: 'reasoning', text: t }),
      onText: (t) => this.post({ type: 'text', text: t }),
      onAssistantEnd: () => this.post({ type: 'assistantEnd' }),
      onToolCall: (info) => { this.calls.set(info.id, { name: info.name, args: info.args }); this.post({ type: 'toolCall', ...info }); },
      ask: ({ question, options }) => new Promise((resolve) => {
        const id = 'ask' + crypto.randomBytes(4).toString('hex');
        this.asks.set(id, resolve);
        this.post({ type: 'ask', id, question, options });
      }),
      onCommandOutput: (t) => this.post({ type: 'cmdOut', text: t }),
      onToolResult: (r) => this.post({ type: 'toolResult', ...r }),
      onPlan: (plan) => this.post({ type: 'plan', plan }),
      onUsage: (usage) => this.post({ type: 'usage', usage }),
      approve: (info) => new Promise((resolve) => {
        this.pending.set(info.id, resolve);
        const diff = ['write_file', 'edit_file', 'multi_edit'].includes(info.name);
        this.post({ type: 'approval', id: info.id, forced: !!info.forced, diff, rule: info.forced ? '' : suggestRule(info.name, info.args) });
      }),
      onRetry: (t) => this.post({ type: 'info', text: t }),
      onError: (t) => this.post({ type: 'error', text: t }),
      onAborted: () => this.post({ type: 'info', text: 'Interrompido.' }),
      onDone: () => this.post({ type: 'done' }),
    };
  }
}

function activate(context) {
  const provider = new ChatViewProvider(context);
  const devCommand = (id, fn) => vscode.commands.registerCommand(id, () => {
    if (!settings().get('developerMode')) {
      vscode.window.showInformationMessage('rfcode: este comando é de desenvolvimento. Ative "rfcode.developerMode" nas configurações para usar.');
      return undefined;
    }
    return fn();
  });
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('rfcode-proposed', proposedProvider),
    vscode.window.registerWebviewViewProvider('rfcode.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('rfcode.open', () => vscode.commands.executeCommand('rfcode.chat.focus')),
    vscode.commands.registerCommand('rfcode.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('rfcode.history', async () => { await vscode.commands.executeCommand('rfcode.chat.focus'); provider.postLocal({ type: 'openHistory' }); }),
    vscode.commands.registerCommand('rfcode.setApiKey', () => provider.setApiKey()),
    vscode.commands.registerCommand('rfcode.setProvider', () => provider.setupProvider()),
    vscode.commands.registerCommand('rfcode.doctor', async () => {
      await vscode.commands.executeCommand('rfcode.chat.focus');
      return provider.runCommand('doctor', '');
    }),
    vscode.commands.registerCommand('rfcode.openLog', async () => {
      if (!fs.existsSync(log.file())) { vscode.window.showInformationMessage('rfcode: nenhum erro registrado ainda.'); return; }
      const doc = await vscode.workspace.openTextDocument(log.file());
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('rfcode.remote', async () => {
      await vscode.commands.executeCommand('rfcode.chat.focus');
      return provider.remote?.running ? provider.showRemote() : provider.startRemote();
    }),
    vscode.commands.registerCommand('rfcode.remoteStop', () => provider.stopRemote()),
    vscode.commands.registerCommand('rfcode.openTerminal', () => {
      const term = vscode.window.createTerminal({ name: 'rfcode', cwd: workspaceCwd() });
      term.show();
      term.sendText(`node "${path.join(context.extensionPath, 'bin', 'rfcode.js')}"`);
    }),
    devCommand('rfcode.selfImprove', async () => {
      const n = await vscode.window.showInputBox({
        title: 'rfcode: auto-melhoria', prompt: 'Quantas tarefas do SDD tentar nesta rodada?', value: '3', ignoreFocusOut: true,
        validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : 'Informe um número'),
      });
      if (!n) return;
      const repo = settings().get('repoPath') || context.extensionPath;
      const term = vscode.window.createTerminal({ name: 'rfcode: auto-melhoria', cwd: repo });
      term.show();
      term.sendText(`node scripts/self-improve.js --iterations ${n}`);
    }),
    devCommand('rfcode.dashboard', async () => {
      const repo = settings().get('repoPath') || context.extensionPath;
      const url = 'http://127.0.0.1:4517';
      const up = await fetch(url + '/api/state').then((r) => r.ok).catch(() => false);
      if (!up) {
        const term = vscode.window.createTerminal({ name: 'rfcode: painel', cwd: repo });
        term.sendText('node scripts/dashboard.js');
        for (let i = 0; i < 20 && !(await fetch(url + '/api/state').then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 300));
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('rfcode.askSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const sel = ed.document.getText(ed.selection);
      const file = vscode.workspace.asRelativePath(ed.document.uri);
      const q = await vscode.window.showInputBox({ title: 'rfcode', prompt: 'O que fazer com a seleção?', ignoreFocusOut: true });
      if (!q) return;
      await vscode.commands.executeCommand('rfcode.chat.focus');
      provider.send(`${q}\n\nArquivo: ${file} (linhas ${ed.selection.start.line + 1}-${ed.selection.end.line + 1})\n\`\`\`\n${sel}\n\`\`\``);
    }),
  );
  return provider; // usado nos testes
}

function deactivate() {}

module.exports = { activate, deactivate, ChatViewProvider };
