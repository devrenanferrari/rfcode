'use strict';
// Ferramentas do cérebro do projeto (lib/brain.js): o agente aprende sobre o projeto e recupera o que já sabe.
// Sempre disponíveis (sem grupo): fazem parte do raciocínio central.

const brain = require('../brain');

function run(name, a, { cwd }) {
  switch (name) {
    case 'learn': return brain.learn(cwd, a);
    case 'recall': {
      const facts = brain.recall(cwd, a);
      if (!facts.length) return a && a.query ? `Nada aprendido ainda sobre "${a.query}".` : 'O cérebro do projeto está vazio.';
      return `O que já sei sobre este projeto${a && a.query ? ` (sobre "${a.query}")` : ''}:\n`
        + facts.map((f) => `- ${f.text}${(f.tags || []).length ? ` [${f.tags.join(', ')}]` : ''}`).join('\n');
    }
    default: throw new Error(`desconhecida: ${name}`);
  }
}

module.exports = {
  defs: [
    {
      name: 'learn',
      description: 'Guarda no cérebro do projeto um fato que VOCÊ descobriu e que vai economizar tempo no futuro: como buildar/rodar/testar, '
        + 'onde fica cada parte do código, armadilhas, decisões de arquitetura, a causa de um bug já corrigido, comandos que funcionaram. '
        + 'Fica em .rfcode/brain.json e volta nas próximas conversas. É diferente de remember (preferências do usuário). '
        + 'Uma lição curta e concreta por vez. Nunca guarde segredos (senhas, tokens, chaves).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A lição, ex.: "Os testes rodam com npm test (node --test); test/core.test.js é protegido"' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Palavras-chave para achar depois, ex.: ["build","testes"]' },
        },
        required: ['text'],
      },
    },
    {
      name: 'recall',
      description: 'Consulta o cérebro do projeto (o que você já aprendeu em conversas anteriores) antes de investigar do zero. '
        + 'Passe query com o assunto (ex.: "como rodar os testes", "onde fica a autenticação"). Sem query, lista os fatos mais recentes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Assunto a recuperar' },
          limit: { type: 'number', description: 'Máximo de fatos (padrão 8)' },
        },
      },
    },
  ],
  run,
  describe: (name, a) => (name === 'learn' ? `Aprender(${String(a.text || '').slice(0, 70)})` : `Lembrar(${String(a.query || 'recentes').slice(0, 50)})`),
  needsApproval: () => false, // só escreve num arquivo interno do rfcode (.rfcode/brain.json)
  _test: { run },
};
