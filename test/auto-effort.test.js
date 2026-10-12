'use strict';
// Modo auto (escolhe e troca de modelo sozinho) e esforço (baixo, médio, alto).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
// o caminho do config é fixado quando lib/agent carrega: uma pasta só para todos os testes deste arquivo
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-auto-'));
process.env.RFCODE_HOME = HOME;
const providers = require('../lib/providers');
const { effortCommand, parseEffort } = require('../lib/commands');

const noop = () => {};
const baseHooks = () => ({
  approve: async () => 'yes', onToolCall: noop, onToolResult: noop, onThinking: noop, onResponseStart: noop, onAssistantEnd: noop,
  onDone: noop, onAborted: noop, onUsage: noop, onInfo: noop, onReasoning: noop, onCommandOutput: noop, onPlan: noop, onText: noop,
});

// Servidor falso compatível com a OpenAI; handler(body) devolve { status, json } para erro ou nada para responder "ok".
async function withServer(handler, fn) {
  const bodies = [];
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => {
      const body = JSON.parse(b);
      bodies.push(body);
      const res = handler(body);
      if (res) { r.writeHead(res.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(res.json)); return; }
      r.setHeader('content-type', 'text/event-stream');
      r.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `ok de ${body.model}` } }] })}\n\n`);
      r.end('data: [DONE]\n\n');
    });
  });
  await new Promise((ok) => srv.listen(0, ok));
  const home = HOME;
  const realTimeout = global.setTimeout;
  global.setTimeout = (f, ms, ...rest) => realTimeout(f, Math.min(ms, 5), ...rest);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/v1`;
    await fn({ home, url, bodies, writeConfig: (c) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrls: { custom: url }, ...c })) });
  } finally {
    global.setTimeout = realTimeout;
    srv.close();
  }
}

test('candidatos do auto: sempre do mais forte ao mais fraco, entre todos os provedores com chave', () => {
  const nv = providers.autoCandidates({ keys: { nvidia: 'x' } });
  assert.strictEqual(nv[0], 'moonshotai/kimi-k3');
  assert.ok(nv.every((m) => !m.includes(':')), 'só NVIDIA quando só ela tem chave');
  assert.ok(nv.indexOf('openai/gpt-oss-20b') > nv.indexOf('nvidia/nemotron-3-super-120b-a12b'), 'os fracos ficam por último');
  // um provedor com modelo mais forte passa na frente da NVIDIA
  const mixed = providers.autoCandidates({ keys: { nvidia: 'x', anthropic: 'y', groq: 'z' } });
  assert.strictEqual(mixed[0], 'anthropic:claude-sonnet-5-5');
  assert.strictEqual(mixed[1], 'moonshotai/kimi-k3');
  assert.ok(mixed.indexOf('groq:llama-3.3-70b-versatile') > mixed.indexOf('groq:openai/gpt-oss-120b'));
  assert.ok(!providers.autoCandidates({ keys: { openrouter: 'x' } }).includes('openrouter:openrouter/auto'), 'roteador de terceiros fica fora');
  assert.deepStrictEqual(providers.autoCandidates({ autoModels: ['groq:x', 'nvidia/y'], keys: { nvidia: 'k' } }), ['nvidia/y'], 'lista manual, sem os que não têm chave');
});

test('reasoning_effort só vai para modelos que aceitam, e nunca no médio', () => {
  const body = (spec, effort) => providers.requestBody(providers.endpoint(spec, { keys: { nvidia: 'k', groq: 'k', openai: 'k' } }), { messages: [], effort });
  assert.strictEqual(body('openai/gpt-oss-20b', 'high').reasoning_effort, 'high');
  assert.strictEqual(body('groq:openai/gpt-oss-120b', 'low').reasoning_effort, 'low');
  assert.strictEqual(body('openai:gpt-5', 'low').reasoning_effort, 'low');
  assert.strictEqual(body('openai/gpt-oss-20b', 'medium').reasoning_effort, undefined);
  assert.strictEqual(body('moonshotai/kimi-k3', 'high').reasoning_effort, undefined);
});

