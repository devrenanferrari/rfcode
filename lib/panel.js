'use strict';
// HTML do painel de chat, compartilhado pela webview do VS Code e pela página do controle remoto.

const svgIcon = (d, size = 15) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}">${d}</svg>`;

function panelBody() {
  return `
  <header class="top">
    <label class="model" title="Modelo da NVIDIA"><span class="dot"></span><select id="model" aria-label="Modelo"></select></label>
    <span class="spacer"></span>
    <span class="folder" id="folder"></span>
    <button class="icon-btn hidden" id="remoteBtn" type="button" title="Controle remoto ativo">${svgIcon('<rect x="4.5" y="1.5" width="7" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 12.2h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>')}</button>
    <button class="icon-btn" id="historyBtn" type="button" title="Histórico de conversas (/history)">${svgIcon('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.8v2.6h2.6M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')}</button>
    <button class="icon-btn" id="newChatBtn" type="button" title="Nova conversa (/new)">${svgIcon('<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>')}</button>
  </header>
  <main id="log"></main>
  <section id="history" class="history hidden" aria-label="Histórico">
    <div class="history-head">
      <input id="historySearch" type="search" placeholder="Buscar conversas…" aria-label="Buscar conversas">
      <button class="icon-btn" id="historyClose" type="button" title="Fechar">${svgIcon('<path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', 14)}</button>
    </div>
    <div id="historyList" class="history-list"></div>
  </section>
  <footer>
    <div id="plan" class="plan hidden"></div>
    <div id="cmdMenu" class="cmd-menu hidden" role="listbox" aria-label="Comandos"></div>
    <div class="composer">
      <div id="modeBadge" class="mode-badge hidden"></div>
      <div id="chips" class="chips hidden"></div>
      <textarea id="input" rows="1" placeholder="Peça algo ao rfcode… ( / para comandos)" aria-label="Mensagem"></textarea>
      <div class="composer-bar">
        <button id="attach" class="icon-btn" type="button" title="Anexar imagem ou arquivo">${svgIcon('<path d="M10.5 3.5L4.8 9.2a2.6 2.6 0 003.7 3.7l6-6a1.7 1.7 0 00-2.4-2.4l-5.6 5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')}</button>
        <input type="file" id="fileInput" multiple hidden>
        <label class="switch" title="Aprovar edições, comandos e controle do PC sem perguntar">
          <input type="checkbox" id="auto"><span class="track"></span><span class="lbl">Auto</span>
        </label>
        <label class="effort" title="Esforço: quanto o rfcode investiga e verifica antes de concluir (/effort)">${svgIcon('<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 11.5l2.6-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>', 13)}<select id="effort" aria-label="Esforço">
          <option value="low">Baixo</option><option value="medium">Médio</option><option value="high">Alto</option>
        </select></label>
        <span id="status"></span>
        <button id="stop" class="round stop hidden" type="button" title="Parar (Esc)">${svgIcon('<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>', 12)}</button>
        <button id="send" class="round send" type="button" title="Enviar (Enter)">${svgIcon('<path d="M8 13V3.5M3.8 7.5L8 3.3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>', 14)}</button>
      </div>
    </div>
  </footer>`;
}

module.exports = { panelBody };
