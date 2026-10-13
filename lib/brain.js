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
function learn(cwd, { text, tags } = {}) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('Informe o que aprendeu (text).');
  if (/(senha|password|secret|token|api[_-]?key|bearer|x-api-key|-----BEGIN)/i.test(line)) {
    throw new Error('Não guarde segredos no cérebro (senhas, tokens, chaves). Guarde só a instrução de onde obtê-los.');
  }
  const data = load(cwd);
  const tagArr = (Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/)).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const dup = data.facts.find((f) => f.text.toLowerCase() === line.toLowerCase());
  if (dup) { dup.ts = Date.now(); dup.hits = (dup.hits || 0) + 1; if (tagArr.length) dup.tags = [...new Set([...(dup.tags || []), ...tagArr])]; save(cwd, data); return `Já sabia; reforçado: ${line}`; }
  data.facts.push({ id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: line, tags: tagArr, ts: Date.now(), hits: 0 });
  save(cwd, data);
  return `Aprendido sobre o projeto: ${line}`;
}

// Sobreposição de palavras/tags entre a consulta e o fato (quantos termos batem).
function overlapOf(fact, qWords) {
  const fWords = new Set([...words(fact.text), ...(fact.tags || [])]);
  let n = 0;
  for (const w of qWords) if (fWords.has(w)) n += 1;
  return n;
}

// Pontua um fato que JÁ bateu na consulta: sobreposição manda; recência e hits são só desempate.
function score(fact, qWords) {
  const ageDays = (Date.now() - (fact.ts || 0)) / 86400000;
  const recency = Math.max(0, 1 - ageDays / 180); // decai em ~6 meses
  return overlapOf(fact, qWords) * 10 + (fact.hits || 0) * 2 + recency;
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
  const top = [...data.facts].sort((a, b) => ((b.ts || 0) + (b.hits || 0) * 8.64e7) - ((a.ts || 0) + (a.hits || 0) * 8.64e7));
  const lines = [];
  let total = 0;
  for (const f of top) {
    const line = `- ${f.text}${(f.tags || []).length ? ` [${f.tags.join(', ')}]` : ''}`;
    if (total + line.length > INJECT_CHARS) break;
    lines.push(line); total += line.length + 1;
  }
  return lines.join('\n');
}

module.exports = { learn, recall, forget, brief, load, fileFor, _test: { words, score } };
