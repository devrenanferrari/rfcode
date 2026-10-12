'use strict';
// Controle remoto: um servidor HTTP na rede local que serve o mesmo painel do VS Code para o celular.
// O celular recebe os eventos por Server-Sent Events e manda as ações por POST. Tudo exige o token
// do link (QR code); sem ele, nada além da página vazia é servido.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');
const { panelBody } = require('./panel');

const MEDIA_FILES = new Set(['chat.css', 'chat.js', 'markdown.js', 'logo.svg', 'logo.png']);
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

const DEFAULT_PORT = 7433;
const RULE = 'rfcode remoto';

// IP que o PC usa para sair para a internet (a rede de verdade). "Conectar" um socket UDP não envia nada.
function primaryAddress() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v) => { try { sock.close(); } catch { /* já fechado */ } resolve(v); };
    sock.on('error', () => done(null));
    try {
      sock.connect(53, '8.8.8.8', () => { try { done(sock.address().address); } catch { done(null); } });
    } catch { done(null); }
  });
}

// IPs da rede local: o da rota principal primeiro, adaptadores virtuais por último.
function lanAddresses(primary) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      // 192.168.56.x é a rede padrão do VirtualBox; o nome do adaptador costuma ser só "Ethernet 2"
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|vbox|Loopback|Tailscale|ZeroTier/i.test(name) || /^192\.168\.56\./.test(a.address);
      const score = (a.address === primary ? -100 : 0) + (virtual ? 10 : 0) +(/^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : 2);
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

// ---------- firewall do Windows ----------
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 20000 });

// 'ok' | 'missing' | 'n/a' (fora do Windows ou sem como verificar)
function firewallStatus(port) {
  if (process.platform !== 'win32') return 'n/a';
  // Sem permissão de administrador o Windows pode esconder todas as regras: aí não dá para saber ("NA").
  const r = ps(`if (@(Get-NetFirewallRule -ErrorAction SilentlyContinue | Select-Object -First 1).Count -eq 0) { 'NA'; exit 0 }; `
    + `$r = Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }; `
    + `if ($r) { ($r | Get-NetFirewallPortFilter).LocalPort -join ',' }; exit 0`);
  const out = String(r.stdout || '').trim();
  if (r.status !== 0 || out === 'NA') return 'n/a';
  return out.split(/[,\s]+/).includes(String(port)) ? 'ok' : 'missing';
}

