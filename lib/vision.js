'use strict';
// Visão: o celular fica com a câmera aberta, mostra uma pergunta (prova, exercício, placa, tela, objeto)
// e o rfcode responde com os modelos de visão gratuitos de build.nvidia.com.
//
// O servidor roda no PC, na rede local, em HTTPS com um certificado próprio: o navegador do celular só
// libera a câmera ao vivo em página segura. A chave da NVIDIA fica no PC; o celular só manda a foto.
// Tudo exige o token do link (QR code).

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { lanAddresses, primaryAddress } = require('./remote');

const DEFAULT_PORT = 7443;
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

// Modelos com visão no catálogo gratuito da NVIDIA, do melhor para o mais leve. Se um não estiver
// disponível para a conta (404/410) ou estourar o limite (429), o próximo é tentado.
const VISION_MODELS = [
  ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'Nemotron 3.5 Super VL da NVIDIA, rápido, lê documentos e telas'],
  ['meta/llama-3.2-90b-vision-instruct', 'Llama 3.2 Vision 90B'],
];

const SYSTEM_PROMPT = `Você é o rfcode visão: um assistente que enxerga pela câmera do celular da pessoa.
Cada mensagem traz uma foto do que a câmera está vendo agora.
- Se houver uma pergunta, questão de prova, exercício, conta ou problema escrito (papel, quadro, livro ou tela), leia com cuidado e resolva. Comece pela resposta final em uma linha (por exemplo "Resposta: C) 42"), depois explique em poucas linhas como chegou nela.
- Se a pessoa escreveu ou falou uma pergunta, responda a ela usando a imagem.
- Se não houver pergunta, diga em poucas palavras o que você vê e como pode ajudar.
- Se o texto estiver cortado, borrado ou escuro, diga exatamente o que ajustar (aproximar, mais luz, enquadrar a questão inteira) em vez de chutar.
Responda sempre em português do Brasil, de forma direta e curta: a resposta vai aparecer na tela do celular e pode ser lida em voz alta. Use markdown simples (negrito e listas), sem tabelas.`;

// ---------- certificado autoassinado (sem openssl) ----------
const der = {
  len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) { bytes.unshift(n & 0xff); n >>>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  },
  tlv(tag, body) { return Buffer.concat([Buffer.from([tag]), der.len(body.length), body]); },
  seq(...items) { return der.tlv(0x30, Buffer.concat(items)); },
  int(buf) { if (typeof buf === 'number') buf = Buffer.from([buf]); if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); return der.tlv(0x02, buf); },
  oid(s) {
    const p = s.split('.').map(Number);
    const out = [40 * p[0] + p[1]];
    for (const v of p.slice(2)) {
      const enc = [v & 0x7f];
      for (let x = v >>> 7; x > 0; x >>>= 7) enc.unshift(0x80 | (x & 0x7f));
      out.push(...enc);
    }
    return der.tlv(0x06, Buffer.from(out));
  },
  nul() { return Buffer.from([0x05, 0x00]); },
  utf8(s) { return der.tlv(0x0c, Buffer.from(s, 'utf8')); },
  time(d) { return der.tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z')); },
  bits(buf) { return der.tlv(0x03, Buffer.concat([Buffer.from([0]), buf])); },
  octet(buf) { return der.tlv(0x04, buf); },
};

