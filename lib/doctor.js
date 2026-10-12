'use strict';
// /doctor: verifica o ambiente do rfcode e aponta o que falta. Usado no suporte ("rode /doctor e cole o resultado").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const providers = require('./providers');
const log = require('./log');

const has = (cmd, args = ['--version']) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 8000 }).trim().split('\n')[0]; } catch { return ''; }
};

// Cada item: { name, status: 'ok' | 'warn' | 'fail', detail }
async function runDoctor({ cfg = {}, model, version, home } = {}) {
  const items = [];
  const add = (name, status, detail) => items.push({ name, status, detail });

  add('rfcode', 'ok', `versão ${version || '?'}`);
  const nodeMajor = +process.versions.node.split('.')[0];
  add('Node.js', nodeMajor >= 22 ? 'ok' : 'warn', `${process.versions.node}${nodeMajor >= 22 ? '' : ' (o navegador e a pesquisa pelo Chrome precisam do Node 22 ou superior)'}`);
  add('Sistema', 'ok', `${os.type()} ${os.release()} (${process.arch})`);

  // modelo atual e provedores
  const spec = model || cfg.model || providers.DEFAULT_MODEL;
  if (spec === providers.AUTO) {
    const list = providers.autoCandidates(cfg);
    add('Modelo', list.length ? 'ok' : 'fail', list.length ? `auto (${list.length} candidatos: ${list.slice(0, 4).join(', ')}${list.length > 4 ? '...' : ''})` : 'auto, mas nenhum provedor tem chave (use /provider)');
  } else {
    const { provider, model: modelId } = providers.parseModel(spec);
    const p = providers.PROVIDERS[provider];
    const key = providers.keyFor(provider, cfg);
    add('Modelo', p.needsKey === false || key ? 'ok' : 'fail', `${modelId} em ${p.name}${p.needsKey === false || key ? '' : ' (sem API key: use /provider ' + provider + ')'}`);
  }

  const configured = Object.keys(providers.PROVIDERS).filter((id) => providers.PROVIDERS[id].needsKey !== false && providers.keyFor(id, cfg));
  const checks = await Promise.all(configured.map(async (id) => [id, await providers.validateKey(id, providers.keyFor(id, cfg), cfg)]));
  for (const [id, r] of checks) {
    add(`Chave ${providers.PROVIDERS[id].name}`, r === 'ok' ? 'ok' : r === 'invalid' ? 'fail' : 'warn',
      r === 'ok' ? 'aceita' : r === 'invalid' ? 'recusada pelo provedor' : 'sem conexão para verificar');
  }
  const local = await providers.detectLocal();
  add('Modelos locais', local.length ? 'ok' : 'warn', local.length
    ? local.map((l) => `${providers.PROVIDERS[l.provider].name}: ${l.models.length} modelo(s)`).join('; ')
    : 'Ollama e LM Studio não estão rodando (opcional)');

  // ferramentas externas
  const git = has('git');
  add('git', git ? 'ok' : 'warn', git || 'não encontrado (ferramentas de git e /review ficam indisponíveis)');
  const { findChrome } = require('./browser');
  const chrome = findChrome();
  add('Chrome/Edge', chrome ? 'ok' : 'warn', chrome || 'não encontrado (navegador, vídeo e parte da pesquisa ficam indisponíveis)');
  const ffmpeg = has('ffmpeg', ['-version']);
  add('ffmpeg', ffmpeg ? 'ok' : 'warn', ffmpeg ? ffmpeg.split(' ').slice(0, 3).join(' ') : 'não encontrado (vídeos saem em WebM; opcional)');
  if (process.platform === 'win32') {
    const voices = has('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; ((New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Culture.Name }) -join ","']);
    add('Voz pt-BR', /pt-BR/i.test(voices) ? 'ok' : 'warn', /pt-BR/i.test(voices) ? 'disponível para narração' : 'não instalada (narração usa outra voz)');
  }

  // arquivos do usuário
  const base = home || process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
  const exists = (f) => fs.existsSync(path.join(base, f));
  add('Configuração', exists('config.json') ? 'ok' : 'warn', path.join(base, 'config.json'));
  add('Memória', 'ok', exists('MEMORIA.md') ? 'MEMORIA.md presente' : 'vazia');
  const errors = log.tail(200).split('\n').filter((l) => / ERROR /.test(l));
  add('Log', errors.length ? 'warn' : 'ok', `${log.file()}${errors.length ? ` (${errors.length} erro(s) recente(s); último: ${errors[errors.length - 1].slice(25, 160)})` : ''}`);
  return items;
}

function formatDoctor(items, { color = (s) => s } = {}) {
  const icon = { ok: color.ok ? color.ok('✓') : '✓', warn: color.warn ? color.warn('!') : '!', fail: color.fail ? color.fail('✗') : '✗' };
  const w = Math.max(...items.map((i) => i.name.length));
  return items.map((i) => `${icon[i.status]} ${i.name.padEnd(w)}  ${i.detail}`).join('\n');
}

module.exports = { runDoctor, formatDoctor };
