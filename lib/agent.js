'use strict';
// Núcleo do rfcode: ferramentas, chamada à API da NVIDIA e loop do agente.
// Usado tanto pela CLI (bin/rfcode.js) quanto pela extensão do VS Code (extension/extension.js).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { PC_TOOL_DEFS, PC_TOOLS, PC_PROMPT, pcNeedsApproval, pcDescribe, runPcTool, dedupeEnv } = require('./pc');
const { GIT_TOOL_DEFS, GIT_TOOLS, runGitTool, gitDescribe } = require('./git');
const { WORK_STYLE } = require('./prompts');
const { CheckpointManager } = require('./checkpoints');
const { expandMentions } = require('./mentions');
const { SessionManager } = require('./sessions');
const {
  BROWSER_TOOL_DEF, BROWSER_PROMPT, getBrowser, browserNeedsApproval, browserMustConfirm, browserDescribe,
} = require('./browser');
const { OFFICE_TOOL_DEFS, OFFICE_TOOLS, runOfficeTool, officeDescribe } = require('./office');
const { createVideo, VIDEO_TOOL_DEF } = require('./video');
const { parseArgs } = require('./jsonfix');
const { webSearch, formatResults, SEARCH_TOOL_DEF } = require('./websearch');
const { readUserMemory, remember, forget, MEMORY_TOOL_DEF } = require('./memory');
const brain = require('./brain');

// Módulos de ferramentas: { defs, run(name, args, ctx), describe?(name, args), needsApproval?(name, args), group? }.
// group: { name, desc, hint } deixa as ferramentas sob demanda (entram quando o pedido fala do assunto).
const MODULES = [
  require('./tools/data'),
  require('./tools/git-plus'),
  require('./tools/http'),
  require('./tools/skills'),
  require('./tools/code'),
  require('./tools/dashboard'),
  require('./tools/web'),
  require('./tools/motion'),
  require('./tools/quality'),
  require('./tools/reverse'),
  require('./tools/brain'),
  require('./tools/think'),
  require('./tools/research'),
  require('./tools/compute'),
  require('./tools/setup'),
  require('./tools/devcore'),
  require('./tools/devkit'),
  require('./tools/serve'),
  require('./tools/archive'),
  require('./tools/toolbox'),
  require('./tools/crystallize'),
];
const { McpManager } = require('./mcp');
const enterprise = require('./enterprise');
const skills = require('./skills');
const MODULE_OF = new Map(MODULES.flatMap((m) => m.defs.map((d) => [d.name, m])));
const { loadRules, decide } = require('./permissions');
const providers = require('./providers');
const log = require('./log');
const ctx = require('./context');

const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const CONFIG_DIR = process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_MODEL = providers.DEFAULT_MODEL;
// modelos sugeridos da NVIDIA (provedor padrão); os de outros provedores ficam em lib/providers.js
const SUGGESTED_MODELS = providers.PROVIDERS.nvidia.models;
const MAX_OUTPUT = 20000;
// Sem limite de passos: o agente segue até terminar (ou até o usuário parar). Quem quiser limite usa --max-steps.
const MAX_STEPS = Infinity;
// Trava de segurança: a mesma ação idêntica feita tantas vezes seguidas (entre as últimas 10) encerra a tarefa.
const STUCK_REPEATS = 6;
const CHANGES_FILES = new Set(['write_file', 'edit_file', 'multi_edit', 'create_pptx', 'create_docx', 'create_video']);
const MEMORY_HINT = /(^|[^a-zà-ú])(lembr[ae]|memoriz|anot[ae]|n[aã]o esque[cç]|daqui (pra|para) frente|de agora em diante|sempre que eu|eu prefiro|prefiro que|meu nome [eé]|me chame de)/i;
// processos em segundo plano de todos os agentes: encerrados quando o rfcode fecha
const BG_CHILDREN = new Set();
process.once('exit', () => { for (const c of BG_CHILDREN) { try { c.kill(); } catch { /* já saiu */ } } });
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
const IS_WIN = process.platform === 'win32';

// ---------- config ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Retorna 'ok', 'invalid' ou 'offline'. provider padrão: NVIDIA (compatibilidade com a assinatura antiga).
function validateKey(key, provider = 'nvidia') {
  return providers.validateKey(provider, key, loadConfig());
}

