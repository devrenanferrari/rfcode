'use strict';
// Pesquisa na web sem chave de API (DuckDuckGo, versão HTML). Devolve título, endereço e resumo de cada resultado,
// já sem anúncios e com os links de redirecionamento trocados pelo endereço real.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

// Link do DuckDuckGo ("//duckduckgo.com/l/?uddg=<url>") -> endereço real. Anúncios (y.js) -> null.
function realUrl(href) {
  const h = decode(href);
  if (/duckduckgo\.com\/y\.js/.test(h)) return null;
  const m = /[?&]uddg=([^&]+)/.exec(h);
  const url = m ? decodeURIComponent(m[1]) : h.startsWith('//') ? 'https:' + h : h;
  return /^https?:\/\//.test(url) ? url : null;
}

function parseResults(html, max = 8) {
  const out = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const b of blocks) {
    if (/result--ad/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const url = realUrl(a[1]);
    if (!url || out.some((r) => r.url === url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    out.push({ title: decode(a[2]), url, snippet: sn ? decode(sn[1]) : '' });
    if (out.length >= max) break;
  }
  return out;
}

// Palavras da pesquisa (sem acento, 3+ letras, sem as muito comuns) para conferir se o resultado tem a ver.
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'que', 'com', 'para', 'por', 'uma', 'como', 'mais', 'dos', 'das', 'qual', 'quais', 'hoje', 'latest', 'new']);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const terms = (q) => [...new Set(norm(q).split(/[^a-z0-9.+#]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d{4}$/.test(w)))];

// Buscadores às vezes devolvem lixo para acessos automatizados (ex.: "Hatta Resorts" para "Node.js LTS").
// Fica só o que contém alguma palavra da pesquisa; se quase nada sobra, a fonte é descartada.
function relevant(query, results) {
  const t = terms(query);
  if (!t.length) return results;
  const keep = results.filter((r) => {
    const hay = norm(`${r.title} ${r.snippet} ${r.url}`);
    return t.some((w) => hay.includes(w));
  });
  return keep.length >= Math.min(2, results.length) ? keep : [];
}

function parseBing(html, max = 8) {
  const out = [];
  for (const m of String(html).matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<li class="b_algo"|$)/g)) {
    const url = bingUrl(decode(m[1]));
    if (!/^https?:\/\//.test(url) || out.some((r) => r.url === url)) continue;
    const sn = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]);
    out.push({ title: decode(m[2]), url, snippet: sn ? decode(sn[1]) : '' });
    if (out.length >= max) break;
  }
  return out;
}

// API do Brave Search (opcional, mais confiável): chave em ~/.rfcode/config.json ("searchApiKey") ou BRAVE_API_KEY.
async function braveSearch(q, key, { max, signal }) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: String(max), search_lang: 'pt-br', country: 'BR' })}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: signal || AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const j = await res.json();
  return ((j.web && j.web.results) || []).slice(0, max).map((r) => ({ title: decode(r.title), url: r.url, snippet: decode(r.description) }));
}

