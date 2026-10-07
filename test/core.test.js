'use strict';
// Testes de base do rfcode. O loop de auto-melhoria NÃO pode alterar este arquivo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, globToRegex, previewCall, describeCall, TOOL_DEFS } = require('../lib/agent');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-test-'));
}

// Simula a API da NVIDIA: cada chamada consome a próxima resposta da fila.
function mockFetch(responses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const r = responses.shift();
    if (!r) throw new Error('mockFetch: sem respostas na fila');
    if (r.status && r.status !== 200) return new Response(r.body || 'erro', { status: r.status });
    const chunks = [];
    if (r.text) for (const piece of r.text.match(/.{1,5}/gs)) chunks.push({ choices: [{ delta: { content: piece } }] });
    (r.tools || []).forEach((t, i) => {
      chunks.push({ choices: [{ delta: { tool_calls: [{ index: i, id: 'call_' + i, function: { name: t.name, arguments: '' } }] } }] });
      chunks.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(t.args) } }] } }] });
    });
    const sse = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200 });
  };
  return calls;
}

test('globToRegex', () => {
  assert.ok(globToRegex('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegex('*.{ts,tsx}').test('x.tsx'));
  assert.ok(!globToRegex('*.js').test('a/b.js'));
});

test('ferramentas de arquivo: write, read, edit, list, glob, grep', () => {
  const dir = tmpdir();
  const a = new Agent({ apiKey: 'x', cwd: dir });
  a.write_file({ path: 'src/a.js', content: 'const x = 1;\nconst y = 2;\n' });
  assert.match(a.read_file({ path: 'src/a.js' }), /const y = 2/);
  a.edit_file({ path: 'src/a.js', old_string: 'const y = 2;', new_string: 'const y = 3;' });
  assert.match(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), /const y = 3/);
  assert.throws(() => a.edit_file({ path: 'src/a.js', old_string: 'nao existe', new_string: '' }), /não encontrado/);
  assert.match(a.list_dir({ path: '.' }), /src\//);
  assert.match(a.glob({ pattern: '**/*.js' }), /src\/a\.js/);
  assert.match(a.grep({ pattern: 'y = 3' }), /src\/a\.js:2:/);
});

test('edit_file preserva CRLF', () => {
  const dir = tmpdir();
  const a = new Agent({ apiKey: 'x', cwd: dir });
  fs.writeFileSync(path.join(dir, 'w.txt'), 'linha1\r\nlinha2\r\n');
  a.edit_file({ path: 'w.txt', old_string: 'linha1\nlinha2', new_string: 'um\ndois' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'um\r\ndois\r\n');
});

test('previewCall e describeCall', () => {
  const p = previewCall('edit_file', { old_string: 'a', new_string: 'b\nc' });
  assert.deepStrictEqual(p.removed, ['a']);
  assert.deepStrictEqual(p.added, ['b', 'c']);
  assert.strictEqual(describeCall('read_file', { path: 'x' }), 'Read(x)');
});

test('loop do agente: chama ferramenta, pede aprovação e responde', async () => {
  const dir = tmpdir();
  const calls = mockFetch([
    { tools: [{ name: 'write_file', args: { path: 'ola.txt', content: 'oi' } }] },
    { text: 'Pronto, criei ola.txt.' },
  ]);
  const a = new Agent({ apiKey: 'x', cwd: dir });
  const events = [];
  let text = '';
  await a.send('crie ola.txt', {
    approve: async (info) => { events.push('approve:' + info.name); return 'yes'; },
    onToolResult: (r) => events.push('result:' + r.name + ':' + (r.error ? 'erro' : 'ok')),
    onText: (t) => { text += t; },
    onDone: () => events.push('done'),
  });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ola.txt'), 'utf8'), 'oi');
  assert.deepStrictEqual(events, ['approve:write_file', 'result:write_file:ok', 'done']);
  assert.strictEqual(text, 'Pronto, criei ola.txt.');
  assert.strictEqual(calls.length, 2);
  // a segunda chamada precisa conter o resultado da ferramenta no histórico
  assert.ok(calls[1].messages.some((m) => m.role === 'tool' && /Arquivo escrito/.test(m.content)));
});

test('loop do agente: ação negada não é executada', async () => {
  const dir = tmpdir();
  mockFetch([
    { tools: [{ name: 'write_file', args: { path: 'nao.txt', content: 'x' } }] },
    { text: 'Ok, não criei.' },
  ]);
  const a = new Agent({ apiKey: 'x', cwd: dir });
  await a.send('crie nao.txt', { approve: async () => ({ deny: 'não quero' }) });
  assert.ok(!fs.existsSync(path.join(dir, 'nao.txt')));
  assert.ok(a.messages.some((m) => m.role === 'tool' && /NEGOU/.test(m.content) && /não quero/.test(m.content)));
});

test('filtro de ferramentas restringe o que o modelo recebe e pode usar', async () => {
  const dir = tmpdir();
  const calls = mockFetch([
    { tools: [{ name: 'run_command', args: { command: 'echo oi' } }] },
    { text: 'fim' },
  ]);
  const a = new Agent({ apiKey: 'x', cwd: dir, tools: ['read_file'] });
  a.autoApprove = true;
  await a.send('rode echo', {});
  assert.deepStrictEqual(calls[0].tools.map((t) => t.function.name), ['read_file']);
  assert.ok(a.messages.some((m) => m.role === 'tool' && /ferramenta desconhecida/.test(m.content)));
});

test('erro 401 é reportado sem novas tentativas', async () => {
  mockFetch([{ status: 401, body: 'unauthorized' }]);
  const a = new Agent({ apiKey: 'x', cwd: tmpdir() });
  let err = '';
  await a.send('oi', { onError: (m) => { err = m; } });
  assert.match(err, /Chave inválida/);
});

test('todas as ferramentas têm nome, descrição e schema', () => {
  for (const t of TOOL_DEFS) {
    assert.ok(t.name && t.description && t.parameters && t.parameters.type === 'object', t.name);
  }
});

test('arquivos principais carregam sem erro de sintaxe', () => {
  const { execFileSync } = require('child_process');
  const root = path.join(__dirname, '..');
  for (const f of ['bin/rfcode.js', 'lib/agent.js', 'lib/pc.js', 'extension/extension.js', 'media/chat.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)]);
  }
});
