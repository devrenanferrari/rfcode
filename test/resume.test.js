'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../lib/agent');
const providers = require('../lib/providers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-resume-'));
function fakeApi(scripts) {
  const real = global.fetch;
  const bodies = [];
  let n = 0;
  global.fetch = async (url, opts) => {
    bodies.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const chunks = scripts[Math.min(n++, scripts.length - 1)];
    const body = (typeof chunks === 'function' ? chunks() : chunks).map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return { ok: true, status: 200, body: [Buffer.from(body)] };
  };
  return { bodies, restore: () => { global.fetch = real; } };
}
const call = (id, name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }];
const say = (text) => [{ choices: [{ delta: { content: text } }] }];

test('mensagem enviada durante o trabalho entra no próximo passo', async () => {
  let ag;
  const api = fakeApi([
    () => { ag.queue('ah, e use letras maiúsculas'); return call('a', 'list_dir', {}); },
    say('feito em MAIÚSCULAS'),
  ]);
  try {
    ag = new Agent({ apiKey: 'x', cwd: tmp() });
    const seen = [];
    await ag.send('liste a pasta', { onQueued: (t) => seen.push(...t) });
    assert.deepStrictEqual(seen, ['ah, e use letras maiúsculas']);
    const second = api.bodies[1].body.messages.map((m) => m.content).join('\n');
    assert.match(second, /enquanto você trabalhava[\s\S]*letras maiúsculas/);
  } finally { api.restore(); }
});

test('mensagem que chega depois da resposta final faz a conversa continuar', async () => {
  let ag;
  const api = fakeApi([() => { ag.queue('agora traduza para inglês'); return say('olá'); }, say('hello')]);
  try {
    ag = new Agent({ apiKey: 'x', cwd: tmp() });
    await ag.send('diga olá');
    assert.strictEqual(api.bodies.length, 2);
    assert.strictEqual(ag.messages[ag.messages.length - 1].content, 'hello');
  } finally { api.restore(); }
});

test('conversa salva a cada passo e retomada depois de interrompida', async () => {
  const home = tmp();
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try {
    // simula uma sessão gravada no meio: o modelo pediu uma ação e o processo caiu antes do resultado
    const dir = tmp();
    const a1 = new Agent({ apiKey: 'x', cwd: dir, saveSession: true });
    a1.messages = [
      { role: 'user', content: 'crie a.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"1"}' } }] },
    ];
    a1.sessionManager.save(a1.messages, 'running');
    const saved = a1.sessionManager.list()[0];
    assert.strictEqual(saved.status, 'running');

    const a2 = new Agent({ apiKey: 'x', cwd: dir, saveSession: true });
    a2.messages = a2.sessionManager.load(saved.id);
    assert.ok(a2.interrupted);
    const api = fakeApi([say('Continuei: a.txt já foi tratado.')]);
    try {
      await a2.resume();
    } finally { api.restore(); }
    const sent = api.bodies[0].body.messages;
    const toolMsg = sent.find((m) => m.role === 'tool' && m.tool_call_id === 'w1');
    assert.match(toolMsg.content, /interrompida/, 'ação sem resultado ganha um resultado de interrompida');
    assert.match(sent[sent.length - 1].content, /Continue de onde parou/);
    assert.strictEqual(a2.sessionManager.list()[0].status, 'done');
    assert.ok(!a2.interrupted);
  } finally {
    if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old;
  }
});

test('provedores: prefixo no modelo escolhe endereço, chave e parâmetros', () => {
  assert.deepStrictEqual(providers.parseModel('nvidia/nemotron-3-super-120b-a12b'), { provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' });
  assert.deepStrictEqual(providers.parseModel('ollama:qwen3:8b'), { provider: 'ollama', model: 'qwen3:8b' });
  assert.deepStrictEqual(providers.parseModel('openrouter:meta-llama/llama-3.3-70b-instruct:free'), { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' });
  const ep = providers.endpoint('groq:llama-3.3-70b-versatile', { keys: { groq: 'gsk_abc' } });
  assert.strictEqual(ep.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(ep.headers.Authorization, 'Bearer gsk_abc');
  assert.throws(() => providers.endpoint('openai:gpt-4.1', { keys: {} }), /Falta a API key de OpenAI/);
  const local = providers.endpoint('ollama:qwen3:8b', {});
  assert.ok(!local.headers.Authorization, 'local não precisa de chave');
  const o = providers.requestBody(providers.endpoint('openai:o3-mini', { keys: { openai: 'k' } }), { messages: [], maxTokens: 10 });
  assert.strictEqual(o.max_completion_tokens, 10);
  assert.ok(!('temperature' in o) && !('max_tokens' in o));
  const n = providers.requestBody(providers.endpoint('nvidia/x', { apiKey: 'nvapi-k' }), { messages: [], maxTokens: 10 });
  assert.strictEqual(n.max_tokens, 10);
  assert.deepStrictEqual(n.stream_options, { include_usage: true });
  assert.match(providers.explainError(410, 'model end of life', ep), /aposentado/);
});

test('o agente chama o provedor do modelo escolhido', async () => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_teste';
  const api = fakeApi([say('oi')]);
  try {
    const ag = new Agent({ apiKey: 'nvapi-x', model: 'groq:openai/gpt-oss-120b', cwd: tmp() });
    await ag.send('oi');
    assert.strictEqual(api.bodies[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(api.bodies[0].body.model, 'openai/gpt-oss-120b');
    assert.strictEqual(api.bodies[0].headers.Authorization, 'Bearer gsk_teste');
  } finally {
    api.restore();
    if (old === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = old;
  }
});

test('sem chave do provedor: erro claro, sem ficar tentando de novo', async () => {
  const api = fakeApi([say('não devia chamar')]);
  try {
    const ag = new Agent({ apiKey: 'x', model: 'mistral:mistral-small-latest', cwd: tmp() });
    ag.keys = { mistral: '' };
    const saved = process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    let err = '';
    await ag.send('oi', { onError: (m) => { err = m; } });
    if (saved !== undefined) process.env.MISTRAL_API_KEY = saved;
    assert.match(err, /Falta a API key de Mistral/);
    assert.strictEqual(api.bodies.length, 0);
  } finally { api.restore(); }
});
