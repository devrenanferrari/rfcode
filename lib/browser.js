'use strict';
// Ferramenta "browser": controla um Chrome próprio do rfcode pelo Chrome DevTools Protocol (CDP), sem dependências.
// O modelo recebe um "retrato" da página em texto, com os elementos clicáveis numerados ([n]), e age por esses números.
// Isso é muito mais confiável em sites do que OCR + coordenadas de mouse.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const CONFIG_DIR = process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const DEFAULT_PORT = +process.env.RFCODE_BROWSER_PORT || 9333;
const MAX_SNAPSHOT = 9000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Botões que enviam, pagam, apagam ou publicam: sempre pedem confirmação, mesmo no modo auto.
const SENSITIVE = /\b(enviar|envie|submit|send|apply|candidatar(-se)?|candidatura|aplicar|finalizar|concluir|confirmar|confirm|pagar|pay|comprar|buy|checkout|excluir|delete|remover|remove|publicar|post|transferir)\b/i;

const BROWSER_TOOL_DEF = {
  name: 'browser',
  description: 'Controla um navegador Chrome (perfil próprio do rfcode). Depois de cada ação devolve um retrato da página em texto, '
    + 'com os elementos interativos numerados como [n]. Use os números do retrato MAIS RECENTE em click/type/select/scroll/upload. '
    + 'Ações: open (url), read (query opcional filtra as linhas), click (ref), type (ref, text, submit), select (ref, value), '
    + 'key (key: Enter, Escape, Tab, ArrowDown...), scroll (ref de um item da lista ou nada para a página; direction up/down), '
    + 'back, tabs, switch_tab (index), upload (ref, path), wait (ms).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'read', 'click', 'type', 'select', 'key', 'scroll', 'back', 'tabs', 'switch_tab', 'upload', 'wait'] },
      url: { type: 'string', description: 'open: endereço (https://...)' },
      ref: { type: 'integer', description: 'Número [n] do elemento no retrato' },
      text: { type: 'string', description: 'type: texto a digitar (substitui o conteúdo do campo)' },
      submit: { type: 'boolean', description: 'type: pressionar Enter depois' },
      value: { type: 'string', description: 'select: texto ou valor da opção' },
      key: { type: 'string', description: 'key: tecla, ex. Enter, Escape, Tab, ArrowDown, Control+a' },
      direction: { type: 'string', enum: ['up', 'down'] },
      query: { type: 'string', description: 'read: mostra só as linhas com este texto' },
      offset: { type: 'integer', description: 'read: continua a leitura de uma página longa a partir deste caractere' },
      index: { type: 'integer', description: 'switch_tab: número da aba (de tabs)' },
      path: { type: 'string', description: 'upload: caminho do arquivo' },
      ms: { type: 'integer', description: 'wait: milissegundos' },
      new_tab: { type: 'boolean', description: 'open: abrir numa aba nova' },
    },
    required: ['action'],
  },
};

const BROWSER_PROMPT = `
Navegador (ferramenta browser):
- Para tarefas em sites use a ferramenta browser, não screen_text/mouse. Ela abre um Chrome próprio do rfcode (perfil separado do Chrome pessoal). Se o site pedir login, pare e peça ao usuário para entrar na conta nessa janela; depois continue.
- Fluxo: open (vá direto pela URL quando souber) → leia o retrato → aja pelos números [n] → confira o retrato novo que volta depois de cada ação. Os números mudam a cada retrato: use sempre os mais recentes.
- Retrato grande: use read com query para achar o que procura. Lista longa: scroll com o ref de um item da lista (rola a própria lista).
- Se houver uma janela de diálogo aberta, o retrato mostra só ela. Termine ou feche o diálogo antes de mexer na página.
- Exemplo de URL direta: vagas no LinkedIn com candidatura simplificada: https://www.linkedin.com/jobs/search/?keywords=engenheiro%20de%20dados&location=Brasil&geoId=106057199&f_AL=true (f_AL=true filtra candidatura simplificada; geoId=106057199 é o Brasil)
- Formulários: preencha só com dados reais do usuário, que ficam em ${path.join(CONFIG_DIR, 'perfil.md')} (leia com read_file). NUNCA invente dados pessoais (experiência, salário, telefone, documentos, respostas de triagem). Se o arquivo não existir ou faltar um dado obrigatório, pare e pergunte ao usuário exatamente o que falta; sugira salvar a resposta no perfil.
- Botões de enviar, pagar, excluir ou publicar sempre pedem confirmação ao usuário, mesmo no modo auto. Isso é esperado; não tente contornar.
- Tarefas repetitivas (ex.: candidatar-se a várias vagas): declare o plano com update_plan, faça um item por vez e anote o resultado de cada um (feito, pulado e por quê). Pule o item que exige algo que você não tem (site externo, teste, dado ausente) em vez de travar. No fim, relate a lista.`;

