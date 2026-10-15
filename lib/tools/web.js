'use strict';
// Criação de sites, apps e sistemas a partir dos starters oficiais mais usados do GitHub, sem interação.
// Cobre front-end (SPA via Vite), meta-frameworks/fullstack, back-end, geradores de site (SSG/docs) e
// mobile/desktop. Também adiciona Tailwind CSS ou shadcn/ui a um projeto existente.
// Roda com a entrada padrão fechada (os geradores caem nos defaults em vez de travar esperando resposta).

const path = require('path');
const { run, need, has } = require('./_exec');

const NODE = 'https://nodejs.org (inclui o npm)';
const npx = (args) => ({ bin: 'npx', a: ['--yes', ...args] });
const npmc = (args) => ({ bin: 'npm', a: ['create', ...args] });

// stack -> como criar. cat agrupa na descrição. Comandos conferidos nas docs oficiais (out/2026).
const STACKS = {
  // --- front-end (SPA, via Vite) ---
  'vite-react': { ...npmc(['vite@latest', '%n', '--yes', '--', '--template', 'react-ts']), from: 'vitejs/vite', cat: 'front-end' },
  'vite-vue': { ...npmc(['vite@latest', '%n', '--yes', '--', '--template', 'vue-ts']), from: 'vitejs/vite', cat: 'front-end' },
  'vite-svelte': { ...npmc(['vite@latest', '%n', '--yes', '--', '--template', 'svelte-ts']), from: 'vitejs/vite', cat: 'front-end' },
  'vite-preact': { ...npmc(['vite@latest', '%n', '--yes', '--', '--template', 'preact-ts']), from: 'vitejs/vite', cat: 'front-end' },
  'vite-lit': { ...npmc(['vite@latest', '%n', '--yes', '--', '--template', 'lit-ts']), from: 'vitejs/vite', cat: 'front-end' },
  'vite-vanilla': { ...npmc(['vite@latest', '%n', '--yes', '--', '--template', 'vanilla-ts']), from: 'vitejs/vite', cat: 'front-end' },
  solid: { ...npmc(['solid@latest', '%n']), from: 'solidjs/solid-start', cat: 'front-end' },

  // --- meta-frameworks / fullstack ---
  next: { ...npx(['create-next-app@latest', '%n', '--ts', '--eslint', '--app', '--tailwind', '--use-npm', '--no-src-dir', '--no-import-alias']), from: 'vercel/next.js', cat: 'fullstack' },
  nuxt: { ...npx(['nuxi@latest', 'init', '%n', '--packageManager', 'npm']), from: 'nuxt/nuxt', cat: 'fullstack' },
  sveltekit: { ...npx(['sv', 'create', '%n', '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--install', 'npm']), from: 'sveltejs/kit', cat: 'fullstack' },
  'react-router': { ...npx(['create-react-router@latest', '%n', '--yes', '--no-git-init', '--install']), from: 'remix-run/react-router', cat: 'fullstack' },
  remix: { ...npx(['create-remix@latest', '%n', '--yes', '--no-git-init', '--install']), from: 'remix-run/remix', cat: 'fullstack' },
  astro: { ...npmc(['astro@latest', '%n', '--', '--template', 'basics', '--install', '--no-git', '--typescript', 'strict', '--skip-houston', '--yes']), from: 'withastro/astro', cat: 'fullstack' },
  angular: { ...npx(['@angular/cli@latest', 'new', '%n', '--defaults', '--skip-git', '--package-manager', 'npm']), from: 'angular/angular', cat: 'fullstack' },
  'solid-start': { ...npmc(['solid@latest', '%n']), from: 'solidjs/solid-start', cat: 'fullstack' },
  qwik: { ...npmc(['qwik@latest', '%n']), from: 'QwikDev/qwik', cat: 'fullstack' },
  t3: { ...npx(['create-t3-app@latest', '%n', '--CI', '--tailwind', '--noGit']), from: 't3-oss/create-t3-app', cat: 'fullstack' },
  redwood: { ...npx(['create-redwood-app@latest', '%n', '-y']), from: 'redwoodjs/redwood', cat: 'fullstack' },

  // --- back-end / sistemas ---
  nestjs: { ...npx(['@nestjs/cli@latest', 'new', '%n', '--skip-git', '--package-manager', 'npm']), from: 'nestjs/nest', cat: 'back-end' },
  hono: { ...npmc(['hono@latest', '%n', '--', '--template', 'nodejs', '--install', '--pm', 'npm']), from: 'honojs/hono', cat: 'back-end' },
  express: { ...npx(['express-generator@latest', '%n', '--no-view']), from: 'expressjs/generator', cat: 'back-end' },

  // --- geradores de site / documentação (SSG) ---
  docusaurus: { ...npx(['create-docusaurus@latest', '%n', 'classic', '--typescript']), from: 'facebook/docusaurus', cat: 'ssg/docs' },
  starlight: { ...npmc(['astro@latest', '%n', '--', '--template', 'starlight', '--install', '--no-git', '--skip-houston', '--yes']), from: 'withastro/starlight', cat: 'ssg/docs' },
  hugo: { bin: 'hugo', a: ['new', 'site', '%n'], from: 'gohugo/hugo', cat: 'ssg/docs', need: 'hugo' },

  // --- mobile / desktop ---
  expo: { ...npx(['create-expo-app@latest', '%n']), from: 'expo/expo', cat: 'mobile/desktop' },
  electron: { ...npx(['create-electron-app@latest', '%n']), from: 'electron/forge', cat: 'mobile/desktop' },
  tauri: { ...npmc(['tauri-app@latest', '%n', '--', '--yes', '--manager', 'npm', '--template', 'vanilla']), from: 'tauri-apps/tauri', cat: 'mobile/desktop' },
};

