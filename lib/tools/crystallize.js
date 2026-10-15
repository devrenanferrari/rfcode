'use strict';
// Auto-extensão (plasticidade que vira estrutura): quando um procedimento se repete, o agente o cristaliza
// num comando reutilizável do rfcode (.rfcode/commands/<nome>.md no projeto, ou ~/.rfcode/commands para o usuário).
// Depois é só chamar /<nome> no chat. O conteúdo do arquivo vira o pedido ao agente; $ARGUMENTS recebe o texto digitado.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');

function asCommand(a, cwd, name, body, desc) {
  const dir = a.scope === 'usuario' ? path.join(HOME(), 'commands') : path.join(cwd, '.rfcode', 'commands');
  const file = path.join(dir, `${name}.md`);
  const existed = fs.existsSync(file);
  if (existed && !a.overwrite) throw new Error(`O comando /${name} já existe em ${path.relative(cwd, file).replace(/\\/g, '/')}. Use overwrite: true para substituir.`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, (desc ? `description: ${desc}\n` : '') + body + (body.endsWith('\n') ? '' : '\n'));
  const where = a.scope === 'usuario' ? 'seu usuário (todos os projetos)' : 'este projeto';
  return `${existed ? 'Atualizado' : 'Cristalizado'} o comando /${name} em ${where}: ${path.relative(cwd, file).replace(/\\/g, '/') || file}.\n`
    + `Agora é só digitar /${name}${/\$ARGUMENTS/.test(body) ? ' <texto>' : ''} no chat para executar este procedimento.`;
}

function asSkill(a, cwd, name, body, desc) {
  if (!desc) throw new Error('Para uma skill, description é obrigatória: UMA frase dizendo QUANDO usar a skill.');
  const dir = (a.scope === 'usuario' ? path.join(HOME(), 'skills') : path.join(cwd, '.rfcode', 'skills'));
  const skillDir = path.join(dir, name);
  const file = path.join(skillDir, 'SKILL.md');
  const existed = fs.existsSync(file);
  if (existed && !a.overwrite) throw new Error(`A skill ${name} já existe em ${path.relative(cwd, file).replace(/\\/g, '/')}. Use overwrite: true para substituir.`);
  const keywords = (Array.isArray(a.keywords) ? a.keywords : String(a.keywords || '').split(/[,\s]+/)).map((k) => String(k).trim()).filter(Boolean);
  fs.mkdirSync(skillDir, { recursive: true });
  const front = `---\nname: ${name}\ndescription: ${desc}\n${keywords.length ? `keywords: ${keywords.join(', ')}\n` : ''}---\n\n`;
  // se o body já vem com seções, respeita; senão embrulha num esqueleto padrão
  const content = /^#|Passo a passo|Quando usar/i.test(body) ? body : `# ${name}\n\n## Quando usar\n${desc}\n\n## Passo a passo\n${body}\n\n## Regras\n- (sempre/nunca, se houver)\n`;
  fs.writeFileSync(file, front + content + (content.endsWith('\n') ? '' : '\n'));
  const where = a.scope === 'usuario' ? 'seu usuário' : 'este projeto (versione para o time usar)';
  return `${existed ? 'Atualizada' : 'Cristalizada'} a skill "${name}" em ${where}: ${path.relative(cwd, file).replace(/\\/g, '/') || file}.\n`
    + 'Ela entra sozinha quando o pedido casar com a descrição/keywords. Veja com /skills.';
}

function crystallize(a, { cwd }) {
  const name = String(a.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) throw new Error('name deve ser um identificador curto (letras, números, hífen, _), ex.: "testar-arquivo".');
  const body = String(a.body || '').trim();
  if (!body) throw new Error('Informe body: o procedimento (para comando, pode usar $ARGUMENTS; para skill, os passos).');
  const desc = String(a.description || '').replace(/\s+/g, ' ').trim();
  return a.kind === 'skill' ? asSkill(a, cwd, name, body, desc) : asCommand(a, cwd, name, body, desc);
}

module.exports = {
  defs: [{
    name: 'crystallize',
    description: 'Cristaliza um procedimento que se repete em algo reutilizável, em vez de refazer os passos toda vez. '
      + 'kind "comando" (padrão) cria um comando /<nome> (body pode usar $ARGUMENTS). kind "skill" cria uma skill (.rfcode/skills/<nome>/SKILL.md) '
      + 'que entra sozinha quando o pedido casa com a descrição/keywords, boa para procedimentos ricos e recorrentes. '
      + 'Use quando o usuário pedir um atalho, ou quando você perceber que repete a mesma sequência. scope "projeto" (padrão) ou "usuario".',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['comando', 'skill'], description: 'Padrão: comando' },
        name: { type: 'string', description: 'Nome curto (vira /nome ou o nome da skill), ex.: "revisar-pr"' },
        description: { type: 'string', description: 'Uma frase; para skill, diz QUANDO usar (obrigatória)' },
        body: { type: 'string', description: 'O procedimento; comando: prompt com $ARGUMENTS; skill: os passos (seções opcionais)' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'skill: palavras que ativam a skill' },
        scope: { type: 'string', enum: ['projeto', 'usuario'], description: 'Padrão: projeto' },
        overwrite: { type: 'boolean', description: 'Substituir se já existir' },
      },
      required: ['name', 'body'],
    },
  }],
  run: (name, a, ctx) => crystallize(a, ctx),
  describe: (name, a) => `Cristalizar(${a.kind === 'skill' ? 'skill ' : '/'}${String(a.name || '').slice(0, 40)})`,
  needsApproval: () => true, // cria um comando que o usuário poderá executar
  group: {
    name: 'comandos', desc: 'cristalizar um procedimento repetido num comando reutilizável (/nome)',
    hint: /\b(comando|atalho|cristaliz|toda vez que|sempre que|repetir|de novo o mesmo|criar um \/|vira comando|automatiz)/i,
  },
  _test: { crystallize },
};
