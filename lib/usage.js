'use strict';
// Uso de tokens: uma linha por chamada ao modelo em ~/.rfcode/logs/uso-AAAA-MM.jsonl, e o resumo do /uso
// (hoje, últimos 7 dias, mês; por modelo e por pasta). Serve para controlar custo e limites dos provedores.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = () => path.join(process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode'), 'logs');

function recordUsage({ model, cwd, prompt = 0, completion = 0, estimated = false }) {
  if (process.env.NODE_TEST_CONTEXT || process.env.RFCODE_NO_LOG) return;
  if (!prompt && !completion) return;
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), model, cwd, prompt, completion, ...(estimated ? { estimated: true } : {}) });
    fs.appendFileSync(path.join(DIR(), `uso-${new Date().toISOString().slice(0, 7)}.jsonl`), line + '\n');
  } catch { /* contagem nunca derruba o agente */ }
}

function readUsage(months = 2) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < months; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1).toISOString().slice(0, 7);
    try {
      for (const l of fs.readFileSync(path.join(DIR(), `uso-${m}.jsonl`), 'utf8').split('\n')) if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* linha ruim */ } }
    } catch { /* mês sem uso */ }
  }
  return out;
}

const fmt = (n) => Math.round(n).toLocaleString('pt-BR');
function usageSummary({ now = new Date() } = {}) {
  const all = readUsage(2);
  if (!all.length) return 'Ainda não há uso registrado.';
  const day = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const month = now.toISOString().slice(0, 7);
  const sum = (list) => list.reduce((a, r) => ({ p: a.p + (r.prompt || 0), c: a.c + (r.completion || 0), n: a.n + 1 }), { p: 0, c: 0, n: 0 });
  const line = (label, list) => { const s = sum(list); return `${label.padEnd(16)} ${fmt(s.p + s.c).padStart(12)} tokens  (${fmt(s.p)} enviados, ${fmt(s.c)} gerados, ${s.n} chamadas)`; };
  const thisMonth = all.filter((r) => r.ts.startsWith(month));
  const by = (key) => {
    const g = new Map();
    for (const r of thisMonth) { const k = r[key] || '-'; const s = g.get(k) || { p: 0, c: 0 }; s.p += r.prompt || 0; s.c += r.completion || 0; g.set(k, s); }
    return [...g.entries()].sort((a, b) => (b[1].p + b[1].c) - (a[1].p + a[1].c)).slice(0, 8).map(([k, s]) => `  ${fmt(s.p + s.c).padStart(12)}  ${key === 'cwd' ? k : k}`).join('\n');
  };
  return [line('Hoje', all.filter((r) => r.ts.startsWith(day))), line('Últimos 7 dias', all.filter((r) => r.ts >= weekAgo)), line('Este mês', thisMonth),
    '', 'Por modelo (mês):', by('model'), '', 'Por pasta (mês):', by('cwd'),
    '', 'Provedores gratuitos têm limites por minuto e por dia; pagos cobram por token. Detalhes em ~/.rfcode/logs/uso-*.jsonl'].join('\n');
}

module.exports = { recordUsage, readUsage, usageSummary };
