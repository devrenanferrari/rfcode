'use strict';
// Auto-reflexão no loop (aprender ao se recuperar de falha) e crystallize (procedimento -> comando reutilizável).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-al-'));

test('reflectNudge: cutuca a consolidar só na recuperação (falha -> sucesso), uma vez por turno', () => {
  const { Agent } = require('../lib/agent');
  const nudge = Agent.prototype.reflectNudge;
  const fake = () => ({ toolDefs: [{ name: 'reflect' }], hadFailure: false, learnNudged: false, learnedThisTurn: false });

  // sucesso sem falha anterior: não cutuca
  let s = fake();
  assert.strictEqual(nudge.call(s, 'run_tests', 'Resultado: PASSOU', false), 'Resultado: PASSOU');

  // falha e depois sucesso: cutuca uma vez
  s = fake();
  nudge.call(s, 'run_tests', 'Resultado: FALHOU (código 1)', false);
  assert.strictEqual(s.hadFailure, true);
  const out = nudge.call(s, 'run_command', 'tudo certo', false);
  assert.match(out, /lembrete do sistema/);
  assert.match(out, /learn|reflect/);
  // não repete no mesmo turno
  s.hadFailure = true;
  assert.ok(!/lembrete do sistema/.test(nudge.call(s, 'run_command', 'ok de novo', false)));

  // erro (flag) conta como falha
  s = fake();
  nudge.call(s, 'edit_file', 'Erro: não achei', true);
  assert.strictEqual(s.hadFailure, true);

  // se o agente já consolidou, não cutuca
  s = fake(); s.hadFailure = true;
  nudge.call(s, 'reflect', 'Consolidado', false);
  assert.strictEqual(s.learnedThisTurn, true);
  assert.ok(!/lembrete do sistema/.test(nudge.call(s, 'run_command', 'ok', false)));

  // sem a ferramenta reflect (ex.: subagente): nunca cutuca
  const sub = { toolDefs: [{ name: 'read_file' }], hadFailure: true, learnNudged: false, learnedThisTurn: false };
  assert.ok(!/lembrete/.test(nudge.call(sub, 'read_file', 'ok', false)));
});

test('crystallize: cria comando no projeto, respeita overwrite e valida nome', () => {
  const cry = require('../lib/tools/crystallize');
  const d = tmp();
  assert.strictEqual(cry.needsApproval(), true);
  assert.throws(() => cry.run('crystallize', { name: 'nome inválido!', body: 'x' }, { cwd: d }), /identificador/);
  assert.throws(() => cry.run('crystallize', { name: 'x', body: '' }, { cwd: d }), /body/);
  const r = cry.run('crystallize', { name: 'testar-arquivo', description: 'roda testes de um arquivo', body: 'Escreva e rode testes para $ARGUMENTS.' }, { cwd: d });
  assert.match(r, /\/testar-arquivo/);
  const file = path.join(d, '.rfcode', 'commands', 'testar-arquivo.md');
  assert.ok(fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^description: roda testes/);
  assert.match(content, /\$ARGUMENTS/);
  // já existe: exige overwrite
  assert.throws(() => cry.run('crystallize', { name: 'testar-arquivo', body: 'outro' }, { cwd: d }), /já existe/);
  assert.match(cry.run('crystallize', { name: 'testar-arquivo', body: 'novo corpo', overwrite: true }, { cwd: d }), /Atualizado/);
  assert.match(fs.readFileSync(file, 'utf8'), /novo corpo/);
});
