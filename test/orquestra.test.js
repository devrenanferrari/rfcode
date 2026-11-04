'use strict';
// Orquestra: quadro com várias sessões em paralelo ou em sequência (lib/orquestra.js e lib/orquestra-server.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const orq = require('../lib/orquestra');
const { OrquestraServer, startOrquestra, pageHtml } = require('../lib/orquestra-server');
const { parseCommand } = require('../lib/commands');

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-orq-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-orq-work-'));
  const prev = process.env.RFCODE_HOME;
  process.env.RFCODE_HOME = home;
  try { await fn(home, work); } finally {
    if (prev === undefined) delete process.env.RFCODE_HOME; else process.env.RFCODE_HOME = prev;
    cleanup(home); cleanup(work);
  }
}

// Agente falso: registra o pedido, espera um pouco e responde "fiz: <primeira linha>".
function fakeAgents({ delay = 30, onSend } = {}) {
  const calls = [];
  let active = 0;
  const stats = { max: 0, created: 0 };
  const createAgent = ({ cwd, model, extraTools }) => {
    stats.created++;
    return {
      cwd, model, extraTools, usage: { total: 0 }, messages: [], busy: false, autoApprove: false, aborted: false,
      sessionManager: { id: `s${stats.created}`, load: () => null },
      abort() { this.aborted = true; },
      queue(t) { (this.queued ||= []).push(t); return this.queued.length; },
      async send(prompt, h) {
        this.busy = true;
        active++; stats.max = Math.max(stats.max, active);
        calls.push({ prompt, cwd, agent: this, at: Date.now() });
        this.messages.push({ role: 'user', content: prompt });
        try {
          if (onSend) { const r = await onSend(this, prompt, h); if (r === 'abort') { h.onAborted(); return; } }
          await sleep(delay);
          if (this.aborted) { h.onAborted(); return; }
          const reply = `fiz: ${prompt.split('\n')[0]}`;
          h.onText(reply);
          h.onAssistantEnd();
          this.messages.push({ role: 'assistant', content: reply });
          this.usage.total += 100;
        } finally { active--; this.busy = false; }
      },
    };
  };
  return { createAgent, calls, stats };
}

// Espera a execução do quadro terminar.
function finished(o, boardId, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('a execução não terminou')), timeout);
    const on = (ev) => { if (ev.type === 'execucao' && ev.quadro === boardId && !ev.rodando) { clearTimeout(t); o.off('evento', on); resolve(o.board(boardId)); } };
    o.on('evento', on);
  });
}

function board(o, work, caixas, ligacoes, config = {}) {
  const b = o.create({ nome: 'teste', repos: [{ caminho: work }] });
  const r = b.repos[0].id;
  return o.update(b.id, { ...b, config: { ...b.config, ...config }, caixas: caixas.map((c) => ({ repo: c.tipo === 'nota' ? undefined : r, ...c })), ligacoes });
}
const st = (b) => Object.fromEntries(b.caixas.map((c) => [c.id, c.status]));

