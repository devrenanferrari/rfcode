'use strict';
// Chamadas a APIs REST (sistemas internos, ERPs, CRMs, SaaS). Segredos entram por referência ({{NOME}}):
// o valor vem da variável de ambiente ou de "secrets" no ~/.rfcode/config.json e nunca aparece na conversa.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX = 30000;
const home = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
function secretsFromConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).secrets || {}; } catch { return {}; }
}

// troca {{NOME}} pelo segredo; guarda os valores usados para esconder na resposta
function fill(value, used) {
  if (value == null) return value;
  const cfg = secretsFromConfig();
  return String(value).replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (m, name) => {
    const v = cfg[name] ?? process.env[name];
    if (v == null || v === '') throw new Error(`Segredo {{${name}}} não configurado. Defina a variável de ambiente ${name} ou "secrets": { "${name}": "..." } em ${path.join(home(), 'config.json')}.`);
    used.add(String(v));
    return String(v);
  });
}
const redact = (text, used) => [...used].filter((v) => v.length >= 4).reduce((t, v) => t.split(v).join('***'), String(text));

async function httpRequest(a, { cwd, signal }) {
  const used = new Set();
  const method = String(a.method || 'GET').toUpperCase();
  let url = fill(a.url, used);
  if (!/^https?:\/\//i.test(url || '')) throw new Error('url deve começar com http:// ou https://');
  if (a.query && typeof a.query === 'object') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(a.query)) u.searchParams.set(k, fill(v, used));
    url = u.toString();
  }
  const headers = {};
  for (const [k, v] of Object.entries(a.headers || {})) headers[k] = fill(v, used);
  let body;
  if (a.json !== undefined) { body = fill(typeof a.json === 'string' ? a.json : JSON.stringify(a.json), used); headers['content-type'] ||= 'application/json'; }
  else if (a.body != null) body = fill(a.body, used);
  if (a.form && typeof a.form === 'object') { body = new URLSearchParams(Object.fromEntries(Object.entries(a.form).map(([k, v]) => [k, fill(v, used)]))).toString(); headers['content-type'] ||= 'application/x-www-form-urlencoded'; }
  headers['user-agent'] ||= 'rfcode';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(Number(a.timeout_ms) || 30000, 120000));
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const t0 = Date.now();
  let res;
  try { res = await fetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, signal: ctrl.signal, redirect: 'follow' }); }
  catch (e) { throw new Error(redact(`Falha na conexão: ${e.cause ? e.cause.message || e.cause.code : e.message}`, used)); }
  finally { clearTimeout(timer); }
  const ms = Date.now() - t0;
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const head = `HTTP ${res.status} ${res.statusText} (${ms} ms, ${buf.length} bytes, ${type || 'sem content-type'})`;
  const keep = ['location', 'retry-after', 'x-ratelimit-remaining', 'x-total-count', 'link', 'etag'];
  const hdrs = keep.map((k) => (res.headers.get(k) ? `${k}: ${res.headers.get(k)}` : '')).filter(Boolean).join('\n');
  if (a.save) {
    const out = path.resolve(cwd, a.save);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    return redact(`${head}\nResposta gravada em ${path.relative(cwd, out).replace(/\\/g, '/')}.${hdrs ? `\n${hdrs}` : ''}`, used);
  }
  let text;
  if (/json/.test(type)) { try { text = JSON.stringify(JSON.parse(buf.toString('utf8')), null, 2); } catch { text = buf.toString('utf8'); } }
  else if (/text|xml|html|javascript|csv/.test(type) || !type) text = buf.toString('utf8');
  else text = `(conteúdo binário; use save para gravar em arquivo)`;
  if (/html/.test(type)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ');
  if (text.length > MAX) text = `${text.slice(0, MAX)}\n... [resposta truncada; ${text.length - MAX} caracteres omitidos. Use parâmetros de paginação/filtro da API ou save]`;
  return redact(`${head}${hdrs ? `\n${hdrs}` : ''}\n\n${text}`, used);
}

module.exports = {
  defs: [{
    name: 'http_request',
    description: 'Chama APIs HTTP/REST (sistemas da empresa, ERPs, CRMs, SaaS): método, url, headers, query, json ou form, e devolve status e corpo (JSON formatado). '
      + 'Para chaves e tokens use {{NOME}} (ex.: headers: { "Authorization": "Bearer {{API_TOKEN}}" }): o valor vem da variável de ambiente ou de "secrets" no config do rfcode e nunca aparece na conversa. '
      + 'Nunca escreva um token direto nos argumentos. save grava a resposta em arquivo (PDF, imagem, CSV).',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
        url: { type: 'string' },
        headers: { type: 'object' },
        query: { type: 'object', description: 'Parâmetros de query string' },
        json: { description: 'Corpo JSON (objeto)' },
        form: { type: 'object', description: 'Corpo application/x-www-form-urlencoded' },
        body: { type: 'string', description: 'Corpo bruto (texto)' },
        save: { type: 'string', description: 'Grava a resposta neste arquivo' },
        timeout_ms: { type: 'number' },
      },
      required: ['url'],
    },
  }],
  run: (name, args, ctx) => httpRequest(args, ctx),
  describe: (name, a) => `HTTP(${String(a.method || 'GET').toUpperCase()} ${String(a.url || '').slice(0, 90)})`,
  // qualquer chamada pode enviar dados para fora: pede aprovação (libere APIs confiáveis com regras allow)
  needsApproval: () => true,
  group: {
    name: 'api', desc: 'chamadas HTTP/REST a APIs e sistemas da empresa, com segredos por referência',
    hint: /\b(api|rest|endpoint|webhook|http|requisi[cç][aã]o|token|erp|crm|sap|totvs|salesforce|hubspot|jira|zendesk|integra[cç][aã]o|integrar)\b/i,
  },
  _test: { fill, redact },
};
