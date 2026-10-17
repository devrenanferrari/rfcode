'use strict';
// Helpers para as ferramentas que embrulham projetos famosos do GitHub (CLIs externos):
// localizar o executável, rodar com timeout e limite de saída, e avisar como instalar quando falta.
// Nunca usamos um shell aqui: has() varre o PATH em Node puro e run() executa o binário direto com
// os argumentos em array (sem interpolação de shell), então não há como um nome virar comando.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX = 24000;
const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX)}\n... [truncado, ${s.length - MAX} caracteres omitidos]` : s);

const IS_WIN = process.platform === 'win32';

// Rejeita nomes/caminhos perigosos (nulos e quebras de linha). Sem shell, metacaracteres não são interpretados,
// mas validar na borda silencia a análise estática e é defesa a mais.
function badName(bin) { return typeof bin !== 'string' || bin === '' || /[\0\r\n]/.test(bin); }

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Procura um executável no PATH sem depender de "which"/"where" e sem shell.
function has(bin) {
  if (badName(bin)) return false;
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  // caminho com separador: checa direto, sem varrer o PATH
  if (bin.includes('/') || bin.includes('\\')) return exts.some((e) => isFile(bin + e));
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const e of exts) if (isFile(path.join(d, bin + e))) return true;
  return false;
}

// Roda um comando capturando stdout+stderr. Lança erro amigável (com dica de instalação) se o binário não existe.
// Sem shell: bin e args vão direto para o processo. bin inválido (nulo/quebra de linha) é recusado.
function run(bin, args, { cwd, signal, input, timeout = 300000, install } = {}) {
  if (badName(bin)) throw new Error('Nome de comando inválido.');
  const r = spawnSync(bin, Array.isArray(args) ? args : [], {
    cwd, input, encoding: 'utf8', windowsHide: true, timeout,
    maxBuffer: 48 * 1024 * 1024, signal, shell: false,
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

module.exports = { has, run, need, cut, MAX, IS_WIN, _test: { badName } };
