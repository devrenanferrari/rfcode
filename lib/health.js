'use strict';
// Saúde dos modelos, compartilhada: quando um modelo trava, some do provedor ou falha seguido, todas as sessões
// (o painel, cada caixa da orquestra, o terminal e a próxima vez que o rfcode abrir) pulam ele por um tempo,
// em vez de cada uma esperar o mesmo minuto e meio para descobrir sozinha.
// Arquivo: ~/.rfcode/modelos-saude.json  { "<modelo>": { "ate": <ms>, "motivo": "..." } }. Sem dependências.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const file = () => path.join(HOME(), 'modelos-saude.json');

// quanto tempo cada problema tira o modelo da frente
const PAUSA = {
  travou: 30 * 60 * 1000,      // aceitou o pedido e não respondeu
  sumiu: 6 * 60 * 60 * 1000,    // 404/410: saiu do catálogo
  falhou: 5 * 60 * 1000,        // erro passageiro que continuou na nova tentativa (502, conexão)
};

let cache = null; // { file, at, data }

function load() {
  const f = file();
  // outro processo (terminal, outra janela do VS Code) pode ter gravado: relê a cada 10 s
  if (cache && cache.file === f && Date.now() - cache.at < 10000) return cache.data;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { data = {}; }
  cache = { file: f, at: Date.now(), data };
  return data;
}

function save(data) {
  const now = Date.now();
  for (const [k, v] of Object.entries(data)) if (!v || !(v.ate > now)) delete data[k];
  cache = { file: file(), at: now, data };
  try {
    fs.mkdirSync(HOME(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file());
  } catch { /* sem disco: vale só para este processo */ }
}

// Até quando o modelo está fora (ms), ou 0 se está liberado.
function pausedUntil(model) {
  const e = load()[model];
  return e && e.ate > Date.now() ? e.ate : 0;
}

function pause(model, tipo, motivo = '') {
  if (!model) return;
  const ms = PAUSA[tipo] || PAUSA.falhou;
  const data = { ...load() };
  const ate = Date.now() + ms;
  if (data[model] && data[model].ate >= ate) return;
  data[model] = { ate, motivo: `${tipo}: ${String(motivo).slice(0, 160)}` };
  save(data);
}

// O modelo respondeu: volta a valer.
function ok(model) {
  const data = load();
  if (!data[model]) return;
  const next = { ...data };
  delete next[model];
  save(next);
}

function list() {
  const now = Date.now();
  return Object.entries(load()).filter(([, v]) => v && v.ate > now).map(([modelo, v]) => ({ modelo, ate: v.ate, motivo: v.motivo }));
}

function reset() { cache = null; }

module.exports = { pausedUntil, pause, ok, list, reset, PAUSA, file };
