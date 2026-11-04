'use strict';
// Orquestra: um quadro (canvas) com várias sessões de código ligadas em fluxo, para um ou mais repositórios.
// - Cada caixa é uma sessão do agente, um comando (testes, build) ou uma nota compartilhada.
// - Uma ligação A -> B faz B esperar A e receber o resultado de A como contexto. Caixas sem dependência
//   entre si rodam em paralelo, até o limite do quadro (1 = tudo em sequência).
// - A ligação diz quando seguir: "sucesso" (padrão), "falha" (ex.: testes falharam -> sessão que corrige) ou "sempre".
// - Sessões com "isolar" trabalham numa git worktree, numa branch própria; as caixas seguintes do mesmo
//   repositório continuam nessa pasta, então uma cadeia implementar -> testar -> corrigir fica na mesma branch.
// Estado em disco: ~/.rfcode/orquestra/quadros/<id>.json (gravação atômica). Sem dependências.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn, execFile, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const baseDir = () => path.join(HOME(), 'orquestra');
const boardsDir = () => path.join(baseDir(), 'quadros');
const reposDir = () => path.join(baseDir(), 'repos');
const worktreesDir = () => path.join(baseDir(), 'worktrees');

const TIPOS = ['sessao', 'comando', 'nota'];
const QUANDO = ['sucesso', 'falha', 'sempre'];
const EFFORTS = ['low', 'medium', 'high'];
const FINAL = new Set(['concluida', 'falhou', 'cancelada', 'pulada']);
// campos que só o executor escreve (o navegador manda o quadro inteiro, mas não manda nestes)
const RUNTIME = ['status', 'resultado', 'erro', 'sessao', 'branch', 'pasta', 'inicio', 'fim', 'tokens', 'codigo'];
const TITULO = { sessao: 'Sessão', comando: 'Comando', nota: 'Nota' };
const MAX_LOG = 800;
const now = () => new Date().toISOString();

