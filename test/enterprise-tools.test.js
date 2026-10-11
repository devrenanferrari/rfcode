'use strict';
// Dados, Excel, git completo, HTTP, conectores MCP, política, hooks e auditoria.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const tmp = (p = 'rf-ent-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');

test('data_query: descreve, consulta, cruza arquivos e grava xlsx', () => {
  const { dataQuery } = require('../lib/data');
  const { readXlsx } = require('../lib/xlsx');
  const d = tmp();
  fs.writeFileSync(path.join(d, 'vendas.csv'), 'Região;Mês;Receita\nSul;jan;"1.250,50"\nNorte;jan;800\nSul;fev;1000\n');
  fs.writeFileSync(path.join(d, 'metas.json'), JSON.stringify([{ regiao: 'Sul', meta: 2000 }, { regiao: 'Norte', meta: 1000 }]));
  const desc = dataQuery({ files: 'vendas.csv' }, d);
  assert.match(desc, /regiao \(original: "Região"\) texto/);
  assert.match(desc, /receita número: .*soma 3050.5/);
  const r = dataQuery({ files: { v: 'vendas.csv', m: 'metas.json' }, sql: 'SELECT v.regiao, SUM(receita) AS total, m.meta FROM v JOIN m USING(regiao) GROUP BY 1 ORDER BY 2 DESC', save: 'out.xlsx' }, d);
  assert.match(r, /2 linhas gravadas/);
  const rows = readXlsx(path.join(d, 'out.xlsx'))[0].rows;
  assert.deepStrictEqual(rows[1], ['Sul', 2250.5, 2000]);
  assert.throws(() => dataQuery({ files: 'vendas.csv', sql: 'SELECT nada FROM vendas' }, d), /no such column.*tabelas: vendas/);
});

test('create_xlsx: formatos, fórmulas, datas, totais e códigos com zero à esquerda', () => {
  const { createXlsx, readXlsx } = require('../lib/xlsx');
  const { readZip } = require('../lib/zip');
  const f = path.join(tmp(), 'p.xlsx');
  createXlsx(f, { sheets: [{ name: 'Vendas', columns: ['Código', 'Data', 'Valor', 'Margem'], rows: [['007', '2026-01-31', 10, 0.5], ['008', '2026-02-28', '20,5', 0.3]], formats: { Valor: 'moeda', Margem: 'percentual' }, totals: true }] });
  const zip = readZip(fs.readFileSync(f));
  const sheet = zip.get('xl/worksheets/sheet1.xml').toString();
  assert.match(sheet, /<f>SUM\(C2:C3\)<\/f>/);
  assert.match(sheet, /<f>AVERAGE\(D2:D3\)<\/f>/, 'percentual usa média no total');
  assert.match(sheet, /<pane ySplit="1"/);
  assert.match(sheet, /<autoFilter/);
  assert.match(zip.get('xl/styles.xml').toString(), /R\$/);
  const rows = readXlsx(f)[0].rows;
  assert.deepStrictEqual(rows[1], ['007', '2026-01-31', 10, 0.5]);
  assert.strictEqual(rows[2][2], 20.5);
});

test('git completo: branch, merge com conflito, continue, stash e aprovação só para escrita', () => {
  const g = require('../lib/tools/git-plus');
  const d = tmp('rf-git-');
  const sh = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't'); sh('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\n1\n'); sh('add', '.'); sh('commit', '-qm', 'a');
  g.run('git_branch', { action: 'create', name: 'feat' }, { cwd: d });
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\nfeat\n'); sh('commit', '-qam', 'f');
  g.run('git_branch', { action: 'switch', name: 'main' }, { cwd: d });
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\nmain\n'); sh('commit', '-qam', 'm');
  const out = g.run('git_merge', { action: 'merge', branch: 'feat' }, { cwd: d });
  assert.match(out, /a\.txt \(1 conflito/);
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\nok\n');
  g.run('git_merge', { action: 'continue' }, { cwd: d });
  assert.match(g.run('git_conflicts', {}, { cwd: d }), /Nenhum conflito/);
  fs.writeFileSync(path.join(d, 'b.txt'), 'novo');
  g.run('git_stash', { action: 'push', message: 'wip' }, { cwd: d });
  assert.match(g.run('git_stash', { action: 'list' }, { cwd: d }), /wip/);
  assert.throws(() => g.run('git_branch', { action: 'create', name: '--force' }, { cwd: d }), /Nome inválido/);
  assert.strictEqual(g.needsApproval('git_branch', { action: 'list' }), false);
  assert.strictEqual(g.needsApproval('git_sync', { action: 'push' }), true);
  assert.strictEqual(g.needsApproval('github', { action: 'pr_view' }), false);
  assert.strictEqual(g.needsApproval('github', { action: 'pr_merge' }), true);
});

