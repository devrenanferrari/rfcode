'use strict';
// Inteligência de código: símbolos em várias linguagens, imports, referências, leitura de um símbolo e busca por palavras.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const code = require('../lib/code');

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-code-'));
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  w('src/carrinho.js', "const { desconto } = require('./preco');\n\nclass Carrinho {\n  constructor() { this.itens = []; }\n  // soma os itens com desconto\n  total(pct) {\n    const bruto = this.itens.reduce((s, i) => s + i.preco, 0);\n    return desconto(bruto, pct);\n  }\n}\nmodule.exports = { Carrinho };\n");
  w('src/preco.js', "function desconto(v, pct) {\n  if (pct > 100) throw new Error('pct');\n  return v - v * pct / 100;\n}\nmodule.exports = { desconto };\n");
  w('src/index.js', "const { Carrinho } = require('./carrinho');\nconst c = new Carrinho();\nconsole.log(c.total(10));\n");
  w('app/servico.py', "from .modelos import Pedido\n\nclass Servico:\n    def criar(self, dados):\n        p = Pedido(dados)\n        return p.salvar()\n\ndef auxiliar():\n    return 1\n");
  w('app/modelos.py', "class Pedido:\n    def __init__(self, d):\n        self.d = d\n\n    def salvar(self):\n        return True\n");
  w('Api/Controller.cs', "namespace Loja {\n  public class PedidosController {\n    public async Task<IActionResult> Listar(int pagina) {\n      return Ok();\n    }\n  }\n}\n");
  w('cmd/main.go', "package main\n\ntype Servidor struct{}\n\nfunc (s *Servidor) Iniciar(porta int) error {\n\treturn nil\n}\n\nfunc main() {}\n");
  return d;
}

test('mapa de símbolos em JS, Python, C# e Go', () => {
  const d = project();
  const map = code.codeMap(d);
  assert.match(map, /src\/carrinho\.js \(\d+ l\.\): class Carrinho:3 \{ constructor:4, total:6 \}/);
  assert.match(map, /app\/servico\.py .*class Servico:3 \{ criar:4 \}, auxiliar:8/);
  assert.match(map, /Api\/Controller\.cs .*class PedidosController:2 \{ Listar:3 \}/);
  assert.match(map, /cmd\/main\.go .*Servidor:3.*Iniciar:5.*main:9/);
});

test('definição, referências, leitura de um símbolo e dependências', () => {
  const d = project();
  assert.match(code.findSymbol(d, { name: 'Carrinho.total' }), /src\/carrinho\.js:6 {2}method de Carrinho/);
  const refs = code.findReferences(d, { name: 'desconto' });
  assert.match(refs, /src\/carrinho\.js \(2\)/);
  assert.doesNotMatch(refs, /src\/preco\.js \(\d+\)\n {2}1:/, 'a definição não conta como uso');
  const body = code.readSymbol(d, { name: 'Carrinho.total' });
  assert.match(body, /src\/carrinho\.js:6-9/);
  assert.match(body, /soma os itens com desconto/, 'inclui o comentário acima');
  assert.match(code.readSymbol(d, { name: 'criar' }), /app\/servico\.py:4-6/);
  const deps = code.codeDeps(d, { path: 'src/preco.js' });
  assert.match(deps, /Usado por: src\/carrinho\.js/);
  assert.match(deps, /Impacto de mudar \(dependentes diretos e indiretos\): 2 arquivo/);
  assert.match(code.codeDeps(d, { path: 'app/servico.py' }), /Usa \(do projeto\): app\/modelos\.py/);
});

test('busca por palavras quando não há embeddings', async () => {
  const d = project();
  const r = await code.codeSearch(d, { query: 'desconto no preço', limit: 2 });
  assert.match(r, /Busca por palavras/);
  assert.match(r, /src\/preco\.js:1/);
});
