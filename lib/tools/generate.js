'use strict';
// Geracao DENTRO de um projeto ja existente (o passo depois do web_scaffold): cria uma pagina, componente,
// rota, endpoint de API ou layout na convencao do framework detectado. Para frameworks com gerador oficial
// (Angular, Nuxt, NestJS, Redwood) delega ao CLI; para os demais (Next, React/Vite, Vue, Svelte, Solid)
// escreve um arquivo inicial correto. Detecta o framework pelo package.json e pelas pastas.

const fs = require('fs');
const path = require('path');
const { run, has } = require('./_exec');

function readPkg(cwd) { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { return {}; } }
function deps(pkg) { return { ...pkg.dependencies, ...pkg.devDependencies }; }
const exists = (cwd, p) => fs.existsSync(path.join(cwd, p));

function detect(cwd) {
  const d = deps(readPkg(cwd));
  if (d.next) return 'next';
  if (d.nuxt) return 'nuxt';
  if (d['@angular/core']) return 'angular';
  if (d['@nestjs/core']) return 'nest';
  if (d['@redwoodjs/core'] || d['@redwoodjs/web']) return 'redwood';
  if (d['@sveltejs/kit'] || d.svelte) return 'svelte';
  if (d['solid-js']) return 'solid';
  if (d.vue) return 'vue';
  if (d.react) return 'react';
  return null;
}

const pascal = (s) => String(s).replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^(.)/, (m) => m.toUpperCase());
const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

// pasta de componentes preferida do projeto
function compDir(cwd) {
  for (const p of ['src/components', 'components', 'app/components', 'src/lib/components']) if (exists(cwd, p)) return p;
  return exists(cwd, 'src') ? 'src/components' : 'components';
}

