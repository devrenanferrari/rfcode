'use strict';
// Módulo de ferramentas: entender bases de código grandes (mapa, símbolos, referências, dependências, busca por significado).
const code = require('../code');
const providers = require('../providers');

// endpoint de embeddings da NVIDIA (gratuito); sem chave da NVIDIA, a busca usa palavras
function embedEndpoint(agent) {
  try {
    const cfg = agent.providerConfig();
    if (!providers.keyFor('nvidia', cfg)) return null;
    const ep = providers.endpoint('nvidia/nemotron-3-embed-1b', cfg);
    return ep;
  } catch { return null; }
}

const DEFS = [
  { name: 'code_map', description: 'Mapa do código: arquivos com classes, funções e métodos e a linha de cada um (12 linguagens). Comece por aqui para entender um projeto ou uma pasta; em projetos grandes mostra o resumo por pasta e os arquivos centrais.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Pasta ou arquivo (padrão: projeto inteiro)' } } } },
  { name: 'find_symbol', description: 'Onde uma função, classe ou método é definido (arquivo:linha e assinatura). Aceita "Classe.metodo" e parte do nome.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['class', 'function', 'method', 'type'] } }, required: ['name'] } },
  { name: 'find_references', description: 'Todos os lugares que usam um identificador (chamadas, imports, leituras), agrupados por arquivo. Use antes de renomear ou mudar a assinatura de algo.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string', description: 'Limitar a uma pasta' } }, required: ['name'] } },
  { name: 'read_symbol', description: 'Lê só o corpo completo de uma função, método ou classe (com comentários acima e números de linha), sem abrir o arquivo inteiro. Economiza contexto em arquivos grandes.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Nome ou Classe.metodo' }, path: { type: 'string', description: 'Arquivo, quando há nomes repetidos' } }, required: ['name'] } },
  { name: 'code_deps', description: 'Dependências: o que um arquivo importa, quem o importa e o impacto de mudá-lo (dependentes diretos e indiretos). Sem path: arquivos centrais e pontos de entrada do projeto.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'code_search', description: 'Busca no código por significado, em linguagem natural ("onde o desconto é calculado", "validação do token de login"). Use quando não souber o nome da função. Na primeira vez indexa o projeto.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, path: { type: 'string' } }, required: ['query'] } },
];

module.exports = {
  defs: DEFS,
  async run(name, a, { cwd, agent, hooks }) {
    switch (name) {
      case 'code_map': return code.codeMap(cwd, a);
      case 'find_symbol': return code.findSymbol(cwd, a);
      case 'find_references': return code.findReferences(cwd, a);
      case 'read_symbol': return code.readSymbol(cwd, a);
      case 'code_deps': return code.codeDeps(cwd, a);
      case 'code_search': return code.codeSearch(cwd, a, { embedEndpoint: embedEndpoint(agent), onProgress: (m) => hooks && hooks.onInfo && hooks.onInfo(m) });
      default: throw new Error(`desconhecida: ${name}`);
    }
  },
  describe(name, a) {
    const label = { code_map: 'Mapa', find_symbol: 'Definição', find_references: 'Referências', read_symbol: 'Símbolo', code_deps: 'Dependências', code_search: 'BuscaCódigo' }[name];
    return `${label}(${a.name || a.query || a.path || '.'})`;
  },
  needsApproval: () => false,
  group: {
    name: 'codigo', desc: 'entender código: mapa de símbolos, definição, referências, leitura de uma função, dependências e busca por significado',
    hint: /\b(c[oó]digo|fun[cç][aã]o|fun[cç][oõ]es|classe|m[eé]todo|arquitetura|projeto|reposit[oó]rio|repo|bug|erro|refator|implement|entend|explique|como funciona|onde (fica|est[aá]|[eé])|quem (chama|usa)|depend|m[oó]dulo|api|endpoint|teste|feature|codebase|legado)\b|\.(js|ts|tsx|jsx|py|java|cs|go|rs|php|rb|cpp|c|h|kt|swift|vue|sql)\b/i,
  },
};
