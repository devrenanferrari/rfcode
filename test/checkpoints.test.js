'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../lib/agent');

test('undo desfaz edições e apaga arquivo criado, voltando ao estado original', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-undo-'));
  try {
    const a = new Agent({ apiKey: 'x', cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');

    a.write_file({ path: 'novo.txt', content: 'criado' });
    a.edit_file({ path: 'a.txt', old_string: 'original', new_string: 'mudado' });
    a.write_file({ path: 'a.txt', content: 'sobrescrito' });

    assert.match(a.undo(), /restaurado a\.txt/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'mudado\n');
    assert.match(a.undo(), /restaurado a\.txt/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'original\n');
    assert.match(a.undo(), /removido novo\.txt/);
    assert.ok(!fs.existsSync(path.join(dir, 'novo.txt')));
    assert.match(a.undo(), /Nenhum checkpoint/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('edição que falha não cria checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-undo-'));
  try {
    const a = new Agent({ apiKey: 'x', cwd: dir });
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    assert.throws(() => a.edit_file({ path: 'b.txt', old_string: 'nao existe', new_string: 'y' }));
    assert.match(a.undo(), /Nenhum checkpoint/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