test('/effort entende português e inglês', () => {
  assert.strictEqual(parseEffort('alto'), 'high');
  assert.strictEqual(parseEffort('Médio'), 'medium');
  assert.strictEqual(parseEffort('low'), 'low');
  assert.strictEqual(parseEffort('turbo'), null);
  assert.strictEqual(effortCommand('baixo').effort, 'low');
  assert.ok(!effortCommand('').effort && /Esforço: médio/.test(effortCommand('').text));
  assert.ok(!effortCommand('xyz').effort);
});

test('auto: limite de pedidos troca na hora para o próximo e volta ao melhor quando libera', async () => {
  let limited = true;
  await withServer((b) => (b.model === 'a' && limited ? { status: 429, json: { error: { message: 'Too many requests' } } } : null), async ({ home, bodies, writeConfig }) => {
    writeConfig({ autoModels: ['custom:a', 'custom:b'] });
    const { Agent } = require('../lib/agent');
    const ag = new Agent({ model: 'auto', cwd: home });
    assert.strictEqual(ag.selectedModel, 'auto');
    assert.strictEqual(ag.model, 'custom:a');
    const retries = [], models = [], texts = [], errors = [];
    const h = { ...baseHooks(), onRetry: (m) => retries.push(m), onModel: (m) => models.push(m), onText: (t) => texts.push(t), onError: (e) => errors.push(e) };
    await ag.send('oi', h);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(bodies.map((b) => b.model), ['a', 'b'], 'sem nova tentativa no modelo limitado');
    assert.ok(retries.some((m) => /modo auto seguiu com custom:b/.test(m)));
    assert.deepStrictEqual(models, ['custom:a', 'custom:b']);
    assert.strictEqual(texts.join(''), 'ok de b');
    assert.strictEqual(ag.selectedModel, 'auto', 'continua no modo auto');

    // ainda em espera: o próximo pedido já começa pelo b
    await ag.send('de novo', h);
    assert.strictEqual(bodies.at(-1).model, 'b');
    // a cota do a liberou: volta para ele
    limited = false;
    ag.cooldown['custom:a'] = 0;
    await ag.send('mais um', h);
    assert.strictEqual(bodies.at(-1).model, 'a');

    // escolher um modelo fixo desliga o auto
    ag.model = 'custom:b';
    assert.strictEqual(ag.auto, false);
    assert.strictEqual(ag.selectedModel, 'custom:b');
  });
});

test('auto: todos no limite espera o primeiro liberar em vez de desistir', async () => {
  let calls = 0;
  await withServer(() => (++calls <= 2 ? { status: 429, json: { error: { message: 'rate limit' } } } : null), async ({ home, writeConfig }) => {
    writeConfig({ autoModels: ['custom:a', 'custom:b'] });
    const { Agent } = require('../lib/agent');
    const ag = new Agent({ model: 'auto', cwd: home });
    const retries = [], errors = [], texts = [];
    // cooldowns curtos para o teste: o primeiro a liberar volta logo
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      await ag.send('oi', { ...baseHooks(), onRetry: (m) => { retries.push(m); if (/Todos os modelos/.test(m)) shift += 60000; }, onError: (e) => errors.push(e), onText: (t) => texts.push(t) });
    } finally { Date.now = realNow; }
    assert.deepStrictEqual(errors, []);
    assert.ok(retries.some((m) => /Todos os modelos do modo auto/.test(m)));
    assert.ok(/^ok de /.test(texts.join('')));
  });
});

test('esforço: provedor que recusa reasoning_effort recebe o pedido de novo sem ele', async () => {
  await withServer((b) => (b.reasoning_effort ? { status: 400, json: { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } } } : null), async ({ home, bodies, writeConfig }) => {
    writeConfig({});
    const { Agent } = require('../lib/agent');
    const ag = new Agent({ model: 'custom:gpt-oss-120b', effort: 'high', cwd: home });
    const errors = [], texts = [];
    await ag.send('oi', { ...baseHooks(), onError: (e) => errors.push(e), onText: (t) => texts.push(t) });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(texts.join(''), 'ok de gpt-oss-120b');
    assert.deepStrictEqual(bodies.map((b) => b.reasoning_effort), ['high', undefined]);
    assert.ok(/Esforço: alto/.test(bodies[0].messages[0].content), 'instrução de esforço no prompt do sistema');
    await ag.send('de novo', { ...baseHooks(), onError: (e) => errors.push(e) });
    assert.strictEqual(bodies.length, 3, 'lembra que o modelo não aceita e não tenta mais');
  });
});