// ---------- quadro e grafo ----------
test('normalizeBoard limpa o que vem do navegador: tipos, ligações inválidas, duplicadas e ciclos', () => {
  const b = orq.normalizeBoard({
    nome: '', repos: [{ id: 'r1', caminho: '/x/app' }, { caminho: '' }],
    caixas: [
      { id: 'a', tipo: 'sessao', repo: 'r1', x: '10', y: 'abc', auto: 'sim' },
      { id: 'b', tipo: 'xyz', repo: 'nao-existe' },
      { id: 'c', tipo: 'comando', limite: 99999 },
      { id: 'n', tipo: 'nota', texto: 'oi' },
      { id: 'a', tipo: 'sessao' }, // id repetido ganha outro
    ],
    ligacoes: [
      { de: 'a', para: 'b' }, { de: 'a', para: 'b' }, { de: 'b', para: 'c', quando: 'falha' }, { de: 'c', para: 'a' },
      { de: 'a', para: 'a' }, { de: 'a', para: 'zzz' }, { de: 'n', para: 'a' }, { de: 'a', para: 'n' }, { de: 'b', para: 'c', quando: 'xx' },
    ],
    config: { paralelo: 99 },
  });
  assert.strictEqual(b.nome, 'Quadro sem nome');
  assert.strictEqual(b.repos.length, 1);
  assert.deepStrictEqual(b.caixas.map((c) => c.tipo), ['sessao', 'sessao', 'comando', 'nota', 'sessao']);
  assert.strictEqual(new Set(b.caixas.map((c) => c.id)).size, 5);
  assert.strictEqual(b.caixas[0].x, 10);
  assert.strictEqual(b.caixas[0].y, 0);
  assert.strictEqual(b.caixas[0].auto, true);
  assert.strictEqual(b.caixas[1].repo, null, 'repositório que não existe no quadro vira null');
  assert.strictEqual(b.caixas[2].limite, 24 * 60);
  assert.strictEqual(b.caixas[0].status, 'ociosa');
  assert.strictEqual(b.caixas[3].status, undefined, 'nota não tem status');
  // a->b, b->c (falha), n->a e a->n ficam; duplicada, laço, destino inexistente e o c->a (ciclo) saem
  assert.deepStrictEqual(b.ligacoes.map((e) => `${e.de}>${e.para}:${e.quando}`), ['a>b:sucesso', 'b>c:falha', 'n>a:sucesso', 'a>n:sucesso']);
  assert.strictEqual(b.config.paralelo, 8);
});

test('ciclo só conta entre caixas que rodam: nota ligada nos dois sentidos não é ciclo', () => {
  const b = orq.normalizeBoard({ caixas: [{ id: 'a' }, { id: 'b' }, { id: 'n', tipo: 'nota' }], ligacoes: [{ de: 'a', para: 'b' }, { de: 'b', para: 'n' }] });
  assert.strictEqual(orq.wouldCycle(b, 'b', 'a'), true);
  assert.strictEqual(orq.wouldCycle(b, 'n', 'a'), false);
  assert.strictEqual(orq.wouldCycle(b, 'a', 'a'), true);
  assert.deepStrictEqual(orq.depEdges(b).map((e) => `${e.de}>${e.para}`), ['a>b']);
});

test('todos os modelos de quadro viram quadros válidos, com as ligações intactas', () => {
  for (const key of Object.keys(orq.MODELOS)) {
    const t = orq.MODELOS[key];
    const b = orq.normalizeBoard({ repos: [{ id: 'r1', caminho: '/x' }], ...orq.fromTemplate(key, [{ id: 'r1' }]) });
    assert.strictEqual(b.caixas.length, t.caixas.length, key);
    assert.strictEqual(b.ligacoes.length, t.ligacoes.length, `${key}: alguma ligação foi descartada`);
    for (const c of b.caixas) if (c.tipo !== 'nota') assert.strictEqual(c.repo, 'r1', `${key}: caixa sem repositório`);
  }
});

