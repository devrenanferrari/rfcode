'use strict';
// Cérebro do projeto: o que o rfcode descobre SOZINHO sobre cada projeto (como buildar, onde fica cada coisa,
// armadilhas, decisões, correções de bugs) fica em .rfcode/brain.json na pasta do projeto e volta nas próximas
// conversas. É diferente de:
//   - MEMORIA.md (preferências do USUÁRIO, via remember), e
//   - RFCODE.md (instruções escritas por uma PESSOA).
// Aqui é a memória de longo prazo do agente sobre o código: ele aprende com o tempo e fica mais eficiente.

const fs = require('fs');
const path = require('path');

const MAX_FACTS = 300; // teto de fatos guardados por projeto
const INJECT_CHARS = 2600; // teto do que entra no prompt
const STOP = new Set(('a o as os de do da das dos e ou que para por com sem no na nos nas um uma the to of in on for and or is are com que qual onde como'.split(' ')));

function fileFor(cwd) { return path.join(cwd || process.cwd(), '.rfcode', 'brain.json'); }

function load(cwd) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(cwd), 'utf8'));
    return Array.isArray(data.facts) ? data : { facts: [] };
  } catch { return { facts: [] }; }
}

function save(cwd, data) {
  const f = fileFor(cwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // mantém só os mais recentes se passar do teto
  if (data.facts.length > MAX_FACTS) data.facts = data.facts.slice(-MAX_FACTS);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

function words(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_.]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

// Grava um fato aprendido. tags ajuda a recuperar depois. Não duplica texto idêntico (atualiza a data e os hits).
// outcome: 'ok' (funcionou), 'avoid' (deu errado, evite) ou null. weight: força do fato (plasticidade).
function learn(cwd, { text, tags, outcome = null, weight } = {}) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('Informe o que aprendeu (text).');
  if (/(senha|password|secret|token|api[_-]?key|bearer|x-api-key|-----BEGIN)/i.test(line)) {
    throw new Error('Não guarde segredos no cérebro (senhas, tokens, chaves). Guarde só a instrução de onde obtê-los.');
  }
  const data = load(cwd);
  const tagArr = (Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/)).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const w = Math.max(0.1, Math.min(5, Number(weight) || 1));
  const dup = data.facts.find((f) => f.text.toLowerCase() === line.toLowerCase());
  if (dup) {
    dup.ts = Date.now(); dup.hits = (dup.hits || 0) + 1;
    dup.weight = Math.min(5, (dup.weight || 1) + 0.5); // reencontrar um fato o fortalece
    if (outcome) dup.outcome = outcome;
    if (tagArr.length) dup.tags = [...new Set([...(dup.tags || []), ...tagArr])];
    save(cwd, data); return `Já sabia; reforçado (peso ${dup.weight.toFixed(1)}): ${line}`;
  }
  data.facts.push({ id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: line, tags: tagArr, ts: Date.now(), hits: 0, weight: w, outcome });
  save(cwd, data);
  return `Aprendido sobre o projeto${outcome === 'avoid' ? ' (o que evitar)' : ''}: ${line}`;
}

// Reforço dependente de experiência: fortalece (delta > 0) ou enfraquece (delta < 0) os fatos relevantes
// a uma consulta. É o "ajuste sináptico": o que ajudou de novo sobe; o que enganou desce (e some se zerar).
function reinforce(cwd, { query, delta = 0.5 } = {}) {
  const qWords = words(query);
  if (!qWords.length) throw new Error('Informe query (o assunto a reforçar/enfraquecer).');
  const data = load(cwd);
  let touched = 0;
  for (const f of data.facts) {
    if (overlapOf(f, qWords) <= 0) continue;
    f.weight = Math.max(0, Math.min(5, (f.weight || 1) + Number(delta)));
    touched += 1;
  }
  const before = data.facts.length;
  data.facts = data.facts.filter((f) => (f.weight ?? 1) > 0.05); // esquece o que foi zerado por mau resultado
  save(cwd, data);
  const pruned = before - data.facts.length;
  return `Reforço aplicado (${delta > 0 ? '+' : ''}${delta}) em ${touched} fato(s) sobre "${query}"${pruned ? `; ${pruned} esquecido(s) por peso baixo` : ''}.`;
}

// Sobreposição de palavras/tags entre a consulta e o fato (quantos termos batem).
function overlapOf(fact, qWords) {
  const fWords = new Set([...words(fact.text), ...(fact.tags || [])]);
  let n = 0;
  for (const w of qWords) if (fWords.has(w)) n += 1;
  return n;
}

// Pontua um fato que JÁ bateu na consulta: sobreposição manda; peso (reforço), recência e hits ajustam.
function score(fact, qWords) {
  const ageDays = (Date.now() - (fact.ts || 0)) / 86400000;
  const recency = Math.max(0, 1 - ageDays / 180); // decai em ~6 meses
  return overlapOf(fact, qWords) * 10 + ((fact.weight || 1) - 1) * 4 + (fact.hits || 0) * 2 + recency;
}

// Recupera os fatos mais relevantes para uma consulta (ou os mais recentes, se não houver consulta).
// Com consulta, só entram fatos com pelo menos um termo em comum (recência não cria relevância do nada).
function recall(cwd, { query, limit = 8 } = {}) {
  const data = load(cwd);
  if (!data.facts.length) return [];
  const qWords = words(query);
  const ranked = data.facts.map((f) => ({ f, s: query ? score(f, qWords) : (f.ts || 0), o: query ? overlapOf(f, qWords) : 1 }))
    .filter((x) => (query ? x.o > 0 : true))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(1, Math.min(30, limit)))
    .map((x) => x.f);
  // marca que foram usados (sobe o hits dos recuperados por consulta)
  if (query && ranked.length) { const ids = new Set(ranked.map((f) => f.id)); for (const f of data.facts) if (ids.has(f.id)) f.hits = (f.hits || 0) + 1; save(cwd, data); }
  return ranked;
}

function forget(cwd, { query } = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) throw new Error('Informe o trecho a esquecer (query).');
  const data = load(cwd);
  const before = data.facts.length;
  data.facts = data.facts.filter((f) => !(f.text.toLowerCase().includes(q) || (f.tags || []).some((t) => t.includes(q))));
  save(cwd, data);
  return `Esquecido do cérebro: ${before - data.facts.length} fato(s).`;
}

// Texto para injetar no system prompt: os fatos mais recentes/úteis, limitado por tamanho.
function brief(cwd) {
  const data = load(cwd);
  if (!data.facts.length) return '';
  // prioriza por peso (reforço) e recência/uso: o que mais ajudou fica à vista no prompt
  const rank = (f) => (f.ts || 0) + (f.hits || 0) * 8.64e7 + ((f.weight || 1) - 1) * 3 * 8.64e7;
  const top = [...data.facts].sort((a, b) => rank(b) - rank(a));
  const lines = [];
  let total = 0;
  for (const f of top) {
    const mark = f.outcome === 'avoid' ? 'EVITE: ' : '';
    const line = `- ${mark}${f.text}${(f.tags || []).length ? ` [${f.tags.join(', ')}]` : ''}`;
    if (total + line.length > INJECT_CHARS) break;
    lines.push(line); total += line.length + 1;
  }
  return lines.join('\n');
}

module.exports = { learn, recall, reinforce, forget, brief, load, fileFor, _test: { words, score, overlapOf } };
