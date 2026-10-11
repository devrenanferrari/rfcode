'use strict';
// Conectores MCP (Model Context Protocol): o mesmo padrão usado por Claude Code, VS Code e Cursor.
// Lê a configuração de ~/.rfcode/mcp.json, <projeto>/.rfcode/mcp.json, <projeto>/.mcp.json e <projeto>/.vscode/mcp.json,
// conecta por stdio (programa local) ou HTTP (servidor remoto) e expõe as ferramentas como mcp__servidor__ferramenta.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROTOCOL = '2025-06-18';
const VERSION = (() => { try { return require('../package.json').version; } catch { return '0'; } })();
const home = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/^\s*\/\/.*$/gm, '')); } catch { return null; } };

// ---------- configuração ----------
function configFiles(cwd) {
  return [path.join(home(), 'mcp.json'), path.join(cwd, '.rfcode', 'mcp.json'), path.join(cwd, '.mcp.json'), path.join(cwd, '.vscode', 'mcp.json')];
}
// { nome: { command, args, env, cwd } | { type: 'http'|'sse', url, headers }, ... }; os arquivos do projeto sobrescrevem o do usuário
function loadMcpConfig(cwd) {
  const servers = {};
  for (const f of configFiles(cwd)) {
    const j = readJson(f);
    if (!j) continue;
    for (const [name, s] of Object.entries(j.mcpServers || j.servers || {})) {
      if (s && typeof s === 'object') servers[name] = { ...s, source: f };
    }
  }
  const { mcpAllowed } = require('./enterprise');
  for (const [name, s] of Object.entries(servers)) if (s.disabled || s.enabled === false || !mcpAllowed(name)) delete servers[name];
  return servers;
}

// ${VAR}, ${env:VAR} e {{SEGREDO}} viram o valor da variável de ambiente ou de "secrets" no config do rfcode
function expand(value) {
  if (typeof value !== 'string') return value;
  let secrets = {};
  try { secrets = JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).secrets || {}; } catch { /* sem config */ }
  const get = (n) => secrets[n] ?? process.env[n] ?? '';
  return value.replace(/\$\{(?:env:)?([A-Za-z_][\w]*)\}/g, (m, n) => get(n)).replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (m, n) => get(n));
}

