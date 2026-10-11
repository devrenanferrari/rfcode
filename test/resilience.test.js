'use strict';
// Provedor instável: texto corrompido e erro dentro do stream levam a novas tentativas e ao modelo reserva.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('texto corrompido é descartado e o modelo reserva assume', async () => {
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => {
      const m = JSON.parse(b).model;
      r.setHeader('content-type', 'text/event-stream');
      const send = (o) => r.write(`data: ${JSON.stringify(o)}\n\n`);
      if (m === 'ruim') send({ choices: [{ delta: { content: '<|close|>1. <|close|>1. 1.<|close|> 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1. 1.' } }] });
      else if (m === 'cheio') send({ error: { message: 'ResourceExhausted: Worker local total request limit reached (33/32)', code: 500 } });
      else send({ choices: [{ delta: { content: 'Tudo certo.' } }] });
      r.end('data: [DONE]\n\n');
    });
  });
  await new Promise((ok) => srv.listen(0, ok));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-res-'));
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrls: { custom: `http://127.0.0.1:${srv.address().port}/v1` }, fallbackModels: ['custom:cheio', 'custom:bom'] }));
    const { Agent } = require('../lib/agent');
    const a = new Agent({ model: 'custom:ruim', cwd: home });
    // sem esperas longas no teste
    const realTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 5), ...rest);
    const texts = [], retries = [], errors = [];
    const noop = () => {};
    const h = { onText: (t) => texts.push(t), onRetry: (m) => retries.push(m), onError: (m) => errors.push(m), approve: async () => 'yes',
      onToolCall: noop, onToolResult: noop, onThinking: noop, onResponseStart: noop, onAssistantEnd: noop, onDone: noop, onAborted: noop, onUsage: noop, onInfo: noop, onReasoning: noop, onCommandOutput: noop, onPlan: noop };
    try { await a.send('oi', h); } finally { global.setTimeout = realTimeout; }
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(texts, ['Tudo certo.'], 'o lixo não chega na tela');
    assert.ok(retries.some((m) => /corrompido/.test(m)));
    assert.ok(retries.some((m) => /sobrecarregado/.test(m)), 'erro dentro do stream é reconhecido');
    assert.strictEqual(a.model, 'custom:bom');
    assert.strictEqual(a.primaryModel, 'custom:ruim');
  } finally {
    srv.close();
    if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old;
  }
});
