const { Agent } = require('./lib/agent');
// Dummy agent just to call update_plan
const agent = new Agent({ apiKey: 'x', cwd: process.cwd() });
// Update plan showing all steps completed
agent.update_plan({
  goal: 'Implementar sessões salvas e retomada (T07)',
  steps: [
    { text: 'Criar lib/sessions.js para salvar e carregar sessões', status: 'done' },
    { text: 'Modificar lib/agent.js para salvar sessão após cada resposta', status: 'done' },
    { text: 'Adicionar comandos /sessions e /resume na CLI (bin/rfcode.js)', status: 'done' },
    { text: 'Escrever testes de aceitação em test/sessions.test.js', status: 'done' }
  ],
  why: 'Todas as etapas concluídas: sessões implementadas, testes passando'
});
console.log('Plano atualizado: todas as etapas concluídas.');