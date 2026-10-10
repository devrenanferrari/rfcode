'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { Agent, describeCall } = require('../lib/agent');

function sse(chunks) {
  return new Response(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
}
const toolCall = (name, args, content) => [
  ...(content ? [{ choices: [{ delta: { content } }] }] : []),
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c_' + name, function: { name, arguments: JSON.stringify(args) } }] } }] },
];

test('update_plan guarda o plano, chama onPlan e não pede aprovação', async () => {
  const queue = [
    sse(toolCall('update_plan', {
      goal: 'Adicionar soma',
      steps: [{ text: 'Ler código', status: 'done' }, { text: 'Escrever função', status: 'in_progress' }, { text: 'Testar', status: 'xyz' }],
      why: 'precisa da função antes do teste',
    })),
    sse([{ choices: [{ delta: { content: 'fim' } }] }]),
  ];
  global.fetch = async () => queue.shift();
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  const plans = [];
  let approvals = 0;
  await a.send('faça', { onPlan: (p) => plans.push(p), approve: async () => { approvals++; return 'yes'; } });
  assert.strictEqual(approvals, 0);
  assert.strictEqual(plans.length, 1);
  assert.strictEqual(a.plan.goal, 'Adicionar soma');
  assert.deepStrictEqual(a.plan.steps.map((s) => s.status), ['done', 'in_progress', 'pending']);
  assert.strictEqual(a.plan.why, 'precisa da função antes do teste');
  assert.ok(a.messages.some((m) => m.role === 'tool' && /1\/3 concluídos; em andamento: Escrever função/.test(m.content)));
  assert.strictEqual(describeCall('update_plan', a.plan), 'Plano(1/3)');
});

test('o texto junto com a chamada vira o "porquê" da ação', async () => {
  const queue = [
    sse(toolCall('list_dir', { path: '.' }, 'Vou listar a pasta para entender a estrutura.')),
    sse([{ choices: [{ delta: { content: 'pronto' } }] }]),
  ];
  global.fetch = async () => queue.shift();
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  const reasons = [];
  await a.send('olhe', { onToolCall: (i) => reasons.push(i.reason) });
  assert.deepStrictEqual(reasons, ['Vou listar a pasta para entender a estrutura.']);
});

test('uso de tokens é acumulado a partir do chunk de usage', async () => {
  const queue = [
    sse([{ choices: [{ delta: { content: 'oi' } }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
    sse([{ choices: [{ delta: { content: 'de novo' } }] }, { choices: [], usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 } }]),
  ];
  const bodies = [];
  global.fetch = async (_, o) => { bodies.push(JSON.parse(o.body)); return queue.shift(); };
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  let last = null;
  await a.send('1', { onUsage: (u) => { last = u; } });
  await a.send('2', {});
  assert.deepStrictEqual(a.usage, { prompt: 250, completion: 30, total: 280 });
  assert.deepStrictEqual(last, { prompt: 100, completion: 20, total: 120 });
  assert.deepStrictEqual(bodies[0].stream_options, { include_usage: true });
});

test('maxSteps limita o loop', async () => {
  global.fetch = async () => sse(toolCall('list_dir', { path: '.' }));
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir(), maxSteps: 2 });
  let err = '';
  await a.send('loop', { onError: (m) => { err = m; } });
  assert.match(err, /Limite de 2 passos/);
});

test('lembrete de plano aparece depois de N ações sem update_plan', async () => {
  const queue = [
    sse(toolCall('update_plan', { goal: 'g', steps: [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' }] })),
    sse(toolCall('list_dir', { path: '.' })),
    sse(toolCall('list_dir', { path: '.' })),
    sse([{ choices: [{ delta: { content: 'fim' } }] }]),
  ];
  global.fetch = async () => queue.shift();
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir(), planReminderEvery: 2 });
  await a.send('faça', {});
  const tools = a.messages.filter((m) => m.role === 'tool');
  assert.ok(!/lembrete do sistema/.test(tools[1].content), 'ainda não');
  assert.match(tools[2].content, /lembrete do sistema/);
});
