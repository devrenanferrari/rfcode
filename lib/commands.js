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
  { name: 'model', args: '[modelo|auto]', desc: 'Mostra ou troca o modelo (auto: escolhe e troca sozinho no limite de pedidos)', where: ['ui', 'cli'] },
  { name: 'effort', aliases: ['esforco'], args: '[baixo|medio|alto]', desc: 'Esforço: baixo (rápido), médio (padrão) ou alto (mais cuidadoso)', where: ['ui', 'cli'] },
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
  { name: 'skills', aliases: ['skill', 'habilidades'], args: '[nova <nome>|criar <descrição>]', desc: 'Procedimentos que você ou a empresa ensinam ao rfcode', where: ['ui', 'cli'] },
  { name: 'entender', aliases: ['explain', 'arquitetura'], args: '[pasta ou pergunta]', desc: 'Estuda o projeto e explica a arquitetura (e grava no RFCODE.md se você quiser)', where: ['ui', 'cli'] },
  { name: 'missao', aliases: ['mission', 'missoes', 'missions'], args: '<objetivo> [--horas N] | status|parar|retomar|lista [id]', desc: 'Tarefa longa e autônoma (até dias), em segundo plano, com commits de segurança', where: ['ui', 'cli'] },
  { name: 'agendar', aliases: ['agendamentos', 'agendamento', 'schedule'], args: '<quando>: <tarefa> | rodar|remover <id>', desc: 'Tarefa recorrente ou futura ("dias úteis às 8h: resuma os PRs"), roda mesmo com o rfcode fechado', where: ['ui', 'cli'] },
  { name: 'uso', aliases: ['usage', 'custo', 'tokens'], desc: 'Tokens usados hoje, na semana e no mês, por modelo e por pasta', where: ['ui', 'cli'] },
  { name: 'export', aliases: ['exportar'], args: '[arquivo.md]', desc: 'Salva esta conversa em Markdown', where: ['ui', 'cli'] },
  { name: 'review', desc: 'Revisa as mudanças não commitadas (git diff) em busca de bugs', where: ['ui', 'cli'] },
  { name: 'compact', desc: 'Resume a conversa para liberar contexto', where: ['ui', 'cli'] },
  { name: 'memory', args: '[texto]', desc: 'Mostra a memória do rfcode sobre você, ou guarda um texto nela', where: ['ui', 'cli'] },
  { name: 'remote', desc: 'Controle remoto: use o rfcode pelo celular', where: ['ui'] },
  { name: 'key', desc: 'Troca a API key da NVIDIA', where: ['ui', 'cli'] },
  { name: 'chaves', aliases: ['keys', 'apikeys'], desc: 'Como obter as chaves dos modelos e das ferramentas, e quais já estão configuradas', where: ['ui', 'cli'] },
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

const UNDERSTAND_PROMPT = (focus) => `Estude este projeto a fundo e explique como ele funciona${focus ? `, com foco em: ${focus}` : ''}.
`
  + 'Método: code_map e code_deps (núcleo e pontos de entrada) para a visão geral; README/RFCODE.md; depois siga os fluxos principais do ponto de entrada até o fim com read_symbol e find_references. '
  + 'Em projetos grandes, divida por área e use task (subagentes) em paralelo. Anote com note os achados (arquivo:linha).\n'
  + 'Entregue: 1) o que o sistema faz; 2) arquitetura (camadas, módulos centrais e como se conectam); 3) os 3 a 5 fluxos mais importantes passo a passo com arquivo:linha; '
  + '4) dados e integrações externas; 5) como rodar e testar; 6) pontos de atenção (complexidade, acoplamento, riscos, código morto). '
  + 'Diferencie o que leu do que deduziu. No fim, pergunte com ask_user se deve gravar um resumo na seção Arquitetura do RFCODE.md.';

const COMMIT_PROMPT = 'Prepare um commit das mudanças atuais: veja git_status e git_diff, confira no git_log o padrão de mensagens do repositório e siga-o. '
  + 'Não inclua segredos (.env, chaves), arquivos gerados ou de build; se aparecerem, avise. Se houver mudanças sem relação entre si, faça commits separados. '
  + 'Mensagem: primeira linha curta no imperativo dizendo o que muda e por quê; corpo opcional com os detalhes. Depois mostre o resultado com git_log.';
