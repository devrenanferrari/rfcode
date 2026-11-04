'use strict';
// Servidor da orquestra: a tela do quadro no navegador, uma API JSON e os eventos ao vivo (Server-Sent Events).
// Por padrão só atende o próprio computador (127.0.0.1, com checagem do Host contra DNS rebinding).
// Com rede: true atende a rede local, como o controle remoto. Fora a página vazia, tudo exige o token do link,
// mandado no cabeçalho X-RF-Token (um cabeçalho próprio também impede que outro site faça pedidos por você).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const orq = require('./orquestra');

const DEFAULT_PORT = 7434;
const MEDIA = path.join(__dirname, '..', 'media');
const STATIC = {
  'orquestra.js': 'text/javascript; charset=utf-8',
  'orquestra.css': 'text/css; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
  'logo.svg': 'image/svg+xml',
};
const MAX_BODY = 4 * 1024 * 1024;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const svg = (d, s = 16) => `<svg viewBox="0 0 16 16" width="${s}" height="${s}" aria-hidden="true">${d}</svg>`;
const ICONS = {
  sessao: svg('<path d="M3 4.5l3 3-3 3M7.5 11h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  comando: svg('<rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 7l2 1.5L5 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  nota: svg('<path d="M3.5 2.5h6l3 3v8h-9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.5 8h5M5.5 10.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
};

function pageHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="dark light">
<title>rfcode orquestra</title><link rel="icon" href="/static/logo.svg">
<link rel="stylesheet" href="/static/orquestra.css">
</head><body>
<div class="app">
  <header class="bar">
    <div class="brand"><img src="/static/logo.svg" alt="" width="26" height="26"><span>orquestra</span></div>
    <div class="board-pick">
      <button id="boardBtn" class="btn ghost board-btn" type="button" aria-haspopup="menu"><span id="boardName">…</span>${svg('<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>', 14)}</button>
      <div id="boardMenu" class="menu hidden" role="menu"></div>
    </div>
    <div id="repos" class="repos" aria-label="Repositórios conectados"></div>
    <span class="grow"></span>
    <span id="saveState" class="save-state"></span>
    <label class="par" title="Quantas caixas rodam ao mesmo tempo. 1 = uma de cada vez, em sequência.">
      <span>Paralelo</span>
      <select id="paralelo" aria-label="Caixas ao mesmo tempo">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n === 1 ? '1 (sequência)' : n}</option>`).join('')}</select>
    </label>
    <button id="stopAll" class="btn ghost danger hidden" type="button">${svg('<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>', 12)}<span>Parar tudo</span></button>
    <button id="runAll" class="btn primary" type="button">${svg('<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>', 12)}<span>Rodar fluxo</span></button>
  </header>
  <div class="stage">
    <nav class="palette" id="palette" aria-label="Caixinhas">
      <div class="pal-title">Caixinhas</div>
      <button class="pal-item" data-tipo="sessao" type="button" title="Sessão de código: o agente trabalha num repositório">${ICONS.sessao}<span>Sessão</span></button>
      <button class="pal-item" data-tipo="comando" type="button" title="Comando: testes, build, lint. O fluxo segue pelo código de saída">${ICONS.comando}<span>Comando</span></button>
      <button class="pal-item" data-tipo="nota" type="button" title="Nota: contexto compartilhado que as sessões ligadas leem e escrevem">${ICONS.nota}<span>Nota</span></button>
      <span class="pal-sep"></span>
      <button class="pal-tool" id="zoomIn" type="button" title="Aproximar">${svg('<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', 14)}</button>
      <button class="pal-tool" id="zoomOut" type="button" title="Afastar">${svg('<path d="M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', 14)}</button>
      <button class="pal-tool" id="fit" type="button" title="Ver tudo (F)">${svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>', 14)}</button>
    </nav>
    <div id="viewport" class="viewport" tabindex="-1">
      <div id="world" class="world">
        <svg id="edges" class="edges" aria-hidden="true">
          <defs>
            <marker id="arr-sucesso" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk-sucesso"/></marker>
            <marker id="arr-falha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk-falha"/></marker>
            <marker id="arr-sempre" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk-sempre"/></marker>
          </defs>
          <g id="edgeG"></g>
          <path id="ghost" class="ghost hidden" d=""/>
        </svg>
        <div id="nodes"></div>
      </div>
      <div id="empty" class="empty hidden"></div>
    </div>
    <aside id="drawer" class="drawer hidden" aria-label="Detalhes da caixa"></aside>
  </div>
  <footer class="status">
    <span id="conn" class="conn">conectando…</span>
    <span id="counts"></span>
    <span class="grow"></span>
    <span class="hint">Arraste do ● de saída até outra caixa para ligar · duplo clique no quadro cria uma sessão · Ctrl+roda dá zoom</span>
  </footer>
</div>
<div id="modal" class="modal hidden" role="dialog" aria-modal="true"></div>
<div id="toast" class="toast hidden" role="status"></div>
<script>window.RF_ICONS = ${JSON.stringify(ICONS)};</script>
<script src="/static/markdown.js"></script>
<script src="/static/orquestra.js"></script>
</body></html>`;
}