// ---------- normalização (tudo que vem do navegador passa por aqui) ----------
const str = (v, max = 20000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v, def = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.round(Number(v) * 100) / 100 : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const validId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const newId = (prefix) => `${prefix}${crypto.randomBytes(4).toString('hex')}`;
const newBoardId = () => `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
const slug = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'sessao';

function normalizeNode(n = {}) {
  const tipo = TIPOS.includes(n.tipo) ? n.tipo : 'sessao';
  const out = { id: validId(n.id) ? n.id : newId('c'), tipo, titulo: str(n.titulo, 120).trim() || TITULO[tipo], x: num(n.x), y: num(n.y) };
  if (tipo === 'nota') {
    out.texto = str(n.texto, 50000);
    return out;
  }
  out.repo = validId(n.repo) ? n.repo : null;
  if (tipo === 'sessao') {
    out.prompt = str(n.prompt, 20000);
    out.modelo = str(n.modelo, 200).trim();
    out.esforco = EFFORTS.includes(n.esforco) ? n.esforco : '';
    out.auto = !!n.auto;
    out.isolar = !!n.isolar;
  } else {
    out.comando = str(n.comando, 4000);
    out.limite = clamp(num(n.limite, 30) || 30, 1, 24 * 60); // minutos
  }
  out.status = typeof n.status === 'string' && n.status ? n.status : 'ociosa';
  for (const k of RUNTIME) {
    if (k === 'status' || n[k] === undefined || n[k] === null) continue;
    out[k] = k === 'tokens' || k === 'codigo' ? num(n[k]) : str(n[k], 20000);
  }
  return out;
}

const runnable = (c) => !!c && c.tipo !== 'nota';

// Ligações que são dependência (entre caixas que rodam). As que tocam uma nota são só contexto.
function depEdges(board) {
  const by = new Map(board.caixas.map((c) => [c.id, c]));
  return board.ligacoes.filter((e) => runnable(by.get(e.de)) && runnable(by.get(e.para)));
}

// Ligar de -> para criaria um ciclo? (existe caminho para -> ... -> de)
function wouldCycle(board, de, para) {
  if (de === para) return true;
  const by = new Map(board.caixas.map((c) => [c.id, c]));
  if (!runnable(by.get(de)) || !runnable(by.get(para))) return false;
  const adj = new Map();
  for (const e of depEdges(board)) { if (!adj.has(e.de)) adj.set(e.de, []); adj.get(e.de).push(e.para); }
  const seen = new Set(), stack = [para];
  while (stack.length) {
    const id = stack.pop();
    if (id === de) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(adj.get(id) || []));
  }
  return false;
}

function normalizeBoard(b = {}) {
  const repos = [];
  for (const r of (Array.isArray(b.repos) ? b.repos : []).slice(0, 50)) {
    if (!r || typeof r.caminho !== 'string' || !r.caminho.trim()) continue;
    const repo = { id: validId(r.id) && !repos.some((x) => x.id === r.id) ? r.id : newId('r'), nome: str(r.nome, 100).trim() || path.basename(r.caminho), caminho: str(r.caminho, 1000), git: !!r.git };
    if (r.url) repo.url = str(r.url, 1000);
    if (r.branch) repo.branch = str(r.branch, 200);
    repos.push(repo);
  }
  const caixas = [], ids = new Set();
  for (const n of (Array.isArray(b.caixas) ? b.caixas : []).slice(0, 300)) {
    if (!n || typeof n !== 'object') continue;
    const c = normalizeNode(n);
    if (ids.has(c.id)) c.id = newId('c');
    ids.add(c.id);
    if (c.repo && !repos.some((r) => r.id === c.repo)) c.repo = null;
    caixas.push(c);
  }
  const out = { caixas, ligacoes: [] };
  for (const e of (Array.isArray(b.ligacoes) ? b.ligacoes : []).slice(0, 1000)) {
    if (!e || !ids.has(e.de) || !ids.has(e.para) || e.de === e.para) continue;
    if (out.ligacoes.some((x) => x.de === e.de && x.para === e.para)) continue;
    if (wouldCycle(out, e.de, e.para)) continue;
    out.ligacoes.push({ id: validId(e.id) && !out.ligacoes.some((x) => x.id === e.id) ? e.id : newId('l'), de: e.de, para: e.para, quando: QUANDO.includes(e.quando) ? e.quando : 'sucesso' });
  }
  const cfg = b.config || {};
  const view = b.view || {};
  return {
    id: validId(b.id) ? b.id : newBoardId(),
    nome: str(b.nome, 120).trim() || 'Quadro sem nome',
    criado: str(b.criado, 40) || now(),
    atualizado: str(b.atualizado, 40) || now(),
    repos, caixas, ligacoes: out.ligacoes,
    config: { paralelo: clamp(Math.round(num(cfg.paralelo, 3)) || 3, 1, 8), modelo: str(cfg.modelo, 200).trim() },
    view: { x: num(view.x), y: num(view.y), zoom: clamp(num(view.zoom, 1) || 1, 0.2, 2.5) },
  };
}

// ---------- modelos de quadro ----------
// Posições em pixels do quadro; repo "@1" = primeiro repositório conectado.
const MODELOS = {
  vazio: { nome: 'Quadro vazio', desc: 'Comece do zero e puxe as caixinhas.', caixas: [], ligacoes: [] },
  paralelo: {
    nome: 'Paralelo + revisão',
    desc: 'Três sessões trabalham ao mesmo tempo, cada uma na sua branch, e uma quarta junta e revisa tudo.',
    caixas: [
      { id: 'a', tipo: 'sessao', titulo: 'Back-end', x: 80, y: 0, isolar: true, prompt: 'Implemente a parte de back-end da funcionalidade descrita na nota. Faça commits na sua branch.' },
      { id: 'b', tipo: 'sessao', titulo: 'Front-end', x: 80, y: 340, isolar: true, prompt: 'Implemente a interface da funcionalidade descrita na nota. Faça commits na sua branch.' },
      { id: 'c', tipo: 'sessao', titulo: 'Testes', x: 80, y: 680, isolar: true, prompt: 'Escreva os testes da funcionalidade descrita na nota e rode a suíte. Faça commits na sua branch.' },
      { id: 'd', tipo: 'sessao', titulo: 'Juntar e revisar', x: 540, y: 340, prompt: 'Junte as branches das etapas anteriores (git merge), resolva os conflitos, rode os testes e revise o resultado.' },
      { id: 'n', tipo: 'nota', titulo: 'Especificação', x: -340, y: 340, texto: '# O que construir\n\nDescreva aqui a funcionalidade. Todas as sessões ligadas a esta nota leem (e podem atualizar) o texto.' },
    ],
    ligacoes: [['a', 'd'], ['b', 'd'], ['c', 'd'], ['n', 'a'], ['n', 'b'], ['n', 'c']],
  },
  ciclo: {
    nome: 'Implementar, testar e corrigir',
    desc: 'Uma sessão implementa, um comando roda os testes e, se falharem, outra sessão corrige.',
    caixas: [
      { id: 'a', tipo: 'sessao', titulo: 'Implementar', x: 40, y: 140, isolar: true, prompt: 'Implemente: (descreva o pedido aqui).' },
      { id: 'b', tipo: 'comando', titulo: 'Rodar testes', x: 460, y: 140, comando: 'npm test' },
      { id: 'c', tipo: 'sessao', titulo: 'Corrigir', x: 880, y: -120, prompt: 'Os testes falharam (veja a saída da etapa anterior). Encontre a causa, corrija e rode os testes de novo até passarem.' },
      { id: 'd', tipo: 'sessao', titulo: 'Abrir PR', x: 880, y: 260, prompt: 'Os testes passaram. Revise o diff da branch, faça o commit final e prepare a descrição do pull request.' },
    ],
    ligacoes: [['a', 'b'], ['b', 'c', 'falha'], ['b', 'd', 'sucesso']],
  },
  revisao: {
    nome: 'Planejar, executar e revisar',
    desc: 'Uma sessão investiga e escreve o plano numa nota, outra executa e uma terceira revisa o diff.',
    caixas: [
      { id: 'a', tipo: 'sessao', titulo: 'Planejar', x: 40, y: 120, prompt: 'Investigue o projeto e escreva na nota "Plano" um plano curto, passo a passo, para: (descreva o pedido aqui). Não altere o código.' },
      { id: 'n', tipo: 'nota', titulo: 'Plano', x: 250, y: -240, texto: '' },
      { id: 'b', tipo: 'sessao', titulo: 'Executar', x: 460, y: 120, prompt: 'Execute o plano da nota "Plano", verificando cada passo com os testes.' },
      { id: 'c', tipo: 'sessao', titulo: 'Revisar', x: 880, y: 120, prompt: 'Revise o git diff procurando bugs reais (lógica, casos de borda, segurança). Corrija o que for sério.' },
    ],
    ligacoes: [['a', 'b'], ['b', 'c'], ['a', 'n'], ['n', 'b']],
  },
};

function fromTemplate(key, repos = []) {
  const t = MODELOS[key] || MODELOS.vazio;
  const map = new Map(t.caixas.map((c) => [c.id, newId('c')]));
  const repo = repos[0] ? repos[0].id : null;
  return {
    caixas: t.caixas.map((c) => ({ ...c, id: map.get(c.id), repo: c.tipo === 'nota' ? undefined : repo })),
    ligacoes: t.ligacoes.map(([de, para, quando]) => ({ de: map.get(de), para: map.get(para), quando: quando || 'sucesso' })),
  };
}

// ---------- disco ----------
function boardFile(id) {
  if (!validId(id)) throw new Error('id de quadro inválido');
  return path.join(boardsDir(), `${id}.json`);
}
function writeBoard(b) {
  fs.mkdirSync(boardsDir(), { recursive: true });
  const file = boardFile(b.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 1));
  fs.renameSync(tmp, file);
}
function readBoard(id) {
  try { return normalizeBoard(JSON.parse(fs.readFileSync(boardFile(id), 'utf8'))); } catch { return null; }
}
function listBoards() {
  let files = [];
  try { files = fs.readdirSync(boardsDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(boardsDir(), f), 'utf8'));
      out.push({ id: b.id, nome: b.nome, atualizado: b.atualizado, caixas: (b.caixas || []).length, repos: (b.repos || []).map((r) => r.nome) });
    } catch { /* arquivo corrompido: ignora */ }
  }
  return out.filter((b) => validId(b.id)).sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado)));
}

// ---------- repositórios ----------
const git = (cwd, args, timeout = 30000) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return ''; } };

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

// Confere uma pasta local e devolve o repositório para o quadro: { nome, caminho, git, branch, url }.
function inspectRepo(caminho) {
  const p = expandHome(caminho);
  if (!p || !path.isAbsolute(p)) throw new Error('Informe o caminho completo da pasta (ex.: C:\\projetos\\app ou /home/voce/app).');
  const full = path.resolve(p);
  let st;
  try { st = fs.statSync(full); } catch { throw new Error(`Pasta não encontrada: ${full}`); }
  if (!st.isDirectory()) throw new Error(`Não é uma pasta: ${full}`);
  const isGit = tryGit(full, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const repo = { nome: path.basename(full) || full, caminho: full, git: isGit };
  if (isGit) {
    const branch = tryGit(full, ['branch', '--show-current']);
    const url = tryGit(full, ['config', '--get', 'remote.origin.url']);
    if (branch) repo.branch = branch;
    if (url) repo.url = url.replace(/\/\/[^@/]+@/, '//'); // nunca mostra token embutido no endereço
  }
  return repo;
}

const GIT_URL = /^(https:\/\/[\w.-]+(:\d+)?\/[\w.@:/~+-]+|git@[\w.-]+:[\w.@/~+-]+|ssh:\/\/[\w.@:-]+\/[\w.@:/~+-]+)$/;

// Clona um repositório remoto em ~/.rfcode/orquestra/repos/<nome>. Sem shell: argumentos em lista.
function cloneRepo(url, { timeout = 10 * 60 * 1000 } = {}) {
  const u = String(url || '').trim();
  if (!GIT_URL.test(u)) return Promise.reject(new Error('Endereço git inválido. Use https://..., git@host:dono/repo.git ou ssh://...'));
  const base = (u.split(/[/:]/).pop() || 'repo').replace(/\.git$/, '').replace(/[^\w.-]/g, '') || 'repo';
  fs.mkdirSync(reposDir(), { recursive: true });
  let dest = path.join(reposDir(), base);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(reposDir(), `${base}-${i}`);
  return new Promise((resolve, reject) => {
    execFile('git', ['clone', '--', u, dest], { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) return reject(new Error(`git clone falhou: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      try { resolve({ ...inspectRepo(dest), url: u.replace(/\/\/[^@/]+@/, '//') }); } catch (e) { reject(e); }
    });
  });
}

