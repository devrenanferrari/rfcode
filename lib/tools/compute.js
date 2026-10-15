'use strict';
// Cálculo determinístico: avalia uma expressão JavaScript num sandbox (sem acesso a arquivos, rede, processo
// ou require) para contas exatas, datas, estatística e transformações de dados. Modelos erram aritmética;
// aqui a conta é feita de verdade. Não altera nada: roda sem aprovação.

const vm = require('node:vm');

// Ajudas comuns disponíveis dentro da expressão.
const HELPERS = {
  sum: (a) => (Array.isArray(a) ? a.reduce((s, x) => s + Number(x), 0) : Number(a)),
  avg: (a) => (Array.isArray(a) && a.length ? a.reduce((s, x) => s + Number(x), 0) / a.length : NaN),
  min: (a) => Math.min(...[].concat(a).map(Number)),
  max: (a) => Math.max(...[].concat(a).map(Number)),
  round: (x, n = 0) => { const p = 10 ** n; return Math.round(Number(x) * p) / p; },
  range: (n, m) => (m == null ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: m - n }, (_, i) => n + i)),
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x))),
  daysBetween: (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000),
};

function compute(a) {
  const expr = String(a.expression || '').trim();
  if (!expr) throw new Error('Informe a expressão (expression).');
  // Bloqueia caminhos óbvios de escape antes de rodar (defesa extra; o sandbox já não expõe esses nomes).
  if (/\b(require|process|global|globalThis|import|eval|Function|constructor|__proto__|fetch|module|while\s*\(\s*true|for\s*\(\s*;\s*;)/.test(expr)) {
    throw new Error('Expressão não permitida (sem require/process/loops infinitos/etc). Use só matemática e transformação de dados.');
  }
  const sandbox = Object.create(null);
  // valores que o modelo quer usar na conta
  if (a.data !== undefined) sandbox.data = a.data;
  // API segura exposta
  Object.assign(sandbox, {
    Math, Number, String, Boolean, Array, Object, JSON, Date, isNaN, parseInt, parseFloat, ...HELPERS,
  });
  let result;
  try {
    // "return" permite expressões ou blocos curtos; timeout corta laços longos.
    result = vm.runInNewContext(`(()=>{ "use strict"; return (${expr}); })()`, sandbox, { timeout: 1000, displayErrors: false });
  } catch (e1) {
    try {
      result = vm.runInNewContext(`(()=>{ "use strict"; ${expr} })()`, sandbox, { timeout: 1000, displayErrors: false });
    } catch (e2) {
      throw new Error(`Erro ao calcular: ${e2.message || e1.message}`);
    }
  }
  let out;
  if (typeof result === 'object' && result !== null) out = JSON.stringify(result, null, 2);
  else out = String(result);
  if (out.length > 8000) out = `${out.slice(0, 8000)}\n... [truncado]`;
  return out;
}

module.exports = {
  defs: [{
    name: 'compute',
    description: 'Calcula uma expressão JavaScript de forma exata e determinística (sem acesso a arquivos, rede ou sistema): aritmética, '
      + 'datas, porcentagens, estatística e transformações de listas. Use sempre que precisar de uma conta precisa em vez de calcular de cabeça. '
      + 'Disponíveis: Math, Date, JSON e ajudas sum, avg, min, max, round(x,n), range(n[,m]), clamp, daysBetween(a,b). '
      + 'Passe data com os números/objetos a usar (acessível como "data" na expressão). Ex.: expression "avg(data)" com data [10,20,30].',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'A expressão a avaliar, ex.: "sum(data)*1.1" ou "daysBetween(\'2026-01-01\',\'2026-10-13\')"' },
        data: { description: 'Dados opcionais acessíveis como "data" na expressão (número, lista ou objeto)' },
      },
      required: ['expression'],
    },
  }],
  run: (name, a) => compute(a),
  describe: (name, a) => `Calcular(${String(a.expression || '').slice(0, 70)})`,
  needsApproval: () => false, // puro, sem efeitos colaterais
  _test: { compute },
};
