'use strict';
// Login OAuth de conector MCP remoto contra um servidor de autorização falso que segue a especificação.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeServer() {
  const st = { registered: 0, issued: 0, refreshed: 0, challenge: null, tokens: new Set() };
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const u = new URL(req.url, base);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (u.pathname === '/.well-known/oauth-protected-resource') return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['ler'] });
      if (u.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
      if (u.pathname === '/register') { st.registered++; const r = JSON.parse(body); st.redirect = r.redirect_uris[0]; return json({ client_id: 'cliente-1' }); }
      if (u.pathname === '/authorize') {
        assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(u.searchParams.get('resource'), `${base}/mcp`);
        st.challenge = u.searchParams.get('code_challenge');
        res.statusCode = 302;
        res.setHeader('location', `${u.searchParams.get('redirect_uri')}?code=cod-123&state=${u.searchParams.get('state')}`);
        return res.end();
      }
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'authorization_code') {
          const ch = crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          if (ch !== st.challenge || p.get('code') !== 'cod-123') return json({ error: 'invalid_grant' }, 400);
          st.issued++;
          const t = `tok-${st.issued}`; st.tokens.add(t);
          return json({ access_token: t, refresh_token: 'ref-1', expires_in: 1 }); // vence logo, para testar a renovação
        }
        if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'ref-1') {
          st.refreshed++;
          const t = `tok-r${st.refreshed}`; st.tokens.add(t);
          return json({ access_token: t, expires_in: 3600 });
        }
        return json({ error: 'invalid_grant' }, 400);
      }
      if (u.pathname === '/mcp') {
        const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!st.tokens.has(tok)) { res.statusCode = 401; res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`); return res.end(); }
        const m = JSON.parse(body || '{}');
        if (m.id == null) { res.statusCode = 202; return res.end(); }
        const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'oauth', version: '1' } }
          : m.method === 'tools/list' ? { tools: [{ name: 'quem_sou', description: 'Usuário logado', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
          : { content: [{ type: 'text', text: `logado com ${tok}` }] };
        return json({ jsonrpc: '2.0', id: m.id, result });
      }
      res.statusCode = 404; res.end();
    });
  });
  return { srv, st };
}

test('conector remoto com login OAuth: descoberta, registro, PKCE, token guardado e renovado', async () => {
  const { srv, st } = fakeServer();
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-oauth-'));
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try {
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { sistema: { type: 'http', url } } }));
    const oauth = require('../lib/mcp-oauth');
    const { McpManager } = require('../lib/mcp');
    // "navegador": segue o redirecionamento até a porta local do rfcode
    const realLogin = oauth.login;
    let shown = '';
    oauth.login = (u, o = {}) => realLogin(u, { ...o, port: 0, open: (link) => { fetch(link).catch(() => {}); } });
    try {
      // sem modo interativo: não abre navegador, explica o que fazer
      const m0 = new McpManager(path.join(home, 'p'));
      await m0.start(10000);
      assert.match(m0.status(), /precisa de login: rode \/mcp login sistema/);
      m0.closeAll();

      const m = new McpManager(path.join(home, 'p'));
      await m.start(10000, { interactive: true, onAuthUrl: (u) => { shown = u; } });
      assert.match(m.status(), /sistema .*conectado, 1 ferramentas/);
      assert.match(shown, /\/authorize\?response_type=code&client_id=cliente-1/);
      assert.strictEqual(await m.call('mcp__sistema__quem_sou', {}), 'logado com tok-1');
      m.closeAll();
      assert.strictEqual(st.registered, 1);
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'mcp-auth.json'), 'utf8'));
      assert.strictEqual(Object.values(saved)[0].client.client_id, 'cliente-1');

      // o token venceu: renova sozinho com o refresh token, sem navegador
      await new Promise((r) => setTimeout(r, 1100));
      const m2 = new McpManager(path.join(home, 'p'));
      await m2.start(10000);
      assert.match(m2.status(), /conectado/);
      assert.strictEqual(await m2.call('mcp__sistema__quem_sou', {}), 'logado com tok-r1');
      assert.strictEqual(st.issued, 1, 'não pediu login de novo');
      m2.closeAll();
    } finally { oauth.login = realLogin; }
  } finally {
    srv.close();
    if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old;
  }
});
