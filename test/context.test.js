'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ctx = require('../lib/context');
const { Agent } = require('../lib/agent');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-ctx-'));
const big = (n) => 'x'.repeat(n);
const sse = (chunks) => ({ ok: true, status: 200, body: [Buffer.from(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n')] });
const call = (id, name, args, usage) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }, ...(usage ? [{ choices: [], usage }] : [])]);
const say = (text, usage) => sse([{ choices: [{ delta: { content: text } }] }, ...(usage ? [{ choices: [], usage }] : [])]);
const summaryReply = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });

test('janela de contexto por provedor e por configuração', () => {
  assert.strictEqual(ctx.contextWindow('nvidia/nemotron-3-super-120b-a12b'), 128000);
  assert.strictEqual(ctx.contextWindow('anthropic:claude-sonnet-5-5'), 200000);
  assert.strictEqual(ctx.contextWindow('gemini:gemini-2.5-flash'), 1000000);
  assert.strictEqual(ctx.contextWindow('ollama:qwen3:8b'), 8192);
  assert.strictEqual(ctx.contextWindow('ollama:qwen3:8b', { contextWindows: { 'ollama:qwen3:8b': 32768 } }), 32768);
  assert.strictEqual(ctx.contextWindow('groq:llama', { contextWindow: 50000 }), 50000);
});

test('o corte nunca separa uma ação do seu resultado', () => {
  const msgs = [
    { role: 'user', content: big(4000) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: big(4000) },
    { role: 'tool', tool_call_id: 'b', content: big(400) },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'próximo' },
  ];
  for (let keep = 50; keep < 4000; keep += 150) {
    const at = ctx.splitPoint(msgs, keep);
    if (at < 0) continue;
    assert.notStrictEqual(msgs[at].role, 'tool', `corte em ${at} com keep=${keep}`);
  }
  assert.strictEqual(ctx.splitPoint(msgs, 0), msgs.length, 'keep=0 resume tudo');
  assert.strictEqual(ctx.splitPoint([{ role: 'user', content: 'a' }], 100), -1);
});

test('compacta no meio de uma tarefa longa e mantém o estado', async () => {
  const dir = tmp();
  const ag = new Agent({ apiKey: 'x', cwd: dir });
  // janela pequena para forçar a compactação depois de poucas ações
  ag.contextWindow = () => 20000;
  const prompts = [];
  let summaryCalls = 0;
  const steps = [
    () => call('w1', 'write_file', { path: 'a.txt', content: big(30000) }, { prompt_tokens: 3000 }),
    () => call('p1', 'update_plan', { goal: 'Gerar relatório', steps: [{ text: 'Escrever a.txt', status: 'done' }, { text: 'Revisar', status: 'in_progress' }] }, { prompt_tokens: 12000 }),
    () => call('l1', 'list_dir', {}, { prompt_tokens: 15000 }),
    () => say('pronto', { prompt_tokens: 6000 }),
  ];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (!body.stream) { summaryCalls++; return summaryReply('## Pedidos e objetivo\n- gerar relatório'); }
    prompts.push(body.messages);
    return steps.shift()();
  };
  try {
    ag.autoApprove = true;
    const notes = [];
    await ag.send('gere o relatório completo em a.txt', { onRetry: (m) => notes.push(m) });
    assert.ok(summaryCalls >= 1, 'houve compactação durante a tarefa');
    assert.ok(notes.some((n) => /Contexto em \d+%/.test(n)), 'avisou a compactação');
    const after = prompts[prompts.length - 1];
    const summary = after.find((m) => m.role === 'user' && String(m.content).startsWith(ctx.SUMMARY_PREFIX));
    assert.ok(summary, 'o resumo entrou na conversa');
    assert.match(summary.content, /Pedido do usuário mais recente[\s\S]*gere o relatório completo/);
    assert.match(summary.content, /Plano atual: Gerar relatório/);
    assert.match(summary.content, /a\.txt/);
    // histórico continua válido: todo resultado de ferramenta tem a chamada correspondente antes dele
    const ids = new Set();
    for (const m of ag.messages) {
      if (m.role === 'assistant') for (const tc of m.tool_calls || []) ids.add(tc.id);
      if (m.role === 'tool') assert.ok(ids.has(m.tool_call_id), `resultado órfão ${m.tool_call_id}`);
    }
    assert.strictEqual(ag.messages[ag.messages.length - 1].content, 'pronto');
  } finally { global.fetch = real; }
});

test('se a API recusar por excesso de contexto, compacta e tenta de novo', async () => {
  const ag = new Agent({ apiKey: 'x', cwd: tmp() });
  ag.messages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `mensagem ${i} ${big(2000)}` }));
  let n = 0, summaries = 0;
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (!body.stream) { summaries++; return summaryReply('- resumo'); }
    n++;
    if (n === 1) return { ok: false, status: 400, text: async () => 'This model\'s maximum context length is 8192 tokens' };
    return say('ok depois de compactar');
  };
  try {
    let err = '';
    await ag.send('continue', { onError: (m) => { err = m; } });
    assert.strictEqual(err, '');
    assert.strictEqual(summaries, 1);
    assert.strictEqual(ag.messages[ag.messages.length - 1].content, 'ok depois de compactar');
  } finally { global.fetch = real; }
});