// ---------- localizar o Chrome ----------
function findChrome() {
  if (process.env.RFCODE_BROWSER && fs.existsSync(process.env.RFCODE_BROWSER)) return process.env.RFCODE_BROWSER;
  const env = process.env;
  const candidates = process.platform === 'win32' ? [
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  if (process.platform !== 'win32') {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim(); } catch { /* tenta o próximo */ }
    }
  }
  return null;
}

// ---------- cliente CDP mínimo (WebSocket nativo do Node ≥ 22) ----------
class CDP {
  static connect(wsUrl) {
    if (typeof WebSocket === 'undefined') throw new Error('A ferramenta browser precisa do Node 22 ou mais novo (WebSocket nativo).');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = () => reject(new Error('Não foi possível conectar ao navegador.'));
    });
  }
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('A conexão com o navegador caiu.'));
      this.pending.clear();
    };
  }
  send(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('A conexão com o navegador caiu.'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`O navegador não respondeu (${method}).`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* já fechado */ } }
}

// ---------- scripts que rodam dentro da página ----------
// Retrato: texto visível em linhas + elementos interativos numerados. Se houver um diálogo aberto, só ele.
function pageSnapshot() {
  const STRONG = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=switch],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const WEAK = '[onclick],[tabindex]:not([tabindex="-1"])';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'HEAD', 'IFRAME', 'CANVAS', 'VIDEO']);
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)/;
  document.querySelectorAll('[data-rf]').forEach((e) => e.removeAttribute('data-rf'));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = (el) => !el.checkVisibility || el.checkVisibility({ visibilityProperty: true });
  const labelOf = (el) => {
    let l = el.getAttribute('aria-label') || '';
    if (!l && el.labels && el.labels.length) {
      // o <label> pode envolver o próprio campo: tira os controles para não misturar opções/valores no nome
      const c = el.labels[0].cloneNode(true);
      c.querySelectorAll('select,input,textarea,button').forEach((x) => x.remove());
      l = c.textContent;
    }
    if (!l && el.getAttribute('aria-labelledby')) {
      l = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
    }
    if (!l && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) l = el.innerText;
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    return clean(l).slice(0, 110);
  };
  const describe = (el) => {
    const tag = el.tagName, role = el.getAttribute('role'), type = (el.type || '').toLowerCase();
    let kind = role || { A: 'link', BUTTON: 'botão', SELECT: 'seleção', TEXTAREA: 'campo', SUMMARY: 'botão' }[tag];
    if (tag === 'INPUT') kind = { checkbox: 'checkbox', radio: 'radio', file: 'arquivo', submit: 'botão', button: 'botão' }[type] || 'campo';
    kind = kind || 'clicável';
    let s = `${kind} "${labelOf(el)}"`;
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) s += el.checked ? ' [marcado]' : ' [desmarcado]';
    else if ((tag === 'INPUT' || tag === 'TEXTAREA') && type !== 'file') {
      if (el.value) s += ` = "${clean(el.value).slice(0, 80)}"`;
      else if (el.placeholder && !s.includes(el.placeholder)) s += ` (ex.: ${clean(el.placeholder).slice(0, 40)})`;
    }
    if (tag === 'SELECT') {
      s += ` = "${clean(el.selectedOptions[0] && el.selectedOptions[0].text)}" opções: ${[...el.options].slice(0, 15).map((o) => clean(o.text)).join(' | ')}`;
    }
    if (/^(checkbox|radio|switch)$/.test(role)) s += el.getAttribute('aria-checked') === 'true' ? ' [marcado]' : ' [desmarcado]';
    if (el.required || el.getAttribute('aria-required') === 'true') s += ' (obrigatório)';
    if (el.getAttribute('aria-invalid') === 'true') s += ' (inválido)';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' (desabilitado)';
    return s;
  };
  let n = 0;
  const refs = {}, out = [];
  let line = '';
  const flush = () => { const t = clean(line); if (t) out.push(t); line = ''; };
  const walk = (node) => {
    if (node.nodeType === 3) { line += ' ' + node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' || !shown(el)) return;
    const strong = el.matches(STRONG);
    if (strong || (el.matches(WEAK) && !el.querySelector(STRONG))) {
      const r = el.getBoundingClientRect();
      const tiny = el.tagName === 'INPUT' && /^(checkbox|radio|file)$/i.test(el.type);
      if (r.width > 0 || r.height > 0 || tiny) {
        const id = ++n;
        el.setAttribute('data-rf', id);
        refs[id] = describe(el);
        line += ` [${id}] ${refs[id]} `;
        return;
      }
    }
    const heading = /^H[1-6]$/.test(el.tagName);
    const block = heading || BLOCK.test(getComputedStyle(el).display);
    if (block) flush();
    if (heading) line += '#'.repeat(+el.tagName[1]) + ' ';
    for (const c of el.childNodes) walk(c);
    if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
    if (block) flush();
  };
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter((d) => shown(d) && d.getBoundingClientRect().height > 0);
  const dialog = dialogs[dialogs.length - 1];
  if (dialog) { out.push('=== Diálogo aberto (a página atrás está bloqueada) ==='); walk(dialog); flush(); }
  else { walk(document.body); flush(); }
  return { title: document.title, url: location.href, text: out.join('\n'), refs, dialog: !!dialog };
}

