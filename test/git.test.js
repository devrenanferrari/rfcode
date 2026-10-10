'use strict';
// Exemplo de referência para testes de ferramentas novas: repositório temporário real, sem rede.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { gitStatus, gitDiff, gitLog, gitCommit } = require('../lib/git');
const { Agent } = require('../lib/agent');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  // a máquina pode não ter identidade global configurada
  g('config', 'user.name', 'rfcode-test');
  g('config', 'user.email', 'test@rfcode.local');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'linha um\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'primeiro commit');
  return dir;
}
// no Windows o git pode segurar a pasta por alguns ms; maxRetries evita EBUSY
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test('git_status, git_diff e git_log num repositório', () => {
  const dir = tmpRepo();
  try {
    assert.match(gitStatus(dir), /árvore limpa/);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'linha dois\n');
    assert.match(gitStatus(dir), /M a\.txt/);
    assert.match(gitDiff(dir), /\+linha dois/);
    assert.match(gitDiff(dir, { path: 'a.txt' }), /-linha um/);
    assert.match(gitLog(dir), /primeiro commit/);
  } finally { cleanup(dir); }
});

test('git_diff avisa sobre arquivos novos', () => {
  const dir = tmpRepo();
  try {
    fs.writeFileSync(path.join(dir, 'novo.txt'), 'x');
    assert.match(gitDiff(dir), /novo\.txt/);
  } finally { cleanup(dir); }
});

test('git_commit cria commit e rejeita mensagem vazia', () => {
  const dir = tmpRepo();
  try {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    assert.match(gitCommit(dir, { message: 'adiciona b' }), /Commit criado: \w+ adiciona b/);
    assert.match(gitLog(dir, { limit: 1 }), /adiciona b/);
    assert.throws(() => gitCommit(dir, { message: '  ' }), /vazia/);
    assert.strictEqual(gitCommit(dir, { message: 'nada' }), 'Nada para commitar.');
  } finally { cleanup(dir); }
});

test('fora de um repositório a mensagem é amigável', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-nogit-'));
  try {
    assert.throws(() => gitStatus(dir), /não é um repositório git/);
  } finally { cleanup(dir); }
});

test('ferramentas git estão no agente e git_commit pede aprovação', async () => {
  const dir = tmpRepo();
  try {
    const sse = (chunks) => new Response(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
    const queue = [
      sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'git_commit', arguments: '{"message":"via agente"}' } }] } }] }]),
      sse([{ choices: [{ delta: { content: 'ok' } }] }]),
    ];
    global.fetch = async () => queue.shift();
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c');
    const agent = new Agent({ apiKey: 'x', cwd: dir });
    const approvals = [];
    await agent.send('commita', { approve: async (i) => { approvals.push(i.label); return 'yes'; } });
    assert.deepStrictEqual(approvals, ['Git(commit "via agente")']);
    assert.match(gitLog(dir, { limit: 1 }), /via agente/);
  } finally { cleanup(dir); }
});