test('buildPrompt junta o pedido, o resultado das etapas anteriores e as notas ligadas', () => {
  const b = orq.normalizeBoard({
    nome: 'Q', repos: [{ id: 'r1', caminho: '/x/app', nome: 'app' }],
    caixas: [
      { id: 'a', titulo: 'Back', repo: 'r1', status: 'concluida', resultado: 'API pronta em /api/cupom', branch: 'rfcode/back-1' },
      { id: 'b', titulo: 'Front', repo: 'r1', prompt: 'Faça a tela do cupom' },
      { id: 'n', tipo: 'nota', titulo: 'Spec', texto: 'Cupom de 10%' },
      { id: 'z', titulo: 'Solta', repo: 'r1', status: 'concluida', resultado: 'NÃO DEVE APARECER' },
    ],
    ligacoes: [{ de: 'a', para: 'b' }, { de: 'n', para: 'b' }],
  });
  const p = orq.buildPrompt(b, b.caixas[1], { repo: b.repos[0], cwd: '/x/app' });
  assert.match(p, /^Faça a tela do cupom/);
  assert.match(p, /### Back \(concluída, app, branch rfcode\/back-1\)\nAPI pronta em \/api\/cupom/);
  assert.match(p, /### Nota "Spec"\nCupom de 10%/);
  assert.match(p, /nota_ler e nota_escrever/);
  assert.doesNotMatch(p, /NÃO DEVE APARECER/);
});

// ---------- execução ----------
test('caixas sem ligação rodam em paralelo até o limite; ligadas esperam e recebem o resultado', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents({ delay: 60 });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [
      { id: 'a', tipo: 'sessao', titulo: 'A', prompt: 'tarefa A' },
      { id: 'b', tipo: 'sessao', titulo: 'B', prompt: 'tarefa B' },
      { id: 'c', tipo: 'sessao', titulo: 'C', prompt: 'tarefa C' },
      { id: 'd', tipo: 'sessao', titulo: 'D', prompt: 'juntar' },
    ], [{ de: 'a', para: 'd' }, { de: 'b', para: 'd' }, { de: 'c', para: 'd' }], { paralelo: 2 });
    const done = finished(o, b.id);
    o.run(b.id);
    const end = await done;
    assert.deepStrictEqual(st(end), { a: 'concluida', b: 'concluida', c: 'concluida', d: 'concluida' });
    assert.strictEqual(f.stats.max, 2, 'respeita o limite de 2 ao mesmo tempo');
    const last = f.calls[f.calls.length - 1];
    assert.match(last.prompt, /^juntar/);
    for (const x of ['A', 'B', 'C']) assert.match(last.prompt, new RegExp(`### ${x} \\(concluída[^)]*\\)\\nfiz: tarefa ${x}`));
    assert.strictEqual(end.caixas.find((c) => c.id === 'd').resultado, 'fiz: juntar');
    assert.strictEqual(end.caixas.find((c) => c.id === 'a').tokens, 100);
    // gravado em disco
    const disk = orq.readBoard(b.id);
    assert.strictEqual(disk.caixas.find((c) => c.id === 'd').status, 'concluida');
  });
});

test('paralelo 1 = tudo em sequência, uma caixa de cada vez', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents({ delay: 20 });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }, { id: 'c', prompt: 'c' }], [], { paralelo: 1 });
    const done = finished(o, b.id);
    o.run(b.id);
    await done;
    assert.strictEqual(f.stats.max, 1);
    assert.strictEqual(f.calls.length, 3);
  });
});

test('comando que falha segue pela ligação "se falhar" e pula a de "se der certo"', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents();
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const node = JSON.stringify(process.execPath);
    const b = board(o, work, [
      { id: 't', tipo: 'comando', titulo: 'Testes', comando: `${node} -e "console.log('2 falharam'); process.exit(3)"` },
      { id: 'fix', tipo: 'sessao', titulo: 'Corrigir', prompt: 'corrija' },
      { id: 'pr', tipo: 'sessao', titulo: 'PR', prompt: 'abra o PR' },
      { id: 'pos', tipo: 'sessao', titulo: 'Depois do PR', prompt: 'depois' },
      { id: 'sempre', tipo: 'sessao', titulo: 'Sempre', prompt: 'sempre' },
    ], [{ de: 't', para: 'fix', quando: 'falha' }, { de: 't', para: 'pr' }, { de: 'pr', para: 'pos' }, { de: 't', para: 'sempre', quando: 'sempre' }]);
    const done = finished(o, b.id);
    o.run(b.id);
    const end = await done;
    assert.deepStrictEqual(st(end), { t: 'falhou', fix: 'concluida', pr: 'pulada', pos: 'pulada', sempre: 'concluida' });
    const t = end.caixas.find((c) => c.id === 't');
    assert.strictEqual(t.codigo, 3);
    assert.match(t.resultado, /2 falharam/);
    assert.match(f.calls.find((c) => /^corrija/.test(c.prompt)).prompt, /2 falharam/, 'a saída do comando vira contexto da correção');
    assert.match(end.caixas.find((c) => c.id === 'pr').erro, /Testes" falhou/);
    assert.ok(o.logOf(b.id, 't').some((e) => e.type === 'output' && /2 falharam/.test(e.text)));
  });
});

test('"rodar a partir daqui" roda a caixa e as seguintes; "só esta" usa o resultado anterior como contexto', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents({ delay: 5 });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }, { id: 'c', prompt: 'c' }, { id: 'x', prompt: 'x' }],
      [{ de: 'a', para: 'b' }, { de: 'b', para: 'c' }]);
    let done = finished(o, b.id);
    o.run(b.id, { ids: ['b'], modo: 'daqui' });
    let end = await done;
    assert.deepStrictEqual(st(end), { a: 'ociosa', b: 'concluida', c: 'concluida', x: 'ociosa' });
    done = finished(o, b.id);
    o.run(b.id, { ids: ['c'], modo: 'so' });
    end = await done;
    assert.match(f.calls[f.calls.length - 1].prompt, /fiz: b/);
    assert.strictEqual(f.calls.length, 3);
  });
});

