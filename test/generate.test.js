'use strict';
// generate (peças dentro de um projeto), guia de back-end e crystallize kind=skill.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-gen-'));
const proj = (deps, dirs = []) => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: deps }));
  for (const sub of dirs) fs.mkdirSync(path.join(d, sub), { recursive: true });
  return d;
};

test('generate: detecta framework e aprovação', () => {
  const gen = require('../lib/tools/generate');
  assert.strictEqual(gen.needsApproval(), true);
  assert.strictEqual(gen._test.detect(proj({ next: '1' })), 'next');
  assert.strictEqual(gen._test.detect(proj({ react: '1' })), 'react');
  assert.strictEqual(gen._test.detect(proj({ vue: '1' })), 'vue');
  assert.strictEqual(gen._test.detect(proj({ 'solid-js': '1' })), 'solid');
  assert.strictEqual(gen._test.detect(tmp()), null);
  assert.strictEqual(gen._test.pascal('user-card'), 'UserCard');
  assert.strictEqual(gen._test.kebab('UserCard'), 'user-card');
});

test('generate: componente React e página Next (app router)', () => {
  const gen = require('../lib/tools/generate');
  const r = proj({ react: '1' }, ['src']);
  gen.run('generate', { kind: 'component', name: 'UserCard' }, { cwd: r });
  const comp = fs.readFileSync(path.join(r, 'src', 'components', 'UserCard.tsx'), 'utf8');
  assert.match(comp, /export function UserCard/);
  assert.match(comp, /export default UserCard/);

  const n = proj({ next: '1' }, ['app']);
  gen.run('generate', { kind: 'page', name: 'dashboard' }, { cwd: n });
  const page = fs.readFileSync(path.join(n, 'app', 'dashboard', 'page.tsx'), 'utf8');
  assert.match(page, /export default function DashboardPage/);
  // api route no Next app router
  gen.run('generate', { kind: 'api', name: 'health' }, { cwd: n });
  assert.ok(fs.existsSync(path.join(n, 'app', 'api', 'health', 'route.ts')));
  // não sobrescreve
  assert.throws(() => gen.run('generate', { kind: 'page', name: 'dashboard' }, { cwd: n }), /Já existe/);
});

test('generate: página SvelteKit e erro sem framework', () => {
  const gen = require('../lib/tools/generate');
  const s = proj({ '@sveltejs/kit': '1' }, ['src']);
  gen.run('generate', { kind: 'page', name: 'sobre' }, { cwd: s });
  assert.ok(fs.existsSync(path.join(s, 'src', 'routes', 'sobre', '+page.svelte')));
  assert.throws(() => gen.run('generate', { kind: 'component', name: 'X' }, { cwd: tmp() }), /framework/);
});

test('guia de back-end existe e está ligado ao grupo backend', () => {
  const g = fs.readFileSync(path.join(__dirname, '..', 'lib', 'guides', 'backend.md'), 'utf8');
  assert.match(g, /migra[cç]/i);
  assert.match(g, /segredos/i);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent.js'), 'utf8');
  assert.match(agent, /backend: 'backend'/);
  assert.match(agent, /TOOL_GROUPS\.backend = /);
});

test('crystallize kind=skill: cria SKILL.md com frontmatter; exige descrição', () => {
  const cry = require('../lib/tools/crystallize');
  const d = tmp();
  assert.throws(() => cry.run('crystallize', { kind: 'skill', name: 'deploy', body: 'passos' }, { cwd: d }), /description é obrigat/i);
  const r = cry.run('crystallize', { kind: 'skill', name: 'deploy', description: 'Use ao publicar o site em produção', body: '1. rode os testes\n2. build\n3. publique', keywords: ['deploy', 'publicar'] }, { cwd: d });
  assert.match(r, /skill "deploy"/);
  const file = path.join(d, '.rfcode', 'skills', 'deploy', 'SKILL.md');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^---\nname: deploy\ndescription: Use ao publicar/);
  assert.match(content, /keywords: deploy, publicar/);
  assert.match(content, /## Passo a passo/);
  // ainda cria comando por padrão
  assert.match(cry.run('crystallize', { name: 'oi', body: 'diga oi' }, { cwd: d }), /\/oi/);
});
