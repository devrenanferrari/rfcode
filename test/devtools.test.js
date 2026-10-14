'use strict';
// ensure_tool (instalador sob demanda) e as 10 ferramentas gerais: apply_patch, run_tests, detect_stack,
// replace_in_files, diff, json_query, hash, bench, serve, archive. Testa sem instalar nada nem abrir rede externa.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-dev-'));

test('setup/ensure_tool: já instalado, detecção de gerenciadores e aprovação', () => {
  const setup = require('../lib/tools/setup');
  assert.strictEqual(setup.needsApproval(), true);
  // "node" existe neste ambiente, então não tenta instalar
  assert.match(setup.run('ensure_tool', { tool: 'node' }, { cwd: tmp() }), /já está instalado/);
  assert.throws(() => setup.run('ensure_tool', { tool: 'rm -rf /' }, { cwd: tmp() }), /nome do programa/);
  assert.ok(Array.isArray(setup._test.available()));
  const ff = setup._test.KNOWN.ffmpeg;
  assert.strictEqual(setup._test.pkgFor(ff, 'apt', 'ffmpeg'), 'ffmpeg');
  assert.strictEqual(setup._test.pkgFor(ff, 'winget', 'ffmpeg'), 'Gyan.FFmpeg');
});

test('apply_patch: altera arquivo existente e cria arquivo novo', () => {
  const dev = require('../lib/tools/devcore');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.txt'), 'linha1\nlinha2\nlinha3\n');
  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' linha1',
    '-linha2',
    '+LINHA DOIS',
    ' linha3',
    '--- /dev/null',
    '+++ b/novo.txt',
    '@@ -0,0 +1,2 @@',
    '+ola',
    '+mundo',
    '',
  ].join('\n');
  const r = dev.run('apply_patch', { patch }, { cwd: d });
  assert.match(r, /2 arquivo/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'linha1\nLINHA DOIS\nlinha3\n');
  assert.strictEqual(fs.readFileSync(path.join(d, 'novo.txt'), 'utf8'), 'ola\nmundo\n');
  assert.strictEqual(dev.needsApproval(), true);
});

test('apply_patch: localiza contexto mesmo deslocado e erra com clareza se não acha', () => {
  const dev = require('../lib/tools/devcore');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'x.txt'), 'cabecalho\n\nalvo\nfim\n');
  // o diff diz linha 1, mas o alvo está na 3: deve achar pelo contexto
  const patch = '--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-alvo\n+ACERTOU\n';
  dev.run('apply_patch', { patch }, { cwd: d });
  assert.match(fs.readFileSync(path.join(d, 'x.txt'), 'utf8'), /ACERTOU/);
  const bad = '--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-nao existe\n+y\n';
  assert.throws(() => dev.run('apply_patch', { patch: bad }, { cwd: d }), /contexto/);
});

test('run_tests: detecta comando por package.json e aceita override', () => {
  const dev = require('../lib/tools/devcore');
  const d = tmp();
  assert.throws(() => dev.run('run_tests', {}, { cwd: d }), /Não descobri/);
  assert.strictEqual(dev._test.detectTestCmd(d), null);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  assert.deepStrictEqual(dev._test.detectTestCmd(d), { cmd: 'npm test', kind: 'node' });
  fs.writeFileSync(path.join(d, 'yarn.lock'), '');
  assert.strictEqual(dev._test.detectTestCmd(d).cmd, 'yarn test');
});