test('aprovações e perguntas ficam pendentes até a resposta pelo quadro', async () => {
  await withHome(async (home, work) => {
    const decisions = [];
    const f = fakeAgents({
      onSend: async (agent, prompt, h) => {
        decisions.push(await h.approve({ id: 't1', name: 'edit_file', label: 'Editar a.js', args: { path: 'a.js' }, preview: { removed: ['x'], added: ['y'] } }));
        decisions.push(await h.ask({ question: 'Qual banco?', options: ['Postgres', 'SQLite'] }));
      },
    });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }], []);
    const pedidos = [];
    o.on('evento', (ev) => { if (ev.type === 'pedido') pedidos.push(ev.pedido); });
    const done = finished(o, b.id);
    o.run(b.id);
    while (pedidos.length < 1) await sleep(5);
    assert.strictEqual(pedidos[0].tipo, 'aprovacao');
    assert.strictEqual(pedidos[0].label, 'Editar a.js');
    assert.deepStrictEqual(pedidos[0].preview, { removed: ['x'], added: ['y'] });
    assert.strictEqual(pedidos[0].regra, 'edit_file:a.js');
    assert.strictEqual(o.snapshot(b.id).pendentes.length, 1);
    assert.ok(o.answer(pedidos[0].id, 'all'));
    assert.strictEqual(o.answer(pedidos[0].id, 'yes'), false, 'não responde duas vezes');
    while (pedidos.length < 2) await sleep(5);
    assert.deepStrictEqual(pedidos[1].opcoes, ['Postgres', 'SQLite']);
    o.answer(pedidos[1].id, 'SQLite');
    const end = await done;
    assert.deepStrictEqual(decisions, ['all', 'SQLite']);
    assert.strictEqual(end.caixas[0].auto, true, '"aprovar tudo" liga o auto da caixa');
    assert.strictEqual(o.snapshot(b.id).pendentes.length, 0);
  });
});

test('parar cancela a caixa em andamento, nega o pedido pendente e pula as seguintes', async () => {
  await withHome(async (home, work) => {
    let decision = null;
    const f = fakeAgents({ onSend: async (agent, prompt, h) => { if (/^a/.test(prompt)) { decision = await h.approve({ id: 't', name: 'run_command', label: 'rm', args: { command: 'rm x' } }); return agent.aborted ? 'abort' : null; } return null; } });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }], [{ de: 'a', para: 'b' }]);
    const done = finished(o, b.id);
    o.run(b.id);
    while (!o.snapshot(b.id).pendentes.length) await sleep(5);
    o.stop(b.id);
    const end = await done;
    assert.strictEqual(decision, 'no');
    assert.deepStrictEqual(st(end), { a: 'cancelada', b: 'cancelada' });
    assert.strictEqual(f.calls.length, 1);
  });
});

test('mensagem de acompanhamento continua a mesma conversa da caixa', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents({ delay: 5 });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'primeira' }], []);
    let done = finished(o, b.id);
    o.run(b.id);
    await done;
    done = finished(o, b.id);
    assert.strictEqual(o.message(b.id, 'a', 'agora adicione testes'), 'continua');
    const end = await done;
    assert.strictEqual(f.stats.created, 1, 'reaproveita o agente');
    assert.strictEqual(f.calls[1].prompt, 'agora adicione testes');
    assert.strictEqual(end.caixas[0].resultado, 'fiz: agora adicione testes');
    assert.strictEqual(end.caixas[0].tokens, 200, 'soma os tokens da conversa');
    assert.throws(() => o.message(b.id, 'a', '   '), /vazia/);
  });
});

test('mensagem para uma caixa que nunca rodou vai junto com o pedido e o contexto', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents({ delay: 5 });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'faça X' }], []);
    const done = finished(o, b.id);
    o.message(b.id, 'a', 'use TypeScript');
    await done;
    assert.match(f.calls[0].prompt, /^faça X[\s\S]*Instrução do usuário: use TypeScript$/);
  });
});

