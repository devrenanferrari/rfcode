'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, describeCall } = require('../lib/agent');
const { parseArgs } = require('../lib/jsonfix');
const { replayEvents } = require('../lib/sessions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-files-'));

test('jsonfix: conserta os erros comuns de modelos', () => {
  assert.deepStrictEqual(parseArgs('{"a":1}'), { value: { a: 1 }, repaired: false });
  assert.deepStrictEqual(parseArgs('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepStrictEqual(parseArgs('{"a":1,}').value, { a: 1 });
  assert.deepStrictEqual(parseArgs("{'a': 'b'}").value, { a: 'b' });
  assert.deepStrictEqual(parseArgs('{"t":"linha1\nlinha2"}').value, { t: 'linha1\nlinha2' });
  assert.deepStrictEqual(parseArgs('{"a": {"b": [1, 2').value, { a: { b: [1, 2] } });
  assert.deepStrictEqual(parseArgs('{path: "x.js"}').value, { path: 'x.js' });
  assert.deepStrictEqual(parseArgs('').value, {});
  assert.throws(() => parseArgs('isso não é json'));
});

test('multi_edit: aplica tudo, ou nada se uma edição falha', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  const ag = new Agent({ apiKey: 'x', cwd: dir });
  const ok = ag.multi_edit({ path: 'a.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'b = 2', new_string: 'b = 20' }, { old_string: 'const', new_string: 'let', replace_all: true }] });
  assert.match(ok, /3 edições/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'let a = 10;\nlet b = 20;\nlet c = 3;\n');
  const before = fs.readFileSync(f, 'utf8');
  assert.throws(() => ag.multi_edit({ path: 'a.js', edits: [{ old_string: 'a = 10', new_string: 'a = 0' }, { old_string: 'nao existe', new_string: 'x' }] }), /Edição 2 de 2 falhou; nada foi gravado/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'arquivo intacto');
  assert.strictEqual(describeCall('multi_edit', { path: 'a.js', edits: [{}, {}] }), 'MultiEdit(a.js, 2 edições)');
});

test('multi_edit respeita CRLF', () => {
  const dir = tmp();
  const f = path.join(dir, 'w.txt');
  fs.writeFileSync(f, 'um\r\ndois\r\ntres\r\n');
  new Agent({ apiKey: 'x', cwd: dir }).multi_edit({ path: 'w.txt', edits: [{ old_string: 'um\ndois', new_string: 'UM\nDOIS' }] });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'UM\r\nDOIS\r\ntres\r\n');
});

test('write_file grava CSV com BOM para o Excel', () => {
  const dir = tmp();
  new Agent({ apiKey: 'x', cwd: dir }).write_file({ path: 'p.csv', content: 'nome;preço\nCafé;5' });
  assert.ok(fs.readFileSync(path.join(dir, 'p.csv'), 'utf8').startsWith('﻿nome'));
});

test('JSON quebrado do modelo é consertado e o histórico fica válido', async () => {
  const dir = tmp();
  const calls = [];
  const realFetch = global.fetch;
  let n = 0;
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const chunks = n++ === 0
      ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path": "a.txt", "content": "oi",}' } }] } }] }]
      : [{ choices: [{ delta: { content: 'feito' } }] }];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return { ok: true, status: 200, body: [Buffer.from(body)] };
  };
  try {
    const ag = new Agent({ apiKey: 'x', cwd: dir });
    ag.autoApprove = true;
    await ag.send('crie');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'oi');
    const sent = calls[1].messages.find((m) => m.tool_calls);
    assert.doesNotThrow(() => JSON.parse(sent.tool_calls[0].function.arguments), 'argumentos consertados no histórico');
  } finally {
    global.fetch = realFetch;
  }
});

test('replayEvents reconstrói a conversa para o painel', () => {
  const msgs = [
    { role: 'user', content: 'olhe @a.js\n--- Begin file: a.js ---\nconteudo\n--- End file: a.js ---' },
    { role: 'assistant', content: 'vou ler', tool_calls: [
      { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
      { id: 't2', type: 'function', function: { name: 'update_plan', arguments: '{"goal":"g","steps":[{"text":"s","status":"done"}]}' } },
    ] },
    { role: 'tool', tool_call_id: 't1', name: 'read_file', content: '1\tx' },
    { role: 'tool', tool_call_id: 't2', name: 'update_plan', content: 'ok' },
    { role: 'assistant', content: 'pronto' },
  ];
  const ev = replayEvents(msgs, { describe: describeCall });
  assert.deepStrictEqual(ev.map((e) => e.type), ['user', 'text', 'assistantEnd', 'toolCall', 'plan', 'toolResult', 'toolResult', 'text', 'assistantEnd', 'done']);
  assert.strictEqual(ev[0].text, 'olhe @a.js', 'sem o conteúdo anexado');
  assert.strictEqual(ev[3].label, 'Read(a.js)');
  assert.strictEqual(ev[4].plan.goal, 'g');
  assert.strictEqual(ev[5].error, false);
});
