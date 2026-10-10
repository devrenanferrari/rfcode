'use strict';
// Núcleo do rfcode: ferramentas, chamada à API da NVIDIA e loop do agente.
// Usado tanto pela CLI (bin/rfcode.js) quanto pela extensão do VS Code (extension/extension.js).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { PC_TOOL_DEFS, PC_TOOLS, PC_PROMPT, pcNeedsApproval, pcDescribe, runPcTool, dedupeEnv } = require('./pc');
const { GIT_TOOL_DEFS, GIT_TOOLS, runGitTool, gitDescribe } = require('./git');
const { WORK_STYLE } = require('./prompts');
const { CheckpointManager } = require('./checkpoints');
const { expandMentions } = require('./mentions');

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
const MAX_STEPS = 50;
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
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
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

TOOL_DEFS.push(...GIT_TOOL_DEFS, PLAN_TOOL_DEF, ...PC_TOOL_DEFS);

const NEEDS_APPROVAL = new Set(['write_file', 'edit_file', 'run_command', 'git_commit']);
const needsApproval = (name, args) => NEEDS_APPROVAL.has(name) || (PC_TOOLS.has(name) && pcNeedsApproval(name, args));

function describeCall(name, args) {
  switch (name) {
    case 'read_file': return `Read(${args.path})`;
    case 'write_file': return `Write(${args.path})`;
    case 'edit_file': return `Edit(${args.path})`;
    case 'list_dir': return `List(${args.path || '.'})`;
    case 'glob': return `Glob(${args.pattern})`;
    case 'grep': return `Grep(${args.pattern})`;
    case 'run_command': return `Run(${args.command})`;
    case 'update_plan': {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const done = steps.filter((s) => s.status === 'done').length;
      return `Plano(${done}/${steps.length})`;
    }
    default: return gitDescribe(name, args) || pcDescribe(name, args) || `${name}(${JSON.stringify(args)})`;
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
  return null;
}

function systemPrompt(cwd, { pc = IS_WIN, extra: more = '' } = {}) {
  let extra = '';
  for (const f of ['RFCODE.md', 'CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(cwd, f);
    if (fs.existsSync(p)) {
      extra += `\n\n# Instruções do projeto (${f})\n` + truncate(fs.readFileSync(p, 'utf8'));
      break;
    }
  }
  return `Você é o rfcode, um agente de engenharia de software que trabalha no computador do usuário (no estilo do Claude Code).
Você lê, entende, cria e modifica código, usa git, roda comandos e testes, e verifica o próprio trabalho.

Ambiente:
- Diretório de trabalho: ${cwd}
- Sistema: ${process.platform} (${os.release()})
- Shell do run_command: ${IS_WIN ? 'PowerShell' : 'bash'}
- Data: ${new Date().toISOString().slice(0, 10)}

${WORK_STYLE}
${pc ? PC_PROMPT : ''}${extra}${more ? '\n\n' + more : ''}`;
}

// ---------- agente ----------
const noop = () => {};

class Agent {
  /**
   * tools: lista de nomes de ferramentas permitidas (padrão: todas).
   * systemExtra: texto adicional no prompt do sistema.
   */
  constructor({ apiKey, model, cwd, tools, systemExtra, maxSteps }) {
    this.toolDefs = tools ? TOOL_DEFS.filter((t) => tools.includes(t.name)) : TOOL_DEFS;
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
  }

  get busy() { return !!this.controller; }

  clear() { this.messages = []; this.plan = null; }

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
    const lines = fs.readFileSync(this.resolve(p), 'utf8').split(/\r?\n/);
    const start = Math.max(1, offset || 1);
    const end = limit ? Math.min(lines.length, start + limit - 1) : Math.min(lines.length, start + 1999);
    const out = [];
    for (let i = start; i <= end; i++) out.push(`${String(i).padStart(5)}\t${lines[i - 1]}`);
    if (end < lines.length) out.push(`... (${lines.length - end} linhas restantes; use offset)`);
    return out.join('\n') || '(arquivo vazio)';
  }

  write_file({ path: p, content }) {
    const full = this.resolve(p);
    this.checkpoints.saveCheckpoint(full);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content ?? '', 'utf8');
    return `Arquivo escrito: ${this.rel(full)} (${String(content ?? '').split('\n').length} linhas)`;
  }

  edit_file({ path: p, old_string, new_string, replace_all }) {
    if (!old_string) throw new Error('old_string vazio. Para criar um arquivo use write_file.');
    const full = this.resolve(p);
    this.checkpoints.saveCheckpoint(full);
    let src = fs.readFileSync(full, 'utf8');
    let oldS = old_string, newS = new_string ?? '';
    // tolera diferença de quebra de linha CRLF/LF
    if (src.includes('\r\n') && !oldS.includes('\r\n')) {
      oldS = oldS.replace(/\n/g, '\r\n');
      newS = newS.replace(/\n/g, '\r\n');
    }
    const count = src.split(oldS).length - 1;
    if (count === 0) throw new Error('old_string não encontrado no arquivo. Leia o arquivo e copie o trecho exato.');
    if (count > 1 && !replace_all) throw new Error(`old_string aparece ${count} vezes. Inclua mais contexto ou use replace_all.`);
    src = replace_all ? src.split(oldS).join(newS) : src.replace(oldS, () => newS);
    fs.writeFileSync(full, src, 'utf8');
    return `Arquivo editado: ${this.rel(full)} (${replace_all ? count : 1} substituição(ões))`;
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

  run_command({ command, timeout_ms }, onOutput) {
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
        
        // Replace basic HTML entities
        text = text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ');
        
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
        messages: [{ role: 'system', content: systemPrompt(this.cwd, { pc: IS_WIN && this.toolDefs.some((t) => PC_TOOLS.has(t.name)), extra: this.systemExtra }) }, ...this.messages],
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
    const expandedInput = expandMentions(userInput, this.cwd);
    this.messages.push({ role: 'user', content: expandedInput });
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    try {
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

        const assistantMsg = { role: 'assistant', content: result.content || '' };
        if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
        this.messages.push(assistantMsg);
        h.onAssistantEnd();
        if (!result.toolCalls.length) return;

        for (const tc of result.toolCalls) {
          const name = tc.function.name;
          let args = {};
          let output, error = false;
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            output = `Erro: argumentos JSON inválidos: ${tc.function.arguments}`;
            error = true;
          }
          // depois de um "parar", responde às ferramentas pendentes para manter o histórico válido
          if (signal.aborted && output === undefined) { output = 'Cancelado pelo usuário.'; error = true; }

          if (output === undefined) {
            const info = {
              id: tc.id, name, args, label: describeCall(name, args), preview: previewCall(name, args),
              reason: (result.content || '').trim().slice(0, 500),
            };
            h.onToolCall(info);
            let approved = true, denyReason = '';
            if (needsApproval(name, args) && !this.autoApprove) {
              const d = await h.approve(info);
              if (d === 'all') this.autoApprove = true;
              else if (d !== 'yes') { approved = false; denyReason = (d && d.deny) || ''; }
            }
            if (signal.aborted) { output = 'Cancelado pelo usuário.'; error = true; }
            else if (!approved) {
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
                else r = await this[name](args, h.onCommandOutput);
                output = truncate(String(r));
              } catch (e) {
                output = `Erro: ${e.message}`;
                error = true;
              }
            }
            h.onToolResult({ id: tc.id, name, output, error });
          }
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
  loadConfig, saveConfig, validateKey, describeCall, previewCall,
};
