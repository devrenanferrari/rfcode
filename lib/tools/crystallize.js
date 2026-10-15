'use strict';
// Auto-extensão (plasticidade que vira estrutura): quando um procedimento se repete, o agente o cristaliza
// num comando reutilizável do rfcode (.rfcode/commands/<nome>.md no projeto, ou ~/.rfcode/commands para o usuário).
// Depois é só chamar /<nome> no chat. O conteúdo do arquivo vira o pedido ao agente; $ARGUMENTS recebe o texto digitado.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');

function crystallize(a, { cwd }) {
  const name = String(a.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) throw new Error('name deve ser um identificador curto (letras, números, hífen, _), ex.: "testar-arquivo".');
  const body = String(a.body || '').trim();
  if (!body) throw new Error('Informe body: o procedimento/prompt que o comando executa (pode usar $ARGUMENTS para o texto digitado depois do comando).');
  const desc = String(a.description || '').replace(/\s+/g, ' ').trim();
  const dir = a.scope === 'usuario' ? path.join(HOME(), 'commands') : path.join(cwd, '.rfcode', 'commands');
  const file = path.join(dir, `${name}.md`);
  const existed = fs.existsSync(file);
  if (existed && !a.overwrite) throw new Error(`O comando /${name} já existe em ${path.relative(cwd, file).replace(/\\/g, '/')}. Use overwrite: true para substituir.`);
  fs.mkdirSync(dir, { recursive: true });
  const content = (desc ? `description: ${desc}\n` : '') + body + (body.endsWith('\n') ? '' : '\n');
  fs.writeFileSync(file, content);
  const where = a.scope === 'usuario' ? 'seu usuário (todos os projetos)' : 'este projeto';
  return `${existed ? 'Atualizado' : 'Cristalizado'} o comando /${name} em ${where}: ${path.relative(cwd, file).replace(/\\/g, '/') || file}.\n`
    + `Agora é só digitar /${name}${/\$ARGUMENTS/.test(body) ? ' <texto>' : ''} no chat para executar este procedimento.`;
}

module.exports = {
  defs: [{
    name: 'crystallize',
    description: 'Cristaliza um procedimento que se repete num comando reutilizável do rfcode (/<nome>), em vez de refazer os passos toda vez. '
      + 'Use quando o usuário pedir um atalho ("sempre que eu pedir X, faça Y"), ou quando você perceber que repete a mesma sequência. '
      + 'body é o que o comando faz (pode conter $ARGUMENTS para o texto digitado após o comando). scope "projeto" (padrão, vale para o time se versionar) ou "usuario".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome do comando (vira /nome), ex.: "revisar-pr"' },
        description: { type: 'string', description: 'Uma frase que aparece na lista de comandos' },
        body: { type: 'string', description: 'O procedimento/prompt; use $ARGUMENTS onde entra o texto digitado' },
        scope: { type: 'string', enum: ['projeto', 'usuario'], description: 'Padrão: projeto' },
        overwrite: { type: 'boolean', description: 'Substituir se já existir' },
      },
      required: ['name', 'body'],
    },
  }],
  run: (name, a, ctx) => crystallize(a, ctx),
  describe: (name, a) => `Cristalizar(/${String(a.name || '').slice(0, 40)})`,
  needsApproval: () => true, // cria um comando que o usuário poderá executar
  group: {
    name: 'comandos', desc: 'cristalizar um procedimento repetido num comando reutilizável (/nome)',
    hint: /\b(comando|atalho|cristaliz|toda vez que|sempre que|repetir|de novo o mesmo|criar um \/|vira comando|automatiz)/i,
  },
  _test: { crystallize },
};