test('http_request: segredo por referência some da resposta; falta de segredo explica como configurar', async () => {
  const h = require('../lib/tools/http');
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ auth: q.headers.authorization, url: q.url })); });
  await new Promise((r) => srv.listen(0, r));
  process.env.RF_TEST_TOKEN = 'abc-segredo-123';
  try {
    const out = await h.run('http_request', { url: `http://127.0.0.1:${srv.address().port}/x`, query: { p: 2 }, headers: { Authorization: 'Bearer {{RF_TEST_TOKEN}}' } }, { cwd: tmp() });
    assert.match(out, /HTTP 200/);
    assert.match(out, /Bearer \*\*\*/);
    assert.doesNotMatch(out, /abc-segredo/);
    assert.match(out, /\/x\?p=2/);
    await assert.rejects(h.run('http_request', { url: 'http://127.0.0.1:1/', headers: { a: '{{RF_FALTA}}' } }, { cwd: '.' }), /RF_FALTA}} não configurado/);
  } finally { srv.close(); }
});

test('conectores MCP: stdio e HTTP, formato do VS Code, aprovação por leitura/escrita', async () => {
  const { McpManager } = require('../lib/mcp');
  const home = tmp('rf-mcp-');
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  const server = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'mcp-server.js'), '--http']);
  const port = await new Promise((r) => server.stdout.once('data', (x) => r(String(x).trim())));
  try {
    const proj = path.join(home, 'proj');
    fs.mkdirSync(path.join(proj, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-server.js')] } } }));
    process.env.RF_MCP_TOK = 'tok';
    fs.writeFileSync(path.join(proj, '.vscode', 'mcp.json'), JSON.stringify({ servers: { remoto: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer ${env:RF_MCP_TOK}' } } } }));
    const m = new McpManager(proj);
    await m.start(20000);
    assert.match(m.status(), /local .*conectado, 2 ferramentas/);
    assert.match(m.status(), /remoto .*conectado, 2 ferramentas/);
    assert.strictEqual(await m.call('mcp__local__somar', { a: 2, b: 40 }), '42');
    assert.match(await m.call('mcp__remoto__criar_tarefa', { titulo: 'X' }), /Tarefa #1 criada: X/);
    assert.strictEqual(m.needsApproval('mcp__local__somar'), false, 'readOnlyHint dispensa aprovação');
    assert.strictEqual(m.needsApproval('mcp__local__criar_tarefa'), true);
    m.closeAll();
  } finally {
    server.kill();
    if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old;
  }
});

test('/mcp add grava o conector do catálogo e /mcp lista', () => {
  const home = tmp('rf-mcpc-');
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try {
    const { mcpCommand, parseCommand } = require('../lib/commands');
    assert.strictEqual(parseCommand('/conectores').name, 'mcp');
    const r = mcpCommand('add powerbi', { cwd: home });
    assert.match(r.text, /accept_eula/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8'));
    assert.deepStrictEqual(cfg.mcpServers.powerbi.args, ['-y', '@microsoft/powerbi-modeling-mcp@latest', '--start']);
    assert.match(mcpCommand('', { cwd: home }).text, /powerbi: será conectado/);
    mcpCommand('add meu https://exemplo.com/mcp projeto', { cwd: home });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.rfcode', 'mcp.json'), 'utf8')).mcpServers.meu.type, 'http');
  } finally { if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old; }
});

test('política da empresa, hooks e auditoria', () => {
  const home = tmp('rf-pol-');
  const env = { ...process.env };
  process.env.RFCODE_HOME = home;
  process.env.RFCODE_POLICY = path.join(home, 'policy.json');
  try {
    fs.writeFileSync(process.env.RFCODE_POLICY, JSON.stringify({ disabledTools: ['browser'], deny: ['run_command:rm *'], allowedProviders: ['nvidia'], disableAutoApprove: true }));
    const ent = require('../lib/enterprise');
    ent.resetPolicyCache();
    const proj = path.join(home, 'p');
    fs.mkdirSync(path.join(proj, '.rfcode'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.rfcode', 'settings.json'), JSON.stringify({ allow: ['run_command:rm *'], hooks: { preTool: [{ match: 'write_file', command: `"${process.execPath}" -e "process.stderr.write('proibido');process.exit(2)"` }] } }));
    const { Agent } = require('../lib/agent');
    const a = new Agent({ apiKey: 'x', cwd: proj });
    assert.ok(!a.toolDefs.some((t) => t.name === 'browser'));
    const { decide, loadRules } = require('../lib/permissions');
    assert.strictEqual(decide('run_command', { command: 'rm -rf x' }, loadRules(proj)), 'deny');
    a.model = 'openai:gpt-5';
    assert.throws(() => a.endpoint(), /não é permitido pela política/);
    assert.deepStrictEqual(ent.preToolHooks(proj, 'write_file', { path: 'a' }), { block: 'proibido' });
    assert.strictEqual(ent.preToolHooks(proj, 'read_file', { path: 'a' }), null);
  } finally {
    for (const k of ['RFCODE_HOME', 'RFCODE_POLICY']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    require('../lib/enterprise').resetPolicyCache();
  }
});

test('guias entram no prompt só quando o assunto aparece', () => {
  const { Agent } = require('../lib/agent');
  const a = new Agent({ apiKey: 'x' });
  assert.strictEqual(a.guides(), '');
  a.activateFor('crie medidas DAX no Power BI a partir de vendas.csv');
  assert.match(a.guides(), /# Power BI/);
  assert.match(a.guides(), /# Dados e planilhas/);
  assert.ok(a.requestTools().some((t) => t.name === 'data_query'));
});
