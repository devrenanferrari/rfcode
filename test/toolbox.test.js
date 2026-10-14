'use strict';
// Catálogo de ~200 CLIs e os despachantes toolbox (descobrir) e toolbox_run (executar/instalar sob demanda).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-tb-'));

test('catálogo: 200+ ferramentas, sem duplicatas, categorias rotuladas, mapas de install sãos', () => {
  const { CATALOG, CATEGORIES, find } = require('../lib/toolcatalog');
  assert.ok(CATALOG.length >= 200, `esperado >=200, veio ${CATALOG.length}`);
  const names = CATALOG.map((t) => t.n);
  assert.strictEqual(new Set(names).size, names.length, 'nomes únicos');
  for (const t of CATALOG) {
    assert.ok(t.n && t.c && t.d, `item completo: ${JSON.stringify(t)}`);
    assert.ok(CATEGORIES[t.c], `categoria rotulada: ${t.c}`);
    assert.strictEqual(typeof t.i, 'object', `mapa de install: ${t.n}`);
    assert.ok(/^[\w.+-]+$/.test(t.b || t.n), `binário seguro: ${t.n}`);
  }
  assert.ok(find('rg') && find('RG'), 'find case-insensitive');
});

test('toolbox: categorias, listagem e busca', () => {
  const tb = require('../lib/tools/toolbox');
  assert.strictEqual(tb.needsApproval('toolbox'), false);
  const cats = tb.run('toolbox', { action: 'categories' }, {});
  assert.match(cats, /categorias/);
  assert.match(cats, /seguranca/);
  const list = tb.run('toolbox', { action: 'list', category: 'dados' }, {});
  assert.match(list, /jq/);
  assert.throws(() => tb.run('toolbox', { action: 'list', category: 'xpto' }, {}), /Categoria inválida/);
  const search = tb.run('toolbox', { action: 'search', query: 'kubernetes' }, {});
  assert.match(search, /kubectl/);
  const search2 = tb.run('toolbox', { query: 'pdf' }, {}); // action implícito
  assert.match(search2, /qpdf|pdftk|gs/);
  assert.match(tb.run('toolbox', {}, {}), /categorias/); // sem nada: cai em categorias
  assert.throws(() => tb.run('toolbox', { action: 'search' }, {}), /query/); // search sem query
});

test('toolbox_run: exige aprovação, valida args e roda uma ferramenta já instalada', () => {
  const tb = require('../lib/tools/toolbox');
  assert.strictEqual(tb.needsApproval('toolbox_run'), true);
  assert.throws(() => tb.run('toolbox_run', { name: 'jq', args: 'nao-lista' }, { cwd: tmp() }), /args deve ser uma lista/);
  // node existe neste ambiente (está no catálogo): roda sem instalar
  const r = tb.run('toolbox_run', { name: 'node', args: ['-e', 'process.stdout.write("oi")'] }, { cwd: tmp() });
  assert.match(r, /oi/);
  assert.match(r, /código 0/);
  // ferramenta ausente com install:false não tenta instalar
  assert.throws(() => tb.run('toolbox_run', { name: 'radare2', args: ['-v'], install: false }, { cwd: tmp() }), /não está instalado/);
});
