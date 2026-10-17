'use strict';
// Guias de deploy e design (grupos só-guia), run_tests com e2e, e CLIs de deploy/qualidade no catálogo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-dd-'));

test('guias de deploy e design existem e estão ligados a grupos', () => {
  const dep = fs.readFileSync(path.join(__dirname, '..', 'lib', 'guides', 'deploy.md'), 'utf8');
  const des = fs.readFileSync(path.join(__dirname, '..', 'lib', 'guides', 'design.md'), 'utf8');
  assert.match(dep, /preview|produ[cç]/i);
  assert.match(des, /acessibilidade|contraste/i);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent.js'), 'utf8');
  assert.match(agent, /deploy: 'deploy'/);
  assert.match(agent, /design: 'design'/);
  assert.match(agent, /TOOL_GROUPS\.deploy = /);
  assert.match(agent, /TOOL_GROUPS\.design = /);
});

test('run_tests: detecta e2e por script, Playwright e Cypress', () => {
  const dev = require('../lib/tools/devcore');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', 'test:e2e': 'playwright test' } }));
  assert.deepStrictEqual(dev._test.detectTestCmd(d, { e2e: true }), { cmd: 'npm run test:e2e', kind: 'e2e' });
  assert.strictEqual(dev._test.detectTestCmd(d).cmd, 'npm test'); // sem e2e, teste normal

  const p = tmp();
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ scripts: {} }));
  fs.writeFileSync(path.join(p, 'playwright.config.ts'), '');
  assert.match(dev._test.detectTestCmd(p, { e2e: true }).kind, /playwright/);

  const c = tmp();
  fs.writeFileSync(path.join(c, 'package.json'), JSON.stringify({ scripts: {} }));
  fs.writeFileSync(path.join(c, 'cypress.config.js'), '');
  assert.match(dev._test.detectTestCmd(c, { e2e: true }).kind, /cypress/);
});

test('catálogo: CLIs de deploy/qualidade presentes', () => {
  const { find } = require('../lib/toolcatalog');
  for (const n of ['lighthouse', 'pa11y', 'gh-pages', 'surge']) assert.ok(find(n), `catálogo tem ${n}`);
});
