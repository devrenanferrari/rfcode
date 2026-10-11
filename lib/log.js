'use strict';
// Log de erros e eventos importantes em ~/.rfcode/logs/rfcode.log, para diagnosticar problemas
// (o usuário pode anexar o arquivo ao abrir uma issue). Gira ao passar de 1 MB e nunca grava chaves.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const dir = () => path.join(process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode'), 'logs');
const file = () => path.join(dir(), 'rfcode.log');

// Esconde chaves de API conhecidas (nvapi-, sk-, gsk_, AIza, Bearer ...).
function redact(text) {
  return String(text)
    .replace(/\b(nvapi-|sk-ant-|sk-or-|sk-|gsk_|AIza)[A-Za-z0-9_\-]{8,}/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

function write(level, scope, msg) {
  // NODE_TEST_CONTEXT: rodando dentro do node --test (os testes não sujam o log de quem desenvolve)
  if (process.env.RFCODE_NO_LOG || process.env.NODE_TEST_CONTEXT) return;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    try {
      if (fs.statSync(file()).size > MAX_BYTES) fs.renameSync(file(), file() + '.1');
    } catch { /* ainda não existe */ }
    const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${redact(msg).replace(/\r?\n/g, ' | ')}\n`;
    fs.appendFileSync(file(), line);
  } catch { /* log nunca derruba o programa */ }
}

const log = {
  error: (scope, msg) => write('ERROR', scope, msg),
  warn: (scope, msg) => write('WARN', scope, msg),
  info: (scope, msg) => write('INFO', scope, msg),
  file,
  redact,
  // últimas n linhas (para o /doctor e para anexar em issues)
  tail(n = 40) {
    try { return fs.readFileSync(file(), 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
  },
};

module.exports = log;