test('update guarda o que o navegador mandou, mas o estado da execução é do executor', async () => {
  await withHome(async (home, work) => {
    const o = new orq.Orquestra({ createAgent: fakeAgents().createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }], []);
    o.patch(b.id, 'a', { status: 'concluida', resultado: 'ok', branch: 'rfcode/a' });
    const next = o.update(b.id, { ...b, caixas: [{ ...b.caixas[0], prompt: 'novo', status: 'rodando', resultado: 'forjado' }, { id: 'novo', tipo: 'sessao', status: 'concluida', resultado: 'forjado' }] });
    const a = next.caixas.find((c) => c.id === 'a');
    assert.strictEqual(a.prompt, 'novo');
    assert.strictEqual(a.status, 'concluida');
    assert.strictEqual(a.resultado, 'ok');
    assert.strictEqual(a.branch, 'rfcode/a');
    const n = next.caixas.find((c) => c.id === 'novo');
    assert.strictEqual(n.status, 'ociosa');
    assert.strictEqual(n.resultado, undefined);
  });
});

test('quadro reaberto depois de fechar o rfcode no meio: o que rodava aparece como interrompido', async () => {
  await withHome(async (home, work) => {
    const o = new orq.Orquestra({ createAgent: fakeAgents().createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }], []);
    o.patch(b.id, 'a', { status: 'rodando' });
    o.patch(b.id, 'b', { status: 'concluida' });
    o.flush();
    const again = new orq.Orquestra({ createAgent: fakeAgents().createAgent });
    const re = again.board(b.id);
    assert.strictEqual(re.caixas[0].status, 'cancelada');
    assert.match(re.caixas[0].erro, /Interrompida/);
    assert.strictEqual(re.caixas[1].status, 'concluida');
    assert.deepStrictEqual(again.list().map((x) => x.id), [b.id]);
    assert.ok(again.remove(b.id));
    assert.deepStrictEqual(again.list(), []);
  });
});

test('notas: as sessões ligadas leem e escrevem (memória compartilhada do fluxo)', async () => {
  await withHome(async (home, work) => {
    const seen = [];
    const f = fakeAgents({
      onSend: async (agent, prompt, h) => {
        void h;
        const tools = agent.extraTools;
        if (!tools) { seen.push('sem ferramentas'); return; }
        seen.push(tools.defs.map((d) => d.name).join(','));
        seen.push(await tools.run('nota_ler', {}));
        seen.push(await tools.run('nota_escrever', { nota: 'plano', texto: '1. fazer X' }));
      },
    });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }, { id: 'n', tipo: 'nota', titulo: 'Plano', texto: '# Plano' }, { id: 'solo', prompt: 'solo' }], [{ de: 'a', para: 'n' }], { paralelo: 1 });
    const done = finished(o, b.id);
    o.run(b.id);
    const end = await done;
    assert.strictEqual(seen[0], 'nota_ler,nota_escrever');
    assert.match(seen[1], /### Plano\n# Plano/);
    assert.match(seen[2], /Nota "Plano" atualizada/);
    assert.strictEqual(end.caixas.find((c) => c.id === 'n').texto, '# Plano\n\n1. fazer X');
    assert.strictEqual(seen[3], 'sem ferramentas', 'caixa sem nota ligada não recebe as ferramentas');
  });
});