// ---------- utilitários ----------
function truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n... [truncado, ${s.length - MAX_OUTPUT} caracteres omitidos]`;
}
function walk(dir, out = [], limit = 5000) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, limit);
    else out.push(full);
  }
  return out;
}
function globToRegex(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') re += '(';
    else if (ch === '}') re += ')';
    else if (ch === ',') re += '|';
    else if ('.+^$()|[]\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', 'i');
}
// sync: espera o taskkill terminar (usado quando o usuário pede para parar um processo e quer a confirmação)
function killTree(child, { sync = false } = {}) {
  if (!child || child.exitCode !== null) return;
  if (!IS_WIN) { child.kill('SIGTERM'); return; }
  const args = ['/pid', String(child.pid), '/T', '/F'];
  if (sync) { try { execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch { /* já tinha saído */ } }
  else execFile('taskkill', args, { windowsHide: true }, () => {});
}

// ---------- definição das ferramentas ----------
const TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Lê um arquivo de texto. Retorna o conteúdo com números de linha.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do arquivo' },
        offset: { type: 'integer', description: 'Linha inicial (1-based), opcional' },
        limit: { type: 'integer', description: 'Quantidade de linhas, opcional' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Cria ou sobrescreve um arquivo com o conteúdo informado. Cria pastas se necessário.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Substitui um trecho exato (old_string) por new_string em um arquivo. old_string deve ser único no arquivo, a não ser que replace_all seja true. Leia o arquivo antes de editar.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'Lista arquivos e pastas de um diretório.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Diretório (padrão: atual)' } } },
  },
  {
    name: 'glob',
    description: 'Encontra arquivos por padrão glob (ex: "**/*.js", "src/**/*.{ts,tsx}"). Ignora node_modules e .git.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Diretório base (padrão: atual)' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Procura uma regex no conteúdo dos arquivos. Retorna arquivo:linha:texto.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Expressão regular (JavaScript)' },
        path: { type: 'string', description: 'Diretório ou arquivo (padrão: atual)' },
        glob: { type: 'string', description: 'Filtro de arquivos, ex: "*.py"' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: IS_WIN
      ? 'Executa um comando no PowerShell (Windows) no diretório de trabalho e retorna stdout/stderr. Use sintaxe PowerShell.'
      : 'Executa um comando no bash no diretório de trabalho e retorna stdout/stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: 'Timeout em ms (padrão 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Baixa a URL (timeout de 20 s), converte HTML em texto (remove script/style, tags e entidades básicas) e devolve até 20 000 caracteres. Só aceita http e https.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
];

const MULTI_EDIT_DEF = {
  name: 'multi_edit',
  description: 'Aplica várias edições (old_string → new_string) num mesmo arquivo, em sequência e de forma atômica: se uma falhar, nada é gravado. '
    + 'Prefira a vários edit_file seguidos no mesmo arquivo. Cada old_string segue as regras do edit_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
};

// Plano visível: o modelo declara objetivo e passos, e as interfaces mostram o progresso.
const PLAN_TOOL_DEF = {
  name: 'update_plan',
  description: 'Declara ou atualiza o plano de trabalho: objetivo, passos com status e o que está fazendo agora e por quê. Use no início de tarefas com 3 ou mais passos e sempre que concluir ou começar um passo. Mantenha exatamente um passo "in_progress".',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Objetivo final, em uma frase' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['text', 'status'],
        },
      },
      why: { type: 'string', description: 'Por que o passo atual é necessário (curto)' },
    },
    required: ['steps'],
  },
};

const ASK_TOOL_DEF = {
  name: 'ask_user',
  description: 'Faz uma pergunta ao usuário e espera a resposta. Use só quando a decisão é dele e muda o resultado (preferência, dado pessoal que falta, '
    + 'escolha entre caminhos com custo diferente). Dê de 2 a 4 opções curtas quando der; o usuário também pode responder livremente.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    required: ['question'],
  },
};
const TASK_TOOL_DEF = {
  name: 'task',
  description: 'Delega uma pesquisa a um subagente, que investiga sozinho (arquivos, git, documentos e internet, só leitura) e devolve um relatório. '
    + 'Use para perguntas amplas ("como funciona a autenticação deste projeto?", "compare 3 bibliotecas de PDF") e para pesquisas na web com várias fontes: '
    + 'economiza o seu contexto. Escreva no prompt tudo o que ele precisa saber e o formato do relatório. Ele não altera nada.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Resumo em 3 a 6 palavras (aparece para o usuário)' },
      prompt: { type: 'string', description: 'A tarefa completa para o subagente' },
    },
    required: ['description', 'prompt'],
  },
};
const NOTE_TOOL_DEF = {
  name: 'note',
  description: 'Anota um fato que você vai precisar mais adiante nesta tarefa (valores lidos, resultados parciais, decisões, caminhos). '
    + 'Em tarefas longas, leituras antigas podem ser resumidas para caber no contexto; as anotações são mantidas literalmente. '
    + 'Ex.: "cap1.txt linha 59: total 8083". Uma anotação curta por chamada.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};
const BG_TOOL_DEFS = [
  {
    name: 'command_output',
    description: 'Lê a saída nova de um comando em segundo plano (iniciado com run_command background: true) e diz se ainda está rodando.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Ex.: bg1' } }, required: ['id'] },
  },
  {
    name: 'command_stop',
    description: 'Para um comando em segundo plano.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

TOOL_DEFS.splice(3, 0, MULTI_EDIT_DEF);
TOOL_DEFS.find((t) => t.name === 'run_command').parameters.properties.background = {
  type: 'boolean',
  description: 'Inicia em segundo plano (servidor de desenvolvimento, watch, processo longo) e devolve um id na hora; leia com command_output e pare com command_stop',
};
TOOL_DEFS.splice(TOOL_DEFS.findIndex((t) => t.name === 'web_fetch'), 0, SEARCH_TOOL_DEF);
TOOL_DEFS.push(...BG_TOOL_DEFS, ...GIT_TOOL_DEFS, PLAN_TOOL_DEF, NOTE_TOOL_DEF, TASK_TOOL_DEF, ASK_TOOL_DEF, MEMORY_TOOL_DEF,
  ...OFFICE_TOOL_DEFS, VIDEO_TOOL_DEF, BROWSER_TOOL_DEF, ...PC_TOOL_DEFS, ...MODULES.flatMap((m) => m.defs));

// ---------- ferramentas sob demanda ----------
// As ferramentas básicas vão em toda chamada. Os grupos abaixo só entram quando o pedido fala do assunto
// (detecção por palavras) ou quando o modelo pede com load_tools. Economiza ~4 mil tokens por chamada.
const TOOL_GROUPS = {
  office: { tools: ['create_pptx', 'create_docx', 'read_document'], desc: 'PowerPoint, Word, leitura de PDF/Word/PowerPoint/Excel',
    hint: /\b(pptx?|powerpoint|slides?|apresenta[cç][aã]o|docx?|word|pdf|xlsx?|excel|planilha|documento|relat[oó]rio|curr[ií]culo|contrato)\b|\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)\b/i },
  video: { tools: ['create_video'], desc: 'vídeo narrado com legendas', hint: /\bv[ií]deos?\b|\bnarra[cç][aã]o\b|\.(mp4|webm)\b/i },
  browser: { tools: ['browser'], desc: 'navegador (abrir sites, clicar, preencher formulários, login)',
    hint: /\b(site|p[aá]gina web|navegador|browser|chrome|linkedin|instagram|facebook|google|youtube|formul[aá]rio|login|candidat|https?:\/\/|www\.)/i },
  pc: { tools: [...PC_TOOLS], desc: 'controle do Windows: janelas, tela (OCR), mouse, teclado, abrir programas',
    hint: /\b(janela|tela|clique|clicar|mouse|teclado|atalho|bloco de notas|notepad|abr(a|ir) o (programa|app)|print da tela|screenshot|aplicativo|programa)\b/i },
};
for (const m of MODULES) {
  if (!m.group) continue;
  const g = (TOOL_GROUPS[m.group.name] ||= { tools: [], desc: m.group.desc, hint: m.group.hint });
  g.tools.push(...m.defs.map((d) => d.name));
}
// assuntos sem ferramentas próprias: só trazem o guia
TOOL_GROUPS.powerbi = { tools: [], desc: 'Power BI', hint: /\bpower ?bi\b|\bdax\b|\.pbi[xp]\b|\bfabric\b|modelo sem[aâ]ntico/i };
TOOL_GROUPS.conectores = { tools: [], desc: 'conectores', hint: /\b(mcp|conector(es)?|jira|confluence|notion|slack|postgres(ql)?|stripe|supabase|salesforce|hubspot)\b/i };
const DEFERRED = new Set(Object.values(TOOL_GROUPS).flatMap((g) => g.tools));

// Guias (lib/guides/*.md): como trabalhar com cada assunto. Vão para o prompt só quando o assunto está ativo.
const GUIDE_OF = { dados: 'dados', git: 'git', api: 'api', powerbi: 'powerbi', conectores: 'mcp', codigo: 'codigo', dashboard: 'dados' };
const guideCache = new Map();
function guide(name) {
  if (!guideCache.has(name)) {
    try { guideCache.set(name, fs.readFileSync(path.join(__dirname, 'guides', `${name}.md`), 'utf8').trim()); } catch { guideCache.set(name, ''); }
  }
  return guideCache.get(name);
}
const LOAD_TOOLS_DEF = {
  name: 'load_tools',
  description: 'Carrega grupos de ferramentas que não estão disponíveis agora. Grupos: '
    + Object.entries(TOOL_GROUPS).map(([k, g]) => `${k} (${g.desc})`).join('; ') + '. Use quando a tarefa precisar delas.',
  parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string', enum: Object.keys(TOOL_GROUPS) } } }, required: ['groups'] },
};

// Ferramentas do subagente: só leitura (o resultado volta como texto para o agente principal).
const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'read_document', 'data_query', 'web_search', 'web_fetch',
  'code_map', 'find_symbol', 'find_references', 'read_symbol', 'code_deps', 'code_search',
  // ferramentas sem efeito colateral que deixam o subagente mais capaz (só leitura/cálculo):
  'recall', 'compute', 'deep_research', 'think', 'detect_stack', 'diff', 'json_query', 'hash', 'toolbox'];

const ASSISTANT_PROMPT = `
# Pesquisa, memória e tarefas grandes
- Não sabe algo com certeza, ou é coisa que muda (preços, versões, notícias, vagas, documentação)? Pesquise com web_search antes de responder e cite as fontes (endereços). Para perguntas amplas, comparações ou estado da arte, use deep_research (várias buscas de uma vez) e depois web_fetch nas fontes que importam.
- Pesquisas com várias fontes, perguntas amplas sobre o código ou leitura de muitos arquivos grandes (vários PDFs, documentos, pastas inteiras): use task (subagente). Ele lê num contexto separado e devolve só o relatório, o que mantém esta conversa leve.
- Falta um dado que só o usuário tem, ou a escolha é dele? Use ask_user com opções, em vez de chutar.
- O usuário contou uma preferência ou algo sobre si que vale para o futuro? Guarde com remember (uma frase).
- Descobriu algo sobre ESTE projeto que vai poupar tempo depois (como buildar/testar, onde fica cada coisa, uma armadilha, a causa de um bug)? Guarde com learn. No começo de uma tarefa, use recall para ver o que já sabe antes de investigar do zero.
- Servidores e processos longos: run_command com background: true, depois command_output para acompanhar.
- Tarefas longas ou com muitos dados (vários arquivos, comparações, somas): registre com note cada fato que vai precisar no final, logo que encontrar. Leituras antigas podem ser resumidas; as anotações ficam.`;

const FILES_PROMPT = `
# Arquivos, documentos e mídia
- PDF, Word, PowerPoint e Excel: leia com read_document (read_file é só para texto).
- Várias mudanças no mesmo arquivo: use multi_edit (tudo ou nada) em vez de vários edit_file.
- Operações em massa (renomear, mover, organizar pastas): primeiro liste e diga o que vai mudar; depois use run_command. Nunca apague nada sem pedido explícito.
- Planilhas: entregue em .xlsx com create_xlsx (formatos, totais, várias abas). Para analisar dados (somar, agrupar, cruzar, conferir) use data_query com SQL em vez de scripts. CSV só se pedirem.
- Apresentações (create_pptx): planeje a história antes (capa → contexto → seções → números ou exemplos → conclusão → encerramento), de 6 a 12 slides. Títulos com até ~8 palavras, 3 a 6 tópicos curtos por slide e conteúdo real e específico (nunca "Tópico 1" ou texto de enchimento). Varie os tipos de slide. Depois confira com read_document.
- Documentos (create_docx): markdown bem estruturado, com títulos, listas e tabelas quando ajudarem.
- Vídeos (create_video): roteiro com capa, 3 a 6 cenas de conteúdo e encerramento. Cada cena de conteúdo tem 2 a 4 bullets e, quando combinar, um emoji. A narração é falada em voz alta: 2 a 3 frases naturais por cena, sem markdown, siglas difíceis ou URLs, e a soma das falas deve bater com a duração pedida (~2,5 palavras por segundo). Os bullets resumem a fala, não a repetem palavra por palavra.
- Ao terminar, informe o caminho do arquivo criado.`;

// web_fetch pede aprovação: uma URL pode carregar dados para fora (ex.: segredo na query string)
const NEEDS_APPROVAL = new Set(['write_file', 'edit_file', 'multi_edit', 'run_command', 'git_commit', 'web_fetch', 'create_pptx', 'create_docx', 'create_video']);
const needsApproval = (name, args) => NEEDS_APPROVAL.has(name)
  || !!(MODULE_OF.get(name) && MODULE_OF.get(name).needsApproval && MODULE_OF.get(name).needsApproval(name, args || {}))
  || (name === 'remember' && args && args.scope === 'projeto')
  || (name === 'browser' && browserNeedsApproval(args))
  || (PC_TOOLS.has(name) && pcNeedsApproval(name, args));
// Ações com consequência real (enviar, pagar, excluir...) pedem confirmação mesmo no modo auto.
const mustConfirm = (name, args) => name === 'browser' && browserMustConfirm(args);

// No modo plano, ler e navegar pode; alterar arquivos, rodar comandos e agir no PC ou em sites, não.
const blockedInPlan = (name, args) => needsApproval(name, args) && name !== 'web_fetch'
  && !(name === 'browser' && ['open', 'read', 'scroll', 'back', 'tabs', 'switch_tab', 'wait'].includes(args && args.action));

// ---------- economia de contexto ----------
// Saídas antigas de ferramentas "barulhentas" (retratos de página, OCR, comandos) ocupam muito contexto e
// confundem modelos menores em tarefas longas. Só as KEEP_RECENT mais novas vão inteiras para o modelo;
// as antigas viram um resumo curto. O histórico guardado (this.messages) não muda.
const NOISY_TOOLS = new Set(['browser', 'screen_text', 'ui_elements', 'windows', 'web_fetch', 'run_command', 'grep', 'glob', 'list_dir', 'git_diff', 'git_log']);
// leituras sem efeito colateral: quando o modelo pede várias de uma vez, rodam em paralelo
const PARALLEL_SAFE = new Set(['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'read_document',
  'code_map', 'find_symbol', 'find_references', 'read_symbol', 'code_deps', 'code_search', 'web_search', 'task', 'use_skill']);
const KEEP_RECENT = 4;
const OLD_OUTPUT_MAX = 600;
function compactHistory(messages) {
  let recent = 0;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || !NOISY_TOOLS.has(m.name)) continue;
    if (++recent <= KEEP_RECENT) continue;
    const c = String(m.content || '');
    if (c.length <= OLD_OUTPUT_MAX) continue;
    const head = c.slice(0, OLD_OUTPUT_MAX * 0.6), tail = c.slice(-OLD_OUTPUT_MAX * 0.3);
    out[i] = { ...m, content: `${head}
[... saída antiga encurtada (${c.length} caracteres) para economizar contexto; rode a ferramenta de novo se precisar ...]
${tail}` };
  }
  return out;
}

function describeCall(name, args) {
  switch (name) {
    case 'read_file': return `Read(${args.path})`;
    case 'write_file': return `Write(${args.path})`;
    case 'edit_file': return `Edit(${args.path})`;
    case 'multi_edit': return `MultiEdit(${args.path}, ${Array.isArray(args.edits) ? args.edits.length : 0} edições)`;
    case 'create_video': return `Video(${args.path}, ${Array.isArray(args.scenes) ? args.scenes.length : 0} cenas)`;
    case 'list_dir': return `List(${args.path || '.'})`;
    case 'glob': return `Glob(${args.pattern})`;
    case 'grep': return `Grep(${args.pattern})`;
    case 'run_command': return `Run(${args.command})${args.background ? ' &' : ''}`;
    case 'web_fetch': return `Web(${args.url})`;
    case 'web_search': return `Search(${args.query})`;
    case 'ask_user': return `Pergunta(${String(args.question || '').slice(0, 80)})`;
    case 'remember': return `${args.forget ? 'Esquecer' : 'Memória'}(${String(args.text || '').slice(0, 80)})`;
    case 'task': return `Subagente(${args.description || ''})`;
    case 'note': return `Nota(${String(args.text || '').slice(0, 80)})`;
    case 'load_tools': return `Ferramentas(${[].concat(args.groups || []).join(', ')})`;
    case 'command_output': return `Saída(${args.id})`;
    case 'command_stop': return `Parar(${args.id})`;
    case 'browser': return browserDescribe(args);
    case 'update_plan': {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const done = steps.filter((s) => s.status === 'done').length;
      return `Plano(${done}/${steps.length})`;
    }
    default: if (name.startsWith('mcp__')) { const [, server, ...tool] = name.split('__'); return `MCP(${server}: ${tool.join('__')})`; }
      return (MODULE_OF.get(name) && MODULE_OF.get(name).describe && MODULE_OF.get(name).describe(name, args))
      || gitDescribe(name, args) || officeDescribe(name, args) || pcDescribe(name, args) || `${name}(${JSON.stringify(args)})`;
  }
}

// Prévia de uma alteração: { removed: [linhas], added: [linhas], more: n } ou null.
function previewCall(name, args) {
  if (name === 'write_file') {
    const lines = String(args.content ?? '').split('\n');
    return { removed: [], added: lines.slice(0, 15), more: Math.max(0, lines.length - 15) };
  }
  if (name === 'edit_file') {
    const del = String(args.old_string ?? '').split('\n');
    const add = String(args.new_string ?? '').split('\n');
    return { removed: del.slice(0, 12), added: add.slice(0, 12), more: Math.max(0, del.length - 12) + Math.max(0, add.length - 12) };
  }
  if (name === 'multi_edit' && Array.isArray(args.edits)) {
    const del = [], add = [];
    for (const e of args.edits) { del.push(...String(e.old_string ?? '').split('\n')); add.push(...String(e.new_string ?? '').split('\n')); }
    return { removed: del.slice(0, 12), added: add.slice(0, 12), more: Math.max(0, del.length - 12) + Math.max(0, add.length - 12) };
  }
  return null;
}

// Esforço escolhido pelo usuário (/effort). Médio é o comportamento normal; baixo e alto ajustam a profundidade.
// Nos modelos que aceitam, também vai como reasoning_effort. Não muda o modelo: o auto usa sempre o mais forte disponível.
const EFFORT_PROMPT = {
  low: '# Esforço: baixo\nO usuário quer rapidez. Vá direto ao ponto: investigue só o necessário, sem plano para tarefas simples, '
    + 'respostas curtas. Ainda confira o resultado do que alterou (um teste ou uma leitura), mas sem varreduras extras.',
  medium: '',
  high: '# Esforço: alto\nO usuário quer o resultado mais cuidadoso possível, mesmo que demore. Antes de mudar, entenda o contexto completo '
    + '(quem chama, testes existentes, casos de borda). Considere alternativas e escolha a melhor com motivo. Depois de mudar, '
    + 'verifique de verdade: rode os testes e o build, revise o próprio diff procurando erros e só então conclua.',
};

function systemPrompt(cwd, { pc = IS_WIN, browser = false, assistant = true, extra: more = '' } = {}) {
  let extra = '';
  const mem = assistant ? readUserMemory() : '';
  if (mem) extra += `\n\n# Memória sobre o usuário (~/.rfcode/MEMORIA.md)\nUse isto para personalizar o trabalho; não repita de volta sem motivo.\n${mem}`;
  let br = '';
  try { br = brain.brief(cwd); } catch { /* sem cérebro */ }
  if (br) extra += `\n\n# Cérebro do projeto (.rfcode/brain.json)\nO que você já aprendeu sobre ESTE projeto em conversas anteriores. Confie nisto antes de investigar do zero, mas confirme se algo parecer desatualizado. Use recall para buscar mais e learn para guardar novas lições.\n${br}`;
  for (const f of ['RFCODE.md', 'CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(cwd, f);
    if (fs.existsSync(p)) {
      extra += `\n\n# Instruções do projeto (${f})\n` + truncate(fs.readFileSync(p, 'utf8'));
      break;
    }
  }
  return `Você é o rfcode, um agente que trabalha no computador do usuário, no estilo do Claude Code.
Você programa (lê, cria e modifica código, usa git, roda comandos e testes)${browser ? ', navega e age em sites' : ''}${pc ? ' e opera programas do Windows' : ''}, sempre verificando o próprio trabalho.
Tarefas longas são normais: planeje, avance um passo por vez, confira o resultado de cada ação e não desista no primeiro obstáculo; contorne ou pule o item e siga.

Ambiente:
- Diretório de trabalho: ${cwd}
- Sistema: ${process.platform} (${os.release()})
- Shell do run_command: ${IS_WIN ? 'PowerShell' : 'bash'}
- Data: ${new Date().toISOString().slice(0, 10)}

${WORK_STYLE}
${FILES_PROMPT}
${assistant ? ASSISTANT_PROMPT : ''}
${browser ? BROWSER_PROMPT : ''}${pc ? PC_PROMPT : ''}${extra}${more ? '\n\n' + more : ''}`;
}

