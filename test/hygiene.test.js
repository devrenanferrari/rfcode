'use strict';
// Verificações de higiene do repositório: pegam erros que os testes de comportamento não pegam.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const listJs = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
const sources = ['lib', 'bin', 'extension', 'media', 'scripts', 'test'].flatMap(listJs);

test('todos os arquivos .js têm sintaxe válida', () => {
  for (const f of sources) execFileSync(process.execPath, ['--check', path.join(root, f)]);
});

test('nenhum caractere de controle perdido no código (ex.: \\b virando backspace)', () => {
  const bad = [];
  for (const f of [...sources, 'lib/pc.ps1']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const m = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(text);
    if (m) bad.push(`${f}: caractere 0x${m[0].charCodeAt(0).toString(16)} na posição ${m.index}`);
  }
  assert.deepStrictEqual(bad, []);
});

test('lib/pc.ps1 é só ASCII (o PowerShell 5 lê sem BOM como ANSI)', () => {
  const text = fs.readFileSync(path.join(root, 'lib', 'pc.ps1'), 'utf8');
  const i = [...text].findIndex((ch) => ch.charCodeAt(0) > 127);
  assert.strictEqual(i, -1, `caractere não ASCII na posição ${i}`);
});

test('textos públicos sem travessão', () => {
  const pkg = require('../package.json');
  const fields = [pkg.displayName, pkg.description, ...pkg.contributes.commands.map((c) => c.title),
    ...Object.values(pkg.contributes.configuration.properties).map((p) => p.description)];
  for (const f of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
    if (fs.existsSync(path.join(root, f))) fields.push(fs.readFileSync(path.join(root, f), 'utf8'));
  }
  const found = fields.filter((t) => /[—–]/.test(String(t)));
  assert.deepStrictEqual(found.map((t) => String(t).slice(0, 80)), []);
});

test('versão do package.json tem entrada no CHANGELOG', () => {
  const { version } = require('../package.json');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${version.replace(/\./g, '\\.')}$`, 'm'));
});

test('todo comando da paleta está registrado na extensão', () => {
  const pkg = require('../package.json');
  const ext = fs.readFileSync(path.join(root, 'extension', 'extension.js'), 'utf8');
  const missing = pkg.contributes.commands.map((c) => c.command).filter((id) => !ext.includes(`'${id}'`));
  assert.deepStrictEqual(missing, []);
});