function pageLocate(ref) {
  const el = document.querySelector(`[data-rf="${ref}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const clickable = !!hit && (el === hit || el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some((l) => l.contains(hit))));
  return { x, y, clickable };
}

function pageFocus(ref) {
  const el = document.querySelector(`[data-rf="${ref}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  try { if (typeof el.select === 'function') el.select(); else if (el.isContentEditable) document.execCommand('selectAll'); } catch { /* sem seleção */ }
  return true;
}

function pageSelect(ref, value) {
  const el = document.querySelector(`[data-rf="${ref}"]`);
  if (!el || el.tagName !== 'SELECT') return 'não é uma seleção';
  const v = String(value).toLowerCase().trim();
  const opt = [...el.options].find((o) => o.value.toLowerCase() === v || o.text.toLowerCase().trim() === v)
    || [...el.options].find((o) => o.text.toLowerCase().includes(v));
  if (!opt) return 'opção não encontrada. Opções: ' + [...el.options].map((o) => o.text.trim()).join(' | ');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok: ' + opt.text.trim();
}

function pageScroll(ref, dy) {
  let s = ref ? document.querySelector(`[data-rf="${ref}"]`) : null;
  while (s && s !== document.body && s !== document.documentElement) {
    const cs = getComputedStyle(s);
    if (/(auto|scroll)/.test(cs.overflowY) && s.scrollHeight > s.clientHeight + 4) break;
    s = s.parentElement;
  }
  if (!s || s === document.body || s === document.documentElement) { window.scrollBy(0, dy * innerHeight); return 'página'; }
  s.scrollBy(0, dy * s.clientHeight);
  return 'lista';
}

function pageFileInput(ref) {
  const el = document.querySelector(`[data-rf="${ref}"]`);
  const pick = (root) => root && (root.matches && root.matches('input[type=file]') ? root : root.querySelector('input[type=file]'));
  return pick(el) || (el && pick(el.closest('form,[role=dialog]'))) || document.querySelector('input[type=file]');
}

const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a ?? null)).join(',')})`;

const KEYS = {
  enter: ['Enter', 13], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27], backspace: ['Backspace', 8],
  delete: ['Delete', 46], space: [' ', 32], arrowdown: ['ArrowDown', 40], arrowup: ['ArrowUp', 38],
  arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39], pagedown: ['PageDown', 34], pageup: ['PageUp', 33],
  home: ['Home', 36], end: ['End', 35],
};

// ---------- navegador ----------
class Browser {
  constructor({ port = DEFAULT_PORT, profile = path.join(CONFIG_DIR, 'chrome-profile'), headless = !!process.env.RFCODE_BROWSER_HEADLESS, exe, args = [] } = {}) {
    this.port = port; this.profile = profile; this.headless = headless; this.exe = exe; this.extraArgs = args;
    this.base = `http://127.0.0.1:${port}`;
    this.cdp = null; this.targetId = null; this.refs = {};
  }

  async alive() {
    try { return (await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  }

  async launch() {
    const exe = this.exe || findChrome();
    if (!exe) throw new Error('Chrome ou Edge não encontrado. Instale o Chrome ou defina RFCODE_BROWSER com o caminho do executável.');
    fs.mkdirSync(this.profile, { recursive: true });
    const args = [`--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check'];
    if (this.headless) args.push('--headless=new', '--window-size=1280,900');
    args.push(...this.extraArgs);
    args.push('about:blank');
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: this.headless }).unref();
    for (let i = 0; i < 60; i++) { if (await this.alive()) return; await sleep(250); }
    throw new Error('O navegador não abriu a porta de controle. Feche janelas do Chrome que usem o perfil do rfcode e tente de novo.');
  }

  async pages() {
    const list = await (await fetch(`${this.base}/json/list`)).json();
    return list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  }

  async attach(target) {
    if (!target) {
      const pages = await this.pages();
      target = pages.find((p) => p.id === this.targetId) || pages[0];
      if (!target) target = await (await fetch(`${this.base}/json/new?about:blank`, { method: 'PUT' })).json();
    }
    if (this.cdp) this.cdp.close();
    this.cdp = await CDP.connect(target.webSocketDebuggerUrl);
    this.targetId = target.id;
    await this.cdp.send('Page.enable');
    if (!this.headless) await this.cdp.send('Page.bringToFront').catch(() => {});
  }

  async ensure() {
    if (this.cdp && !this.cdp.closed) return;
    if (!(await this.alive())) await this.launch();
    await this.attach();
  }

  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }

  // Espera a página carregar e "assentar" (sites SPA continuam mudando depois do load).
  async settle(extra = 700) {
    await sleep(350);
    for (let i = 0; i < 40; i++) {
      const state = await this.eval('document.readyState').catch(() => 'loading');
      if (state === 'complete') break;
      await sleep(250);
    }
    await sleep(extra);
  }

  async snapshot({ query, max = MAX_SNAPSHOT, offset = 0 } = {}) {
    const s = await this.eval(call(pageSnapshot));
    this.refs = s.refs || {};
    let text = s.text;
    if (query) {
      const q = query.toLowerCase();
      const lines = text.split('\n');
      const keep = lines.filter((l) => l.toLowerCase().includes(q));
      text = keep.length ? keep.join('\n') : `(nenhuma linha com "${query}")`;
    }
    let more = '';
    const from = Math.max(0, Math.min(+offset || 0, text.length));
    if (from) text = text.slice(from);
    if (text.length > max) {
      more = `\n[... mostrando ${from}-${from + max} de ${from + text.length} caracteres. Para continuar: read com offset ${from + max}; ou read com query.]`;
      text = text.slice(0, max);
    }
    return `Página: ${s.title}\nURL: ${s.url}\n\n${text || '(página sem texto visível)'}${more}`;
  }

  label(ref) { return this.refs[ref] || ''; }

  async mouseClick(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async pressKey(combo) {
    const parts = String(combo).split('+');
    const name = parts.pop();
    const mods = parts.reduce((m, p) => m | ({ alt: 1, control: 2, ctrl: 2, meta: 4, shift: 8 }[p.toLowerCase()] || 0), 0);
    const known = KEYS[name.toLowerCase()];
    const key = known ? known[0] : name;
    const code = known ? known[1] : name.toUpperCase().charCodeAt(0);
    const text = !known && name.length === 1 && !(mods & 2) ? name : known && name.toLowerCase() === 'enter' ? '\r' : undefined;
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, modifiers: mods, text });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers: mods });
  }

  needRef(a) {
    if (!Number.isInteger(a.ref)) throw new Error('Informe ref (o número [n] do elemento no retrato).');
  }

  async run(a = {}, signal) {
    const act = a.action || 'read';
    if (act === 'wait') { await sleep(Math.min(Math.max(+a.ms || 1000, 0), 30000)); return 'Pronto.'; }
    await this.ensure();
    if (signal && signal.aborted) throw new Error('Cancelado.');
    switch (act) {
      case 'open': {
        let url = String(a.url || '').trim();
        if (!url) throw new Error('Informe url.');
        if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
        if (!/^(https?:|about:blank)/i.test(url)) throw new Error('Só aceito endereços http(s).');
        if (a.new_tab) {
          const t = await (await fetch(`${this.base}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
          await this.attach(t);
        } else {
          await this.cdp.send('Page.navigate', { url });
        }
        await this.settle(1200);
        return this.snapshot();
      }
      case 'read':
        return this.snapshot({ query: a.query, offset: a.offset });
      case 'click': {
        this.needRef(a);
        const before = new Set((await this.pages()).map((p) => p.id));
        const at = await this.eval(call(pageLocate, a.ref));
        if (!at) throw new Error(`Elemento [${a.ref}] não existe mais. Leia a página de novo (read).`);
        if (at.clickable) await this.mouseClick(at.x, at.y);
        else await this.eval(`document.querySelector('[data-rf="${a.ref}"]').click()`);
        await this.settle();
        const fresh = (await this.pages()).find((p) => !before.has(p.id));
        let note = '';
        if (fresh) { await this.attach(fresh); await this.settle(800); note = '(O clique abriu uma aba nova; agora estou nela.)\n'; }
        return note + await this.snapshot();
      }
      case 'type': {
        this.needRef(a);
        if (!(await this.eval(call(pageFocus, a.ref)))) throw new Error(`Elemento [${a.ref}] não existe mais. Leia a página de novo (read).`);
        if (a.text) await this.cdp.send('Input.insertText', { text: String(a.text) });
        else await this.pressKey('Backspace');
        if (a.submit) await this.pressKey('Enter');
        await this.settle(a.submit ? 900 : 300);
        return this.snapshot();
      }
      case 'select': {
        this.needRef(a);
        const r = await this.eval(call(pageSelect, a.ref, a.value ?? ''));
        if (!String(r).startsWith('ok')) throw new Error(r);
        await this.settle(300);
        return `Selecionado ${r.slice(4)}.\n` + await this.snapshot();
      }
      case 'key':
        await this.pressKey(a.key || 'Enter');
        await this.settle(500);
        return this.snapshot();
      case 'scroll': {
        const where = await this.eval(call(pageScroll, Number.isInteger(a.ref) ? a.ref : null, a.direction === 'up' ? -0.8 : 0.8));
        await this.settle(600);
        return `(rolou a ${where})\n` + await this.snapshot();
      }
      case 'back':
        await this.eval('history.back()');
        await this.settle(900);
        return this.snapshot();
      case 'tabs': {
        const pages = await this.pages();
        return pages.map((p, i) => `${i + 1}. ${p.id === this.targetId ? '* ' : ''}${p.title} — ${p.url}`).join('\n') || '(nenhuma aba)';
      }
      case 'switch_tab': {
        const pages = await this.pages();
        const t = pages[(a.index || 1) - 1];
        if (!t) throw new Error(`Aba ${a.index} não existe (há ${pages.length}).`);
        await this.attach(t);
        return this.snapshot();
      }
      case 'upload': {
        this.needRef(a);
        const file = path.resolve(String(a.path || ''));
        if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);
        const r = await this.cdp.send('Runtime.evaluate', { expression: call(pageFileInput, a.ref) });
        if (!r.result || !r.result.objectId) throw new Error('Nenhum campo de arquivo encontrado perto desse elemento.');
        await this.cdp.send('DOM.setFileInputFiles', { files: [file], objectId: r.result.objectId });
        await this.settle(800);
        return `Arquivo enviado ao campo: ${path.basename(file)}\n` + await this.snapshot();
      }
      default:
        throw new Error(`Ação desconhecida: ${act}`);
    }
  }

  close() { if (this.cdp) this.cdp.close(); this.cdp = null; }

  // Fecha o Chrome do rfcode inteiro (usado nos testes).
  async quit() {
    this.close();
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`${this.base}/json/version`)).json();
      const b = await CDP.connect(webSocketDebuggerUrl);
      await b.send('Browser.close', {}, 5000).catch(() => {});
      b.close();
    } catch { /* já fechado */ }
  }
}