// ---------- ajuda para edições que falham ----------
const trimEnd = (s) => s.replace(/[ \t]+$/, '');

// Procura old_string ignorando espaços no fim das linhas. Devolve o trecho real do arquivo se houver UMA ocorrência.
function findLooseMatch(src, old) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const srcLines = src.split(/\r?\n/);
  const oldLines = old.split(/\r?\n/).map(trimEnd);
  if (oldLines.length < 1 || !oldLines.join('').trim()) return null;
  const hits = [];
  for (let i = 0; i + oldLines.length <= srcLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length && ok; j++) {
      const s = trimEnd(srcLines[i + j]);
      // primeira e última linha podem ser parciais
      if (oldLines.length === 1) ok = s.includes(oldLines[0]);
      else if (j === 0) ok = s.endsWith(oldLines[0]);
      else if (j === oldLines.length - 1) ok = s.startsWith(oldLines[j]);
      else ok = s === oldLines[j];
    }
    if (ok) hits.push(i);
    if (hits.length > 1) return null;
  }
  if (hits.length !== 1) return null;
  const i = hits[0];
  const block = srcLines.slice(i, i + oldLines.length);
  if (oldLines.length === 1) {
    const at = block[0].indexOf(oldLines[0]);
    return at >= 0 ? block[0].slice(at, at + oldLines[0].length) : null;
  }
  const first = block[0].slice(trimEnd(block[0]).length - oldLines[0].length);
  const last = block[block.length - 1].slice(0, oldLines[oldLines.length - 1].length);
  const real = [first, ...block.slice(1, -1), last].join(nl);
  return src.split(real).length - 1 === 1 ? real : null;
}

