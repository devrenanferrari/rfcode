// Interface do painel do rfcode (roda dentro do webview).
(function () {
  const vscode = acquireVsCodeApi();
  const { render: md, esc } = window.rfMarkdown;
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
  const modelSel = $('model'), autoChk = $('auto'), statusEl = $('status'), planEl = $('plan');
  const LOGO = document.body.dataset.logo;

  let busy = false;
  let current = null;      // { el, text, reasoning, body } da resposta em andamento
  let spinner = null;
  const tools = new Map(); // id -> { card, body, name, cmdOut }
  let lastCmdTool = null;
  let tokens = 0;
  let state = { cwd: '', hasKey: true };
  let planOpen = true;

  // ---------- ícones (SVG inline, herdam a cor do texto) ----------
  const svg = (d, extra = '') => `<svg viewBox="0 0 16 16" aria-hidden="true" ${extra}>${d}</svg>`;
  const I = {
    check: svg('<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    x: svg('<path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    chev: svg('<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    spark: svg('<path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor"/>'),
    folder: svg('<path d="M1.5 4.5a1 1 0 011-1h3.6l1.4 1.5h5.9a1 1 0 011 1v6.5a1 1 0 01-1 1h-10.9a1 1 0 01-1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
    info: svg('<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4M8 4.8v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
    warn: svg('<path d="M8 1.8l6.6 11.7H1.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.3v3.3M8 11.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
    key: svg('<circle cx="5" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 8h6.5M12 8v2.5M14 8v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'),
    book: svg('<path d="M2 3h4.5A1.5 1.5 0 018 4.5V13a1.5 1.5 0 00-1.5-1.5H2zM14 3H9.5A1.5 1.5 0 008 4.5V13a1.5 1.5 0 011.5-1.5H14z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'),
    bug: svg('<ellipse cx="8" cy="9.5" rx="3.5" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.3v8.4M4.5 8H1.8M14.2 8h-2.7M4.7 11.5l-2.2 1.3M11.3 11.5l2.2 1.3M5.6 3.3L6.6 5M10.4 3.3L9.4 5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
    flask: svg('<path d="M6 1.8h4M6.7 1.8v4.4L2.6 12.8a1 1 0 00.9 1.5h9a1 1 0 00.9-1.5L9.3 6.2V1.8M4.3 10h7.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
    branch: svg('<circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2.2 3-5.4 4.2" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  };

  const SUGGESTIONS = [
    { icon: I.book, title: 'Explicar o projeto', sub: 'Estrutura, dependências e como executar',
      prompt: 'Explique este projeto: o que ele faz, como está organizado e como rodar.' },
    { icon: I.bug, title: 'Procurar bugs', sub: 'Problemas encontrados, com arquivo e linha',
      prompt: 'Procure bugs reais no código deste projeto e me mostre os mais graves, com arquivo e linha. Não edite nada ainda.' },
    { icon: I.flask, title: 'Escrever testes', sub: 'Para o código ainda sem cobertura',
      prompt: 'Escreva testes para a parte mais importante deste projeto que ainda não tem testes, e rode os testes.' },
    { icon: I.branch, title: 'Ver alterações', sub: 'git status e resumo das mudanças',
      prompt: 'Mostre o git status e resuma o que mudou.' },
  ];

  // ---------- helpers ----------
  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  function stickToBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 140; }
  function scroll(force) { if (force || stickToBottom()) log.scrollTop = log.scrollHeight; }
  function add(node) {
    const stick = stickToBottom();
    log.appendChild(node);
    if (spinner) log.appendChild(spinner);
    scroll(stick);
    return node;
  }
  function note(kind, text) {
    const n = el('div', 'note ' + kind, (kind === 'error' ? I.warn : I.info) + '<span></span>');
    n.querySelector('span').textContent = text;
    add(n);
  }
  function fmtTokens(n) {
    if (n < 1000) return `${n} tokens`;
    return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil tokens`;
  }
  function setBusy(b) {
    busy = b;
    sendBtn.classList.toggle('hidden', b);
    stopBtn.classList.toggle('hidden', !b);
    statusEl.textContent = tokens ? fmtTokens(tokens) : '';
    document.body.classList.toggle('busy', b);
  }
  function showSpinner(text) {
    if (!spinner) spinner = el('div', 'spinner', '<span class="dots"><i></i><i></i><i></i></span><span class="txt"></span>');
    spinner.querySelector('.txt').textContent = text || 'Pensando';
    const stick = stickToBottom();
    log.appendChild(spinner);
    scroll(stick);
  }
  function hideSpinner() { if (spinner) { spinner.remove(); spinner = null; } }
  function ensureAssistant() {
    if (!current) {
      current = { el: el('div', 'msg assistant'), text: '', reasoning: null, body: el('div', 'md') };
      current.el.appendChild(current.body);
      add(current.el);
    }
    return current;
  }
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  // ---------- boas-vindas ----------
  function welcome() {
    const w = el('div', 'welcome');
    w.innerHTML = `
      <img class="logo" src="${LOGO}" alt="">
      <h1>Em que posso ajudar?</h1>
      ${state.hasKey ? '' : `<button class="keycard" id="keyBtn" type="button">${I.key}<span><b>Configurar a API key da NVIDIA</b><small>Necessária para usar o rfcode. Gere a chave em build.nvidia.com.</small></span></button>`}
      <div class="suggest">${SUGGESTIONS.map((s, i) => `
        <button class="sugg" type="button" data-i="${i}">
          <span class="ic">${s.icon}</span>
          <span><b>${esc(s.title)}</b><small>${esc(s.sub)}</small></span>
        </button>`).join('')}
      </div>
      <p class="tips">Use <code>@arquivo</code> para anexar um arquivo · <kbd>Esc</kbd> interrompe</p>`;
    w.querySelector('#keyBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'setKey' }));
    w.querySelectorAll('.sugg').forEach((b) => b.addEventListener('click', () => {
      input.value = SUGGESTIONS[+b.dataset.i].prompt;
      send();
    }));
    return w;
  }
  function resetLog() { log.innerHTML = ''; log.appendChild(welcome()); }
  function hideWelcome() { log.querySelector('.welcome')?.remove(); }

  // ---------- enviar ----------
  // ---------- comandos "/" ----------
  const cmdMenu = $('cmdMenu');
  let commands = [];
  let menuItems = [], menuIndex = 0;
  const ALIAS = {};
  function parseCmd(text) {
    const m = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!m) return null;
    const name = m[1].toLowerCase();
    return { name: ALIAS[name] || name, args: (m[2] || '').trim() };
  }
  function closeMenu() { cmdMenu.classList.add('hidden'); menuItems = []; }
  function updateMenu() {
    const v = input.value;
    const m = /^\/([a-z0-9_-]*)$/i.exec(v);
    if (!m || !commands.length) { closeMenu(); return; }
    const q = m[1].toLowerCase();
    menuItems = commands.filter((c) => c.name.startsWith(q) || (c.aliases || []).some((a) => a.startsWith(q)));
    if (!menuItems.length) { closeMenu(); return; }
    menuIndex = Math.min(menuIndex, menuItems.length - 1);
    cmdMenu.innerHTML = menuItems.map((c, i) => `<div class="cmd-item${i === menuIndex ? ' active' : ''}" role="option" data-i="${i}">
      <span class="cmd-name">/${esc(c.name)}${c.args ? ` <span class="cmd-args">${esc(c.args)}</span>` : ''}</span>
      <span class="cmd-desc">${esc(c.desc || '')}${c.custom ? ' <span class="cmd-tag">personalizado</span>' : ''}</span></div>`).join('');
    cmdMenu.classList.remove('hidden');
    cmdMenu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  function pickCommand(i) {
    const c = menuItems[i];
    if (!c) return;
    closeMenu();
    if (c.args) { input.value = `/${c.name} `; input.focus(); autoGrow(); return; }
    input.value = `/${c.name}`;
    send();
  }
  cmdMenu.addEventListener('mousedown', (e) => { const it = e.target.closest('.cmd-item'); if (it) { e.preventDefault(); pickCommand(+it.dataset.i); } });

  function showHelp() {
    hideWelcome();
    const card = el('div', 'help-card');
    card.innerHTML = '<div class="help-title">Comandos</div>' + commands.map((c) => `<div class="help-row"><code>/${esc(c.name)}${c.args ? ' ' + esc(c.args) : ''}</code><span>${esc(c.desc || '')}</span></div>`).join('')
      + '<div class="help-foot">Crie os seus em <code>.rfcode/commands/nome.md</code> (no projeto) ou <code>~/.rfcode/commands</code>. Use <code>$ARGUMENTS</code> no texto para o que vier depois do comando.</div>';
    add(card);
    scroll(true);
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    const cmd = text.startsWith('/') ? parseCmd(text) : null;
    if (cmd) {
      input.value = '';
      autoGrow();
      closeMenu();
      if (cmd.name === 'help') return showHelp();
      if (cmd.name === 'history') return openHistory();
      if (busy && !['model', 'auto', 'remote', 'undo'].includes(cmd.name)) { note('info', 'Espere a resposta atual terminar para usar este comando.'); return; }
      vscode.postMessage({ type: 'command', name: cmd.name, args: cmd.args });
      return;
    }
    input.value = '';
    autoGrow();
    // durante o trabalho a mensagem vai para a fila (o agente a recebe no próximo passo)
    if (!busy) setBusy(true);
    vscode.postMessage({ type: 'send', text });
  }

  // Seletor de modelos agrupado por provedor, com atalho para configurar outro provedor.
  const shortName = (id) => {
    const i = id.indexOf(':');
    const bare = i > 0 && !id.slice(0, i).includes('/') ? id.slice(i + 1) : id;
    return bare.split('/').pop();
  };
  function renderModels(models, model) {
    const groups = new Map();
    for (const x of models || []) {
      const g = x.group || 'Modelos';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    }
    let html = '';
    for (const [g, list] of groups) {
      html += `<optgroup label="${esc(g)}">${list.map((x) => `<option value="${esc(x.id)}" title="${esc(x.id + (x.desc ? ' · ' + x.desc : ''))}">${esc(shortName(x.id))}</option>`).join('')}</optgroup>`;
    }
    html += '<option value="__provider__">Configurar outro provedor…</option>';
    modelSel.innerHTML = html;
    modelSel.value = model;
    modelSel.title = model;
    modelSel.dataset.current = model;
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => { autoGrow(); menuIndex = 0; updateMenu(); });
  input.addEventListener('blur', () => setTimeout(closeMenu, 120));
  input.addEventListener('keydown', (e) => {
    if (menuItems.length && !cmdMenu.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); menuIndex = (menuIndex + 1) % menuItems.length; updateMenu(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length; updateMenu(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickCommand(menuIndex); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy && historyEl.classList.contains('hidden')) { e.preventDefault(); vscode.postMessage({ type: 'stop' }); }
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  modelSel.addEventListener('change', () => {
    if (modelSel.value === '__provider__') {
      modelSel.value = modelSel.dataset.current || '';
      vscode.postMessage({ type: 'command', name: 'provider', args: '' });
      return;
    }
    modelSel.dataset.current = modelSel.value;
    modelSel.title = modelSel.value;
    vscode.postMessage({ type: 'setModel', model: modelSel.value });
  });
  autoChk.addEventListener('change', () => vscode.postMessage({ type: 'setAuto', value: autoChk.checked }));
  planEl.addEventListener('click', (e) => {
    if (!e.target.closest('.plan-head')) return;
    planOpen = !planOpen;
    planEl.classList.toggle('collapsed', !planOpen);
  });

  // copiar blocos de código (delegação; a área de transferência é da extensão, mais confiável no webview)
  log.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const code = btn.closest('.code')?.querySelector('code');
    if (!code) return;
    vscode.postMessage({ type: 'copy', text: code.textContent });
    btn.textContent = 'Copiado';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('done'); }, 1400);
  });

  // ---------- cartões de ferramenta ----------
  const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
  const OPEN_BY_DEFAULT = new Set(['write_file', 'edit_file', 'run_command']);

  function splitLabel(label) {
    const m = /^([A-Za-z]+)\(([\s\S]*)\)$/.exec(label || '');
    return m ? { verb: m[1], target: m[2] } : { verb: '', target: label || '' };
  }

  function toolCard(m) {
    const { verb, target } = splitLabel(m.label);
    const card = el('div', 'tool running');
    const head = el('div', 'tool-head');
    head.innerHTML = `<span class="st"></span><span class="verb">${esc(verb || m.name)}</span><span class="target"></span><span class="meta"></span><span class="chev">${I.chev}</span>`;
    const tgt = head.querySelector('.target');
    tgt.textContent = FILE_TOOLS.has(m.name) && m.args?.path ? m.args.path : target;
    tgt.title = target;
    if (FILE_TOOLS.has(m.name) && m.args?.path) {
      tgt.classList.add('link');
      tgt.title = 'Abrir ' + m.args.path;
      tgt.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openFile', path: m.args.path }); });
    }
    const body = el('div', 'tool-body');
    if (m.preview) {
      const p = m.preview;
      head.querySelector('.meta').innerHTML = `<span class="plus">+${p.added.length}</span>${p.removed.length ? `<span class="minus">−${p.removed.length}</span>` : ''}`;
      const pre = el('pre', 'diff');
      pre.innerHTML = p.removed.map((l) => `<span class="del">${esc(l) || ' '}</span>`).join('')
        + p.added.map((l) => `<span class="add">${esc(l) || ' '}</span>`).join('')
        + (p.more ? `<span class="more">… mais ${p.more} linhas</span>` : '');
      body.appendChild(pre);
    }
    card.append(head, body);
    if (!OPEN_BY_DEFAULT.has(m.name)) card.classList.add('collapsed');
    if (!body.childNodes.length) card.classList.add('empty');
    head.addEventListener('click', () => { if (!card.classList.contains('empty')) card.classList.toggle('collapsed'); });
    return { card, body };
  }

  function approvalBox(m, t) {
    const box = el('div', 'approve' + (m.forced ? ' forced' : ''));
    box.innerHTML = `
      <div class="q">${I.warn}<span>${m.forced ? 'Ação importante (enviar, pagar ou excluir). Confira antes de permitir.' : 'Permitir esta ação?'}</span></div>
      <div class="btns">
        <button type="button" class="primary" data-d="yes">Permitir</button>
        ${m.forced ? '' : '<button type="button" class="secondary" data-d="all" title="Aprovar tudo até o fim desta conversa">Sempre</button>'}
        <button type="button" class="ghost" data-d="deny">Negar</button>
        ${m.diff && !window.rfRemote ? '<button type="button" class="ghost" data-d="diff" title="Abre no editor o arquivo atual ao lado da proposta">Ver diff</button>' : ''}
      </div>
      ${m.rule ? `<button type="button" class="rule-link" data-d="rule" title="Grava a regra em ~/.rfcode/settings.json">Sempre permitir <code>${esc(m.rule.replace(/^[a-z_]+:/, ''))}</code></button>` : ''}
      <div class="deny hidden">
        <input type="text" placeholder="O que o rfcode deve fazer em vez disso? (opcional)">
        <button type="button" class="secondary" data-d="denySend">Negar</button>
      </div>`;
    const reason = box.querySelector('input');
    const decide = (decision) => {
      vscode.postMessage({ type: 'approval', id: m.id, decision, reason: decision === 'deny' ? reason.value : '' });
      box.remove();
      t.card.classList.remove('wait');
      if (decision !== 'deny') showSpinner('Executando');
    };
    box.addEventListener('click', (e) => {
      const d = e.target.closest('button')?.dataset.d;
      if (!d) return;
      if (d === 'diff') { vscode.postMessage({ type: 'showDiff', id: m.id }); return; }
      if (d === 'deny') { box.querySelector('.deny').classList.remove('hidden'); box.querySelector('.btns').classList.add('hidden'); box.querySelector('.rule-link')?.classList.add('hidden'); reason.focus(); return; }
      decide(d === 'denySend' ? 'deny' : d);
    });
    reason.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); decide('deny'); } });
    return box;
  }

  // ---------- perguntas do agente (ask_user) ----------
  function askCard(m) {
    hideSpinner();
    hideWelcome();
    const card = el('div', 'ask-card');
    card.dataset.id = m.id;
    card.innerHTML = `<div class="ask-q">${I.info}<span></span></div>
      <div class="ask-opts">${(m.options || []).map((o, i) => `<button type="button" class="secondary" data-i="${i}"></button>`).join('')}</div>
      <div class="ask-free"><input type="text" placeholder="${(m.options || []).length ? 'Ou escreva outra resposta…' : 'Sua resposta…'}"><button type="button" class="primary" data-a="send">Responder</button></div>`;
    card.querySelector('.ask-q span').textContent = m.question;
    card.querySelectorAll('.ask-opts button').forEach((b) => { b.textContent = m.options[+b.dataset.i]; });
    const input2 = card.querySelector('input');
    const answer = (text) => { if (text.trim()) vscode.postMessage({ type: 'answer', id: m.id, text: text.trim() }); };
    card.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      answer(b.dataset.a === 'send' ? input2.value : m.options[+b.dataset.i]);
    });
    input2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answer(input2.value); } });
    add(card);
    scroll(true);
    input2.focus();
  }

  // ---------- plano ----------
  function renderPlan(p) {
    const done = p.steps.filter((s) => s.status === 'done').length;
    const pct = p.steps.length ? Math.round((done / p.steps.length) * 100) : 0;
    const mark = { done: I.check, in_progress: '<span class="ring"></span>', pending: '<span class="hollow"></span>' };
    planEl.innerHTML = `
      <div class="plan-head">
        <span class="chev">${I.chev}</span>
        <b>${esc(p.goal || 'Plano')}</b>
        <span class="count">${done}/${p.steps.length}</span>
      </div>
      <div class="bar"><i></i></div>
      <div class="steps">
        ${p.steps.map((s) => `<div class="step ${s.status}"><span class="mk">${mark[s.status]}</span><span>${esc(s.text)}</span></div>`).join('')}
        ${p.why ? `<div class="why">${esc(p.why)}</div>` : ''}
      </div>`;
    planEl.querySelector('.bar i').style.width = pct + '%';
    planEl.classList.toggle('hidden', !p.steps.length);
    planEl.classList.toggle('collapsed', !planOpen);
  }

  // ---------- histórico ----------
  const historyEl = $('history'), historyList = $('historyList'), historySearch = $('historySearch');
  let historyItems = [], historyCurrent = null;
  function openHistory() {
    historyEl.classList.remove('hidden');
    historyList.innerHTML = '<div class="history-empty">Carregando…</div>';
    vscode.postMessage({ type: 'history' });
    historySearch.value = '';
    historySearch.focus();
  }
  function closeHistory() { historyEl.classList.add('hidden'); input.focus(); }
  function dayGroup(iso) {
    const d = new Date(iso), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff <= 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    if (diff < 7) return 'Últimos 7 dias';
    if (diff < 30) return 'Últimos 30 dias';
    return 'Mais antigas';
  }
  function renderHistory() {
    const q = historySearch.value.trim().toLowerCase();
    const items = historyItems.filter((it) => !q || it.title.toLowerCase().includes(q) || (it.cwd || '').toLowerCase().includes(q));
    if (!items.length) {
      historyList.innerHTML = `<div class="history-empty">${historyItems.length ? 'Nada encontrado.' : 'Nenhuma conversa salva ainda. As conversas novas aparecem aqui.'}</div>`;
      return;
    }
    let html = '', last = '';
    for (const it of items) {
      const g = dayGroup(it.updated);
      if (g !== last) { html += `<div class="history-group">${g}</div>`; last = g; }
      const when = new Date(it.updated).toLocaleString('pt-BR', g === 'Hoje' || g === 'Ontem' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' });
      html += `<div class="history-item${it.id === historyCurrent ? ' current' : ''}" data-id="${esc(it.id)}" tabindex="0" role="button">
        <div class="h-main"><div class="h-title">${esc(it.title)}</div>
        <div class="h-meta">${esc(baseName(it.cwd))} · ${it.count} msgs · ${esc(when)}</div></div>
        <button class="h-del" type="button" title="Apagar conversa" data-del="${esc(it.id)}">${I.x}</button></div>`;
    }
    historyList.innerHTML = html;
  }
  historySearch.addEventListener('input', renderHistory);
  historyList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const row = del.closest('.history-item');
      if (row.classList.contains('confirm')) vscode.postMessage({ type: 'deleteSession', id: del.dataset.del });
      else { row.classList.add('confirm'); del.title = 'Clique de novo para apagar'; setTimeout(() => row.classList.remove('confirm'), 2500); }
      return;
    }
    const row = e.target.closest('.history-item');
    if (row) vscode.postMessage({ type: 'openSession', id: row.dataset.id });
  });
  historyList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('history-item')) vscode.postMessage({ type: 'openSession', id: e.target.dataset.id });
  });
  historyEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeHistory(); } });
  $('historyBtn').addEventListener('click', () => (historyEl.classList.contains('hidden') ? openHistory() : closeHistory()));
  $('historyClose').addEventListener('click', closeHistory);
  $('newChatBtn').addEventListener('click', () => { closeHistory(); vscode.postMessage({ type: 'newChat' }); });
  $('remoteBtn').addEventListener('click', () => vscode.postMessage({ type: 'command', name: 'remote', args: '' }));

  // ---------- modo plano e controle remoto ----------
  function setMode(mode) {
    const b = $('modeBadge');
    b.classList.toggle('hidden', mode !== 'plan');
    b.innerHTML = mode === 'plan' ? '<b>Modo plano</b> · nada será alterado. Digite <code>/go</code> para executar.' : '';
  }
  function showRemoteCard(m) {
    log.querySelector('.remote-card')?.remove();
    $('remoteBtn').classList.toggle('hidden', !m.on);
    if (!m.on) { note('info', 'Controle remoto desligado.'); return; }
    hideWelcome();
    const card = el('div', 'remote-card');
    card.innerHTML = `<div class="rc-head"><b>Controle remoto ligado</b><span class="rc-count">${m.clients ? m.clients + ' conectado(s)' : 'aguardando o celular'}</span></div>
      <div class="rc-body"><div class="rc-qr">${m.qr}</div>
      <div class="rc-info"><p>Aponte a câmera do celular para o código. O celular precisa estar <b>no mesmo Wi-Fi</b> que este PC.</p>
      <p class="rc-url"><code></code></p>
      <p class="rc-warn">Quem tiver este link controla o rfcode neste PC. Não compartilhe.</p></div></div>
      ${m.firewall === 'missing' ? `<div class="rc-fw">${I.warn}<div><b>O firewall do Windows está bloqueando o celular.</b> Clique em liberar: é criada uma regra só para a porta do rfcode e só para a sua rede local. O Windows vai pedir confirmação de administrador.</div></div>` : ''}
      <div class="rc-actions">${m.firewall === 'missing' ? '<button type="button" class="primary" data-a="fw">Liberar no firewall</button>' : ''}<button type="button" class="secondary" data-a="copy">Copiar link</button><button type="button" class="ghost" data-a="stop">Desligar</button></div>
      ${m.firewall === 'n/a' ? '<button type="button" class="rc-help" data-a="fw">O celular não conecta? Liberar a porta no firewall do Windows</button>' : ''}`;
    card.querySelector('.rc-url code').textContent = m.url;
    card.addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'fw') { e.target.disabled = true; e.target.textContent = 'Aguardando a confirmação do Windows…'; vscode.postMessage({ type: 'remoteFirewall' }); }
      if (a === 'copy') { vscode.postMessage({ type: 'copy', text: m.url }); e.target.textContent = 'Copiado'; }
      if (a === 'stop') vscode.postMessage({ type: 'remoteStop' });
    });
    add(card);
    scroll(true);
  }

  // ---------- mensagens da extensão ----------
  function handle(m) {
    switch (m.type) {
      case 'history':
        historyItems = m.items || [];
        historyCurrent = m.current;
        renderHistory();
        break;
      case 'replay':
        closeHistory();
        log.innerHTML = '';
        current = null; tools.clear(); hideSpinner(); tokens = 0;
        planEl.classList.add('hidden');
        for (const e of m.events) handle(e);
        scroll(true);
        break;
      case 'init':
        commands = m.commands || [];
        for (const c of commands) for (const a of c.aliases || []) ALIAS[a] = c.name;
        setMode(m.mode);
        $('remoteBtn').classList.toggle('hidden', !m.remote);
        renderModels(m.models, m.model);
        autoChk.checked = m.autoApprove;
        state = { cwd: m.cwd, hasKey: m.hasKey };
        $('folder').innerHTML = `${I.folder}<span>${esc(baseName(m.cwd))}</span>`;
        $('folder').title = m.cwd;
        if (!log.querySelector('.msg')) resetLog();
        break;
      case 'keyStatus':
        state.hasKey = m.hasKey;
        log.querySelector('.welcome') && resetLog();
        break;
      case 'autoChanged':
        autoChk.checked = m.value;
        break;
      case 'modelChanged':
        if (![...modelSel.options].some((o) => o.value === m.model)) modelSel.insertAdjacentHTML('afterbegin', `<option value="${esc(m.model)}">${esc(shortName(m.model))}</option>`);
        modelSel.value = m.model;
        modelSel.title = m.model;
        modelSel.dataset.current = m.model;
        break;
      case 'models': renderModels(m.models, m.model); break;
      case 'queued': {
        // o agente recebeu as mensagens da fila
        log.querySelectorAll('.msg.user.queued').forEach((u) => { u.classList.remove('queued'); u.querySelector('.q-tag')?.remove(); });
        break;
      }
      case 'resumable': {
        hideWelcome();
        log.querySelector('.resume-card')?.remove();
        const card = el('div', 'resume-card');
        card.innerHTML = `<div class="rs-text"><b>A última tarefa foi interrompida.</b><span>O rfcode pode continuar de onde parou.</span></div>
          <div class="rs-actions"><button type="button" class="primary" data-a="go">Continuar</button><button type="button" class="ghost" data-a="drop">Descartar</button></div>`;
        card.addEventListener('click', (e) => {
          const a = e.target.closest('button')?.dataset.a;
          if (!a) return;
          card.remove();
          vscode.postMessage({ type: a === 'go' ? 'resume' : 'discardResume' });
        });
        add(card);
        scroll(true);
        break;
      }
      case 'resuming':
        log.querySelector('.resume-card')?.remove();
        setBusy(true);
        break;
      case 'mode': setMode(m.mode); break;
      case 'remote': showRemoteCard(m); break;
      case 'ask': askCard(m); break;
      case 'askDone': {
        const card = log.querySelector(`.ask-card[data-id="${m.id}"]`);
        if (card) {
          card.classList.add('answered');
          card.querySelector('.ask-opts').remove();
          card.querySelector('.ask-free').replaceWith(Object.assign(el('div', 'ask-a'), { textContent: '↳ ' + m.text }));
        }
        showSpinner('Pensando');
        break;
      }
      case 'remoteClients': {
        // celular conectou: o QR já cumpriu o papel, sai da conversa (o ícone no topo mostra de novo)
        const card = log.querySelector('.remote-card');
        if (m.connected && card) { card.remove(); note('info', 'Celular conectado ao controle remoto. O ícone de celular no topo mostra o QR code de novo.'); }
        $('remoteBtn').title = m.clients ? `Controle remoto: ${m.clients} conectado(s)` : 'Controle remoto ligado (nenhum celular conectado)';
        break;
      }
      case 'openHistory': openHistory(); break;
      case 'approvalDone': {
        const t = tools.get(m.id);
        if (t) { t.card.querySelector('.approve')?.remove(); t.card.classList.remove('wait'); }
        break;
      }
      case 'cleared':
        state.cwd = m.cwd || state.cwd;
        current = null; tools.clear(); hideSpinner(); tokens = 0;
        planEl.classList.add('hidden');
        resetLog();
        setBusy(false);
        input.focus();
        break;
      case 'user': {
        hideWelcome();
        const u = el('div', 'msg user' + (m.queued ? ' queued' : ''));
        u.appendChild(el('div', 'bubble')).textContent = m.text;
        if (m.queued) {
          // não interrompe a resposta em andamento: a mensagem fica marcada até o agente recebê-la
          u.appendChild(el('div', 'q-tag', 'na fila'));
          add(u);
          scroll(true);
          break;
        }
        setBusy(true);
        current = null;
        add(u);
        scroll(true);
        break;
      }
      case 'thinking': if (!busy) setBusy(true); showSpinner('Pensando'); break;
      case 'responseStart': hideSpinner(); break;
      case 'reasoning': {
        const c = ensureAssistant();
        if (!c.reasoning) {
          const d = el('details', 'reasoning', `<summary>${I.spark}<span>Pensando…</span></summary><div class="rt"></div>`);
          c.el.insertBefore(d, c.body);
          c.reasoning = d;
        }
        c.reasoning.querySelector('.rt').textContent += m.text;
        scroll();
        break;
      }
      case 'text': {
        const c = ensureAssistant();
        c.text += m.text;
        c.body.innerHTML = md(c.text);
        scroll();
        break;
      }
      case 'assistantEnd':
        if (current) {
          if (current.reasoning) current.reasoning.querySelector('summary span').textContent = 'Raciocínio';
          if (!current.text && !current.reasoning) current.el.remove();
        }
        current = null;
        break;
      case 'toolCall': {
        hideWelcome();
        if (m.name === 'update_plan') { showSpinner('Planejando'); break; }
        if (m.name === 'ask_user') break; // o cartão da pergunta aparece no lugar // o plano aparece fixo acima do campo
        const t = toolCard(m);
        add(t.card);
        tools.set(m.id, { ...t, name: m.name, cmdOut: null });
        if (m.name === 'run_command' || m.name === 'create_video') lastCmdTool = m.id;
        showSpinner('Executando');
        break;
      }
      case 'approval': {
        const t = tools.get(m.id);
        if (!t || t.card.querySelector('.approve')) break;
        hideSpinner();
        t.card.classList.add('wait');
        t.card.classList.remove('collapsed');
        t.card.appendChild(approvalBox(m, t));
        scroll(true);
        break;
      }
      case 'cmdOut': {
        const t = tools.get(lastCmdTool);
        if (!t) break;
        if (!t.cmdOut) {
          t.cmdOut = el('pre', 'out term');
          t.body.appendChild(t.cmdOut);
          t.card.classList.remove('empty', 'collapsed');
        }
        t.cmdOut.textContent += m.text;
        t.cmdOut.scrollTop = t.cmdOut.scrollHeight;
        scroll();
        break;
      }
      case 'toolResult': {
        const t = tools.get(m.id);
        if (!t) break;
        t.card.classList.remove('running', 'wait');
        t.card.classList.add(m.error ? 'err' : 'ok');
        t.card.querySelector('.approve')?.remove();
        if (m.error && m.output.startsWith('O usuário NEGOU')) {
          t.card.classList.add('denied', 'collapsed');
          t.card.querySelector('.meta').textContent = 'negado';
          break;
        }
        if (t.cmdOut) {
          const code = /\[exit code: (-?\d+|null)\]\s*$/.exec(m.output);
          if (code) t.card.querySelector('.meta').textContent = code[1] === '0' ? 'ok' : `saída ${code[1]}`;
          break;
        }
        const lines = m.output.split('\n');
        const meta = t.card.querySelector('.meta');
        if (!meta.textContent) meta.textContent = m.name === 'read_file' && !m.error ? `${lines.length} linhas` : '';
        if (!t.body.childNodes.length || m.error) {
          const pre = el('pre', 'out' + (m.error ? ' error' : ''));
          pre.textContent = m.output;
          t.body.appendChild(pre);
          t.card.classList.remove('empty');
        }
        if (m.error) t.card.classList.remove('collapsed');
        scroll();
        break;
      }
      case 'plan': renderPlan(m.plan); break;
      case 'usage':
        tokens = m.usage.total;
        statusEl.textContent = fmtTokens(tokens);
        break;
      case 'info': hideSpinner(); note('info', m.text); break;
      case 'error': hideSpinner(); note('error', m.text); break;
      case 'done':
        hideSpinner();
        current = null;
        setBusy(false);
        input.focus();
        break;
    }
  }
  window.addEventListener('message', (ev) => handle(ev.data));

  setBusy(false);
  autoGrow();
  vscode.postMessage({ type: 'ready' });
})();
