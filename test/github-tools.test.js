'use strict';
// Ferramentas que embrulham projetos famosos do GitHub: sites (web), vídeos animados (motion),
// qualidade de código (quality) e engenharia reversa (reverse). Testa forma, metadados e caminhos de erro
// sem depender dos CLIs externos estarem instalados.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODS = {
  web: require('../lib/tools/web'),
  motion: require('../lib/tools/motion'),
  quality: require('../lib/tools/quality'),
  reverse: require('../lib/tools/reverse'),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-gh-'));

test('todos os módulos têm a forma esperada (defs, run, group com hint)', () => {
  for (const [key, m] of Object.entries(MODS)) {
    assert.ok(Array.isArray(m.defs) && m.defs.length >= 1, `${key}: defs`);
    assert.strictEqual(typeof m.run, 'function', `${key}: run`);
    assert.strictEqual(typeof m.group, 'object', `${key}: group`);
    assert.ok(m.group.name && m.group.desc && m.group.hint instanceof RegExp, `${key}: group completo`);
    assert.strictEqual(typeof m.describe, 'function', `${key}: describe`);
    for (const d of m.defs) {
      assert.ok(d.name && d.description && d.parameters, `${key}: def ${d.name}`);
      assert.strictEqual(typeof m.describe(d.name, {}), 'string');
    }
  }
});

test('os grupos são registrados no agent.js e ativados pelas palavras-chave certas', () => {
  // o require do agent.js não pode quebrar e precisa citar os quatro módulos novos
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent.js'), 'utf8');
  for (const name of ['web', 'motion', 'quality', 'reverse']) {
    assert.match(src, new RegExp(`require\\('\\./tools/${name}'\\)`), `agent.js registra tools/${name}`);
  }
  assert.ok(MODS.web.group.hint.test('quero criar um site em react'));
  assert.ok(MODS.motion.group.hint.test('fazer um vídeo com remotion'));
  assert.ok(MODS.quality.group.hint.test('rodar o eslint e o prettier'));
  assert.ok(MODS.reverse.group.hint.test('engenharia reversa desse binário .exe'));
  // não devem disparar à toa
  assert.ok(!MODS.reverse.group.hint.test('escreva uma função de soma'));
});

test('web_scaffold: stack inválida e aprovação', () => {
  assert.throws(() => MODS.web.run('web_scaffold', { stack: 'inexistente' }, { cwd: tmp() }), /stack inválida/);
  assert.throws(() => MODS.web.run('web_scaffold', { stack: 'vite-react', name: 'nome inválido!' }, { cwd: tmp() }), /name deve conter/);
  assert.strictEqual(MODS.web.needsApproval(), true);
  assert.match(MODS.web.describe('web_scaffold', { stack: 'next', name: 'loja' }), /Site\(next loja\)/);
});

test('web_scaffold: cobre front-end, meta-frameworks, back-end, SSG e mobile/desktop', () => {
  const S = MODS.web._test.STACKS;
  assert.ok(Object.keys(S).length >= 25, `esperado muitas stacks, veio ${Object.keys(S).length}`);
  for (const s of ['vite-react', 'next', 'nuxt', 'sveltekit', 'angular', 'solid', 'qwik', 't3', 'nestjs', 'hono', 'astro', 'docusaurus', 'expo', 'tauri', 'electron', 'react-router']) {
    assert.ok(S[s], `stack ${s} presente`);
    assert.ok(S[s].from && S[s].cat && (S[s].bin && Array.isArray(S[s].a)), `stack ${s} bem formada`);
  }
  const cats = new Set(Object.values(S).map((x) => x.cat));
  for (const c of ['front-end', 'fullstack', 'back-end', 'ssg/docs', 'mobile/desktop']) assert.ok(cats.has(c), `categoria ${c}`);
  // nenhum %n sobrou sem o marcador (sanidade dos templates)
  for (const [k, v] of Object.entries(S)) assert.ok(v.a.includes('%n'), `stack ${k} usa o nome do projeto`);
});

test('guia de front-end existe e cobre escolha de stack e qualidade', () => {
  const fs = require('fs');
  const g = fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'guides', 'frontend.md'), 'utf8');
  assert.match(g, /web_scaffold/);
  assert.match(g, /acessibilidade/i);
  assert.match(g, /SSR|meta-framework/i);
  // ligado ao grupo websites no agent.js
  assert.match(fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'agent.js'), 'utf8'), /websites: 'frontend'/);
});

test('code_quality: tool inválida, fix em ferramenta só-leitura e regra de aprovação', () => {
  assert.throws(() => MODS.quality.run('code_quality', { tool: 'xpto' }, { cwd: tmp() }), /tool inválida/);
  assert.throws(() => MODS.quality.run('code_quality', { tool: 'semgrep', action: 'fix' }, { cwd: tmp() }), /só analisa/);
  assert.throws(() => MODS.quality.run('code_quality', { tool: 'typescript', action: 'fix' }, { cwd: tmp() }), /só analisa/);
  assert.strictEqual(MODS.quality.needsApproval('code_quality', { tool: 'eslint', action: 'check' }), false);
  assert.strictEqual(MODS.quality.needsApproval('code_quality', { tool: 'eslint', action: 'fix' }), true);
});

test('reverse_engineer: só leitura (sem aprovação), valida arquivo e ação', () => {
  const d = tmp();
  assert.strictEqual(MODS.reverse.needsApproval(), false);
  assert.throws(() => MODS.reverse.run('reverse_engineer', { action: 'info' }, { cwd: d }), /file é obrigatório/);
  assert.throws(() => MODS.reverse.run('reverse_engineer', { file: 'nao-existe.bin', action: 'info' }, { cwd: d }), /não encontrado/);
  fs.writeFileSync(path.join(d, 'x.bin'), 'conteudo');
  assert.throws(() => MODS.reverse.run('reverse_engineer', { file: 'x.bin', action: 'xpto' }, { cwd: d }), /action:/);
});

test('motion_video: engine inválida e aprovação', () => {
  assert.throws(() => MODS.motion.run('motion_video', { engine: 'xpto' }, { cwd: tmp() }), /engine:/);
  assert.strictEqual(MODS.motion.needsApproval(), true);
  assert.match(MODS.motion.describe('motion_video', { engine: 'manim', action: 'render' }), /Motion\(manim render\)/);
});
