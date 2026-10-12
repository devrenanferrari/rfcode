'use strict';
// Anexos do chat (imagens e arquivos) no agente e nas sessões.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../lib/agent');
const { replayEvents, titleOf } = require('../lib/sessions');

const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('userContent: sem anexos devolve o texto puro', () => {
  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  assert.strictEqual(agent.userContent('olá'), 'olá');
});

test('userContent: imagem vira parte image_url com data URL', () => {
  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  const content = agent.userContent('o que tem nesta imagem?', [{ name: 'foto.png', mime: 'image/png', data: PNG_1PX }]);
  assert.ok(Array.isArray(content));
  assert.deepStrictEqual(content[0], { type: 'text', text: 'o que tem nesta imagem?' });
  assert.deepStrictEqual(content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } });
});

test('userContent: arquivo de texto é embutido; binário vira referência ao arquivo salvo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-att-'));
  try {
    const txt = path.join(dir, 'dados.csv');
    fs.writeFileSync(txt, 'a;b\n1;2\n', 'utf8');
    const bin = path.join(dir, 'app.exe');
    fs.writeFileSync(bin, Buffer.from([0x4d, 0x5a, 0x90]));
    const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
    const content = agent.userContent('analise', [
      { name: 'dados.csv', mime: 'text/csv', data: '', file: txt },
      { name: 'app.exe', mime: 'application/octet-stream', data: '', file: bin },
    ]);
    assert.ok(Array.isArray(content));
    assert.strictEqual(content[0].text, 'analise');
    assert.ok(content[1].text.includes('--- Begin file: dados.csv ---'));
    assert.ok(content[1].text.includes('a;b'));
    assert.ok(content[2].text.includes('app.exe: ' + bin));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send com anexo de imagem grava mensagem multimodal no histórico', async () => {
  global.fetch = async () => sse('recebi a imagem');
  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  await agent.send('descreva', {}, { attachments: [{ name: 'foto.png', mime: 'image/png', data: PNG_1PX }] });
  const user = agent.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user.content));
  assert.strictEqual(user.content[1].type, 'image_url');
});

test('stripImages: troca image_url por nota de texto (modelo sem visão)', () => {
  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  agent.messages.push({ role: 'user', content: agent.userContent('veja', [{ name: 'foto.png', mime: 'image/png', data: PNG_1PX }]) });
  assert.strictEqual(agent.stripImages(), true);
  const m = agent.messages[0];
  assert.strictEqual(typeof m.content, 'string');
  assert.ok(m.content.includes('veja'));
  assert.ok(m.content.includes('[Imagem anexada'));
  assert.strictEqual(agent.stripImages(), false); // já sem imagens
});

test('replayEvents e titleOf entendem mensagens multimodais', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'o que é isso?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG_1PX } }] },
    { role: 'assistant', content: 'é um pixel' },
  ];
  assert.strictEqual(titleOf(messages), 'o que é isso?');
  const ev = replayEvents(messages);
  assert.strictEqual(ev[0].type, 'user');
  assert.strictEqual(ev[0].text, 'o que é isso?');
  assert.strictEqual(ev[0].attachments.length, 1);
  assert.ok(ev[0].attachments[0].url.startsWith('data:image/png'));
});

test('fila guarda anexos junto do texto', () => {
  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  agent.queue('olha isso', [{ name: 'a.png', mime: 'image/png', data: PNG_1PX }]);
  agent.queue('só texto');
  assert.strictEqual(agent.pendingUser.length, 2);
  agent.takeQueued({});
  const m = agent.messages[0];
  assert.ok(Array.isArray(m.content));
  assert.ok(m.content[0].text.includes('olha isso'));
  assert.strictEqual(m.content[1].type, 'image_url');
});