// Lista as subpastas de um caminho (para escolher repositórios pelo navegador).
function listDirs(caminho) {
  const p = path.resolve(expandHome(caminho) || os.homedir());
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { throw new Error(`Não consegui abrir ${p}`); }
  const pastas = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => ({ nome: d.name, caminho: path.join(p, d.name), git: fs.existsSync(path.join(p, d.name, '.git')) }))
    .sort((a, b) => (b.git - a.git) || a.nome.localeCompare(b.nome)).slice(0, 400);
  const pai = path.dirname(p);
  return { caminho: p, pai: pai !== p ? pai : null, git: fs.existsSync(path.join(p, '.git')), pastas };
}

// Worktree da caixa: ~/.rfcode/orquestra/worktrees/<quadro>/<caixa>, numa branch rfcode/<titulo>-<id>.
function prepareWorktree(repoPath, boardId, node) {
  const dir = path.join(worktreesDir(), boardId, node.id);
  if (fs.existsSync(path.join(dir, '.git'))) return { cwd: dir, branch: tryGit(dir, ['branch', '--show-current']) || null };
  if (tryGit(repoPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('"Isolar" precisa de um repositório git. Desligue a opção ou rode git init na pasta.');
  if (!tryGit(repoPath, ['rev-parse', '--verify', 'HEAD'])) throw new Error('O repositório ainda não tem nenhum commit; faça o primeiro commit para usar "Isolar".');
  const branch = `rfcode/${slug(node.titulo)}-${node.id.slice(-4)}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { git(repoPath, ['worktree', 'add', '-b', branch, dir], 60000); } catch {
    try { git(repoPath, ['worktree', 'add', dir, branch], 60000); } catch (e) { throw new Error(`Não consegui criar a worktree: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }
  }
  return { cwd: dir, branch };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* já saiu */ } }
}

