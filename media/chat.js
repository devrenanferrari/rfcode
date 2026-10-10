// Interface do painel do rfcode (roda dentro do webview).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
  const modelSel = $('model'), autoChk = $('auto'), statusEl = $('status');

  let busy = false;
  let current = null;   // { el, text, reasoningEl } da resposta em andamento
  let spinner = null;
  const tools = new Map(); // id -> elementos do cartão da ferramenta
  let lastCmdTool = null;
  let tokens = 0;

  // ---------- markdown simples ----------
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  function md(src) {
    const out = [];
    const parts = src.split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        out.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
        return;
      }
      const lines = esc(part).split('\n');
      let para = [], list = null;
      const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
      const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
      for (const line of lines) {
        let m;
        if (!line.trim()) { flushPara(); flushList(); continue; }
        if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); out.push(`<h3>${inline(m[2])}</h3>`); continue; }
        if ((m = line.match(/^\s*[-*]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
          flushPara();
          const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
          if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
          list.items.push(m[1]);
          continue;
        }
        flushList();
        para.push(line);
      }
      flushPara(); flushList();
    });
    return out.join('');
  }

  // ---------- helpers ----------
  function hideWelcome() { $('welcome')?.classList.add('hidden'); }
  function scroll() {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
  function add(el) { log.appendChild(el); if (spinner) log.appendChild(spinner); scroll(); return el; }
  function div(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function note(kind, text) { add(div('note ' + kind)).textContent = text; }
  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    stopBtn.classList.toggle('hidden', !b);
    statusEl.textContent = b ? 'trabalhando…' : (tokens ? `${tokens.toLocaleString('pt-BR')} tokens` : '');
  }
  function showSpinner(text) {
    if (!spinner) spinner = div('spinner');
    spinner.textContent = text || 'pensando';
    log.appendChild(spinner);
    scroll();
  }
  function hideSpinner() { if (spinner) { spinner.remove(); spinner = null; } }
  function ensureAssistant() {
    if (!current) {
      current = { el: div('msg assistant'), text: '', reasoningEl: null, body: div('') };
      current.el.appendChild(current.body);
      add(current.el);
    }
    return current;
  }
  const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

  // ---------- enviar ----------
  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    setBusy(true);
    vscode.postMessage({ type: 'send', text });
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('keyBtn').addEventListener('click', () => vscode.postMessage({ type: 'setKey' }));
  modelSel.addEventListener('change', () => vscode.postMessage({ type: 'setModel', model: modelSel.value }));
  autoChk.addEventListener('change', () => vscode.postMessage({ type: 'setAuto', value: autoChk.checked }));

  // ---------- mensagens da extensão ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        modelSel.innerHTML = m.models.map((x) => `<option value="${esc(x.id)}" title="${esc(x.desc)}">${esc(x.id)}</option>`).join('');
        modelSel.value = m.model;
        autoChk.checked = m.autoApprove;
        $('cwd').textContent = 'Pasta: ' + m.cwd;
        $('keyBtn').classList.toggle('hidden', m.hasKey);
        break;
      case 'keyStatus':
        $('keyBtn').classList.toggle('hidden', m.hasKey);
        break;
      case 'autoChanged':
        autoChk.checked = m.value;
        break;
      case 'cleared':
        log.innerHTML = '';
        log.appendChild(div('welcome', `<h2>rfcode</h2><p>Nova conversa.</p><p class="muted">Pasta: ${esc(m.cwd)}</p>`));
        current = null; tools.clear(); hideSpinner(); tokens = 0; $('plan').classList.add('hidden'); setBusy(false);
        break;
      case 'user': {
        hideWelcome();
        setBusy(true);
        current = null;
        add(div('msg user')).textContent = m.text;
        break;
      }
      case 'thinking': showSpinner('pensando'); break;
      case 'responseStart': hideSpinner(); break;
      case 'reasoning': {
        const c = ensureAssistant();
        if (!c.reasoningEl) {
          const d = document.createElement('details');
          d.className = 'reasoning';
          d.innerHTML = '<summary>raciocínio</summary><div></div>';
          c.el.insertBefore(d, c.body);
          c.reasoningEl = d.querySelector('div');
        }
        c.reasoningEl.textContent += m.text;
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
        if (current && !current.text && !current.reasoningEl) current.el.remove();
        current = null;
        break;
      case 'toolCall': {
        hideWelcome();
        const card = div('tool');
        const label = div('label');
        label.textContent = '● ' + m.label;
        if (FILE_TOOLS.has(m.name) && m.args && m.args.path) {
          label.classList.add('link');
          label.title = 'Abrir arquivo';
          label.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: m.args.path }));
        }
        card.appendChild(label);
        if (m.preview) {
          const pre = document.createElement('pre');
          pre.className = 'diff';
          pre.innerHTML = m.preview.removed.map((l) => `<span class="del">- ${esc(l)}</span>`).join('\n')
            + (m.preview.removed.length && m.preview.added.length ? '\n' : '')
            + m.preview.added.map((l) => `<span class="add">+ ${esc(l)}</span>`).join('\n')
            + (m.preview.more ? `\n<span>  … (+${m.preview.more} linhas)</span>` : '');
          card.appendChild(pre);
        }
        add(card);
        tools.set(m.id, { card, name: m.name, cmdOut: null });
        if (m.name === 'run_command') lastCmdTool = m.id;
        showSpinner('executando');
        break;
      }
      case 'approval': {
        const t = tools.get(m.id);
        if (!t) break;
        hideSpinner();
        t.card.classList.add('wait');
        const box = div('approve');
        const mk = (txt, cls, decision) => {
          const b = document.createElement('button');
          b.textContent = txt;
          if (cls) b.className = cls;
          b.addEventListener('click', () => {
            const reason = box.querySelector('input')?.value || '';
            vscode.postMessage({ type: 'approval', id: m.id, decision, reason });
            box.remove();
            t.card.classList.remove('wait');
            if (decision !== 'deny') showSpinner('executando');
          });
          return b;
        };
        box.appendChild(mk('Permitir', '', 'yes'));
        box.appendChild(mk('Permitir tudo', 'secondary', 'all'));
        box.appendChild(mk('Negar', 'secondary', 'deny'));
        const reason = document.createElement('input');
        reason.placeholder = 'Ao negar: instrução para o modelo (opcional)';
        box.appendChild(reason);
        t.card.appendChild(box);
        scroll();
        break;
      }
      case 'cmdOut': {
        const t = tools.get(lastCmdTool);
        if (!t) break;
        if (!t.cmdOut) {
          t.cmdOut = document.createElement('pre');
          t.cmdOut.className = 'out';
          t.card.appendChild(t.cmdOut);
        }
        t.cmdOut.textContent += m.text;
        t.cmdOut.scrollTop = t.cmdOut.scrollHeight;
        scroll();
        break;
      }
      case 'toolResult': {
        const t = tools.get(m.id);
        if (!t) break;
        t.card.classList.add(m.error ? 'err' : 'ok');
        t.card.querySelector('.approve')?.remove();
        if (t.cmdOut) break; // a saída do comando já está visível
        const lines = m.output.split('\n');
        const d = document.createElement('details');
        const summary = m.name === 'read_file' && !m.error ? `${lines.length} linhas lidas` : lines[0].slice(0, 120) + (lines.length > 1 ? ` (+${lines.length - 1} linhas)` : '');
        d.innerHTML = `<summary>${esc(summary)}</summary>`;
        const pre = document.createElement('pre');
        pre.className = 'out';
        pre.textContent = m.output;
        d.appendChild(pre);
        if (m.error) d.open = true;
        t.card.appendChild(d);
        scroll();
        break;
      }
      case 'plan': {
        const p = m.plan, el = $('plan');
        const icon = { done: '☑', in_progress: '◐', pending: '☐' };
        const done = p.steps.filter((s) => s.status === 'done').length;
        el.innerHTML = `<div class="plan-head"><b>${esc(p.goal || 'Plano')}</b><span>${done}/${p.steps.length}</span></div>`
          + p.steps.map((s) => `<div class="step ${s.status}"><span>${icon[s.status]}</span>${esc(s.text)}</div>`).join('')
          + (p.why ? `<div class="why">↳ ${esc(p.why)}</div>` : '');
        el.classList.toggle('hidden', !p.steps.length);
        break;
      }
      case 'usage':
        tokens = m.usage.total;
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
  });

  vscode.postMessage({ type: 'ready' });
})();
