'use strict';
// Memória do assistente: o que ele aprende sobre o usuário (preferências, dados, jeito de trabalhar) fica em
// ~/.rfcode/MEMORIA.md e entra no prompt de toda conversa. O que é do projeto vai para o RFCODE.md da pasta.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const userFile = () => path.join(HOME(), 'MEMORIA.md');
const MAX = 12000;

function readUserMemory() {
  try { return fs.readFileSync(userFile(), 'utf8').trim().slice(0, MAX); } catch { return ''; }
}

// scope: 'usuario' (padrão) ou 'projeto' (RFCODE.md na pasta). Não duplica uma linha que já existe.
function remember(text, scope = 'usuario', cwd = process.cwd()) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('Informe o que lembrar (text).');
  const file = scope === 'projeto' ? path.join(cwd, 'RFCODE.md') : userFile();
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* arquivo novo */ }
  if (cur.split('\n').some((l) => l.replace(/^[-*]\s*/, '').trim().toLowerCase() === line.toLowerCase())) {
    return `Já estava na memória (${scope}): ${line}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = !cur && scope !== 'projeto' ? '# Memória do rfcode\nO que aprendi sobre você. Pode editar ou apagar linhas à vontade.\n\n' : '';
  const prefix = cur && !cur.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, cur + prefix + header + `- ${line}\n`);
  return `Guardado na memória (${scope === 'projeto' ? 'RFCODE.md do projeto' : 'sua memória'}): ${line}`;
}

function forget(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) throw new Error('Informe o trecho a esquecer.');
  let cur = '';
  try { cur = fs.readFileSync(userFile(), 'utf8'); } catch { return 'A memória está vazia.'; }
  const lines = cur.split('\n');
  const keep = lines.filter((l) => !(l.startsWith('- ') && l.toLowerCase().includes(q)));
  if (keep.length === lines.length) return `Nada na memória contém "${text}".`;
  fs.writeFileSync(userFile(), keep.join('\n'));
  return `Esquecido: ${lines.length - keep.length} linha(s) com "${text}".`;
}

const MEMORY_TOOL_DEF = {
  name: 'remember',
  description: 'Guarda algo para lembrar nas próximas conversas. Use quando o usuário contar uma preferência, um dado pessoal útil, '
    + 'como gosta que as coisas sejam feitas, ou pedir "lembre que...". Uma frase curta e autoexplicativa por vez. '
    + 'scope "usuario" (padrão, vale para tudo) ou "projeto" (vai para o RFCODE.md da pasta). Nunca guarde senhas, tokens ou dados de cartão.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'O que lembrar, ex.: "Prefere respostas curtas" ou "Trabalha com Python e Spark"' },
      scope: { type: 'string', enum: ['usuario', 'projeto'] },
      forget: { type: 'boolean', description: 'true para apagar da memória as linhas que contêm o texto' },
    },
    required: ['text'],
  },
};

module.exports = { readUserMemory, remember, forget, userFile, MEMORY_TOOL_DEF };