function runTokenCommand(cmd) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(expand(cmd), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true }).trim();
    if (!out) throw new Error('saída vazia');
    return out.split(/\r?\n/).pop().trim();
  } catch (e) {
    throw new Error(`não consegui obter o token com "${cmd}": ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

const toolName = (server, tool) => `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

// ---------- transporte ----------
class StdioTransport {
  constructor(cfg, cwd) {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(cfg.env || {})) env[k] = expand(String(v));
    const args = (cfg.args || []).map((a) => expand(String(a)));
    const win = process.platform === 'win32';
    // npx, uvx e afins são .cmd no Windows: precisam do shell
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    this.child = win
      ? spawn([expand(cfg.command), ...args].map(quote).join(' '), { cwd: cfg.cwd ? path.resolve(cwd, expand(cfg.cwd)) : cwd, env, shell: true, windowsHide: true })
      : spawn(expand(cfg.command), args, { cwd: cfg.cwd ? path.resolve(cwd, expand(cfg.cwd)) : cwd, env });
    this.buf = '';
    this.stderr = '';
    this.child.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) { try { this.onmessage(JSON.parse(line)); } catch { /* linha que não é JSON (log do servidor) */ } }
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    this.child.on('exit', (code) => this.onclose && this.onclose(`o processo terminou (código ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    this.child.on('error', (e) => this.onclose && this.onclose(e.code === 'ENOENT' ? `programa não encontrado: ${cfg.command}` : e.message));
  }
  send(msg) { this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  close() { try { this.child.stdin.end(); this.child.kill(); } catch { /* já fechado */ } }
}

// HTTP "streamable": cada mensagem é um POST; a resposta vem em JSON ou num stream SSE curto.
class HttpTransport {
  constructor(cfg) {
    this.url = expand(cfg.url);
    this.headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, expand(String(v))]));
    // tokenCommand: o token vem de um comando (gh auth token, az account get-access-token...) e não fica gravado em arquivo
    if (cfg.tokenCommand && !Object.keys(this.headers).some((h) => h.toLowerCase() === 'authorization')) {
      const token = runTokenCommand(cfg.tokenCommand);
      this.headers.Authorization = `Bearer ${token}`;
    }
    this.session = null;
  }
  async send(msg) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(this.session ? { 'mcp-session-id': this.session } : {}), ...this.headers },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`acesso negado (HTTP ${res.status})`);
      e.auth = true; e.wwwAuth = res.headers.get('www-authenticate') || '';
      throw e;
    }
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const type = res.headers.get('content-type') || '';
    if (res.status === 202 || !type) return;
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (data) { try { this.onmessage(JSON.parse(data)); } catch { /* evento sem JSON */ } }
      }
    } else {
      const j = await res.json().catch(() => null);
      for (const m of [].concat(j || [])) this.onmessage(m);
    }
  }
  close() {
    if (this.session) fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...this.headers } }).catch(() => {});
  }
}

// SSE antigo (2024-11-05): GET abre o stream; o primeiro evento "endpoint" diz para onde mandar os POSTs.
class SseTransport {
  constructor(cfg) {
    this.url = expand(cfg.url);
    this.headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, expand(String(v))]));
    this.ctrl = new AbortController();
    this.ready = new Promise((resolve, reject) => { this._ok = resolve; this._fail = reject; });
    this.open();
  }
  async open() {
    try {
      const res = await fetch(this.url, { headers: { accept: 'text/event-stream', ...this.headers }, signal: this.ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(buf.slice(i).match(/^\r?\n\r?\n/)[0].length + i);
          const ev = (/^event:\s*(.*)$/m.exec(block) || [])[1];
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (ev === 'endpoint') { this.post = new URL(data, this.url).toString(); this._ok(); }
          else if (data) { try { this.onmessage(JSON.parse(data)); } catch { /* ignora */ } }
        }
      }
      this.onclose && this.onclose('o stream SSE foi fechado');
    } catch (e) { this._fail(e); if (e.name !== 'AbortError') this.onclose && this.onclose(e.message); }
  }
  async send(msg) {
    await this.ready;
    const res = await fetch(this.post, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers }, body: JSON.stringify(msg) });
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
  }
  close() { this.ctrl.abort(); }
}

// ---------- cliente ----------
class McpClient {
  constructor(name, cfg, cwd) {
    this.name = name; this.cfg = cfg; this.cwd = cwd;
    this.seq = 0; this.pending = new Map(); this.tools = []; this.status = 'parado'; this.error = '';
  }
  // opts: { interactive, onAuthUrl } - interactive permite abrir o navegador para login OAuth
  async connect(timeoutMs = 60000, opts = {}) {
    const type = this.cfg.type || (this.cfg.url ? (/\/sse\/?$/.test(this.cfg.url) ? 'sse' : 'http') : 'stdio');
    this.status = 'conectando';
    this.t = type === 'stdio' ? new StdioTransport(this.cfg, this.cwd) : type === 'sse' ? new SseTransport(this.cfg) : new HttpTransport(this.cfg);
    // servidor remoto sem token configurado: usa o login OAuth guardado (renova se venceu)
    const hasAuth = (t) => t.headers && Object.keys(t.headers).some((h) => h.toLowerCase() === 'authorization');
    if (type === 'http' && !hasAuth(this.t) && this.cfg.oauth !== false) {
      const tok = await require('./mcp-oauth').savedToken(expand(this.cfg.url)).catch(() => null);
      if (tok) this.t.headers.Authorization = `Bearer ${tok}`;
    }
    this.t.onmessage = (m) => this.receive(m);
    this.t.onclose = (why) => {
      this.status = 'erro'; this.error = why;
      for (const [, p] of this.pending) p.reject(new Error(`conector ${this.name}: ${why}`));
      this.pending.clear();
    };
    try {
      const init = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'rfcode', version: VERSION } }, timeoutMs);
      this.server = init && init.serverInfo;
      this.instructions = init && init.instructions;
      await this.notify('notifications/initialized');
      this.tools = [];
      let cursor;
      do {
        const r = await this.request('tools/list', cursor ? { cursor } : {}, 30000);
        this.tools.push(...((r && r.tools) || []));
        cursor = r && r.nextCursor;
      } while (cursor);
      this.status = 'conectado';
    } catch (e) {
      // 401 num servidor remoto: login OAuth no navegador (só em modo interativo) e tenta de novo uma vez
      if (e.auth && type === 'http' && this.cfg.oauth !== false && !opts.retried) {
        if (opts.interactive) {
          try {
            const tok = await require('./mcp-oauth').login(expand(this.cfg.url), { wwwAuth: e.wwwAuth, onUrl: opts.onAuthUrl });
            this.close();
            this.cfg = { ...this.cfg, headers: { ...(this.cfg.headers || {}), Authorization: `Bearer ${tok}` } };
            return this.connect(timeoutMs, { ...opts, retried: true });
          } catch (le) { e.message = `login falhou: ${le.message}`; }
        } else e.message = `precisa de login: rode /mcp login ${this.name}`;
      }
      this.status = 'erro';
      this.error = e.message + (this.t.stderr ? ` | ${this.t.stderr.trim().split('\n').slice(-2).join(' ')}` : '');
      this.close();
      throw new Error(this.error);
    }
  }
  receive(m) {
    if (m.id != null && this.pending.has(m.id) && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
      else p.resolve(m.result);
    } else if (m.method && m.id != null) {
      // pedidos do servidor: só respondemos o que faz sentido para o rfcode
      const result = m.method === 'roots/list' ? { roots: [{ uri: 'file:///' + this.cwd.replace(/\\/g, '/').replace(/^\//, ''), name: path.basename(this.cwd) }] }
        : m.method === 'ping' ? {} : null;
      Promise.resolve(this.t.send(result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'não suportado pelo rfcode' } })).catch(() => {});
    }
  }
  request(method, params, timeoutMs = 120000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`conector ${this.name} não respondeu a ${method} em ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      Promise.resolve(this.t.send({ jsonrpc: '2.0', id, method, params })).catch((e) => { const p = this.pending.get(id); if (p) { this.pending.delete(id); p.reject(e); } });
    });
  }
  notify(method, params) { return Promise.resolve(this.t.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })).catch(() => {}); }
  async call(tool, args, signal) {
    const p = this.request('tools/call', { name: tool, arguments: args || {} }, Number(this.cfg.timeout) || 180000);
    if (signal) signal.addEventListener('abort', () => this.notify('notifications/cancelled', { requestId: this.seq, reason: 'cancelado pelo usuário' }), { once: true });
    return p;
  }
  close() { try { this.t && this.t.close(); } catch { /* ignora */ } }
}

