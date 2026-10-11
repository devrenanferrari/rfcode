'use strict';
// Módulo de ferramentas: carrega uma skill (procedimento ensinado pelo usuário ou pela empresa).
const { loadSkill } = require('../skills');

module.exports = {
  defs: [{
    name: 'use_skill',
    description: 'Carrega as instruções de uma skill da lista "Skills" do prompt (procedimentos da empresa ou do usuário). Use antes de começar uma tarefa que a skill cobre.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  }],
  run: (name, args, { cwd }) => loadSkill(cwd, args.name),
  describe: (name, a) => `Skill(${a.name})`,
  needsApproval: () => false,
};