// Abre o navegador padrão sem shell (os argumentos vão em lista).
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    return true;
  } catch { return false; }
}

function modelList() {
  try {
    const providers = require('./providers');
    const { loadConfig } = require('./agent');
    const cfg = loadConfig();
    const groups = providers.configuredProviders(cfg);
    const list = (groups.length ? groups : [{ name: providers.PROVIDERS.nvidia.name, models: providers.PROVIDERS.nvidia.models.map(([m, d]) => ({ id: m, desc: d })) }])
      .flatMap((g) => g.models.map((m) => ({ ...m, grupo: g.name })));
    return [{ id: '', desc: `padrão do rfcode (${cfg.model || 'auto'})` }, { id: 'auto', desc: 'o mais forte disponível, troca sozinho no limite' }, ...list];
  } catch { return [{ id: '', desc: 'padrão do rfcode' }, { id: 'auto', desc: 'o mais forte disponível' }]; }
}

class OrquestraServer {
  /**
   * orquestra: instância de Orquestra (padrão: uma nova, com o Agent do rfcode).
   * rede: true atende a rede local (0.0.0.0); senão só 127.0.0.1.
   */
  constructor({ orquestra, apiKey, rede = false, mediaDir = MEDIA, version = '' } = {}) {
    this.orq = orquestra || new orq.Orquestra({ apiKey });
    this.rede = !!rede;
    this.mediaDir = mediaDir;
    this.version = version;
    this.token = crypto.randomBytes(18).toString('base64url');
    this.clients = new Set();
    this.server = null;
    this.port = 0;
    this.onEvent = (ev) => {
      const data = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of this.clients) { try { c.write(data); } catch { /* cliente caiu */ } }
    };
    this.orq.on('evento', this.onEvent);
  }

  get running() { return !!this.server; }

  async start(port = DEFAULT_PORT) {
    try { return await this.listen(port); } catch (e) {
      if (e.code === 'EADDRINUSE' && port) return this.listen(0);
      throw e;
    }
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
        try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ erro: e.message })); } catch { /* já respondido */ }
      }));
      server.on('error', reject);
      server.listen(port, this.rede ? '0.0.0.0' : '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        this.ping = setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 20000);
        resolve(this.url());
      });
    });
  }

  // Link com o token (no #: não vai para o servidor nem para o histórico do proxy). quadro: abre direto nele.
  url(quadro) {
    let host = '127.0.0.1';
    if (this.rede) {
      try { const { lanAddresses } = require('./remote'); const a = lanAddresses(null)[0]; if (a) host = a.address; } catch { /* fica no local */ }
    }
    return `http://${host}:${this.port}/#t=${this.token}${quadro ? `&q=${encodeURIComponent(quadro)}` : ''}`;
  }

  hostAllowed(req) {
    if (this.rede) return true;
    const h = String(req.headers.host || '').toLowerCase();
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(h);
  }

  async body(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) throw Object.assign(new Error('pedido grande demais'), { status: 413 }); }
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const fail = (code, msg) => send(code, { erro: msg });
    if (!this.hostAllowed(req)) return fail(403, 'host não permitido');

    if (req.method === 'GET' && u.pathname === '/') return send(200, pageHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname.startsWith('/static/')) {
      const name = path.basename(u.pathname);
      if (!STATIC[name]) return fail(404, 'não encontrado');
      return send(200, fs.readFileSync(path.join(this.mediaDir, name)), STATIC[name]);
    }
    if (!u.pathname.startsWith('/api/')) return fail(404, 'não encontrado');

    if (req.method === 'GET' && u.pathname === '/api/eventos') {
      if (!safeEqual(u.searchParams.get('t'), this.token)) return fail(401, 'token inválido');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': ok\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return undefined;
    }
    if (!safeEqual(req.headers['x-rf-token'], this.token)) return fail(401, 'token inválido');

    try {
      return await this.route(req, u, send);
    } catch (e) {
      return fail(e.status || 400, e.message);
    }
  }

  async route(req, u, send) {
    const o = this.orq;
    const parts = u.pathname.split('/').filter(Boolean).slice(1); // sem o "api"
    const m = req.method;
    const need = (cond, msg = 'não encontrado', status = 404) => { if (!cond) throw Object.assign(new Error(msg), { status }); };

    if (m === 'GET' && parts[0] === 'estado') {
      return send(200, {
        versao: this.version, quadros: o.list(), modelos: modelList(), home: os.homedir(), sep: path.sep, rede: this.rede,
        modelosQuadro: Object.entries(orq.MODELOS).map(([id, t]) => ({ id, nome: t.nome, desc: t.desc, caixas: t.caixas.length })),
      });
    }
    if (parts[0] === 'quadros') {
      if (parts.length === 1 && m === 'GET') return send(200, { quadros: o.list() });
      if (parts.length === 1 && m === 'POST') {
        const b = await this.body(req);
        const q = o.create({ nome: b.nome, modelo: b.modelo, repos: b.repos });
        return send(200, o.snapshot(q.id));
      }
      const id = parts[1];
      need(id && /^[\w-]{1,64}$/.test(id) && o.board(id), 'Quadro não encontrado.');
      if (parts.length === 2 && m === 'GET') return send(200, o.snapshot(id));
      if (parts.length === 2 && m === 'PUT') {
        const b = await this.body(req);
        const q = o.update(id, b.quadro || b);
        return send(200, { ok: true, atualizado: q.atualizado, ligacoes: q.ligacoes.length });
      }
      if (parts.length === 2 && m === 'DELETE') return send(200, { ok: o.remove(id) });
      if (parts[2] === 'rodar' && m === 'POST') {
        const b = await this.body(req);
        const modo = ['tudo', 'daqui', 'so'].includes(b.modo) ? b.modo : 'tudo';
        return send(200, { iniciadas: o.run(id, { ids: Array.isArray(b.ids) ? b.ids.map(String) : null, modo }) });
      }
      if (parts[2] === 'parar' && m === 'POST') {
        const b = await this.body(req);
        return send(200, { ok: o.stop(id, b.caixa ? String(b.caixa) : null) });
      }
      if (parts[2] === 'mensagem' && m === 'POST') {
        const b = await this.body(req);
        return send(200, { ok: true, como: o.message(id, String(b.caixa || ''), b.texto) });
      }
      if (parts[2] === 'log' && parts[3] && m === 'GET') return send(200, { eventos: o.logOf(id, parts[3]) });
    }
    if (m === 'POST' && parts[0] === 'responder') {
      const b = await this.body(req);
      const r = b.resposta;
      const ok = ['yes', 'all', 'no'].includes(r) || typeof r === 'string' || (r && typeof r === 'object' && typeof r.deny === 'string');
      need(ok, 'resposta inválida', 400);
      need(o.answer(String(b.pedido || ''), typeof r === 'object' ? { deny: r.deny.slice(0, 2000) } : String(r).slice(0, 4000)), 'Esse pedido já foi respondido.', 409);
      return send(200, { ok: true });
    }
    if (m === 'POST' && parts[0] === 'repos' && parts[1] === 'verificar') {
      const b = await this.body(req);
      return send(200, { repo: orq.inspectRepo(b.caminho) });
    }
    if (m === 'POST' && parts[0] === 'repos' && parts[1] === 'clonar') {
      const b = await this.body(req);
      return send(200, { repo: await orq.cloneRepo(b.url) });
    }
    if (m === 'GET' && parts[0] === 'pastas') return send(200, orq.listDirs(u.searchParams.get('caminho') || ''));
    return need(false);
  }

  stop() {
    if (!this.server) return;
    clearInterval(this.ping);
    for (const c of this.clients) { try { c.end(); } catch { /* já fechado */ } }
    this.clients.clear();
    this.orq.off('evento', this.onEvent);
    this.server.close();
    this.server = null;
  }
}

