'use strict';
// Correções feitas na revisão humana das tarefas T05 e T06 do loop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandMentions } = require('../lib/mentions');
const { Agent, describeCall } = require('../lib/agent');

test('@arquivo: pontuação no fim é ignorada e menção repetida entra uma vez', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-men-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'CONTEUDO_A');
    const out = expandMentions('veja @a.js, e de novo @a.js.', dir);
    assert.strictEqual(out.split('CONTEUDO_A').length - 1, 1);
    assert.match(out, /Begin file: @a\.js ---/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('web_fetch: entidades na ordem certa e espaços juntados', async () => {
  global.fetch = async () => new Response('<html><body>\n\n  <p>a &amp;lt; b</p>\n\n\n\n<p>x&nbsp;&amp;&nbsp;y</p>   </body></html>', { status: 200 });
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  const text = await a.web_fetch({ url: 'https://exemplo.com' });
  assert.strictEqual(text, 'a &lt; b\nx & y');
});

test('web_fetch pede aprovação e tem rótulo legível', async () => {
  assert.strictEqual(describeCall('web_fetch', { url: 'https://exemplo.com' }), 'Web(https://exemplo.com)');
  const sse = (chunks) => new Response(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  const queue = [
    sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'web_fetch', arguments: '{"url":"https://exemplo.com/?s=segredo"}' } }] } }] }]),
    sse([{ choices: [{ delta: { content: 'ok' } }] }]),
  ];
  let fetchedPage = false;
  global.fetch = async (url) => {
    if (String(url).startsWith('https://exemplo.com')) { fetchedPage = true; return new Response('x'); }
    return queue.shift();
  };
  const a = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  const asked = [];
  await a.send('busque', { approve: async (i) => { asked.push(i.name); return { deny: 'não' }; } });
  assert.deepStrictEqual(asked, ['web_fetch']);
  assert.strictEqual(fetchedPage, false, 'negado não pode buscar a página');
});