// Resultado de tools/call em texto para o modelo
function formatResult(r) {
  if (!r) return '(sem resposta)';
  const parts = (r.content || []).map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'resource') return c.resource && (c.resource.text || `[recurso ${c.resource.uri}]`);
    if (c.type === 'resource_link') return `[link: ${c.uri}${c.name ? ` (${c.name})` : ''}]`;
    if (c.type === 'image' || c.type === 'audio') return `[${c.type === 'image' ? 'imagem' : 'áudio'} ${c.mimeType || ''} omitida]`;
    return JSON.stringify(c);
  });
  if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2));
  const text = parts.join('\n').trim() || '(resposta vazia)';
  return r.isError ? `Erro do conector: ${text}` : text;
}

// ---------- gerenciador (um por agente) ----------
class McpManager {
  constructor(cwd) { this.cwd = cwd; this.clients = new Map(); this.started = null; }
  get configured() { return loadMcpConfig(this.cwd); }
  // conecta todos em paralelo; quem falhar fica com status de erro e não trava os outros
  start(timeoutMs = 60000, opts = {}) {
    if (this.started) return this.started;
    const cfg = this.configured;
    this.started = Promise.all(Object.entries(cfg).map(async ([name, c]) => {
      const client = new McpClient(name, c, this.cwd);
      this.clients.set(name, client);
      try { await client.connect(timeoutMs, opts); } catch { /* status guarda o erro */ }
    }));
    return this.started;
  }

