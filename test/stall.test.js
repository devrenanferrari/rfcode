'use strict';
// Provedor que aceita o pedido e não responde: o vigia de cada pedido estoura a tentativa em vez de esperar 5 min.
// Arquivo próprio: os outros testes de resiliência trocam o setTimeout global, o que bagunça o cliente HTTP do Node.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('provedor que aceita o pedido e não responde (ou trava no meio) não segura a tarefa', async () => {
  const hits = {};
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => {
      const m = JSON.parse(b).model;
      hits[m] = (hits[m] || 0) + 1;
      if (m === 'mudo') return; // nem cabeçalho: fica pendurado
      r.setHeader('content-type', 'text/event-stream');
      if (m === 'trava') { r.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'pensando' } }] })}\n\n`); return; }
      r.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Respondi.' } }] })}\n\n`);
      r.end('data: [DONE]\n\n');
    });
  });
  await new Promise((ok) => srv.listen(0, ok));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-res-'));
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  const realTimeout = global.setTimeout;
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrls: { custom: `http://127.0.0.1:${srv.address().port}/v1` }, fallbackModels: ['custom:trava', 'custom:bom'] }));
    const { Agent } = require('../lib/agent');
    const a = new Agent({ model: 'custom:mudo', cwd: home });
    a.firstResponseMs = 150;
    a.streamIdleMs = 150;
    // só as esperas entre tentativas (2 s ou mais) encurtam; o tique de 1 s do cliente HTTP do Node fica como está
    global.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms >= 2000 ? 5 : ms, ...rest);
    const texts = [], retries = [], errors = [];
    const noop = () => {};
    const h = { onText: (t) => texts.push(t), onRetry: (m) => retries.push(m), onError: (m) => errors.push(m), approve: async () => 'yes',
      onToolCall: noop, onToolResult: noop, onThinking: noop, onResponseStart: noop, onAssistantEnd: noop, onDone: noop, onAborted: noop, onUsage: noop, onInfo: noop, onReasoning: noop, onCommandOutput: noop, onPlan: noop };
    const t0 = Date.now();
    await a.send('oi', h);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(texts, ['Respondi.']);
    assert.strictEqual(a.model, 'custom:bom');
    assert.ok(retries.some((m) => /mudo não começou a responder/.test(m)), retries.join('\n'));
    assert.ok(retries.some((m) => /trava parou de responder no meio/.test(m)), 'travar no meio da resposta também estoura');
    assert.strictEqual(hits.mudo, 2, 'uma nova tentativa antes de trocar de modelo');
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    global.setTimeout = realTimeout;
    srv.closeAllConnections();
    srv.close();
    if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old;
  }
});