const PR_PROMPT = 'Abra um pull request com as mudanças atuais: se estiver na branch principal, crie uma branch com nome descritivo (git_branch create); '
  + 'faça o commit (padrão do repositório, sem segredos), envie com git_sync push e crie o PR com github action pr_create: título claro e corpo com Resumo, Como testar e Riscos. '
  + 'No fim, mostre o link do PR. Se o GitHub CLI não estiver configurado, explique como configurar ("gh auth login").';

// /skills: lista, cria modelo vazio ou pede ao agente para escrever uma skill a partir de uma descrição.
// Devolve { text } para mostrar ou { send } para mandar ao agente.
function skillsCommand(args, { cwd } = {}) {
  const { listSkills, createSkill } = require('./skills');
  const [sub = '', ...rest] = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!sub || sub === 'list' || sub === 'lista') {
    const list = listSkills(cwd);
    return { text: (list.length ? `Skills instaladas:\n${list.map((s) => `- ${s.name} (${s.scope}): ${s.description}`).join('\n')}` : 'Nenhuma skill instalada.')
      + '\n\nSkills são procedimentos que o rfcode segue (ex.: como fechar o relatório mensal, padrão de deploy, revisão de contratos).'
      + '\n/skills criar <descrição>: o rfcode escreve a skill para você.\n/skills nova <nome> [usuario]: cria um modelo para preencher.'
      + '\nPastas: .rfcode/skills/<nome>/SKILL.md (projeto, vale para o time se versionar), ~/.rfcode/skills (só você) e .claude/skills (compatível com o Claude Code).' };
  }
  if (sub === 'nova' || sub === 'new') {
    const scope = rest[1] === 'usuario' ? 'usuario' : 'projeto';
    const file = createSkill(cwd, rest[0], { scope });
    return { text: `Skill criada em ${file}. Preencha a descrição (é por ela que o rfcode decide quando usar) e o passo a passo.` };
  }
  if (sub === 'criar' || sub === 'create') {
    const desc = rest.join(' ');
    if (!desc) return { text: 'Uso: /skills criar <o que a skill deve ensinar>' };
    return { send: `Crie uma skill do rfcode a partir desta descrição: "${desc}".\nFormato: pasta .rfcode/skills/<nome-curto>/SKILL.md com cabeçalho YAML (---, name, description com UMA frase dizendo quando usar, keywords separadas por vírgula, ---) e depois seções: Quando usar, Passo a passo (numerado, concreto), Regras (sempre/nunca), Exemplos. Se faltar informação essencial do processo (sistemas, aprovações, formatos), pergunte com ask_user antes de escrever. Se fizer sentido, crie arquivos de apoio na mesma pasta (modelo de e-mail, checklist, script). No fim mostre o caminho e um resumo.` };
  }
  return { text: 'Uso: /skills [nova <nome>|criar <descrição>]' };
}

