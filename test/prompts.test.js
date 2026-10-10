'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { WORK_STYLE, INIT_PROMPT } = require('../lib/prompts');
const { Agent } = require('../lib/agent');

test('modo de trabalho cobre os pilares do Claude Code', () => {
  for (const s of ['## Entender antes de mudar', '## Planejar', '## Editar com disciplina', '## Verificar', '## Git e ações arriscadas', '## Comunicação', '## Segurança']) {
    assert.ok(WORK_STYLE.includes(s), s);
  }
});

test('o prompt do sistema enviado ao modelo inclui o modo de trabalho', async () => {
  let body = null;
  global.fetch = async (_, o) => {
    body = JSON.parse(o.body);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\ndata: [DONE]\n\n');
  };
  await new Agent({ apiKey: 'x', cwd: os.tmpdir() }).send('oi', {});
  assert.strictEqual(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.includes('# Modo de trabalho'));
});

test('INIT_PROMPT pede as seções do RFCODE.md', () => {
  for (const s of ['## Visão geral', '## Como rodar', '## Como testar', '## Estrutura', '## Convenções']) assert.ok(INIT_PROMPT.includes(s), s);
});
