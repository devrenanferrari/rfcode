'use strict';
// Melhorias de "inteligência" para modelos menores: memória de leitura, edição tolerante com dica, detector de repetição.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../lib/agent');

function workdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-smart-')); }
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });

test('reler arquivo que não mudou devolve aviso curto; depois de mudar, lê de novo', () => {
  const dir = workdir();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'linha1\nlinha2\n');
    const a = new Agent({ apiKey: 'x', cwd: dir });
    assert.match(a.read_file({ path: 'a.js' }), /linha2/);
    assert.match(a.read_file({ path: 'a.js' }), /^\[já lido\]/);
    assert.match(a.read_file({ path: 'a.js', offset: 2 }), /linha2/, 'outro trecho é lido normalmente');
    a.edit_file({ path: 'a.js', old_string: 'linha2', new_string: 'linha dois' });
    assert.match(a.read_file({ path: 'a.js' }), /linha dois/, 'arquivo mudou: lê de novo');
  } finally { cleanup(dir); }
});

test('edit_file tolera espaços no fim das linhas', () => {
  const dir = workdir();
  try {
    fs.writeFileSync(path.join(dir, 'b.js'), 'function f() {   \n  return 1;\n}\n');
    const a = new Agent({ apiKey: 'x', cwd: dir });
    a.edit_file({ path: 'b.js', old_string: 'function f() {\n  return 1;', new_string: 'function f() {\n  return 2;' });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), 'function f() {\n  return 2;\n}\n');
  } finally { cleanup(dir); }
});

test('edit_file que falha mostra o trecho mais parecido com números de linha', () => {
  const dir = workdir();
  try {
    const body = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\nfunction calcularTotal(itens) {\n  return itens.reduce((s, x) => s + x.preco, 0);\n}\n';
    fs.writeFileSync(path.join(dir, 'c.js'), body);
    const a = new Agent({ apiKey: 'x', cwd: dir });
    assert.throws(
      () => a.edit_file({ path: 'c.js', old_string: 'function calcularTotal(itens) {\n    return itens.reduce((soma, x) => soma + x.preco, 0);', new_string: 'x' }),
      (e) => /Trecho mais parecido/.test(e.message) && /41\tfunction calcularTotal/.test(e.message),
    );
  } finally { cleanup(dir); }
});

test('repetir a mesma ação 3 vezes gera alerta para mudar de abordagem', async () => {
  const dir = workdir();
  try {
    const call = (id) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }] })}\n\ndata: [DONE]\n\n`);
    const queue = [call('a'), call('b'), call('c'), new Response('data: {"choices":[{"delta":{"content":"fim"}}]}\n\ndata: [DONE]\n\n')];
    global.fetch = async () => queue.shift();
    const a = new Agent({ apiKey: 'x', cwd: dir });
    await a.send('liste', {});
    const tools = a.messages.filter((m) => m.role === 'tool');
    assert.ok(!/alerta do sistema/.test(tools[1].content));
    assert.match(tools[2].content, /alerta do sistema: você já fez exatamente esta ação 3 vezes/);
  } finally { cleanup(dir); }
});
