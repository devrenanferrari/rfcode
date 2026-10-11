'use strict';
// Dashboards, agendamentos, exportação, skills e /entender.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-r14-'));

test('dashboard: HTML único com dados embutidos, tipos deduzidos e erro claro para coluna errada', async () => {
  const { createDashboard } = require('../lib/dashboard');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'v.csv'), 'mes;regiao;receita\n2026-01;Sul;100\n2026-01;Norte;50\n2026-02;Sul;120\n');
  const r = await createDashboard(path.join(d, 'p.html'), {
    title: 'Vendas <teste>', data: 'v.csv', filters: ['regiao'],
    widgets: [{ title: 'Receita', field: 'receita', agg: 'sum' }, { title: 'Por mês', x: 'mes', y: 'receita' }, { title: 'Pizza', type: 'pizza', x: 'regiao', y: 'receita' }, { columns: ['mes', 'receita'] }],
  }, d);
  assert.strictEqual(r.widgets, 4);
  assert.strictEqual(r.rows, 3);
  const html = fs.readFileSync(path.join(d, 'p.html'), 'utf8');
  assert.ok(!/<script src=|https?:\/\/cdn/.test(html), 'não depende de internet');
  assert.match(html, /<title>Vendas &lt;teste&gt;<\/title>/);
  const P = JSON.parse(/const P=(\{.*?\});\nconst NICE/s.exec(html)[1]);
  assert.deepStrictEqual(P.widgets.map((w) => w.type), ['kpi', 'chart', 'chart', 'table']);
  assert.strictEqual(P.widgets[2].chart, 'pie');
  assert.strictEqual(P.datasets.default[2].receita, 120);
  await assert.rejects(createDashboard(path.join(d, 'x.html'), { data: 'v.csv', widgets: [{ x: 'cidade', y: 'receita' }] }, d), /coluna "cidade" não existe. Colunas: mes, regiao, receita/);
  // com SQL
  await createDashboard(path.join(d, 's.html'), { data: { files: { v: 'v.csv' }, sql: 'SELECT regiao, SUM(receita) AS total FROM v GROUP BY 1' }, widgets: [{ type: 'chart', chart: 'bar', x: 'regiao', y: 'total' }] }, d);
  assert.match(fs.readFileSync(path.join(d, 's.html'), 'utf8'), /"total":220/);
});

test('agendamentos: frases em português viram regras e cron', () => {
  const { parseWhen, toCron } = require('../lib/schedule');
  const now = new Date('2026-10-11T15:30:00');
  const t = (q) => { const w = parseWhen(q, now); return [w.label, toCron(w)]; };
  assert.deepStrictEqual(t('todo dia às 9h'), ['todo dia às 09:00', '0 9 * * *']);
  assert.deepStrictEqual(t('dias úteis às 8h30'), ['dias úteis às 08:30', '30 8 * * 1,2,3,4,5']);
  assert.deepStrictEqual(t('toda segunda e quinta às 14:30'), ['segunda, quinta às 14:30', '30 14 * * 1,4']);
  assert.deepStrictEqual(t('a cada 30 minutos'), ['a cada 30 min', '*/30 * * * *']);
  assert.deepStrictEqual(t('amanhã às 7h'), ['uma vez em 12/10/2026 às 07:00', '0 7 12 10 *']);
  assert.deepStrictEqual(t('toda sexta às 6 da tarde'), ['sexta às 18:00', '0 18 * * 5']);
  assert.throws(() => parseWhen('a cada 1 minuto', now), /mínimo é de 5 minutos/);
  assert.throws(() => parseWhen('qualquer coisa', now), /Não entendi quando/);
});

test('/agendar sem registrar no sistema grava e lista', () => {
  const home = tmp();
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try {
    const sched = require('../lib/schedule');
    const job = sched.add({ when: 'dias úteis às 8h', task: 'resuma os pull requests', cwd: home, register: false });
    assert.match(sched.listText(), new RegExp(`${job.id}  dias úteis às 08:00  resuma os pull requests`));
    sched.recordRun(job.id, { inicio: new Date().toISOString(), ok: true, saida: 'x.md' });
    assert.strictEqual(sched.list()[0].execucoes.length, 1);
    const { scheduleCommand } = require('../lib/commands');
    assert.match(scheduleCommand('', { cwd: home }).text, /resuma os pull requests/);
    assert.match(scheduleCommand('qualquer coisa sem separador', { cwd: home }).text, /Uso: \/agendar/);
  } finally { if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old; }
});

test('/export grava a conversa em Markdown', () => {
  const { exportConversation } = require('../lib/commands');
  const d = tmp();
  const agent = { model: 'm', cwd: d, messages: [
    { role: 'user', content: 'corrija o bug' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', content: 'conteúdo' },
    { role: 'assistant', content: 'Corrigido.' },
  ] };
  const out = exportConversation(agent, 'conversa.md');
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /## Você\n\ncorrija o bug/);
  assert.match(md, /- `Read\(a\.js\)`/);
  assert.match(md, /## rfcode\n\nCorrigido\./);
});

test('skills: lista, carrega com arquivos de apoio e entra no prompt por palavra-chave', () => {
  const d = tmp();
  const dir = path.join(d, '.rfcode', 'skills', 'deploy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: Como fazemos deploy em produção\nkeywords: deploy, publicar\n---\n# Deploy\n1. rode os testes\n');
  fs.writeFileSync(path.join(dir, 'checklist.md'), '- item');
  const skills = require('../lib/skills');
  assert.deepStrictEqual(skills.listSkills(d).map((s) => s.name), ['deploy']);
  const body = skills.loadSkill(d, 'deploy');
  assert.match(body, /# Skill: deploy/);
  assert.match(body, /checklist\.md/);
  assert.match(skills.skillsPrompt(d), /- deploy: Como fazemos deploy em produção/);
  const { Agent } = require('../lib/agent');
  const a = new Agent({ apiKey: 'x', cwd: d });
  a.activateFor('faça o deploy da versão nova');
  assert.match(a.guides(), /# Skill: deploy/);
  const { skillsCommand } = require('../lib/commands');
  assert.match(skillsCommand('criar como revisar contratos', { cwd: d }).send, /SKILL\.md/);
});
