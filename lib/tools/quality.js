'use strict';
// Qualidade de código com as ferramentas mais usadas do GitHub:
// ESLint (eslint/eslint), Prettier (prettier/prettier), Biome (biomejs/biome), Ruff (astral-sh/ruff),
// Semgrep (semgrep/semgrep) e o compilador TypeScript (microsoft/TypeScript).
// action=check só analisa (roda direto); action=fix aplica correções (pede aprovação).

const path = require('path');
const { run, has } = require('./_exec');

const NODE = 'https://nodejs.org';

// npx roda a versão local do projeto se existir; senão baixa. --no-install evita baixar sem querer no check pesado? Mantemos --yes.
function npx(args, ctx, timeout = 300000) { return run('npx', ['--yes', ...args], { ...ctx, timeout }); }

const TOOLS = {
  eslint: {
    from: 'eslint/eslint', lang: 'JS/TS',
    check: (t) => ['eslint', t || '.'],
    fix: (t) => ['eslint', t || '.', '--fix'],
    runner: 'npx',
  },
  prettier: {
    from: 'prettier/prettier', lang: 'formatação (JS/TS/CSS/HTML/JSON/MD)',
    check: (t) => ['prettier', '--check', t || '.'],
    fix: (t) => ['prettier', '--write', t || '.'],
    runner: 'npx',
  },
  biome: {
    from: 'biomejs/biome', lang: 'lint+format (JS/TS) rápido',
    check: (t) => ['@biomejs/biome', 'check', t || '.'],
    fix: (t) => ['@biomejs/biome', 'check', '--write', t || '.'],
    runner: 'npx',
  },
  ruff: {
    from: 'astral-sh/ruff', lang: 'Python (lint+format) rápido',
    check: (t) => ['ruff', 'check', t || '.'],
    fix: (t) => ['ruff', 'check', '--fix', t || '.'],
    runner: 'bin', bin: 'ruff',
    install: 'Ruff não encontrado. Instale com "pip install ruff" ou "uvx ruff" (astral-sh/ruff).',
  },
  semgrep: {
    from: 'semgrep/semgrep', lang: 'análise estática / segurança (multi-linguagem)',
    check: (t) => ['--config', 'auto', t || '.'],
    runner: 'bin', bin: 'semgrep', checkOnly: true,
    install: 'Semgrep não encontrado. Instale com "pip install semgrep" ou veja semgrep/semgrep.',
  },
  typescript: {
    from: 'microsoft/TypeScript', lang: 'checagem de tipos TS',
    check: () => ['tsc', '--noEmit'],
    runner: 'npx', checkOnly: true,
  },
};

function quality(a, ctx) {
  const key = String(a.tool || '').toLowerCase();
  const T = TOOLS[key];
  if (!T) throw new Error(`tool inválida. Use: ${Object.keys(TOOLS).join(', ')}.`);
  const action = a.action === 'fix' ? 'fix' : 'check';
  if (action === 'fix' && (T.checkOnly || !T.fix)) throw new Error(`${key} só analisa (não tem correção automática). Use action=check.`);
  const target = a.path ? String(a.path) : '';
  const args = (action === 'fix' ? T.fix : T.check)(target);

  let res;
  if (T.runner === 'bin') {
    if (!has(T.bin)) throw new Error(T.install);
    res = run(T.bin, args, { ...ctx, timeout: 600000 });
  } else {
    if (!has('npx')) throw new Error(`Node.js/npx não encontrado (para ${key}). Instale em ${NODE}.`);
    res = npx(args, ctx, 600000);
  }
  const verb = action === 'fix' ? 'correção' : 'análise';
  const status = res.code === 0 ? 'sem problemas' : `encontrou problemas (código ${res.code})`;
  return `${key} (${T.from}) — ${verb}: ${status}.\n\n${res.out || '(sem saída)'}`;
}

module.exports = {
  defs: [{
    name: 'code_quality',
    description: 'Roda as ferramentas de qualidade de código mais usadas do GitHub. '
      + 'tool=eslint (eslint/eslint), prettier (prettier/prettier), biome (biomejs/biome), ruff (astral-sh/ruff, Python), '
      + 'semgrep (semgrep/semgrep, análise de segurança) ou typescript (checagem de tipos tsc). '
      + 'action=check só relata (padrão); action=fix corrige/formata automaticamente (eslint, prettier, biome, ruff). '
      + 'path limita a um arquivo/pasta. Requer Node.js/npx (ou pip para ruff/semgrep).',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: Object.keys(TOOLS) },
        action: { type: 'string', enum: ['check', 'fix'], description: 'Padrão: check' },
        path: { type: 'string', description: 'Arquivo ou pasta alvo (padrão: projeto todo)' },
      },
      required: ['tool'],
    },
  }],
  run: (name, a, ctx) => quality(a, ctx),
  describe: (name, a) => `Qualidade(${a.tool} ${a.action || 'check'}${a.path ? ` ${a.path}` : ''})`,
  // check é leitura (roda direto); fix altera arquivos (aprovação).
  needsApproval: (name, a) => a && a.action === 'fix',
  group: {
    name: 'qualidade', desc: 'qualidade de código (ESLint, Prettier, Biome, Ruff, Semgrep, TypeScript)',
    hint: /\b(lint(er)?|eslint|prettier|biome|ruff|semgrep|formatar|format|tsc|type-?check|checagem de tipos|qualidade de c[oó]digo|an[aá]lise est[aá]tica|padr[oõ]es de c[oó]digo)\b/i,
  },
  _test: { TOOLS },
};
