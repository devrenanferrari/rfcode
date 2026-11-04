// rfcode orquestra: o quadro no navegador. Sem dependências.
// Caixas (sessão, comando, nota) em um canvas infinito; arrastar do ponto de saída de uma caixa até outra cria a
// ligação (o fluxo). Tudo é gravado no servidor local do rfcode, que roda as sessões e manda os eventos ao vivo.
(function () {
  'use strict';

  // ---------- utilidades ----------
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const md = (t) => (window.rfMarkdown ? window.rfMarkdown.render(String(t || '')) : `<p>${esc(t)}</p>`);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = (p) => p + Math.random().toString(16).slice(2, 10);
  const ICON = window.RF_ICONS || {};
  const SVG = {
    dots: '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4.5 3v10l8-5z" fill="currentColor"/></svg>',
    playFrom: '<svg viewBox="0 0 16 16" width="13" height="11"><path d="M2 3v10l6-5zM8.5 3v10l6-5z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 16 16" width="10" height="10"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    open: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M9.5 2.5h4v4M13.5 2.5L8 8M6.5 3.5h-3v9h9v-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    up: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 12.5V3.5M4 7.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const STATUS = { ociosa: 'parada', fila: 'na fila', rodando: 'rodando', concluida: 'concluída', falhou: 'falhou', cancelada: 'cancelada', pulada: 'pulada', aguardando: 'aguardando você' };
  const QUANDO = { sucesso: 'se der certo', falha: 'se falhar', sempre: 'sempre' };
  const NEXT_Q = { sucesso: 'falha', falha: 'sempre', sempre: 'sucesso' };
  const WIDTH = { sessao: 300, comando: 300, nota: 260 };
  const PORT_Y = 21;
  const REPO_COLORS = ['#76b900', '#4ea1ff', '#e3b341', '#c678dd', '#56b6c2', '#f2555a', '#ff9f43', '#9be22d'];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
  };

  // ---------- token e quadro do link ----------
  // alguns abridores de link (o do VS Code, por exemplo) codificam o # inteiro: "t%3D...%26q%3D..."
  let rawHash = location.hash.slice(1);
  if (!/[=&]/.test(rawHash)) { try { rawHash = decodeURIComponent(rawHash); } catch { /* fica como veio */ } }
  const hp = new URLSearchParams(rawHash);
  let TOKEN = hp.get('t') || '';
  try { if (TOKEN) sessionStorage.setItem('rf-orq-t', TOKEN); else TOKEN = sessionStorage.getItem('rf-orq-t') || ''; } catch { /* sem storage */ }
  const wanted = hp.get('q') || store.get('rf-orq-q');
  history.replaceState(null, '', location.pathname + (wanted ? `#q=${encodeURIComponent(wanted)}` : ''));

  // ---------- estado ----------
  const S = {
    q: null, quadros: [], modelos: [], tpls: [], home: '', sep: '/',
    rodando: false, pendentes: new Map(), logs: new Map(), act: new Map(),
    sel: null, aberta: null, tab: 'conversa', view: { x: 0, y: 0, zoom: 1 },
    saveTimer: null, saving: null, conn: false,
  };
  const els = {
    viewport: $('#viewport'), world: $('#world'), nodes: $('#nodes'), edgeG: $('#edgeG'), ghost: $('#ghost'), drawer: $('#drawer'),
    empty: $('#empty'), repos: $('#repos'), boardName: $('#boardName'), boardMenu: $('#boardMenu'), saveState: $('#saveState'),
    paralelo: $('#paralelo'), runAll: $('#runAll'), stopAll: $('#stopAll'), counts: $('#counts'), conn: $('#conn'), modal: $('#modal'), toast: $('#toast'),
  };
  const byId = (id) => (S.q ? S.q.caixas.find((c) => c.id === id) : null);
  const repoOf = (c) => (S.q && c ? S.q.repos.find((r) => r.id === c.repo) : null);
  const repoColor = (r) => REPO_COLORS[Math.max(0, S.q.repos.indexOf(r)) % REPO_COLORS.length];
  const runnable = (c) => c && c.tipo !== 'nota';
  const pendFor = (id) => [...S.pendentes.values()].filter((p) => p.caixa === id);

  // ---------- API ----------
  async function api(method, url, body, opts) {
    const r = await fetch(url, {
      method, headers: { 'X-RF-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, keepalive: !!(opts && opts.keepalive),
    });
    let j = {};
    try { j = await r.json(); } catch { /* sem corpo */ }
    if (r.status === 401) { fatal('O link expirou (o rfcode foi reiniciado). Abra a orquestra de novo pelo rfcode para receber um link novo.'); throw new Error('token'); }
    if (!r.ok) throw new Error(j.erro || `erro ${r.status}`);
    return j;
  }

  let toastTimer = null;
  function toast(text, bad) {
    els.toast.textContent = text;
    els.toast.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), bad ? 6000 : 3200);
  }
  function fatal(text) {
    els.empty.classList.remove('hidden');
    els.empty.replaceChildren(h('h2', { text: 'Sem acesso' }), h('p', { text }));
  }

  // ---------- gravação ----------
  function markDirty(delay = 500) {
    els.saveState.textContent = 'alterações…';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, delay);
  }
  async function save() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    if (!S.q) return;
    const q = S.q;
    const body = { quadro: { ...q, view: { ...S.view } } };
    const p = api('PUT', `/api/quadros/${q.id}`, body, { keepalive: JSON.stringify(body).length < 60000 }).then((r) => {
      if (S.q !== q) return;
      els.saveState.textContent = 'salvo';
      if (r.ligacoes !== q.ligacoes.length) reloadBoard();
    }).catch((e) => { if (e.message !== 'token') { els.saveState.textContent = 'não salvou'; toast(`Não consegui salvar: ${e.message}`, true); } });
    S.saving = p;
    return p;
  }
  async function flushSave() {
    if (S.saveTimer) await save();
    else if (S.saving) await S.saving;
  }

  // ---------- quadros ----------
  async function boot() {
    if (!TOKEN) return fatal('Link sem token. Abra pelo rfcode (rfcode orquestra, ou /orquestra no painel) para receber o link de acesso.');
    let st;
    try { st = await api('GET', '/api/estado'); } catch (e) { if (e.message !== 'token') fatal(`Não consegui falar com o rfcode: ${e.message}`); return; }
    S.modelos = st.modelos || []; S.tpls = st.modelosQuadro || []; S.home = st.home || ''; S.sep = st.sep || '/'; S.quadros = st.quadros || [];
    const id = wanted && S.quadros.some((q) => q.id === wanted) ? wanted : S.quadros[0] && S.quadros[0].id;
    if (id) await openBoard(id);
    else await createBoard({ nome: 'Meu primeiro quadro', modelo: 'vazio', repos: [] });
    connectEvents();
    setInterval(tick, 1000);
  }

  async function openBoard(id) {
    await flushSave();
    const snap = await api('GET', `/api/quadros/${id}`);
    applySnapshot(snap);
    store.set('rf-orq-q', id);
    history.replaceState(null, '', `${location.pathname}#q=${encodeURIComponent(id)}`);
  }
  async function reloadBoard() { if (S.q) applySnapshot(await api('GET', `/api/quadros/${S.q.id}`)); }

  function applySnapshot(snap) {
    const first = !S.q || S.q.id !== snap.quadro.id;
    S.q = snap.quadro;
    S.rodando = !!snap.rodando;
    S.pendentes = new Map((snap.pendentes || []).map((p) => [p.id, p]));
    if (first) { S.logs.clear(); S.act.clear(); S.sel = null; closeDrawer(); }
    // a câmera é de cada navegador (o celular e o PC enquadram diferente): primeira vez neste navegador = ver tudo
    let local = null;
    try { local = JSON.parse(store.get(`rf-orq-view:${S.q.id}`) || 'null'); } catch { /* sem câmera salva */ }
    if (first || !S.view) S.view = local && Number.isFinite(local.zoom) ? local : { ...S.q.view };
    renderAll();
    if (first && !local && S.q.caixas.length) requestAnimationFrame(fit);
  }

  async function createBoard({ nome, modelo, repos }) {
    const snap = await api('POST', '/api/quadros', { nome, modelo, repos });
    S.quadros = (await api('GET', '/api/quadros')).quadros;
    applySnapshot(snap);
    store.set('rf-orq-q', snap.quadro.id);
    history.replaceState(null, '', `${location.pathname}#q=${encodeURIComponent(snap.quadro.id)}`);
    requestAnimationFrame(fit);
  }

  // ---------- eventos ao vivo ----------
  let es = null;
  function connectEvents() {
    if (es) es.close();
    es = new EventSource(`/api/eventos?t=${encodeURIComponent(TOKEN)}`);
    let first = true;
    es.onopen = () => {
      setConn(true);
      // reconectou (o rfcode caiu ou a rede voltou): grava o que estava pendente e pega o estado atual
      if (!first && S.q) flushSave().then(reloadBoard).catch(() => {});
      first = false;
    };
    es.onerror = () => { setConn(false); if (es.readyState === 2) setTimeout(connectEvents, 2500); };
    es.onmessage = (e) => { let ev; try { ev = JSON.parse(e.data); } catch { return; } onEvent(ev); };
  }
  function setConn(on) {
    S.conn = on;
    els.conn.textContent = on ? 'conectado ao rfcode' : 'sem conexão com o rfcode… tentando de novo';
    els.conn.className = `conn ${on ? 'on' : 'off'}`;
  }

  function onEvent(ev) {
    if (!S.q || ev.quadro !== S.q.id) return;
    if (ev.type === 'caixa') {
      const c = byId(ev.caixa);
      if (!c) return;
      for (const [k, v] of Object.entries(ev.campos || {})) { if (v === null) delete c[k]; else c[k] = v; }
      // execução nova (não é continuação da conversa): começa a conversa do zero
      const fresh = ev.campos && ev.campos.status === 'rodando' && ev.campos.resultado === null;
      if (fresh) { S.act.delete(c.id); S.logs.set(c.id, []); if (S.aberta === c.id && S.tab === 'conversa') renderLog(); }
      updateNode(c);
      renderEdges();
      updateCounts();
      if (S.aberta === c.id) refreshDrawer(Object.keys(ev.campos || {}));
    } else if (ev.type === 'log') {
      addLog(ev.caixa, ev.ev);
    } else if (ev.type === 'pedido') {
      S.pendentes.set(ev.pedido.id, ev.pedido);
      const c = byId(ev.caixa);
      if (c) updateNode(c);
      if (S.aberta === ev.caixa) renderPending();
      updateCounts();
    } else if (ev.type === 'pedidoFim') {
      S.pendentes.delete(ev.id);
      const c = byId(ev.caixa);
      if (c) updateNode(c);
      if (S.aberta === ev.caixa) renderPending();
      updateCounts();
    } else if (ev.type === 'execucao') {
      S.rodando = !!ev.rodando;
      updateRunButtons();
      renderEdges();
      if (!ev.rodando) {
        const done = S.q.caixas.filter(runnable);
        const bad = done.filter((c) => c.status === 'falhou').length;
        toast(bad ? `Fluxo terminou: ${bad} caixa${bad > 1 ? 's falharam' : ' falhou'}.` : 'Fluxo terminou.', !!bad);
      }
    }
  }

  // ---------- conversa de cada caixa ----------
  function addLog(id, ev) {
    if (!S.logs.has(id)) S.logs.set(id, []);
    const list = S.logs.get(id);
    const last = list[list.length - 1];
    let merged = false;
    if (last && (ev.type === 'text' || ev.type === 'output') && last.type === ev.type && !last.closed) { last.text = (last.text + ev.text).slice(-60000); merged = true; }
    else list.push({ ...ev });
    if (ev.type === 'assistantEnd' && last && last.type === 'text') last.closed = true;
    if (ev.type === 'toolResult') { const call = list.find((x) => x.type === 'toolCall' && x.id === ev.id); if (call) call.result = ev; }
    // última atividade no cartão
    const line = activityOf(merged ? last : ev);
    if (line) { S.act.set(id, line); const c = byId(id); if (c) updateActivity(c); }
    if (S.aberta === id && S.tab === 'conversa') appendLogDom(ev, merged ? last : null);
  }
  function activityOf(ev) {
    const lastLine = (t) => String(t || '').trim().split('\n').filter(Boolean).pop() || '';
    if (ev.type === 'toolCall') return { text: `› ${ev.label || ev.name}` };
    if (ev.type === 'text') return { text: lastLine(ev.text).replace(/[#*`>]/g, '').replace(/^\s*([-+]|\d+\.)\s+/, '').slice(0, 200) };
    if (ev.type === 'output') return { text: lastLine(ev.text).slice(0, 200) };
    if (ev.type === 'error') return { text: ev.text, err: true };
    if (ev.type === 'info') return { text: ev.text };
    if (ev.type === 'plan' && ev.plan) { const a = (ev.plan.steps || []).find((s) => s.status === 'active'); return a ? { text: `plano: ${a.text}` } : null; }
    return null;
  }

  // ---------- desenho do quadro ----------
  function renderAll() {
    els.boardName.textContent = S.q.nome;
    els.paralelo.value = String(S.q.config.paralelo || 3);
    document.title = `${S.q.nome} · rfcode orquestra`;
    renderRepos();
    els.nodes.replaceChildren();
    for (const c of S.q.caixas) els.nodes.append(nodeEl(c));
    for (const c of S.q.caixas) updateNode(c);
    setView();
    renderEdges();
    updateRunButtons();
    updateCounts();
    renderEmpty();
    if (S.aberta && !byId(S.aberta)) closeDrawer();
  }

  function renderEmpty() {
    const e = els.empty;
    if (!S.q.repos.length) {
      e.replaceChildren(
        h('h2', { text: 'Conecte um repositório para começar' }),
        h('p', { text: 'Cada caixinha de sessão trabalha num repositório. Dá para conectar vários e misturar no mesmo fluxo.' }),
        h('div', { class: 'acts' },
          h('button', { class: 'btn primary', type: 'button', onclick: openRepoModal, html: `${SVG.plus}<span>Conectar repositório</span>` }),
          h('button', { class: 'btn', type: 'button', onclick: () => openNewBoardModal(), text: 'Começar com um modelo de fluxo' })),
      );
      e.classList.remove('hidden');
    } else if (!S.q.caixas.length) {
      e.replaceChildren(
        h('h2', { text: 'Puxe uma caixinha para o quadro' }),
        h('p', { text: 'Arraste uma Sessão, um Comando ou uma Nota da barra à esquerda. Depois ligue as caixas: o que não está ligado roda em paralelo; o que está ligado roda em sequência.' }),
        h('div', { class: 'acts' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => { const p = centerWorld(); createNode('sessao', p.x - 150, p.y - 90); }, html: `${SVG.plus}<span>Nova sessão</span>` }),
          h('button', { class: 'btn', type: 'button', onclick: () => openNewBoardModal(), text: 'Usar um modelo de fluxo' })),
      );
      e.classList.remove('hidden');
    } else e.classList.add('hidden');
  }

  function renderRepos() {
    const list = S.q.repos.map((r) => h('span', { class: 'repo-chip', title: `${r.caminho}${r.url ? `\n${r.url}` : ''}` },
      h('span', { class: 'dot', style: `background:${repoColor(r)}` }),
      h('span', { class: 'nm', text: r.nome }),
      r.branch ? h('span', { class: 'br', text: r.branch }) : null,
      h('button', { class: 'x', type: 'button', title: 'Desconectar do quadro', 'aria-label': `Desconectar ${r.nome}`, html: SVG.close, onclick: () => removeRepo(r) })));
    els.repos.replaceChildren(...list, h('button', { class: 'add-repo', type: 'button', onclick: openRepoModal, html: `${SVG.plus}<span>Repositório</span>` }));
    for (const c of S.q.caixas) { const el = nodeDom(c.id); if (el && runnable(c)) fillRepoSelect($('.nrepo', el), c); }
  }

  function removeRepo(r) {
    const used = S.q.caixas.filter((c) => c.repo === r.id);
    if (used.length && !confirm(`${used.length} caixa${used.length > 1 ? 's usam' : ' usa'} ${r.nome}. Desconectar mesmo assim? Os arquivos não são apagados.`)) return;
    S.q.repos = S.q.repos.filter((x) => x !== r);
    for (const c of used) c.repo = null;
    renderRepos();
    for (const c of used) updateNode(c);
    renderEmpty();
    markDirty(0);
  }

  function fillRepoSelect(sel, c) {
    if (!sel) return;
    const cur = c.repo || '';
    const sig = S.q.repos.map((r) => `${r.id}:${r.nome}:${r.branch || ''}`).join('|');
    // só refaz as opções quando os repositórios mudam (refazer fecharia o menu aberto a cada evento)
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.replaceChildren(h('option', { value: '', text: S.q.repos.length ? 'Escolha o repositório…' : 'Conecte um repositório (barra de cima)' }),
        ...S.q.repos.map((r) => h('option', { value: r.id, text: `● ${r.nome}${r.branch ? ` (${r.branch})` : ''}` })));
    }
    if (sel.value !== cur) sel.value = cur;
    sel.classList.toggle('missing', !cur);
    const r = repoOf(c);
    sel.style.color = r ? repoColor(r) : '';
  }

  const nodeDom = (id) => els.nodes.querySelector(`.node[data-id="${CSS.escape(id)}"]`);

  function nodeEl(c) {
    const el = h('div', { class: `node t-${c.tipo}`, 'data-id': c.id });
    const head = h('div', { class: 'nhead' },
      h('span', { class: 'ticon', html: ICON[c.tipo] || '' }),
      h('span', { class: 'ntitle', title: 'Duplo clique para renomear' }),
      runnable(c) ? h('span', { class: 'pill' }) : null,
      h('button', { class: 'nbtn more', type: 'button', title: 'Mais ações', 'aria-label': 'Mais ações', html: SVG.dots }));
    el.append(h('div', { class: 'port in', title: 'Entrada: solte aqui uma ligação' }), h('div', { class: 'port out', title: 'Saída: arraste até outra caixa para ligar' }), head);
    const body = h('div', { class: 'nbody' });
    if (c.tipo === 'nota') {
      body.append(h('textarea', { class: 'ntext', rows: '6', placeholder: 'Markdown. As sessões ligadas a esta nota leem e podem escrever aqui (plano, decisões, especificação).', spellcheck: 'false' }));
    } else {
      body.append(h('select', { class: 'nrepo', 'aria-label': 'Repositório' }));
      if (c.tipo === 'sessao') {
        body.append(h('textarea', { class: 'nprompt', rows: '3', placeholder: 'O que esta sessão deve fazer? (Ctrl+Enter roda)' }));
        body.append(h('div', { class: 'flags' },
          h('button', { class: 'flag', type: 'button', 'data-f': 'isolar', title: 'Trabalha numa git worktree, numa branch só dela. Use quando várias sessões mexem no mesmo repositório em paralelo.', text: 'branch própria' }),
          h('button', { class: 'flag', type: 'button', 'data-f': 'auto', title: 'Aprova sozinha edições e comandos (regras deny continuam valendo)', text: 'auto' }),
          h('button', { class: 'flag model', type: 'button', title: 'Modelo e esforço (abre a configuração)' })));
      } else {
        body.append(h('input', { class: 'ncmd', placeholder: 'npm test', spellcheck: 'false', 'aria-label': 'Comando' }));
      }
      body.append(h('div', { class: 'nask hidden' }), h('div', { class: 'nact' }));
    }
    el.append(body);
    if (runnable(c)) {
      el.append(h('div', { class: 'nfoot' },
        h('button', { class: 'ibtn go run', type: 'button', title: 'Rodar só esta caixa', html: `${SVG.play}<span>Rodar</span>` }),
        h('button', { class: 'ibtn go runFrom', type: 'button', title: 'Rodar esta caixa e o que vem depois dela', html: SVG.playFrom }),
        h('button', { class: 'ibtn stop hidden', type: 'button', title: 'Parar esta caixa', html: `${SVG.stop}<span>Parar</span>` }),
        h('span', { class: 'meta' }),
        h('button', { class: 'ibtn open', type: 'button', title: 'Abrir a conversa e a configuração', html: SVG.open })));
    }
    wireNode(el, c.id);
    return el;
  }

  function wireNode(el, id) {
    const c0 = () => byId(id);
    const title = $('.ntitle', el);
    title.addEventListener('dblclick', (e) => { e.stopPropagation(); editTitle(title, id); });
    $('.more', el).addEventListener('click', (e) => { e.stopPropagation(); nodeMenu(id, e.currentTarget); });
    const text = $('.ntext', el), prompt = $('.nprompt', el), cmd = $('.ncmd', el), repo = $('.nrepo', el);
    if (text) text.addEventListener('input', () => { const c = c0(); c.texto = text.value; autosize(text, 360); markDirty(); });
    if (prompt) {
      prompt.addEventListener('input', () => { const c = c0(); c.prompt = prompt.value; autosize(prompt, 220); markDirty(); });
      prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runNodes([id], 'so'); } });
    }
    if (cmd) {
      cmd.addEventListener('input', () => { c0().comando = cmd.value; markDirty(); });
      cmd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runNodes([id], 'so'); } });
    }
    if (repo) repo.addEventListener('change', () => { const c = c0(); c.repo = repo.value || null; fillRepoSelect(repo, c); markDirty(0); });
    for (const f of $$('.flag[data-f]', el)) f.addEventListener('click', () => { const c = c0(); c[f.dataset.f] = !c[f.dataset.f]; updateNode(c); markDirty(0); });
    const model = $('.flag.model', el);
    if (model) model.addEventListener('click', () => openDrawer(id, 'config'));
    const q = (s) => $(s, el);
    if (q('.run')) q('.run').addEventListener('click', () => runNodes([id], 'so'));
    if (q('.runFrom')) q('.runFrom').addEventListener('click', () => runNodes([id], 'daqui'));
    if (q('.stop')) q('.stop').addEventListener('click', () => stopNode(id));
    if (q('.open')) q('.open').addEventListener('click', () => openDrawer(id));
    // arrastar a caixa (pelo cabeçalho ou pelo fundo do cartão) e ligar pelos pontos
    el.addEventListener('pointerdown', (e) => onNodePointerDown(e, id));
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('input,textarea,select,button,.ntitle')) openDrawer(id); });
  }

  function editTitle(span, id) {
    span.contentEditable = 'true';
    span.focus();
    document.getSelection().selectAllChildren(span);
    const done = (commit) => {
      span.contentEditable = 'false';
      const c = byId(id);
      if (!c) return;
      const t = span.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (commit && t) { c.titulo = t; markDirty(0); if (S.aberta === id) refreshDrawer(['titulo']); }
      span.textContent = c.titulo;
    };
    span.addEventListener('keydown', function k(e) {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { span.removeEventListener('keydown', k); done(false); }
    });
    span.addEventListener('blur', () => done(true), { once: true });
  }

  function autosize(t, max) { t.style.height = 'auto'; t.style.height = `${Math.min(max, t.scrollHeight + 2)}px`; }

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}min ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}min`;
  }
  const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} mil tokens` : `${n} tokens`);
  function metaOf(c) {
    const parts = [];
    if (c.branch) parts.push(c.branch);
    if (c.inicio) {
      const end = c.status === 'rodando' ? Date.now() : Date.parse(c.fim || c.inicio);
      if (c.status === 'rodando' || c.fim) parts.push(fmtDur(end - Date.parse(c.inicio)));
    }
    if (c.tokens) parts.push(fmtTok(c.tokens));
    return parts.join(' · ');
  }

  function updateNode(c) {
    const el = nodeDom(c.id);
    if (!el) return;
    el.style.transform = `translate(${c.x}px, ${c.y}px)`;
    const waiting = pendFor(c.id).length > 0;
    const st = runnable(c) ? c.status || 'ociosa' : '';
    el.className = `node t-${c.tipo}${st ? ` s-${st}` : ''}${waiting ? ' waiting' : ''}${S.sel && S.sel.tipo === 'caixa' && S.sel.id === c.id ? ' sel' : ''}`;
    const title = $('.ntitle', el);
    if (title.contentEditable !== 'true') title.textContent = c.titulo;
    const pill = $('.pill', el);
    if (pill) { const k = waiting ? 'aguardando' : st; pill.className = `pill s-${k}`; pill.textContent = STATUS[k] || k; }
    const set = (sel, v) => { const x = $(sel, el); if (x && document.activeElement !== x && x.value !== v) { x.value = v; if (x.tagName === 'TEXTAREA') autosize(x, x.classList.contains('ntext') ? 360 : 220); } };
    if (c.tipo === 'nota') set('.ntext', c.texto || '');
    else {
      fillRepoSelect($('.nrepo', el), c);
      if (c.tipo === 'sessao') {
        set('.nprompt', c.prompt || '');
        for (const f of $$('.flag[data-f]', el)) f.classList.toggle('on', !!c[f.dataset.f]);
        const model = $('.flag.model', el);
        const m = c.modelo ? c.modelo.split('/').pop() : 'modelo padrão';
        model.textContent = `${m}${c.esforco ? ` · ${{ low: 'baixo', medium: 'médio', high: 'alto' }[c.esforco]}` : ''}`;
      } else set('.ncmd', c.comando || '');
      const busy = c.status === 'rodando' || c.status === 'fila';
      $('.run', el).classList.toggle('hidden', busy);
      $('.runFrom', el).classList.toggle('hidden', busy);
      $('.stop', el).classList.toggle('hidden', !busy);
      $('.meta', el).textContent = metaOf(c);
      updateActivity(c);
      renderNodeAsk(c, el);
    }
  }

  function updateActivity(c) {
    const el = nodeDom(c.id);
    const box = el && $('.nact', el);
    if (!box) return;
    let a = S.act.get(c.id);
    if (!a && c.status !== 'rodando') {
      if (c.erro && (c.status === 'falhou' || c.status === 'pulada' || c.status === 'cancelada')) a = { text: c.erro, err: c.status === 'falhou' };
      else if (c.resultado) a = { text: (c.resultado.replace(/[#*`>]/g, '').trim().split('\n').filter(Boolean).slice(-1)[0] || '').replace(/^\s*([-+]|\d+\.)\s+/, '') };
    }
    box.textContent = a ? a.text : c.status === 'rodando' ? 'começando…' : '';
    box.classList.toggle('err', !!(a && a.err));
  }

  function renderNodeAsk(c, el) {
    const box = $('.nask', el);
    const ps = pendFor(c.id);
    box.classList.toggle('hidden', !ps.length);
    if (!ps.length) { box.replaceChildren(); return; }
    const p = ps[0];
    const more = ps.length > 1 ? ` (+${ps.length - 1})` : '';
    if (p.tipo === 'aprovacao') {
      box.replaceChildren(
        h('div', { class: 'q', html: `<b>Aprovar?</b> ${esc(p.label || p.nome)}${more}` }),
        h('div', { class: 'acts' },
          h('button', { class: 'ibtn go', type: 'button', text: 'Aprovar', onclick: () => answer(p.id, 'yes') }),
          h('button', { class: 'ibtn stop', type: 'button', text: 'Negar', onclick: () => answer(p.id, 'no') }),
          h('button', { class: 'ibtn', type: 'button', text: 'Ver', onclick: () => openDrawer(c.id, 'conversa') })));
    } else {
      box.replaceChildren(h('div', { class: 'q', html: `<b>Pergunta:</b> ${esc(p.pergunta)}${more}` }),
        h('div', { class: 'acts' }, h('button', { class: 'ibtn', type: 'button', text: 'Responder', onclick: () => openDrawer(c.id, 'conversa') })));
    }
  }

  function tick() {
    if (!S.q) return;
    for (const c of S.q.caixas) {
      if (c.status !== 'rodando') continue;
      const el = nodeDom(c.id);
      if (el) $('.meta', el).textContent = metaOf(c);
    }
    if (S.aberta) { const c = byId(S.aberta); if (c && c.status === 'rodando') refreshDrawer(['tempo']); }
  }

  function updateRunButtons() {
    els.stopAll.classList.toggle('hidden', !S.rodando);
    els.runAll.querySelector('span').textContent = S.rodando ? 'Rodando…' : 'Rodar fluxo';
  }

  function updateCounts() {
    if (!S.q) return;
    const n = {};
    for (const c of S.q.caixas) if (runnable(c)) n[c.status || 'ociosa'] = (n[c.status || 'ociosa'] || 0) + 1;
    const parts = [];
    if (n.rodando) parts.push(`<b>${n.rodando}</b> rodando`);
    if (S.pendentes.size) parts.push(`<b>${S.pendentes.size}</b> aguardando você`);
    if (n.fila) parts.push(`<b>${n.fila}</b> na fila`);
    if (n.concluida) parts.push(`<b>${n.concluida}</b> concluída${n.concluida > 1 ? 's' : ''}`);
    if (n.falhou) parts.push(`<b>${n.falhou}</b> falhou`);
    const total = S.q.caixas.filter(runnable).length;
    els.counts.innerHTML = total ? `${total} caixa${total > 1 ? 's' : ''}${parts.length ? ` · ${parts.join(' · ')}` : ''}` : '';
    document.title = `${S.pendentes.size ? `(${S.pendentes.size}) ` : ''}${S.q.nome} · rfcode orquestra`;
  }

  // ---------- ligações ----------
  const outPort = (c) => ({ x: c.x + (WIDTH[c.tipo] || 300), y: c.y + PORT_Y });
  const inPort = (c) => ({ x: c.x, y: c.y + PORT_Y });
  function curve(a, b) {
    const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
    const c1 = { x: a.x + dx, y: a.y }, c2 = { x: b.x - dx, y: b.y };
    return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 } };
  }
  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }

  function renderEdges() {
    if (!S.q) return;
    els.edgeG.replaceChildren();
    for (const l of $$('.elabel', els.nodes)) l.remove();
    for (const e of S.q.ligacoes) {
      const a = byId(e.de), b = byId(e.para);
      if (!a || !b) continue;
      const { d, mid } = curve(outPort(a), inPort(b));
      const nota = a.tipo === 'nota' || b.tipo === 'nota';
      const kind = nota ? 'nota' : e.quando;
      const sel = S.sel && S.sel.tipo === 'ligacao' && S.sel.id === e.id;
      const flow = !nota && a.status === 'rodando';
      const dim = !nota && (b.status === 'pulada' || (FINAL_DONE(a) && !okEdge(e.quando, a.status)));
      const path = svgEl('path', { d, class: `edge e-${kind}${sel ? ' sel' : ''}${flow ? ' flow' : ''}${dim ? ' dim' : ''}` });
      if (!nota) path.setAttribute('marker-end', `url(#arr-${e.quando})`);
      const hit = svgEl('path', { d, class: 'edge-hit' });
      hit.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); select({ tipo: 'ligacao', id: e.id }); });
      els.edgeG.append(path, hit);
      const lab = h('div', { class: `elabel q-${kind}${sel ? ' sel' : ''}`, style: `left:${mid.x}px;top:${mid.y}px`, title: nota ? 'Ligação com nota: a sessão lê e escreve nela' : 'Clique para trocar quando o fluxo segue' },
        h('span', { text: nota ? 'nota' : QUANDO[e.quando] }),
        h('button', { class: 'ex', type: 'button', title: 'Remover ligação', 'aria-label': 'Remover ligação', text: '×', onclick: (ev) => { ev.stopPropagation(); removeEdge(e.id); } }));
      lab.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      lab.addEventListener('click', () => {
        if (!nota) { e.quando = NEXT_Q[e.quando]; markDirty(0); }
        select({ tipo: 'ligacao', id: e.id });
      });
      els.nodes.append(lab);
    }
  }
  const FINAL_DONE = (c) => ['concluida', 'falhou', 'cancelada', 'pulada'].includes(c.status);
  function okEdge(quando, st) { return quando === 'falha' ? st === 'falhou' : quando === 'sempre' ? st === 'concluida' || st === 'falhou' : st === 'concluida'; }

  function wouldCycle(de, para) {
    if (de === para) return true;
    const a = byId(de), b = byId(para);
    if (!runnable(a) || !runnable(b)) return false;
    const deps = S.q.ligacoes.filter((e) => runnable(byId(e.de)) && runnable(byId(e.para)));
    const seen = new Set(), stack = [para];
    while (stack.length) {
      const x = stack.pop();
      if (x === de) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const e of deps) if (e.de === x) stack.push(e.para);
    }
    return false;
  }
  function canConnect(de, para) {
    if (!de || !para || de === para) return 'mesma caixa';
    if (S.q.ligacoes.some((e) => (e.de === de && e.para === para))) return 'já estão ligadas';
    if (byId(de).tipo === 'nota' && byId(para).tipo === 'nota') return 'nota com nota não faz nada';
    if (wouldCycle(de, para)) return 'criaria um ciclo (o fluxo voltaria para trás)';
    return '';
  }
  function connect(de, para) {
    const why = canConnect(de, para);
    if (why) { if (why !== 'mesma caixa') toast(`Não liguei: ${why}.`, true); return null; }
    const e = { id: uid('l'), de, para, quando: 'sucesso' };
    S.q.ligacoes.push(e);
    renderEdges();
    markDirty(0);
    return e;
  }
  function removeEdge(id) {
    S.q.ligacoes = S.q.ligacoes.filter((e) => e.id !== id);
    if (S.sel && S.sel.id === id) S.sel = null;
    renderEdges();
    markDirty(0);
  }

  // ---------- seleção e caixas ----------
  function select(sel) {
    const prev = S.sel;
    S.sel = sel;
    if (prev && prev.tipo === 'caixa') { const c = byId(prev.id); if (c) updateNode(c); }
    if (sel && sel.tipo === 'caixa') { const c = byId(sel.id); if (c) updateNode(c); }
    if ((prev && prev.tipo === 'ligacao') || (sel && sel.tipo === 'ligacao')) renderEdges();
  }

  function nextTitle(tipo) {
    const base = { sessao: 'Sessão', comando: 'Comando', nota: 'Nota' }[tipo];
    let n = S.q.caixas.filter((c) => c.tipo === tipo).length + 1;
    while (S.q.caixas.some((c) => c.titulo === `${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  function createNode(tipo, x, y, extra = {}) {
    const c = { id: uid('c'), tipo, titulo: nextTitle(tipo), x: Math.round(x / 8) * 8, y: Math.round(y / 8) * 8 };
    if (tipo === 'nota') c.texto = '';
    else { c.repo = (S.q.repos[0] && S.q.repos[0].id) || null; c.status = 'ociosa'; }
    if (tipo === 'sessao') Object.assign(c, { prompt: '', modelo: '', esforco: '', auto: false, isolar: false });
    if (tipo === 'comando') Object.assign(c, { comando: '', limite: 30 });
    Object.assign(c, extra);
    S.q.caixas.push(c);
    els.nodes.append(nodeEl(c));
    updateNode(c);
    select({ tipo: 'caixa', id: c.id });
    renderEmpty();
    updateCounts();
    markDirty(0);
    const el = nodeDom(c.id);
    const f = el && ($('.nprompt', el) || $('.ncmd', el) || $('.ntext', el));
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
    return c;
  }

  // Lugar livre à direita de uma caixa (para "puxar" a próxima etapa do fluxo).
  function spotRightOf(c) {
    let x = c.x + (WIDTH[c.tipo] || 300) + 90, y = c.y;
    for (let i = 0; i < 20 && S.q.caixas.some((o) => Math.abs(o.x - x) < 200 && Math.abs(o.y - y) < 150); i++) y += 170;
    return { x, y };
  }

  function removeNode(id) {
    const c = byId(id);
    if (!c) return;
    if ((c.status === 'rodando' || c.status === 'fila') && !confirm(`"${c.titulo}" está ${STATUS[c.status]}. Parar e excluir?`)) return;
    S.q.caixas = S.q.caixas.filter((x) => x.id !== id);
    S.q.ligacoes = S.q.ligacoes.filter((e) => e.de !== id && e.para !== id);
    const el = nodeDom(id);
    if (el) el.remove();
    if (S.aberta === id) closeDrawer();
    if (S.sel && S.sel.id === id) S.sel = null;
    renderEdges();
    renderEmpty();
    updateCounts();
    markDirty(0);
  }

  function duplicateNode(id) {
    const c = byId(id);
    if (!c) return;
    const copy = { ...c };
    for (const k of ['status', 'resultado', 'erro', 'sessao', 'branch', 'pasta', 'inicio', 'fim', 'tokens', 'codigo']) delete copy[k];
    delete copy.id;
    createNode(c.tipo, c.x + 32, c.y + 32, { ...copy, titulo: `${c.titulo} (cópia)` });
  }

  function nodeMenu(id, anchor) {
    const c = byId(id);
    const items = [];
    if (runnable(c)) {
      items.push(['Rodar só esta', () => runNodes([id], 'so')], ['Rodar a partir daqui', () => runNodes([id], 'daqui')]);
      if (c.tipo === 'sessao') items.push(['Puxar próxima sessão ligada', () => { const p = spotRightOf(c); const n = createNode('sessao', p.x, p.y, { repo: c.repo }); connect(c.id, n.id); }]);
      items.push(['Puxar comando ligado (testes)', () => { const p = spotRightOf(c); const n = createNode('comando', p.x, p.y, { repo: c.repo, comando: 'npm test', titulo: 'Testes' }); connect(c.id, n.id); }]);
      items.push(null);
    }
    items.push(['Abrir', () => openDrawer(id)], ['Duplicar (Ctrl+D)', () => duplicateNode(id)], null, ['Excluir (Delete)', () => removeNode(id), 'danger']);
    popMenu(anchor, items);
  }

  let menuEl = null;
  function popMenu(anchor, items) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    menuEl = h('div', { class: 'menu', role: 'menu', style: 'position:fixed' },
      ...items.map((it) => (it ? h('button', { class: `mi${it[2] ? ` ${it[2]}` : ''}`, type: 'button', role: 'menuitem', onclick: () => { closeMenu(); it[1](); } }, h('span', { class: 't', text: it[0] })) : h('div', { class: 'sep' }))));
    document.body.append(menuEl);
    const w = menuEl.offsetWidth, hh = menuEl.offsetHeight;
    menuEl.style.left = `${clamp(r.right - w, 8, innerWidth - w - 8)}px`;
    menuEl.style.top = `${r.bottom + 6 + hh > innerHeight ? Math.max(8, r.top - hh - 6) : r.bottom + 6}px`;
    setTimeout(() => document.addEventListener('pointerdown', outsideMenu), 0);
  }
  function outsideMenu(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('pointerdown', outsideMenu); }

  // ---------- rodar ----------
  async function runNodes(ids, modo) {
    if (!S.q) return;
    await flushSave();
    const targets = modo === 'tudo' ? S.q.caixas.filter(runnable) : ids.map(byId).filter(runnable);
    if (!targets.length) { toast(modo === 'tudo' ? 'Não há caixas de sessão ou comando para rodar.' : 'Nada para rodar.', true); return; }
    if (!S.q.repos.length) { openRepoModal(); toast('Conecte um repositório primeiro.', true); return; }
    const sem = targets.filter((c) => !c.repo);
    if (sem.length) {
      select({ tipo: 'caixa', id: sem[0].id });
      toast(`Escolha o repositório de "${sem[0].titulo}"${sem.length > 1 ? ` e de mais ${sem.length - 1}` : ''}.`, true);
      return;
    }
    const vazio = targets.filter((c) => (c.tipo === 'sessao' && !String(c.prompt || '').trim()) || (c.tipo === 'comando' && !String(c.comando || '').trim()));
    if (vazio.length) {
      select({ tipo: 'caixa', id: vazio[0].id });
      toast(`"${vazio[0].titulo}" está sem ${vazio[0].tipo === 'sessao' ? 'pedido' : 'comando'}.`, true);
      return;
    }
    try { await api('POST', `/api/quadros/${S.q.id}/rodar`, { ids: targets.map((c) => c.id), modo }); }
    catch (e) { toast(e.message, true); }
  }
  async function stopNode(id) { try { await api('POST', `/api/quadros/${S.q.id}/parar`, { caixa: id }); } catch (e) { toast(e.message, true); } }
  async function answer(pedido, resposta) {
    try { await api('POST', '/api/responder', { pedido, resposta }); } catch (e) { toast(e.message, true); }
  }

  // ---------- câmera ----------
  function setView() {
    const v = S.view;
    els.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    const gs = 24 * v.zoom;
    els.viewport.style.setProperty('--gs', `${gs}px`);
    els.viewport.style.setProperty('--gx', `${v.x % gs}px`);
    els.viewport.style.setProperty('--gy', `${v.y % gs}px`);
  }
  let viewTimer = null;
  function viewChanged() {
    setView();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (S.q) store.set(`rf-orq-view:${S.q.id}`, JSON.stringify(S.view)); }, 400);
  }
  function zoomAt(f, cx, cy) {
    const r = els.viewport.getBoundingClientRect();
    const z0 = S.view.zoom, z1 = clamp(z0 * f, 0.2, 2.5);
    const px = (cx === undefined ? r.width / 2 : cx - r.left), py = (cy === undefined ? r.height / 2 : cy - r.top);
    S.view.x = px - (px - S.view.x) * (z1 / z0);
    S.view.y = py - (py - S.view.y) * (z1 / z0);
    S.view.zoom = z1;
    viewChanged();
  }
  function toWorld(cx, cy) {
    const r = els.viewport.getBoundingClientRect();
    return { x: (cx - r.left - S.view.x) / S.view.zoom, y: (cy - r.top - S.view.y) / S.view.zoom };
  }
  function centerWorld() { const r = els.viewport.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }
  function fit() {
    if (!S.q || !S.q.caixas.length) { S.view = { x: 0, y: 0, zoom: 1 }; setView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of S.q.caixas) {
      const el = nodeDom(c.id);
      const w = WIDTH[c.tipo] || 300, hh = el ? el.offsetHeight : 200;
      x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + w); y1 = Math.max(y1, c.y + hh);
    }
    const r = els.viewport.getBoundingClientRect();
    const padL = innerWidth > 760 ? 100 : 30, padR = S.aberta && innerWidth > 760 ? 470 : 40, padY = 50;
    const aw = Math.max(200, r.width - padL - padR), ah = Math.max(200, r.height - padY * 2 - (innerWidth > 760 ? 0 : 70));
    const z = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.25, 1.1);
    S.view = { zoom: z, x: padL + (aw - (x1 - x0) * z) / 2 - x0 * z, y: padY + (ah - (y1 - y0) * z) / 2 - y0 * z };
    viewChanged();
  }

  // ---------- ponteiro: arrastar caixas, ligar, mover o quadro ----------
  let drag = null;
  const pointers = new Map();

  function onNodePointerDown(e, id) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const port = e.target.closest('.port');
    select({ tipo: 'caixa', id });
    if (port) { e.preventDefault(); e.stopPropagation(); startConnect(e, id, port.classList.contains('out') ? 'out' : 'in'); return; }
    if (e.target.closest('input,textarea,select,button,[contenteditable="true"],.nask')) { e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
    const c = byId(id);
    drag = { kind: 'node', id, sx: e.clientX, sy: e.clientY, x: c.x, y: c.y, moved: false, pid: e.pointerId };
    nodeDom(id).setPointerCapture(e.pointerId);
  }

  function startConnect(e, id, dir) {
    drag = { kind: 'link', id, dir, pid: e.pointerId, over: null };
    els.ghost.classList.remove('hidden');
    moveConnect(e);
  }
  function moveConnect(e) {
    const c = byId(drag.id);
    const p = toWorld(e.clientX, e.clientY);
    const { d } = drag.dir === 'out' ? curve(outPort(c), p) : curve(p, inPort(c));
    els.ghost.setAttribute('d', d);
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest('.node');
    const tid = target && target.dataset.id;
    if (drag.over && drag.over !== tid) { const o = nodeDom(drag.over); if (o) o.classList.remove('drop-ok', 'drop-bad'); }
    drag.over = tid && tid !== drag.id ? tid : null;
    if (drag.over) {
      const [de, para] = drag.dir === 'out' ? [drag.id, drag.over] : [drag.over, drag.id];
      const why = canConnect(de, para);
      target.classList.toggle('drop-ok', !why);
      target.classList.toggle('drop-bad', !!why);
    }
  }
  function endConnect() {
    els.ghost.classList.add('hidden');
    if (drag.over) {
      const o = nodeDom(drag.over);
      if (o) o.classList.remove('drop-ok', 'drop-bad');
      const [de, para] = drag.dir === 'out' ? [drag.id, drag.over] : [drag.over, drag.id];
      connect(de, para);
    }
  }

  els.viewport.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // pinça (toque): zoom e movimento com dois dedos
      const [a, b] = [...pointers.values()];
      drag = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (e.target.closest('.node, .elabel, .empty')) return;
    if (e.button !== 0 && e.button !== 1) return;
    closeMenu();
    if (S.sel) select(null);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, x: S.view.x, y: S.view.y, pid: e.pointerId };
    els.viewport.setPointerCapture(e.pointerId);
    els.viewport.classList.add('panning');
  });

  window.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      S.view.x += cx - drag.cx; S.view.y += cy - drag.cy;
      zoomAt(dist / (drag.dist || dist), cx, cy);
      drag.dist = dist; drag.cx = cx; drag.cy = cy;
    } else if (drag.kind === 'pan') {
      S.view.x = drag.x + (e.clientX - drag.sx);
      S.view.y = drag.y + (e.clientY - drag.sy);
      setView();
    } else if (drag.kind === 'node' && e.pointerId === drag.pid) {
      const dx = (e.clientX - drag.sx) / S.view.zoom, dy = (e.clientY - drag.sy) / S.view.zoom;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) { drag.moved = true; nodeDom(drag.id).classList.add('dragging'); }
      const c = byId(drag.id);
      c.x = Math.round((drag.x + dx) / 8) * 8;
      c.y = Math.round((drag.y + dy) / 8) * 8;
      nodeDom(drag.id).style.transform = `translate(${c.x}px, ${c.y}px)`;
      renderEdges();
    } else if (drag.kind === 'link' && e.pointerId === drag.pid) moveConnect(e);
    else if (drag.kind === 'palette' && e.pointerId === drag.pid) movePalette(e);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.kind === 'pinch') { if (pointers.size < 2) { drag = null; viewChanged(); } return; }
    if (drag.pid !== undefined && e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (d.kind === 'pan') { els.viewport.classList.remove('panning'); if (d.x !== S.view.x || d.y !== S.view.y) viewChanged(); }
    else if (d.kind === 'node') { const el = nodeDom(d.id); if (el) el.classList.remove('dragging'); if (d.moved) markDirty(); }
    else if (d.kind === 'link') { drag = d; endConnect(); drag = null; }
    else if (d.kind === 'palette') { drag = d; endPalette(e); drag = null; }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (drag && drag.kind === 'link') els.ghost.classList.add('hidden');
    if (drag && drag.kind === 'palette' && drag.ghost) drag.ghost.remove();
    if (drag && drag.kind === 'pan') els.viewport.classList.remove('panning');
    drag = null;
  });

  els.viewport.addEventListener('wheel', (e) => {
    if (e.target.closest('textarea, .nask') && !(e.ctrlKey || e.metaKey)) return; // rola o texto, não o quadro
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), e.clientX, e.clientY);
    else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; viewChanged(); }
  }, { passive: false });

  els.viewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.node, .elabel, .empty') || !S.q) return;
    const p = toWorld(e.clientX, e.clientY);
    createNode('sessao', p.x - 150, p.y - 21);
  });

  // ---------- paleta: puxar caixinhas ----------
  for (const item of $$('.pal-item')) {
    item.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      drag = { kind: 'palette', tipo: item.dataset.tipo, sx: e.clientX, sy: e.clientY, moved: false, pid: e.pointerId, ghost: null, html: item.innerHTML };
    });
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); paletteClick(item.dataset.tipo); } });
  }
  function movePalette(e) {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    if (!drag.moved) { drag.moved = true; drag.ghost = h('div', { class: 'drag-ghost', html: drag.html }); document.body.append(drag.ghost); }
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
  }
  function endPalette(e) {
    if (drag.ghost) drag.ghost.remove();
    if (!S.q) return;
    if (!drag.moved) { paletteClick(drag.tipo); return; }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under || !els.viewport.contains(under) || under.closest('.palette, .drawer')) return;
    const onNode = under.closest('.node');
    const p = toWorld(e.clientX, e.clientY);
    const c = createNode(drag.tipo, p.x - (WIDTH[drag.tipo] || 300) / 2, p.y - 21);
    // soltou em cima de outra caixa: liga as duas (nota ↔ sessão, ou a próxima etapa)
    if (onNode && onNode.dataset.id !== c.id) {
      const other = byId(onNode.dataset.id);
      if (other) {
        const pos = spotRightOf(other);
        c.x = pos.x; c.y = pos.y; updateNode(c);
        if (c.tipo === 'nota') connect(c.id, other.id); else connect(other.id, c.id);
        if (other.repo && runnable(c)) { c.repo = other.repo; updateNode(c); }
      }
    }
  }
  // Clique na paleta: com uma caixa selecionada, a nova entra ligada depois dela (puxa a próxima etapa).
  function paletteClick(tipo) {
    const sel = S.sel && S.sel.tipo === 'caixa' ? byId(S.sel.id) : null;
    if (sel) {
      const p = spotRightOf(sel);
      const c = createNode(tipo, p.x, p.y, runnable(sel) && tipo !== 'nota' ? { repo: sel.repo || null } : {});
      if (tipo === 'nota' && sel.tipo === 'nota') return;
      if (tipo === 'nota') connect(c.id, sel.id); else connect(sel.id, c.id);
      return;
    }
    const p = centerWorld();
    const n = S.q.caixas.length;
    createNode(tipo, p.x - 150 + (n % 5) * 24, p.y - 100 + (n % 5) * 24);
  }

  // ---------- teclado ----------
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (!els.modal.classList.contains('hidden')) { closeModal(); return; }
      if (menuEl) { closeMenu(); return; }
      if (!els.boardMenu.classList.contains('hidden')) { els.boardMenu.classList.add('hidden'); return; }
      if (typing) { e.target.blur(); return; }
      if (S.aberta) { closeDrawer(); return; }
      select(null);
      return;
    }
    if (typing || !S.q) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
      e.preventDefault();
      if (S.sel.tipo === 'caixa') removeNode(S.sel.id); else removeEdge(S.sel.id);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && S.sel && S.sel.tipo === 'caixa') {
      e.preventDefault(); duplicateNode(S.sel.id);
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault(); runNodes([], 'tudo');
    } else if (e.key === 'f' || e.key === 'F') fit();
    else if (e.key === '+' || e.key === '=') zoomAt(1.2);
    else if (e.key === '-') zoomAt(1 / 1.2);
    else if (e.key === 'Enter' && S.sel && S.sel.tipo === 'caixa') { e.preventDefault(); openDrawer(S.sel.id); }
  });

  // ---------- gaveta: conversa e configuração da caixa ----------
  function closeDrawer() {
    S.aberta = null;
    els.drawer.classList.add('hidden');
    els.drawer.replaceChildren();
  }

  async function openDrawer(id, tab) {
    const c = byId(id);
    if (!c) return;
    S.aberta = id;
    S.tab = tab || (c.tipo === 'nota' ? 'nota' : 'conversa');
    select({ tipo: 'caixa', id });
    renderDrawer();
    if (runnable(c)) {
      try {
        const r = await api('GET', `/api/quadros/${S.q.id}/log/${id}`);
        if (S.aberta !== id) return;
        S.logs.set(id, r.eventos || []);
        for (const ev of r.eventos || []) if (ev.type === 'toolResult') { const call = r.eventos.find((x) => x.type === 'toolCall' && x.id === ev.id); if (call) call.result = ev; }
        if (S.tab === 'conversa') renderLog();
      } catch { /* sem histórico */ }
    }
  }

  function renderDrawer() {
    const c = byId(S.aberta);
    if (!c) return closeDrawer();
    const d = els.drawer;
    d.classList.remove('hidden');
    const tabs = c.tipo === 'nota' ? [['nota', 'Editar'], ['ver', 'Ver']] : [['conversa', c.tipo === 'comando' ? 'Saída' : 'Conversa'], ['config', 'Configurar']];
    if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    const title = h('input', { class: 'dtitle', value: c.titulo, 'aria-label': 'Título da caixa', spellcheck: 'false' });
    title.addEventListener('input', () => { c.titulo = title.value.slice(0, 120) || c.titulo; updateNode(c); markDirty(); });
    d.replaceChildren(...[
      h('div', { class: 'dhead' }, h('span', { class: 'ticon', html: ICON[c.tipo] || '' }), title, runnable(c) ? h('span', { class: 'pill', id: 'dpill' }) : null,
        h('button', { class: 'nbtn', type: 'button', title: 'Fechar (Esc)', 'aria-label': 'Fechar', html: SVG.close, onclick: closeDrawer })),
      runnable(c) ? h('div', { class: 'dmeta', id: 'dmeta' }) : null,
      h('div', { class: 'dtabs' }, ...tabs.map(([k, t]) => h('button', { type: 'button', class: S.tab === k ? 'on' : '', text: t, onclick: () => { S.tab = k; renderDrawer(); if (k === 'conversa') renderLog(); } }))),
      h('div', { class: 'dbody', id: 'dbody' }),
      c.tipo === 'sessao' && S.tab === 'conversa' ? drawerComposer(c) : null,
    ].filter(Boolean));
    d.className = `drawer t-${c.tipo}`;
    refreshDrawer();
    const body = $('#dbody');
    if (S.tab === 'conversa') renderLog();
    else if (S.tab === 'config') body.append(c.tipo === 'sessao' ? sessionConfig(c) : commandConfig(c));
    else if (S.tab === 'nota') {
      const ta = h('textarea', { class: 'note-edit', placeholder: 'Markdown. As sessões ligadas a esta nota leem e podem escrever aqui.', spellcheck: 'false' });
      ta.value = c.texto || '';
      ta.addEventListener('input', () => { c.texto = ta.value; updateNode(c); markDirty(); });
      body.append(h('div', { class: 'note-wrap' }, ta));
      setTimeout(() => ta.focus(), 20);
    } else if (S.tab === 'ver') body.append(h('div', { class: 'note-view ev-text', html: md(c.texto || '*(vazia)*') }));
  }

  function refreshDrawer(fields) {
    const c = byId(S.aberta);
    if (!c) return;
    const pill = $('#dpill');
    if (pill) { const k = pendFor(c.id).length ? 'aguardando' : c.status || 'ociosa'; pill.className = `pill s-${k}`; pill.textContent = STATUS[k] || k; }
    const meta = $('#dmeta');
    if (meta) {
      const r = repoOf(c);
      meta.replaceChildren(...[
        h('span', {}, r ? h('span', { style: `color:${repoColor(r)}`, text: `● ${r.nome}` }) : h('span', { class: 'err-text', text: 'sem repositório' })),
        c.branch ? h('span', {}, 'branch ', h('code', { text: c.branch })) : null,
        c.pasta && c.pasta !== (r && r.caminho) ? h('span', { title: c.pasta }, 'pasta ', h('code', { text: c.pasta })) : null,
        metaOf(c) ? h('span', { text: metaOf(c).replace(c.branch ? `${c.branch} · ` : '', '') }) : null].filter(Boolean));
    }
    if (fields && fields.includes('titulo')) { const t = $('.dtitle'); if (t && document.activeElement !== t) t.value = c.titulo; }
    if (fields && fields.includes('texto') && c.tipo === 'nota') {
      const ta = $('.note-edit');
      if (ta && document.activeElement !== ta) ta.value = c.texto || '';
      const v = $('.note-view');
      if (v) v.innerHTML = md(c.texto || '*(vazia)*');
    }
    if (fields && fields.includes('resultado') && S.tab === 'config') { const box = $('#dresult'); if (box) box.innerHTML = c.resultado ? md(c.resultado) : '<span class="muted">Ainda sem resultado.</span>'; }
  }

  function drawerComposer(c) {
    const ta = h('textarea', { id: 'dmsg', rows: '1', placeholder: c.status === 'rodando' ? 'Mandar uma mensagem (entra no próximo passo)…' : 'Continuar a conversa com esta sessão…' });
    const sendIt = async () => {
      const t = ta.value.trim();
      if (!t) return;
      ta.value = '';
      autosize(ta, 160);
      await flushSave();
      try { await api('POST', `/api/quadros/${S.q.id}/mensagem`, { caixa: c.id, texto: t }); }
      catch (e) { toast(e.message, true); ta.value = t; }
    };
    ta.addEventListener('input', () => autosize(ta, 160));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
    return h('div', { class: 'dfoot' }, ta, h('button', { class: 'btn primary', type: 'button', text: 'Enviar', onclick: sendIt }));
  }

  function field(label, input, hint) { return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { text: hint }) : null); }
  function toggle(label, hint, on, set) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!on;
    cb.addEventListener('change', () => set(cb.checked));
    return h('label', { class: 'tog' }, cb, h('b', { text: label }), h('small', { text: hint }));
  }

  function repoField(c) {
    const sel = h('select', {});
    sel.append(h('option', { value: '', text: 'Escolha…' }), ...S.q.repos.map((r) => h('option', { value: r.id, text: `${r.nome}  ${r.caminho}` })));
    sel.value = c.repo || '';
    sel.addEventListener('change', () => { c.repo = sel.value || null; updateNode(c); refreshDrawer(); markDirty(0); });
    return field('Repositório', sel);
  }

  function sessionConfig(c) {
    const prompt = h('textarea', { rows: '7' });
    prompt.value = c.prompt || '';
    prompt.addEventListener('input', () => { c.prompt = prompt.value; updateNode(c); markDirty(); });
    const model = h('select', {});
    let group = null;
    for (const m of S.modelos) {
      const opt = h('option', { value: m.id, text: m.id ? `${m.id}${m.desc ? `  (${m.desc})` : ''}` : `Padrão  (${m.desc || ''})` });
      if (m.grupo) { if (!group || group.label !== m.grupo) { group = h('optgroup', { label: m.grupo }); model.append(group); } group.append(opt); } else model.append(opt);
    }
    if (c.modelo && !S.modelos.some((m) => m.id === c.modelo)) model.append(h('option', { value: c.modelo, text: c.modelo }));
    model.value = c.modelo || '';
    model.addEventListener('change', () => { c.modelo = model.value; updateNode(c); markDirty(0); });
    const effort = h('select', {}, h('option', { value: '', text: 'Padrão' }), h('option', { value: 'low', text: 'Baixo (rápido)' }), h('option', { value: 'medium', text: 'Médio' }), h('option', { value: 'high', text: 'Alto (mais cuidadoso)' }));
    effort.value = c.esforco || '';
    effort.addEventListener('change', () => { c.esforco = effort.value; updateNode(c); markDirty(0); });
    return h('div', { class: 'dcfg' },
      repoField(c),
      field('Pedido', prompt, 'O resultado das caixas ligadas antes desta e o texto das notas ligadas entram junto, como contexto.'),
      field('Modelo', model),
      field('Esforço', effort),
      toggle('Branch própria (git worktree)', 'A sessão trabalha numa cópia do repositório, numa branch só dela. As caixas seguintes do mesmo repositório continuam nessa branch. Use quando várias sessões mexem no mesmo repositório ao mesmo tempo.', c.isolar, (v) => { c.isolar = v; updateNode(c); markDirty(0); }),
      toggle('Aprovar sozinha (auto)', 'Edições e comandos não pedem confirmação. Regras "deny" do .rfcode/settings.json continuam valendo.', c.auto, (v) => { c.auto = v; updateNode(c); markDirty(0); }),
      h('div', { class: 'field' }, h('span', { text: 'Último resultado' }), h('div', { class: 'result ev-text', id: 'dresult', html: c.resultado ? md(c.resultado) : '<span class="muted">Ainda sem resultado.</span>' })),
      h('div', {}, h('button', { class: 'btn danger', type: 'button', text: 'Excluir caixa', onclick: () => removeNode(c.id) })));
  }

  function commandConfig(c) {
    const cmd = h('input', { class: 'mono', spellcheck: 'false', placeholder: 'npm test' });
    cmd.value = c.comando || '';
    cmd.addEventListener('input', () => { c.comando = cmd.value; updateNode(c); markDirty(); });
    const lim = h('input', { type: 'number', min: '1', max: '1440' });
    lim.value = c.limite || 30;
    lim.addEventListener('input', () => { c.limite = clamp(Number(lim.value) || 30, 1, 1440); markDirty(); });
    return h('div', { class: 'dcfg' },
      repoField(c),
      field('Comando', cmd, 'Roda no terminal, na pasta do repositório (ou na branch própria da sessão anterior). Código de saída 0 segue pelas ligações "se der certo"; outro código segue pelas "se falhar".'),
      field('Limite (minutos)', lim),
      h('div', {}, h('button', { class: 'btn danger', type: 'button', text: 'Excluir caixa', onclick: () => removeNode(c.id) })));
  }

  function renderLog() {
    const body = $('#dbody');
    if (!body || S.tab !== 'conversa') return;
    const c = byId(S.aberta);
    const list = S.logs.get(S.aberta) || [];
    const log = h('div', { class: 'dlog', id: 'dlog' });
    if (!list.length && c && (c.resultado || c.erro) && c.status !== 'rodando') {
      // a conversa não está mais na memória (o rfcode foi reiniciado) e não há sessão salva: mostra o último resultado
      log.append(h('div', { class: 'ev-info', text: 'Último resultado desta caixa:' }), c.resultado ? h('div', { class: 'ev-text', html: md(c.resultado) }) : h('div', { class: 'ev-error', text: c.erro }));
    } else if (!list.length) log.append(h('div', { class: 'empty-log', text: c && c.status === 'rodando' ? 'Começando…' : 'Ainda não rodou. Use Rodar no cartão ou mande uma mensagem abaixo.' }));
    for (const ev of list) {
      if (ev.type === 'toolResult' && list.some((x) => x.type === 'toolCall' && x.id === ev.id)) continue; // já aparece dentro da ação
      const el = evEl(ev);
      if (el) log.append(el);
    }
    body.replaceChildren(log, h('div', { class: 'pends', id: 'dpends' }));
    renderPending();
    body.scrollTop = body.scrollHeight;
  }

  function appendLogDom(ev, merged) {
    const log = $('#dlog');
    if (!log) return;
    const body = $('#dbody');
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const empty = $('.empty-log', log);
    if (empty) empty.remove();
    if (merged) {
      const last = log.lastElementChild;
      if (last && last.dataset.kind === merged.type) {
        if (merged.type === 'text') scheduleMd(last, merged);
        else { last.textContent = tailLines(merged.text, 400); last.scrollTop = last.scrollHeight; }
      } else { const el = evEl(merged); if (el) log.append(el); }
    } else if (ev.type === 'toolResult') {
      const t = log.querySelector(`.ev-tool[data-id="${CSS.escape(ev.id)}"]`);
      if (t) fillToolResult(t, ev); else { const el = evEl(ev); if (el) log.append(el); }
    } else { const el = evEl(ev); if (el) log.append(el); }
    if (stick) body.scrollTop = body.scrollHeight;
  }

  let mdPending = new Map();
  function scheduleMd(el, ev) {
    if (mdPending.has(el)) { mdPending.set(el, ev); return; }
    mdPending.set(el, ev);
    requestAnimationFrame(() => { const e = mdPending.get(el); mdPending.delete(el); el.innerHTML = md(e.text); });
  }
  const tailLines = (t, n) => { const lines = String(t || '').split('\n'); return lines.length > n ? `…\n${lines.slice(-n).join('\n')}` : String(t || ''); };

  function diffHtml(p) {
    if (!p || (!p.added && !p.removed)) return '';
    const lines = [...(p.removed || []).map((l) => `<span class="del">- ${esc(l)}</span>`), ...(p.added || []).map((l) => `<span class="add">+ ${esc(l)}</span>`)];
    if (p.more) lines.push(`<span class="muted">… +${p.more} linhas</span>`);
    return lines.join('\n');
  }

  function evEl(ev) {
    switch (ev.type) {
      case 'user': {
        const el = h('div', { class: `ev-user${ev.queued ? ' queued' : ''}`, text: ev.text });
        if (String(ev.text).length > 400) { el.classList.add('long'); el.title = 'Clique para ver tudo'; el.addEventListener('click', () => el.classList.toggle('open')); }
        return el;
      }
      case 'text': { const el = h('div', { class: 'ev-text', html: md(ev.text) }); el.dataset.kind = 'text'; return el; }
      case 'toolCall': {
        const el = h('details', { class: 'ev-tool', 'data-id': ev.id || '' },
          h('summary', {}, h('span', { class: 'ic', text: '•' }), h('span', { class: 'lb', text: ev.label || ev.name })));
        if (ev.preview) el.append(h('pre', { class: 'diff', html: diffHtml(ev.preview) }));
        if (ev.result) fillToolResult(el, ev.result);
        return el;
      }
      case 'toolResult': return h('div', { class: ev.error ? 'ev-error' : 'ev-info', text: `${ev.name}: ${String(ev.output).slice(0, 300)}` });
      case 'output': { const el = h('pre', { class: 'ev-out', text: tailLines(ev.text, 400) }); el.dataset.kind = 'output'; setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0); return el; }
      case 'plan': {
        const p = ev.plan || {};
        return h('div', { class: 'ev-plan' }, h('b', { text: p.goal ? `Plano: ${p.goal}` : 'Plano' }),
          h('ol', {}, ...(p.steps || []).map((s) => h('li', { class: s.status, text: s.text }))));
      }
      case 'info': return h('div', { class: 'ev-info', text: ev.text });
      case 'error': return h('div', { class: 'ev-error', text: ev.text });
      default: return null;
    }
  }
  function fillToolResult(el, r) {
    el.classList.add(r.error ? 'bad' : 'ok');
    $('.ic', el).textContent = r.error ? '✗' : '✓';
    const old = el.querySelector('pre.out');
    if (old) old.remove();
    el.append(h('pre', { class: 'out', text: String(r.output || '').slice(0, 4000) }));
    if (r.error) el.open = true;
  }

  function renderPending() {
    const box = $('#dpends');
    if (!box) return;
    const ps = pendFor(S.aberta);
    box.replaceChildren(...ps.map((p) => {
      if (p.tipo === 'aprovacao') {
        const reason = h('input', { class: 'inp', placeholder: 'Instrução ao negar (opcional): o que fazer em vez disso' });
        return h('div', { class: 'pend' },
          h('div', { class: 'ph' }, h('small', { text: p.forcado ? 'Confirmação obrigatória' : 'Aprovar ação' }), p.label || p.nome),
          p.motivo ? h('div', { class: 'why', text: p.motivo }) : null,
          p.preview ? h('pre', { class: 'diff', html: diffHtml(p.preview) }) : null,
          h('div', { class: 'acts' },
            h('button', { class: 'btn primary sm', type: 'button', text: 'Aprovar', onclick: () => answer(p.id, 'yes') }),
            p.forcado ? null : h('button', { class: 'btn sm', type: 'button', text: 'Aprovar tudo nesta caixa', title: 'Liga o modo auto desta caixa', onclick: () => answer(p.id, 'all') }),
            reason,
            h('button', { class: 'btn danger sm', type: 'button', text: 'Negar', onclick: () => answer(p.id, reason.value.trim() ? { deny: reason.value.trim() } : 'no') })));
      }
      const free = h('input', { class: 'inp', placeholder: 'Sua resposta' });
      const send = () => { if (free.value.trim()) answer(p.id, free.value.trim()); };
      free.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      return h('div', { class: 'pend' },
        h('div', { class: 'ph' }, h('small', { text: 'Pergunta da sessão' }), p.pergunta),
        h('div', { class: 'acts' }, ...(p.opcoes || []).map((o) => h('button', { class: 'btn sm', type: 'button', text: o, onclick: () => answer(p.id, o) })), free,
          h('button', { class: 'btn primary sm', type: 'button', text: 'Responder', onclick: send })));
    }));
    const body = $('#dbody');
    if (ps.length && body) body.scrollTop = body.scrollHeight;
  }

  // ---------- janelas: repositórios e quadros ----------
  function closeModal() { els.modal.classList.add('hidden'); els.modal.replaceChildren(); }
  function modal(title, body, foot, tabs) {
    const box = h('div', { class: 'mbox' },
      h('div', { class: 'mhead' }, h('h2', { text: title }), h('button', { class: 'nbtn', type: 'button', 'aria-label': 'Fechar', html: SVG.close, onclick: closeModal })),
      ...[tabs, body, foot].filter(Boolean));
    els.modal.replaceChildren(box);
    els.modal.classList.remove('hidden');
    els.modal.onclick = (e) => { if (e.target === els.modal) closeModal(); };
    return box;
  }

  function addRepo(repo) {
    const same = S.q.repos.find((r) => r.caminho === repo.caminho);
    if (same) { toast(`${same.nome} já está conectado.`); return same; }
    const r = { id: uid('r'), nome: repo.nome, caminho: repo.caminho, git: !!repo.git, ...(repo.url ? { url: repo.url } : {}), ...(repo.branch ? { branch: repo.branch } : {}) };
    S.q.repos.push(r);
    for (const c of S.q.caixas) if (runnable(c) && !c.repo) c.repo = r.id;
    renderRepos();
    for (const c of S.q.caixas) updateNode(c);
    renderEmpty();
    markDirty(0);
    toast(`${r.nome} conectado${r.git ? '' : ' (não é um repositório git: "branch própria" não funciona nele)'}.`);
    return r;
  }

  function openRepoModal() {
    let tab = 'pasta';
    const body = h('div', { class: 'mbody' });
    const tabs = h('div', { class: 'mtabs' });
    const render = () => {
      tabs.replaceChildren(...[['pasta', 'Pasta do computador'], ['git', 'Clonar do Git']].map(([k, t]) => h('button', { type: 'button', class: tab === k ? 'on' : '', text: t, onclick: () => { tab = k; render(); } })));
      if (tab === 'pasta') renderBrowse(body, store.get('rf-orq-dir') || S.home);
      else renderClone(body);
    };
    modal('Conectar repositório', body, null, tabs);
    render();
  }

  async function renderBrowse(body, dir) {
    const input = h('input', { class: 'inp', value: dir, spellcheck: 'false', 'aria-label': 'Caminho da pasta' });
    const err = h('div', { class: 'err-text' });
    const list = h('div', { class: 'dirs' }, h('div', { class: 'none', text: 'Carregando…' }));
    const crumbs = h('div', { class: 'crumbs' });
    const use = async (p) => {
      err.textContent = '';
      try { const r = await api('POST', '/api/repos/verificar', { caminho: p }); addRepo(r.repo); closeModal(); }
      catch (e) { err.textContent = e.message; }
    };
    const go = async (p) => {
      try {
        const r = await api('GET', `/api/pastas?caminho=${encodeURIComponent(p)}`);
        store.set('rf-orq-dir', r.caminho);
        input.value = r.caminho;
        const segs = r.caminho.split(/[\\/]/).filter(Boolean);
        const win = /^[A-Za-z]:/.test(r.caminho);
        crumbs.replaceChildren(...segs.map((s, i) => {
          const full = win ? segs.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : '') : `/${segs.slice(0, i + 1).join('/')}`;
          return h('button', { type: 'button', text: s, onclick: () => go(full) });
        }).flatMap((b, i) => (i ? [h('span', { text: S.sep }), b] : [b])));
        list.replaceChildren(...[
          r.pai ? h('div', { class: 'dir', onclick: () => go(r.pai) }, h('span', { html: SVG.up }), h('span', { class: 'nm', text: '..' })) : null,
          ...r.pastas.map((d) => h('div', { class: 'dir', onclick: () => go(d.caminho) },
            h('span', { class: 'nm', text: d.nome }),
            d.git ? h('span', { class: 'git', text: 'git' }) : null,
            h('button', { class: 'btn sm use', type: 'button', text: 'Conectar', onclick: (e) => { e.stopPropagation(); use(d.caminho); } }))),
          r.pastas.length ? null : h('div', { class: 'none', text: 'Nenhuma subpasta.' })].filter(Boolean));
        err.textContent = '';
      } catch (e) { err.textContent = e.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(input.value); });
    body.replaceChildren(
      h('p', { class: 'muted', text: 'Escolha a pasta do projeto. Pode conectar vários repositórios no mesmo quadro: cada caixa diz em qual trabalha.' }),
      h('div', { class: 'prow' }, input, h('button', { class: 'btn', type: 'button', text: 'Abrir', onclick: () => go(input.value) }), h('button', { class: 'btn primary', type: 'button', text: 'Conectar esta pasta', onclick: () => use(input.value) })),
      crumbs, list, err);
    go(dir);
  }

  function renderClone(body) {
    const input = h('input', { class: 'inp', placeholder: 'https://github.com/dono/projeto.git', spellcheck: 'false', 'aria-label': 'Endereço do repositório' });
    const err = h('div', { class: 'err-text' });
    const btn = h('button', { class: 'btn primary', type: 'button', text: 'Clonar e conectar' });
    btn.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      btn.disabled = true; btn.textContent = 'Clonando…'; err.textContent = '';
      try { const r = await api('POST', '/api/repos/clonar', { url: input.value.trim() }); addRepo(r.repo); closeModal(); }
      catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Clonar e conectar'; }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    body.replaceChildren(
      h('p', { class: 'muted', text: 'O rfcode clona com o git do seu computador (usa o login que você já tem) numa pasta da orquestra, ~/.rfcode/orquestra/repos.' }),
      h('div', { class: 'prow' }, input, btn), err);
    setTimeout(() => input.focus(), 20);
  }

  function openNewBoardModal() {
    let tpl = S.q && S.q.caixas.length ? 'vazio' : 'paralelo';
    const name = h('input', { class: 'inp', placeholder: 'Nome do quadro', spellcheck: 'false' });
    const keep = h('input', { type: 'checkbox' });
    keep.checked = true;
    const grid = h('div', { class: 'tpls' });
    const paint = () => grid.replaceChildren(...S.tpls.map((t) => h('button', { type: 'button', class: `tpl${tpl === t.id ? ' on' : ''}`, onclick: () => { tpl = t.id; paint(); } },
      h('b', { text: t.nome }), h('span', { text: t.desc }))));
    paint();
    const reuse = S.q && S.q.repos.length;
    const body = h('div', { class: 'mbody' },
      field('Nome', name),
      h('div', { class: 'field' }, h('span', { text: 'Começar com' }), grid),
      reuse ? h('label', { class: 'tog' }, keep, h('b', { text: `Levar os repositórios deste quadro (${S.q.repos.map((r) => r.nome).join(', ')})` }), h('small', { text: 'As caixas do modelo já começam apontando para o primeiro.' })) : null);
    const create = h('button', { class: 'btn primary', type: 'button', text: 'Criar quadro' });
    create.addEventListener('click', async () => {
      create.disabled = true;
      try {
        const t = S.tpls.find((x) => x.id === tpl);
        await createBoard({ nome: name.value.trim() || (t && tpl !== 'vazio' ? t.nome : 'Novo quadro'), modelo: tpl, repos: reuse && keep.checked ? S.q.repos : [] });
        closeModal();
      } catch (e) { toast(e.message, true); create.disabled = false; }
    });
    modal('Novo quadro', body, h('div', { class: 'mfoot' }, h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: closeModal }), create));
    setTimeout(() => name.focus(), 20);
  }

  // menu dos quadros
  $('#boardBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const m = els.boardMenu;
    if (!m.classList.contains('hidden')) { m.classList.add('hidden'); return; }
    try { S.quadros = (await api('GET', '/api/quadros')).quadros; } catch { /* usa a lista antiga */ }
    m.replaceChildren(
      h('div', { class: 'lbl', text: 'Quadros' }),
      ...S.quadros.map((q) => h('button', { class: `mi${S.q && q.id === S.q.id ? ' on' : ''}`, type: 'button', onclick: () => { m.classList.add('hidden'); openBoard(q.id); } },
        h('span', { class: 't', text: q.nome }), h('small', { text: `${q.caixas} caixa${q.caixas === 1 ? '' : 's'}` }))),
      h('div', { class: 'sep' }),
      h('button', { class: 'mi', type: 'button', onclick: () => { m.classList.add('hidden'); openNewBoardModal(); } }, h('span', { class: 't', text: 'Novo quadro…' })),
      h('button', { class: 'mi', type: 'button', onclick: () => { m.classList.add('hidden'); renameBoard(); } }, h('span', { class: 't', text: 'Renomear este quadro' })),
      h('button', { class: 'mi', type: 'button', onclick: () => { m.classList.add('hidden'); fit(); } }, h('span', { class: 't', text: 'Ver tudo' }), h('small', { text: 'F' })),
      h('div', { class: 'sep' }),
      h('button', { class: 'mi danger', type: 'button', onclick: () => { m.classList.add('hidden'); deleteBoard(); } }, h('span', { class: 't', text: 'Excluir este quadro' })));
    m.classList.remove('hidden');
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.board-pick')) els.boardMenu.classList.add('hidden'); });

  function renameBoard() {
    const t = prompt('Nome do quadro', S.q.nome);
    if (!t || !t.trim()) return;
    S.q.nome = t.trim().slice(0, 120);
    els.boardName.textContent = S.q.nome;
    updateCounts();
    markDirty(0);
  }
  async function deleteBoard() {
    if (!confirm(`Excluir o quadro "${S.q.nome}"? As caixas e as ligações somem; os repositórios e as conversas salvas continuam no disco.`)) return;
    const id = S.q.id;
    clearTimeout(S.saveTimer); S.saveTimer = null;
    await api('DELETE', `/api/quadros/${id}`);
    S.q = null;
    S.quadros = (await api('GET', '/api/quadros')).quadros;
    if (S.quadros[0]) await openBoard(S.quadros[0].id);
    else await createBoard({ nome: 'Meu primeiro quadro', modelo: 'vazio', repos: [] });
  }

  // ---------- barra de cima ----------
  els.paralelo.addEventListener('change', () => { S.q.config.paralelo = Number(els.paralelo.value); markDirty(0); });
  els.runAll.addEventListener('click', () => runNodes([], 'tudo'));
  els.stopAll.addEventListener('click', async () => { try { await api('POST', `/api/quadros/${S.q.id}/parar`, {}); } catch (e) { toast(e.message, true); } });
  $('#zoomIn').addEventListener('click', () => zoomAt(1.2));
  $('#zoomOut').addEventListener('click', () => zoomAt(1 / 1.2));
  $('#fit').addEventListener('click', fit);
  window.addEventListener('beforeunload', () => { if (S.saveTimer) save(); });

  boot();
})();
