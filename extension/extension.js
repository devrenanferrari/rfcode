'use strict';
// Extensão do VS Code: painel de chat do rfcode na barra lateral.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Agent, DEFAULT_MODEL, SUGGESTED_MODELS, loadConfig, saveConfig, validateKey } = require('../lib/agent');

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
    this.pending = new Map(); // aprovações aguardando resposta do painel
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
        prompt: 'Crie uma chave grátis em https://build.nvidia.com → "Get API Key"',
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

  // ---------- webview ----------
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', text: e.message })));
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(media, 'logo.svg'));
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>rfcode</title>
</head>
<body>
  <header>
    <select id="model" title="Modelo"></select>
    <label class="auto" title="Aprovar edições, comandos e controle do PC sem perguntar"><input type="checkbox" id="auto"> auto</label>
    <button id="newChat" class="icon" title="Nova conversa">＋</button>
  </header>
  <main id="log">
    <div class="welcome" id="welcome">
      <img src="${logo}" class="logo" alt="">
      <h2>rfcode</h2>
      <p>Agente de código e controle do PC com modelos gratuitos da NVIDIA.</p>
      <p class="muted" id="cwd"></p>
      <button id="keyBtn" class="hidden">Configurar API key da NVIDIA</button>
    </div>
  </main>
  <footer>
    <div id="plan" class="plan hidden"></div>
    <textarea id="input" rows="3" placeholder="Peça algo… (Enter envia, Shift+Enter quebra linha)"></textarea>
    <div class="actions">
      <span class="muted" id="status"></span>
      <button id="stop" class="hidden secondary">Parar</button>
      <button id="send">Enviar</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  post(msg) { this.view?.webview.postMessage(msg); }

  async init() {
    const key = (await this.context.secrets.get(SECRET_KEY)) || loadConfig().apiKey;
    const model = settings().get('model') || DEFAULT_MODEL;
    const models = SUGGESTED_MODELS.map(([id, desc]) => ({ id, desc }));
    if (!models.some((m) => m.id === model)) models.unshift({ id: model, desc: 'personalizado' });
    this.post({
      type: 'init', model, models, cwd: workspaceCwd(), hasKey: !!key,
      autoApprove: settings().get('autoApprove') || false,
    });
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.init();
      case 'send': return this.send(m.text);
      case 'stop': return this.stop();
      case 'newChat': return this.newChat();
      case 'setKey': return this.setApiKey();
      case 'setModel':
        await settings().update('model', m.model, vscode.ConfigurationTarget.Global);
        if (this.agent) this.agent.model = m.model;
        return;
      case 'setAuto':
        await settings().update('autoApprove', !!m.value, vscode.ConfigurationTarget.Global);
        if (this.agent) this.agent.autoApprove = !!m.value;
        return;
      case 'approval': {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m.decision === 'deny' ? { deny: m.reason || '' } : m.decision); }
        if (m.decision === 'all') this.post({ type: 'autoChanged', value: true });
        return;
      }
      case 'openFile': {
        const full = path.resolve(this.agent ? this.agent.cwd : workspaceCwd(), m.path);
        const doc = await vscode.workspace.openTextDocument(full);
        return vscode.window.showTextDocument(doc, { preview: true });
      }
    }
  }

  newChat() {
    this.stop();
    this.agent?.clear();
    this.post({ type: 'cleared', cwd: workspaceCwd() });
  }

  stop() {
    this.agent?.abort();
    for (const [, resolve] of this.pending) resolve('no');
    this.pending.clear();
  }

  async send(text) {
    if (!text || !text.trim()) return;
    const apiKey = await this.getApiKey();
    if (!apiKey) { this.post({ type: 'error', text: 'Configure a API key da NVIDIA para usar o rfcode.' }); this.post({ type: 'done' }); return; }
    if (!this.agent) this.agent = new Agent({ apiKey, model: settings().get('model') || DEFAULT_MODEL, cwd: workspaceCwd() });
    const agent = this.agent;
    if (agent.busy) return;
    agent.apiKey = apiKey;
    agent.cwd = workspaceCwd();
    agent.model = settings().get('model') || DEFAULT_MODEL;
    agent.autoApprove = settings().get('autoApprove') || agent.autoApprove;

    this.post({ type: 'user', text });
    await agent.send(text, {
      onThinking: () => this.post({ type: 'thinking' }),
      onResponseStart: () => this.post({ type: 'responseStart' }),
      onReasoning: (t) => this.post({ type: 'reasoning', text: t }),
      onText: (t) => this.post({ type: 'text', text: t }),
      onAssistantEnd: () => this.post({ type: 'assistantEnd' }),
      onToolCall: (info) => this.post({ type: 'toolCall', ...info }),
      onCommandOutput: (t) => this.post({ type: 'cmdOut', text: t }),
      onToolResult: (r) => this.post({ type: 'toolResult', ...r }),
      onPlan: (plan) => this.post({ type: 'plan', plan }),
      onUsage: (usage) => this.post({ type: 'usage', usage }),
      approve: (info) => new Promise((resolve) => {
        this.pending.set(info.id, resolve);
        this.post({ type: 'approval', id: info.id });
      }),
      onRetry: (t) => this.post({ type: 'info', text: t }),
      onError: (t) => this.post({ type: 'error', text: t }),
      onAborted: () => this.post({ type: 'info', text: 'Interrompido.' }),
      onDone: () => this.post({ type: 'done' }),
    });
  }
}

function activate(context) {
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('rfcode.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('rfcode.open', () => vscode.commands.executeCommand('rfcode.chat.focus')),
    vscode.commands.registerCommand('rfcode.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('rfcode.setApiKey', () => provider.setApiKey()),
    vscode.commands.registerCommand('rfcode.openTerminal', () => {
      const term = vscode.window.createTerminal({ name: 'rfcode', cwd: workspaceCwd() });
      term.show();
      term.sendText(`node "${path.join(context.extensionPath, 'bin', 'rfcode.js')}"`);
    }),
    vscode.commands.registerCommand('rfcode.selfImprove', async () => {
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
    vscode.commands.registerCommand('rfcode.dashboard', async () => {
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
