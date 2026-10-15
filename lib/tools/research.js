'use strict';
// Pesquisa profunda: dispara várias buscas na web (ângulos diferentes da mesma pergunta), junta e deduplica
// os resultados por domínio/URL, e devolve um dossiê com fontes numeradas. O modelo então sintetiza e, se quiser
// o conteúdo inteiro de uma fonte, usa web_fetch. Reusa o mecanismo de busca do rfcode (sem chave obrigatória).

const websearch = require('../websearch');

function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

async function deepResearch(a, { signal } = {}) {
  const question = String(a.question || '').trim();
  if (!question) throw new Error('Informe a pergunta (question).');
  // Subconsultas: as que o modelo mandou, ou derivadas da pergunta.
  let queries = Array.isArray(a.queries) ? a.queries.map((q) => String(q).trim()).filter(Boolean) : [];
  if (!queries.length) {
    queries = [question, `${question} tutorial`, `${question} exemplo`, `${question} melhores práticas`, `${question} comparação`];
  }
  queries = [...new Set(queries)].slice(0, 6);
  const perQuery = Math.max(3, Math.min(8, Number(a.per_query) || 6));

  const settled = await Promise.allSettled(queries.map((q) => websearch.webSearch(q, { max: perQuery, signal })));
  const byUrl = new Map();
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') { errors.push(queries[i]); return; }
    for (const item of r.value || []) {
      if (!item || !item.url) continue;
      const key = item.url.split('#')[0];
      const prev = byUrl.get(key);
      if (prev) { prev.n += 1; if (!prev.snippet && item.snippet) prev.snippet = item.snippet; }
      else byUrl.set(key, { title: item.title || key, url: key, snippet: item.snippet || '', n: 1, q: queries[i] });
    }
  });

  const results = [...byUrl.values()];
  if (!results.length) {
    return `A pesquisa profunda sobre "${question}" não trouxe resultados agora (os buscadores podem estar limitando). `
      + `Tente web_fetch numa fonte específica ou abra pelo navegador.`;
  }
  // Ranqueia: aparecer em mais subconsultas (n) e ter snippet conta mais; diversifica por domínio.
  results.sort((x, y) => (y.n - x.n) || (y.snippet.length - x.snippet.length));
  const seenHost = new Map();
  const picked = [];
  for (const r of results) {
    const h = host(r.url);
    const c = seenHost.get(h) || 0;
    if (c >= 3) continue; // no máximo 3 links por domínio
    seenHost.set(h, c + 1);
    picked.push(r);
    if (picked.length >= (Number(a.max_sources) || 12)) break;
  }

  const body = picked.map((r, i) => `${i + 1}. ${r.title}${r.n > 1 ? ` (relevante em ${r.n} buscas)` : ''}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
  const head = `Dossiê sobre: "${question}"\nSubconsultas: ${queries.join(' | ')}\nFontes únicas encontradas: ${results.length} (mostrando ${picked.length})`;
  const tail = `\n\nSintetize a resposta citando as fontes pelo número. Para ler uma fonte por inteiro, use web_fetch (página simples) ou browser open (site dinâmico).`
    + (errors.length ? `\n(Buscas sem retorno: ${errors.join(' | ')})` : '');
  return `${head}\n\n${body}${tail}`;
}

module.exports = {
  defs: [{
    name: 'deep_research',
    description: 'Pesquisa profunda na web: dispara várias buscas com ângulos diferentes da mesma pergunta, junta e deduplica as fontes '
      + 'e devolve um dossiê com os melhores resultados e os links, para você sintetizar com citações. '
      + 'Use para perguntas amplas, comparações, levantamento do estado da arte ou quando uma busca só não basta. '
      + 'Passe queries para controlar os ângulos, ou deixe o rfcode derivar da pergunta. Depois use web_fetch para ler uma fonte inteira.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A pergunta central da pesquisa' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Subconsultas específicas (opcional; até 6)' },
        max_sources: { type: 'number', description: 'Máximo de fontes no dossiê (padrão 12)' },
        per_query: { type: 'number', description: 'Resultados por subconsulta (3 a 8, padrão 6)' },
      },
      required: ['question'],
    },
  }],
  run: (name, a, ctx) => deepResearch(a, ctx || {}),
  describe: (name, a) => `Pesquisa(${String(a.question || '').slice(0, 70)})`,
  needsApproval: () => false, // só lê a web (como web_search)
  group: {
    name: 'pesquisa', desc: 'pesquisa profunda na web com várias buscas e dossiê de fontes',
    hint: /\b(pesquis|investig|levantar|estado da arte|compar(ar|a[cç][aã]o)|benchmark|refer[eê]ncias|fontes|artigos?|documenta[cç][aã]o|como funciona|o que [eé])\b/i,
  },
  _test: { deepResearch, host },
};