// ---------- git: branch própria ----------
function gitRepo(dir) {
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'oi\n');
  g(['add', '.']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

test('"branch própria" cria uma worktree por caixa; a cadeia segue nela e a junção volta à pasta principal', async () => {
  await withHome(async (home, work) => {
    gitRepo(work);
    const f = fakeAgents({ delay: 5 });
    const o = new orq.Orquestra({ createAgent: f.createAgent });
    const node = JSON.stringify(process.execPath);
    const b = board(o, work, [
      { id: 'a', titulo: 'Implementar cupom', prompt: 'a', isolar: true },
      { id: 't', tipo: 'comando', comando: `${node} -e "console.log(process.cwd())"` },
      { id: 'fix', prompt: 'fix' },
      { id: 'b', titulo: 'Outra', prompt: 'b', isolar: true },
      { id: 'merge', prompt: 'merge' },
    ], [{ de: 'a', para: 't' }, { de: 't', para: 'fix', quando: 'sempre' }, { de: 'fix', para: 'merge' }, { de: 'b', para: 'merge' }]);
    const done = finished(o, b.id);
    o.run(b.id);
    const end = await done;
    const by = Object.fromEntries(end.caixas.map((c) => [c.id, c]));
    assert.strictEqual(by.a.status, 'concluida', by.a.erro);
    assert.match(by.a.branch, /^rfcode\/implementar-cupom-/);
    assert.ok(fs.existsSync(path.join(by.a.pasta, 'a.txt')), 'a worktree tem os arquivos do repositório');
    assert.notStrictEqual(by.a.pasta, by.b.pasta);
    assert.strictEqual(by.t.pasta, by.a.pasta, 'o comando roda na branch da caixa anterior');
    assert.strictEqual(fs.realpathSync(by.t.resultado.split('\n').slice(-1)[0].trim()), fs.realpathSync(by.a.pasta));
    assert.strictEqual(by.fix.pasta, by.a.pasta);
    assert.strictEqual(by.merge.pasta, work, 'junção de duas branches roda na pasta principal');
    const branches = execFileSync('git', ['branch', '--list', 'rfcode/*'], { cwd: work, encoding: 'utf8' });
    assert.strictEqual(branches.trim().split('\n').length, 2);
    // rodar de novo reaproveita a mesma worktree
    const again = finished(o, b.id);
    o.run(b.id, { ids: ['a'], modo: 'so' });
    assert.strictEqual((await again).caixas.find((c) => c.id === 'a').pasta, by.a.pasta);
  });
});

test('"branch própria" fora de um repositório git explica o que fazer', async () => {
  await withHome(async (home, work) => {
    const o = new orq.Orquestra({ createAgent: fakeAgents().createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a', isolar: true }], []);
    const done = finished(o, b.id);
    o.run(b.id);
    const end = await done;
    assert.strictEqual(end.caixas[0].status, 'falhou');
    assert.match(end.caixas[0].erro, /precisa de um repositório git/);
  });
});

test('caixa sem repositório falha com uma mensagem clara', async () => {
  await withHome(async (home, work) => {
    const o = new orq.Orquestra({ createAgent: fakeAgents().createAgent });
    const b = board(o, work, [{ id: 'a', prompt: 'a' }], []);
    o.update(b.id, { ...b, caixas: [{ ...b.caixas[0], repo: null }] });
    const done = finished(o, b.id);
    o.run(b.id);
    assert.match((await done).caixas[0].erro, /Escolha o repositório/);
  });
});

// ---------- repositórios ----------
test('inspectRepo, listDirs e cloneRepo validam caminhos e endereços', async () => {
  await withHome(async (home, work) => {
    gitRepo(work);
    fs.mkdirSync(path.join(work, 'sub'));
    fs.mkdirSync(path.join(work, '.escondida'));
    const r = orq.inspectRepo(work);
    assert.strictEqual(r.git, true);
    assert.strictEqual(r.nome, path.basename(work));
    assert.throws(() => orq.inspectRepo('relativo/x'), /caminho completo/);
    assert.throws(() => orq.inspectRepo(path.join(work, 'nao-existe')), /não encontrada/);
    assert.throws(() => orq.inspectRepo(path.join(work, 'a.txt')), /Não é uma pasta/);
    const d = orq.listDirs(work);
    assert.deepStrictEqual(d.pastas.map((p) => p.nome), ['sub']);
    assert.strictEqual(d.git, true);
    for (const bad of ['--upload-pack=touch /tmp/x', 'file:///etc', 'https://x.com/a b', 'ext::sh -c id', '']) {
      await assert.rejects(orq.cloneRepo(bad), /Endereço git inválido/, bad);
    }
    assert.ok(orq.GIT_URL.test('https://github.com/dono/projeto.git'));
    assert.ok(orq.GIT_URL.test('git@github.com:dono/projeto.git'));
  });
});

// ---------- servidor ----------
function request(port, method, url, { token, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(token ? { 'X-RF-Token': token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(host ? { Host: host } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* html */ } resolve({ status: res.statusCode, raw, json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('servidor: página, token, Host, arquivos permitidos e a API do quadro', async () => {
  await withHome(async (home, work) => {
    const f = fakeAgents({ delay: 5 });
    const s = new OrquestraServer({ orquestra: new orq.Orquestra({ createAgent: f.createAgent }), version: 't' });
    await s.start(0);
    try {
      const p = s.port, token = s.token;
      assert.match(s.url('abc'), new RegExp(`^http://127\\.0\\.0\\.1:${p}/#t=${token}&q=abc$`));
      const page = await request(p, 'GET', '/');
      assert.strictEqual(page.status, 200);
      assert.match(page.raw, /orquestra\.js/);
      assert.strictEqual(page.headers['x-frame-options'], 'DENY');
      assert.strictEqual((await request(p, 'GET', '/static/orquestra.css')).status, 200);
      assert.strictEqual((await request(p, 'GET', '/static/chat.js')).status, 404, 'só os arquivos da orquestra');
      assert.strictEqual((await request(p, 'GET', '/static/..%2f..%2fpackage.json')).status, 404);
      assert.strictEqual((await request(p, 'GET', '/api/estado')).status, 401);
      assert.strictEqual((await request(p, 'GET', '/api/estado', { token: 'errado' })).status, 401);
      assert.strictEqual((await request(p, 'GET', '/api/eventos?t=errado')).status, 401);
      assert.strictEqual((await request(p, 'GET', '/', { host: 'evil.example:80' })).status, 403, 'protege contra DNS rebinding');
      const est = await request(p, 'GET', '/api/estado', { token });
      assert.strictEqual(est.status, 200);
      assert.ok(est.json.modelosQuadro.some((m) => m.id === 'paralelo'));
      assert.ok(est.json.modelos.some((m) => m.id === 'auto'));

      const repo = await request(p, 'POST', '/api/repos/verificar', { token, body: { caminho: work } });
      assert.strictEqual(repo.json.repo.caminho, path.resolve(work));
      assert.strictEqual((await request(p, 'POST', '/api/repos/verificar', { token, body: { caminho: 'x' } })).status, 400);
      const created = await request(p, 'POST', '/api/quadros', { token, body: { nome: 'Q', modelo: 'revisao', repos: [repo.json.repo] } });
      const q = created.json.quadro;
      assert.strictEqual(q.caixas.length, 4);
      const id = q.id;
      assert.strictEqual((await request(p, 'GET', `/api/quadros/${id}`, { token })).json.quadro.nome, 'Q');
      assert.strictEqual((await request(p, 'GET', '/api/quadros/..%2f..%2fx', { token })).status, 404);
      const put = await request(p, 'PUT', `/api/quadros/${id}`, { token, body: { quadro: { ...q, nome: 'Renomeado' } } });
      assert.strictEqual(put.json.ok, true);
      assert.strictEqual(put.json.ligacoes, q.ligacoes.length);

      const done = finished(s.orq, id);
      const run = await request(p, 'POST', `/api/quadros/${id}/rodar`, { token, body: { modo: 'tudo' } });
      assert.strictEqual(run.json.iniciadas.length, 3, 'nota não roda');
      await done;
      const after = (await request(p, 'GET', `/api/quadros/${id}`, { token })).json;
      assert.ok(after.quadro.caixas.filter((c) => c.tipo === 'sessao').every((c) => c.status === 'concluida'));
      const log = await request(p, 'GET', `/api/quadros/${id}/log/${after.quadro.caixas[0].id}`, { token });
      assert.ok(log.json.eventos.some((e) => e.type === 'text'));
      assert.strictEqual((await request(p, 'POST', '/api/responder', { token, body: { pedido: 'nao-existe', resposta: 'yes' } })).status, 409);
      assert.strictEqual((await request(p, 'POST', '/api/responder', { token, body: { pedido: 'x', resposta: 5 } })).status, 400);
      assert.strictEqual((await request(p, 'DELETE', `/api/quadros/${id}`, { token })).json.ok, true);
    } finally { s.stop(); }
  });
});

test('servidor: eventos ao vivo chegam pelo SSE com o token', async () => {
  await withHome(async (home, work) => {
    const o = new orq.Orquestra({ createAgent: fakeAgents({ delay: 5 }).createAgent });
    const s = new OrquestraServer({ orquestra: o });
    await s.start(0);
    try {
      const b = board(o, work, [{ id: 'a', prompt: 'a' }], []);
      const events = [];
      const req = http.get({ host: '127.0.0.1', port: s.port, path: `/api/eventos?t=${s.token}` });
      await new Promise((resolve) => req.on('response', (res) => {
        res.on('data', (c) => { for (const line of String(c).split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
        resolve();
      }));
      await sleep(30);
      const done = finished(o, b.id);
      o.run(b.id);
      await done;
      await sleep(30);
      req.destroy();
      const types = new Set(events.map((e) => e.type));
      for (const t of ['execucao', 'caixa', 'log']) assert.ok(types.has(t), `faltou o evento ${t}`);
    } finally { s.stop(); }
  });
});

test('startOrquestra abre o quadro mais recente e conecta as pastas pedidas sem repetir', async () => {
  await withHome(async (home, work) => {
    const mk = () => new orq.Orquestra({ createAgent: fakeAgents().createAgent });
    const r1 = await startOrquestra({ pastas: [work], port: 0, orquestra: mk() });
    r1.server.stop();
    assert.strictEqual(r1.quadro.repos.length, 1);
    assert.match(r1.url, /#t=.+&q=/);
    const r2 = await startOrquestra({ pastas: [work, path.join(work, 'nao-existe')], port: 0, orquestra: mk() });
    r2.server.stop();
    assert.strictEqual(r2.quadro.id, r1.quadro.id);
    assert.strictEqual(r2.quadro.repos.length, 1);
    assert.strictEqual(r2.avisos.length, 1);
  });
});

test('/orquestra é um comando do painel e do terminal, com apelidos', () => {
  assert.deepStrictEqual(parseCommand('/quadro'), { name: 'orquestra', args: '' });
  assert.deepStrictEqual(parseCommand('/canvas C:\\proj'), { name: 'orquestra', args: 'C:\\proj' });
  assert.match(pageHtml(), /Rodar fluxo/);
});

test('com o Agent de verdade: a conversa é salva, volta depois de reiniciar e continua de onde parou', async () => {
  await withHome(async (home, work) => {
    const prevFetch = global.fetch;
    const prompts = [];
    global.fetch = async (url, opts) => {
      if (opts && opts.body) { try { const b = JSON.parse(opts.body); prompts.push(b.messages[b.messages.length - 1].content); } catch { /* não é chat */ } }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pronto, feito' } }] })}\n\ndata: [DONE]\n\n`);
    };
    try {
      const o = new orq.Orquestra({ apiKey: 'x', model: 'z-ai/glm-5.3', effort: 'low' });
      const b = board(o, work, [{ id: 'a', prompt: 'explique o projeto' }], []);
      let done = finished(o, b.id);
      o.run(b.id);
      let end = await done;
      const a = end.caixas[0];
      assert.strictEqual(a.status, 'concluida', a.erro);
      assert.strictEqual(a.resultado, 'pronto, feito');
      assert.ok(a.sessao, 'guarda o id da conversa salva');
      assert.ok(fs.existsSync(path.join(home, 'sessions', `${a.sessao}.json`)));
      o.flush();
      // outro processo (rfcode reiniciado): o histórico vem da conversa salva
      const o2 = new orq.Orquestra({ apiKey: 'x', model: 'z-ai/glm-5.3' });
      const log = o2.logOf(b.id, 'a');
      assert.ok(log.some((e) => e.type === 'user' && /explique o projeto/.test(e.text)));
      assert.ok(log.some((e) => e.type === 'text' && e.text === 'pronto, feito'));
      done = finished(o2, b.id);
      o2.message(b.id, 'a', 'agora resuma em uma frase');
      end = await done;
      assert.strictEqual(end.caixas[0].status, 'concluida');
      assert.strictEqual(prompts[prompts.length - 1], 'agora resuma em uma frase', 'continua a conversa, sem repetir o contexto');
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${a.sessao}.json`), 'utf8'));
      assert.strictEqual(saved.messages.filter((m) => m.role === 'user').length, 2, 'mesma conversa, não uma nova');
    } finally { global.fetch = prevFetch; }
  });
});
