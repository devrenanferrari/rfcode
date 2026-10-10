'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 4600 + Math.floor(Math.random() * 300);

function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('painel: estado, estáticos e proteções', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'dashboard.js')], {
    env: { ...process.env, RFCODE_PAINEL_PORT: String(PORT) }, stdio: 'ignore', windowsHide: true,
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await request('GET', '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const st = await request('GET', '/api/state');
    assert.strictEqual(st.status, 200);
    const j = JSON.parse(st.body);
    assert.ok(Array.isArray(j.tasks) && j.tasks.length > 0, 'lê o backlog do SDD');
    assert.ok(j.tasks.every((t) => /^T\d+$/.test(t.id) && [' ', 'x', '!'].includes(t.state)));
    assert.ok(Array.isArray(j.models));

    const html = await request('GET', '/');
    assert.strictEqual(html.status, 200);
    assert.match(html.body, /Central de auto-melhoria/);

    // POST sem o cabeçalho próprio é recusado (proteção contra sites externos)
    const noHeader = await request('POST', '/api/next', { body: { task: 'T99' } });
    assert.strictEqual(noHeader.status, 403);

    // Host diferente é recusado (proteção contra DNS rebinding)
    const badHost = await request('GET', '/api/state', { headers: { Host: 'evil.example:80' } });
    assert.strictEqual(badHost.status, 403);

    // não deixa sair da pasta do painel
    const trav = await request('GET', '/..%2f..%2fpackage.json');
    assert.notStrictEqual(trav.status, 200);

    const badRun = await request('GET', '/api/run?id=../x');
    assert.strictEqual(badRun.status, 400);
  } finally {
    child.kill();
  }
});