// /missao: cria e controla missões. start(m) inicia o processo em segundo plano (CLI e extensão sabem como).
function missionCommand(args, { cwd, start, model, aliasUsed } = {}) {
  const mission = require('./mission');
  let text = String(args || '').trim();
  if (aliasUsed === 'missoes' || aliasUsed === 'missions') text = text || 'lista';
  const [sub, ...rest] = text.split(/\s+/);
  const id = rest[0];
  switch ((sub || '').toLowerCase()) {
    case '': case 'lista': case 'list': return { text: mission.listText(cwd) };
    case 'status': return { text: mission.status(cwd, id) };
    case 'parar': case 'stop': { const m = mission.stop(cwd, id); return { text: `Pedido de parada enviado para a missão ${m.id}; ela para ao fim da ação atual.` }; }
    case 'retomar': case 'resume': {
      const m = mission.load(cwd, id);
      if (m.status === 'rodando' && mission.alive(m.pid)) return { text: `A missão ${m.id} já está rodando (processo ${m.pid}).` };
      if (m.status === 'concluida') return { text: `A missão ${m.id} já foi concluída.` };
      // prazo vencido ao retomar: estende pelo tempo que faltava quando parou, no mínimo 1 h
      if (Date.now() > Date.parse(m.prazo)) { m.prazo = new Date(Date.now() + 3600 * 1000).toISOString(); }
      m.status = 'criada'; m.semProgresso = 0; mission.save(cwd, m);
      const pid = start(m);
      return { text: `Missão ${m.id} retomada em segundo plano (processo ${pid}). Acompanhe com /missao status.` };
    }
    default: {
      let horas = 24, git = true, objetivo = text;
      objetivo = objetivo.replace(/--horas[= ](\d+(?:[.,]\d+)?)/, (x, h) => { horas = Number(h.replace(',', '.')); return ''; });
      let passos;
      objetivo = objetivo.replace(/--passos[= ](\d+)/, (x, n) => { passos = Number(n); return ''; });
      objetivo = objetivo.replace(/--sem-git\b/, () => { git = false; return ''; }).trim();
      if (objetivo.length < 10) return { text: 'Uso: /missao <objetivo detalhado> [--horas 24] [--passos 120] [--sem-git]. Quanto mais claro o objetivo e o critério de pronto, melhor.' };
      const m = mission.create(cwd, { objetivo, horas, git, modelo: model, ...(passos ? { passosPorCiclo: passos } : {}) });
      const pid = start(m);
      return { text: `Missão ${m.id} iniciada em segundo plano (processo ${pid}), por até ${m.horas} h.\n`
        + `Ela trabalha em ciclos, sem pedir aprovação, sem ações irreversíveis${m.git ? ', com commits de segurança numa branch própria' : ''}, e mantém o computador acordado.\n`
        + `Acompanhe: /missao status ${m.id}. Pare: /missao parar ${m.id}. Diário: .rfcode/missoes/${m.id}/diario.md` };
    }
  }
}

// /agendar: cria, lista, roda e remove tarefas agendadas. srcRoot = pasta do rfcode (para a cópia usada pelo agendador).
function scheduleCommand(args, { cwd, model, srcRoot, run } = {}) {
  const sched = require('./schedule');
  const text = String(args || '').trim();
  const [sub, id] = text.split(/\s+/);
  if (!text || /^(lista|list)$/i.test(text)) return { text: sched.listText() };
  if (/^(remover|remove|apagar|rm)$/i.test(sub)) { const j = sched.remove(id); return { text: `Agendamento ${j.id} removido (${j.quando}).` }; }
  if (/^(rodar|run|agora)$/i.test(sub)) {
    const j = sched.list().find((x) => x.id === id);
    if (!j) return { text: `Agendamento ${id} não encontrado.` };
    return { send: j.task, text: `Rodando agora: ${j.task}` };
  }
  // "<quando>: <tarefa>" (o ":" de "8:30" não conta porque vem sem espaço) ou "<quando> -- <tarefa>"
  const m = /^(.+?)(?::\s|\s--\s|\s—\s)([\s\S]+)$/.exec(text);
  if (!m) return { text: 'Uso: /agendar <quando>: <tarefa>\nExemplos:\n  /agendar dias úteis às 8h: resuma os pull requests abertos e mande no Slack\n  /agendar toda segunda às 9h: gere o relatório semanal de vendas em relatorio.xlsx\n  /agendar a cada 2 horas: confira se o site responde e avise se cair\n  /agendar amanhã às 7h: rode os testes e corrija o que quebrar' };
  const job = sched.add({ when: m[1], task: m[2], cwd, model, srcRoot });
  return { text: `Agendado (${job.id}): ${job.quando}\nTarefa: ${job.task}\nPasta: ${job.cwd}\nRoda pelo agendador do sistema, mesmo com o rfcode fechado; o resultado de cada execução fica em ~/.rfcode/agendamentos/${job.id}/ e aparece um aviso ao terminar.\nVer: /agendamentos. Testar agora: /agendamento rodar ${job.id}. Remover: /agendamento remover ${job.id}.` };
}

