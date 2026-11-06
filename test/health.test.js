'use strict';
// Saúde compartilhada dos modelos (lib/health.js) e o freio de exploração do agente.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-health-'));
process.env.RFCODE_HOME = HOME;
const health = require('../lib/health');

test('modelo pausado fica fora para todas as sessões e volta quando responde', () => {
  health.reset();
  assert.strictEqual(health.pausedUntil('x/travado'), 0);
  health.pause('x/travado', 'travou', 'não começou a responder em 60s');
  const ate = health.pausedUntil('x/travado');
  assert.ok(ate > Date.now() + 29 * 60 * 1000 && ate <= Date.now() + 30 * 60 * 1000);
  // outro processo lê do disco
  const disk = JSON.parse(fs.readFileSync(health.file(), 'utf8'));
  assert.match(disk['x/travado'].motivo, /^travou: /);
  health.reset();
  assert.strictEqual(health.pausedUntil('x/travado'), ate);
  // uma pausa mais curta não encurta a que já existe
  health.pause('x/travado', 'falhou');
  assert.strictEqual(health.pausedUntil('x/travado'), ate);
  health.ok('x/travado');
  assert.strictEqual(health.pausedUntil('x/travado'), 0);
  assert.deepStrictEqual(health.list(), []);
});

test('o modo auto pula o modelo que outra sessão viu travar', () => {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ keys: { nvidia: 'nvapi-x' }, autoModels: ['nvidia/a', 'nvidia/b'] }));
  health.reset();
  const { Agent } = require('../lib/agent');
  const a = new Agent({ model: 'auto', cwd: HOME });
  a.sharedHealth = true;
  assert.strictEqual(a.autoPick(), 'nvidia/a');
  health.pause('nvidia/a', 'travou');
  const b = new Agent({ model: 'auto', cwd: HOME });
  b.sharedHealth = true;
  assert.strictEqual(b.autoPick(), 'nvidia/b');
  // todos fora: escolhe o que libera primeiro em vez de nenhum
  health.pause('nvidia/b', 'falhou');
  assert.strictEqual(b.autoPick({ ready: true }), null);
  assert.strictEqual(b.autoPick(), 'nvidia/b');
  health.ok('nvidia/a');
  health.ok('nvidia/b');
});

test('muitas leituras seguidas sem agir disparam o lembrete de parar de explorar', () => {
  const { Agent } = require('../lib/agent');
  const a = new Agent({ model: 'nvidia/a', cwd: HOME });
  const outs = [];
  for (let i = 0; i < 15; i++) outs.push(a.exploreGuard(i % 2 ? 'grep' : 'read_file', 'ok'));
  assert.ok(outs.slice(0, 14).every((o) => o === 'ok'));
  assert.match(outs[14], /15 leituras seguidas sem agir/);
  // agir (editar, rodar) zera a contagem; notas e plano não contam nem zeram
  a.exploreGuard('update_plan', 'ok');
  assert.strictEqual(a.exploring, 15);
  a.exploreGuard('edit_file', 'ok');
  assert.strictEqual(a.exploring, 0);
  assert.strictEqual(a.exploreGuard('read_file', 'ok'), 'ok');
});