  // login OAuth explícito (/mcp login nome): abre o navegador e reconecta
  async login(name, opts = {}) {
    const cfg = this.configured[name];
    if (!cfg) throw new Error(`conector ${name} não configurado`);
    if (!cfg.url) throw new Error(`${name} roda no computador (stdio); login OAuth é só para conectores remotos`);
    await require('./mcp-oauth').login(expand(cfg.url), { onUrl: opts.onAuthUrl });
    const old = this.clients.get(name);
    if (old) old.close();
    const client = new McpClient(name, cfg, this.cwd);
    this.clients.set(name, client);
    await client.connect(60000, opts);
    return client;
  }
  defs() {
    const out = [];
    for (const [server, c] of this.clients) {
      if (c.status !== 'conectado') continue;
      for (const t of c.tools) {
        const schema = { ...(t.inputSchema || { type: 'object', properties: {} }) };
        delete schema.$schema;
        if (!schema.type) schema.type = 'object';
        if (!schema.properties) schema.properties = {};
        const desc = String(t.description || t.title || t.name).replace(/\s+/g, ' ').slice(0, 400);
        out.push({ name: toolName(server, t.name), description: `[${server}] ${desc}`, parameters: schema, _mcp: { server, tool: t.name, readOnly: !!(t.annotations && t.annotations.readOnlyHint) } });
      }
    }
    return out;
  }
  find(name) { return this.defs().find((d) => d.name === name); }
  async call(name, args, signal) {
    const d = this.find(name);
    if (!d) throw new Error(`ferramenta de conector desconhecida: ${name}`);
    const c = this.clients.get(d._mcp.server);
    return formatResult(await c.call(d._mcp.tool, args, signal));
  }
  // conector confiável (trust: true) ou ferramenta marcada como só leitura dispensam aprovação
  needsApproval(name) {
    const d = this.find(name);
    if (!d) return true;
    const cfg = this.clients.get(d._mcp.server).cfg;
    return !(cfg.trust === true || (cfg.trust !== false && d._mcp.readOnly));
  }
  instructions() {
    return [...this.clients.values()].filter((c) => c.status === 'conectado' && c.instructions).map((c) => `[${c.name}] ${String(c.instructions).slice(0, 600)}`).join('\n');
  }
  status() {
    const cfg = this.configured;
    if (!Object.keys(cfg).length) return 'Nenhum conector configurado. Use /mcp add para ver os prontos ou edite ~/.rfcode/mcp.json.';
    return Object.entries(cfg).map(([name, c]) => {
      const cl = this.clients.get(name);
      const st = !cl ? 'não iniciado' : cl.status === 'conectado' ? `conectado, ${cl.tools.length} ferramentas` : `${cl.status}${cl.error ? `: ${cl.error}` : ''}`;
      return `- ${name} (${c.url ? c.url : [c.command, ...(c.args || [])].join(' ')}): ${st}`;
    }).join('\n');
  }
  closeAll() { for (const c of this.clients.values()) c.close(); this.clients.clear(); this.started = null; }
}

// grava/remove um servidor no mcp.json (usuário ou projeto)
function saveServer(name, cfg, { cwd, scope = 'usuario' } = {}) {
  const file = scope === 'projeto' ? path.join(cwd, '.rfcode', 'mcp.json') : path.join(home(), 'mcp.json');
  const j = readJson(file) || { mcpServers: {} };
  j.mcpServers ||= {};
  if (cfg) j.mcpServers[name] = cfg; else delete j.mcpServers[name];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  return file;
}

module.exports = { McpManager, McpClient, loadMcpConfig, saveServer, formatResult, toolName, expand, configFiles };