function write(cwd, rel, content) {
  const abs = path.resolve(cwd, rel);
  if (fs.existsSync(abs)) throw new Error(`Já existe: ${rel}. Apague ou escolha outro nome.`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

// ---------- templates por framework ----------
const T = {
  reactComponent: (N) => `export function ${N}() {\n  return <div className="${kebab(N)}">${N}</div>;\n}\n\nexport default ${N};\n`,
  solidComponent: (N) => `import type { Component } from 'solid-js';\n\nconst ${N}: Component = () => {\n  return <div class="${kebab(N)}">${N}</div>;\n};\n\nexport default ${N};\n`,
  vueComponent: (N) => `<script setup lang="ts">\n</script>\n\n<template>\n  <div class="${kebab(N)}">${N}</div>\n</template>\n`,
  svelteComponent: () => `<script lang="ts">\n</script>\n\n<div>\n</div>\n`,
  nextPage: (N) => `export default function ${N}Page() {\n  return (\n    <main>\n      <h1>${N}</h1>\n    </main>\n  );\n}\n`,
  nextLayout: (N) => `export default function ${N}Layout({ children }: { children: React.ReactNode }) {\n  return <section>{children}</section>;\n}\n`,
  nextApi: () => `import { NextResponse } from 'next/server';\n\nexport async function GET() {\n  return NextResponse.json({ ok: true });\n}\n`,
  sveltePage: (N) => `<script lang="ts">\n</script>\n\n<h1>${N}</h1>\n`,
  svelteServer: () => `import { json } from '@sveltejs/kit';\n\nexport async function GET() {\n  return json({ ok: true });\n}\n`,
};

function generate(a, { cwd, signal }) {
  const kind = String(a.kind || '').toLowerCase();
  const rawName = String(a.name || '').trim();
  if (!rawName || !/^[\w./-]+$/.test(rawName)) throw new Error('Informe name (ex.: "UserCard" ou "dashboard").');
  const fw = a.framework || detect(cwd);
  if (!fw) throw new Error('Não detectei o framework (sem package.json reconhecido). Rode num projeto, ou passe framework.');
  const N = pascal(rawName.replace(/.*\//, ''));
  const slug = kebab(rawName.replace(/.*\//, ''));
  const made = [];

  // frameworks com gerador oficial: delega
  if (fw === 'angular' && (has('ng') || has('npx'))) {
    const ngKind = { component: 'component', page: 'component', service: 'service', route: 'component', guard: 'guard', pipe: 'pipe', directive: 'directive' }[kind] || 'component';
    const r = run(has('ng') ? 'ng' : 'npx', (has('ng') ? [] : ['--yes', '@angular/cli']).concat(['generate', ngKind, rawName]), { cwd, signal, timeout: 300000, input: '' });
    return `Angular (ng generate ${ngKind} ${rawName}) código ${r.code}:\n\n${r.out}`;
  }
  if (fw === 'nuxt' && has('npx')) {
    const nuxiKind = { page: 'page', component: 'component', layout: 'layout', api: 'api', store: 'store', composable: 'composable', middleware: 'middleware' }[kind] || 'component';
    const r = run('npx', ['--yes', 'nuxi', 'add', nuxiKind, rawName], { cwd, signal, timeout: 300000, input: '' });
    return `Nuxt (nuxi add ${nuxiKind} ${rawName}) código ${r.code}:\n\n${r.out}`;
  }
  if (fw === 'nest' && has('npx')) {
    const nestKind = { component: 'module', service: 'service', controller: 'controller', api: 'resource', resource: 'resource', module: 'module' }[kind] || 'resource';
    const r = run('npx', ['--yes', '@nestjs/cli', 'generate', nestKind, rawName, '--no-spec'], { cwd, signal, timeout: 300000, input: '' });
    return `NestJS (nest generate ${nestKind} ${rawName}) código ${r.code}:\n\n${r.out}`;
  }

  // frameworks sem gerador oficial: escreve arquivo idiomatico
  const ext = fw === 'vue' ? 'vue' : fw === 'svelte' ? 'svelte' : 'tsx';
  const appRouter = exists(cwd, 'app') || exists(cwd, 'src/app');
  const appBase = exists(cwd, 'src/app') ? 'src/app' : 'app';

  if (kind === 'component' || !kind) {
    const dir = compDir(cwd);
    if (fw === 'vue') made.push(write(cwd, `${dir}/${N}.vue`, T.vueComponent(N)));
    else if (fw === 'svelte') made.push(write(cwd, `${dir}/${N}.svelte`, T.svelteComponent(N)));
    else if (fw === 'solid') made.push(write(cwd, `${dir}/${N}.tsx`, T.solidComponent(N)));
    else made.push(write(cwd, `${dir}/${N}.tsx`, T.reactComponent(N)));
  } else if (kind === 'page') {
    if (fw === 'next' && appRouter) made.push(write(cwd, `${appBase}/${slug}/page.tsx`, T.nextPage(N)));
    else if (fw === 'next') made.push(write(cwd, `pages/${slug}.tsx`, T.nextPage(N)));
    else if (fw === 'svelte') made.push(write(cwd, `src/routes/${slug}/+page.svelte`, T.sveltePage(N)));
    else if (fw === 'vue') made.push(write(cwd, `src/pages/${N}.vue`, T.vueComponent(N)));
    else made.push(write(cwd, `src/pages/${N}.tsx`, fw === 'solid' ? T.solidComponent(N) : T.reactComponent(N)));
  } else if (kind === 'layout') {
    if (fw === 'next' && appRouter) made.push(write(cwd, `${appBase}/${slug}/layout.tsx`, T.nextLayout(N)));
    else throw new Error('layout só é gerado para Next (app router). Use component/page nos outros.');
  } else if (kind === 'api' || kind === 'route') {
    if (fw === 'next' && appRouter) made.push(write(cwd, `${appBase}/api/${slug}/route.ts`, T.nextApi()));
    else if (fw === 'next') made.push(write(cwd, `pages/api/${slug}.ts`, 'export default function handler(req, res) {\n  res.status(200).json({ ok: true });\n}\n'));
    else if (fw === 'svelte') made.push(write(cwd, `src/routes/${slug}/+server.ts`, T.svelteServer()));
    else throw new Error(`api/route não é suportado para ${fw} aqui. Use um framework com rotas de servidor (Next, SvelteKit).`);
  } else {
    throw new Error('kind: component, page, layout, api/route (ou service/controller nos frameworks com gerador).');
  }
  return `Gerado (${fw}):\n- ${made.join('\n- ')}\n\nAbra e complete a lógica. Importe o componente onde for usar.`;
}

module.exports = {
  defs: [{
    name: 'generate',
    description: 'Gera uma peça DENTRO de um projeto já existente, na convenção do framework detectado (depois do web_scaffold): '
      + 'kind=component, page, layout, api/route (e service/controller/module nos frameworks com gerador). '
      + 'Detecta o framework pelo package.json (Next, React/Vite, Vue, Svelte, Solid, Angular, Nuxt, NestJS). '
      + 'Angular/Nuxt/NestJS usam o gerador oficial; os demais ganham um arquivo inicial correto. name aceita PascalCase ou caminho.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'component, page, layout, api/route, service, controller, module...' },
        name: { type: 'string', description: 'Nome (ex.: "UserCard") ou caminho (ex.: "admin/settings")' },
        framework: { type: 'string', description: 'Força o framework se a detecção falhar' },
      },
      required: ['kind', 'name'],
    },
  }],
  run: (name, a, ctx) => generate(a, ctx),
  describe: (name, a) => `Gerar(${a.kind} ${String(a.name || '').slice(0, 40)})`,
  needsApproval: () => true, // cria arquivos / roda gerador
  group: {
    name: 'websites', desc: 'gerar páginas, componentes, rotas e APIs dentro de um projeto existente',
    hint: /\b(gerar|criar|nova|novo)\s+(p[aá]gina|componente|rota|endpoint|api|layout|service|controller|m[oó]dulo)|\bgenerate\b|\bscaffold\b/i,
  },
  _test: { detect, pascal, kebab, generate },
};