/** Certificado X.509 autoassinado válido para os IPs informados e localhost. Devolve { key, cert } em PEM. */
function selfSignedCert(ips = [], { days = 365, name = 'rfcode visao' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = der.seq(der.oid('1.2.840.113549.1.1.11'), der.nul()); // sha256WithRSAEncryption
  const dn = der.seq(der.tlv(0x31, der.seq(der.oid('2.5.4.3'), der.utf8(name)))); // CN
  const now = new Date(Date.now() - 60_000);
  const until = new Date(now.getTime() + days * 86400_000);
  const altNames = [der.tlv(0x82, Buffer.from('localhost'))];
  for (const ip of ips) if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) altNames.push(der.tlv(0x87, Buffer.from(ip.split('.').map(Number))));
  const extensions = der.tlv(0xa3, der.seq(
    der.seq(der.oid('2.5.29.17'), der.octet(der.seq(...altNames))), // subjectAltName
    der.seq(der.oid('2.5.29.37'), der.octet(der.seq(der.oid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage: serverAuth
  ));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const tbs = der.seq(
    der.tlv(0xa0, der.int(2)), der.int(serial), alg, dn, der.seq(der.time(now), der.time(until)), dn,
    publicKey.export({ type: 'spki', format: 'der' }), extensions,
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = der.seq(tbs, alg, der.bits(signature));
  const b64 = certDer.toString('base64').replace(/.{64}/g, '$&\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`,
  };
}

// Reaproveita o certificado entre execuções (o celular só pede para confiar uma vez) enquanto os IPs forem os mesmos.
function loadOrCreateCert(ips, dir) {
  const file = path.join(dir, 'visao-cert.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const x = new crypto.X509Certificate(c.cert);
    const fresh = Date.parse(x.validTo) - Date.now() > 7 * 86400_000;
    if (fresh && ips.every((ip) => (c.ips || []).includes(ip))) return c;
  } catch { /* não existe ou inválido: gera outro */ }
  const c = { ips, ...selfSignedCert(ips) };
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 }); } catch { /* segue sem cache */ }
  return c;
}

// ---------- chamada ao modelo ----------
function buildMessages({ image, question, history = [] }) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history.slice(-3)) {
    if (h && h.q) msgs.push({ role: 'user', content: String(h.q).slice(0, 2000) });
    if (h && h.a) msgs.push({ role: 'assistant', content: String(h.a).slice(0, 4000) });
  }
  const text = String(question || '').trim() || 'Leia o que aparece na imagem. Se houver uma pergunta ou exercício, resolva.';
  msgs.push({ role: 'user', content: [{ type: 'text', text: text.slice(0, 2000) }, { type: 'image_url', image_url: { url: image } }] });
  return msgs;
}

function postJson(url, body, headers, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': data.length, ...headers }, timeout }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch { /* não é json */ } resolve({ status: res.statusCode, json, text: out }); });
    });
    req.on('timeout', () => req.destroy(new Error('o modelo demorou demais para responder')));
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Pergunta ao modelo de visão. models: lista em ordem de preferência; o primeiro que responder vence.
 * Devolve { answer, model }.
 */
async function askVision({ apiKey, image, question, history, models = VISION_MODELS.map((m) => m[0]), baseUrl = NVIDIA_BASE, post = postJson }) {
  if (!apiKey) throw new Error('Falta a chave da NVIDIA. Rode "rfcode --key" ou defina NVIDIA_API_KEY.');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(String(image || ''))) throw new Error('Imagem inválida.');
  const messages = buildMessages({ image, question, history });
  const errors = [];
  for (const model of models) {
    let r;
    try {
      r = await post(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { model, messages, max_tokens: 700, temperature: 0.2, stream: false }, { Authorization: `Bearer ${apiKey}` });
    } catch (e) { errors.push(`${model}: ${e.message}`); continue; }
    if (r.status === 401 || r.status === 403) throw new Error('A chave da NVIDIA foi recusada. Gere outra em build.nvidia.com/settings/api-keys e rode "rfcode --key".');
    const answer = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content;
    if (r.status >= 200 && r.status < 300 && answer) return { answer: String(answer).trim(), model };
    const detail = (r.json && (r.json.detail || (r.json.error && (r.json.error.message || r.json.error)))) || r.text || '';
    errors.push(`${model}: ${r.status} ${String(detail).slice(0, 160)}`);
  }
  const limit = errors.some((e) => /: 429 /.test(e));
  throw new Error(limit ? 'Limite de pedidos da NVIDIA atingido. Espere alguns segundos e tente de novo.' : `Nenhum modelo de visão respondeu.\n${errors.join('\n')}`);
}

