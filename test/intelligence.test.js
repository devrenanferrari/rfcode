'use strict';
// Pacote de inteligência: cérebro do projeto (aprendizado entre sessões), raciocínio (think/self_check)
// e pesquisa profunda (deep_research).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-iq-'));

test('cérebro: aprende, injeta no brief, recupera por relevância e esquece', () => {
  const brain = require('../lib/brain');
  const d = tmp();
  assert.strictEqual(brain.brief(d), '');
  brain.learn(d, { text: 'Os testes rodam com npm test (node --test)', tags: ['testes', 'build'] });
  brain.learn(d, { text: 'A autenticação fica em lib/auth e usa JWT', tags: ['auth'] });
  // persistiu em .rfcode/brain.json
  assert.ok(fs.existsSync(path.join(d, '.rfcode', 'brain.json')));
  // brief traz os fatos para o prompt
  assert.match(brain.brief(d), /npm test/);
  // recall por relevância: a consulta sobre teste deve priorizar o fato de teste
  const r = brain.recall(d, { query: 'como rodar os testes' });
  assert.ok(r.length >= 1 && /npm test/.test(r[0].text));
  // não duplica e reforça
  const again = brain.learn(d, { text: 'Os testes rodam com npm test (node --test)' });
  assert.match(again, /reforçado/i);
  // não guarda segredos
  assert.throws(() => brain.learn(d, { text: 'o token é api_key=abc123' }), /segredo/i);
  // esquece
  brain.forget(d, { query: 'autenticação' });
  assert.strictEqual(brain.recall(d, { query: 'autenticação JWT' }).length, 0);
});

test('cérebro (ferramenta): learn/recall e sem aprovação', () => {
  const tool = require('../lib/tools/brain');
  const d = tmp();
  assert.strictEqual(tool.needsApproval(), false);
  assert.match(tool.run('learn', { text: 'build com npm run build' }, { cwd: d }), /Aprendido/);
  assert.match(tool.run('recall', { query: 'build' }, { cwd: d }), /npm run build/);
  assert.match(tool.run('recall', {}, { cwd: tmp() }), /vazio/);
});

test('think e self_check: puros, sem aprovação, com validação', () => {
  const tool = require('../lib/tools/think');
  assert.strictEqual(tool.needsApproval(), false);
  assert.throws(() => tool.run('think', {}), /raciocínio/);
  const t = tool.run('think', { thought: 'duas abordagens', options: ['A', 'B'], risks: ['perf'], decision: 'A por X' });
  assert.match(t, /Decisão: A por X/);
  assert.match(t, /execute a decisão/i);
  assert.throws(() => tool.run('self_check', {}), /goal|criteria/);
  assert.match(tool.run('self_check', { goal: 'passar nos testes', criteria: ['build ok', 'lint ok'] }), /\[ \] build ok/);
});

test('deep_research: dispara várias buscas, deduplica por URL e limita por domínio', async () => {
  const websearch = require('../lib/websearch');
  const orig = websearch.webSearch;
  const calls = [];
  websearch.webSearch = async (q) => {
    calls.push(q);
    // mesma URL aparece em duas buscas (deve deduplicar e somar relevância); 4 do mesmo domínio (deve limitar a 3)
    return [
      { title: 'Doc oficial', url: 'https://ex.com/a', snippet: 'intro' },
      { title: 'Guia', url: `https://ex.com/${q.length}`, snippet: 'guia' },
      { title: 'Outro', url: `https://ex.com/x${q.length}`, snippet: '' },
      { title: 'Blog', url: `https://blog.dev/${q.length}`, snippet: 'post' },
    ];
  };
  try {
    const research = require('../lib/tools/research');
    const out = await research.run('deep_research', { question: 'como usar X', per_query: 4, max_sources: 10 }, {});
    assert.ok(calls.length >= 2, 'rodou várias subconsultas');
    assert.match(out, /Dossiê sobre: "como usar X"/);
    assert.match(out, /ex\.com\/a/);
    assert.match(out, /relevante em \d+ buscas/); // a URL repetida foi contada
    // no máximo 3 links do domínio ex.com
    const exCount = (out.match(/https:\/\/ex\.com\//g) || []).length;
    assert.ok(exCount <= 3, `limite por domínio respeitado (${exCount})`);
  } finally {
    websearch.webSearch = orig;
  }
});

test('compute: contas exatas, ajudas, data e bloqueio de escape', () => {
  const tool = require('../lib/tools/compute');
  assert.strictEqual(tool.needsApproval(), false);
  assert.strictEqual(tool.run('compute', { expression: '2 + 3 * 4' }), '14');
  assert.strictEqual(tool.run('compute', { expression: 'sum(data)', data: [10, 20, 30.5] }), '60.5');
  assert.strictEqual(tool.run('compute', { expression: 'round(avg(data), 2)', data: [1, 2, 4] }), '2.33');
  assert.strictEqual(tool.run('compute', { expression: "daysBetween('2026-01-01','2026-01-31')" }), '30');
  // objeto sai como JSON
  assert.match(tool.run('compute', { expression: '({a: 1+1, b: max(data)})', data: [3, 9, 5] }), /"b": 9/);
  // validação e sandbox
  assert.throws(() => tool.run('compute', { expression: '' }), /expressão/);
  assert.throws(() => tool.run('compute', { expression: 'require("fs")' }), /não permitida/);
  assert.throws(() => tool.run('compute', { expression: 'process.exit(1)' }), /não permitida/);
  assert.throws(() => tool.run('compute', { expression: 'while(true){}' }), /não permitida/);
});

test('deep_research: valida pergunta vazia e trata buscas sem retorno', async () => {
  const research = require('../lib/tools/research');
  await assert.rejects(() => research.run('deep_research', { question: '' }, {}), /pergunta/);
  const websearch = require('../lib/websearch');
  const orig = websearch.webSearch;
  websearch.webSearch = async () => [];
  try {
    const out = await research.run('deep_research', { question: 'xyz' }, {});
    assert.match(out, /não trouxe resultados/);
  } finally { websearch.webSearch = orig; }
});
