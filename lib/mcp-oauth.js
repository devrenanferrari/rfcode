'use strict';
// Login OAuth dos conectores MCP remotos (especificação de autorização do MCP):
// 401 → metadados do recurso → servidor de autorização → registro dinâmico do rfcode → navegador com PKCE →
// código recebido numa porta local → tokens guardados em ~/.rfcode/mcp-auth.json e renovados quando vencem.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const STORE = () => path.join(HOME(), 'mcp-auth.json');
const PORT = 7434;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readStore() { try { return JSON.parse(fs.readFileSync(STORE(), 'utf8')); } catch { return {}; } }
function writeStore(s) {
  fs.mkdirSync(HOME(), { recursive: true });
  fs.writeFileSync(STORE(), JSON.stringify(s, null, 2), { mode: 0o600 });
}
const keyOf = (url) => { const u = new URL(url); return `${u.origin}${u.pathname}`; };

function openBrowser(url) {
  const q = `"${url.replace(/"/g, '%22')}"`;
  const cmd = process.platform === 'win32' ? `start "" ${q}` : process.platform === 'darwin' ? `open ${q}` : `xdg-open ${q}`;
  exec(cmd, { windowsHide: true }, () => {});
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

// Descobre o servidor de autorização a partir do 401 (WWW-Authenticate) ou dos endereços padrão.
async function discover(resourceUrl, wwwAuth) {
  const u = new URL(resourceUrl);
  let prm = null;
  const meta = /resource_metadata="([^"]+)"/.exec(wwwAuth || '');
  const candidates = [meta && meta[1], `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  for (const c of candidates) { try { prm = await getJson(c); break; } catch { /* próximo */ } }
  const issuer = (prm && prm.authorization_servers && prm.authorization_servers[0]) || u.origin;
  const iu = new URL(issuer);
  const asCandidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${iu.pathname.replace(/\/$/, '')}`,
    `${iu.origin}/.well-known/oauth-authorization-server`,
    `${iu.origin}/.well-known/openid-configuration${iu.pathname.replace(/\/$/, '')}`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ];
  for (const c of asCandidates) {
    try {
      const as = await getJson(c);
      if (as.authorization_endpoint && as.token_endpoint) return { as, resource: (prm && prm.resource) || resourceUrl, scopes: (prm && prm.scopes_supported) || as.scopes_supported };
    } catch { /* próximo */ }
  }
  throw new Error(`não encontrei o servidor de login de ${u.origin}`);
}

async function register(as, redirectUri) {
  if (!as.registration_endpoint) throw new Error('o servidor não aceita registro automático de aplicativos; configure um token em headers');
  const r = await fetch(as.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'rfcode', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (!r.ok) throw new Error(`registro recusado (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function tokenRequest(endpoint, params) {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token recusado (HTTP ${r.status}): ${j.error_description || j.error || ''}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_in ? Date.now() + (j.expires_in - 60) * 1000 : null, token_type: j.token_type || 'Bearer' };
}

// Abre a porta local que recebe o código. Resolve quando está ouvindo: { port, code (promise) }.
function listenCallback(port, state, timeoutMs) {
  return new Promise((ready, fail) => {
    let gotCode, lost;
    const code = new Promise((ok, no) => { gotCode = ok; lost = no; });
    code.catch(() => {}); // quem espera o código trata o erro
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.statusCode = 404; return res.end(); }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(ok ? '<h2>rfcode conectado.</h2><p>Pode fechar esta aba e voltar ao rfcode.</p>' : `<h2>Login não concluído</h2><p>${u.searchParams.get('error_description') || u.searchParams.get('error') || 'tente de novo'}</p>`);
      clearTimeout(timer); srv.close();
      if (ok) gotCode(u.searchParams.get('code')); else lost(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'login cancelado'));
    });
    const timer = setTimeout(() => { srv.close(); lost(new Error('o login no navegador não foi concluído em 5 minutos')); }, timeoutMs);
    srv.once('error', (e) => { clearTimeout(timer); fail(e); });
    srv.listen(port, '127.0.0.1', () => ready({ port: srv.address().port, code }));
  });
}

/**
 * Faz o login completo. onUrl(url) é chamado com o endereço de login (para mostrar ao usuário);
 * open(url) abre o navegador (substituível nos testes).
 */
async function login(resourceUrl, { wwwAuth, onUrl, open = openBrowser, timeoutMs = 5 * 60 * 1000, port = PORT } = {}) {
  const { as, resource, scopes } = await discover(resourceUrl, wwwAuth);
  const store = readStore();
  const key = keyOf(resourceUrl);
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  // porta fixa para reaproveitar o registro; se estiver ocupada, qualquer uma (e registra de novo)
  let cb;
  try { cb = await listenCallback(port, state, timeoutMs); } catch { cb = await listenCallback(0, state, timeoutMs); }
  const redirectUri = `http://127.0.0.1:${cb.port}/callback`;
  let client = store[key] && store[key].client;
  if (!client || client.redirect_uri !== redirectUri || client.issuer !== (as.issuer || as.authorization_endpoint)) {
    const reg = await register(as, redirectUri);
    client = { client_id: reg.client_id, client_secret: reg.client_secret, redirect_uri: redirectUri, issuer: as.issuer || as.authorization_endpoint };
  }
  const auth = new URL(as.authorization_endpoint);
  auth.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', resource,
    ...(scopes && scopes.length ? { scope: scopes.join(' ') } : {}),
  }).toString();
  if (onUrl) onUrl(auth.toString());
  open(auth.toString());
  const code = await cb.code;
  const tokens = await tokenRequest(as.token_endpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  });
  store[key] = { client, tokens, token_endpoint: as.token_endpoint, resource };
  writeStore(store);
  return tokens.access_token;
}

// token guardado (renovado se venceu) ou null
async function savedToken(resourceUrl) {
  const store = readStore();
  const e = store[keyOf(resourceUrl)];
  if (!e || !e.tokens) return null;
  if (!e.tokens.expires_at || Date.now() < e.tokens.expires_at) return e.tokens.access_token;
  if (!e.tokens.refresh_token) return null;
  try {
    const t = await tokenRequest(e.token_endpoint, { grant_type: 'refresh_token', refresh_token: e.tokens.refresh_token, client_id: e.client.client_id, resource: e.resource, ...(e.client.client_secret ? { client_secret: e.client.client_secret } : {}) });
    if (!t.refresh_token) t.refresh_token = e.tokens.refresh_token;
    e.tokens = t;
    writeStore(store);
    return t.access_token;
  } catch { return null; }
}

function logout(resourceUrl) {
  const store = readStore();
  delete store[keyOf(resourceUrl)];
  writeStore(store);
}

module.exports = { login, savedToken, logout, discover, openBrowser };