function scaffold(a, { cwd, signal }) {
  const stack = String(a.stack || '').toLowerCase();
  const S = STACKS[stack];
  if (!S) throw new Error(`stack inválida. Use uma de: ${Object.keys(STACKS).join(', ')} (ou tailwind/shadcn para adicionar a um projeto existente).`);
  const name = String(a.name || 'meu-app').trim();
  if (!/^[\w.-]+$/.test(name)) throw new Error('name deve conter só letras, números, ponto, hífen e _.');
  const dir = a.dir ? path.resolve(cwd, a.dir) : cwd;
  if (S.need && !has(S.need)) throw new Error(`"${S.need}" não está instalado (necessário para ${stack}). Instale com ensure_tool (tool: "${S.need}").`);
  if (!S.need) need('node', `Node.js não encontrado. Instale em ${NODE}.`);
  const args = S.a.map((x) => (x === '%n' ? name : x));
  // entrada fechada (input '') evita travar em prompts: os geradores usam os defaults.
  const { code, out } = run(S.bin, args, { cwd: dir, signal, timeout: 900000, input: '' });
  const rel = path.join(a.dir || '.', name).replace(/\\/g, '/');
  const dica = `\n\nPróximo passo: cd ${rel}${S.need === 'hugo' ? '' : ' && npm install && npm run dev'} (confira o README gerado).`;
  return `Projeto ${stack} (${S.from}, ${S.cat}) ${code === 0 ? 'criado' : `terminou com código ${code}`} em "${name}".\n\n${out}${code === 0 ? dica : '\n\n(Se um gerador exigiu respostas interativas e não gerou tudo, rode o comando no terminal ou me diga as opções.)'}`;
}

// Tailwind / shadcn adicionados a um projeto existente.
function addLib(a, { cwd, signal }) {
  const dir = a.dir ? path.resolve(cwd, a.dir) : cwd;
  need('npx', `npm/npx não encontrado. Instale o Node.js em ${NODE}.`);
  if (a.stack === 'tailwind') {
    const r1 = run('npm', ['install', '-D', 'tailwindcss', '@tailwindcss/postcss', 'postcss'], { cwd: dir, signal });
    return `Tailwind CSS (tailwindlabs/tailwindcss) instalado.\n\n${r1.out}\n\nAdicione "@import \\"tailwindcss\\";" ao seu CSS principal e o plugin @tailwindcss/postcss ao postcss.config.`;
  }
  const { code, out } = run('npx', ['--yes', 'shadcn@latest', 'init', '--yes', '--defaults'], { cwd: dir, signal, timeout: 600000, input: '' });
  return `shadcn/ui (shadcn-ui/ui) ${code === 0 ? 'inicializado' : `código ${code}`}.\n\n${out}\n\nAdicione componentes com: npx shadcn@latest add button card ...`;
}

module.exports = {
  defs: [{
    name: 'web_scaffold',
    description: 'Cria a base de um site, app ou sistema usando os starters oficiais mais populares, sem perguntas interativas. Categorias e stacks: '
      + 'front-end (vite-react, vite-vue, vite-svelte, vite-preact, vite-lit, vite-vanilla, solid); '
      + 'fullstack/meta (next, nuxt, sveltekit, react-router, remix, astro, angular, solid-start, qwik, t3, redwood); '
      + 'back-end (nestjs, hono, express); SSG/docs (docusaurus, starlight, hugo); mobile/desktop (expo, electron, tauri). '
      + 'Também adiciona tailwind ou shadcn a um projeto existente. Precisa de Node.js (hugo precisa do binário hugo). '
      + 'name é a pasta do projeto; dir é onde criar (padrão: pasta atual).',
    parameters: {
      type: 'object',
      properties: {
        stack: { type: 'string', enum: [...Object.keys(STACKS), 'tailwind', 'shadcn'] },
        name: { type: 'string', description: 'Nome da pasta/projeto' },
        dir: { type: 'string', description: 'Pasta onde criar (relativa ao projeto). Padrão: pasta atual.' },
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
    name: 'websites', desc: 'criar sites, apps e sistemas com starters famosos (front-end, meta-frameworks, back-end, SSG, mobile/desktop) e adicionar Tailwind/shadcn',
    hint: /\b(site|website|app\b|aplica[cç][aã]o|sistema|landing ?page|p[aá]gina|componente|rota|endpoint|layout|front-?end|back-?end|full-?stack|react|vue|svelte|angular|solid|qwik|preact|next\.?js|nuxt|sveltekit|remix|react-?router|astro|t3|redwood|nest|hono|express|docusaurus|starlight|hugo|expo|electron|tauri|vite|tailwind|shadcn|scaffold|starter|boilerplate|framework|gerar|gere|generate)\b/i,
  },
  _test: { STACKS },
};
