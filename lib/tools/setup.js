'use strict';
// Instala uma ferramenta que falta, sob demanda e com aprovação (estilo Claude/Codex): detecta o gerenciador
// de pacotes certo do sistema e instala só o que o agente precisa, em vez de parar e mandar o usuário instalar.
// O agente resolve a maioria das coisas escrevendo código e rodando comando; quando um programa externo é
// mesmo necessário (ex.: radare2, ffmpeg, manim), isto o instala com um único aprovar.

const { has, run } = require('./_exec');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Gerenciadores conhecidos e como instalam um pacote. Ordem = preferência por sistema.
const MANAGERS = {
  npm: { bin: 'npm', args: (p) => ['install', '-g', p], label: 'npm (global)' },
  pipx: { bin: 'pipx', args: (p) => ['install', p], label: 'pipx' },
  pip: { bin: IS_WIN ? 'pip' : 'pip3', args: (p) => ['install', '--user', p], label: 'pip' },
  cargo: { bin: 'cargo', args: (p) => ['install', p], label: 'cargo' },
  go: { bin: 'go', args: (p) => ['install', p], label: 'go install' },
  brew: { bin: 'brew', args: (p) => ['install', p], label: 'Homebrew' },
  winget: { bin: 'winget', args: (p) => ['install', '-e', '--id', p, '--accept-package-agreements', '--accept-source-agreements'], label: 'winget' },
  choco: { bin: 'choco', args: (p) => ['install', '-y', p], label: 'Chocolatey' },
  scoop: { bin: 'scoop', args: (p) => ['install', p], label: 'Scoop' },
  apt: { bin: 'apt-get', args: (p) => ['install', '-y', p], sudo: true, label: 'apt' },
  dnf: { bin: 'dnf', args: (p) => ['install', '-y', p], sudo: true, label: 'dnf' },
  pacman: { bin: 'pacman', args: (p) => ['-S', '--noconfirm', p], sudo: true, label: 'pacman' },
};

// Pacotes conhecidos: para cada ferramenta, o nome do pacote em cada gerenciador.
// '*' significa "mesmo nome do binário". Ausência num gerenciador = não dá para instalar por ele.
const KNOWN = {
  radare2: { apt: '*', dnf: '*', brew: '*', pacman: '*', choco: '*' },
  rizin: { apt: '*', brew: '*', pacman: '*' },
  ffmpeg: { apt: '*', dnf: '*', brew: '*', pacman: '*', choco: '*', winget: 'Gyan.FFmpeg', scoop: '*' },
  jq: { apt: '*', dnf: '*', brew: '*', pacman: '*', choco: '*', winget: 'jqlang.jq', scoop: '*' },
  ripgrep: { apt: '*', dnf: '*', brew: '*', pacman: '*', cargo: '*', scoop: '*', winget: 'BurntSushi.ripgrep.MSVC' },
  binwalk: { apt: '*', pip: '*', brew: '*' },
  manim: { pip: 'manim', pipx: 'manim' },
  ruff: { pip: 'ruff', pipx: 'ruff', cargo: '*', brew: '*' },
  semgrep: { pip: 'semgrep', pipx: 'semgrep', brew: '*' },
  pandoc: { apt: '*', dnf: '*', brew: '*', pacman: '*', choco: '*', winget: 'JohnMacFarlane.Pandoc' },
  'decktape': { npm: 'decktape' },
};

// Gerenciadores disponíveis neste sistema, na ordem de preferência por plataforma.
function available() {
  const order = IS_WIN ? ['npm', 'winget', 'scoop', 'choco', 'pipx', 'pip', 'cargo', 'go']
    : IS_MAC ? ['npm', 'brew', 'pipx', 'pip', 'cargo', 'go']
      : ['npm', 'apt', 'dnf', 'pacman', 'pipx', 'pip', 'cargo', 'go', 'brew'];
  return order.filter((m) => has(MANAGERS[m].bin));
}

function pkgFor(map, mgr, tool, explicitPkg) {
  if (explicitPkg) return explicitPkg;
  if (map && map[mgr]) return map[mgr] === '*' ? tool : map[mgr];
  // sem mapa: pip/pipx/npm/cargo costumam aceitar o próprio nome; gerenciadores de sistema também, na maioria.
  return tool;
}

// Instalador reutilizável (usado por ensure_tool e pelo toolbox). installMap: { apt:'pacote'|'*', brew:..., ... }.
// Devolve { ok, text }. Não lança por falha de instalação (reporta); lança só por erro de uso.
function install(tool, installMap, ctx, { via, package: pkgOverride } = {}) {
  if (!tool || !/^[\w.+-]+$/.test(tool)) throw new Error('Informe o nome do programa (tool), ex.: "radare2".');
  if (has(tool)) return { ok: true, text: `"${tool}" já está instalado.` };
  const avail = available();
  if (!avail.length) throw new Error('Nenhum gerenciador de pacotes encontrado no sistema (npm, pip, brew, apt, winget...).');
  const map = installMap || KNOWN[tool] || null;
  let mgr = via && avail.includes(via) ? via : null;
  if (!mgr && map) mgr = avail.find((m) => map[m]);
  mgr = mgr || avail[0];
  const M = MANAGERS[mgr];
  const pkg = pkgFor(map, mgr, tool, pkgOverride);
  const args = M.args(pkg);
  const bin = M.sudo && !IS_WIN && has('sudo') ? 'sudo' : M.bin;
  const fullArgs = M.sudo && bin === 'sudo' ? [M.bin, ...args] : args;
  const { code, out } = run(bin, fullArgs, { ...ctx, timeout: 900000 });
  const ok = code === 0 && has(tool);
  const text = `${ok ? 'Instalado' : `Tentativa de instalar (código ${code}, verifique abaixo)`}: ${tool} via ${M.label}.\n\n${out || '(sem saída)'}`
    + (ok ? '' : `\n\nSe falhou, tente outro gerenciador com via (disponíveis: ${avail.join(', ')}) ou instale manualmente.`);
  return { ok, text };
}

function ensureTool(a, ctx) {
  return install(String(a.tool || '').trim(), KNOWN[String(a.tool || '').trim()] || null, ctx, { via: a.via, package: a.package }).text;
}

module.exports = {
  defs: [{
    name: 'ensure_tool',
    description: 'Garante que um programa de linha de comando esteja instalado, instalando-o sob demanda se faltar (com aprovação). '
      + 'Detecta o gerenciador do sistema (npm, pip/pipx, brew, apt, dnf, pacman, winget, choco, scoop, cargo, go). '
      + 'Use quando uma tarefa precisar de uma ferramenta externa que não existe (ex.: radare2, ffmpeg, jq, manim, ruff) em vez de parar e pedir ao usuário. '
      + 'Se já estiver instalado, não faz nada. via força um gerenciador; package força o nome do pacote.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Nome do executável, ex.: "radare2" ou "ffmpeg"' },
        via: { type: 'string', enum: Object.keys(MANAGERS), description: 'Forçar um gerenciador específico' },
        package: { type: 'string', description: 'Nome do pacote, se diferente do executável' },
      },
      required: ['tool'],
    },
  }],
  run: (name, a, ctx) => ensureTool(a, ctx),
  describe: (name, a) => `Instalar(${String(a.tool || '').slice(0, 50)}${a.via ? ` via ${a.via}` : ''})`,
  needsApproval: () => true, // instala software no sistema
  install, // reutilizado pelo toolbox
  has,
  _test: { available, pkgFor, MANAGERS, KNOWN, install },
};
