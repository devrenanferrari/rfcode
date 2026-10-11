'use strict';
// Comandos com "/" compartilhados pela CLI e pela extensão: lista dos embutidos, comandos personalizados
// (.rfcode/commands/<nome>.md no projeto ou em ~/.rfcode/commands) e os prompts dos comandos que viram pedido ao agente.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { INIT_PROMPT } = require('./prompts');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');

// where: onde o comando existe ('ui' = painel do VS Code, 'cli' = terminal)
const BUILTIN = [
  { name: 'help', desc: 'Lista os comandos', where: ['ui', 'cli'] },
  { name: 'new', aliases: ['clear'], desc: 'Começa uma conversa nova', where: ['ui', 'cli'] },
  { name: 'history', aliases: ['resume', 'sessions'], desc: 'Abre o histórico de conversas', where: ['ui', 'cli'] },
  { name: 'model', args: '[modelo]', desc: 'Mostra ou troca o modelo', where: ['ui', 'cli'] },
  { name: 'models', args: '[provedor]', desc: 'Lista os modelos disponíveis', where: ['ui', 'cli'] },
  { name: 'provider', args: '[provedor]', desc: 'Configura um provedor (OpenRouter, Groq, OpenAI, Anthropic, Gemini, Ollama...)', where: ['ui', 'cli'] },
  { name: 'doctor', desc: 'Verifica o ambiente, as chaves e as ferramentas', where: ['ui', 'cli'] },
  { name: 'auto', desc: 'Liga ou desliga a aprovação automática', where: ['ui', 'cli'] },
  { name: 'undo', desc: 'Desfaz a última alteração de arquivo do agente', where: ['ui', 'cli'] },
  { name: 'plan', args: '<pedido>', desc: 'Investiga e propõe um plano sem alterar nada', where: ['ui', 'cli'] },
  { name: 'go', desc: 'Aprova o plano e executa', where: ['ui', 'cli'] },
  { name: 'init', desc: 'Cria o RFCODE.md com as instruções deste projeto', where: ['ui', 'cli'] },
  { name: 'review', desc: 'Revisa as mudanças não commitadas (git diff) em busca de bugs', where: ['ui', 'cli'] },
  { name: 'compact', desc: 'Resume a conversa para liberar contexto', where: ['ui', 'cli'] },
  { name: 'memory', args: '[texto]', desc: 'Mostra a memória do rfcode sobre você, ou guarda um texto nela', where: ['ui', 'cli'] },
  { name: 'remote', desc: 'Controle remoto: use o rfcode pelo celular', where: ['ui'] },
  { name: 'key', desc: 'Troca a API key da NVIDIA', where: ['ui', 'cli'] },
  { name: 'think', desc: 'Mostra ou oculta o raciocínio do modelo', where: ['cli'] },
  { name: 'cd', args: '<pasta>', desc: 'Muda a pasta de trabalho', where: ['cli'] },
  { name: 'exit', aliases: ['quit', 'sair'], desc: 'Sai do rfcode', where: ['cli'] },
];

const REVIEW_PROMPT = `Revise as mudanças abaixo (git diff do que ainda não foi commitado) procurando bugs reais: erros de lógica, casos de borda, regressões, problemas de segurança e de concorrência.
- NÃO edite nada; só leia o código ao redor quando precisar de contexto.
- Para cada problema: arquivo:linha, severidade (alta, média ou baixa), o que acontece de errado e um cenário concreto que dispara o bug.
- Não comente estilo nem gosto pessoal. Se não achar nada sério, diga isso claramente.`;

const PLAN_PREFIX = 'MODO PLANO: investigue o necessário e proponha um plano com update_plan (objetivo, passos e o porquê). '
  + 'Não altere nada agora: edições, comandos que mudam algo e ações no PC ou em sites estão bloqueados até o usuário aprovar com /go.\n\nPedido: ';
const GO_PROMPT = 'Plano aprovado. Execute agora, passo a passo, atualizando o plano e verificando cada etapa.';
const COMPACT_PROMPT = 'Resuma esta conversa para continuar o trabalho depois, sem perder nada importante: objetivo do usuário, decisões tomadas, '
  + 'arquivos criados ou alterados (com caminhos), o que já foi verificado, o que falta fazer e qualquer preferência que o usuário expressou. '
  + 'Escreva em tópicos, de forma densa. Não chame ferramentas.';

// Comandos personalizados: arquivo .md cujo conteúdo é o prompt; $ARGUMENTS vira o texto depois do comando.
// A primeira linha "description: ..." (opcional) aparece na lista.
function loadCustom(cwd) {
  const out = new Map();
  for (const dir of [path.join(HOME(), 'commands'), path.join(cwd || process.cwd(), '.rfcode', 'commands')]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      try {
        let body = fs.readFileSync(path.join(dir, f), 'utf8');
        let desc = '';
        const m = /^description:\s*(.+)\r?\n/i.exec(body);
        if (m) { desc = m[1].trim(); body = body.slice(m[0].length); }
        out.set(name, { name, desc: desc || body.trim().split('\n')[0].slice(0, 80), body, custom: true, file: path.join(dir, f) });
      } catch { /* ilegível: ignora */ }
    }
  }
  return [...out.values()]; // o do projeto sobrescreve o do usuário (lido depois)
}

function listCommands(cwd, where = 'ui') {
  const builtin = BUILTIN.filter((c) => c.where.includes(where)).map(({ name, aliases, args, desc }) => ({ name, aliases, args, desc }));
  const taken = new Set(builtin.flatMap((c) => [c.name, ...(c.aliases || [])]));
  const custom = loadCustom(cwd).filter((c) => !taken.has(c.name)).map(({ name, desc }) => ({ name, desc, args: '[texto]', custom: true }));
  return [...builtin, ...custom];
}

// "/model glm" -> { name: 'model', args: 'glm' }; resolve apelidos. null se não começar com "/".
function parseCommand(text) {
  const m = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const real = BUILTIN.find((c) => c.name === name || (c.aliases || []).includes(name));
  return { name: real ? real.name : name, args: (m[2] || '').trim() };
}

function expandCustom(name, args, cwd) {
  const c = loadCustom(cwd).find((x) => x.name === name);
  if (!c) return null;
  return c.body.includes('$ARGUMENTS') ? c.body.split('$ARGUMENTS').join(args) : (args ? `${c.body.trim()}\n\n${args}` : c.body.trim());
}

// Mensagem do /review para a pasta: { send } ou { reason } quando não há o que revisar.
function reviewFor(cwd) {
  let diff;
  try { diff = require('./git').gitDiff(cwd); } catch (e) { return { reason: e.message }; }
  if (/^\((sem alterações|sem diff)/.test(diff) && !/Arquivos novos/.test(diff)) return { reason: 'não há mudanças desde o último commit.' };
  return { send: reviewMessage(diff) };
}

function reviewMessage(diff) {
  return diff && diff.trim()
    ? `${REVIEW_PROMPT}\n\n\`\`\`diff\n${diff}\n\`\`\``
    : null;
}

module.exports = {
  BUILTIN, listCommands, parseCommand, loadCustom, expandCustom, reviewMessage, reviewFor,
  REVIEW_PROMPT, PLAN_PREFIX, GO_PROMPT, COMPACT_PROMPT, INIT_PROMPT,
};
