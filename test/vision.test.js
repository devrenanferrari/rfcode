'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const vm = require('vm');
const { VisionServer, askVision, buildMessages, selfSignedCert, loadOrCreateCert, pageHtml, qrTerminal, VISION_MODELS } = require('../lib/vision');

const IMG = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-visao-'));
const ok = (content) => ({ status: 200, json: { choices: [{ message: { content } }] } });

test('certificado autoassinado é X.509 válido, com os IPs e assinatura correta', () => {
  const c = selfSignedCert(['192.168.0.7', '10.0.0.2']);
  const x = new crypto.X509Certificate(c.cert);
  assert.match(x.subjectAltName, /DNS:localhost/);
  assert.match(x.subjectAltName, /IP Address:192\.168\.0\.7/);
  assert.match(x.subjectAltName, /IP Address:10\.0\.0\.2/);
  assert.ok(x.verify(x.publicKey));
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(c.key)));
  assert.ok(Date.parse(x.validTo) > Date.now() + 300 * 86400_000);
});

test('certificado é reaproveitado com os mesmos IPs e refeito quando o IP muda', () => {
  const dir = tmp();
  const a = loadOrCreateCert(['192.168.0.7'], dir);
  assert.strictEqual(loadOrCreateCert(['192.168.0.7'], dir).cert, a.cert);
  assert.notStrictEqual(loadOrCreateCert(['192.168.0.9'], dir).cert, a.cert);
});

test('buildMessages manda a imagem na última mensagem e só o texto do histórico', () => {
  const m = buildMessages({ image: IMG, question: '', history: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }, { q: 'e', a: 'f' }, { q: 'g', a: 'h' }] });
  assert.strictEqual(m[0].role, 'system');
  assert.strictEqual(m.length, 1 + 6 + 1);
  const last = m[m.length - 1];
  assert.strictEqual(last.content[1].image_url.url, IMG);
  assert.match(last.content[0].text, /pergunta/);
  assert.ok(m.slice(1, -1).every((x) => typeof x.content === 'string'));
});

test('askVision cai para o próximo modelo e para na chave recusada', async () => {
  const calls = [];
  const post = async (url, body, headers) => {
    calls.push(body.model);
    assert.strictEqual(headers.Authorization, 'Bearer nvapi-x');
    assert.match(url, /\/chat\/completions$/);
    return body.model === 'b' ? ok(' Resposta: C ') : { status: 404, json: { detail: 'not found' } };
  };
  const r = await askVision({ apiKey: 'nvapi-x', image: IMG, question: 'qual?', models: ['a', 'b', 'c'], post });
  assert.deepStrictEqual(r, { answer: 'Resposta: C', model: 'b' });
  assert.deepStrictEqual(calls, ['a', 'b']);

  await assert.rejects(askVision({ apiKey: 'x', image: IMG, models: ['a', 'b'], post: async () => ({ status: 401, json: {} }) }), /recusada/);
  await assert.rejects(askVision({ apiKey: 'x', image: IMG, models: ['a'], post: async () => ({ status: 429, json: {} }) }), /Limite/);
  await assert.rejects(askVision({ apiKey: 'x', image: 'data:text/html,oi', models: ['a'], post }), /Imagem inválida/);
  await assert.rejects(askVision({ apiKey: '', image: IMG, models: ['a'], post }), /chave/);
});

test('servidor HTTPS exige token, responde e põe o modelo que funcionou na frente', async (t) => {
  const asked = [];
  const post = async (url, body) => (body.model === VISION_MODELS[1][0] ? ok('**Resposta:** 4') : { status: 404, json: {} });
  const s = new VisionServer({ getKey: () => 'nvapi-x', certDir: tmp(), post, onAsk: (r) => asked.push(r) });
  const urls = await s.start(0);
  t.after(() => s.stop());
  assert.ok(urls[0].url.startsWith('https://'));
  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: s.port, path: p, method, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
  const page = await req('GET', '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /getUserMedia/);
  assert.strictEqual((await req('POST', '/ask', { image: IMG })).status, 401);
  const r = await req('POST', '/ask', { image: IMG, question: '2+2?' }, { 'X-RF-Token': s.token });
  const j = JSON.parse(r.body);
  assert.strictEqual(j.answer, '**Resposta:** 4');
  assert.strictEqual(j.model, VISION_MODELS[1][0]);
  assert.strictEqual(s.models[0], VISION_MODELS[1][0]);
  assert.strictEqual(asked[0].question, '2+2?');
  const e = JSON.parse((await req('POST', '/ask', { image: 'nada' }, { 'X-RF-Token': s.token })).body);
  assert.match(e.error, /Imagem inválida/);
});

test('script da página é JavaScript válido', () => {
  const html = pageHtml();
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(html, /lang="pt-BR"/);
});

test('qrTerminal desenha o código com meio-blocos', () => {
  const out = qrTerminal('https://192.168.0.7:7443/#t=abc');
  const lines = out.split('\n');
  assert.ok(lines.length > 10);
  assert.ok(lines.every((l) => l.length === lines[0].length));
  assert.match(out, /[▀▄█]/);
});

test('/visao existe só no painel, com acento e sem acento', () => {
  const { listCommands } = require('../lib/commands');
  const ui = listCommands(tmp(), 'ui').find((c) => c.name === 'visao');
  assert.ok(ui);
  assert.ok(ui.aliases.includes('visão'));
  assert.ok(!listCommands(tmp(), 'cli').some((c) => c.name === 'visao'));
});