// ---------- página do celular ----------
function pageHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000"><meta name="robots" content="noindex">
<title>rfcode visão</title>
<style>
:root{--accent:#76b900;--bg:#000;--sheet:rgba(18,20,24,.92);--fg:#f2f2f2;--muted:#a3a8b0;--line:#30343b;--err:#ff6b6b}
*{box-sizing:border-box}html,body{margin:0;height:100%;height:100dvh;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
video{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
#top{position:fixed;top:0;left:0;right:0;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;display:flex;gap:8px;align-items:center;background:linear-gradient(#000a,#0000);z-index:2}
#top b{flex:1;font-size:15px;letter-spacing:.2px}#top b span{color:var(--accent)}
.chip{border:1px solid #fff4;background:#0006;color:#fff;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer}
.chip.on{background:var(--accent);border-color:var(--accent);color:#111;font-weight:600}
#sheet{position:fixed;left:0;right:0;bottom:0;z-index:2;background:var(--sheet);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:18px 18px 0 0;padding:12px 14px calc(12px + env(safe-area-inset-bottom));max-height:62dvh;display:flex;flex-direction:column;gap:10px}
#answer{overflow-y:auto;font-size:16px;min-height:0;flex:1}
#answer:empty{display:none}
#answer p{margin:0 0 8px}#answer ul{margin:0 0 8px;padding-left:20px}#answer code{background:#fff1;padding:1px 4px;border-radius:4px}
#status{font-size:13px;color:var(--muted);min-height:18px}#status.err{color:var(--err)}
.row{display:flex;gap:8px;align-items:center}
#q{flex:1;min-width:0;background:#24272e;border:1px solid var(--line);color:var(--fg);border-radius:12px;padding:11px 12px;font-size:16px}
.icon{width:46px;height:46px;border-radius:50%;border:1px solid var(--line);background:#24272e;color:#fff;font-size:20px;display:grid;place-items:center;cursor:pointer;flex:none}
.icon.on{background:#c62828;border-color:#c62828}
#shoot{width:64px;height:64px;border-radius:50%;border:4px solid #fff;background:var(--accent);flex:none;cursor:pointer;position:relative}
#shoot:disabled{opacity:.6}
#shoot.busy::after{content:"";position:absolute;inset:10px;border:3px solid #111;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#gate{position:fixed;inset:0;z-index:5;display:none;place-items:center;padding:24px;text-align:center;background:#000}
#gate div{max-width:420px}#gate button{margin-top:16px;padding:12px 20px;border-radius:12px;border:0;background:var(--accent);color:#111;font-weight:600;font-size:16px}
#flash{position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:3;transition:opacity .25s}
</style></head><body>
<video id="v" playsinline muted autoplay></video>
<div id="flash"></div>
<div id="top"><b>rfcode <span>visão</span></b>
  <button class="chip" id="auto" title="Responde sozinho quando a câmera para numa pergunta nova">Auto</button>
  <button class="chip on" id="voz" title="Ler a resposta em voz alta">Voz</button>
  <button class="chip" id="flip" title="Trocar de câmera">⟲</button>
</div>
<div id="sheet">
  <div id="answer"></div>
  <div id="status">Aponte a câmera para a pergunta e toque no botão verde.</div>
  <div class="row">
    <input id="q" placeholder="Pergunta (opcional)" enterkeyhint="send" autocomplete="off">
    <button class="icon" id="mic" title="Falar a pergunta">🎤</button>
    <button id="shoot" title="Responder"></button>
  </div>
</div>
<div id="gate"><div id="gateText"></div></div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var q = new URLSearchParams(location.hash.slice(1));
  var token = q.get('t') || sessionStorage.getItem('rfv-t') || '';
  if (q.get('t')) { sessionStorage.setItem('rfv-t', token); history.replaceState(null, '', location.pathname); }
  var video = $('v'), statusEl = $('status'), answerEl = $('answer'), shoot = $('shoot');
  var facing = 'environment', stream = null, busy = false, hist = [];
  var pref = function(k, d){ try { var v = localStorage.getItem('rfv-' + k); return v === null ? d : v === '1'; } catch(e){ return d; } };
  var save = function(k, v){ try { localStorage.setItem('rfv-' + k, v ? '1' : '0'); } catch(e){} };
  var speakOn = pref('voz', true), autoOn = false;
  $('voz').classList.toggle('on', speakOn);

  function status(t, err){ statusEl.textContent = t; statusEl.className = err ? 'err' : ''; }
  function gate(html, btn, fn){ $('gate').style.display = 'grid'; $('gateText').innerHTML = html + (btn ? '<br><button id="gateBtn">' + btn + '</button>' : ''); if (btn) $('gateBtn').onclick = fn; }

  if (!token) return gate('<p>Link sem token.</p><p>Leia de novo o QR code que aparece no terminal do PC (<b>rfcode visao</b>).</p>');
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    return gate('<p>O navegador só libera a câmera em página segura (https).</p><p>Abra o link https que aparece no PC.</p>');

  function esc(s){ return s.replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }
  function md(s){
    var out = [], list = false;
    esc(s).split(/\\n/).forEach(function(line){
      line = line.replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>').replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/^#{1,6}\\s*/, '');
      var m = /^\\s*(?:[-*•]|\\d+[.)])\\s+(.*)/.exec(line);
      if (m) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + m[1] + '</li>'); return; }
      if (list) { out.push('</ul>'); list = false; }
      if (line.trim()) out.push('<p>' + line + '</p>');
    });
    if (list) out.push('</ul>');
    return out.join('');
  }

  function startCamera(){
    if (stream) stream.getTracks().forEach(function(t){ t.stop(); });
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then(function(s){ stream = s; video.srcObject = s; $('gate').style.display = 'none'; return video.play(); })
      .catch(function(e){ gate('<p>Não consegui abrir a câmera (' + esc(e.name || String(e)) + ').</p><p>Permita o acesso à câmera para este site nas configurações do navegador.</p>', 'Tentar de novo', startCamera); });
  }

  // Foto do quadro atual, no máximo 1280 px no lado maior, em JPEG (fica leve para enviar).
  function capture(maxSide){
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    var s = Math.min(1, (maxSide || 1280) / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  function speak(text){
    if (!speakOn || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    var clean = text.replace(/[*_#\`>]/g, '').replace(/\\n+/g, '. ');
    var u = new SpeechSynthesisUtterance(clean); u.lang = 'pt-BR'; u.rate = 1.05;
    var v = speechSynthesis.getVoices().filter(function(x){ return /^pt(-|_)BR/i.test(x.lang); })[0]; if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  function ask(){
    if (busy) return;
    var c = capture(1280);
    if (!c) return status('A câmera ainda está abrindo…');
    var question = $('q').value.trim();
    busy = true; shoot.disabled = true; shoot.classList.add('busy');
    $('flash').style.opacity = '.6'; setTimeout(function(){ $('flash').style.opacity = '0'; }, 120);
    status('Pensando…');
    if (window.speechSynthesis) speechSynthesis.cancel();
    fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RF-Token': token },
      body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.8), question: question, history: hist }) })
      .then(function(r){ return r.json().catch(function(){ return { error: 'Resposta inválida do PC (' + r.status + ').' }; }).then(function(j){ if (r.status === 401) j.error = 'Sessão expirada. Leia o QR code de novo.'; return j; }); })
      .then(function(j){
        if (j.error) { status(j.error, true); return; }
        answerEl.innerHTML = md(j.answer); answerEl.scrollTop = 0;
        status((j.model || '').split('/').pop() + ' · ' + (j.ms / 1000).toFixed(1) + ' s');
        hist.push({ q: question || '(pergunta na imagem)', a: j.answer }); hist = hist.slice(-3);
        $('q').value = '';
        speak(j.answer);
      })
      .catch(function(){ status('Sem conexão com o PC. Ele ainda está rodando o rfcode visao?', true); })
      .then(function(){ busy = false; shoot.disabled = false; shoot.classList.remove('busy'); });
  }

  shoot.onclick = ask;
  $('q').addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); ask(); } });
  $('voz').onclick = function(){ speakOn = !speakOn; save('voz', speakOn); this.classList.toggle('on', speakOn); if (!speakOn && window.speechSynthesis) speechSynthesis.cancel(); };
  $('flip').onclick = function(){ facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };

  // Modo automático: quando a imagem muda (pergunta nova) e depois fica parada por ~1,5 s, responde sozinho.
  var last = null, changed = false, stillSince = 0, timer = null;
  function thumb(){
    var c = capture(48); if (!c) return null;
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, g = [];
    for (var i = 0; i < d.length; i += 4) g.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    return g;
  }
  function diff(a, b){ if (!a || !b || a.length !== b.length) return 255; var s = 0; for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
  function tick(){
    var t = thumb(); if (!t) return;
    var d = diff(t, last); last = t;
    if (d > 14) { changed = true; stillSince = 0; return; }
    if (!changed || busy) return;
    if (!stillSince) { stillSince = Date.now(); return; }
    if (Date.now() - stillSince > 1500) { changed = false; stillSince = 0; ask(); }
  }
  $('auto').onclick = function(){
    autoOn = !autoOn; this.classList.toggle('on', autoOn);
    clearInterval(timer);
    if (autoOn) { last = null; changed = true; stillSince = 0; timer = setInterval(tick, 400); status('Modo automático: segure a câmera parada numa pergunta.'); }
    else status('Modo automático desligado.');
  };

  // Pergunta por voz (Chrome no Android e Safari no iPhone)
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) $('mic').style.display = 'none';
  else $('mic').onclick = function(){
    var btn = this, rec = new Rec(); rec.lang = 'pt-BR'; rec.interimResults = true;
    btn.classList.add('on'); status('Ouvindo…');
    rec.onresult = function(e){ var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; $('q').value = t; };
    rec.onerror = function(e){ status('Microfone: ' + e.error, true); };
    rec.onend = function(){ btn.classList.remove('on'); if ($('q').value.trim()) ask(); else status(''); };
    rec.start();
  };

  if (window.speechSynthesis) speechSynthesis.getVoices();
  startCamera();
})();
</script></body></html>`;
}

// ---------- servidor ----------
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class VisionServer {
  /** getKey(): chave da NVIDIA; models: lista de modelos; certDir: onde guardar o certificado; secure: false para HTTP puro (testes). */
  constructor({ getKey, models, baseUrl = NVIDIA_BASE, certDir = path.join(os.homedir(), '.rfcode'), secure = true, onAsk = () => {}, post } = {}) {
    this.getKey = getKey || (() => process.env.NVIDIA_API_KEY || '');
    this.models = models && models.length ? models : VISION_MODELS.map((m) => m[0]);
    this.baseUrl = baseUrl;
    this.certDir = certDir;
    this.secure = secure;
    this.onAsk = onAsk;
    this.post = post;
    this.token = crypto.randomBytes(18).toString('base64url');
    this.server = null;
    this.port = 0;
    this.busy = 0;
  }

  get running() { return !!this.server; }

  async start(port = DEFAULT_PORT) {
    this.primary = await primaryAddress();
    this.addresses = lanAddresses(this.primary);
    try { return await this.listen(port); } catch (e) {
      if (e.code === 'EADDRINUSE' && port) return this.listen(0);
      throw e;
    }
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const handler = (req, res) => this.handle(req, res).catch((e) => { try { this.json(res, 500, { error: e.message }); } catch { /* já respondido */ } });
      let server;
      if (this.secure) {
        const c = loadOrCreateCert(this.addresses.map((a) => a.address), this.certDir);
        server = https.createServer({ key: c.key, cert: c.cert }, handler);
      } else server = http.createServer(handler);
      server.on('error', reject);
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this.urls());
      });
    });
  }

  urls() {
    const scheme = this.secure ? 'https' : 'http';
    const list = this.addresses.length ? this.addresses : [{ name: 'local', address: '127.0.0.1' }];
    return list.map((a) => ({ name: a.name, url: `${scheme}://${a.address}:${this.port}/#t=${this.token}` }));
  }

  json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(obj));
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(self), microphone=(self)',
      });
      return res.end(pageHtml());
    }
    if (req.method === 'POST' && u.pathname === '/ask') {
      if (!safeEqual(req.headers['x-rf-token'], this.token)) return this.json(res, 401, { error: 'token inválido' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8_000_000) return this.json(res, 413, { error: 'Imagem grande demais.' }); }
      let msg;
      try { msg = JSON.parse(body); } catch { return this.json(res, 400, { error: 'JSON inválido.' }); }
      if (this.busy >= 2) return this.json(res, 429, { error: 'Ainda respondendo a pergunta anterior.' });
      this.busy++;
      const t0 = Date.now();
      try {
        const r = await askVision({ apiKey: this.getKey(), image: msg.image, question: msg.question, history: Array.isArray(msg.history) ? msg.history : [], models: this.models, baseUrl: this.baseUrl, ...(this.post ? { post: this.post } : {}) });
        // o modelo que respondeu vai para a frente da fila: as próximas perguntas são mais rápidas
        this.models = [r.model, ...this.models.filter((m) => m !== r.model)];
        const out = { answer: r.answer, model: r.model, ms: Date.now() - t0 };
        this.onAsk({ question: msg.question || '', ...out });
        return this.json(res, 200, out);
      } catch (e) {
        this.onAsk({ question: msg.question || '', error: e.message });
        return this.json(res, 200, { error: e.message });
      } finally { this.busy--; }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('não encontrado');
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }
}

// QR code para o terminal, com meio-blocos (duas linhas do código por linha do terminal).
function qrTerminal(text) {
  const m = require('./qr').qrMatrix(text);
  const n = m.length, pad = 2, at = (y, x) => (y >= 0 && y < n && x >= 0 && x < n ? m[y][x] : false);
  const lines = [];
  for (let y = -pad; y < n + pad; y += 2) {
    let s = '';
    for (let x = -pad; x < n + pad; x++) {
      const top = at(y, x), bottom = at(y + 1, x);
      s += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(s);
  }
  return lines.join('\n');
}

module.exports = { VisionServer, VISION_MODELS, SYSTEM_PROMPT, DEFAULT_PORT, askVision, buildMessages, selfSignedCert, loadOrCreateCert, pageHtml, qrTerminal };
