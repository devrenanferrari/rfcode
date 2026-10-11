'use strict';
// Git completo e GitHub: branches, sincronização, stash, histórico, conflitos e pull requests/issues (via GitHub CLI).
// Leitura roda direto; tudo que altera o repositório ou o GitHub pede aprovação.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { git } = require('../git');

const MAX = 20000;
const cut = (s) => (s.length > MAX ? `${s.slice(0, MAX)}\n... [truncado, ${s.length - MAX} caracteres omitidos]` : s);
const safeName = (n) => {
  const s = String(n || '').trim();
  if (!s || /^-|\.\.|[\s~^:?*[\\]|@\{/.test(s)) throw new Error(`Nome inválido: "${s}"`);
  return s;
};

function gh(cwd, args, input) {
  try {
    return execFileSync(process.env.RFCODE_GH || 'gh', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('GitHub CLI (gh) não encontrado. Instale em https://cli.github.com e rode "gh auth login".');
    const msg = String(e.stderr || e.message || '').trim();
    if (/auth login|not logged/i.test(msg)) throw new Error('GitHub CLI sem login: rode "gh auth login" no terminal.');
    throw new Error(msg.split('\n').slice(0, 8).join('\n') || 'gh falhou');
  }
}

function branch(cwd, { action = 'list', name, from, new_name: newName } = {}) {
  switch (action) {
    case 'list': {
      const cur = git(cwd, ['branch', '--show-current']).trim();
      const local = git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(committerdate:relative)|%(upstream:short)|%(upstream:track)', 'refs/heads']).trim();
      return `Branch atual: ${cur || '(HEAD destacado)'}\n` + local.split('\n').filter(Boolean).map((l) => {
        const [n, when, up, track] = l.split('|');
        return `${n === cur ? '* ' : '  '}${n}  (${when}${up ? `, segue ${up}${track ? ' ' + track : ''}` : ''})`;
      }).join('\n');
    }
    case 'create': git(cwd, ['switch', '-c', safeName(name), ...(from ? [safeName(from)] : [])]); return `Branch ${name} criada e ativa.`;
    case 'switch': git(cwd, ['switch', safeName(name)]); return `Agora em ${name}.`;
    case 'delete': git(cwd, ['branch', '-d', safeName(name)]); return `Branch ${name} apagada (só apaga se já estiver mesclada).`;
    case 'rename': git(cwd, ['branch', '-m', safeName(name), safeName(newName)]); return `Branch ${name} renomeada para ${newName}.`;
    default: throw new Error('action: list, create, switch, delete ou rename');
  }
}

function sync(cwd, { action, remote = 'origin', branch: br, set_upstream: setUp } = {}) {
  const cur = git(cwd, ['branch', '--show-current']).trim();
  const b = br ? safeName(br) : cur;
  switch (action) {
    case 'fetch': git(cwd, ['fetch', '--prune', safeName(remote)]); return `Atualizado de ${remote}.\n${git(cwd, ['status', '-sb']).split('\n')[0]}`;
    case 'pull': return git(cwd, ['pull', '--ff-only', safeName(remote), b]).trim() || 'Já estava atualizado.';
    case 'push': {
      // force push nunca: reescrever histórico remoto é decisão do usuário, no terminal
      const out = execFileSafe(cwd, ['push', ...(setUp || !hasUpstream(cwd) ? ['-u'] : []), safeName(remote), b]);
      return `Enviado para ${remote}/${b}.\n${out.trim()}`;
    }
    default: throw new Error('action: fetch, pull ou push');
  }
}
const hasUpstream = (cwd) => { try { git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']); return true; } catch { return false; } };
// git push escreve o resultado no stderr; git() já devolve o stdout
function execFileSafe(cwd, args) {
  try {
    const r = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return r;
  } catch (e) {
    throw new Error(String(e.stderr || e.message).trim().split('\n').slice(0, 8).join('\n'));
  }
}

function stash(cwd, { action = 'list', message, index = 0 } = {}) {
  const ref = `stash@{${parseInt(index, 10) || 0}}`;
  switch (action) {
    case 'list': return git(cwd, ['stash', 'list']).trim() || '(nenhum stash)';
    case 'push': return git(cwd, ['stash', 'push', '-u', ...(message ? ['-m', String(message)] : [])]).trim();
    case 'pop': return git(cwd, ['stash', 'pop', ref]).trim();
    case 'apply': return git(cwd, ['stash', 'apply', ref]).trim();
    case 'drop': return git(cwd, ['stash', 'drop', ref]).trim();
    case 'show': return cut(git(cwd, ['stash', 'show', '-p', ref]));
    default: throw new Error('action: list, push, pop, apply, drop ou show');
  }
}

function show(cwd, { ref = 'HEAD', path: p, stat } = {}) {
  const r = String(ref).replace(/^-+/, '');
  return cut(git(cwd, ['show', '--no-color', '--pretty=format:%H%nAutor: %an <%ae>%nData: %ad%n%n%B', ...(stat ? ['--stat'] : []), r, ...(p ? ['--', p] : [])]));
}

function blame(cwd, { path: p, start, end } = {}) {
  if (!p) throw new Error('Informe path.');
  const range = start ? ['-L', `${parseInt(start, 10)},${parseInt(end || start, 10) || parseInt(start, 10) + 40}`] : [];
  const out = git(cwd, ['blame', '--date=short', ...range, '--', p]);
  return cut(out.split('\n').map((l) => l.replace(/^(\^?[0-9a-f]{8})[0-9a-f]* /, '$1 ')).join('\n'));
}

function conflicts(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--git-dir']).trim();
  const g = path.resolve(cwd, gitDir);
  const state = fs.existsSync(path.join(g, 'MERGE_HEAD')) ? 'merge' : fs.existsSync(path.join(g, 'rebase-merge')) || fs.existsSync(path.join(g, 'rebase-apply')) ? 'rebase'
    : fs.existsSync(path.join(g, 'CHERRY_PICK_HEAD')) ? 'cherry-pick' : null;
  const files = git(cwd, ['diff', '--name-only', '--diff-filter=U']).trim().split('\n').filter(Boolean);
  if (!files.length) return state ? `${state} em andamento, sem conflitos pendentes. Conclua com git_merge action "continue".` : 'Nenhum conflito.';
  const parts = files.map((f) => {
    let text = '';
    try { text = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return `### ${f}\n(binário ou ilegível)`; }
    const blocks = [...text.matchAll(/<<<<<<< [^\n]*\n[\s\S]*?\n>>>>>>> [^\n]*/g)].map((m) => m[0]);
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    return `### ${f} (${blocks.length} conflito(s))\n` + blocks.slice(0, 5).map((b) => `linha ${lineOf(text.indexOf(b))}:\n${b.slice(0, 1500)}`).join('\n\n');
  });
  return cut(`${state ? `${state} em andamento. ` : ''}Arquivos em conflito: ${files.length}\n\n${parts.join('\n\n')}\n\nResolva editando os arquivos (remova os marcadores <<<<<<< ======= >>>>>>>), depois git_merge action "continue".`);
}

function merge(cwd, { action = 'merge', branch: br } = {}) {
  const gitDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-dir']).trim());
  const rebasing = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
  const op = rebasing ? 'rebase' : 'merge';
  try {
    switch (action) {
      case 'merge': return git(cwd, ['merge', '--no-edit', safeName(br)]).trim();
      case 'rebase': return git(cwd, ['rebase', safeName(br)]).trim();
      case 'abort': git(cwd, [op, '--abort']); return `${op} cancelado; o repositório voltou ao estado anterior.`;
      case 'continue':
        git(cwd, ['add', '-A']);
        return execFileSafe(cwd, ['-c', 'core.editor=true', op, '--continue']).trim() || `${op} concluído.`;
      default: throw new Error('action: merge, rebase, abort ou continue');
    }
  } catch (e) {
    if (/conflict/i.test(e.message)) return `Conflitos encontrados.\n${conflicts(cwd)}`;
    throw e;
  }
}

// GitHub: tudo com --json para devolver texto curto e estruturado
const PR_FIELDS = 'number,title,state,author,headRefName,baseRefName,isDraft,url,reviewDecision,mergeable,additions,deletions,changedFiles,body';
function github(cwd, a = {}) {
  const n = a.number != null ? String(parseInt(a.number, 10)) : null;
  const need = (v, what) => { if (!v) throw new Error(`Informe ${what}.`); return v; };
  const j = (out) => { try { return JSON.parse(out); } catch { return out; } };
  switch (a.action) {
    case 'repo': return fmtObj(j(gh(cwd, ['repo', 'view', '--json', 'nameWithOwner,description,defaultBranchRef,url,visibility,stargazerCount'])));
    case 'pr_list': return fmtList(j(gh(cwd, ['pr', 'list', '--state', a.state || 'open', '--limit', String(a.limit || 20), '--json', 'number,title,author,headRefName,isDraft,updatedAt'])), (p) => `#${p.number} ${p.title} (${p.headRefName}, ${p.author && p.author.login}${p.isDraft ? ', rascunho' : ''})`);
    case 'pr_view': return fmtObj(j(gh(cwd, ['pr', 'view', ...(n ? [n] : []), '--json', PR_FIELDS])));
    case 'pr_diff': return cut(gh(cwd, ['pr', 'diff', ...(n ? [n] : [])]));
    case 'pr_checks': {
      try { return gh(cwd, ['pr', 'checks', ...(n ? [n] : [])]).trim(); } catch (e) { return e.message; } // sai com erro quando algum check falha
    }
    case 'pr_create': {
      const args = ['pr', 'create', '--title', need(a.title, 'title'), '--body-file', '-'];
      if (a.base) args.push('--base', safeName(a.base));
      if (a.draft) args.push('--draft');
      return gh(cwd, args, String(a.body || '')).trim();
    }
    case 'pr_comment': return gh(cwd, ['pr', 'comment', need(n, 'number'), '--body-file', '-'], need(a.body, 'body')).trim() || 'Comentário publicado.';
    case 'pr_review': return gh(cwd, ['pr', 'review', need(n, 'number'), a.event === 'approve' ? '--approve' : a.event === 'request_changes' ? '--request-changes' : '--comment', '--body-file', '-'], String(a.body || '')).trim() || 'Revisão enviada.';
    case 'pr_merge': return gh(cwd, ['pr', 'merge', need(n, 'number'), `--${['merge', 'rebase'].includes(a.method) ? a.method : 'squash'}`, '--delete-branch']).trim() || 'PR mesclado.';
    case 'issue_list': return fmtList(j(gh(cwd, ['issue', 'list', '--state', a.state || 'open', '--limit', String(a.limit || 20), '--json', 'number,title,labels,author', ...(a.labels ? ['--label', String(a.labels)] : [])])), (i) => `#${i.number} ${i.title}${i.labels && i.labels.length ? ` [${i.labels.map((l) => l.name).join(', ')}]` : ''}`);
    case 'issue_view': return fmtObj(j(gh(cwd, ['issue', 'view', need(n, 'number'), '--json', 'number,title,state,author,labels,body,comments,url'])));
    case 'issue_create': return gh(cwd, ['issue', 'create', '--title', need(a.title, 'title'), '--body-file', '-', ...(a.labels ? ['--label', String(a.labels)] : [])], String(a.body || '')).trim();
    case 'issue_comment': return gh(cwd, ['issue', 'comment', need(n, 'number'), '--body-file', '-'], need(a.body, 'body')).trim() || 'Comentário publicado.';
    case 'runs': return fmtList(j(gh(cwd, ['run', 'list', '--limit', String(a.limit || 10), '--json', 'databaseId,displayTitle,status,conclusion,workflowName,headBranch'])), (r) => `${r.databaseId} ${r.workflowName}: ${r.conclusion || r.status} (${r.headBranch}) ${r.displayTitle}`);
    case 'run_log': return cut(gh(cwd, ['run', 'view', need(n, 'number (id da execução)'), '--log-failed']));
    default: throw new Error('action: repo, pr_list, pr_view, pr_diff, pr_checks, pr_create, pr_comment, pr_review, pr_merge, issue_list, issue_view, issue_create, issue_comment, runs, run_log');
  }
}
const fmtList = (arr, f) => (Array.isArray(arr) ? (arr.length ? arr.map(f).join('\n') : '(nada encontrado)') : String(arr));
function fmtObj(o) {
  if (!o || typeof o !== 'object') return String(o);
  return cut(Object.entries(o).map(([k, v]) => {
    if (v && typeof v === 'object') v = Array.isArray(v) ? v.map((x) => (x && (x.login || x.name || x.body ? `${x.author ? x.author.login + ': ' : ''}${x.login || x.name || x.body}` : JSON.stringify(x)))).join(' | ') : v.login || v.name || JSON.stringify(v);
    return `${k}: ${v}`;
  }).join('\n'));
}

const DEFS = [
  { name: 'git_branch', description: 'Branches: list (com última atividade e upstream), create (e já troca para ela), switch, delete (só se mesclada), rename.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'switch', 'delete', 'rename'] }, name: { type: 'string' }, from: { type: 'string', description: 'Base da nova branch (opcional)' }, new_name: { type: 'string' } }, required: ['action'] } },
  { name: 'git_sync', description: 'Sincroniza com o remoto: fetch, pull (só fast-forward) ou push (cria o upstream se faltar). Nunca faz force push.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['fetch', 'pull', 'push'] }, remote: { type: 'string' }, branch: { type: 'string' }, set_upstream: { type: 'boolean' } }, required: ['action'] } },
  { name: 'git_stash', description: 'Guarda e recupera alterações temporárias: list, push (inclui arquivos novos), pop, apply, drop, show.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'push', 'pop', 'apply', 'drop', 'show'] }, message: { type: 'string' }, index: { type: 'number' } }, required: ['action'] } },
  { name: 'git_show', description: 'Mostra um commit (mensagem completa e diff), opcionalmente só de um arquivo ou só o resumo (stat).',
    parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Hash, tag ou HEAD~1 (padrão HEAD)' }, path: { type: 'string' }, stat: { type: 'boolean' } } } },
  { name: 'git_blame', description: 'Quem alterou cada linha de um arquivo e em qual commit (útil para entender o porquê de um código).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['path'] } },
  { name: 'git_conflicts', description: 'Lista os conflitos de merge/rebase com os trechos <<<<<<< ======= >>>>>>> e a linha de cada um.',
    parameters: { type: 'object', properties: {} } },
  { name: 'git_merge', description: 'merge ou rebase de uma branch na atual; abort cancela; continue conclui depois de resolver os conflitos.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['merge', 'rebase', 'abort', 'continue'] }, branch: { type: 'string' } }, required: ['action'] } },
  { name: 'github', description: 'GitHub pelo GitHub CLI (gh): repo, pr_list, pr_view, pr_diff, pr_checks, pr_create (title, body, base, draft), pr_comment, pr_review (event: approve|request_changes|comment), pr_merge (method: squash|merge|rebase), '
    + 'issue_list, issue_view, issue_create, issue_comment, runs (execuções do GitHub Actions), run_log (log das etapas que falharam).',
    parameters: { type: 'object', properties: { action: { type: 'string' }, number: { type: 'number' }, title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' }, state: { type: 'string' }, labels: { type: 'string' }, limit: { type: 'number' }, event: { type: 'string' }, method: { type: 'string' } }, required: ['action'] } },
];

const READ_ONLY = {
  git_branch: (a) => a.action === 'list', git_sync: (a) => a.action === 'fetch', git_stash: (a) => ['list', 'show'].includes(a.action),
  git_show: () => true, git_blame: () => true, git_conflicts: () => true, git_merge: () => false,
  github: (a) => /^(repo|pr_list|pr_view|pr_diff|pr_checks|issue_list|issue_view|runs|run_log)$/.test(a.action || ''),
};

module.exports = {
  defs: DEFS,
  run(name, a, { cwd }) {
    switch (name) {
      case 'git_branch': return branch(cwd, a);
      case 'git_sync': return sync(cwd, a);
      case 'git_stash': return stash(cwd, a);
      case 'git_show': return show(cwd, a);
      case 'git_blame': return blame(cwd, a);
      case 'git_conflicts': return conflicts(cwd);
      case 'git_merge': return merge(cwd, a);
      case 'github': return github(cwd, a);
      default: throw new Error(`desconhecida: ${name}`);
    }
  },
  describe(name, a) {
    const tail = [a.action, a.name || a.branch || a.ref || a.path || (a.number != null ? `#${a.number}` : '') || a.title].filter(Boolean).join(' ');
    return `${name === 'github' ? 'GitHub' : 'Git'}(${name === 'github' ? '' : name.replace('git_', '') + ' '}${tail})`.replace('( ', '(').replace(/ \)$/, ')');
  },
  needsApproval: (name, a) => !READ_ONLY[name](a || {}),
  group: {
    name: 'git', desc: 'git completo (branches, push/pull, stash, merge, conflitos, blame) e GitHub (pull requests, issues, Actions)',
    hint: /\b(git|branch|commit|push|pull|merge|rebase|stash|conflit|blame|pull request|\bpr\b|issue|github|actions|ci|deploy|release|tag)\b/i,
  },
  _test: { conflicts, branch, merge, stash },
};
