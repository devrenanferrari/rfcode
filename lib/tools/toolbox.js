'use strict';
// Caixa de ferramentas: dá ao agente um repertório de ~200 CLIs famosos do dev (lib/toolcatalog.js) que ele
// pode DESCOBRIR (toolbox) e EXECUTAR instalando sob demanda (toolbox_run). É a filosofia Claude/Codex em escala:
// um catálogo pesquisável e dois despachantes, em vez de uma ferramenta dedicada por programa (que incharia o contexto).

const { CATALOG, CATEGORIES, find } = require('../toolcatalog');
const setup = require('./setup');
const { run } = require('./_exec');

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function listLine(t) {
  const installed = setup.has(t.b || t.n) ? ' [instalado]' : '';
  return `- ${t.n}${t.b && t.b !== t.n ? ` (cmd: ${t.b})` : ''} — ${t.d}${installed}`;
}

function toolbox(a) {
  const action = a.action || (a.query ? 'search' : 'categories');
  if (action === 'categories') {
    const counts = {};
    for (const t of CATALOG) counts[t.c] = (counts[t.c] || 0) + 1;
    return `Caixa de ferramentas: ${CATALOG.length} programas em ${Object.keys(CATEGORIES).length} categorias.\n`
      + Object.entries(CATEGORIES).map(([k, label]) => `- ${k}: ${label} (${counts[k] || 0})`).join('\n')
      + '\n\nUse toolbox com category para listar uma, ou query para buscar. Depois rode com toolbox_run.';
  }
  if (action === 'list') {
    const cat = String(a.category || '').toLowerCase();
    if (!CATEGORIES[cat]) throw new Error(`Categoria inválida. Use uma de: ${Object.keys(CATEGORIES).join(', ')}.`);
    const items = CATALOG.filter((t) => t.c === cat);
    return `${CATEGORIES[cat]} (${items.length}):\n${items.map(listLine).join('\n')}`;
  }
  // search
  const q = norm(a.query);
  if (!q) throw new Error('Informe query (o que procurar) ou category.');
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = CATALOG.map((t) => {
    const hay = norm(`${t.n} ${t.b || ''} ${t.d} ${t.c} ${CATEGORIES[t.c]}`);
    let s = 0;
    for (const term of terms) { if (norm(t.n) === term) s += 20; else if (hay.includes(term)) s += 5; }
    return { t, s };
  }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, Number(a.limit) || 30);
  if (!scored.length) return `Nada no catálogo para "${a.query}". Veja as categorias com toolbox (action categories) ou rode um comando direto com run_command.`;
  return `Resultados para "${a.query}" (${scored.length}):\n${scored.map((x) => listLine(x.t)).join('\n')}\n\nRode uma com toolbox_run (name + args). Se faltar, é instalada sob demanda (com aprovação).`;
}

function toolboxRun(a, ctx) {
  const entry = find(a.name);
  const bin = entry ? (entry.b || entry.n) : String(a.name || '').trim();
  if (!bin || !/^[\w.+-]+$/.test(bin)) throw new Error('Informe name (nome da ferramenta no catálogo).');
  const args = a.args == null ? [] : (Array.isArray(a.args) ? a.args.map(String) : null);
  if (args === null) throw new Error('args deve ser uma lista de strings (ex.: ["--version"]).');

  let installNote = '';
  if (!setup.has(bin)) {
    if (a.install === false) throw new Error(`"${bin}" não está instalado. Rode de novo sem install:false para instalar, ou instale manualmente.`);
    const r = setup.install(bin, entry ? entry.i : null, ctx, { via: a.via });
    installNote = r.text + '\n\n';
    if (!setup.has(bin)) return installNote + `Não consegui deixar "${bin}" disponível; veja o erro acima.`;
  }
  const { code, out } = run(bin, args, { ...ctx, timeout: Number(a.timeout_ms) || 600000 });
  return `${installNote}$ ${bin} ${args.join(' ')}\n(código ${code})\n\n${out || '(sem saída)'}`;
}

module.exports = {
  defs: [
    {
      name: 'toolbox',
      description: `Descobre ferramentas de linha de comando famosas do dev num catálogo de ${CATALOG.length} programas (git, JS/TS, Python, Go/Rust, Docker/Kubernetes, nuvem, IaC, bancos, HTTP/rede, mídia, busca, linters, segurança/engenharia reversa, shell). `
        + 'action=categories lista as categorias; action=list com category lista uma; action=search com query busca por palavra. Depois rode com toolbox_run. '
        + 'Pense assim: em vez de ter uma ferramenta pronta para tudo, você consulta o catálogo, escolhe a certa e executa. Só leitura.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['categories', 'list', 'search'] },
          query: { type: 'string', description: 'Busca por palavra (ex.: "pdf", "kubernetes", "json")' },
          category: { type: 'string', description: 'Categoria para listar (veja action categories)' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'toolbox_run',
      description: 'Executa uma ferramenta do catálogo (toolbox), instalando-a sob demanda se faltar (com aprovação) pelo gerenciador certo do sistema. '
        + 'name é o nome no catálogo; args é a lista de argumentos. Ex.: name "jq", args [".items", "dados.json"]. '
        + 'Também aceita um comando conhecido fora do catálogo (tenta instalar pelo mesmo nome). Para pipelines complexos, prefira run_command.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome da ferramenta (ex.: "ripgrep"/"rg", "ffmpeg", "kubectl")' },
          args: { type: 'array', items: { type: 'string' }, description: 'Argumentos da linha de comando' },
          install: { type: 'boolean', description: 'Instalar se faltar (padrão true)' },
          via: { type: 'string', description: 'Forçar um gerenciador de instalação' },
          timeout_ms: { type: 'number' },
        },
        required: ['name'],
      },
    },
  ],
  run(name, a, ctx) { return name === 'toolbox_run' ? toolboxRun(a, ctx) : toolbox(a); },
  describe(name, a) {
    if (name === 'toolbox_run') return `Rodar(${a.name} ${(a.args || []).join(' ')})`.slice(0, 80);
    return `Catálogo(${a.action || (a.query ? `buscar "${a.query}"` : 'categorias')})`;
  },
  needsApproval: (name) => name === 'toolbox_run', // executa/instala
  _test: { toolbox, toolboxRun },
};
