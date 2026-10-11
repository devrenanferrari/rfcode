'use strict';
// Sessões salvas do rfcode: uma conversa = um arquivo em ~/.rfcode/sessions/<id>.json,
// regravado a cada resposta. Só é usado quando o Agent é criado com saveSession: true (a CLI faz isso).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function sessionsDir() {
  return path.join(process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode'), 'sessions');
}

function newId() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'); // 20261010-163000
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

// Título = começo da primeira mensagem do usuário (sem os blocos de @arquivo anexados).
function titleOf(messages) {
  const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  if (!first) return '(sem mensagens)';
  const text = first.content.split('\n--- Begin file:')[0].replace(/\s+/g, ' ').trim();
  return text.length > 70 ? text.slice(0, 70) + '…' : text;
}

class SessionManager {
  constructor({ id, cwd } = {}) {
    this.id = id || newId();
    this.cwd = cwd || process.cwd();
    this.created = new Date().toISOString();
  }

  get file() { return path.join(sessionsDir(), `${this.id}.json`); }

  save(messages) {
    if (!messages || !messages.length) return null;
    try {
      fs.mkdirSync(sessionsDir(), { recursive: true });
      const data = { id: this.id, cwd: this.cwd, created: this.created, updated: new Date().toISOString(), title: titleOf(messages), messages };
      fs.writeFileSync(this.file, JSON.stringify(data));
      return this.file;
    } catch {
      return null;
    }
  }

  // Lista as sessões (mais recentes primeiro): [{ id, file, title, cwd, updated, count }]
  list() {
    let files;
    try { files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      const file = path.join(sessionsDir(), f);
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        const messages = Array.isArray(d) ? d : d.messages || []; // aceita o formato antigo (só o array)
        out.push({
          id: d.id || f.replace(/\.json$/, ''), file, title: d.title || titleOf(messages), cwd: d.cwd || '',
          updated: d.updated || fs.statSync(file).mtime.toISOString(), count: messages.length,
        });
      } catch { /* arquivo corrompido: ignora */ }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  // Carrega as mensagens de uma sessão (por id ou caminho) e passa a gravar nela.
  load(idOrFile) {
    const file = String(idOrFile).endsWith('.json') ? idOrFile : path.join(sessionsDir(), `${idOrFile}.json`);
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      const messages = Array.isArray(d) ? d : d.messages;
      if (!Array.isArray(messages)) return null;
      this.id = d.id || path.basename(file, '.json');
      if (d.created) this.created = d.created;
      return messages;
    } catch {
      return null;
    }
  }
}

// Transforma uma conversa salva nos mesmos eventos que a interface recebe ao vivo, para reabrir
// a conversa no painel do jeito que ela aconteceu. describe/preview vêm do agent (rótulos e diffs).
function replayEvents(messages, { describe = (n) => n, preview = () => null } = {}) {
  const ev = [];
  for (const m of messages || []) {
    if (m.role === 'user' && typeof m.content === 'string') {
      ev.push({ type: 'user', text: m.content.split('\n--- Begin file:')[0].trim() });
    } else if (m.role === 'assistant') {
      if (m.content) { ev.push({ type: 'text', text: m.content }); ev.push({ type: 'assistantEnd' }); }
      for (const tc of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* argumentos quebrados: mostra sem eles */ }
        const name = tc.function.name;
        if (name === 'update_plan') {
          const steps = (Array.isArray(args.steps) ? args.steps : []).map((s) => ({ text: String(s.text || ''), status: s.status || 'pending' }));
          ev.push({ type: 'plan', plan: { goal: args.goal || '', steps, why: args.why || '' } });
          continue;
        }
        ev.push({ type: 'toolCall', id: tc.id, name, args, label: describe(name, args), preview: preview(name, args) });
      }
    } else if (m.role === 'tool') {
      const output = String(m.content || '');
      ev.push({ type: 'toolResult', id: m.tool_call_id, name: m.name, output, error: /^(Erro|O usuário NEGOU|Cancelado)/.test(output) });
    }
  }
  ev.push({ type: 'done' });
  return ev;
}

function deleteSession(id) {
  const file = path.join(sessionsDir(), `${path.basename(String(id))}.json`);
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

module.exports = { SessionManager, titleOf, sessionsDir, replayEvents, deleteSession };
