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
const { COMPACT_PROMPT } = require('./commands');
const { webSearch, formatResults, SEARCH_TOOL_DEF } = require('./websearch');
const { readUserMemory, remember, forget, MEMORY_TOOL_DEF } = require('./memory');
const { loadRules, decide } = require('./permissions');

const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const CONFIG_DIR = process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const SUGGESTED_MODELS = [
  ['nvidia/nemotron-3-super-120b-a12b', 'rápido, bom com ferramentas (padrão)'],
  ['z-ai/glm-5.3', 'mais forte em código, mais lento'],
  ['openai/gpt-oss-20b', 'muito rápido, mais simples'],
  ['nvidia/nemotron-3-ultra-550b-a55b', 'grande, lento'],
];
const MAX_OUTPUT = 20000;
const MAX_STEPS = 100;
const AUTO_COMPACT_CHARS = 160000;
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

// Retorna 'ok', 'invalid' ou 'offline'. O endpoint /models não exige chave, então testa com uma chamada real.
async function validateKey(key) {
  try {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-20b', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30000),
    });
    return r.status === 401 || r.status === 403 ? 'invalid' : 'ok';
  } catch {
    return 'offline';
  }
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
TOOL_DEFS.push(...BG_TOOL_DEFS, ...GIT_TOOL_DEFS, PLAN_TOOL_DEF, TASK_TOOL_DEF, ASK_TOOL_DEF, MEMORY_TOOL_DEF,
  ...OFFICE_TOOL_DEFS, VIDEO_TOOL_DEF, BROWSER_TOOL_DEF, ...PC_TOOL_DEFS);

// Ferramentas do subagente: só leitura (o resultado volta como texto para o agente principal).
const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'read_document', 'web_search', 'web_fetch'];

const ASSISTANT_PROMPT = `
# Pesquisa, memória e tarefas grandes
- Não sabe algo com certeza, ou é coisa que muda (preços, versões, notícias, vagas, documentação)? Pesquise com web_search antes de responder e cite as fontes (endereços).
- Pesquisas com várias fontes ou perguntas amplas sobre o código: use task (subagente) e trabalhe a partir do relatório.
- Falta um dado que só o usuário tem, ou a escolha é dele? Use ask_user com opções, em vez de chutar.
- O usuário contou uma preferência ou algo sobre si que vale para o futuro? Guarde com remember (uma frase).
- Servidores e processos longos: run_command com background: true, depois command_output para acompanhar.`;

const FILES_PROMPT = `
# Arquivos, documentos e mídia
- PDF, Word, PowerPoint e Excel: leia com read_document (read_file é só para texto).
- Várias mudanças no mesmo arquivo: use multi_edit (tudo ou nada) em vez de vários edit_file.
- Operações em massa (renomear, mover, organizar pastas): primeiro liste e diga o que vai mudar; depois use run_command. Nunca apague nada sem pedido explícito.
- Planilhas: gere .csv com write_file usando ; como separador (o rfcode já grava com BOM para o Excel ler os acentos).
- Apresentações (create_pptx): planeje a história antes (capa → contexto → seções → números ou exemplos → conclusão → encerramento), de 6 a 12 slides. Títulos com até ~8 palavras, 3 a 6 tópicos curtos por slide e conteúdo real e específico (nunca "Tópico 1" ou texto de enchimento). Varie os tipos de slide. Depois confira com read_document.
- Documentos (create_docx): markdown bem estruturado, com títulos, listas e tabelas quando ajudarem.
- Vídeos (create_video): roteiro com capa, 3 a 6 cenas de conteúdo e encerramento. Cada cena de conteúdo tem 2 a 4 bullets e, quando combinar, um emoji. A narração é falada em voz alta: 2 a 3 frases naturais por cena, sem markdown, siglas difíceis ou URLs, e a soma das falas deve bater com a duração pedida (~2,5 palavras por segundo). Os bullets resumem a fala, não a repetem palavra por palavra.
- Ao terminar, informe o caminho do arquivo criado.`;

