'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseResults, parseLite, realUrl, bingUrl } = require('../lib/websearch');
const { remember, forget, readUserMemory } = require('../lib/memory');
const { decide, ruleMatches, suggestRule, globMatch } = require('../lib/permissions');
const { Agent, systemPrompt } = require('../lib/agent');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-asst-'));
const withHome = async (fn) => {
  const old = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = tmp();
  try { return await fn(process.env.RFCODE_HOME); } finally { if (old === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = old; }
};
// API simulada: cada chamada devolve o próximo "roteiro" de chunks
function fakeApi(scripts) {
  const real = global.fetch;
  const bodies = [];
  let n = 0;
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const chunks = scripts[Math.min(n++, scripts.length - 1)];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return { ok: true, status: 200, body: [Buffer.from(body)] };
  };
  return { bodies, restore: () => { global.fetch = real; } };
}
const call = (id, name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }];
const say = (text) => [{ choices: [{ delta: { content: text } }] }];

test('web_search: lê resultados do DuckDuckGo, sem anúncios e com o endereço real', () => {
  const html = `
    <div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Anúncio</a></div>
    <div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Flearn&amp;rut=1">Node.js &amp; <b>WebSocket</b></a></h2>
    <a class="result__snippet" href="x">Cliente <b>nativo</b> no Node 22.</a></div>
    <div class="result results_links"><a class="result__a" href="https://example.com/b">B</a></div>`;
  const r = parseResults(html);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { title: 'Node.js & WebSocket', url: 'https://nodejs.org/learn', snippet: 'Cliente nativo no Node 22.' });
  assert.strictEqual(realUrl('https://duckduckgo.com/y.js?ad=1'), null);
  const lite = parseLite(`<a rel="nofollow" href="https://a.com/x" class='result-link'>Título A</a><td class='result-snippet'>Resumo A</td>`);
  assert.deepStrictEqual(lite, [{ title: 'Título A', url: 'https://a.com/x', snippet: 'Resumo A' }]);
  const enc = Buffer.from('https://www.climatempo.com.br/').toString('base64').replace(/=+$/, '');
  assert.strictEqual(bingUrl(`https://www.bing.com/ck/a?!&&p=1&u=a1${enc}&ntb=1`), 'https://www.climatempo.com.br/');
});

test('memória: guarda, não duplica, entra no prompt e esquece', () => withHome(() => {
  assert.match(remember('Prefere respostas curtas'), /Guardado/);
  assert.match(remember('prefere respostas curtas'), /Já estava/);
  remember('Trabalha com Python e Spark');
  assert.match(readUserMemory(), /- Prefere respostas curtas\n- Trabalha com Python e Spark/);
  assert.match(systemPrompt(os.tmpdir(), { pc: false }), /Memória sobre o usuário[\s\S]*Python e Spark/);
  assert.doesNotMatch(systemPrompt(os.tmpdir(), { pc: false, assistant: false }), /Python e Spark/, 'subagente não recebe a memória');
  assert.match(forget('python'), /1 linha/);
  assert.doesNotMatch(readUserMemory(), /Python/);
}));

test('permissões: allow, deny vence allow, glob de caminho e comando com argumentos', () => {
  const rules = { allow: ['run_command:npm test*', 'edit_file:src/**', 'web_fetch'], deny: ['run_command:rm *', 'run_command:npm test --danger*'] };
  assert.strictEqual(decide('run_command', { command: 'npm test' }, rules), 'allow');
  assert.strictEqual(decide('run_command', { command: 'npm test -- --watch=false' }, rules), 'allow');
  assert.strictEqual(decide('run_command', { command: 'npm test --danger x' }, rules), 'deny');
  assert.strictEqual(decide('run_command', { command: 'rm -rf /' }, rules), 'deny');
  assert.strictEqual(decide('run_command', { command: 'npm install' }, rules), 'ask');
  assert.strictEqual(decide('edit_file', { path: 'src/a/b.js' }, rules), 'allow');
  assert.strictEqual(decide('edit_file', { path: 'package.json' }, rules), 'ask');
  assert.strictEqual(decide('web_fetch', { url: 'https://x' }, rules), 'allow');
  assert.ok(globMatch('src/*.js', 'src/a.js') && !globMatch('src/*.js', 'src/x/a.js'));
  assert.ok(ruleMatches('*', 'write_file', {}));
  assert.strictEqual(suggestRule('run_command', { command: 'npm run build -- --prod' }), 'run_command:npm run*');
});

