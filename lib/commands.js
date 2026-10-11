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
  { name: 'config', aliases: ['settings', 'configuracao'], desc: 'Mostra toda a configuração: modelo, chaves, conectores, regras, política e auditoria', where: ['ui', 'cli'] },
  { name: 'doctor', desc: 'Verifica o ambiente, as chaves e as ferramentas', where: ['ui', 'cli'] },
  { name: 'auto', desc: 'Liga ou desliga a aprovação automática', where: ['ui', 'cli'] },
  { name: 'undo', desc: 'Desfaz a última alteração de arquivo do agente', where: ['ui', 'cli'] },
  { name: 'plan', args: '<pedido>', desc: 'Investiga e propõe um plano sem alterar nada', where: ['ui', 'cli'] },
  { name: 'go', desc: 'Aprova o plano e executa', where: ['ui', 'cli'] },
  { name: 'init', desc: 'Cria o RFCODE.md com as instruções deste projeto', where: ['ui', 'cli'] },
  { name: 'commit', args: '[instruções]', desc: 'Revisa as mudanças e cria o commit com uma boa mensagem', where: ['ui', 'cli'] },
  { name: 'pr', args: '[branch base]', desc: 'Cria branch, commit, push e abre o pull request no GitHub', where: ['ui', 'cli'] },
  { name: 'mcp', aliases: ['conectores', 'connectors'], args: '[add|remove|tools|reload] [nome]', desc: 'Conectores MCP: GitHub, Power BI, Jira, Notion, Slack, bancos de dados...', where: ['ui', 'cli'] },
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

const COMMIT_PROMPT = 'Prepare um commit das mudanças atuais: veja git_status e git_diff, confira no git_log o padrão de mensagens do repositório e siga-o. '
  + 'Não inclua segredos (.env, chaves), arquivos gerados ou de build; se aparecerem, avise. Se houver mudanças sem relação entre si, faça commits separados. '
  + 'Mensagem: primeira linha curta no imperativo dizendo o que muda e por quê; corpo opcional com os detalhes. Depois mostre o resultado com git_log.';
const PR_PROMPT = 'Abra um pull request com as mudanças atuais: se estiver na branch principal, crie uma branch com nome descritivo (git_branch create); '
  + 'faça o commit (padrão do repositório, sem segredos), envie com git_sync push e crie o PR com github action pr_create: título claro e corpo com Resumo, Como testar e Riscos. '
  + 'No fim, mostre o link do PR. Se o GitHub CLI não estiver configurado, explique como configurar ("gh auth login").';

// /config: resumo de tudo que está configurado e onde fica cada arquivo.
function configSummary(cwd, agent) {
  const providers = require('./providers');
  const ent = require('./enterprise');
  const { loadMcpConfig } = require('./mcp');
  const { loadRules } = require('./permissions');
  const home = HOME();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* sem config */ }
  const mask = (k) => (k ? `${String(k).slice(0, 6)}…${String(k).slice(-3)}` : '');
  const source = (id) => {
    const p = providers.PROVIDERS[id];
    if ((cfg.keys || {})[id] || (id === 'nvidia' && cfg.apiKey)) return 'config.json';
    const env = [].concat(p.env || []).find((e) => process.env[e]);
    if (env) return `variável ${env}`;
    if (p.keyCommand && (cfg.useKeyCommand || {})[id]) return `comando "${p.keyCommand}"`;
    return '';
  };
  const lines = [];
  const model = (agent && agent.model) || cfg.model || providers.DEFAULT_MODEL;
  lines.push(`Modelo: ${model} (${providers.PROVIDERS[providers.parseModel(model).provider].name})`);
  const ready = Object.keys(providers.PROVIDERS).filter((id) => !providers.PROVIDERS[id].local && source(id));
  lines.push(`Provedores com chave: ${ready.length ? ready.map((id) => `${id} (${source(id)}${source(id) === 'config.json' ? ' ' + mask((cfg.keys || {})[id] || cfg.apiKey) : ''})`).join(', ') : 'nenhum'}`);
  const mcp = loadMcpConfig(cwd);
  lines.push(`Conectores MCP: ${Object.keys(mcp).length ? Object.keys(mcp).join(', ') : 'nenhum'} (/mcp)`);
  const rules = loadRules(cwd);
  const hooks = ent.loadHooks(cwd);
  lines.push(`Regras: ${rules.allow.length} allow, ${rules.deny.length} deny. Hooks: ${hooks.preTool.length} preTool, ${hooks.postEdit.length} postEdit, ${hooks.onDone.length} onDone`);
  const pol = ent.loadPolicy();
  lines.push(`Política da empresa: ${pol ? `ativa (${ent.policyFile()})${pol.message ? ' - ' + pol.message : ''}` : `nenhuma (${ent.policyFile()})`}`);
  lines.push(`Auditoria: ${ent.auditEnabled() ? `ligada (${(pol && pol.auditDir) || path.join(home, 'logs')})` : 'desligada'}`);
  if (cfg.secrets && Object.keys(cfg.secrets).length) lines.push(`Segredos para {{NOME}}: ${Object.keys(cfg.secrets).join(', ')}`);
  lines.push('', 'Arquivos:',
    `  ${path.join(home, 'config.json')}  chaves, modelo, secrets, audit`,
    `  ${path.join(home, 'settings.json')}  regras allow/deny e hooks (também em .rfcode/settings.json do projeto)`,
    `  ${path.join(home, 'mcp.json')}  conectores (também .rfcode/mcp.json, .mcp.json e .vscode/mcp.json do projeto)`,
    `  ${path.join(home, 'MEMORIA.md')}  memória sobre você; RFCODE.md na pasta do projeto`,
    '', 'Trocar: /provider (provedor e chave), /model, /mcp add, /memory. Guia completo: docs/EMPRESAS.md.');
  return lines.join('\n');
}