// /export: conversa em Markdown (pedidos, respostas e um resumo de cada ação)
function exportConversation(agent, file) {
  const { describeCall } = require('./agent');
  const lines = [`# Conversa no rfcode`, '', `${new Date().toLocaleString('pt-BR')} · modelo ${agent.model} · pasta ${agent.cwd}`, ''];
  for (const m of agent.messages) {
    if (m.role === 'user') {
      const t = String(m.content || '');
      if (t.startsWith('[') && t.includes('nota do sistema')) continue;
      lines.push('## Você', '', t.length > 6000 ? `${t.slice(0, 6000)}\n\n[... ${t.length - 6000} caracteres]` : t, '');
    } else if (m.role === 'assistant') {
      if (m.content && m.content.trim()) lines.push('## rfcode', '', m.content.trim(), '');
      for (const tc of m.tool_calls || []) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* argumentos inválidos */ }
        lines.push(`- \`${describeCall(tc.function.name, args)}\``);
      }
      if ((m.tool_calls || []).length) lines.push('');
    }
  }
  const out = path.resolve(agent.cwd, file || path.join('.rfcode', 'exports', `conversa-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'));
  return out;
}

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
  const model = (agent && agent.selectedModel) || cfg.model || providers.AUTO;
  lines.push(model === providers.AUTO ? `Modelo: auto${agent ? ` (agora ${agent.model})` : ''}` : `Modelo: ${model} (${providers.PROVIDERS[providers.parseModel(model).provider].name})`);
  lines.push(`Esforço: ${EFFORT_LABEL[(agent && agent.effort) || cfg.effort] || EFFORT_LABEL.medium}`);
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
  if (sub === 'login' || sub === 'logout') {
    if (!rest[0]) return { text: `Uso: /mcp ${sub} <nome>` };
    if (sub === 'logout') {
      const cfgs = loadMcpConfig(cwd);
      if (!cfgs[rest[0]] || !cfgs[rest[0]].url) return { text: `Conector remoto ${rest[0]} não encontrado.` };
      require('./mcp-oauth').logout(require('./mcp').expand(cfgs[rest[0]].url));
      reload();
      return { text: `Login de ${rest[0]} removido.` };
    }
    return { login: rest[0], text: `Abrindo o navegador para entrar em ${rest[0]}...` };
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

// ---------- /effort ----------
const EFFORT_LABEL = { low: 'baixo (rápido)', medium: 'médio (padrão)', high: 'alto (mais cuidadoso)' };
const EFFORT_ALIASES = { low: 'low', baixo: 'low', b: 'low', rapido: 'low', 'rápido': 'low', medium: 'medium', medio: 'medium', 'médio': 'medium', m: 'medium', normal: 'medium', padrao: 'medium', 'padrão': 'medium', high: 'high', alto: 'high', a: 'high', max: 'high' };
// "alto" -> 'high'; null se não reconhecer.
const parseEffort = (arg) => EFFORT_ALIASES[String(arg || '').trim().toLowerCase()] || null;
// /effort [nível]: { effort } quando troca, sempre { text } para mostrar.
function effortCommand(arg, current = 'medium') {
  const help = 'baixo: respostas rápidas, investiga só o necessário\n'
    + 'médio: o padrão\n'
    + 'alto: entende tudo antes de mudar, considera alternativas e verifica com testes e revisão do diff (mais lento)';
  if (!String(arg || '').trim()) return { text: `Esforço: ${EFFORT_LABEL[current] || EFFORT_LABEL.medium}\n${help}\nUse /effort baixo|medio|alto.` };
  const effort = parseEffort(arg);
  if (!effort) return { text: `Esforço desconhecido: "${arg}". Use baixo, medio ou alto.` };
  return { effort, text: `Esforço: ${EFFORT_LABEL[effort]}.` };
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
  BUILTIN, listCommands, parseCommand, EFFORT_LABEL, parseEffort, effortCommand, loadCustom, expandCustom, reviewMessage, reviewFor,
  REVIEW_PROMPT, PLAN_PREFIX, GO_PROMPT, INIT_PROMPT, COMMIT_PROMPT, PR_PROMPT, UNDERSTAND_PROMPT, mcpCommand, configSummary, skillsCommand, missionCommand, scheduleCommand, exportConversation,
};