test('detect_stack: resume linguagens, gerenciador e scripts', () => {
  const kit = require('../lib/tools/devkit');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y' }, dependencies: { react: '1', vite: '1' } }));
  fs.writeFileSync(path.join(d, 'index.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(d, 'app.jsx'), 'export default 1\n');
  const r = kit.run('detect_stack', {}, { cwd: d });
  assert.match(r, /\.js/);
  assert.match(r, /npm/);
  assert.match(r, /react/);
  assert.match(r, /build=npm run build/);
});

test('replace_in_files: prévia não altera, apply altera e conta', () => {
  const kit = require('../lib/tools/devkit');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.js'), 'cor = 1; cor = 2;\n');
  fs.writeFileSync(path.join(d, 'b.js'), 'const cor = 3;\n');
  const preview = kit.run('replace_in_files', { pattern: 'cor', replacement: 'color' }, { cwd: d });
  assert.match(preview, /Prévia/);
  assert.match(preview, /3 ocorrência/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.js'), 'utf8'), 'cor = 1; cor = 2;\n'); // intacto
  assert.strictEqual(kit.needsApproval('replace_in_files', { apply: true }), true);
  assert.strictEqual(kit.needsApproval('replace_in_files', {}), false);
  kit.run('replace_in_files', { pattern: 'cor', replacement: 'color', apply: true }, { cwd: d });
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.js'), 'utf8'), 'color = 1; color = 2;\n');
});

test('diff: gera diff unificado e detecta igualdade', () => {
  const kit = require('../lib/tools/devkit');
  const r = kit.run('diff', { a_text: 'um\ndois\ntres', b_text: 'um\nDOIS\ntres' }, { cwd: tmp() });
  assert.match(r, /-dois/);
  assert.match(r, /\+DOIS/);
  assert.match(kit.run('diff', { a_text: 'igual', b_text: 'igual' }, { cwd: tmp() }), /Sem diferenças/);
});

test('json_query: consulta arquivo e inline, bloqueia escape', () => {
  const kit = require('../lib/tools/devkit');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'p.json'), JSON.stringify({ items: [1, 2, 3], user: { name: 'Rê' } }));
  assert.strictEqual(kit.run('json_query', { file: 'p.json', query: 'data.items.length' }, { cwd: d }), '3');
  assert.strictEqual(kit.run('json_query', { json: { a: 2 }, query: 'data.a * 10' }, { cwd: d }), '20');
  assert.throws(() => kit.run('json_query', { json: {}, query: 'require("fs")' }, { cwd: d }), /não permitida/);
});

test('hash: checksum de texto e arquivo', () => {
  const kit = require('../lib/tools/devkit');
  const d = tmp();
  assert.match(kit.run('hash', { text: 'abc' }, { cwd: d }), /sha256: ba7816bf/);
  fs.writeFileSync(path.join(d, 'f.bin'), 'abc');
  assert.match(kit.run('hash', { file: 'f.bin', algorithm: 'md5' }, { cwd: d }), /md5: 900150983cd24fb0/);
});

test('bench: mede um comando rápido e exige aprovação', () => {
  const kit = require('../lib/tools/devkit');
  assert.strictEqual(kit.needsApproval('bench', {}), true);
  const r = kit.run('bench', { command: process.platform === 'win32' ? 'echo ok' : 'true', runs: 3 }, { cwd: tmp() });
  assert.match(r, /3 execuções/);
  assert.match(r, /mediana/);
});

test('archive: zip e unzip com proteção de caminho', () => {
  const arc = require('../lib/tools/archive');
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'a.txt'), 'conteudo A');
  fs.writeFileSync(path.join(d, 'src', 'b.txt'), 'conteudo B');
  assert.match(arc.run('archive', { action: 'zip', dir: 'src', out: 'pac.zip' }, { cwd: d }), /2 arquivo/);
  assert.ok(fs.existsSync(path.join(d, 'pac.zip')));
  arc.run('archive', { action: 'unzip', file: 'pac.zip', dir: 'saida' }, { cwd: d });
  assert.strictEqual(fs.readFileSync(path.join(d, 'saida', 'a.txt'), 'utf8'), 'conteudo A');
  assert.strictEqual(arc.needsApproval(), true);
});

test('serve: start devolve URL acessível e stop encerra', async () => {
  const srv = require('../lib/tools/serve');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'index.html'), '<h1>ola rfcode</h1>');
  assert.strictEqual(srv.needsApproval('serve', { action: 'start' }), true);
  assert.strictEqual(srv.needsApproval('serve', { action: 'stop' }), false);
  const port = 8099;
  const msg = await srv.run('serve', { action: 'start', dir: '.', port }, { cwd: d });
  assert.match(msg, new RegExp(`127\\.0\\.0\\.1:${port}`));
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(s)); }).on('error', reject);
  });
  assert.match(body, /ola rfcode/);
  assert.match(srv.run('serve', { action: 'stop', port }, {}), /encerrado/);
});
