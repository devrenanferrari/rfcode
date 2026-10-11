'use strict';
// Módulo de ferramentas: análise de dados (data_query) e Excel (create_xlsx).
const { DATA_TOOL_DEFS, runDataTool, dataDescribe } = require('../data');

module.exports = {
  defs: DATA_TOOL_DEFS,
  run: (name, args, { cwd }) => runDataTool(name, args, cwd),
  describe: dataDescribe,
  // consultar não muda nada; gravar arquivo (save ou create_xlsx) pede aprovação
  needsApproval: (name, args) => name === 'create_xlsx' || !!args.save,
  group: {
    name: 'dados', desc: 'análise de dados com SQL (CSV, Excel, JSON, SQLite) e criação de planilhas Excel',
    hint: /\b(csv|tsv|xlsx?|excel|planilha|dados|base de dados|tabela|sql|sqlite|consulta|soma|m[eé]dia|agrupar|relat[oó]rio|dashboard|power ?bi|kpi|m[eé]tricas?|vendas|faturamento)\b|\.(csv|tsv|xlsx|json|db|sqlite)\b/i,
  },
};
