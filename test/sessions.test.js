'use strict';
// Sessões salvas e retomada (T07, revisada).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../lib/agent');
const { SessionManager } = require('../lib/sessions');

const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-work-'));
  const prev = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try { await fn(home, work); } finally {
    if (prev === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = prev;
    cleanup(home); cleanup(work);
  }
}

test('uma conversa = um arquivo, regravado a cada resposta, com título', async () => {
  await withHome(async (home, work) => {
    global.fetch = async () => sse('ok');
    const agent = new Agent({ apiKey: 'x', cwd: work, saveSession: true });
    await agent.send('Explique o projeto @nada', {});
    await agent.send('agora escreva testes', {});
    await agent.send('e rode', {});
    const list = agent.sessionManager.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].title, 'Explique o projeto @nada');
    assert.strictEqual(list[0].count, 6);
    assert.strictEqual(list[0].cwd, work);
  });
});

test('sem saveSession nada é gravado (testes, loop e extensão não sujam a pasta do usuário)', async () => {
  await withHome(async (home, work) => {
    global.fetch = async () => sse('ok');
    await new Agent({ apiKey: 'x', cwd: work }).send('oi', {});
    assert.ok(!fs.existsSync(path.join(home, 'sessions')) || fs.readdirSync(path.join(home, 'sessions')).length === 0);
  });
});

test('retomar continua gravando no mesmo arquivo e lista mais recentes primeiro', async () => {
  await withHome(async (home, work) => {
    global.fetch = async () => sse('ok');
    const a = new Agent({ apiKey: 'x', cwd: work, saveSession: true });
    await a.send('primeira conversa', {});
    const b = new Agent({ apiKey: 'x', cwd: work, saveSession: true });
    await new Promise((r) => setTimeout(r, 15));
    await b.send('segunda conversa', {});
    const sm = new SessionManager();
    const list = sm.list();
    assert.deepStrictEqual(list.map((s) => s.title), ['segunda conversa', 'primeira conversa']);

    const c = new Agent({ apiKey: 'x', cwd: work, saveSession: true });
    c.messages = c.sessionManager.load(list[1].file);
    await c.send('continuando a primeira', {});
    const after = sm.list();
    assert.strictEqual(after.length, 2, 'retomar não cria arquivo novo');
    const first = after.find((s) => s.title === 'primeira conversa');
    assert.strictEqual(first.count, 4);
  });
});

test('aceita o formato antigo (só o array de mensagens)', async () => {
  await withHome(async (home) => {
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'antiga.json'), JSON.stringify([{ role: 'user', content: 'velha' }, { role: 'assistant', content: 'r' }]));
    const sm = new SessionManager();
    const [s] = sm.list();
    assert.strictEqual(s.title, 'velha');
    assert.strictEqual(sm.load(s.file).length, 2);
  });
});