// Sobe a orquestra: abre o quadro mais recente (ou cria um) e conecta as pastas pedidas como repositórios.
// Usado pela CLI (rfcode orquestra) e pela extensão do VS Code.
async function startOrquestra({ pastas = [], port = DEFAULT_PORT, rede = false, apiKey, orquestra, version = '', quadro = null } = {}) {
  const server = new OrquestraServer({ orquestra, apiKey, rede, version });
  const o = server.orq;
  const repos = [];
  const avisos = [];
  for (const p of pastas) {
    try { repos.push(orq.inspectRepo(path.resolve(p))); } catch (e) { avisos.push(e.message); }
  }
  let board = quadro ? o.board(quadro) : null;
  if (!board) {
    const recent = o.list()[0];
    board = recent ? o.board(recent.id) : o.create({ nome: repos[0] ? repos[0].nome : 'Meu primeiro quadro', repos });
  }
  const missing = repos.filter((r) => !board.repos.some((x) => path.resolve(x.caminho) === path.resolve(r.caminho)));
  if (missing.length) board = o.update(board.id, { ...board, repos: [...board.repos, ...missing] });
  const url = await server.start(port);
  return { server, orquestra: o, quadro: board, url: server.url(board.id), base: url, avisos };
}

module.exports = { OrquestraServer, startOrquestra, pageHtml, openBrowser, DEFAULT_PORT };