// Cria (ou recria) a regra só para esta porta e só para a rede local. Pede elevação (UAC); espera a pessoa responder.
async function allowFirewall(port) {
  if (process.platform !== 'win32') return 'n/a';
  const inner = `netsh advfirewall firewall delete rule name="${RULE}" | Out-Null; netsh advfirewall firewall add rule name="${RULE}" dir=in action=allow protocol=TCP localport=${+port} remoteip=localsubnet profile=any`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const out = await new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; 'ok' } catch { 'cancelado' }`], { windowsHide: true });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => resolve(o));
    p.on('error', () => resolve('cancelado'));
  });
  if (out.includes('cancelado')) return 'cancelled';
  return firewallStatus(port);
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Variáveis de tema do VS Code para a página fora do VS Code (escuro e claro, conforme o celular).
const THEME_VARS = `
:root{--vscode-font-family:-apple-system,"Segoe UI",Roboto,sans-serif;--vscode-font-size:15px;--vscode-editor-font-family:ui-monospace,Menlo,Consolas,monospace;
--vscode-foreground:#d4d4d4;--vscode-sideBar-background:#16181d;--vscode-editor-background:#16181d;--vscode-descriptionForeground:#9aa0a6;
--vscode-textLink-foreground:#4daafc;--vscode-input-background:#24272e;--vscode-input-foreground:#e8e8e8;--vscode-input-border:#363a42;
--vscode-input-placeholderForeground:#8b8f96;--vscode-focusBorder:#76b900;--vscode-textCodeBlock-background:#22252b;--vscode-terminal-background:#111317;
--vscode-dropdown-background:#24272e;--vscode-dropdown-foreground:#e8e8e8;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#d7a10c;
--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#e5534b}
@media (prefers-color-scheme: light){:root{--vscode-foreground:#2b2b2b;--vscode-sideBar-background:#f7f7f8;--vscode-editor-background:#f7f7f8;
--vscode-descriptionForeground:#6b6f76;--vscode-textLink-foreground:#005fb8;--vscode-input-background:#fff;--vscode-input-foreground:#2b2b2b;
--vscode-input-border:#d0d3d8;--vscode-input-placeholderForeground:#8b8f96;--vscode-textCodeBlock-background:#eef0f2;--vscode-terminal-background:#fff;
--vscode-dropdown-background:#fff;--vscode-dropdown-foreground:#2b2b2b;--vscode-errorForeground:#d1242f;--vscode-editorWarning-foreground:#9a6700;
--vscode-gitDecoration-addedResourceForeground:#1a7f37;--vscode-gitDecoration-deletedResourceForeground:#cf222e}}
html,body{height:100%;height:100dvh}
footer{padding-bottom:calc(10px + env(safe-area-inset-bottom))}
.remote-banner{position:fixed;top:0;left:0;right:0;z-index:9;padding:6px 12px;font-size:13px;text-align:center;background:#d7a10c;color:#111}`;

// Ponte: chat.js fala com "acquireVsCodeApi"; aqui ela vira fetch (ida) + EventSource (volta).
const BRIDGE = `
(function(){
  window.rfRemote = true;
  var q = new URLSearchParams(location.hash.slice(1));
  var t = q.get('t') || sessionStorage.getItem('rf-t') || '';
  if (q.get('t')) { sessionStorage.setItem('rf-t', t); history.replaceState(null, '', location.pathname); }
  document.body.className = matchMedia('(prefers-color-scheme: light)').matches ? 'vscode-light' : 'vscode-dark';
  var banner = document.createElement('div'); banner.className = 'remote-banner'; banner.style.display = 'none'; document.body.appendChild(banner);
  function show(msg){ banner.textContent = msg; banner.style.display = msg ? 'block' : 'none'; }
  if (!t) { show('Link sem token. Leia o QR code de novo no VS Code.'); }
  window.acquireVsCodeApi = function(){ return { postMessage: function(m){
    if (m.type === 'ready' || m.type === 'openFile' || m.type === 'setKey') return;
    if (m.type === 'copy') { if (navigator.clipboard) navigator.clipboard.writeText(m.text).catch(function(){}); return; }
    fetch('/msg', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RF-Token': t }, body: JSON.stringify(m) })
      .then(function(r){ if (r.status === 401) show('Sessão expirada. Leia o QR code de novo.'); }).catch(function(){ show('Sem conexão com o PC…'); });
  } }; };
  function connect(){
    var es = new EventSource('/events?t=' + encodeURIComponent(t));
    es.onopen = function(){ show(''); };
    es.onmessage = function(e){ window.postMessage(JSON.parse(e.data), '*'); };
    es.addEventListener('bye', function(){ es.close(); show('O controle remoto foi desligado no PC.'); });
    es.onerror = function(){ if (es.readyState === 2) { show('Reconectando…'); setTimeout(connect, 2000); } else show('Reconectando…'); };
  }
  if (t) connect();
})();`;

function pageHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#16181d"><meta name="robots" content="noindex">
<title>rfcode · remoto</title><link rel="icon" href="/media/logo.svg">
<style>${THEME_VARS}</style><link rel="stylesheet" href="/media/chat.css">
</head><body data-logo="/media/logo.svg">${panelBody()}
<script>${BRIDGE}</script><script src="/media/markdown.js"></script><script src="/media/chat.js"></script>
</body></html>`;
}

class RemoteServer {
  /**
   * mediaDir: pasta com chat.css/chat.js/...; onMessage(msg): ação vinda do celular;
   * onConnect(send): cliente novo (mande o estado atual com send(msg)).
   */
  constructor({ mediaDir, onMessage, onConnect, onDisconnect }) {
    this.mediaDir = mediaDir;
    this.onMessage = onMessage;
    this.onConnect = onConnect || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this.clients = new Set();
    this.token = crypto.randomBytes(18).toString('base64url');
    this.server = null;
    this.port = 0;
  }

  get running() { return !!this.server; }
  get count() { return this.clients.size; }

  // Tenta a porta fixa (a regra do firewall vale para ela); se estiver ocupada, usa uma livre.
  async start(port = DEFAULT_PORT) {
    this.primary = await primaryAddress();
    try { return await this.listen(port); } catch (e) {
      if (e.code === 'EADDRINUSE' && port) return this.listen(0);
      throw e;
    }
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* já respondido */ } }));
      server.on('error', reject);
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port;
        this.ping = setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 20000);
        resolve(this.urls());
      });
    });
  }

  urls() {
    return lanAddresses(this.primary).map((a) => ({ name: a.name, url: `http://${a.address}:${this.port}/#t=${this.token}` }));
  }

  broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
      res.end(body);
    };
    if (req.method === 'GET' && u.pathname === '/') return send(200, pageHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname.startsWith('/media/')) {
      const name = path.basename(u.pathname);
      if (!MEDIA_FILES.has(name)) return send(404, 'não encontrado');
      return send(200, fs.readFileSync(path.join(this.mediaDir, name)), TYPES[path.extname(name)] || 'application/octet-stream');
    }
    // anexos da conversa (imagens salvas pelo PC): só com o token, só dentro de ~/.rfcode/attachments
    if (req.method === 'GET' && u.pathname.startsWith('/att/')) {
      if (!safeEqual(u.searchParams.get('t'), this.token)) return send(401, 'token inválido');
      const base = path.join(os.homedir(), '.rfcode', 'attachments');
      const file = path.join(base, decodeURIComponent(u.pathname.slice(5)).replace(/\0/g, ''));
      if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'não encontrado');
      return send(200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      if (!safeEqual(u.searchParams.get('t'), this.token)) return send(401, 'token inválido');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': ok\n\n');
      this.clients.add(res);
      req.on('close', () => { if (this.clients.delete(res)) this.onDisconnect(); });
      this.onConnect((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
      return undefined;
    }
    if (req.method === 'POST' && u.pathname === '/msg') {
      if (!safeEqual(req.headers['x-rf-token'], this.token)) return send(401, 'token inválido');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 25_000_000) return send(413, 'grande demais'); }
      let msg;
      try { msg = JSON.parse(body); } catch { return send(400, 'json inválido'); }
      send(204, '');
      await this.onMessage(msg);
      return undefined;
    }
    return send(404, 'não encontrado');
  }

  stop() {
    if (!this.server) return;
    clearInterval(this.ping);
    for (const c of this.clients) { try { c.write('event: bye\ndata: {}\n\n'); c.end(); } catch { /* já fechado */ } }
    this.clients.clear();
    this.server.close();
    this.server = null;
  }
}

module.exports = { RemoteServer, lanAddresses, primaryAddress, pageHtml, firewallStatus, allowFirewall, DEFAULT_PORT };
