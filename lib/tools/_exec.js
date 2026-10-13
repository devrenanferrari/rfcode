'use strict';
// Helpers para as ferramentas que embrulham projetos famosos do GitHub (CLIs externos):
// localizar o executável, rodar com timeout e limite de saída, e avisar como instalar quando falta.

const { spawnSync } = require('child_process');

const MAX = 24000;
const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX)}\n... [truncado, ${s.length - MAX} caracteres omitidos]` : s);

const IS_WIN = process.platform === 'win32';

// Procura um executável no PATH sem depender de "which"/"where".
function has(bin) {
  const probe = IS_WIN ? spawnSync('where', [bin], { encoding: 'utf8', windowsHide: true })
    : spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true });
  return probe.status === 0 && String(probe.stdout || '').trim() !== '';
}

// Roda um comando capturando stdout+stderr. Lança erro amigável (com dica de instalação) se o binário não existe.
function run(bin, args, { cwd, signal, input, timeout = 300000, install } = {}) {
  const r = spawnSync(bin, args, {
    cwd, input, encoding: 'utf8', windowsHide: true, timeout,
    maxBuffer: 48 * 1024 * 1024, signal,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new Error(install || `"${bin}" não encontrado no PATH.`);
    if (r.error.code === 'ETIMEDOUT') throw new Error(`"${bin}" passou do tempo limite (${Math.round(timeout / 1000)}s).`);
    throw new Error(`Falha ao executar ${bin}: ${r.error.message}`);
  }
  const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  return { code: r.status, out: cut(out) };
}

// Exige que o binário exista; senão, erro com o link do projeto no GitHub.
function need(bin, install) {
  if (!has(bin)) throw new Error(install);
  return bin;
}

module.exports = { has, run, need, cut, MAX, IS_WIN };
