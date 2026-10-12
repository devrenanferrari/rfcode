'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keysStatus, formatKeysGuide, saveToolKey, NVIDIA_STEPS } = require('../lib/keys');

test('guia de chaves num PC sem nada configurado', () => {
  const s = keysStatus({}, { nvidiaKey: '' });
  assert.strictEqual(s.providers[0].id, 'nvidia');
  assert.strictEqual(s.providers[0].ready, false);
  assert.ok(s.providers.every((p) => p.local || /^https:\/\//.test(p.url)), 'todo provedor na nuvem tem link para a chave');
  assert.strictEqual(s.providers.find((p) => p.id === 'ollama').ready, null);
  assert.ok(NVIDIA_STEPS.some((st) => /settings\/api-keys/.test(st.url || '')));
  assert.ok(s.tools.find((t) => t.id === 'search').canPaste);
});

test('guia de chaves reconhece o que já está configurado', () => {
  const s = keysStatus({ keys: { groq: 'gsk_x' }, searchApiKey: 'b' }, { nvidiaKey: 'nvapi-x' });
  assert.strictEqual(s.providers.find((p) => p.id === 'nvidia').ready, true);
  assert.strictEqual(s.providers.find((p) => p.id === 'groq').ready, true);
  assert.strictEqual(s.tools.find((t) => t.id === 'search').ready, true);
  assert.match(formatKeysGuide(s), /\[ok\] Groq/);
});

test('salvar e apagar a chave de uma ferramenta', () => {
  const cfg = saveToolKey('search', 'abc', {});
  assert.strictEqual(cfg.searchApiKey, 'abc');
  assert.strictEqual(saveToolKey('search', '', cfg).searchApiKey, undefined);
  assert.throws(() => saveToolKey('github', 'x', {}));
});