// ---------- prompt da caixa ----------
const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}\n[... ${t.length - n} caracteres omitidos]` : t; };

function connectedNotes(board, id) {
  const by = new Map(board.caixas.map((c) => [c.id, c]));
  const ids = board.ligacoes.filter((e) => e.de === id || e.para === id).map((e) => (e.de === id ? e.para : e.de));
  return [...new Set(ids)].map((x) => by.get(x)).filter((c) => c && c.tipo === 'nota');
}

function buildPrompt(board, node, { repo, cwd, branch } = {}) {
  const by = new Map(board.caixas.map((c) => [c.id, c]));
  const prev = depEdges(board).filter((e) => e.para === node.id).map((e) => by.get(e.de)).filter((c) => c && (c.resultado || c.erro));
  const notes = connectedNotes(board, node.id);
  const ctx = [`[Contexto: você é a caixa "${node.titulo}" do quadro "${board.nome}" na orquestra do rfcode. Outras sessões podem estar trabalhando ao mesmo tempo, cada uma na sua caixa.]`];
  if (repo) ctx.push(`Repositório: ${repo.nome} (${cwd || repo.caminho})${branch ? `. Você está numa git worktree só sua, na branch ${branch}: faça commits nela ao terminar.` : ''}`);
  if (prev.length) {
    ctx.push('Resultado das etapas anteriores do fluxo:');
    for (const p of prev) {
      const r = board.repos.find((x) => x.id === p.repo);
      ctx.push(`### ${p.titulo} (${p.status === 'concluida' ? 'concluída' : p.status}${r ? `, ${r.nome}` : ''}${p.branch ? `, branch ${p.branch}` : ''})\n${cut(p.resultado || p.erro, 6000)}`);
    }
  }
  if (notes.length) {
    ctx.push('Notas do quadro ligadas a esta caixa (compartilhadas com outras sessões; use nota_ler e nota_escrever para consultar e atualizar):');
    for (const n of notes) ctx.push(`### Nota "${n.titulo}"\n${cut(n.texto, 6000) || '(vazia)'}`);
  }
  ctx.push('Termine com um resumo objetivo: o que fez, onde estão as mudanças (arquivos, branch) e o que ficou pendente. Esse resumo é passado às próximas caixas do fluxo.');
  return `${String(node.prompt || '').trim() || node.titulo}\n\n---\n${ctx.join('\n\n')}`;
}

// Satisfaz a ligação? (status da origem x condição)
function edgeOk(quando, status) {
  if (quando === 'falha') return status === 'falhou';
  if (quando === 'sempre') return status === 'concluida' || status === 'falhou';
  return status === 'concluida';
}

// ---------- o executor ----------
class Orquestra extends EventEmitter {
  /**
   * createAgent({ cwd, model, effort, extraTools }) => Agent (padrão: o Agent do rfcode com saveSession).
   * Eventos ('evento'): { type: 'quadro'|'caixa'|'log'|'pedido'|'pedidoFim'|'execucao', quadro, ... }.
   */
  constructor({ createAgent, apiKey, model, effort } = {}) {
    super();
    this.setMaxListeners(50);
    this.createAgent = createAgent || defaultCreateAgent({ apiKey, model, effort });
    this.boards = new Map();   // id -> quadro carregado
    this.runs = new Map();     // id do quadro -> { alvo: Set, ativos: Map(caixa -> { stop }), continuar: Map }
    this.agents = new Map();   // "quadro/caixa" -> Agent (para mensagens de acompanhamento)
    this.logs = new Map();     // "quadro/caixa" -> eventos da conversa
    this.pending = new Map();  // id do pedido -> { quadro, caixa, pedido, resolve }
    this.saveTimers = new Map();
  }

  send(ev) { this.emit('evento', ev); }

  // ----- quadros -----
  board(id) {
    if (this.boards.has(id)) return this.boards.get(id);
    const b = readBoard(id);
    if (!b) return null;
    // o rfcode foi fechado no meio de uma execução: o que estava rodando não continua sozinho
    for (const c of b.caixas) {
      if (c.status === 'rodando' || c.status === 'fila') { c.status = 'cancelada'; c.erro = c.erro || 'Interrompida: o rfcode foi fechado durante a execução.'; }
    }
    this.boards.set(id, b);
    return b;
  }

  list() { return listBoards(); }

  create({ nome, modelo = 'vazio', repos = [] } = {}) {
    const rs = normalizeBoard({ repos }).repos;
    const b = normalizeBoard({ nome: nome || (MODELOS[modelo] && modelo !== 'vazio' ? MODELOS[modelo].nome : 'Novo quadro'), repos: rs, ...fromTemplate(modelo, rs) });
    this.boards.set(b.id, b);
    writeBoard(b);
    return b;
  }

  // Grava o que o navegador mandou, mantendo os campos de execução que só o executor escreve.
  update(id, data) {
    const cur = this.board(id);
    if (!cur) throw new Error('Quadro não encontrado.');
    const next = normalizeBoard({ ...data, id, criado: cur.criado });
    for (const c of next.caixas) {
      const old = cur.caixas.find((x) => x.id === c.id);
      if (c.tipo === 'nota') continue;
      for (const k of RUNTIME) {
        if (old && old.tipo === c.tipo && old[k] !== undefined) c[k] = old[k];
        else if (k === 'status') c.status = 'ociosa';
        else delete c[k];
      }
    }
    // caixa apagada no meio da execução: para
    for (const c of cur.caixas) if (!next.caixas.some((x) => x.id === c.id)) this.stop(id, c.id);
    next.atualizado = now();
    this.boards.set(id, next);
    this.saveSoon(id, 0);
    return next;
  }

  remove(id) {
    this.stop(id);
    this.runs.delete(id);
    this.boards.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    try { fs.unlinkSync(boardFile(id)); return true; } catch { return false; }
  }