// Uma instância por processo: todas as conversas usam o mesmo Chrome do rfcode.
let shared = null;
const getBrowser = () => (shared ||= new Browser());

const MUTATING = new Set(['open', 'click', 'type', 'select', 'key', 'upload']);
const browserNeedsApproval = (a = {}) => MUTATING.has(a.action);
const browserMustConfirm = (a = {}, browser = shared) => a.action === 'click' && !!browser && SENSITIVE.test(browser.label(a.ref));

function browserDescribe(a = {}, browser = shared) {
  const lbl = browser && Number.isInteger(a.ref) ? browser.label(a.ref) : '';
  const ref = Number.isInteger(a.ref) ? ` [${a.ref}]${lbl ? ' ' + lbl.slice(0, 70) : ''}` : '';
  switch (a.action) {
    case 'open': return `Browser(open ${a.url || ''})`;
    case 'read': return `Browser(read${a.query ? ' ~ "' + a.query + '"' : ''})`;
    case 'type': return `Browser(type${ref} = "${String(a.text || '').slice(0, 50)}"${a.submit ? ' ⏎' : ''})`;
    case 'select': return `Browser(select${ref} = "${a.value || ''}")`;
    case 'key': return `Browser(key ${a.key || 'Enter'})`;
    case 'scroll': return `Browser(scroll ${a.direction || 'down'}${ref})`;
    case 'upload': return `Browser(upload${ref} ${a.path || ''})`;
    case 'switch_tab': return `Browser(aba ${a.index})`;
    default: return `Browser(${a.action || 'read'}${ref})`;
  }
}

module.exports = {
  Browser, getBrowser, BROWSER_TOOL_DEF, BROWSER_PROMPT, SENSITIVE,
  browserNeedsApproval, browserMustConfirm, browserDescribe, findChrome, pageSnapshot,
};