// Mostra o trecho do arquivo mais parecido com old_string, numerado, para o modelo se corrigir sem reler tudo.
function nearestHint(src, old) {
  const srcLines = src.split(/\r?\n/);
  const oldLines = old.split(/\r?\n/);
  const words = (s) => new Set(s.toLowerCase().match(/[\w$]+/g) || []);
  const target = words(old);
  if (!target.size) return 'Leia o arquivo e copie o trecho exato.';
  const win = Math.max(1, Math.min(oldLines.length, 40));
  let best = { score: 0, at: 0 };
  for (let i = 0; i < srcLines.length; i++) {
    const w = words(srcLines.slice(i, i + win).join('\n'));
    let inter = 0;
    for (const t of target) if (w.has(t)) inter++;
    const score = inter / target.size;
    if (score > best.score) best = { score, at: i };
  }
  if (best.score < 0.3) return 'Nenhum trecho parecido foi encontrado; confira o arquivo com grep antes de editar.';
  const from = Math.max(0, best.at - 2);
  const to = Math.min(srcLines.length, best.at + win + 2);
  const snippet = srcLines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(5)}\t${l}`).join('\n');
  return `Trecho mais parecido (${Math.round(best.score * 100)}% das palavras), linhas ${from + 1}-${to}:\n${snippet}\n`
    + 'Copie o old_string exatamente deste trecho (sem os números de linha) e tente de novo.';
}

// Arquivo inexistente: mensagem com os nomes mais parecidos da mesma pasta (o modelo erra "notes.md" por "notas.md").
function notFound(full, agent) {
  const dir = path.dirname(full), base = path.basename(full).toLowerCase();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return `Pasta não encontrada: ${agent.rel(dir)}`; }
  const score = (n) => {
    const a = n.toLowerCase();
    if (a === base) return 0;
    let same = 0;
    while (same < a.length && same < base.length && a[same] === base[same]) same++;
    const ext = path.extname(a) === path.extname(base) ? 2 : 0;
    return 10 - same - ext + Math.abs(a.length - base.length) * 0.3;
  };
  const near = names.map((n) => [n, score(n)]).sort((x, y) => x[1] - y[1]).slice(0, 5).map(([n]) => n);
  return `Arquivo não encontrado: ${agent.rel(full)}.${near.length ? ` Arquivos parecidos nessa pasta: ${near.join(', ')}.` : ' A pasta está vazia.'}`;
}

// PowerShell 5.1 grava "> arquivo" em UTF-16 e o Python imprime em cp1252: força UTF-8 nos dois.
const PS_PRELUDE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; "
  + "$PSDefaultParameterValues['Out-File:Encoding']='utf8'; $PSDefaultParameterValues['Set-Content:Encoding']='utf8'; $PSDefaultParameterValues['Add-Content:Encoding']='utf8'; "
  + "$PSDefaultParameterValues['Get-Content:Encoding']='utf8'; $env:PYTHONUTF8='1'; $env:PYTHONIOENCODING='utf-8'; ";

// Texto corrompido: tokens especiais do modelo vazando ("<|close|>") ou repetição degenerada ("1. 1. 1. 1.").
function garbled(text) {
  const special = (text.match(/<\|[a-z_]{2,20}\|>/gi) || []).length;
  if (special >= 3) return true;
  const words = text.trim().split(/\s+/).slice(-80);
  if (words.length < 40) return false;
  return new Set(words).size / words.length < 0.15;
}

// ---------- agente ----------
const noop = () => {};

class Agent {
  /**
   * tools: lista de nomes de ferramentas permitidas (padrão: todas).
   * systemExtra: texto adicional no prompt do sistema.
   */
  /**
   * planReminderEvery: depois de quantas ações sem update_plan o resultado da ferramenta ganha um lembrete
   * para atualizar o plano (0 desliga). Modelos menores esquecem de atualizar; o lembrete mantém o plano vivo.
   */
  /**
   * extraTools: ferramentas que a interface injeta (ex.: diagnósticos do VS Code): { defs: [...], run(name, args) }.
   */
  /**
   * model: "provedor:modelo" ou "auto" (escolhe e troca de modelo sozinho). effort: low | medium | high.
   */
  constructor({ apiKey, model, cwd, tools, systemExtra, maxSteps, planReminderEvery = 8, saveSession = false, extraTools = null, effort = 'medium' }) {
    this.extraTools = extraTools;
    this.bg = new Map(); // comandos em segundo plano: id -> { child, out, read, done, code, command }
    this.bgSeq = 0;
    this.planReminderEvery = planReminderEvery;
    this.sincePlan = 0;
    this.readCache = new Map(); // "arquivo|início|fim" -> { hash, count }
    this.recentCalls = [];      // assinaturas das últimas ações, para detectar repetição
    // auto-reflexão (plasticidade): aprender sozinho ao se recuperar de uma falha
    this.hadFailure = false; this.learnNudged = false; this.learnedThisTurn = false;
    const available = [...(IS_WIN ? TOOL_DEFS : TOOL_DEFS.filter((t) => !PC_TOOLS.has(t.name))), ...((extraTools && extraTools.defs) || [])];
    // política da empresa pode desligar ferramentas ou grupos inteiros
    const groupOf = (n) => Object.keys(TOOL_GROUPS).find((g) => TOOL_GROUPS[g].tools.includes(n));
    const allowed = available.filter((t) => !enterprise.toolDisabled(t.name, groupOf));
    this.toolDefs = tools ? allowed.filter((t) => tools.includes(t.name)) : allowed;
    // lista explícita (subagente, auto-melhoria): tudo carregado; senão, grupos sob demanda
    this.deferTools = !tools;
    this.activeGroups = new Set();
    this.planOnly = false; // modo plano: só investiga e propõe, nada que altere algo
    this.systemExtra = systemExtra || '';
    this.maxSteps = maxSteps || MAX_STEPS;
    this.plan = null; // { goal, steps: [{ text, status }], why }
    this.usage = { prompt: 0, completion: 0, total: 0 };
    this.apiKey = apiKey;
    this.effort = providers.EFFORTS.includes(effort) ? effort : 'medium';
    this.cooldown = {}; // modelo -> até quando está no limite de pedidos (compartilhado com os subagentes)
    this.model = model || DEFAULT_MODEL;
    this.cwd = cwd || process.cwd();
    this.messages = [];
    this.autoApprove = false;
    this.controller = null;
    this.child = null;
    this.checkpoints = new CheckpointManager();
    this.sessionManager = new SessionManager({ cwd: this.cwd });
    this.saveSession = !!saveSession;
  }

  get busy() { return !!this.controller; }

  // this.model é sempre o modelo concreto da próxima chamada. Atribuir "auto" liga o modo auto (o agente
  // escolhe o modelo a cada passo); atribuir um modelo desliga. selectedModel é o que o usuário escolheu.
  get model() { return this._model; }
  set model(m) {
    this.auto = m === providers.AUTO;
    this._model = this.auto ? this.autoPick() || this._model || DEFAULT_MODEL : m || DEFAULT_MODEL;
  }
  get selectedModel() { return this.auto ? providers.AUTO : this._model; }

  // Modo auto: o primeiro candidato fora do limite de pedidos. ready: null se todos estão em espera
  // (senão devolve o que libera primeiro).
  autoPick({ ready = false } = {}) {
    const list = providers.autoCandidates(this.providerConfig()).filter((m) => enterprise.providerAllowed(providers.parseModel(m).provider));
    if (!list.length) return null;
    const now = Date.now();
    const free = list.find((m) => now >= (this.cooldown[m] || 0));
    if (free || ready) return free || null;
    return list.reduce((a, b) => ((this.cooldown[b] || 0) < (this.cooldown[a] || 0) ? b : a));
  }

  // Ferramentas enviadas na próxima chamada: básicas + grupos ativos (+ load_tools se faltar algum grupo).
  requestTools() {
    if (!this.deferTools) return this.toolDefs;
    const on = new Set([...this.activeGroups].flatMap((g) => (TOOL_GROUPS[g] ? TOOL_GROUPS[g].tools : [])));
    const list = this.toolDefs.filter((t) => !DEFERRED.has(t.name) || on.has(t.name));
    // conectores: com poucas ferramentas vão sempre; com muitas, por servidor (mcp:nome) quando o assunto aparece
    const mcpDefs = this.mcp ? this.mcp.defs() : [];
    const few = mcpDefs.length <= 25;
    const mcpOn = mcpDefs.filter((d) => few || this.activeGroups.has(`mcp:${d._mcp.server}`));
    const mcpOff = [...new Set(mcpDefs.filter((d) => !mcpOn.includes(d)).map((d) => d._mcp.server))];
    const missing = Object.keys(TOOL_GROUPS).filter((g) => !this.activeGroups.has(g) && TOOL_GROUPS[g].tools.some((n) => this.toolDefs.some((t) => t.name === n)));
    const out = [...list, ...mcpOn.map(({ _mcp, ...d }) => d)];
    if (!missing.length && !mcpOff.length) return out;
    const groups = [...missing, ...mcpOff.map((n) => `mcp:${n}`)];
    const desc = (g) => (g.startsWith('mcp:') ? `${g} (conector ${g.slice(4)}: ${mcpDefs.filter((d) => d._mcp.server === g.slice(4)).length} ferramentas)` : `${g} (${TOOL_GROUPS[g].desc})`);
    return [...out, { ...LOAD_TOOLS_DEF, description: `Carrega grupos de ferramentas que não estão disponíveis agora. Grupos: ${groups.map(desc).join('; ')}. Use quando a tarefa precisar delas.`,
      parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string', enum: groups } } }, required: ['groups'] } }];
  }

  guides() {
    if (!this.deferTools) return '';
    const names = new Set([...this.activeGroups].map((g) => GUIDE_OF[g] || (/^mcp:.*(power ?bi|fabric)/i.test(g) ? 'powerbi' : null)).filter(Boolean));
    const auto = [...(this.autoSkills || [])].map((n) => { try { return skills.loadSkill(this.cwd, n); } catch { return ''; } });
    const text = [...[...names].map(guide), ...auto].filter(Boolean).join('\n\n');
    return text ? `\n${text}` : '';
  }

  mcpPrompt() {
    if (!this.mcp || !this.mcp.clients.size) return '';
    const ok = [...this.mcp.clients.values()].filter((c) => c.status === 'conectado');
    if (!ok.length) return '';
    const inst = this.mcp.instructions();
    return '\n# Conectores (MCP)\nConectados: ' + ok.map((c) => `${c.name} (${c.tools.length} ferramentas)`).join(', ')
      + '. As ferramentas deles começam com mcp__<conector>__. Quando o pedido envolver o sistema de um conector, use as ferramentas dele em vez de navegador ou scripts.'
      + (inst ? `\nInstruções dos conectores:\n${inst}` : '');
  }

  // Conectores MCP configurados: conecta uma vez por agente (subagentes e listas fixas de ferramentas não usam)
  async ensureMcp(h) {
    if (!this.deferTools || this.mcpStarted) return;
    this.mcpStarted = true;
    this.mcp = new McpManager(this.cwd);
    const names = Object.keys(this.mcp.configured);
    if (!names.length) return;
    if (h && h.onInfo) h.onInfo(`Conectando ${names.length} conector(es): ${names.join(', ')}...`);
    await this.mcp.start(60000, { interactive: this.interactive !== false, onAuthUrl: (u) => h && h.onInfo && h.onInfo(`Para conectar, entre pelo navegador (se não abriu sozinho): ${u}`) });
    const bad = [...this.mcp.clients.values()].filter((c) => c.status !== 'conectado');
    if (bad.length && h && h.onInfo) h.onInfo(`Conector com problema: ${bad.map((c) => `${c.name} (${c.error})`).join('; ')}`);
  }

  // Modelo para desviar de um limite de pedidos: reserva configurada (ou recomendados do provedor) que não esteja em espera.
  hopModel() {
    const cfg = this.providerConfig();
    const { provider } = providers.parseModel(this.model);
    const own = (providers.PROVIDERS[provider].models || []).slice(0, 4).map(([m]) => providers.formatModel(provider, m));
    const list = Array.isArray(cfg.fallbackModels) && cfg.fallbackModels.length ? [...cfg.fallbackModels, ...(this.primaryModel ? [this.primaryModel] : [])] : own;
    const now = Date.now();
    for (const m of list) {
      if (m === this.model || now < (this.cooldown[m] || 0)) continue;
      try { providers.endpoint(m, cfg); } catch { continue; }
      if (!enterprise.providerAllowed(providers.parseModel(m).provider)) continue;
      return m;
    }
    return null;
  }

  // Modelo reserva: config.fallbackModels, ou os recomendados do mesmo provedor que ainda não falharam nesta tarefa.
  nextFallback() {
    const cfg = this.providerConfig();
    const { provider } = providers.parseModel(this.model);
    const own = (providers.PROVIDERS[provider].models || []).slice(0, 4).map(([m]) => providers.formatModel(provider, m));
    const list = Array.isArray(cfg.fallbackModels) && cfg.fallbackModels.length ? cfg.fallbackModels : own;
    this.triedFallback ||= new Set([this.model]);
    for (const m of list) {
      if (this.triedFallback.has(m)) continue;
      this.triedFallback.add(m);
      try { providers.endpoint(m, cfg); } catch { continue; } // sem chave para esse provedor
      if (!enterprise.providerAllowed(providers.parseModel(m).provider)) continue;
      return m;
    }
    return null;
  }

  // /mcp login: abre o navegador, guarda o token e reconecta o conector
  async mcpLogin(name, onAuthUrl) {
    if (!this.mcp) { this.mcp = new McpManager(this.cwd); this.mcpStarted = true; await this.mcp.start(60000); }
    await this.mcp.login(name, { onAuthUrl, interactive: true });
    return this.mcp.status();
  }

  // aprovação: conectores têm regra própria (confiável ou só leitura dispensa)
  approvalNeeded(name, args) {
    if (name.startsWith('mcp__') && this.mcp && this.mcp.find(name)) return this.mcp.needsApproval(name);
    return needsApproval(name, args);
  }

  // Ativa os grupos cujo assunto aparece no texto (sem gastar uma ida e volta com load_tools).
  activateFor(text) {
    if (!this.deferTools) return;
    for (const [g, def] of Object.entries(TOOL_GROUPS)) if (def.hint.test(String(text || ''))) this.activeGroups.add(g);
    // skill cujas palavras-chave aparecem no pedido: o conteúdo entra direto no prompt
    try {
      const t = String(text || '').toLowerCase();
      for (const sk of skills.listSkills(this.cwd)) if (sk.keywords.some((k) => k && t.includes(k))) (this.autoSkills ||= new Set()).add(sk.name);
    } catch { /* pasta de skills ilegível */ }
    // conector citado pelo nome (ou por uma das palavras-chave do mcp.json)
    if (this.mcp) for (const [name, c] of this.mcp.clients) {
      const words = [name, ...(c.cfg.keywords || [])].map((w) => String(w).toLowerCase());
      if (words.some((w) => w && String(text || '').toLowerCase().includes(w))) this.activeGroups.add(`mcp:${name}`);
    }
  }

  load_tools({ groups }) {
    const ok = (Array.isArray(groups) ? groups : [groups]).filter((g) => TOOL_GROUPS[g] || (String(g).startsWith('mcp:') && this.mcp && this.mcp.clients.has(String(g).slice(4))));
    if (!ok.length) throw new Error(`Grupos disponíveis: ${Object.keys(TOOL_GROUPS).join(', ')}`);
    ok.forEach((g) => this.activeGroups.add(g));
    return `Ferramentas carregadas: ${ok.map((g) => (TOOL_GROUPS[g] ? TOOL_GROUPS[g].tools.join(', ') : this.mcp.defs().filter((d) => `mcp:${d._mcp.server}` === g).map((d) => d.name).join(', '))).join(', ')}. Já pode usá-las.`;
  }

  // Mensagens enviadas enquanto o agente trabalha: entram na conversa no próximo passo.
  queue(text, attachments = []) {
    const t = String(text || '').trim();
    if (!t && !attachments.length) return 0;
    this.pendingUser = this.pendingUser || [];
    this.pendingUser.push({ text: t, attachments });
    return this.pendingUser.length;
  }

  takeQueued(h) {
    if (!this.pendingUser || !this.pendingUser.length) return false;
    const items = this.pendingUser.splice(0);
    // compatibilidade: a fila antiga guardava só texto
    const texts = [], attachments = [];
    for (const it of items) {
      if (typeof it === 'string') texts.push(it);
      else { texts.push(it.text); attachments.push(...(it.attachments || [])); }
    }
    const body = texts.map((t) => expandMentions(t, this.cwd)).join('\n\n');
    this.messages.push({
      role: 'user',
      content: this.userContent(`[O usuário mandou ${texts.length > 1 ? 'novas mensagens' : 'uma nova mensagem'} enquanto você trabalhava. Considere junto com o pedido anterior: `
        + `ajuste o plano se mudou algo, e não abandone o que já estava fazendo sem motivo.]\n\n${body}`, attachments),
    });
    if (h.onQueued) h.onQueued(texts);
    return true;
  }

  // Monta o conteúdo da mensagem do usuário: texto puro, ou multimodal quando há anexos.
  // Imagens vão como image_url (base64); arquivos de texto são lidos e embutidos; os demais
  // entram como referência ao arquivo salvo em ~/.rfcode/attachments (o agente abre com read_file).
  userContent(text, attachments = []) {
    if (!attachments.length) return text;
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    const saved = [];
    for (const a of attachments) {
      if ((a.mime || '').startsWith('image/') && a.data) {
        parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } });
      } else {
        const embedded = this.embedTextAttachment(a);
        if (embedded) parts.push({ type: 'text', text: embedded });
        else if (a.file) saved.push(`${a.name}: ${a.file}`);
      }
    }
    if (saved.length) parts.push({ type: 'text', text: `[Anexos salvos neste computador — abra com read_file se precisar do conteúdo:]\n${saved.join('\n')}` });
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
  }

  // Arquivo de texto pequeno (código, csv, json, log...): embute o conteúdo na mensagem.
  embedTextAttachment(a) {
    if (!a.file) return null;
    const textual = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|x-sh))/.test(a.mime || '')
      || /\.(md|txt|csv|json|jsonl|ya?ml|xml|js|jsx|ts|tsx|py|java|c|h|cpp|cs|go|rs|rb|php|sh|ps1|bat|sql|html|css|log|ini|cfg|toml|env)$/i.test(a.name || '');
    if (!textual) return null;
    try {
      if (fs.statSync(a.file).size > 200 * 1024) return null;
      let content = fs.readFileSync(a.file, 'utf8');
      if (content.length > 20000) content = content.slice(0, 20000) + '\n... [truncado, limite de 20.000 caracteres atingido]';
      return `--- Begin file: ${a.name} ---\n${content}\n--- End file: ${a.name} ---`;
    } catch { return null; }
  }

  // A conversa pode ter parado no meio (VS Code recarregado, processo encerrado): ações sem resultado
  // ganham um resultado de "interrompida", para o histórico ficar válido. Devolve true se havia algo pendente.
  repairHistory() {
    const answered = new Set(this.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    const out = [];
    let pending = false;
    for (const m of this.messages) {
      out.push(m);
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (answered.has(tc.id)) continue;
          pending = true;
          out.push({ role: 'tool', tool_call_id: tc.id, name: tc.function && tc.function.name, content: 'Ação interrompida: o rfcode foi reiniciado antes de concluir. Confira o estado antes de repetir.' });
        }
      }
    }
    this.messages = out;
    const last = out[out.length - 1];
    return pending || (!!last && (last.role === 'user' || last.role === 'tool'));
  }

  // Precisa retomar? (última resposta não terminou)
  get interrupted() {
    const last = this.messages[this.messages.length - 1];
    return !!last && (last.role === 'user' || last.role === 'tool' || (last.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0));
  }

  // Continua uma tarefa interrompida a partir do histórico salvo.
  resume(hooks = {}) {
    return this.send(null, hooks, { resume: true });
  }

  // Chaves e endereços dos provedores: config.json + a chave passada ao criar o agente (NVIDIA, por compatibilidade).
  providerConfig() {
    const cfg = loadConfig();
    const keys = { ...(cfg.keys || {}), ...(this.keys || {}) };
    if (this.apiKey) keys.nvidia = this.apiKey;
    return { ...cfg, keys };
  }

  endpoint() {
    const { provider } = providers.parseModel(this.model);
    if (!enterprise.providerAllowed(provider)) {
      const e = new Error(`O provedor ${provider} não é permitido pela política da empresa (${enterprise.policyFile()}).`);
      e.fatal = true;
      throw e;
    }
    try { return providers.endpoint(this.model, this.providerConfig()); } catch (e) { e.fatal = true; throw e; }
  }

  clear() { this.notes = []; this.touched = new Set(); this.messages = []; this.plan = null; this.sincePlan = 0; this.readCache.clear(); this.recentCalls = []; this.stopBackground(); }

  stopBackground() {
    for (const b of this.bg.values()) if (!b.done) killTree(b.child);
    this.bg.clear();
  }

  // Conteúdo do arquivo antes e depois de uma edição proposta (para mostrar o diff antes de aprovar).
  proposedContent(name, args) {
    const full = this.resolve(args.path);
    let before = '';
    try { before = fs.readFileSync(full, 'utf8'); } catch { /* arquivo novo */ }
    if (name === 'write_file') return { path: full, before, after: String(args.content ?? '') };
    if (name === 'edit_file') return { path: full, before, after: this.applyEdit(before, args, this.rel(full)).src };
    if (name === 'multi_edit') {
      let after = before;
      for (const e of args.edits || []) after = this.applyEdit(after, e || {}, this.rel(full)).src;
      return { path: full, before, after };
    }
    return null;
  }

  // Detecta a mesma ação repetida (mesma ferramenta e mesmos argumentos) e avisa o modelo para mudar de abordagem.
  repeatGuard(name, args, output) {
    if (name === 'update_plan' || name === 'note') return output;
    // ler/rolar/esperar de novo é normal no navegador (a página muda entre uma chamada e outra)
    if (name === 'browser' && ['read', 'scroll', 'wait', 'key', 'back', 'tabs'].includes(args && args.action)) return output;
    const sig = name + ':' + JSON.stringify(args);
    const times = this.recentCalls.filter((s) => s === sig).length;
    this.recentCalls.push(sig);
    if (this.recentCalls.length > 10) this.recentCalls.shift();
    if (times + 1 >= STUCK_REPEATS) this.stuck = name;
    if (times >= 2) {
      return `${output}\n\n[alerta do sistema: você já fez exatamente esta ação ${times + 1} vezes. Repetir não vai dar um resultado diferente. `
        + 'Mude de abordagem: use outra ferramenta, outro argumento, ou explique o bloqueio e siga em frente.]';
    }
    return output;
  }

  // Auto-reflexão (plasticidade): ao se recuperar de uma falha, cutuca a consolidar a lição no cérebro.
  // Dispara uma vez por turno, no instante da recuperação (falhou antes, deu certo agora).
  reflectNudge(name, output, error) {
    if (name === 'learn' || name === 'reflect') { this.learnedThisTurn = true; return output; }
    if (!this.toolDefs.some((t) => t.name === 'reflect')) return output; // cérebro indisponível (ex.: subagente)
    const failed = error || /\bFALHOU\b|\(código [1-9]/.test(String(output).slice(0, 200));
    if (failed) { this.hadFailure = true; return output; }
    if (this.hadFailure && !this.learnNudged && !this.learnedThisTurn) {
      this.hadFailure = false; this.learnNudged = true;
      return `${output}\n\n[lembrete do sistema: você se recuperou de uma falha. Se há uma lição durável (a causa do erro e o que resolveu), guarde já com learn (use outcome "avoid" para o que não repetir) ou, no fim da tarefa, consolide com reflect. É assim que você deixa de repetir o mesmo erro.]`;
    }
    return output;
  }

  planNudge(name, output) {
    if (name === 'update_plan') { this.sincePlan = 0; return output; }
    if (!this.planReminderEvery || !this.toolDefs.some((t) => t.name === 'update_plan')) return output;
    this.sincePlan++;
    if (this.sincePlan < this.planReminderEvery) return output;
    if (!this.plan) {
      this.sincePlan = 0;
      return `${output}\n\n[lembrete do sistema: você já fez ${this.planReminderEvery} ações sem declarar um plano. Se a tarefa tem 3 ou mais passos, chame update_plan com o objetivo, os passos e o porquê do passo atual.]`;
    }
    if (this.plan.steps.some((s) => s.status !== 'done')) {
      this.sincePlan = 0;
      return `${output}\n\n[lembrete do sistema: faz ${this.planReminderEvery} ações que o plano não é atualizado. Chame update_plan marcando o que terminou, o passo atual e o porquê.]`;
    }
    return output;
  }

  update_plan({ goal, steps, why }, h) {
    const list = (Array.isArray(steps) ? steps : [])
      .map((s) => ({ text: String(s.text || '').trim(), status: ['pending', 'in_progress', 'done'].includes(s.status) ? s.status : 'pending' }))
      .filter((s) => s.text);
    this.plan = { goal: goal || this.plan?.goal || '', steps: list, why: why || '' };
    h.onPlan(this.plan);
    const done = list.filter((s) => s.status === 'done').length;
    const cur = list.find((s) => s.status === 'in_progress');
    return `Plano atualizado: ${done}/${list.length} concluídos${cur ? `; em andamento: ${cur.text}` : ''}.`;
  }

  // Resume a conversa numa chamada sem ferramentas e troca o histórico pelo resumo. Devolve o resumo.
  // /compact: resume quase tudo, mantendo só as últimas trocas.
  async compact() {
    if (this.busy) throw new Error('Espere a resposta atual terminar.');
    if (this.messages.length < 4) return null;
    return this.compactNow({ keepTokens: 0 });
  }

  // janela do modelo; se a API já informou um limite menor (erro de excesso), vale o aprendido
  // Último pedido real do usuário (para o resumo saber o que preservar).
  currentTask() {
    const m = [...this.messages].reverse().find(ctx.isRealUser);
    return m ? ctx.userText(m) : '';
  }

  contextWindow() { return this.learnedWindow || ctx.contextWindow(this.model, this.providerConfig()); }

  // Tokens que a próxima chamada vai usar: valor real da última chamada + estimativa do que entrou depois.
  contextTokens() {
    const sys = 4000; // prompt do sistema + definições das ferramentas (aproximado)
    if (this.lastPrompt && this.lastPromptCount <= this.messages.length) {
      return this.lastPrompt + ctx.estimateTokens(this.messages.slice(this.lastPromptCount));
    }
    return sys + ctx.estimateTokens(this.messages);
  }

  // Compacta se a conversa passou do limite. Chamado antes de cada chamada ao modelo (também no meio da tarefa).
  async maybeCompact(h, { force = false } = {}) {
    const win = this.contextWindow();
    const used = this.contextTokens();
    if (!force && (used < win * ctx.COMPACT_AT || this.messages.length < 6)) return false;
    if (!force && this.compactedAt && this.messages.length - this.compactedAt < 6) return false;
    h.onRetry(`Contexto em ${Math.round((used / win) * 100)}% (${Math.round(used / 1000)} mil de ${Math.round(win / 1000)} mil tokens): resumindo a parte antiga da conversa...`);
    try {
      const r = await this.compactNow({ keepTokens: win * (force ? 0.15 : ctx.KEEP_RECENT) });
      if (r && this.saveSession) this.sessionManager.save(this.messages, 'running');
      return !!r;
    } catch (e) {
      log.warn('contexto', 'falha ao compactar: ' + e.message);
      h.onRetry('Não consegui resumir a conversa (' + e.message.slice(0, 80) + '); seguindo assim mesmo.');
      return false;
    }
  }

  // Resume as mensagens antigas e mantém o trecho recente intacto. Devolve o resumo, ou null se não havia o que resumir.
  async compactNow({ keepTokens }) {
    const at = ctx.splitPoint(this.messages, keepTokens);
    if (at < 0) return null;
    const head = this.messages.slice(0, at);
    const tail = this.messages.slice(at);
    const ep = this.endpoint();
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: ep.headers,
      body: JSON.stringify(providers.requestBody(ep, {
        messages: [...compactHistory(head), { role: 'user', content: ctx.compactPrompt(this.currentTask()) }], maxTokens: 2500, temperature: 0.2, stream: false,
      })),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(providers.explainError(res.status, txt, ep) || `HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }
    const j = await res.json();
    const summary = String(j.choices?.[0]?.message?.content || '').trim();
    if (!summary) throw new Error('O modelo não devolveu um resumo.');
    const note = ctx.stateNote(this, head);
    const merged = [{ role: 'user', content: `${ctx.SUMMARY_PREFIX}\n${summary}${note}` }];
    // o trecho mantido começa com o usuário? então o resumo ganha uma confirmação para manter a alternância
    if (!tail.length || tail[0].role === 'user') merged.push({ role: 'assistant', content: 'Entendido. Continuo a partir do resumo.' });
    this.messages = [...merged, ...tail];
    this.lastPrompt = 0;
    this.compactions = (this.compactions || 0) + 1;
    this.compactedAt = this.messages.length;
    this.readCache.clear();
    this.recentCalls = [];
    log.info('contexto', `compactado: ${head.length} mensagens resumidas, ${tail.length} mantidas`);
    return summary;
  }

  abort() {
    if (this.controller) this.controller.abort();
    killTree(this.child);
  }

  // O modelo não entende imagens: troca os blocos image_url da conversa por referências
  // aos arquivos salvos (o agente pode abrir com read_file se o modelo tiver visão via ferramenta).
  // Devolve true se alguma mensagem mudou.
  stripImages() {
    this.imagesStripped = true;
    let changed = false;
    this.messages = this.messages.map((m) => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return m;
      const texts = [];
      for (const p of m.content) {
        if (p.type === 'text') texts.push(p.text);
        else if (p.type === 'image_url') { texts.push('[Imagem anexada: o modelo atual não consegue ver imagens. Se precisar do conteúdo, peça ao usuário uma descrição ou use OCR com as ferramentas de PC.]'); changed = true; }
      }
      return { ...m, content: texts.join('\n\n') };
    });
    return changed;
  }

  /**
   * Desfaz a última alteração de arquivo (write_file ou edit_file).
   * Restaura o conteúdo anterior ou remove o arquivo se ele não existia antes.
   * @returns {string} Descrição da operação realizada ou mensagem de erro se não houver checkpoints
   */
  undo() {
    const checkpoint = this.checkpoints.popCheckpoint();
    if (!checkpoint) {
      return 'Nenhum checkpoint disponível para desfazer.';
    }

    const { path: fullPath, existed, content } = checkpoint;
    const relativePath = this.rel(fullPath);

    try {
      if (existed) {
        // Restaura o conteúdo anterior
        fs.writeFileSync(fullPath, content, 'utf8');
        return `Desfeito: restaurado ${relativePath} (${content.split('\n').length} linhas)`;
      } else {
        // Remove o arquivo que foi criado
        fs.unlinkSync(fullPath);
        return `Desfeito: removido ${relativePath} (arquivo recém-criado)`;
      }
    } catch (err) {
      // Se algo der errado ao desfazer, colocamos o checkpoint de volta na pilha?
      // Por simplicidade, vamos apenas retornar o erro e deixar o checkpoint descartado
      return `Erro ao desfazer alteração em ${relativePath}: ${err.message}`;
    }
  }

  resolve(p) { return path.resolve(this.cwd, p || '.'); }
  rel(p) { return path.relative(this.cwd, p).replace(/\\/g, '/') || '.'; }

  // ----- implementação das ferramentas -----
  read_file({ path: p, offset, limit }) {
    const full = this.resolve(p);
    if (!fs.existsSync(full)) throw new Error(notFound(full, this));
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, offset || 1);
    const end = limit ? Math.min(lines.length, start + limit - 1) : Math.min(lines.length, start + 1999);
    // Memória de leitura: reler o mesmo trecho de um arquivo que não mudou só enche o contexto
    // (modelos menores fazem isso em loop). Devolve um aviso curto no lugar do conteúdo.
    const key = `${full}|${start}|${end}`;
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const seen = this.readCache.get(key);
    if (seen && seen.hash === hash) {
      seen.count++;
      return `[já lido] Você já leu ${this.rel(full)} (linhas ${start}-${end}) e o arquivo não mudou desde então. `
        + 'O conteúdo está acima no histórico. Use grep para localizar um trecho específico, read_file com offset/limit para outra parte, '
        + 'ou siga para a próxima ação (editar, testar).';
    }
    this.readCache.set(key, { hash, count: 1 });
    const out = [];
    for (let i = start; i <= end; i++) out.push(`${String(i).padStart(5)}\t${lines[i - 1]}`);
    if (end < lines.length) out.push(`... (${lines.length - end} linhas restantes; use offset)`);
    return out.join('\n') || '(arquivo vazio)';
  }

  write_file({ path: p, content }) {
    const full = this.resolve(p);
    if (/\.(pptx|docx|xlsx|pdf|png|jpe?g|gif|zip|webm|mp4)$/i.test(full)) throw new Error('write_file grava texto e corromperia este arquivo binário. Use create_pptx, create_docx ou um comando (copiar, mover).');
    this.checkpoints.saveCheckpoint(full);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    let text = content ?? '';
    // CSV com BOM: sem ele o Excel abre os acentos errado
    if (/\.csv$/i.test(full) && text && !text.startsWith('\uFEFF')) text = '\uFEFF' + text;
    fs.writeFileSync(full, text, 'utf8');
    return `Arquivo escrito: ${this.rel(full)} (${String(content ?? '').split('\n').length} linhas)`;
  }

  // Aplica uma substituição em memória; devolve { src, count } ou lança erro com dica do trecho mais parecido.
  applyEdit(src, { old_string, new_string, replace_all }, relName) {
    if (!old_string) throw new Error('old_string vazio. Para criar um arquivo use write_file.');
    let oldS = old_string, newS = new_string ?? '';
    // tolera diferença de quebra de linha CRLF/LF
    if (src.includes('\r\n') && !oldS.includes('\r\n')) {
      oldS = oldS.replace(/\n/g, '\r\n');
      newS = newS.replace(/\n/g, '\r\n');
    }
    let count = src.split(oldS).length - 1;
    if (count === 0) {
      // tolera espaços sobrando no fim das linhas (erro comum ao copiar o trecho)
      const loose = findLooseMatch(src, oldS);
      if (loose) { oldS = loose; count = 1; }
      else throw new Error(`old_string não encontrado em ${relName}.\n${nearestHint(src, old_string)}`);
    }
    if (count > 1 && !replace_all) throw new Error(`old_string aparece ${count} vezes. Inclua mais contexto ou use replace_all.`);
    return { src: replace_all ? src.split(oldS).join(newS) : src.replace(oldS, () => newS), count: replace_all ? count : 1 };
  }

  edit_file(args) {
    const full = this.resolve(args.path);
    if (!fs.existsSync(full)) throw new Error(notFound(full, this));
    const r = this.applyEdit(fs.readFileSync(full, 'utf8'), args, this.rel(full));
    // só guarda o checkpoint quando a edição vai acontecer (edição inválida não vira um "desfazer" vazio)
    this.checkpoints.saveCheckpoint(full);
    fs.writeFileSync(full, r.src, 'utf8');
    return `Arquivo editado: ${this.rel(full)} (${r.count} substituição(ões))`;
  }

  multi_edit({ path: p, edits }) {
    if (!Array.isArray(edits) || !edits.length) throw new Error('Informe edits: [{ old_string, new_string, replace_all? }].');
    const full = this.resolve(p);
    let src = fs.readFileSync(full, 'utf8');
    let total = 0;
    edits.forEach((e, i) => {
      try {
        const r = this.applyEdit(src, e || {}, this.rel(full));
        src = r.src;
        total += r.count;
      } catch (err) {
        throw new Error(`Edição ${i + 1} de ${edits.length} falhou; nada foi gravado.\n${err.message}`);
      }
    });
    this.checkpoints.saveCheckpoint(full);
    fs.writeFileSync(full, src, 'utf8');
    return `Arquivo editado: ${this.rel(full)} (${edits.length} edições, ${total} substituição(ões))`;
  }

  async create_video(args, h, signal) {
    const r = await createVideo(args, this.cwd, { signal, onProgress: (m) => h.onCommandOutput(m + '\n') });
    return `Vídeo criado: ${this.rel(r.file)} (${r.seconds} s, ${r.scenes} cenas${r.voice ? ', voz ' + r.voice : ''}).`
      + (r.notes.length ? '\n' + r.notes.join('\n') : '');
  }

  list_dir({ path: p }) {
    return fs.readdirSync(this.resolve(p), { withFileTypes: true })
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
      .join('\n') || '(vazio)';
  }

  glob({ pattern, path: p }) {
    const base = this.resolve(p);
    const re = globToRegex(pattern);
    const files = walk(base).filter((f) => {
      const r = path.relative(base, f).replace(/\\/g, '/');
      return re.test(r) || (!pattern.includes('/') && re.test(path.basename(f)));
    });
    return files.slice(0, 500).map((f) => this.rel(f)).join('\n') || '(nenhum arquivo)';
  }

  grep({ pattern, path: p, glob, ignore_case }) {
    const base = this.resolve(p);
    const re = new RegExp(pattern, ignore_case ? 'i' : '');
    const fileRe = glob ? globToRegex(glob) : null;
    const files = fs.statSync(base).isDirectory() ? walk(base) : [base];
    const out = [];
    for (const f of files) {
      if (fileRe && !fileRe.test(path.basename(f)) && !fileRe.test(path.relative(base, f).replace(/\\/g, '/'))) continue;
      let text;
      try {
        if (fs.statSync(f).size > 2_000_000) continue;
        text = fs.readFileSync(f, 'utf8');
      } catch { continue; }
      if (text.includes('\u0000')) continue; // binário
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${this.rel(f)}:${i + 1}:${lines[i].slice(0, 300)}`);
          if (out.length >= 300) return out.join('\n') + '\n... (limite de 300 resultados)';
        }
      }
    }
    return out.join('\n') || '(nenhum resultado)';
  }

  run_command({ command, timeout_ms, background }, onOutput) {
    if (background) return this.startBackground(command);
    return new Promise((resolve) => {
      const child = IS_WIN
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `${PS_PRELUDE}${command}`], { cwd: this.cwd, windowsHide: true, env: dedupeEnv(process.env) })
        : spawn('bash', ['-lc', command], { cwd: this.cwd });
      this.child = child;
      let out = '';
      const onData = (d) => { const s = d.toString(); out += s; onOutput(s); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const t = setTimeout(() => { out += '\n[timeout]'; killTree(child); }, timeout_ms || 120000);
      child.on('close', (code) => {
        clearTimeout(t);
        this.child = null;
        resolve(truncate(`${out}\n[exit code: ${code}]`));
      });
      child.on('error', (e) => { clearTimeout(t); this.child = null; resolve(`Erro ao executar: ${e.message}`); });
    });
  }

  startBackground(command) {
    const child = IS_WIN
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${PS_PRELUDE}${command}`],
        { cwd: this.cwd, windowsHide: true, env: dedupeEnv(process.env) })
      : spawn('bash', ['-lc', command], { cwd: this.cwd });
    const id = `bg${++this.bgSeq}`;
    const b = { child, out: '', read: 0, done: false, code: null, command };
    const onData = (d) => { b.out += d.toString(); if (b.out.length > 400000) { b.read = Math.max(0, b.read - 200000); b.out = b.out.slice(200000); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { b.done = true; b.code = code; });
    child.on('error', (e) => { b.done = true; b.out += `\nErro ao iniciar: ${e.message}`; });
    this.bg.set(id, b);
    BG_CHILDREN.add(child);
    return `Iniciado em segundo plano com id ${id}. Use command_output({ id: "${id}" }) para ver a saída e command_stop para parar.`;
  }

  async command_output({ id }) {
    const b = this.bg.get(id);
    if (!b) throw new Error(`Comando ${id} não existe. Ids: ${[...this.bg.keys()].join(', ') || 'nenhum'}.`);
    if (!b.done && b.read === b.out.length) await new Promise((r) => setTimeout(r, 1500)); // dá um tempo para chegar saída
    const fresh = b.out.slice(b.read);
    b.read = b.out.length;
    const state = b.done ? `terminou (exit code: ${b.code})` : 'ainda rodando';
    return truncate(`[${id} ${state}] ${b.command}\n${fresh || '(sem saída nova)'}`);
  }

  command_stop({ id }) {
    const b = this.bg.get(id);
    if (!b) throw new Error(`Comando ${id} não existe.`);
    if (!b.done) {
      killTree(b.child, { sync: true });
      // um processo neto pode segurar a saída aberta mesmo depois do taskkill: para de ler e dá por encerrado
      try { b.child.stdout.destroy(); b.child.stderr.destroy(); } catch { /* já fechado */ }
      b.done = true;
      b.code = b.code ?? 'parado';
      b.read = b.out.length;
    }
    return `Parado: ${id} (${b.command})`;
  }

  note({ text }) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('Informe o texto da anotação.');
    (this.notes ||= []).push(t.slice(0, 500));
    if (this.notes.length > 200) this.notes.shift();
    return `Anotado (${this.notes.length}).`;
  }

  async web_search({ query, max_results, region }, _out, signal) {
    const r = await webSearch(query, { max: Math.min(15, max_results || 8), region: region || 'br-pt', signal });
    return formatResults(query, r);
  }

  remember({ text, scope, forget: del }) {
    return del ? forget(text) : remember(text, scope === 'projeto' ? 'projeto' : 'usuario', this.cwd);
  }

  async ask_user({ question, options }, h) {
    if (typeof h.ask !== 'function') return '(sem resposta: o usuário não está disponível agora; decida com bom senso e siga, explicando a escolha no final)';
    const answer = await h.ask({ question: String(question || ''), options: Array.isArray(options) ? options.map(String).slice(0, 6) : [] });
    return answer ? `Resposta do usuário: ${answer}` : '(o usuário não respondeu; decida com bom senso e siga)';
  }

  // Subagente: um Agent filho, só com ferramentas de leitura, que devolve o relatório final.
  async task({ description, prompt }, h, signal) {
    const child = new Agent({
      apiKey: this.apiKey, model: this.selectedModel, effort: this.effort, cwd: this.cwd, tools: SUBAGENT_TOOLS, planReminderEvery: 0,
      systemExtra: 'Você é um SUBAGENTE de pesquisa. Investigue o pedido usando só leitura (arquivos, git, documentos, internet) e termine com um '
        + 'relatório objetivo e completo para o agente principal: conclusões, evidências (caminhos de arquivo com linha, ou endereços das fontes) e o que ficou incerto. Não peça nada ao usuário.',
    });
    child.autoApprove = true;
    child.cooldown = this.cooldown; // limites de pedidos valem para os dois: o subagente não insiste num modelo em espera
    const stop = () => child.abort();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    let err = '';
    h.onCommandOutput(`Subagente: ${description || 'pesquisa'}\n`);
    try {
      await child.send(prompt, {
        onToolCall: (i) => h.onCommandOutput(`  ↳ ${i.label}\n`),
        onError: (e) => { err = e; },
        onUsage: (u) => { this.usage.total += 0; void u; },
      });
    } finally {
      if (signal) signal.removeEventListener('abort', stop);
    }
    this.usage.prompt += child.usage.prompt;
    this.usage.completion += child.usage.completion;
    this.usage.total += child.usage.total;
    const final = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.content && m.content.trim());
    if (!final) throw new Error(`O subagente não chegou a um relatório${err ? ': ' + err : '.'}`);
    return `Relatório do subagente (${description || 'pesquisa'}):\n${final.content.trim()}`;
  }

  web_fetch({ url }) {
    // Validate URL protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('Erro: URL deve começar com http:// ou https://');
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    return fetch(url, { signal: controller.signal })
      .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.text();
      })
      .then(html => {
        // Convert HTML to text
        // Remove script and style elements
        let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
        
        // Remove HTML tags
        text = text.replace(/<[^>]*>/g, '');
        
        // Replace basic HTML entities (&amp; por último, senão "&amp;lt;" viraria "<")
        text = text
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&');

        // junta espaços e linhas em branco que sobram das tags
        text = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        
        // Limit to 20000 characters
        if (text.length > 20000) {
          text = text.slice(0, 20000) + '\n... [truncado, ' + (text.length - 20000) + ' caracteres omitidos]';
        }
        
        return text;
      })
      .catch(error => {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('Timeout ao buscar URL (20s)');
        }
        throw error;
      });
  }

  // ----- chamada streaming -----
  async chat(hooks, signal) {
    const ep = this.endpoint();
    const sentCount = this.messages.length;
    const usageBefore = { p: this.usage.prompt, c: this.usage.completion };
    this.noEffort ||= new Set(); // modelos que recusaram reasoning_effort
    const body = providers.requestBody(ep, {
      messages: [{ role: 'system', content: systemPrompt(this.cwd, {
        pc: IS_WIN && this.requestTools().some((t) => PC_TOOLS.has(t.name)),
        browser: this.requestTools().some((t) => t.name === 'browser'),
        assistant: this.toolDefs.some((t) => t.name === 'ask_user'),
        extra: [this.systemExtra, EFFORT_PROMPT[this.effort], this.mcpPrompt(), this.deferTools ? skills.skillsPrompt(this.cwd) : '', this.guides()].filter(Boolean).join('\n'),
      }) }, ...compactHistory(this.messages)],
      tools: this.requestTools().map((t) => ({ type: 'function', function: t })),
      effort: this.noEffort.has(this._model) ? undefined : this.effort,
    });
    const post = () => fetch(ep.url, { method: 'POST', headers: { ...ep.headers, Accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
    let res = await post();
    let txt = null;
    // o provedor não aceitou o parâmetro de esforço: lembra e manda de novo sem ele
    if (res.status === 400 && body.reasoning_effort) {
      txt = await res.text().catch(() => '');
      if (/reasoning|effort|unrecognized|unknown|extra.*(field|param)|not permitted/i.test(txt)) {
        this.noEffort.add(this._model);
        delete body.reasoning_effort;
        res = await post();
        txt = null;
      }
    }
    if (!res.ok) {
      if (txt == null) txt = await res.text().catch(() => '');
      const friendly = providers.explainError(res.status, txt, ep);
      const err = new Error(friendly ? `${friendly}\n(HTTP ${res.status}: ${txt.slice(0, 300)})` : `HTTP ${res.status}: ${txt.slice(0, 500)}`);
      err.status = res.status;
      const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : 0);
      if (ra > 0) err.retryAfter = ra;
      err.fatal = !!friendly && res.status !== 429;
      throw err;
    }
    hooks.onResponseStart();

    let content = '';
    const toolCalls = [];
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        // alguns provedores mandam o erro dentro do stream, com HTTP 200 (ex.: servidor sobrecarregado)
        if (j.error && !j.choices) {
          const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
          const busy = /exhausted|limit|overload|capacity|rate|429|503|unavailable/i.test(msg);
          const err = new Error(busy ? `${ep.name} está sobrecarregado para ${ep.model} (${msg.slice(0, 160)}). Tente de novo em instantes ou troque de modelo com /model.` : `Erro do provedor: ${msg.slice(0, 300)}`);
          err.status = busy ? 429 : Number(j.error.code) || 500;
          err.fatal = false;
          throw err;
        }
        if (j.usage) {
          this.usage.prompt += j.usage.prompt_tokens || 0;
          this.usage.completion += j.usage.completion_tokens || 0;
          this.usage.total += j.usage.total_tokens || 0;
          if (j.usage.prompt_tokens) { this.lastPrompt = j.usage.prompt_tokens; this.lastPromptCount = sentCount; }
          hooks.onUsage({ ...this.usage, context: this.contextTokens(), window: this.contextWindow() });
        }
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (reasoning) hooks.onReasoning(reasoning);
        if (delta.content) {
          content += delta.content;
          if (content.length > 80 && content.length % 40 < delta.content.length + 1 && garbled(content)) {
            const err = new Error(`${ep.model} gerou texto corrompido (o servidor do provedor parece instável).`);
            err.status = 502; err.garbled = true;
            throw err;
          }
          hooks.onText(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? toolCalls.length;
            if (!toolCalls[i]) toolCalls[i] = { id: tc.id || `call_${Date.now()}_${i}`, type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    // provedores que não informam uso: estimativa pelo tamanho do texto
    const dp = this.usage.prompt - usageBefore.p, dc = this.usage.completion - usageBefore.c;
    if (dp || dc) require('./usage').recordUsage({ model: this.model, cwd: this.cwd, prompt: dp, completion: dc });
    else require('./usage').recordUsage({ model: this.model, cwd: this.cwd, prompt: this.contextTokens(), completion: Math.ceil((content.length + JSON.stringify(toolCalls).length) / 3.6), estimated: true });
    return { content, toolCalls: toolCalls.filter(Boolean) };
  }

  /**
   * Envia uma mensagem do usuário e roda o loop do agente até o modelo parar de chamar ferramentas.
   * hooks (todos opcionais):
   *   onThinking(), onResponseStart(), onReasoning(t), onText(t), onAssistantEnd(),
   *   onToolCall({ id, name, args, label, preview, reason }), onToolResult({ id, name, output, error }),
   *   onCommandOutput(chunk), approve({ id, name, args, label, preview }) => 'yes' | 'all' | 'no' | { deny: motivo },
   *   onPlan({ goal, steps, why }), onUsage({ prompt, completion, total }),
   *   onRetry(msg), onError(msg), onAborted(), onDone(), onModel(model) (modo auto: modelo em uso mudou)
   * reason = texto que o modelo escreveu junto com a chamada (o "porquê" da ação).
   */
  async send(userInput, hooks = {}, { resume = false, attachments = [] } = {}) {
    const h = {
      onThinking: noop, onResponseStart: noop, onReasoning: noop, onText: noop, onAssistantEnd: noop,
      onToolCall: noop, onToolResult: noop, onCommandOutput: noop, onRetry: noop, onError: noop,
      onAborted: noop, onDone: noop, onPlan: noop, onUsage: noop, onScreenshot: noop, onModel: noop, approve: async () => 'yes', ...hooks,
    };
    // todo erro mostrado ao usuário também vai para ~/.rfcode/logs/rfcode.log (diagnóstico)
    const showError = h.onError;
    h.onError = (msg) => { log.error(`agente ${this.model}`, msg); showError(msg); };
    if (this.busy) throw new Error('O agente já está processando uma mensagem.');
    this.hadFailure = false; this.learnNudged = false; this.learnedThisTurn = false; // reinicia a auto-reflexão a cada turno
    if (resume) {
      this.repairHistory();
      this.messages.push({ role: 'user', content: '[A tarefa anterior foi interrompida (o rfcode foi reiniciado). Continue de onde parou: confira o que já foi feito antes de repetir qualquer ação e termine o pedido.]' });
    } else {
      await this.ensureMcp(h);
      this.activateFor(userInput);
      let expandedInput = expandMentions(userInput, this.cwd);
      // modelos menores ignoram "lembre que..."; um lembrete no ponto certo faz eles usarem a memória
      if (MEMORY_HINT.test(userInput) && this.toolDefs.some((t) => t.name === 'remember')) {
        expandedInput += '\n\n[nota do sistema: o usuário pediu para lembrar algo ou contou uma preferência. Guarde com a ferramenta remember (uma frase curta) antes ou depois de responder.]';
      }
      this.messages.push({ role: 'user', content: this.userContent(expandedInput, attachments) });
    }
    // modelo reserva vale só para o pedido em que o principal falhou (troca manual com /model continua valendo)
    if (this.fallbackActive) { this._model = this.primaryModel; this.fallbackActive = false; }
    // modo auto: a cada pedido recomeça pelo melhor candidato (a chave ou o esforço podem ter mudado)
    if (this.auto) this._model = this.autoPick() || this._model;
    let shownModel = this._model;
    const announce = () => { if (this.auto && this._model !== shownModel) { shownModel = this._model; h.onModel(this._model); } };
    if (this.auto) h.onModel(this._model);
    let autoWaits = 0;
    this.primaryModel = this._model;
    this.triedFallback = new Set([this._model]);
    if (this.saveSession) this.sessionManager.save(this.messages, 'running');
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    try {
      let empty = 0;
      for (let step = 0; step < this.maxSteps; step++) {
        if (step > 0) this.takeQueued(h); // mensagens novas do usuário entram antes da próxima chamada
        // modo auto: volta ao melhor candidato assim que a cota dele libera
        if (this.auto && step > 0) {
          const best = this.autoPick({ ready: true });
          if (best && best !== this._model) { this._model = best; announce(); }
        }
        // fim do desvio por limite de pedidos: volta ao modelo principal se a cota dele já liberou
        if (!this.auto && this.hopUntilStep != null && step >= this.hopUntilStep && this.primaryModel && Date.now() >= (this.cooldown[this.primaryModel] || 0)) {
          this._model = this.primaryModel;
          this.fallbackActive = false;
          this.hopUntilStep = null;
        }
        await this.maybeCompact(h); // também no meio de tarefas longas, não só no começo do pedido
        let result;
        let overflowRetried = false;
        for (let attempt = 0; ; attempt++) {
          try {
            h.onThinking();
            result = await this.chat(h, signal);
            break;
          } catch (e) {
            if (signal.aborted || e.name === 'AbortError') { h.onAborted(); return; }
            // a API recusou por excesso de contexto: compacta de forma agressiva e tenta mais uma vez
            if (e.status === 400 && !overflowRetried && /context|too long|too many tokens|maximum.*tokens|token limit|reduce the length/i.test(e.message)) {
              overflowRetried = true;
              const real = ctx.windowFromError(e.message);
              if (real && real < this.contextWindow()) this.learnedWindow = real;
              if (await this.maybeCompact(h, { force: true })) continue;
            }
            // o modelo não aceita imagens: troca as imagens da conversa pelos arquivos salvos e tenta de novo
            if ((e.status === 400 || e.status === 404 || e.status === 422) && !this.imagesStripped
              && /image|vision|multimodal|modality|content part|unsupported|invalid.*content/i.test(e.message)
              && this.stripImages()) {
              h.onRetry(`${this.model} não aceita imagens; enviando os anexos como arquivos de texto/referência.`);
              continue;
            }
            // erro de configuração, chave recusada, modelo aposentado, sem crédito: tentar de novo não resolve
            if (e.fatal || e.status === 401 || e.status === 403) { h.onError(e.message); return; }
            const temporary = e.status === 429 || e.status >= 500 || !e.status || e.garbled;
            // modo auto: limite de pedidos troca na hora; outra falha temporária troca depois de uma nova tentativa.
            // O modelo fica em espera e o melhor candidato livre assume. Todos em espera: aguarda o primeiro liberar.
            if (this.auto && (e.status === 429 || (temporary && attempt >= 1))) {
              const from = this._model;
              this.cooldown[from] = Date.now() + (e.status === 429 ? (e.retryAfter ? e.retryAfter * 1000 : 20000) : 120000);
              let next = this.autoPick({ ready: true });
              if (!next && autoWaits < 6) {
                autoWaits++;
                const first = this.autoPick();
                const wait = Math.min(60000, Math.max(3000, (this.cooldown[first] || 0) - Date.now()));
                h.onRetry(`Todos os modelos do modo auto estão no limite de pedidos; tentando de novo em ${Math.round(wait / 1000)}s...`);
                await new Promise((r) => setTimeout(r, wait));
                if (signal.aborted) { h.onAborted(); return; }
                next = this.autoPick();
              }
              if (next) {
                if (next !== from) h.onRetry(`${e.status === 429 ? 'Limite de pedidos' : 'Falha'} em ${from} (${e.message.slice(0, 90)}); o modo auto seguiu com ${next}.`);
                this._model = next;
                announce();
                attempt = -1;
                continue;
              }
              h.onError(e.message);
              return;
            }
            // limite de pedidos: em vez de esperar parado, segue na hora com um modelo reserva (cota separada)
            // e volta ao principal depois de alguns passos; sem reserva, espera pouco
            // primeiro limite do passo: uma espera curta costuma bastar (rajadas); só desvia se persistir,
            // porque o modelo reserva costuma ser mais fraco e trocar de modelo no meio custa qualidade
            if (e.status === 429 && attempt === 0 && !(e.retryAfter > 5)) {
              h.onRetry(`Limite de pedidos em ${this.model}; tentando de novo em 3s...`);
              await new Promise((r) => setTimeout(r, 3000));
              if (signal.aborted) { h.onAborted(); return; }
              continue;
            }
            if (e.status === 429) {
              this.cooldown[this._model] = Date.now() + (e.retryAfter ? e.retryAfter * 1000 : 20000);
              const hop = this.hopModel();
              if (hop) {
                h.onRetry(`Limite de pedidos em ${this._model} (${e.message.slice(0, 90)}); seguindo com ${hop} por alguns passos.`);
                if (!this.fallbackActive) this.primaryModel = this._model;
                this._model = hop;
                this.fallbackActive = true;
                this.hopUntilStep = step + 3;
                attempt = -1;
                continue;
              }
            }
            const maxAttempts = e.status === 429 ? 4 : 2;
            if (temporary && attempt < maxAttempts) {
              const wait = e.retryAfter ? Math.min(e.retryAfter * 1000, 60000) : e.status === 429 ? [3000, 8000, 15000, 30000][attempt] : 2000 * (attempt + 1);
              h.onRetry(`${e.status === 429 ? 'Limite de pedidos do provedor' : 'Erro'} (${e.message.slice(0, 120)}). Tentando de novo em ${wait / 1000}s...`);
              await new Promise((r) => setTimeout(r, wait));
              if (signal.aborted) { h.onAborted(); return; }
              continue;
            }
            // continua falhando: troca para um modelo reserva em vez de parar a tarefa
            const next = temporary && this.nextFallback();
            if (next) {
              h.onRetry(`${this._model} não está respondendo bem (${e.message.slice(0, 100)}). Continuando com ${next}; o modelo principal volta na próxima mensagem.`);
              this._model = next;
              this.fallbackActive = true;
              attempt = -1;
              continue;
            }
            h.onError(e.message);
            return;
          }
        }

        // resposta vazia (sem texto e sem ferramentas): tenta mais uma vez antes de desistir
        if (!result.content.trim() && !result.toolCalls.length && step > 0 && empty < 1) {
          empty++;
          h.onRetry('O modelo respondeu vazio; pedindo de novo…');
          continue;
        }
        const assistantMsg = { role: 'assistant', content: result.content || '' };
        if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
        this.messages.push(assistantMsg);
        h.onAssistantEnd();
        if (!result.toolCalls.length) {
          // chegaram mensagens enquanto respondia: continua a conversa com elas em vez de parar
          if (this.takeQueued(h)) { if (this.saveSession) this.sessionManager.save(this.messages, 'running'); continue; }
          if (this.saveSession) this.sessionManager.save(this.messages, 'done');
          return;
        }

        // Leituras pedidas juntas rodam em paralelo (vários arquivos, buscas, subagentes de pesquisa).
        // Só o que não pede aprovação e não altera nada; o resto segue em ordem logo abaixo.
        const prefetched = new Map();
        if (result.toolCalls.length > 1) {
          for (const tc of result.toolCalls) {
            const name = tc.function.name;
            if (!PARALLEL_SAFE.has(name)) continue;
            let a; try { a = parseArgs(tc.function.arguments).value; } catch { continue; }
            if (this.approvalNeeded(name, a) || !this.toolDefs.some((t) => t.name === name) || enterprise.loadHooks(this.cwd).preTool.length) continue;
            const mod = MODULE_OF.get(name);
            const run = mod ? () => mod.run(name, a, { cwd: this.cwd, signal, agent: this, hooks: h })
              : name === 'task' ? () => this.task(a, h, signal) : name === 'web_search' ? () => this.web_search(a, null, signal) : () => this[name](a, h.onCommandOutput);
            const p = Promise.resolve().then(run);
            p.catch(() => {});
            prefetched.set(tc.id, p);
          }
        }

        for (const tc of result.toolCalls) {
          const name = tc.function.name;
          let args = {};
          let output, error = false;
          try {
            const parsed = parseArgs(tc.function.arguments);
            args = parsed.value;
            // grava a versão consertada no histórico: a API recusa JSON inválido nas mensagens seguintes
            if (parsed.repaired) tc.function.arguments = JSON.stringify(args);
          } catch {
            output = `Erro: argumentos JSON inválidos (não deu para consertar). Chame a ferramenta de novo com JSON válido. Recebido: ${String(tc.function.arguments).slice(0, 400)}`;
            error = true;
            tc.function.arguments = '{}';
          }
          // depois de um "parar", responde às ferramentas pendentes para manter o histórico válido
          if (signal.aborted && output === undefined) { output = 'Cancelado pelo usuário.'; error = true; }

          if (output === undefined) {
            for (const [g, def] of Object.entries(TOOL_GROUPS)) if (def.tools.includes(name)) this.activeGroups.add(g);
            const forced = mustConfirm(name, args);
            const info = {
              id: tc.id, name, args, label: describeCall(name, args), preview: previewCall(name, args),
              reason: (result.content || '').trim().slice(0, 500), forced,
            };
            h.onToolCall(info);
            let approved = true, denyReason = '';
            const rule = this.approvalNeeded(name, args) ? decide(name, args, loadRules(this.cwd)) : 'ask';
            if (rule === 'deny') { approved = false; denyReason = 'bloqueado por uma regra "deny" em .rfcode/settings.json; não tente contornar'; }
            else if (!(this.planOnly && (blockedInPlan(name, args) || (name.startsWith('mcp__') && this.approvalNeeded(name, args)))) && (forced || (this.approvalNeeded(name, args) && !(this.autoApprove && !(enterprise.loadPolicy() || {}).disableAutoApprove) && rule !== 'allow'))) {
              const d = await h.approve(info);
              if (d === 'all') this.autoApprove = true;
              else if (d !== 'yes') { approved = false; denyReason = (d && d.deny) || ''; }
            }
            if (signal.aborted) { output = 'Cancelado pelo usuário.'; error = true; }
            else if (this.planOnly && (blockedInPlan(name, args) || (name.startsWith('mcp__') && this.approvalNeeded(name, args)))) {
              output = 'Modo plano: nada pode ser alterado ainda. Apenas investigue e proponha o plano com update_plan; o usuário aprova com /go.';
              error = true;
            } else if (!approved) {
              output = `O usuário NEGOU esta ação.${denyReason ? ' Instrução do usuário: ' + denyReason : ''}`;
              error = true;
            } else if (name !== 'load_tools' && !this.toolDefs.some((t) => t.name === name) && !(name.startsWith('mcp__') && this.mcp && this.mcp.find(name))) {
              output = `Erro: ferramenta desconhecida "${name}"`;
              error = true;
            } else {
              try {
                let r;
                const blocked = enterprise.preToolHooks(this.cwd, name, args);
                if (blocked) throw new Error(`Bloqueado por um hook: ${blocked.block}`);
                if (prefetched.has(tc.id)) r = await prefetched.get(tc.id);
                else if (name.startsWith('mcp__') && this.mcp && this.mcp.find(name)) r = await this.mcp.call(name, args, signal);
                else if (MODULE_OF.has(name)) r = await MODULE_OF.get(name).run(name, args, { cwd: this.cwd, signal, agent: this, hooks: h });
                else if (PC_TOOLS.has(name)) r = await runPcTool(name, args, signal);
                else if (GIT_TOOLS.has(name)) r = runGitTool(name, args, this.cwd);
                else if (name === 'update_plan') r = this.update_plan(args, h);
                else if (name === 'load_tools') r = this.load_tools(args);
                else if (name === 'browser') r = await getBrowser().run(args, signal);
                else if (OFFICE_TOOLS.has(name)) r = runOfficeTool(name, args, this.cwd);
                else if (name === 'create_video') r = await this.create_video(args, h, signal);
                else if (name === 'task' || name === 'ask_user') r = await this[name](args, h, signal);
                else if (name === 'web_search') r = await this.web_search(args, null, signal);
                else if (this.extraTools && this.extraTools.defs.some((t) => t.name === name)) r = await this.extraTools.run(name, args);
                else r = await this[name](args, h.onCommandOutput);
                output = truncate(String(r));
                if (CHANGES_FILES.has(name) && args.path) {
                  (this.touched ||= new Set()).add(String(args.path));
                  const hookOut = enterprise.postEditHooks(this.cwd, name, String(args.path));
                  if (hookOut) output += `\n${hookOut}`;
                }
              } catch (e) {
                output = `Erro: ${e.message}`;
                error = true;
              }
            }
            h.onToolResult({ id: tc.id, name, output, error });
            // screenshot: mostra a imagem na conversa para o usuário acompanhar
            if (name === 'screenshot' && !error) {
              const m = /salva em (\S+\.png)/i.exec(output);
              if (m) h.onScreenshot(m[1]);
            }
            enterprise.audit({ cwd: this.cwd, model: this.model, tool: name, action: describeCall(name, args), approved: !/^O usuário NEGOU/.test(output), error: !!error, result: String(output).slice(0, 200) });
          }
          output = this.planNudge(name, output);
          output = this.repeatGuard(name, args, output);
          output = this.reflectNudge(name, output, error);
          this.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: output });
        }
        // grava a cada passo: se o VS Code recarregar no meio, dá para retomar daqui
        if (this.saveSession) this.sessionManager.save(this.messages, 'running');
        if (signal.aborted) { h.onAborted(); return; }
        if (this.stuck) {
          const tool = this.stuck;
          this.stuck = null;
          this.recentCalls = [];
          if (this.saveSession) this.sessionManager.save(this.messages);
          h.onError(`Parei: o modelo repetiu a mesma ação (${tool}) ${STUCK_REPEATS} vezes sem avançar. Diga como seguir ou troque de modelo e peça para continuar.`);
          return;
        }
      }
      h.onError(`Limite de ${this.maxSteps} passos atingido.`);
    } finally {
      this.controller = null;
      try { enterprise.onDoneHooks(this.cwd, { model: this.model, tokens: this.usage && this.usage.total, aborted: !!(this.controller && this.controller.signal.aborted) }); } catch { /* hook nunca derruba */ }
      h.onDone();
    }
  }
}

module.exports = {
  Agent, TOOL_DEFS, globToRegex, BASE_URL, CONFIG_FILE, DEFAULT_MODEL, SUGGESTED_MODELS,
  loadConfig, saveConfig, validateKey, describeCall, previewCall, compactHistory, systemPrompt,
};
