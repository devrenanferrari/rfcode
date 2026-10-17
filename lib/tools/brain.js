'use strict';
// Cérebro do projeto (lib/brain.js): o agente aprende sobre o projeto, recupera, reforça e consolida.
// Sempre disponíveis (sem grupo): são o ciclo de aprendizado central (a "plasticidade").
//   learn    guarda uma lição          recall   busca o que já sabe
//   reflect  consolida no fim da tarefa (o que funcionou / o que evitar)
//   reinforce ajusta a força de lições pelo resultado (o que ajudou sobe; o que enganou desce)

const brain = require('../brain');

function run(name, a, { cwd }) {
  switch (name) {
    case 'learn': return brain.learn(cwd, a);
    case 'recall': {
      const facts = brain.recall(cwd, a);
      if (!facts.length) return a && a.query ? `Nada aprendido ainda sobre "${a.query}".` : 'O cérebro do projeto está vazio.';
      return `O que já sei sobre este projeto${a && a.query ? ` (sobre "${a.query}")` : ''}:\n`
        + facts.map((f) => `- ${f.outcome === 'avoid' ? 'EVITE: ' : ''}${f.text}${(f.tags || []).length ? ` [${f.tags.join(', ')}]` : ''}`).join('\n');
    }
    case 'reinforce': return brain.reinforce(cwd, { query: a.query, delta: a.good === false ? -(Number(a.amount) || 1) : (Number(a.amount) || 0.5) });
    case 'reflect': {
      const worked = [].concat(a.worked || []).map(String).filter(Boolean);
      const avoid = [].concat(a.avoid || []).map(String).filter(Boolean);
      if (!worked.length && !avoid.length) throw new Error('Informe worked (o que funcionou) e/ou avoid (o que evitar).');
      const tags = Array.isArray(a.tags) ? a.tags : (a.tags ? String(a.tags).split(/[,\s]+/) : []);
      const saved = [];
      for (const w of worked) saved.push(brain.learn(cwd, { text: w, tags, outcome: 'ok', weight: 1.5 }));
      for (const v of avoid) saved.push(brain.learn(cwd, { text: v, tags, outcome: 'avoid', weight: 1.5 }));
      return `Consolidado no cérebro (${saved.length} lição(ões)):\n${saved.map((s) => `- ${s}`).join('\n')}`;
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
        + 'Fica em .rfcode/brain.json e volta nas próximas conversas. Diferente de remember (preferências do usuário). '
        + 'outcome "avoid" marca algo a não repetir. Uma lição curta por vez. Nunca guarde segredos.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A lição, ex.: "Os testes rodam com npm test (node --test)"' },
          tags: { type: 'array', items: { type: 'string' } },
          outcome: { type: 'string', enum: ['ok', 'avoid'], description: '"ok" funcionou; "avoid" deu errado, não repita' },
        },
        required: ['text'],
      },
    },
    {
      name: 'recall',
      description: 'Consulta o cérebro do projeto (o que você já aprendeu) antes de investigar do zero. query com o assunto; sem query, lista os fatos mais fortes/recentes. '
        + 'Recuperar um fato o reforça (quanto mais útil, mais à vista fica).',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    },
    {
      name: 'reflect',
      description: 'No fim de uma tarefa não trivial, consolida o aprendizado de uma vez: worked (o que funcionou, vira lição reforçada) e avoid (o que deu errado, '
        + 'vira aviso para não repetir). É a etapa que transforma a experiência desta tarefa em memória útil para as próximas. Use quando houve tentativa e erro, '
        + 'uma descoberta sobre o projeto, ou um caminho que funcionou bem.',
      parameters: {
        type: 'object',
        properties: {
          worked: { type: 'array', items: { type: 'string' }, description: 'Lições do que funcionou' },
          avoid: { type: 'array', items: { type: 'string' }, description: 'O que evitar da próxima vez' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'reinforce',
      description: 'Ajusta a força das lições do cérebro sobre um assunto conforme o resultado: good=true fortalece (o que você acabou de confirmar que ajuda), '
        + 'good=false enfraquece (o que te enganou; se o peso zerar, o fato é esquecido). É o ajuste fino da memória pela experiência.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Assunto das lições a ajustar' }, good: { type: 'boolean', description: 'true fortalece, false enfraquece' }, amount: { type: 'number' } },
        required: ['query'],
      },
    },
  ],
  run,
  describe(name, a) {
    if (name === 'learn') return `Aprender(${String(a.text || '').slice(0, 60)})`;
    if (name === 'reflect') return `Refletir(${([].concat(a.worked || []).length)}+${([].concat(a.avoid || []).length)})`;
    if (name === 'reinforce') return `Reforçar(${a.good === false ? '-' : '+'} ${String(a.query || '').slice(0, 40)})`;
    return `Lembrar(${String(a.query || 'recentes').slice(0, 50)})`;
  },
  needsApproval: () => false, // só escreve no arquivo interno do rfcode (.rfcode/brain.json)
  _test: { run },
};