// web_fetch pede aprovação: uma URL pode carregar dados para fora (ex.: segredo na query string)
const NEEDS_APPROVAL = new Set(['write_file', 'edit_file', 'multi_edit', 'run_command', 'git_commit', 'web_fetch', 'create_pptx', 'create_docx', 'create_video']);
const needsApproval = (name, args) => NEEDS_APPROVAL.has(name)
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
    case 'command_output': return `Saída(${args.id})`;
    case 'command_stop': return `Parar(${args.id})`;
    case 'browser': return browserDescribe(args);
    case 'update_plan': {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const done = steps.filter((s) => s.status === 'done').length;
      return `Plano(${done}/${steps.length})`;
    }
    default: return gitDescribe(name, args) || officeDescribe(name, args) || pcDescribe(name, args) || `${name}(${JSON.stringify(args)})`;
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

function systemPrompt(cwd, { pc = IS_WIN, browser = false, assistant = true, extra: more = '' } = {}) {
  let extra = '';
  const mem = assistant ? readUserMemory() : '';
  if (mem) extra += `\n\n# Memória sobre o usuário (~/.rfcode/MEMORIA.md)\nUse isto para personalizar o trabalho; não repita de volta sem motivo.\n${mem}`;
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
  constructor({ apiKey, model, cwd, tools, systemExtra, maxSteps, planReminderEvery = 8, saveSession = false, extraTools = null }) {
    this.extraTools = extraTools;
    this.bg = new Map(); // comandos em segundo plano: id -> { child, out, read, done, code, command }
    this.bgSeq = 0;
    this.planReminderEvery = planReminderEvery;
    this.sincePlan = 0;
    this.readCache = new Map(); // "arquivo|início|fim" -> { hash, count }
    this.recentCalls = [];      // assinaturas das últimas ações, para detectar repetição
    const available = [...(IS_WIN ? TOOL_DEFS : TOOL_DEFS.filter((t) => !PC_TOOLS.has(t.name))), ...((extraTools && extraTools.defs) || [])];
    this.toolDefs = tools ? available.filter((t) => tools.includes(t.name)) : available;
    this.planOnly = false; // modo plano: só investiga e propõe, nada que altere algo
    this.systemExtra = systemExtra || '';
    this.maxSteps = maxSteps || MAX_STEPS;
    this.plan = null; // { goal, steps: [{ text, status }], why }
    this.usage = { prompt: 0, completion: 0, total: 0 };
    this.apiKey = apiKey;
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

  clear() { this.messages = []; this.plan = null; this.sincePlan = 0; this.readCache.clear(); this.recentCalls = []; this.stopBackground(); }

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
    if (name === 'update_plan') return output;
    // ler/rolar/esperar de novo é normal no navegador (a página muda entre uma chamada e outra)
    if (name === 'browser' && ['read', 'scroll', 'wait', 'key', 'back', 'tabs'].includes(args && args.action)) return output;
    const sig = name + ':' + JSON.stringify(args);
    const times = this.recentCalls.filter((s) => s === sig).length;
    this.recentCalls.push(sig);
    if (this.recentCalls.length > 10) this.recentCalls.shift();
    if (times >= 2) {
      return `${output}\n\n[alerta do sistema: você já fez exatamente esta ação ${times + 1} vezes. Repetir não vai dar um resultado diferente. `
        + 'Mude de abordagem: use outra ferramenta, outro argumento, ou explique o bloqueio e siga em frente.]';
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
  async compact() {
    if (this.busy) throw new Error('Espere a resposta atual terminar.');
    if (this.messages.length < 4) return null;
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model, temperature: 0.2, max_tokens: 2000,
        messages: [...compactHistory(this.messages), { role: 'user', content: COMPACT_PROMPT }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const j = await res.json();
    const summary = String(j.choices?.[0]?.message?.content || '').trim();
    if (!summary) throw new Error('O modelo não devolveu um resumo.');
    this.messages = [
      { role: 'user', content: 'Resumo da conversa anterior:\n' + summary },
      { role: 'assistant', content: 'Entendido. Vou continuar a partir desse resumo.' },
    ];
    this.readCache.clear();
    this.recentCalls = [];
    return summary;
  }

  abort() {
    if (this.controller) this.controller.abort();
    killTree(this.child);
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
            `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], { cwd: this.cwd, windowsHide: true, env: dedupeEnv(process.env) })
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
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`],
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
    if (!b.done) killTree(b.child, { sync: true });
    return `Parado: ${id} (${b.command})`;
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
      apiKey: this.apiKey, model: this.model, cwd: this.cwd, tools: SUBAGENT_TOOLS, maxSteps: 25, planReminderEvery: 0,
      systemExtra: 'Você é um SUBAGENTE de pesquisa. Investigue o pedido usando só leitura (arquivos, git, documentos, internet) e termine com um '
        + 'relatório objetivo e completo para o agente principal: conclusões, evidências (caminhos de arquivo com linha, ou endereços das fontes) e o que ficou incerto. Não peça nada ao usuário.',
    });
    child.autoApprove = true;
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
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt(this.cwd, {
          pc: IS_WIN && this.toolDefs.some((t) => PC_TOOLS.has(t.name)),
          browser: this.toolDefs.some((t) => t.name === 'browser'),
          assistant: this.toolDefs.some((t) => t.name === 'ask_user'),
          extra: this.systemExtra,
        }) }, ...compactHistory(this.messages)],
        tools: this.toolDefs.map((t) => ({ type: 'function', function: t })),
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
      err.status = res.status;
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
        if (j.usage) {
          this.usage.prompt += j.usage.prompt_tokens || 0;
          this.usage.completion += j.usage.completion_tokens || 0;
          this.usage.total += j.usage.total_tokens || 0;
          hooks.onUsage({ ...this.usage });
        }
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (reasoning) hooks.onReasoning(reasoning);
        if (delta.content) { content += delta.content; hooks.onText(delta.content); }
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
    return { content, toolCalls: toolCalls.filter(Boolean) };
  }

  /**
   * Envia uma mensagem do usuário e roda o loop do agente até o modelo parar de chamar ferramentas.
   * hooks (todos opcionais):
   *   onThinking(), onResponseStart(), onReasoning(t), onText(t), onAssistantEnd(),
   *   onToolCall({ id, name, args, label, preview, reason }), onToolResult({ id, name, output, error }),
   *   onCommandOutput(chunk), approve({ id, name, args, label, preview }) => 'yes' | 'all' | 'no' | { deny: motivo },
   *   onPlan({ goal, steps, why }), onUsage({ prompt, completion, total }),
   *   onRetry(msg), onError(msg), onAborted(), onDone()
   * reason = texto que o modelo escreveu junto com a chamada (o "porquê" da ação).
   */
  async send(userInput, hooks = {}) {
    const h = {
      onThinking: noop, onResponseStart: noop, onReasoning: noop, onText: noop, onAssistantEnd: noop,
      onToolCall: noop, onToolResult: noop, onCommandOutput: noop, onRetry: noop, onError: noop,
      onAborted: noop, onDone: noop, onPlan: noop, onUsage: noop, approve: async () => 'yes', ...hooks,
    };
    if (this.busy) throw new Error('O agente já está processando uma mensagem.');
    // conversa muito longa: resume antes de continuar (modelos menores se perdem com contexto enorme)
    if (this.messages.length > 8 && JSON.stringify(this.messages).length > AUTO_COMPACT_CHARS) {
      try {
        h.onRetry('A conversa ficou longa; resumindo para liberar contexto…');
        await this.compact();
        if (this.saveSession) this.sessionManager.save(this.messages);
      } catch (e) { h.onRetry('Não consegui resumir a conversa (' + e.message.slice(0, 80) + '); seguindo assim mesmo.'); }
    }
    let expandedInput = expandMentions(userInput, this.cwd);
    // modelos menores ignoram "lembre que..."; um lembrete no ponto certo faz eles usarem a memória
    if (MEMORY_HINT.test(userInput) && this.toolDefs.some((t) => t.name === 'remember')) {
      expandedInput += '\n\n[nota do sistema: o usuário pediu para lembrar algo ou contou uma preferência. Guarde com a ferramenta remember (uma frase curta) antes ou depois de responder.]';
    }
    this.messages.push({ role: 'user', content: expandedInput });
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    try {
      let empty = 0;
      for (let step = 0; step < this.maxSteps; step++) {
        let result;
        for (let attempt = 0; ; attempt++) {
          try {
            h.onThinking();
            result = await this.chat(h, signal);
            break;
          } catch (e) {
            if (signal.aborted || e.name === 'AbortError') { h.onAborted(); return; }
            if (e.status === 401 || e.status === 403) {
              h.onError(`Chave inválida ou sem acesso ao modelo ${this.model} (${e.status}). Troque a chave ou o modelo.\n${e.message}`);
              return;
            }
            if ((e.status === 429 || e.status >= 500 || !e.status) && attempt < 3) {
              const wait = 2000 * (attempt + 1);
              h.onRetry(`Erro (${e.message.slice(0, 120)}). Tentando de novo em ${wait / 1000}s...`);
              await new Promise((r) => setTimeout(r, wait));
              if (signal.aborted) { h.onAborted(); return; }
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
          // salva a conversa após cada resposta completa (só quando ativado, ex.: na CLI)
          if (this.saveSession) this.sessionManager.save(this.messages);
          return;
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
            const forced = mustConfirm(name, args);
            const info = {
              id: tc.id, name, args, label: describeCall(name, args), preview: previewCall(name, args),
              reason: (result.content || '').trim().slice(0, 500), forced,
            };
            h.onToolCall(info);
            let approved = true, denyReason = '';
            const rule = needsApproval(name, args) ? decide(name, args, loadRules(this.cwd)) : 'ask';
            if (rule === 'deny') { approved = false; denyReason = 'bloqueado por uma regra "deny" em .rfcode/settings.json; não tente contornar'; }
            else if (!(this.planOnly && blockedInPlan(name, args)) && (forced || (needsApproval(name, args) && !this.autoApprove && rule !== 'allow'))) {
              const d = await h.approve(info);
              if (d === 'all') this.autoApprove = true;
              else if (d !== 'yes') { approved = false; denyReason = (d && d.deny) || ''; }
            }
            if (signal.aborted) { output = 'Cancelado pelo usuário.'; error = true; }
            else if (this.planOnly && blockedInPlan(name, args)) {
              output = 'Modo plano: nada pode ser alterado ainda. Apenas investigue e proponha o plano com update_plan; o usuário aprova com /go.';
              error = true;
            } else if (!approved) {
              output = `O usuário NEGOU esta ação.${denyReason ? ' Instrução do usuário: ' + denyReason : ''}`;
              error = true;
            } else if (!this.toolDefs.some((t) => t.name === name)) {
              output = `Erro: ferramenta desconhecida "${name}"`;
              error = true;
            } else {
              try {
                let r;
                if (PC_TOOLS.has(name)) r = await runPcTool(name, args, signal);
                else if (GIT_TOOLS.has(name)) r = runGitTool(name, args, this.cwd);
                else if (name === 'update_plan') r = this.update_plan(args, h);
                else if (name === 'browser') r = await getBrowser().run(args, signal);
                else if (OFFICE_TOOLS.has(name)) r = runOfficeTool(name, args, this.cwd);
                else if (name === 'create_video') r = await this.create_video(args, h, signal);
                else if (name === 'task' || name === 'ask_user') r = await this[name](args, h, signal);
                else if (name === 'web_search') r = await this.web_search(args, null, signal);
                else if (this.extraTools && this.extraTools.defs.some((t) => t.name === name)) r = await this.extraTools.run(name, args);
                else r = await this[name](args, h.onCommandOutput);
                output = truncate(String(r));
              } catch (e) {
                output = `Erro: ${e.message}`;
                error = true;
              }
            }
            h.onToolResult({ id: tc.id, name, output, error });
          }
          output = this.planNudge(name, output);
          output = this.repeatGuard(name, args, output);
          this.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: output });
        }
        if (signal.aborted) { h.onAborted(); return; }
      }
      h.onError(`Limite de ${this.maxSteps} passos atingido.`);
    } finally {
      this.controller = null;
      h.onDone();
    }
  }
}

module.exports = {
  Agent, TOOL_DEFS, globToRegex, BASE_URL, CONFIG_FILE, DEFAULT_MODEL, SUGGESTED_MODELS,
  loadConfig, saveConfig, validateKey, describeCall, previewCall, compactHistory, systemPrompt,
};