// /mcp: lista, adiciona e remove conectores. Devolve texto; reload = o agente deve reconectar.
function mcpCommand(args, { cwd, agent } = {}) {
  const { CATALOG } = require('./mcp-catalog');
  const { saveServer, loadMcpConfig, configFiles } = require('./mcp');
  const [sub = '', ...rest] = String(args || '').trim().split(/\s+/).filter(Boolean);
  const reload = () => { if (agent && agent.mcp) agent.mcp.closeAll(); if (agent) { agent.mcpStarted = false; agent.mcp = null; } };
  const catalog = () => CATALOG.map((c) => `  ${c.id.padEnd(15)} ${c.name}: ${c.desc}`).join('\n');
  if (!sub || sub === 'status' || sub === 'list') {
    const cfg = loadMcpConfig(cwd);
    const names = Object.keys(cfg);
    const status = agent && agent.mcp ? agent.mcp.status() : names.map((n) => `- ${n}: será conectado na próxima mensagem`).join('\n');
    return { text: (names.length ? `Conectores:\n${status}\n\n` : 'Nenhum conector configurado ainda.\n\n')
      + `Prontos para adicionar (/mcp add <id>):\n${catalog()}\n\nOutros: /mcp add <nome> <comando ou URL>. Arquivos lidos: ${configFiles(cwd).join(', ')} (mesmo formato do Claude Code e do VS Code).` };
  }
  if (sub === 'add') {
    const [id, ...more] = rest;
    if (!id) return { text: `Uso: /mcp add <id> [projeto]\n${catalog()}` };
    const scope = more[more.length - 1] === 'projeto' ? (more.pop(), 'projeto') : 'usuario';
    const item = CATALOG.find((c) => c.id === id.toLowerCase());
    let cfg;
    if (item && !more.length) cfg = item.config;
    else if (more.length) cfg = /^https?:\/\//.test(more[0]) ? { type: /\/sse\/?$/.test(more[0]) ? 'sse' : 'http', url: more[0] } : { command: more[0], args: more.slice(1) };
    else return { text: `Conector "${id}" não está na lista. Para um servidor próprio: /mcp add ${id} <comando> [args] ou /mcp add ${id} <URL>.\n${catalog()}` };
    const file = saveServer(item && !more.length ? item.id : id, cfg, { cwd, scope });
    reload();
    return { reload: true, text: `Conector ${id} salvo em ${file}.${item ? `\nPrecisa de: ${item.needs}` : ''}\nSegredos com {{NOME}} vêm da variável de ambiente ou de "secrets" no config do rfcode. Ele conecta na próxima mensagem; confira com /mcp.` };
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!rest[0]) return { text: 'Uso: /mcp remove <nome>' };
    saveServer(rest[0], null, { cwd, scope: 'usuario' });
    try { saveServer(rest[0], null, { cwd, scope: 'projeto' }); } catch { /* sem arquivo de projeto */ }
    reload();
    return { reload: true, text: `Conector ${rest[0]} removido.` };
  }
  if (sub === 'reload') { reload(); return { reload: true, text: 'Os conectores reconectam na próxima mensagem.' }; }
  if (sub === 'tools') {
    if (!agent || !agent.mcp) return { text: 'Os conectores ainda não foram iniciados; envie uma mensagem e tente de novo.' };
    const defs = agent.mcp.defs().filter((d) => !rest[0] || d._mcp.server === rest[0]);
    return { text: defs.length ? defs.map((d) => `- ${d.name}${d._mcp.readOnly ? ' (leitura)' : ''}: ${d.description.replace(/^\[[^\]]+\] /, '').slice(0, 120)}`).join('\n') : 'Nenhuma ferramenta.' };
  }
  return { text: 'Uso: /mcp [add <id>|remove <nome>|tools [nome]|reload]' };
}

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
  REVIEW_PROMPT, PLAN_PREFIX, GO_PROMPT, INIT_PROMPT, COMMIT_PROMPT, PR_PROMPT, mcpCommand, configSummary,
};
