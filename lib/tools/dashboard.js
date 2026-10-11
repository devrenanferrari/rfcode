'use strict';
// Módulo de ferramentas: dashboards interativos (HTML único) que abrem no VS Code ou no navegador.
const path = require('path');
const { createDashboard, THEMES } = require('../dashboard');

module.exports = {
  defs: [{
    name: 'create_dashboard',
    description: 'Cria um dashboard interativo (um arquivo .html, sem internet) e abre para o usuário: indicadores, gráficos com valores ao passar o mouse, tabelas com ordenação e busca, e filtros que recalculam tudo. '
      + 'data: arquivo ("vendas.csv", .xlsx, .json, .db), { files: { t: "a.csv" }, sql: "SELECT ..." } ou lista de linhas; datasets: { nome: fonte } para mais de uma base. filters: colunas que viram filtros. '
      + 'widgets: kpi { title, field, agg: sum|avg|count|min|max|distinct, format: moeda|percentual|compacto, target?, compare? { field, agg, label } } | '
      + 'chart { title, chart: bar|barh|stacked|line|area|pie|donut|scatter|funnel, x, y (campo ou lista), agg, series? (campo que vira cores), sort: desc|asc|x, limit, format } | '
      + 'table { title, columns? ou group_by + measures [{ field, agg, label }], sort, limit } | text { markdown }. width: 1 a 4 colunas da grade (kpi 1, gráfico 2, tabela/texto 4). '
      + 'Comece com 3 ou 4 KPIs, depois os gráficos que respondem às perguntas principais e por último a tabela de detalhe. Temas: claro, escuro, consultoria, papel.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo de saída (.html)' },
        title: { type: 'string' }, subtitle: { type: 'string' },
        theme: { type: 'string', enum: Object.keys(THEMES) },
        data: { description: 'Fonte de dados padrão' },
        datasets: { type: 'object' },
        filters: { type: 'array', items: {} },
        widgets: { type: 'array', items: { type: 'object' } },
        open: { type: 'boolean', description: 'Abrir para o usuário (padrão: sim)' },
      },
      required: ['path', 'widgets'],
    },
  }],
  async run(name, a, { cwd, agent, hooks }) {
    const full = path.resolve(cwd, a.path || 'dashboard.html');
    if (!/\.html?$/i.test(full)) throw new Error('O caminho deve terminar em .html');
    let widgets = a.widgets;
    if (typeof widgets === 'string') widgets = require('../jsonfix').parseLoose(widgets);
    const r = await createDashboard(full, { ...a, widgets }, cwd);
    const rel = path.relative(cwd, full).split(path.sep).join('/');
    if (a.open !== false && agent && agent.interactive !== false && hooks && hooks.onOpenFile) hooks.onOpenFile({ path: full, kind: 'dashboard', title: a.title });
    return `Dashboard criado: ${rel} (${r.widgets} blocos, ${r.rows} linhas de dados, ${Math.round(r.bytes / 1024)} KB, arquivo único que funciona sem internet).`
      + (agent && agent.interactive !== false ? ' Foi aberto para o usuário.' : '');
  },
  describe: (name, a) => `Dashboard(${a.path})`,
  needsApproval: () => true,
  group: {
    name: 'dashboard', desc: 'dashboards interativos em HTML (indicadores, gráficos, tabelas e filtros)',
    hint: /\b(dashboards?|painel|pain[eé]is|kpis?|indicadores|visualiza|gr[aá]ficos? interativ|monitor|acompanhamento|relat[oó]rio interativo|bi)\b/i,
  },
};