test('regra allow dispensa a aprovação e deny bloqueia mesmo no modo auto', () => withHome(async (home) => {
  const dir = tmp();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ allow: ['write_file:ok.txt'], deny: ['write_file:proibido.txt'] }));
  const api = fakeApi([call('a', 'write_file', { path: 'ok.txt', content: '1' }), call('b', 'write_file', { path: 'proibido.txt', content: '2' }), say('fim')]);
  try {
    const ag = new Agent({ apiKey: 'x', cwd: dir });
    let asked = 0;
    await ag.send('vai', { approve: async () => { asked++; return 'yes'; } });
    assert.strictEqual(asked, 0);
    assert.ok(fs.existsSync(path.join(dir, 'ok.txt')));
    assert.ok(!fs.existsSync(path.join(dir, 'proibido.txt')));
    assert.match(ag.messages.filter((m) => m.role === 'tool')[1].content, /regra "deny"/);
  } finally { api.restore(); }
}));

test('ask_user pergunta pela interface e devolve a resposta ao modelo', async () => {
  const api = fakeApi([call('q', 'ask_user', { question: 'Qual cor?', options: ['Azul', 'Verde'] }), say('ok')]);
  try {
    const ag = new Agent({ apiKey: 'x', cwd: tmp() });
    let got = null;
    await ag.send('escolha', { ask: async (q) => { got = q; return 'Verde'; } });
    assert.deepStrictEqual(got, { question: 'Qual cor?', options: ['Azul', 'Verde'] });
    assert.match(ag.messages.find((m) => m.role === 'tool').content, /Resposta do usuário: Verde/);
  } finally { api.restore(); }
});

test('task: subagente só com leitura devolve o relatório', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'leia.txt'), 'segredo: 42');
  // pai pede task -> filho lê arquivo -> filho responde -> pai responde
  const api = fakeApi([
    call('t', 'task', { description: 'achar o número', prompt: 'Qual o número em leia.txt?' }),
    call('r', 'read_file', { path: 'leia.txt' }),
    say('O número é 42 (leia.txt:1).'),
    say('Pronto: 42.'),
  ]);
  try {
    const ag = new Agent({ apiKey: 'x', cwd: dir });
    const out = [];
    await ag.send('descubra', { onCommandOutput: (t) => out.push(t) });
    const tool = ag.messages.find((m) => m.role === 'tool' && m.name === 'task');
    assert.match(tool.content, /Relatório do subagente[\s\S]*42/);
    const childTools = api.bodies[1].tools.map((t) => t.function.name);
    assert.ok(childTools.includes('read_file') && !childTools.includes('write_file') && !childTools.includes('task'), 'filho só lê');
    assert.ok(out.join('').includes('Read(leia.txt)'), 'progresso do filho aparece');
  } finally { api.restore(); }
});

test('comando em segundo plano: inicia, lê a saída e para', async () => {
  const ag = new Agent({ apiKey: 'x', cwd: tmp() });
  const cmd = `node -e "setInterval(()=>console.log('tick'),100)"`;
  assert.match(ag.run_command({ command: cmd, background: true }), /id bg1/);
  // espera ativa: com a suíte inteira rodando em paralelo, o processo pode demorar a começar
  const until = async (re, ms = 8000) => {
    const end = Date.now() + ms;
    let all = '';
    while (Date.now() < end) {
      all += await ag.command_output({ id: 'bg1' });
      if (re.test(all)) return all;
    }
    return all;
  };
  assert.match(await until(/tick/), /ainda rodando[\s\S]*tick/);
  assert.match(ag.command_stop({ id: 'bg1' }), /Parado/);
  assert.match(await until(/terminou/), /terminou/);
  ag.stopBackground();
});

test('proposedContent mostra o arquivo depois da edição, sem gravar', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'um\ndois\n');
  const ag = new Agent({ apiKey: 'x', cwd: dir });
  const p = ag.proposedContent('edit_file', { path: 'a.txt', old_string: 'dois', new_string: 'DOIS' });
  assert.strictEqual(p.after, 'um\nDOIS\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'um\ndois\n');
  assert.strictEqual(ag.proposedContent('write_file', { path: 'novo.txt', content: 'x' }).before, '');
});

test('resposta vazia: pede de novo uma vez', async () => {
  const api = fakeApi([call('a', 'list_dir', {}), say(''), say('agora sim')]);
  try {
    const ag = new Agent({ apiKey: 'x', cwd: tmp() });
    await ag.send('liste');
    assert.strictEqual(ag.messages[ag.messages.length - 1].content, 'agora sim');
  } finally { api.restore(); }
});

test('extraTools: a interface injeta ferramentas', async () => {
  const api = fakeApi([call('d', 'get_diagnostics', {}), say('ok')]);
  try {
    const ag = new Agent({
      apiKey: 'x', cwd: tmp(),
      extraTools: { defs: [{ name: 'get_diagnostics', description: 'd', parameters: { type: 'object', properties: {} } }], run: async () => 'a.js:1: [erro] x' },
    });
    await ag.send('veja');
    assert.ok(api.bodies[0].tools.some((t) => t.function.name === 'get_diagnostics'));
    assert.match(ag.messages.find((m) => m.role === 'tool').content, /\[erro\]/);
  } finally { api.restore(); }
});
