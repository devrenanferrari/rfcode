'use strict';
// Ferramentas git do rfcode. Rodam o git sem shell (execFileSync) no diretório do agente.

const { execFileSync } = require('child_process');

const MAX_DIFF = 20000;

const GIT_TOOL_DEFS = [
  {
    name: 'git_status',
    description: 'Mostra o estado do repositório git: branch atual e arquivos modificados, novos ou removidos.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Mostra o diff das alterações ainda não commitadas (ou das que estão no stage, com staged=true). Pode limitar a um arquivo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Arquivo ou pasta (opcional)' },
        staged: { type: 'boolean', description: 'Diff do stage (git diff --cached)' },
      },
    },
  },
  {
    name: 'git_log',
    description: 'Lista os últimos commits (hash curto, data relativa, autor e mensagem).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Quantidade de commits (padrão 15)' },
        path: { type: 'string', description: 'Só commits que mexeram neste arquivo (opcional)' },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Adiciona arquivos ao stage e cria um commit. Sem "files", adiciona todas as alterações (git add -A). Use mensagens claras no imperativo.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Mensagem do commit' },
        files: { type: 'array', items: { type: 'string' }, description: 'Arquivos a incluir (opcional)' },
      },
      required: ['message'],
    },
  },
];

const GIT_TOOLS = new Set(GIT_TOOL_DEFS.map((t) => t.name));

function git(cwd, args) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024, windowsHide: true,
    });
  } catch (e) {
    // conflitos de merge saem no stdout, não no stderr
    const msg = [e.stderr, e.stdout].filter(Boolean).join('\n').trim() || String(e.message || '');
    if (/not a git repository|não é um repositório/i.test(msg)) throw new Error('Esta pasta não é um repositório git (use run_command "git init" se quiser criar um).');
    if (e.code === 'ENOENT') throw new Error('git não está instalado ou não está no PATH.');
    throw new Error(msg.trim().split('\n').slice(0, 6).join('\n') || 'git falhou');
  }
}

function gitStatus(cwd) {
  const out = git(cwd, ['status', '--short', '--branch']).trimEnd();
  const lines = out.split('\n');
  return lines.length <= 1 ? `${out}\n(nada a commitar, árvore limpa)` : out;
}

function gitDiff(cwd, { path: p, staged } = {}) {
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  if (p) args.push('--', p);
  let out = git(cwd, args);
  if (!out.trim()) {
    // arquivos novos não aparecem no diff; avisa para não parecer que não há mudanças
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', ...(p ? ['--', p] : [])]).trim();
    return untracked ? `(sem diff em arquivos versionados)\nArquivos novos não versionados:\n${untracked}` : '(sem alterações)';
  }
  if (out.length > MAX_DIFF) out = out.slice(0, MAX_DIFF) + `\n... [diff truncado, ${out.length - MAX_DIFF} caracteres omitidos]`;
  return out;
}

function gitLog(cwd, { limit, path: p } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 100);
  const args = ['log', `-n${n}`, '--pretty=format:%h %ad %an: %s', '--date=relative'];
  if (p) args.push('--', p);
  try {
    return git(cwd, args).trim() || '(sem commits)';
  } catch (e) {
    if (/does not have any commits|não tem nenhum commit/i.test(e.message)) return '(repositório sem commits)';
    throw e;
  }
}

function gitCommit(cwd, { message, files } = {}) {
  if (!message || !String(message).trim()) throw new Error('A mensagem do commit não pode ser vazia.');
  if (Array.isArray(files) && files.length) git(cwd, ['add', '--', ...files]);
  else git(cwd, ['add', '-A']);
  const staged = git(cwd, ['diff', '--cached', '--name-only']).trim();
  if (!staged) return 'Nada para commitar.';
  git(cwd, ['commit', '-q', '-m', String(message)]);
  const head = git(cwd, ['log', '-1', '--pretty=format:%h %s']).trim();
  return `Commit criado: ${head}\nArquivos: ${staged.split('\n').join(', ')}`;
}

function runGitTool(name, args, cwd) {
  switch (name) {
    case 'git_status': return gitStatus(cwd);
    case 'git_diff': return gitDiff(cwd, args);
    case 'git_log': return gitLog(cwd, args);
    case 'git_commit': return gitCommit(cwd, args);
    default: throw new Error(`ferramenta git desconhecida: ${name}`);
  }
}

function gitDescribe(name, a) {
  switch (name) {
    case 'git_status': return 'Git(status)';
    case 'git_diff': return `Git(diff${a.staged ? ' --staged' : ''}${a.path ? ' ' + a.path : ''})`;
    case 'git_log': return `Git(log${a.path ? ' ' + a.path : ''})`;
    case 'git_commit': return `Git(commit "${String(a.message || '').split('\n')[0].slice(0, 60)}")`;
    default: return null;
  }
}

module.exports = { GIT_TOOL_DEFS, GIT_TOOLS, runGitTool, gitDescribe, gitStatus, gitDiff, gitLog, gitCommit, git };