function configKey() {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  try {
    const os = require('os'), path = require('path'), fs = require('fs');
    const file = path.join(process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode'), 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).searchApiKey || '';
  } catch { return ''; }
}

async function webSearch(query, { max = 8, region = 'br-pt', signal, sources } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Informe o que pesquisar (query).');
  const headers = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' };
  const get = async (url) => {
    try {
      const res = await fetch(url, { headers, signal: signal || AbortSignal.timeout(20000) });
      const html = await res.text();
      // excesso de pedidos cai na página anti-robô do DuckDuckGo
      if (!res.ok || /anomaly-modal|challenge-form/i.test(html)) return null;
      return html;
    } catch { return null; }
  };
  const ddg = new URLSearchParams({ q, kl: region }).toString();
  const all = {
    brave: async () => { const k = configKey(); return k ? braveSearch(q, k, { max, signal }) : []; },
    ddg: async () => { const h = await get(`https://html.duckduckgo.com/html/?${ddg}`); return h ? parseResults(h, max) : []; },
    bing: async () => {
      const h = await get(`https://www.bing.com/search?${new URLSearchParams({ q, setlang: 'pt-br', cc: 'BR', count: String(Math.max(10, max)) })}`);
      return h ? parseBing(h, max) : [];
    },
    lite: async () => { const h = await get(`https://lite.duckduckgo.com/lite/?${ddg}`); return h ? parseLite(h, max) : []; },
    chrome: async () => chromeSearch(q, { max, region }),
  };
  for (const name of sources || ['brave', 'ddg', 'bing', 'lite', 'chrome']) {
    let r = [];
    try { r = relevant(q, await all[name]()); } catch { r = []; }
    if (r.length) return r;
  }
  return [];
}

// Link do Bing (bing.com/ck/a?...&u=a1<base64url>) -> endereço real.
function bingUrl(href) {
  const m = /[?&]u=a1([^&]+)/.exec(href || '');
  if (!m) return href;
  try { return Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return href; }
}

// Último recurso: um Chrome invisível faz a pesquisa (passa pelas verificações anti-robô). DuckDuckGo e depois Bing.
async function chromeSearch(q, { max = 8, region = 'br-pt' } = {}) {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { Browser, findChrome } = require('./browser');
  if (!findChrome()) throw new Error('A pesquisa foi bloqueada temporariamente e não há Chrome/Edge para contornar. Tente de novo em alguns segundos.');
  const b = new Browser({ port: 9800 + Math.floor(Math.random() * 150), profile: fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-search-')), headless: true });
  try {
    await b.ensure();
    await b.cdp.send('Page.navigate', { url: `https://html.duckduckgo.com/html/?${new URLSearchParams({ q, kl: region })}` });
    await b.settle(500);
    let r = parseResults(await b.eval('document.documentElement.outerHTML'), max);
    if (r.length) return r;
    await b.cdp.send('Page.navigate', { url: `https://www.bing.com/search?${new URLSearchParams({ q, setlang: 'pt-br', cc: 'BR', mkt: 'pt-BR' })}` });
    await b.settle(800);
    r = await b.eval(`[...document.querySelectorAll('li.b_algo')].map((li) => {
      const a = li.querySelector('h2 a'); const p = li.querySelector('.b_caption p, p');
      return a ? { title: (a.textContent || '').trim(), url: a.href, snippet: p ? (p.textContent || '').trim() : '' } : null;
    }).filter(Boolean)`);
    return (r || []).map((x) => ({ ...x, url: bingUrl(x.url) })).filter((x) => /^https?:/.test(x.url)).slice(0, max);
  } finally {
    await b.quit();
  }
}

// Versão "lite": tabela com <a class="result-link"> e <td class="result-snippet">.
function parseLite(html, max = 8) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class=['"]result-link|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    const url = realUrl(m[1]);
    if (!url || out.some((r) => r.url === url)) continue;
    const sn = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(m[3]);
    out.push({ title: decode(m[2]), url, snippet: sn ? decode(sn[1]) : '' });
  }
  return out;
}

function formatResults(query, results) {
  if (!results.length) {
    return `Os buscadores automáticos não devolveram resultados úteis para "${query}" agora (podem estar limitando pesquisas). `
      + `Pesquise pelo navegador: browser open https://www.google.com/search?q=${encodeURIComponent(query)}&hl=pt-BR e leia o retrato da página.`;
  }
  return `Resultados para "${query}":\n\n` + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n')
    + '\n\nPara ler um resultado inteiro, use web_fetch (página simples) ou browser open (site com login ou dinâmico).';
}

const SEARCH_TOOL_DEF = {
  name: 'web_search',
  description: 'Pesquisa na internet e devolve os melhores resultados (título, endereço e resumo). Use para fatos atuais, documentação, preços, notícias, '
    + 'vagas, tutoriais e qualquer coisa que você não saiba com certeza. Depois leia os resultados promissores com web_fetch ou browser.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'O que pesquisar (palavras-chave funcionam melhor que perguntas longas)' },
      max_results: { type: 'integer', description: 'Quantos resultados (padrão 8, máximo 15)' },
      region: { type: 'string', description: 'Região/idioma: br-pt (padrão), us-en, wt-wt (mundo)' },
    },
    required: ['query'],
  },
};

module.exports = { webSearch, chromeSearch, bingUrl, parseBing, relevant, parseResults, parseLite, formatResults, realUrl, SEARCH_TOOL_DEF };
