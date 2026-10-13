'use strict';
// Raciocínio deliberado e autocrítica. Não altera nada: serve para o agente parar e pensar em voz alta
// antes de uma decisão difícil, listar hipóteses/riscos e checar o próprio trabalho contra o pedido.
// Pensar explicitamente melhora muito o resultado em tarefas com várias etapas ou ambíguas.

function think(a) {
  const thought = String(a.thought || '').trim();
  if (!thought) throw new Error('Escreva o raciocínio (thought).');
  const parts = [];
  if (Array.isArray(a.options) && a.options.length) parts.push(`Opções consideradas:\n${a.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}`);
  if (Array.isArray(a.risks) && a.risks.length) parts.push(`Riscos/dúvidas:\n${a.risks.map((r) => `  - ${r}`).join('\n')}`);
  if (a.decision) parts.push(`Decisão: ${a.decision}`);
  const extra = parts.length ? `\n\n${parts.join('\n')}` : '';
  // Devolve o raciocínio de volta como âncora e lembra de agir (não ficar só pensando).
  return `Raciocínio registrado.${extra}\n\nAgora execute a decisão; não repita o raciocínio para o usuário.`;
}

function critique(a) {
  const goal = String(a.goal || '').trim();
  const criteria = Array.isArray(a.criteria) ? a.criteria.filter(Boolean) : [];
  if (!goal && !criteria.length) throw new Error('Informe goal e/ou criteria (o que o resultado precisa cumprir).');
  const list = criteria.length ? criteria.map((c) => `  [ ] ${c}`).join('\n') : '  [ ] (liste os critérios de aceitação do pedido)';
  return `Autoverificação antes de concluir${goal ? ` (objetivo: ${goal})` : ''}.\n`
    + `Cheque CADA item contra o resultado real (rode o teste/leia o arquivo) e só então conclua:\n${list}\n\n`
    + 'Se algum item falhar, corrija antes de responder. Relate com fidelidade o que passou e o que não deu para verificar.';
}

module.exports = {
  defs: [
    {
      name: 'think',
      description: 'Pensa antes de agir, sem alterar nada. Use em decisões difíceis, bugs sutis, escolhas de arquitetura ou quando o pedido é ambíguo: '
        + 'escreva o raciocínio, as opções, os riscos e a decisão. Ajuda a não sair fazendo errado. Depois, execute a decisão.',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: 'O raciocínio em texto livre' },
          options: { type: 'array', items: { type: 'string' }, description: 'Caminhos considerados' },
          risks: { type: 'array', items: { type: 'string' }, description: 'Riscos, dúvidas ou casos de borda' },
          decision: { type: 'string', description: 'A escolha e o porquê' },
        },
        required: ['thought'],
      },
    },
    {
      name: 'self_check',
      description: 'Monta uma checklist de verificação a partir do objetivo e dos critérios de aceitação do pedido, para conferir item por item '
        + 'antes de concluir. Use no fim de tarefas importantes, junto com rodar os testes/o build.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Objetivo da tarefa em uma frase' },
          criteria: { type: 'array', items: { type: 'string' }, description: 'O que o resultado precisa cumprir (cada item verificável)' },
        },
      },
    },
  ],
  run: (name, a) => (name === 'self_check' ? critique(a) : think(a)),
  describe: (name, a) => (name === 'self_check' ? `Verificar(${(a.criteria || []).length} itens)` : `Pensar(${String(a.thought || '').slice(0, 60)})`),
  needsApproval: () => false, // não altera nada
  _test: { think, critique },
};
