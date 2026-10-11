'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// sem cor: saída previsível (e é o que acontece em pipes, arquivos e com NO_COLOR)
process.env.NO_COLOR = '1';
const { banner, logoLines, shortPath, MarkdownStream, toolLine, strip } = require('../lib/tui');

test('banner: logo de 5 linhas, versão, modelo curto e pasta', () => {
  const b = banner({ version: '9.9.9', model: 'nvidia/nemotron-3-super-120b-a12b', cwd: path.join(os.homedir(), 'proj'), memory: true });
  assert.strictEqual(logoLines().length, 5);
  assert.match(b, /rfcode v9\.9\.9/);
  assert.match(b, /modelo nemotron-3-super-120b-a12b/);
  assert.match(b, /memória ativa/);
  assert.match(b, new RegExp(`pasta\\s+~\\${path.sep}proj`));
  assert.ok(!/\x1b\[/.test(b), 'sem códigos de cor com NO_COLOR');
});

test('shortPath encurta caminhos longos mantendo o começo e o fim', () => {
  const p = ['C:', 'a', 'muito', 'longo', 'caminho', 'de', 'pastas', 'aninhadas', 'projeto'].join('\\');
  const s = shortPath(p, 30);
  assert.ok(s.length <= 32, s);
  assert.ok(s.startsWith('C:') && s.endsWith('projeto'), s);
});

test('markdown no terminal: título, lista, negrito, código e bloco', () => {
  let out = '';
  const md = new MarkdownStream((s) => { out += s; });
  md.push('## Título\nTexto com **negrito** e `codigo`.\n- item um\n1. primeiro\n```js\nconst x = 1;\n```\nfim sem quebra');
  md.flush();
  const plain = strip(out);
  assert.match(plain, /\n {2}Título\n/);
  assert.match(plain, / {2}Texto com negrito e codigo\./);
  assert.match(plain, / {2}• item um/);
  assert.match(plain, / {2}1\. primeiro/);
  assert.match(plain, /┌─ js\n {2}│ const x = 1;\n {2}└─/);
  assert.match(plain, /fim sem quebra\n$/);
});

test('toolLine separa verbo e alvo', () => {
  assert.strictEqual(strip(toolLine('Edit(src/a.js)')), '  ● Edit src/a.js');
  assert.strictEqual(strip(toolLine('Run(npm run dev) &')), '  ● Run npm run dev (segundo plano)');
});
