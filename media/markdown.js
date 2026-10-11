// Renderizador de markdown do painel (UMD: window.rfMarkdown no webview, module.exports no Node/testes).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rfMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Recebe texto já escapado. Código inline é separado antes para não receber negrito/itálico.
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  function codeBlock(lang, code) {
    const l = esc((lang || '').trim().split(/\s+/)[0] || '');
    return `<div class="code"><div class="code-head"><span class="lang">${l || 'código'}</span>`
      + '<button class="copy" type="button" title="Copiar">Copiar</button></div>'
      + `<pre><code${l ? ` data-lang="${l}"` : ''}>${esc(code)}</code></pre></div>`;
  }

  function blocks(part, out) {
    const lines = esc(part).split('\n');
    let para = [], list = null, quote = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    const flushList = () => {
      if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; }
    };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`); quote = []; } };
    const flush = () => { flushPara(); flushList(); flushQuote(); };
    for (const line of lines) {
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
        flush();
        const lvl = Math.min(4, m[1].length + 1);
        out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); out.push('<hr>'); continue; }
      if ((m = line.match(/^&gt;\s?(.*)/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        flushPara(); flushQuote();
        const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      flushList(); flushQuote();
      para.push(line);
    }
    flush();
  }

  function render(src) {
    const out = [];
    const parts = String(src || '').split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const lang = nl >= 0 ? part.slice(0, nl) : '';
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        out.push(codeBlock(lang, code.replace(/\n$/, '')));
      } else {
        blocks(part, out);
      }
    });
    return out.join('');
  }

  return { render, esc, inline };
});