  saveSoon(id, delay = 300) {
    clearTimeout(this.saveTimers.get(id));
    const run = () => { this.saveTimers.delete(id); const b = this.boards.get(id); if (b) { try { writeBoard(b); } catch { /* disco cheio: tenta na próxima */ } } };
    if (!delay) { run(); return; }
    this.saveTimers.set(id, setTimeout(run, delay));
  }

  flush() { for (const id of [...this.saveTimers.keys()]) this.saveSoon(id, 0); }

  snapshot(id) {
    const b = this.board(id);
    if (!b) return null;
    const run = this.runs.get(id);
    return {
      quadro: b,
      rodando: !!run,
      pendentes: [...this.pending.entries()].filter(([, p]) => p.quadro === id).map(([pid, p]) => ({ ...p.pedido, id: pid, caixa: p.caixa })),
    };
  }

  patch(boardId, nodeId, fields) {
    const b = this.board(boardId);
    const c = b && b.caixas.find((x) => x.id === nodeId);
    if (!c) return null;
    Object.assign(c, fields);
    for (const [k, v] of Object.entries(fields)) if (v === undefined) delete c[k];
    b.atualizado = now();
    this.saveSoon(boardId);
    // undefined some no JSON: vai como null para o navegador apagar o campo
    const campos = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === undefined ? null : v]));
    this.send({ type: 'caixa', quadro: boardId, caixa: nodeId, campos });
    return c;
  }

  // ----- conversa de cada caixa -----
  key(b, c) { return `${b}/${c}`; }
  log(boardId, nodeId, ev) {
    const k = this.key(boardId, nodeId);
    if (!this.logs.has(k)) this.logs.set(k, []);
    const list = this.logs.get(k);
    const last = list[list.length - 1];
    // texto e saída de comando chegam aos pedaços: junta no último evento do mesmo tipo
    if (last && (ev.type === 'text' || ev.type === 'output') && last.type === ev.type && !last.closed) {
      last.text = (last.text + ev.text).slice(-60000);
    } else {
      list.push({ ...ev });
      if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
    }
    if (ev.type === 'assistantEnd' && last && last.type === 'text') last.closed = true;
    this.send({ type: 'log', quadro: boardId, caixa: nodeId, ev });
  }

  logOf(boardId, nodeId) {
    const k = this.key(boardId, nodeId);
    if (this.logs.has(k) && this.logs.get(k).length) return this.logs.get(k);
    const c = (this.board(boardId) || { caixas: [] }).caixas.find((x) => x.id === nodeId);
    if (c && c.sessao) {
      try {
        const { SessionManager, replayEvents } = require('./sessions');
        const messages = new SessionManager().load(c.sessao);
        if (messages) {
          const { describeCall } = require('./agent');
          return replayEvents(messages, { describe: describeCall }).filter((e) => e.type !== 'done')
            .map((e) => (e.type === 'toolResult' ? { ...e, output: String(e.output).slice(0, 4000) } : e));
        }
      } catch { /* sessão apagada: sem histórico */ }
    }
    return [];
  }

  // Pedido para a pessoa (aprovação ou pergunta): fica pendente até responder pelo navegador.
  request(boardId, nodeId, pedido) {
    const id = newId('p');
    return new Promise((resolve) => {
      this.pending.set(id, { quadro: boardId, caixa: nodeId, pedido, resolve });
      this.send({ type: 'pedido', quadro: boardId, caixa: nodeId, pedido: { ...pedido, id, caixa: nodeId } });
    });
  }

  answer(pedidoId, resposta) {
    const p = this.pending.get(pedidoId);
    if (!p) return false;
    this.pending.delete(pedidoId);
    if (p.pedido.tipo === 'aprovacao' && resposta === 'all') this.patch(p.quadro, p.caixa, { auto: true });
    this.send({ type: 'pedidoFim', quadro: p.quadro, caixa: p.caixa, id: pedidoId });
    p.resolve(resposta);
    return true;
  }

  dropPending(boardId, nodeId) {
    for (const [id, p] of [...this.pending]) {
      if (p.quadro !== boardId || (nodeId && p.caixa !== nodeId)) continue;
      this.pending.delete(id);
      this.send({ type: 'pedidoFim', quadro: p.quadro, caixa: p.caixa, id });
      p.resolve(p.pedido.tipo === 'aprovacao' ? 'no' : '');
    }
  }

  // ----- execução -----
  // modo: 'tudo' (todas as caixas), 'daqui' (a caixa e o que vem depois dela) ou 'so' (só a caixa).
  run(boardId, { ids = null, modo = 'tudo' } = {}) {
    const b = this.board(boardId);
    if (!b) throw new Error('Quadro não encontrado.');
    let alvo;
    if (modo === 'tudo' || !ids || !ids.length) alvo = b.caixas.filter(runnable).map((c) => c.id);
    else if (modo === 'daqui') {
      const adj = new Map();
      for (const e of depEdges(b)) { if (!adj.has(e.de)) adj.set(e.de, []); adj.get(e.de).push(e.para); }
      const seen = new Set(), stack = [...ids];
      while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); stack.push(...(adj.get(x) || [])); }
      alvo = [...seen];
    } else alvo = [...ids];
    alvo = alvo.filter((id) => runnable(b.caixas.find((c) => c.id === id)));
    const run = this.runFor(boardId);
    const added = [];
    for (const id of alvo) {
      if (run.ativos.has(id)) continue; // já está rodando
      run.alvo.add(id);
      added.push(id);
      this.patch(boardId, id, { status: 'fila', erro: undefined });
    }
    this.pump(boardId);
    return added;
  }

  // Mensagem de acompanhamento para uma sessão: entra na fila se ela está rodando; senão continua a conversa.
  message(boardId, nodeId, texto) {
    const b = this.board(boardId);
    const c = b && b.caixas.find((x) => x.id === nodeId);
    if (!c || c.tipo !== 'sessao') throw new Error('Só caixas de sessão recebem mensagens.');
    const t = String(texto || '').trim();
    if (!t) throw new Error('Mensagem vazia.');
    const run = this.runs.get(boardId);
    const agent = this.agents.get(this.key(boardId, nodeId));
    if (run && run.ativos.has(nodeId) && agent && agent.busy) {
      agent.queue(t);
      this.log(boardId, nodeId, { type: 'user', text: t, queued: true });
      return 'fila';
    }
    if (!run || !run.ativos.has(nodeId)) {
      const r = this.runFor(boardId);
      r.alvo.add(nodeId);
      r.continuar.set(nodeId, t);
      this.patch(boardId, nodeId, { status: 'fila' });
      this.pump(boardId);
      return 'continua';
    }
    // rodando, mas o agente ainda não começou (preparando a worktree): entra na fila do agente quando existir
    run.continuar.set(nodeId, t);
    return 'fila';
  }

  stop(boardId, nodeId = null) {
    const run = this.runs.get(boardId);
    this.dropPending(boardId, nodeId);
    if (!run) return false;
    const b = this.board(boardId);
    for (const id of [...run.alvo]) {
      if (nodeId && id !== nodeId) continue;
      const active = run.ativos.get(id);
      if (active) { active.stop(); continue; }
      // continua no alvo: as caixas que dependem dela veem "cancelada" e são puladas
      const c = b && b.caixas.find((x) => x.id === id);
      if (c && c.status === 'fila') this.patch(boardId, id, { status: 'cancelada', fim: now() });
    }
    if (!nodeId) run.parar = true;
    this.pump(boardId);
    return true;
  }

  stopAll() { for (const id of [...this.runs.keys()]) this.stop(id); this.flush(); }

  // Execução ativa do quadro (cria se não houver). Pedir para rodar de novo depois de um "parar" reativa.
  runFor(boardId) {
    let run = this.runs.get(boardId);
    if (!run) {
      run = { alvo: new Set(), ativos: new Map(), continuar: new Map(), parar: false };
      this.runs.set(boardId, run);
      this.send({ type: 'execucao', quadro: boardId, rodando: true });
    }
    run.parar = false;
    return run;
  }

  pump(boardId) {
    const run = this.runs.get(boardId);
    const b = this.board(boardId);
    if (!run || !b) return;
    const by = new Map(b.caixas.map((c) => [c.id, c]));
    // caixa apagada do quadro: sai do alvo
    for (const id of [...run.alvo]) if (!by.has(id) && !run.ativos.has(id)) run.alvo.delete(id);
    const deps = depEdges(b);
    const ready = [];
    for (let changed = true; changed;) {
      changed = false;
      ready.length = 0;
      for (const id of run.alvo) {
        const c = by.get(id);
        if (!c || c.status !== 'fila') continue;
        // dependências de fora da execução não seguram (o resultado delas, se houver, vira contexto)
        const incoming = deps.filter((e) => e.para === id && run.alvo.has(e.de));
        if (incoming.some((e) => !FINAL.has(by.get(e.de).status))) continue;
        if (incoming.length && !incoming.every((e) => edgeOk(e.quando, by.get(e.de).status))) {
          const why = incoming.filter((e) => !edgeOk(e.quando, by.get(e.de).status)).map((e) => `"${by.get(e.de).titulo}" ${by.get(e.de).status}`).join(', ');
          this.patch(boardId, id, { status: 'pulada', erro: `Pulada: ${why}, e a ligação pede ${incoming.map((e) => e.quando).join('/')}.`, fim: now() });
          changed = true;
          continue;
        }
        ready.push(id);
      }
    }
    if (run.parar) {
      for (const id of ready) { run.alvo.delete(id); this.patch(boardId, id, { status: 'cancelada', fim: now() }); }
      ready.length = 0;
    }
    for (const id of ready) {
      if (run.ativos.size >= b.config.paralelo) break;
      this.start(boardId, id);
    }
    const waiting = [...run.alvo].some((id) => by.has(id) && by.get(id).status === 'fila');
    if (!run.ativos.size && !waiting) {
      this.runs.delete(boardId);
      this.flush();
      this.send({ type: 'execucao', quadro: boardId, rodando: false });
    }
  }

  start(boardId, nodeId) {
    const run = this.runs.get(boardId);
    const b = this.board(boardId);
    const node = b.caixas.find((x) => x.id === nodeId);
    const state = { stopped: false, child: null, agent: null };
    state.stop = () => {
      state.stopped = true;
      this.dropPending(boardId, nodeId);
      if (state.agent) state.agent.abort();
      if (state.child) killTree(state.child);
    };
    run.ativos.set(nodeId, state);
    const follow = run.continuar.get(nodeId);
    run.continuar.delete(nodeId);
    const before = follow ? Number(node.tokens) || 0 : 0;
    this.patch(boardId, nodeId, { status: 'rodando', inicio: now(), fim: undefined, erro: undefined, ...(follow ? {} : { resultado: undefined, codigo: undefined, tokens: undefined }) });
    Promise.resolve()
      .then(() => (node.tipo === 'comando' ? this.runCommand(boardId, node, state) : this.runSession(boardId, node, state, follow)))
      .catch((e) => ({ status: 'falhou', erro: e.message }))
      .then((r) => {
        run.ativos.delete(nodeId);
        const fields = { ...r, status: state.stopped ? 'cancelada' : r.status, fim: now() };
        if (r.tokens !== undefined) fields.tokens = before + r.tokens;
        if (fields.erro && !fields.resultado && node.tipo === 'sessao') this.log(boardId, nodeId, { type: 'error', text: fields.erro });
        this.patch(boardId, nodeId, fields);
        this.pump(boardId);
      })
      .catch((e) => { try { require('./log').error('orquestra', e.stack || e.message); } catch { /* sem log */ } });
  }

  // Pasta de trabalho: worktree própria (isolar), a da caixa anterior do mesmo repositório, ou a do repositório.
  workdir(board, node) {
    const repo = board.repos.find((r) => r.id === node.repo);
    if (!repo) throw new Error('Escolha o repositório desta caixa.');
    if (!fs.existsSync(repo.caminho)) throw new Error(`A pasta do repositório não existe mais: ${repo.caminho}`);
    if (node.tipo === 'sessao' && node.isolar) return { repo, ...prepareWorktree(repo.caminho, board.id, node) };
    // segue a cadeia para trás: a worktree mais próxima de cada caminho. Uma só = continua nela (implementar ->
    // testar -> corrigir na mesma branch); várias (junção de sessões paralelas) = a pasta principal, onde se faz o merge.
    const by = new Map(board.caixas.map((c) => [c.id, c]));
    const deps = depEdges(board);
    const found = new Map();
    const seen = new Set();
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = by.get(id);
      if (p && p.repo === node.repo && p.pasta && p.branch && p.pasta !== repo.caminho && fs.existsSync(p.pasta)) { found.set(p.pasta, p.branch); return; }
      for (const e of deps) if (e.para === id) walk(e.de);
    };
    for (const e of deps) if (e.para === node.id) walk(e.de);
    if (found.size === 1) { const [[cwd, branch]] = [...found]; return { repo, cwd, branch }; }
    return { repo, cwd: repo.caminho, branch: null };
  }

  async runSession(boardId, node, state, follow) {
    const b = this.board(boardId);
    const k = this.key(boardId, node.id);
    let agent = follow ? this.agents.get(k) : null;
    let prompt;
    if (!agent) {
      const { repo, cwd, branch } = this.workdir(b, node);
      agent = this.createAgent({ cwd, model: node.modelo || b.config.modelo || '', effort: node.esforco || '', extraTools: this.noteTools(boardId, node.id) });
      // continuação depois de reiniciar o rfcode: recarrega a conversa salva
      if (follow && node.sessao && agent.sessionManager) {
        const msgs = agent.sessionManager.load(node.sessao);
        if (msgs) agent.messages = msgs;
      }
      const history = !!(agent.messages && agent.messages.length);
      if (!follow) this.logs.set(k, []);
      else if (!(this.logs.get(k) || []).length) this.logs.set(k, this.logOf(boardId, node.id).slice());
      this.agents.set(k, agent);
      this.patch(boardId, node.id, { pasta: cwd, branch: branch || undefined, sessao: agent.sessionManager ? agent.sessionManager.id : undefined });
      // mensagem para uma caixa que nunca rodou: vai junto com o pedido e o contexto do quadro
      prompt = follow && history ? follow : `${buildPrompt(b, node, { repo, cwd, branch })}${follow ? `\n\nInstrução do usuário: ${follow}` : ''}`;
    } else prompt = follow;
    agent.autoApprove = !!node.auto;
    state.agent = agent;
    if (state.stopped) return { status: 'cancelada' };
    this.log(boardId, node.id, { type: 'user', text: follow || String(node.prompt || node.titulo).trim() });
    return this.drive(boardId, node.id, agent, prompt);
  }

  async drive(boardId, nodeId, agent, prompt) {
    let error = '', aborted = false;
    const log = (ev) => this.log(boardId, nodeId, ev);
    const tokens0 = agent.usage ? agent.usage.total : 0;
    let suggestRule = () => '';
    try { ({ suggestRule } = require('./permissions')); } catch { /* opcional */ }
    await agent.send(prompt, {
      onThinking: () => {}, onResponseStart: () => {}, onReasoning: () => {}, onQueued: () => {}, onDone: () => {}, onScreenshot: () => {},
      onText: (t) => log({ type: 'text', text: t }),
      onAssistantEnd: () => log({ type: 'assistantEnd' }),
      onToolCall: (i) => log({ type: 'toolCall', id: i.id, name: i.name, label: i.label, preview: i.preview || null }),
      onToolResult: (r) => log({ type: 'toolResult', id: r.id, name: r.name, output: String(r.output || '').slice(0, 4000), error: !!r.error }),
      onCommandOutput: (t) => log({ type: 'output', text: String(t) }),
      onPlan: (plan) => log({ type: 'plan', plan }),
      onRetry: (t) => log({ type: 'info', text: String(t) }),
      onInfo: (t) => log({ type: 'info', text: String(t) }),
      onModel: (m) => log({ type: 'info', text: `modelo em uso: ${m}` }),
      onUsage: () => {},
      onError: (e) => { error = String(e); log({ type: 'error', text: error }); },
      onAborted: () => { aborted = true; log({ type: 'info', text: 'Sessão interrompida.' }); },
      approve: (info) => this.request(boardId, nodeId, {
        tipo: 'aprovacao', nome: info.name, label: info.label, preview: info.preview || null, motivo: String(info.reason || '').slice(0, 400),
        forcado: !!info.forced, regra: info.forced ? '' : suggestRule(info.name, info.args) || '',
      }),
      ask: ({ question, options }) => this.request(boardId, nodeId, { tipo: 'pergunta', pergunta: String(question || ''), opcoes: (options || []).map(String) }),
    });
    const final = [...(agent.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content && String(m.content).trim());
    return {
      status: aborted ? 'cancelada' : error ? 'falhou' : 'concluida',
      resultado: final ? String(final.content).trim().slice(0, 20000) : undefined,
      erro: error || undefined,
      tokens: (agent.usage ? agent.usage.total : 0) - tokens0,
    };
  }

  runCommand(boardId, node, state) {
    const b = this.board(boardId);
    const cmd = String(node.comando || '').trim();
    if (!cmd) throw new Error('Escreva o comando desta caixa (ex.: npm test).');
    const { cwd, branch } = this.workdir(b, node);
    this.logs.set(this.key(boardId, node.id), []);
    this.patch(boardId, node.id, { pasta: cwd, branch: branch || undefined });
    this.log(boardId, node.id, { type: 'user', text: `$ ${cmd}${branch ? `   (branch ${branch})` : ''}` });
    return new Promise((resolve) => {
      let tail = '';
      const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: true, detached: !IS_WIN });
      state.child = child;
      const onData = (d) => { const t = d.toString(); tail = (tail + t).slice(-8000); this.log(boardId, node.id, { type: 'output', text: t }); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, node.limite * 60000);
      const finish = (code, err) => {
        clearTimeout(timer);
        const resultado = `$ ${cmd}\n${err ? `erro: ${err}` : timedOut ? `passou do limite de ${node.limite} min e foi interrompido` : `código de saída ${code}`}\n\n${cut(tail, 6000)}`;
        this.log(boardId, node.id, { type: code === 0 ? 'info' : 'error', text: code === 0 ? 'Comando concluído (código 0).' : resultado.split('\n')[1] });
        resolve({ status: code === 0 && !timedOut ? 'concluida' : 'falhou', codigo: code == null ? -1 : code, resultado, erro: code === 0 ? undefined : resultado.split('\n')[1] });
      };
      child.on('error', (e) => finish(null, e.message));
      child.on('close', (code) => finish(code));
    });
  }

  // Ferramentas para a sessão ler e escrever nas notas ligadas a ela (o quadro como memória compartilhada).
  noteTools(boardId, nodeId) {
    const notes = () => connectedNotes(this.board(boardId) || { caixas: [], ligacoes: [] }, nodeId);
    if (!notes().length) return null;
    const find = (q) => {
      const list = notes();
      const s = String(q || '').trim().toLowerCase();
      return list.find((n) => n.id === q) || list.find((n) => n.titulo.toLowerCase() === s) || list.find((n) => s && n.titulo.toLowerCase().includes(s)) || (list.length === 1 ? list[0] : null);
    };
    return {
      defs: [
        {
          name: 'nota_ler',
          description: 'Lê as notas do quadro da orquestra ligadas a esta sessão (memória compartilhada entre as sessões do fluxo). Sem "nota", lê todas.',
          parameters: { type: 'object', properties: { nota: { type: 'string', description: 'Título da nota (opcional)' } } },
        },
        {
          name: 'nota_escrever',
          description: 'Escreve numa nota do quadro ligada a esta sessão, para as outras sessões lerem (plano, decisões, descobertas, pendências).',
          parameters: {
            type: 'object',
            properties: {
              nota: { type: 'string', description: 'Título da nota' },
              texto: { type: 'string', description: 'Conteúdo em markdown' },
              modo: { type: 'string', enum: ['acrescentar', 'substituir'], description: 'acrescentar (padrão) ou substituir' },
            },
            required: ['texto'],
          },
        },
      ],
      run: async (name, args) => {
        if (name === 'nota_ler') {
          const list = args && args.nota ? [find(args.nota)].filter(Boolean) : notes();
          if (!list.length) return `Nota não encontrada. Notas ligadas: ${notes().map((n) => n.titulo).join(', ')}`;
          return list.map((n) => `### ${n.titulo}\n${n.texto || '(vazia)'}`).join('\n\n');
        }
        const n = find(args && args.nota);
        if (!n) throw new Error(`Diga em qual nota escrever: ${notes().map((x) => x.titulo).join(', ')}`);
        const texto = String((args && args.texto) || '');
        const novo = (args && args.modo === 'substituir') || !n.texto ? texto : `${n.texto.replace(/\s+$/, '')}\n\n${texto}`;
        this.patch(boardId, n.id, { texto: novo.slice(0, 50000) });
        return `Nota "${n.titulo}" atualizada (${novo.length} caracteres).`;
      },
    };
  }
}

// Agent do rfcode para cada caixa. Modelo e esforço: os da caixa; senão os padrões de quem abriu a orquestra
// (o VS Code passa os das configurações dele); senão os do ~/.rfcode/config.json.
function defaultCreateAgent({ apiKey, model: defModel, effort: defEffort } = {}) {
  return ({ cwd, model, effort, extraTools }) => {
    const { Agent, loadConfig } = require('./agent');
    const cfg = loadConfig();
    return new Agent({
      apiKey: apiKey || cfg.apiKey || process.env.NVIDIA_API_KEY, model: model || defModel || cfg.model || 'auto', effort: effort || defEffort || cfg.effort || 'medium',
      cwd, saveSession: true, extraTools: extraTools || null,
    });
  };
}

module.exports = {
  Orquestra, MODELOS, TIPOS, QUANDO, normalizeBoard, normalizeNode, wouldCycle, depEdges, buildPrompt, edgeOk, fromTemplate,
  listBoards, readBoard, writeBoard, inspectRepo, cloneRepo, listDirs, prepareWorktree, boardsDir, baseDir, GIT_URL,
};
