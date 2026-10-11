'use strict';
// Missões: ciclos com contexto limpo, plano salvo em disco, conclusão verificada e parada.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// o agente lê a pasta de configuração ao carregar o módulo: uma pasta para o arquivo todo
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-mis-'));
process.env.RFCODE_HOME = HOME;
process.env.RFCODE_NO_LOG = '1';

// provedor falso com roteiro: responde conforme o que está na conversa
function fakeProvider(script) {
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => {
      const body = JSON.parse(b);
      const msgs = body.messages;
      const reply = script(msgs) || { text: 'ok' };
      r.setHeader('content-type', 'text/event-stream');
      if (reply.tool) {
        r.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Date.now()}${Math.random()}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } }] })}\n\n`);
      } else {
        r.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`);
      }
      r.end('data: [DONE]\n\n');
    });
  });
  return srv;
}

test('missão: ciclo com plano, continuação com contexto limpo, conclusão e relatório', async () => {
  const seen = [];
  const srv = fakeProvider((msgs) => {
    const first = msgs.find((m) => m.role === 'user').content;
    const last = msgs[msgs.length - 1];
    const cycle2 = first.startsWith('CONTINUAÇÃO');
    if (!seen.includes(first.slice(0, 30))) seen.push(first.slice(0, 30));
    if (!cycle2) {
      if (last.role === 'user') return { tool: 'update_plan', args: { goal: 'criar arquivos', steps: [{ text: 'criar a.txt', status: 'active' }, { text: 'criar b.txt', status: 'pending' }] } };
      if (last.name === 'update_plan') return { tool: 'write_file', args: { path: 'a.txt', content: 'A' } };
      if (last.name === 'write_file') return { tool: 'note', args: { text: 'a.txt criado; falta b.txt' } };
      if (last.name === 'note') return { tool: 'update_plan', args: { steps: [{ text: 'criar a.txt', status: 'done' }, { text: 'criar b.txt', status: 'pending' }] } };
      return { text: 'Parei aqui; continuo no próximo ciclo.' };
    }
    // ciclo 2: recebeu plano e notas do disco
    assert.match(first, /\[feito\] criar a\.txt/);
    assert.match(first, /a\.txt criado; falta b\.txt/);
    if (last.role === 'user') return { tool: 'write_file', args: { path: 'b.txt', content: 'B' } };
    if (last.name === 'write_file') return { tool: 'update_plan', args: { steps: [{ text: 'criar a.txt', status: 'done' }, { text: 'criar b.txt', status: 'done' }] } };
    return { text: 'MISSÃO CONCLUÍDA\nCriei a.txt e b.txt; confira com dir.' };
  });
  await new Promise((ok) => srv.listen(0, ok));
  const home = HOME;
  const proj = fs.mkdtempSync(path.join(home, 'p1-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrls: { custom: `http://127.0.0.1:${srv.address().port}/v1` } }));
    const mission = require('../lib/mission');
    const { Agent } = require('../lib/agent');
    const m = mission.create(proj, { objetivo: 'criar os arquivos a.txt e b.txt', horas: 1, git: false, modelo: 'custom:x' });
    const done = await mission.run(proj, m.id, { log: () => {}, createAgent: ({ model }) => new Agent({ model, cwd: proj }) });
    assert.strictEqual(done.status, 'concluida');
    assert.strictEqual(done.ciclos, 2);
    assert.strictEqual(seen.length, 2, 'cada ciclo começa com uma conversa nova');
    assert.strictEqual(fs.readFileSync(path.join(proj, 'b.txt'), 'utf8'), 'B');
    const rel = fs.readFileSync(path.join(proj, '.rfcode', 'missoes', m.id, 'relatorio.md'), 'utf8');
    assert.match(rel, /Criei a\.txt e b\.txt/);
    assert.match(fs.readFileSync(path.join(proj, '.rfcode', 'missoes', m.id, 'diario.md'), 'utf8'), /Ciclo 1: .*plano 1\/2/);
    assert.match(mission.status(proj, m.id), /concluida[\s\S]*plano: 2\/2/);
  } finally { srv.close(); }
});

test('missão: "concluída" com passos pendentes é recusada; PARAR encerra', async () => {
  let calls = 0;
  const srv = fakeProvider((msgs) => {
    calls++;
    const last = msgs[msgs.length - 1];
    const first = msgs.find((m) => m.role === 'user').content;
    if (!first.startsWith('CONTINUAÇÃO') && last.role === 'user') return { tool: 'update_plan', args: { steps: [{ text: 'passo 1', status: 'pending' }] } };
    if (first.includes('ATENÇÃO: Você declarou a missão concluída')) {
      fs.writeFileSync(path.join(stopDir.value, 'PARAR'), 'x'); // usuário manda parar
      return { text: 'Ok, vou continuar.' };
    }
    return { text: 'MISSÃO CONCLUÍDA (mas o plano não terminou)' };
  });
  const stopDir = { value: '' };
  await new Promise((ok) => srv.listen(0, ok));
  const home = HOME;
  const proj = fs.mkdtempSync(path.join(home, 'p2-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrls: { custom: `http://127.0.0.1:${srv.address().port}/v1` } }));
    const mission = require('../lib/mission');
    const { Agent } = require('../lib/agent');
    const m = mission.create(proj, { objetivo: 'missão de teste com plano', horas: 1, git: false, modelo: 'custom:x' });
    stopDir.value = path.join(proj, '.rfcode', 'missoes', m.id);
    const done = await mission.run(proj, m.id, { log: () => {}, createAgent: ({ model }) => new Agent({ model, cwd: proj }) });
    assert.strictEqual(done.status, 'parada');
    assert.ok(done.ciclos >= 2);
    assert.ok(calls < 20);
  } finally { srv.close(); }
});
