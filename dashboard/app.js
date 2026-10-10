// Painel do administrador do rfcode.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PHASES = [
    ['preparando', 'Preparar'], ['entender', 'Entender'], ['implementar', 'Implementar'],
    ['testar', 'Testar'], ['validando', 'Validar'], ['commit', 'Commit'],
  ];
  const ICON = {
    read_file: '📖', list_dir: '📁', glob: '🔎', grep: '🔎', write_file: '📝', edit_file: '✏️', run_command: '▶️',
    git_status: '🌿', git_diff: '🌿', git_log: '🌿', update_plan: '🗺', say: '💬', denied: '⛔', tests: '🧪',
    repair: '↻', verdict_ok: '✅', verdict_bad: '❌', warn: '⚠️', error: '💥', info: 'ℹ️', task: '🎯', blocked: '🚫',
  };
  const READS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log']);

  let S = null;            // estado do servidor
  let viewRun = null;      // id da rodada exibida
  let follow = true;       // segue a rodada em andamento
  let events = [];
  let es = null;

  // ---------- API ----------
  async function api(path, body) {
    const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RFCode': '1' }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }
  const act = (fn) => async (...a) => { try { await fn(...a); await refresh(); } catch (e) { toast(e.message, true); } };

  // ---------- estado geral ----------
  async function refresh() {
    try { S = await api('/api/state'); } catch (e) { $('statusText').textContent = 'painel sem conexão'; return; }
    renderTop(); renderTasks(); renderCommits(); renderRuns();
    const target = S.running ? S.running.id : (S.runs[0] && S.runs[0].id);
    if (follow && target && target !== viewRun) openRun(target);
  }

  function renderTop() {
    const pill = $('status');
    pill.className = 'pill' + (S.running ? (S.stopRequested ? ' stop' : ' on') : '');
    $('statusText').textContent = S.running ? (S.stopRequested ? 'parando…' : 'rodando') : (S.hasKey ? 'parado' : 'sem API key');
    $('startBtn').classList.toggle('hidden', !!S.running);
    $('stopBtn').classList.toggle('hidden', !S.running);
    const sel = $('model');
    if (!sel.options.length) {
      sel.innerHTML = S.models.map((m) => `<option value="${esc(m.id)}" title="${esc(m.desc)}">${esc(m.id.split('/')[1])}</option>`).join('');
      sel.value = S.defaultModel;
    }
    if (document.activeElement !== $('focus') && !$('focus').dataset.dirty) $('focus').value = S.focus;
  }

  function renderTasks() {
    const cur = currentTaskId();
    const open = new Set([...document.querySelectorAll('.task.open')].map((e) => e.dataset.id));
    const n = { ' ': 0, x: 0, '!': 0 };
    S.tasks.forEach((t) => n[t.state]++);
    $('counts').innerHTML = `<span class="count">${n[' ']} pendentes</span><span class="count">${n.x} feitas</span>${n['!'] ? `<span class="count">${n['!']} bloq.</span>` : ''}`;
    $('tasks').innerHTML = S.tasks.map((t) => {
      const running = S.running && cur === t.id;
      const st = running ? 'cur' : t.state === 'x' ? 'x' : t.state === '!' ? 'blk' : '';
      const mark = t.state === 'x' ? '✓' : t.state === '!' ? '!' : '';
      const tags = (S.next === t.id ? '<span class="tag next">A SEGUIR</span>' : '') + (t.failures ? `<span class="tag fail">${t.failures} falha(s)</span>` : '');
      const actions = [];
      if (t.state === ' ') {
        actions.push(`<button class="btn small" data-next="${t.id}">${S.next === t.id ? 'Tirar de "a seguir"' : 'Fazer a seguir'}</button>`);
        if (!S.running) actions.push(`<button class="btn small primary" data-only="${t.id}">Rodar só esta</button>`);
      }
      if (t.state === '!' && !S.running) actions.push(`<button class="btn small" data-reopen="${t.id}">Reabrir</button>`);
      return `<li class="task ${t.state === 'x' ? 'done' : ''} ${open.has(t.id) ? 'open' : ''}" data-id="${t.id}">
        <div class="task-head"><span class="st ${st}">${mark}</span><div class="task-title"><b>${t.id}</b>${esc(t.title)}${tags}</div></div>
        <div class="task-body"><p>${esc(t.body)}</p>${t.lastFailure ? `<p class="alert warn">Última falha: ${esc(t.lastFailure.slice(0, 400))}</p>` : ''}<div class="actions">${actions.join('')}</div></div>
      </li>`;
    }).join('');
  }

  function renderCommits() {
    const b = S.branch;
    $('aheadCount').textContent = b.ahead.length ? `${b.ahead.length} commit(s)` : '';
    $('commits').innerHTML = b.ahead.length
      ? b.ahead.map((c) => `<li><code>${esc(c.hash)}</code><span class="s">${esc(c.subject)}<br><span class="faint">${esc(c.when)}</span></span><button class="btn small" data-diff="${esc(c.hash)}">diff</button></li>`).join('')
      : '<li class="empty" style="display:block">Nada novo na branch <code>self-improve</code>.</li>';
    $('mergeBtn').disabled = !b.ahead.length || !!S.running;
  }

  function renderRuns() {
    $('runs').innerHTML = S.runs.length ? S.runs.map((r) => {
      const when = new Date(r.start).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const chips = (r.tasks || []).map((t) => `<span class="chip ${t.accepted ? 'ok' : 'bad'}">${t.accepted ? '✓' : '✗'} ${esc(t.id)}</span>`).join('');
      return `<li data-run="${esc(r.id)}" class="${r.id === viewRun ? 'sel' : ''}"><b>${when}</b> <span class="faint">· ${esc((r.model || '').split('/')[1] || '')} · ${esc(r.status || '')}</span><div class="chips">${chips || '<span class="faint">sem veredito</span>'}</div></li>`;
    }).join('') : '<li class="empty" style="display:block;cursor:default">Nenhuma rodada ainda.</li>';
  }

  // ---------- rodada exibida ----------
  async function openRun(id) {
    viewRun = id;
    if (es) { es.close(); es = null; }
    events = [];
    renderRun();
    es = new EventSource(`/api/stream?id=${encodeURIComponent(id)}`);
    let pending = false;
    es.onmessage = (m) => {
      try { events.push(JSON.parse(m.data)); } catch { return; }
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderRun(); }); }
    };
    document.querySelectorAll('.runs li').forEach((li) => li.classList.toggle('sel', li.dataset.run === id));
  }

  function currentTaskId() {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'task_start') return events[i].task.id;
    return null;
  }

  // Reduz os eventos da tarefa atual (a última task_start) num retrato do que está acontecendo.
  function reduce() {
    let start = -1;
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'task_start') { start = i; break; }
    const r = { task: null, phase: null, plan: null, why: null, tools: new Map(), feed: [], code: null, usage: null, tests: null, repairs: 0, actions: 0, verdict: null, runEnd: null, info: [] };
    events.forEach((e, i) => {
      if (e.type === 'run_end') r.runEnd = e;
      if (i < start && start >= 0) return;
      switch (e.type) {
        case 'task_start': r.task = e; r.feed.push({ kind: 'task', e }); break;
        case 'phase': r.phase = e.phase; break;
        case 'plan': r.plan = e; if (e.why) r.why = { text: e.why, src: 'plano' }; r.feed.push({ kind: 'plan', e }); break;
        case 'say': r.feed.push({ kind: 'say', e }); r.why = { text: e.text, src: 'agente' }; break;
        case 'tool': {
          const item = { kind: 'tool', e, result: null };
          r.tools.set(e.id, item); r.feed.push(item); r.actions++;
          if (e.reason) r.why = { text: e.reason, src: 'agente' };
          break;
        }
        case 'tool_result': { const it = r.tools.get(e.id); if (it) it.result = e; break; }
        case 'denied': r.feed.push({ kind: 'denied', e }); break;
        case 'code': r.code = e; break;
        case 'usage': r.usage = e; break;
        case 'tests': r.tests = e; r.feed.push({ kind: 'tests', e }); break;
        case 'repair': r.repairs++; r.feed.push({ kind: 'repair', e }); break;
        case 'verdict': r.verdict = e; if (e.changes) r.code = e.changes; r.feed.push({ kind: 'verdict', e }); break;
        case 'warn': case 'error': case 'agent_error': case 'info': case 'blocked': r.feed.push({ kind: e.type === 'agent_error' ? 'error' : e.type, e }); break;
      }
    });
    return r;
  }

  // fase visual: deriva do que o agente está fazendo
  function visualPhase(r) {
    if (r.verdict) return r.verdict.accepted ? 'commit' : 'validando';
    if (r.phase === 'validando' || r.phase === 'commit' || r.phase === 'preparando') return r.phase;
    let last = null;
    for (let i = r.feed.length - 1; i >= 0; i--) if (r.feed[i].kind === 'tool') { last = r.feed[i].e; break; }
    if (!last) return 'entender';
    if (last.name === 'run_command' && /test|--check/.test(last.target || '')) return 'testar';
    if (last.name === 'write_file' || last.name === 'edit_file') return 'implementar';
    return r.code && r.code.files && r.code.files.length ? 'implementar' : 'entender';
  }

  function renderRun() {
    const r = reduce();
    const live = S && S.running && S.running.id === viewRun;
    $('nowRun').textContent = viewRun ? (live ? 'ao vivo · ' : 'histórico · ') + viewRun.slice(0, 16).replace('T', ' ') : '';
    renderNow(r, live);
    renderCode(r);
    renderTimeline(r);
    renderStats(r);
  }

  function renderNow(r, live) {
    if (!r.task) {
      $('now').innerHTML = `<div class="empty">${viewRun ? (r.runEnd ? `Rodada encerrada (${esc(r.runEnd.status)}) sem tarefas.` : 'Preparando a rodada…') : 'Nenhuma rodada ainda. Defina o foco, escolha a próxima tarefa e clique em <b>Iniciar rodada</b>.'}</div>`;
      return;
    }
    const t = r.task;
    const ph = visualPhase(r);
    const idx = PHASES.findIndex((p) => p[0] === ph);
    const phases = PHASES.map((p, i) => `<div class="phase ${i < idx ? 'done' : i === idx ? (r.verdict ? (r.verdict.accepted ? 'done' : '') : 'cur') : ''}">${p[1]}</div>`).join('');
    let plan = '';
    if (r.plan && r.plan.steps.length) {
      const done = r.plan.steps.filter((s) => s.status === 'done').length;
      const pct = Math.round((done / r.plan.steps.length) * 100);
      const ic = { done: '✅', in_progress: '🔄', pending: '⬜' };
      plan = `<div class="plan"><div class="row"><b>Plano do agente</b><span class="muted" style="margin-left:auto">${done}/${r.plan.steps.length} · ${pct}%</span></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <ul class="steps">${r.plan.steps.map((s) => `<li class="${s.status}"><span>${ic[s.status]}</span><span>${esc(s.text)}</span></li>`).join('')}</ul></div>`;
    } else {
      plan = '<div class="plan faint" style="font-size:12.5px">O agente ainda não declarou o plano.</div>';
    }
    const why = r.why ? `<div class="why"><div class="ico">💡</div><div><div class="k">${live && !r.verdict ? 'Fazendo agora, e por quê' : 'Último raciocínio'}</div><div class="v">${esc(r.why.text.slice(0, 600))}</div></div></div>` : '';
    $('now').innerHTML = `
      <div class="now-title"><span class="id">${esc(t.task.id)}</span><h3>${esc(t.task.title)}</h3></div>
      <div class="target"><div class="k">Alvo</div>${esc((r.plan && r.plan.goal) || t.goal)}</div>
      <div class="meta"><span>Tentativa <b>${t.attempt}</b></span><span>Modelo <b>${esc(t.model.split('/')[1] || t.model)}</b></span><span>Testes no início <b>${t.testsBefore}</b></span><span>Início <b>${new Date(t.ts).toLocaleTimeString('pt-BR')}</b></span></div>
      ${t.focus ? `<div class="alert info">🧭 Foco: ${esc(t.focus.slice(0, 300))}</div>` : ''}
      ${t.previousFailure ? `<div class="alert warn">Tentativa anterior falhou: ${esc(t.previousFailure.slice(0, 300))}</div>` : ''}
      <div class="phases">${phases}</div>
      ${why}${plan}`;
  }

  function renderCode(r) {
    const c = r.code;
    if (!c || !c.files || !c.files.length) { $('code').innerHTML = '<div class="empty">Nenhuma alteração ainda.</div>'; return; }
    const max = Math.max(...c.files.map((f) => f.added + f.removed), 1);
    const files = c.files.map((f) => `<li><span class="name" title="${esc(f.path)}">${esc(f.path)}</span><span class="add">+${f.added}</span><span class="del">−${f.removed}</span>
      <span class="bar"><i style="width:${(f.added / max) * 60}px;background:var(--accent)"></i><i style="width:${(f.removed / max) * 60}px;background:var(--bad)"></i></span></li>`).join('');
    const seen = new Set();
    const syms = (c.symbols || []).filter((s) => { const k = s.kind + s.name; if (seen.has(k)) return false; seen.add(k); return true; });
    const symHtml = syms.length
      ? `<div class="symbols">${syms.map((s) => `<span class="sym k-${esc(s.kind)}" title="${esc(s.file)}"><em>${esc(s.kind)}</em>${esc(s.name)}</span>`).join('')}</div>`
      : '';
    $('code').innerHTML = `<ul class="files">${files}</ul>${symHtml ? '<div class="hint" style="margin-top:10px">Funções, ferramentas e testes que ele está escrevendo:</div>' + symHtml : ''}`;
  }

  function renderTimeline(r) {
    const el = $('timeline');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    const showReads = $('showReads').checked;
    const time = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const items = r.feed
      .filter((f) => !(f.kind === 'tool' && f.e.name === 'update_plan')) // o evento "plan" já mostra isso
      .filter((f) => showReads || !(f.kind === 'tool' && READS.has(f.e.name))).map((f) => {
      const e = f.e;
      switch (f.kind) {
        case 'task': return li('task', '', `Tarefa ${esc(e.task.id)}: ${esc(e.task.title)}`, `Alvo: ${esc(e.goal)}`, '', e.ts);
        case 'plan': {
          const cur = e.steps.find((s) => s.status === 'in_progress');
          const done = e.steps.filter((s) => s.status === 'done').length;
          return li('update_plan', 'plan', `Plano ${done}/${e.steps.length}${cur ? `: ${esc(cur.text)}` : ''}`, e.why ? esc(e.why) : '', '', e.ts);
        }
        case 'say': return li('say', 'say', esc(e.text.slice(0, 700)), '', '', e.ts);
        case 'tool': {
          const res = f.result;
          const cls = res && !res.ok ? 'err' : '';
          const showReason = e.reason && !r.feed.some((x) => x.kind === 'say' && x.e.text === e.reason);
          return li(e.name, cls, esc(e.label), showReason ? esc(e.reason.slice(0, 300)) : '', res ? esc(res.summary) : '<span class="faint">…</span>', e.ts);
        }
        case 'denied': return li('denied', 'denied', `Negado: ${esc(e.label)}`, esc(e.reason), '', e.ts);
        case 'tests': return li('tests', e.fail ? 'err' : '', `Testes: ${e.pass} passando, ${e.fail} falhando (antes: ${e.before})`, '', esc((e.failures || []).map((x) => `✗ ${x.name}: ${x.error}`).join('\n')), e.ts);
        case 'repair': return li('repair', 'denied', `Rodada de reparo ${e.round}: o agente recebeu a falha para corrigir`, esc(e.reason.slice(0, 400)), '', e.ts);
        case 'verdict': return e.accepted
          ? li('verdict_ok', 'verdict-ok', `Aceita: commit ${esc(e.commit)} com ${e.tests} testes passando`, '', '', e.ts)
          : li('verdict_bad', 'verdict-bad', 'Rejeitada: mudança descartada', esc(e.reason), '', e.ts);
        default: return li(f.kind, f.kind === 'error' ? 'err' : '', esc(e.text || f.kind), '', '', e.ts);
      }
    });
    function li(icon, cls, label, reason, res, ts) {
      return `<li class="ev ${cls}"><div class="i">${ICON[icon] || '•'}</div><div><div class="label">${label}</div>${reason ? `<div class="reason">${reason}</div>` : ''}${res ? `<div class="res">${res}</div>` : ''}</div><div class="t">${time(ts)}</div></li>`;
    }
    el.innerHTML = items.length ? items.join('') : '<li class="empty">Os passos do agente aparecem aqui, com o motivo de cada um.</li>';
    if (atBottom || follow) el.scrollTop = el.scrollHeight;
  }

  function renderStats(r) {
    const before = r.task ? r.task.testsBefore : null;
    $('sTests').innerHTML = r.tests ? `${r.tests.pass}<small> / ${r.tests.fail ? `<span class="del">${r.tests.fail} ✗</span>` : `antes ${r.tests.before}`}</small>` : (before != null ? `${before}<small> no início</small>` : '–');
    $('sTokens').textContent = r.usage ? (r.usage.total >= 1000 ? (r.usage.total / 1000).toFixed(1) + 'k' : r.usage.total) : '–';
    $('sActions').textContent = r.task ? r.actions : '–';
    $('sRepairs').textContent = r.task ? r.repairs : '–';
    const v = r.verdict;
    $('verdict').innerHTML = v
      ? `<div class="verdict ${v.accepted ? 'ok' : 'bad'}">${v.accepted ? `✅ ${esc(v.task)} aceita: commit ${esc(v.commit)}` : `❌ ${esc(v.task)} rejeitada\n${esc(String(v.reason).slice(0, 500))}`}</div>`
      : (r.runEnd ? `<div class="verdict">Rodada ${esc(r.runEnd.status)}.</div>` : '');
  }

  // ---------- diff ----------
  function showDiff(title, text) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = (text || '(sem alterações)').split('\n').map((l) => {
      const cls = /^(diff --git|\+\+\+ |--- )/.test(l) ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '';
      return `<span class="${cls}">${esc(l) || ' '}</span>`;
    }).join('');
    $('modal').classList.remove('hidden');
  }

  // ---------- eventos da interface ----------
  $('startBtn').onclick = act(async () => {
    await api('/api/start', { iterations: +$('iters').value || 1, model: $('model').value });
    follow = true; toast('Rodada iniciada.');
    setTimeout(refresh, 1200);
  });
  $('stopBtn').onclick = act(async () => {
    if (!confirm('Parar a rodada? A tarefa em andamento será descartada.')) return;
    await api('/api/stop', {}); toast('Pedido de parada enviado.');
  });
  $('focus').oninput = () => { $('focus').dataset.dirty = '1'; $('focusSaved').textContent = 'não salvo'; };
  $('focusBtn').onclick = act(async () => {
    await api('/api/focus', { text: $('focus').value });
    delete $('focus').dataset.dirty; $('focusSaved').textContent = 'salvo ✓';
  });
  $('ntBtn').onclick = act(async () => {
    const r = await api('/api/task', { title: $('ntTitle').value, body: $('ntBody').value, acceptance: $('ntAcc').value });
    $('ntTitle').value = $('ntBody').value = $('ntAcc').value = '';
    toast(`Tarefa ${r.id} adicionada ao SDD.`);
  });
  $('tasks').onclick = act(async (ev) => {
    const b = ev.target.closest('button');
    if (b) {
      if (b.dataset.next) await api('/api/next', { task: S.next === b.dataset.next ? null : b.dataset.next });
      if (b.dataset.only) { await api('/api/start', { iterations: 1, model: $('model').value, task: b.dataset.only }); follow = true; toast(`Rodando ${b.dataset.only}.`); setTimeout(refresh, 1200); }
      if (b.dataset.reopen) { await api('/api/reopen', { task: b.dataset.reopen }); toast(`${b.dataset.reopen} reaberta.`); }
      return;
    }
    const head = ev.target.closest('.task-head');
    if (head) head.parentElement.classList.toggle('open');
  });
  $('commits').onclick = act(async (ev) => {
    const b = ev.target.closest('[data-diff]');
    if (!b) return;
    const r = await api('/api/commit?hash=' + b.dataset.diff);
    showDiff('Commit ' + b.dataset.diff, r.diff);
  });
  $('mergeBtn').onclick = act(async () => {
    if (!confirm(`Aceitar ${S.branch.ahead.length} commit(s) da branch self-improve no main?`)) return;
    const r = await api('/api/merge', {});
    toast(`Merge feito: ${r.merged} commit(s). main agora em ${r.head}`);
  });
  $('runs').onclick = (ev) => {
    const li = ev.target.closest('[data-run]');
    if (!li) return;
    follow = S.running && S.running.id === li.dataset.run;
    openRun(li.dataset.run);
  };
  $('liveDiffBtn').onclick = act(async () => { const r = await api('/api/live-diff'); showDiff('Alterações ainda não commitadas (worktree)', r.diff); });
  $('showReads').onchange = renderRun;
  $('modalClose').onclick = () => $('modal').classList.add('hidden');
  $('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal').classList.add('hidden'); });
  $('themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = cur === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('rf-theme', document.documentElement.dataset.theme); } catch {}
  };
  try { const t = localStorage.getItem('rf-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

  refresh();
  setInterval(refresh, 3000);
})();
