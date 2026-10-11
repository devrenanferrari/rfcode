'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCommand, listCommands, expandCustom, reviewFor } = require('../lib/commands');
const { Agent } = require('../lib/agent');
const { qrMatrix, qrSvg } = require('../lib/qr');
const { RemoteServer } = require('../lib/remote');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-cmd-'));

test('parseCommand resolve apelidos e argumentos', () => {
  assert.deepStrictEqual(parseCommand('/model glm-5.3'), { name: 'model', args: 'glm-5.3' });
  assert.deepStrictEqual(parseCommand('/clear'), { name: 'new', args: '' });
  assert.deepStrictEqual(parseCommand('/resume'), { name: 'history', args: '' });
  assert.deepStrictEqual(parseCommand('/plan crie\numa API'), { name: 'plan', args: 'crie\numa API' });
  assert.strictEqual(parseCommand('oi /model'), null);
});

test('comandos personalizados do projeto e do usuário', () => {
  const home = tmp(), proj = tmp();
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.rfcode', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, 'commands', 'resumo.md'), 'Resuma do jeito do usuário');
    fs.writeFileSync(path.join(proj, '.rfcode', 'commands', 'resumo.md'), 'description: Resumo do projeto\nResuma $ARGUMENTS em 3 linhas');
    fs.writeFileSync(path.join(proj, '.rfcode', 'commands', 'testes.md'), 'Rode os testes');
    const list = listCommands(proj, 'ui');
    const resumo = list.find((c) => c.name === 'resumo');
    assert.strictEqual(resumo.desc, 'Resumo do projeto', 'o do projeto vence');
    assert.ok(list.some((c) => c.name === 'testes' && c.custom));
    assert.ok(!list.some((c) => c.name === 'think'), '/think é só da CLI');
    assert.strictEqual(expandCustom('resumo', 'o README', proj), 'Resuma o README em 3 linhas');
    assert.strictEqual(expandCustom('testes', 'agora', proj), 'Rode os testes\n\nagora');
    assert.strictEqual(expandCustom('nada', '', proj), null);
  } finally {
    if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old;
  }
});

test('/review fora de um repositório explica o motivo', () => {
  const r = reviewFor(tmp());
  assert.ok(r.reason && !r.send);
});

test('modo plano bloqueia alterações e libera depois do /go', async () => {
  const dir = tmp();
  const realFetch = global.fetch;
  const reply = (chunks) => ({ ok: true, status: 200, body: [Buffer.from(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')] });
  let n = 0;
  global.fetch = async () => (n++ % 2 === 0
    ? reply([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w' + n, function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' } }] } }] }])
    : reply([{ choices: [{ delta: { content: 'ok' } }] }]));
  try {
    const ag = new Agent({ apiKey: 'x', cwd: dir });
    ag.autoApprove = true;
    ag.planOnly = true;
    let asked = 0;
    await ag.send('crie', { approve: async () => { asked++; return 'yes'; } });
    assert.ok(!fs.existsSync(path.join(dir, 'a.txt')), 'nada é criado no modo plano');
    assert.strictEqual(asked, 0, 'nem pede aprovação');
    assert.match(ag.messages.find((m) => m.role === 'tool').content, /Modo plano/);
    ag.planOnly = false;
    await ag.send('go');
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'depois do /go cria');
  } finally {
    global.fetch = realFetch;
  }
});

test('compact troca o histórico por um resumo', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(!body.tools, 'sem ferramentas');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '- objetivo: X\n- feito: Y' } }] }) };
  };
  try {
    const ag = new Agent({ apiKey: 'x', cwd: tmp() });
    ag.messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }];
    await ag.compact();
    assert.strictEqual(ag.messages.length, 2);
    assert.match(ag.messages[0].content, /^Resumo da conversa até aqui[^\n]*\n- objetivo: X/);
    assert.strictEqual(ag.messages[1].role, 'assistant');
  } finally {
    global.fetch = realFetch;
  }
});

test('QR: matriz quadrada no tamanho da versão, com os três localizadores', () => {
  const m = qrMatrix('http://192.168.0.10:5000/#t=abcdefghijklmnopqrstuvwx');
  const size = m.length;
  assert.ok((size - 17) % 4 === 0 && m.every((r) => r.length === size));
  for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    assert.ok(m[y][x] && m[y + 6][x + 6] && !m[y + 1][x + 1] && m[y + 3][x + 3], `localizador em ${x},${y}`);
  }
  assert.match(qrSvg('oi'), /^<svg[\s\S]*<path d="M/);
  assert.throws(() => qrMatrix('x'.repeat(400)), /longo demais/);
});

test('servidor remoto: página pública, resto exige token', async () => {
  const got = [];
  const srv = new RemoteServer({ mediaDir: path.join(__dirname, '..', 'media'), onMessage: async (m) => got.push(m), onConnect: (send) => send({ type: 'init' }) });
  await srv.start(0);
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /acquireVsCodeApi/);
    assert.ok(!page.includes(srv.token), 'a página não carrega o token');
    assert.strictEqual((await fetch(base + '/media/chat.css')).status, 200);
    assert.strictEqual((await fetch(base + '/media/..%2F..%2Fpackage.json')).status, 404);
    assert.strictEqual((await fetch(base + '/msg', { method: 'POST', body: '{}' })).status, 401);
    assert.strictEqual((await fetch(base + '/events?t=errado')).status, 401);
    const ok = await fetch(base + '/msg', { method: 'POST', headers: { 'X-RF-Token': srv.token }, body: JSON.stringify({ type: 'send', text: 'oi' }) });
    assert.strictEqual(ok.status, 204);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(got, [{ type: 'send', text: 'oi' }]);
    // eventos: o cliente novo recebe o estado e depois as transmissões
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events?t=${srv.token}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    srv.broadcast({ type: 'info', text: 'ao vivo' });
    let text = '';
    while (!text.includes('ao vivo')) text += Buffer.from((await reader.read()).value).toString();
    assert.match(text, /"type":"init"/);
    ctrl.abort();
    assert.ok(srv.urls().every((u) => u.url.includes('#t=' + srv.token)));
  } finally {
    srv.stop();
  }
});
