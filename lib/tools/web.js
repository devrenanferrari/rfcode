'use strict';
// Criação de sites a partir dos starters mais usados do GitHub (via npm/npx, sem interação):
// Vite (vitejs/vite), Next.js (vercel/next.js), Astro (withastro/astro), SvelteKit (sveltejs/kit),
// Remix (remix-run/remix), Tailwind CSS (tailwindlabs/tailwindcss) e shadcn/ui (shadcn-ui/ui).

const path = require('path');
const { run, need } = require('./_exec');

const NODE = 'https://nodejs.org (inclui o npm)';

// Cada stack: como criar (args do npm/npx) e o projeto de origem no GitHub.
const STACKS = {
  'vite-react': { bin: 'npm', mk: (n) => ['create', 'vite@latest', n, '--yes', '--', '--template', 'react-ts'], from: 'vitejs/vite' },
  'vite-vue': { bin: 'npm', mk: (n) => ['create', 'vite@latest', n, '--yes', '--', '--template', 'vue-ts'], from: 'vitejs/vite' },
  'vite-svelte': { bin: 'npm', mk: (n) => ['create', 'vite@latest', n, '--yes', '--', '--template', 'svelte-ts'], from: 'vitejs/vite' },
  'vite-vanilla': { bin: 'npm', mk: (n) => ['create', 'vite@latest', n, '--yes', '--', '--template', 'vanilla-ts'], from: 'vitejs/vite' },
  next: { bin: 'npx', mk: (n) => ['--yes', 'create-next-app@latest', n, '--ts', '--eslint', '--app', '--tailwind', '--use-npm', '--no-src-dir', '--no-import-alias'], from: 'vercel/next.js' },
  astro: { bin: 'npm', mk: (n) => ['create', 'astro@latest', n, '--', '--template', 'basics', '--install', '--no-git', '--typescript', 'strict', '--skip-houston', '--yes'], from: 'withastro/astro' },
  sveltekit: { bin: 'npx', mk: (n) => ['--yes', 'sv', 'create', n, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--install', 'npm'], from: 'sveltejs/kit' },
  remix: { bin: 'npx', mk: (n) => ['--yes', 'create-remix@latest', n, '--yes', '--no-git-init', '--install'], from: 'remix-run/remix' },
};

function scaffold(a, { cwd, signal }) {
  const stack = String(a.stack || '').toLowerCase();
  const S = STACKS[stack];
  if (!S) throw new Error(`stack inválida. Use: ${Object.keys(STACKS).join(', ')}, tailwind ou shadcn.`);
  const name = String(a.name || 'meu-site').trim();
  if (!/^[\w.-]+$/.test(name)) throw new Error('name deve conter só letras, números, ponto, hífen e _.');
  const dir = a.dir ? path.resolve(cwd, a.dir) : cwd;
  need('node', `Node.js não encontrado. Instale em ${NODE}.`);
  const { code, out } = run(S.bin, S.mk(name), { cwd: dir, signal, timeout: 600000 });
  const dica = `\n\nPróximo passo: cd ${path.join(a.dir || '.', name).replace(/\\/g, '/')} && npm run dev`;
  return `Projeto ${stack} (${S.from}) ${code === 0 ? 'criado' : `terminou com código ${code}`} em "${name}".\n\n${out}${code === 0 ? dica : ''}`;
}

// Tailwind / shadcn são adicionados a um projeto que já existe.
function addLib(a, { cwd, signal }) {
  const dir = a.dir ? path.resolve(cwd, a.dir) : cwd;
  if (a.stack === 'tailwind') {
    need('npx', `npm/npx não encontrado. Instale o Node.js em ${NODE}.`);
    const r1 = run('npm', ['install', '-D', 'tailwindcss', '@tailwindcss/postcss', 'postcss'], { cwd: dir, signal });
    return `Tailwind CSS (tailwindlabs/tailwindcss) instalado.\n\n${r1.out}\n\nAdicione "@import \\"tailwindcss\\";" ao seu CSS principal e o plugin @tailwindcss/postcss ao postcss.config.`;
  }
  if (a.stack === 'shadcn') {
    need('npx', `npm/npx não encontrado. Instale o Node.js em ${NODE}.`);
    const { code, out } = run('npx', ['--yes', 'shadcn@latest', 'init', '--yes', '--defaults'], { cwd: dir, signal, timeout: 600000 });
    return `shadcn/ui (shadcn-ui/ui) ${code === 0 ? 'inicializado' : `código ${code}`}.\n\n${out}\n\nAdicione componentes com: npx shadcn@latest add button card ...`;
  }
  throw new Error('stack não reconhecida');
}

module.exports = {
  defs: [{
    name: 'web_scaffold',
    description: 'Cria a base de um site usando os starters mais populares do GitHub, sem perguntas interativas. '
      + 'stacks: vite-react, vite-vue, vite-svelte, vite-vanilla (vitejs/vite), next (vercel/next.js), astro (withastro/astro), '
      + 'sveltekit (sveltejs/kit), remix (remix-run/remix). Também adiciona tailwind (tailwindlabs/tailwindcss) ou shadcn (shadcn-ui/ui) a um projeto existente. '
      + 'Precisa de Node.js/npm. name é o nome da pasta do projeto; dir é onde criar (padrão: pasta atual).',
    parameters: {
      type: 'object',
      properties: {
        stack: { type: 'string', enum: [...Object.keys(STACKS), 'tailwind', 'shadcn'] },
        name: { type: 'string', description: 'Nome da pasta/projeto (para os scaffolds)' },
        dir: { type: 'string', description: 'Pasta onde rodar (relativa ao projeto). Padrão: pasta atual.' },
      },
      required: ['stack'],
    },
  }],
  run(name, a, ctx) {
    if (a.stack === 'tailwind' || a.stack === 'shadcn') return addLib(a, ctx);
    return scaffold(a, ctx);
  },
  describe: (name, a) => `Site(${a.stack}${a.name ? ` ${a.name}` : ''})`,
  needsApproval: () => true, // cria arquivos e baixa pacotes
  group: {
    name: 'websites', desc: 'criar sites com starters famosos (Vite, Next.js, Astro, SvelteKit, Remix, Tailwind, shadcn/ui)',
    hint: /\b(site|website|landing ?page|p[aá]gina web|front-?end|react|vue|svelte|next\.?js|astro|sveltekit|remix|vite|tailwind|shadcn|scaffold|starter|boilerplate)\b/i,
  },
  _test: { STACKS },
};
