'use strict';
// Recursos para empresas:
// - Política gerenciada pela TI (arquivo da máquina que o usuário não sobrescreve)
// - Auditoria: cada ação do agente numa linha JSON em ~/.rfcode/logs/auditoria-AAAA-MM.jsonl
// - Hooks: comandos antes de uma ferramenta (podem bloquear), depois de editar arquivos e ao terminar a tarefa

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { redact } = require('./log');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

// ---------- política ----------
function policyFile() {
  if (process.env.RFCODE_POLICY) return process.env.RFCODE_POLICY;
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'rfcode', 'policy.json');
  if (process.platform === 'darwin') return '/Library/Application Support/rfcode/policy.json';
  return '/etc/rfcode/policy.json';
}
/**
 * { deny: [regras], disabledTools: [nomes ou grupos], allowedProviders: [ids], allowedMcpServers: [nomes],
 *   disableAutoApprove: true, audit: true, auditDir: "pasta", message: "texto mostrado ao usuário" }
 */
let cached;
function loadPolicy() {
  if (cached !== undefined && !process.env.RFCODE_POLICY_NOCACHE) return cached;
  cached = readJson(policyFile()) || null;
  return cached;
}
function resetPolicyCache() { cached = undefined; }

function toolDisabled(name, groupOf) {
  const p = loadPolicy();
  if (!p || !Array.isArray(p.disabledTools)) return false;
  return p.disabledTools.some((t) => t === name || (groupOf && t === groupOf(name)) || (t.endsWith('*') && name.startsWith(t.slice(0, -1))));
}
function providerAllowed(id) {
  const p = loadPolicy();
  return !p || !Array.isArray(p.allowedProviders) || p.allowedProviders.includes(id);
}
function mcpAllowed(name) {
  const p = loadPolicy();
  return !p || !Array.isArray(p.allowedMcpServers) || p.allowedMcpServers.includes(name);
}

// ---------- auditoria ----------
function auditEnabled() {
  const p = loadPolicy();
  if (p && p.audit === true) return true;
  const cfg = readJson(path.join(HOME(), 'config.json')) || {};
  return cfg.audit !== false && !process.env.NODE_TEST_CONTEXT && !process.env.RFCODE_NO_LOG;
}
function audit(entry) {
  if (!auditEnabled()) return;
  try {
    const p = loadPolicy();
    const dir = (p && p.auditDir) || path.join(HOME(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const month = new Date().toISOString().slice(0, 7);
    let user = '';
    try { user = os.userInfo().username; } catch { /* sem usuário */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), user, host: os.hostname(), ...entry });
    fs.appendFileSync(path.join(dir, `auditoria-${month}.jsonl`), redact(line) + '\n');
  } catch { /* auditoria nunca derruba o agente */ }
}

// ---------- hooks ----------
// settings.json (usuário e projeto): "hooks": { "preTool": [{ "match": "run_command", "command": "..." }], "postEdit": [...], "onDone": [...] }
// O comando recebe o evento em JSON na entrada padrão e nas variáveis RFCODE_TOOL, RFCODE_FILE.
// preTool que sai com código 2 bloqueia a ação (a saída de erro vira o motivo para o agente).
function loadHooks(cwd) {
  const out = { preTool: [], postEdit: [], onDone: [] };
  for (const f of [path.join(HOME(), 'settings.json'), path.join(cwd || process.cwd(), '.rfcode', 'settings.json')]) {
    const h = (readJson(f) || {}).hooks || {};
    for (const k of Object.keys(out)) for (const x of [].concat(h[k] || [])) out[k].push(typeof x === 'string' ? { command: x } : x);
  }
  const p = loadPolicy();
  if (p && p.hooks) for (const k of Object.keys(out)) for (const x of [].concat(p.hooks[k] || [])) out[k].push(typeof x === 'string' ? { command: x } : x);
  return out;
}
const matches = (pattern, name) => !pattern || pattern === '*' || String(pattern).split('|').some((p) => p === name || (p.endsWith('*') && name.startsWith(p.slice(0, -1))));

function runHook(h, event, cwd) {
  const r = spawnSync(h.command, {
    cwd, shell: true, encoding: 'utf8', input: JSON.stringify(event), timeout: (Number(h.timeout) || 60) * 1000, windowsHide: true,
    env: { ...process.env, RFCODE_TOOL: event.tool || '', RFCODE_FILE: event.file || '', RFCODE_EVENT: event.event },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 4000), err: (r.stderr || '').trim().slice(0, 2000) };
}

// devolve { block: motivo } quando algum preTool bloqueia
function preToolHooks(cwd, tool, args) {
  for (const h of loadHooks(cwd).preTool) {
    if (!matches(h.match, tool)) continue;
    const r = runHook(h, { event: 'preTool', tool, args, cwd }, cwd);
    if (r.code === 2) return { block: r.err || r.out || `bloqueado pelo hook "${h.command}"` };
  }
  return null;
}
// texto para anexar ao resultado da edição (ex.: erros do lint)
function postEditHooks(cwd, tool, file) {
  const outs = [];
  for (const h of loadHooks(cwd).postEdit) {
    if (h.files && !new RegExp(h.files).test(file)) continue;
    const r = runHook(h, { event: 'postEdit', tool, file, cwd }, cwd);
    if (r.code !== 0 || (r.out && h.showOutput)) outs.push(`[hook ${h.command} → código ${r.code}]\n${r.out}`);
  }
  return outs.join('\n');
}
function onDoneHooks(cwd, summary) {
  for (const h of loadHooks(cwd).onDone) runHook(h, { event: 'onDone', cwd, ...summary }, cwd);
}

module.exports = {
  policyFile, loadPolicy, resetPolicyCache, toolDisabled, providerAllowed, mcpAllowed,
  audit, auditEnabled, loadHooks, preToolHooks, postEditHooks, onDoneHooks,
};
