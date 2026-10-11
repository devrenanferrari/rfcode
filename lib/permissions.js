'use strict';
// Regras de permissão: dispensam a aprovação para o que é seguro e repetitivo ("run_command:npm test*")
// ou bloqueiam sempre o que não deve acontecer ("run_command:rm -rf*"). Ficam em ~/.rfcode/settings.json
// e em <projeto>/.rfcode/settings.json: { "allow": [...], "deny": [...] }. deny sempre vence allow.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function loadRules(cwd) {
  const user = readJson(path.join(HOME(), 'settings.json'));
  const proj = readJson(path.join(cwd || process.cwd(), '.rfcode', 'settings.json'));
  const list = (x) => (Array.isArray(x) ? x.map(String) : []);
  // regras "deny" da política da empresa valem sempre e não podem ser liberadas por allow
  const policy = require('./enterprise').loadPolicy() || {};
  return { allow: [...list(user.allow), ...list(proj.allow)], deny: [...list(policy.deny), ...list(user.deny), ...list(proj.deny)] };
}

// "*" casa qualquer coisa sem "/", "**" casa qualquer coisa. Comparação sem diferenciar maiúsculas.
function globMatch(pattern, text) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      // "**/" também casa nenhuma pasta: "**/.env" pega o .env da raiz
      if (pattern[i + 1] === '*' && pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else if (pattern[i + 1] === '*') { re += '.*'; i++; } else re += '[^/\\\\]*';
    } else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i').test(text);
}

// O que a regra compara em cada ferramenta.
function subject(tool, args = {}) {
  if (tool === 'run_command') return String(args.command || '').trim();
  if (tool === 'web_fetch') return String(args.url || '');
  // "http_request:GET https://api.empresa.com/**" libera só leitura naquela API
  if (tool === 'http_request') return `${String(args.method || 'GET').toUpperCase()} ${args.url || ''}`;
  if (tool === 'github' || tool.startsWith('git_')) return String(args.action || '');
  if (tool === 'browser') return `${args.action || ''} ${args.url || ''}`.trim();
  if (args.path) return String(args.path).replace(/\\/g, '/').replace(/^\.\//, '');
  return '';
}

// Regra: "ferramenta" ou "ferramenta:padrão". Para comandos, "*" também casa "/" (ex.: "npm test*").
function ruleMatches(rule, tool, args) {
  const i = rule.indexOf(':');
  const rTool = (i < 0 ? rule : rule.slice(0, i)).trim();
  if (rTool !== tool && rTool !== '*') return false;
  if (i < 0) return true;
  const pat = rule.slice(i + 1).trim();
  const subj = subject(tool, args);
  return tool === 'run_command' ? globMatch(pat.replace(/\*+/g, '**'), subj) : globMatch(pat, subj);
}

// 'allow' | 'deny' | 'ask'
function decide(tool, args, rules) {
  if ((rules.deny || []).some((r) => ruleMatches(r, tool, args))) return 'deny';
  if ((rules.allow || []).some((r) => ruleMatches(r, tool, args))) return 'allow';
  return 'ask';
}

// Acrescenta uma regra "allow" no settings do usuário (botão "Sempre permitir isto").
function addAllow(rule) {
  const file = path.join(HOME(), 'settings.json');
  const cfg = readJson(file);
  cfg.allow = Array.isArray(cfg.allow) ? cfg.allow : [];
  if (!cfg.allow.includes(rule)) cfg.allow.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

// Sugestão de regra para "sempre permitir" uma chamada: comando até o 1º argumento, ou o arquivo exato.
function suggestRule(tool, args = {}) {
  if (tool === 'run_command') {
    const parts = String(args.command || '').trim().split(/\s+/);
    return `run_command:${parts.slice(0, Math.min(2, parts.length)).join(' ')}*`;
  }
  const s = subject(tool, args);
  return s ? `${tool}:${s}` : tool;
}

module.exports = { loadRules, decide, globMatch, ruleMatches, addAllow, suggestRule };
