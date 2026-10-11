'use strict';
// Gera vídeos (estilo apresentação animada, com narração) sem dependências:
// - narração: voz do Windows (System.Speech, ex. "Microsoft Maria" pt-BR) gravada em WAV;
// - imagem: cenas desenhadas num <canvas> do Chrome headless e gravadas com MediaRecorder (WebM VP9/Opus);
// - se houver ffmpeg no PATH e o destino for .mp4, converte para MP4 (H.264/AAC).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { Browser } = require('./browser');
const { THEMES, imageInfo } = require('./office');

const IS_WIN = process.platform === 'win32';
const MAX_SECONDS = 600;

// ---------- narração (Windows SAPI) ----------
function listVoices() {
  if (!IS_WIN) return [];
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture }'],
  { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture] = l.split('|'); return { name, culture }; });
}

function pickVoice(wanted, voices) {
  if (wanted) {
    const v = voices.find((x) => x.name.toLowerCase().includes(String(wanted).toLowerCase()));
    if (v) return v.name;
  }
  return (voices.find((x) => /pt-BR/i.test(x.culture)) || voices.find((x) => /^pt/i.test(x.culture)) || voices[0] || {}).name;
}

// Gera um WAV por texto numa única chamada do PowerShell (mais rápido). rate: -10 a 10.
function synthesize(items, voice, rate = 0) {
  if (!items.length) return;
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `$s.SelectVoice(${JSON.stringify(voice)})` : '',
    `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}`,
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    ...items.map((it) => `$s.SetOutputToWaveFile(${JSON.stringify(it.wav)}, $fmt); $s.Speak([IO.File]::ReadAllText(${JSON.stringify(it.txt)}, [Text.Encoding]::UTF8))`),
    '$s.SetOutputToNull(); $s.Dispose()',
  ].filter(Boolean).join('; ');
  for (const it of items) fs.writeFileSync(it.txt, it.text, 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  if (r.status !== 0) throw new Error('Falha na narração: ' + (r.stderr || r.stdout || '').slice(0, 400));
}

function wavDuration(file) {
  const b = fs.readFileSync(file);
  const byteRate = b.readUInt32LE(28);
  let p = 12;
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'data') return size / byteRate;
    p += 8 + size;
  }
  return 0;
}

// ---------- WebM do MediaRecorder não traz a duração: corrige o cabeçalho para os players saberem o tempo ----------
function readVint(b, p) {
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b[p] & mask)) { len++; mask >>= 1; }
  let v = b[p] & (mask - 1);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { len, value: v, unknown: v === Math.pow(2, 7 * len) - 1 };
}
function readId(b, p) {
  let len = 1, mask = 0x80;
  while (len <= 4 && !(b[p] & mask)) { len++; mask >>= 1; }
  return { len, id: b.readUIntBE(p, len) };
}
function fixWebmDuration(buf, ms) {
  let p = 0;
  const top = readId(buf, p); // EBML header
  const topSize = readVint(buf, p + top.len);
  p += top.len + topSize.len + topSize.value;
  const seg = readId(buf, p);
  if (seg.id !== 0x18538067) return buf;
  const segSize = readVint(buf, p + seg.len);
  let q = p + seg.len + segSize.len;
  while (q < buf.length) {
    const el = readId(buf, q);
    const sz = readVint(buf, q + el.len);
    const start = q + el.len + sz.len;
    if (el.id === 0x1549a966) { // Info
      const content = buf.slice(start, start + sz.value);
      // já tem Duration?
      let r = 0;
      while (r < content.length) {
        const c = readId(content, r), cs = readVint(content, r + c.len);
        if (c.id === 0x4489) return buf;
        r += c.len + cs.len + cs.value;
      }
      const dur = Buffer.alloc(11);
      dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; dur.writeDoubleBE(ms, 3);
      const newContent = Buffer.concat([content, dur]);
      const size = Buffer.alloc(8);
      size[0] = 0x01; size.writeUIntBE(newContent.length, 2, 6);
      return Buffer.concat([buf.slice(0, q), buf.slice(q, q + el.len), size, newContent, buf.slice(start + sz.value)]);
    }
    if (sz.unknown) break;
    q = start + sz.value;
  }
  return buf;
}

function findFfmpeg() {
  for (const bin of ['ffmpeg', 'ffmpeg.exe']) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true }); return bin; } catch { /* não achou */ }
  }
  const links = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
  return links && fs.existsSync(links) ? links : null;
}

// ---------- página que desenha e grava ----------
function recorderPage() {
  window.rfVideo = async (spec) => {
    const W = spec.width, H = spec.height, T = spec.theme;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    document.body.appendChild(cv);
    const g = cv.getContext('2d');
    const k = W / 1280; // escala relativa a 1280x720
    const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
    const imgs = await Promise.all(spec.scenes.map((s) => (s.image ? new Promise((res) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = window.rfData['i' + spec.scenes.indexOf(s)];
    }) : null)));
    const actx = new AudioContext();
    const dest = actx.createMediaStreamDestination();
    // fonte de silêncio sempre ligada: sem nenhuma fonte, a trilha de áudio fica muda e o MediaRecorder não grava nada
    const keep = actx.createConstantSource();
    keep.offset.value = 0;
    keep.connect(dest);
    keep.start();
    const buffers = await Promise.all(spec.scenes.map(async (s) => {
      if (!s.audio) return null;
      const bin = Uint8Array.from(atob(window.rfData['a' + spec.scenes.indexOf(s)]), (c) => c.charCodeAt(0));
      return actx.decodeAudioData(bin.buffer);
    }));

    const wrap = (text, maxW) => {
      const words = String(text).split(/\s+/); const lines = []; let line = '';
      for (const w of words) {
        const t = line ? line + ' ' + w : w;
        if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
      }
      if (line) lines.push(line);
      return lines;
    };
    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    const total = spec.scenes.reduce((s, x) => s + x.duration, 0);

    function drawScene(i, t) {
      const s = spec.scenes[i], d = s.duration, img = imgs[i];
      g.globalAlpha = 1;
      g.fillStyle = '#' + T.bg; g.fillRect(0, 0, W, H);
      const glow = g.createRadialGradient(W * 0.92, H * 0.05, 0, W * 0.92, H * 0.05, W * 0.6);
      glow.addColorStop(0, '#' + T.accent + '33'); glow.addColorStop(1, '#' + T.accent + '00');
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
      const bullets = s.bullets || [];
      const cover = s.type === 'capa' || s.type === 'encerramento' || (!bullets.length && !s.text && !img);
      const appear = (j, n) => ease((t - (0.25 + j * Math.min(1.2, (d * 0.55) / Math.max(1, n)))) / 0.45);
      if (cover) {
        const a = ease(t / 0.6);
        g.globalAlpha = a;
        if (s.emoji) {
          g.textAlign = 'center'; g.textBaseline = 'alphabetic';
          g.font = `${120 * k}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
          g.fillText(s.emoji, W / 2, H * 0.3 - (1 - a) * 20 * k);
        }
        g.fillStyle = '#' + T.accent; g.fillRect(W / 2 - 40 * k, H * 0.36, 80 * k, 6 * k);
        g.fillStyle = '#' + T.fg; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.font = `700 ${64 * k}px ${FONT}`;
        const tl = wrap(s.title || '', W * 0.8);
        tl.forEach((l, j) => g.fillText(l, W / 2, H * 0.36 + (80 + j * 76) * k - (20 * (1 - a)) * k));
        if (s.subtitle) {
          g.globalAlpha = ease((t - 0.4) / 0.6);
          g.fillStyle = '#' + T.muted; g.font = `400 ${28 * k}px ${FONT}`;
          wrap(s.subtitle, W * 0.7).forEach((l, j) => g.fillText(l, W / 2, H * 0.36 + (80 + tl.length * 76 + 20 + j * 40) * k));
        }
        g.textAlign = 'left';
      } else {
        const x0 = 80 * k;
        g.globalAlpha = ease(t / 0.5);
        g.fillStyle = '#' + T.fg; g.font = `700 ${50 * k}px ${FONT}`; g.textBaseline = 'alphabetic';
        g.fillText(s.title || '', x0, 120 * k);
        g.fillStyle = '#' + T.accent; g.fillRect(x0, 142 * k, 70 * k * ease(t / 0.7), 6 * k);
        const textW = img || s.emoji ? W * 0.55 : W - 2 * x0;
        if (s.emoji && !img) {
          const pop = ease((t - 0.15) / 0.5);
          g.save(); g.globalAlpha = pop; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.font = `${200 * k * (0.85 + 0.15 * pop)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
          g.fillText(s.emoji, W * 0.8, H * 0.55);
          g.restore();
        }
        let y = 220 * k;
        if (img) {
          const bx = img && (bullets.length || s.text) ? W * 0.52 : x0, bw = (bullets.length || s.text) ? W * 0.48 - x0 : W - 2 * x0;
          const by = 180 * k, bh = H - by - 90 * k;
          const sc = Math.min(bw / img.width, bh / img.height) * (1 + 0.04 * (t / d));
          const iw = img.width * sc, ih = img.height * sc;
          g.save();
          g.globalAlpha = ease((t - 0.2) / 0.6);
          g.beginPath(); g.rect(bx, by, bw, bh); g.clip();
          g.drawImage(img, bx + (bw - iw) / 2, by + (bh - ih) / 2, iw, ih);
          g.restore();
        }
        if (s.text) {
          g.globalAlpha = ease((t - 0.3) / 0.6);
          g.fillStyle = '#' + T.fg; g.font = `400 ${32 * k}px ${FONT}`;
          wrap(s.text, textW).forEach((l) => { g.fillText(l, x0, y); y += 46 * k; });
        }
        bullets.forEach((b, j) => {
          const a = appear(j, bullets.length);
          if (a <= 0) return;
          const sub = /^\s{2,}/.test(b);
          g.globalAlpha = a;
          const bx = x0 + (sub ? 40 * k : 0) + (1 - a) * 16 * k;
          g.fillStyle = '#' + T.accent;
          g.beginPath(); g.arc(bx + 8 * k, y - 11 * k, (sub ? 4 : 6) * k, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#' + (sub ? T.muted : T.fg); g.font = `${sub ? 400 : 500} ${(sub ? 26 : 32) * k}px ${FONT}`;
          const lines = wrap(String(b).trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''), textW - 40 * k);
          lines.forEach((l, li) => g.fillText(l, bx + 30 * k, y + li * 42 * k));
          y += (lines.length * 42 + 22) * k;
        });
      }
      // legenda da narração
      if (spec.subtitles && s.narration) {
        g.globalAlpha = 1;
        g.font = `500 ${24 * k}px ${FONT}`;
        const lines = wrap(s.narration, W * 0.8).slice(0, 3);
        const per = d / Math.max(1, Math.ceil(lines.length / 2));
        const chunk = Math.min(Math.floor(t / per), Math.ceil(lines.length / 2) - 1);
        const show = wrap(s.narration, W * 0.8).slice(chunk * 2, chunk * 2 + 2);
        const bh = (show.length * 34 + 20) * k;
        g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(W * 0.08, H - bh - 40 * k, W * 0.84, bh);
        g.fillStyle = '#fff'; g.textAlign = 'center';
        show.forEach((l, j) => g.fillText(l, W / 2, H - bh - 40 * k + (34 + j * 34) * k));
        g.textAlign = 'left';
      }
      // transição: escurece na entrada e na saída
      const edge = Math.min(t, d - t);
      if (edge < 0.35) { g.globalAlpha = 1 - edge / 0.35; g.fillStyle = '#' + T.bg; g.fillRect(0, 0, W, H); }
      g.globalAlpha = 1;
    }

    function frame(now) {
      let acc = 0, i = 0;
      while (i < spec.scenes.length - 1 && now >= acc + spec.scenes[i].duration) { acc += spec.scenes[i].duration; i++; }
      drawScene(i, Math.min(now - acc, spec.scenes[i].duration));
      g.fillStyle = '#' + T.accent; g.fillRect(0, H - 5 * k, W * Math.min(1, now / total), 5 * k);
    }

    frame(0);
    const stream = cv.captureStream(spec.fps);
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: spec.bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    await actx.resume();
    rec.start(1000);
    const t0 = actx.currentTime + 0.05;
    let acc = 0;
    spec.scenes.forEach((s, i) => {
      if (buffers[i]) { const src = actx.createBufferSource(); src.buffer = buffers[i]; src.connect(dest); src.start(t0 + acc + 0.3); }
      acc += s.duration;
    });
    await new Promise((res) => {
      const iv = setInterval(() => {
        const now = actx.currentTime - t0;
        frame(Math.max(0, now));
        if (now >= total + 0.2) { clearInterval(iv); res(); }
      }, 1000 / spec.fps);
    });
    rec.stop();
    await done;
    window.rfBlob = new Blob(chunks, { type: 'video/webm' });
    return { size: window.rfBlob.size, mime };
  };
  window.rfChunk = (start, len) => new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.readAsDataURL(window.rfBlob.slice(start, start + len));
  });
}

// Revisão do roteiro antes de gravar: modelos menores tendem a fazer cenas vazias e narração curta demais.
const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
function reviewScenes(scenes, target) {
  const problems = [];
  scenes.forEach((s, i) => {
    const cover = s.type === 'capa' || s.type === 'encerramento';
    const nb = (s.bullets || []).length;
    if (!cover && !s.image && !s.text && nb < 2) problems.push(`a cena ${i + 1} ("${s.title || ''}") tem ${nb} bullet(s); use 2 a 4`);
    if (!cover && s.narration && words(s.narration) < 12) {
      problems.push(`a narração da cena ${i + 1} tem só ${words(s.narration)} palavras; escreva 2 a 3 frases (15 a 35 palavras)`);
    }
  });
  const total = scenes.reduce((a, s) => a + words(s.narration), 0);
  if (+target > 0 && total && total / 2.5 < target * 0.7) {
    problems.push(`a narração soma ~${Math.round(total / 2.5)} s, mas o pedido é ~${target} s: escreva ~${Math.round(target * 2.5)} palavras no total (ou mais cenas)`);
  }
  return problems;
}

/**
 * spec: { path, scenes: [{ type?, title, subtitle?, bullets?, text?, image?, narration?, duration? }],
 *         theme?, accent?, voice?, rate?, subtitles?, width?, height? }
 */
async function createVideo(spec, cwd, { onProgress = () => {}, signal } = {}) {
  const scenes = Array.isArray(spec.scenes) ? spec.scenes : [];
  if (!scenes.length) throw new Error('Informe pelo menos uma cena em "scenes".');
  const problems = spec.force ? [] : reviewScenes(scenes, spec.target_seconds);
  if (problems.length) {
    throw new Error('O roteiro precisa melhorar antes de gravar (nada foi gravado):\n- ' + problems.join('\n- ')
      + '\nAjuste e chame create_video de novo. Use force: true só se o usuário pediu exatamente assim.');
  }
  const out = path.resolve(cwd, spec.path || 'video.webm');
  const wantMp4 = /\.mp4$/i.test(out);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-video-'));
  const notes = [];
  try {
    // 1) narração
    const narr = scenes.map((s, i) => (s.narration ? { i, text: String(s.narration), wav: path.join(tmp, `n${i}.wav`), txt: path.join(tmp, `n${i}.txt`) } : null)).filter(Boolean);
    let voice = null;
    if (narr.length) {
      if (!IS_WIN) notes.push('Narração só funciona no Windows por enquanto; o vídeo saiu sem voz.');
      else {
        voice = pickVoice(spec.voice, listVoices());
        onProgress(`Gerando narração (${narr.length} cenas, voz ${voice || 'padrão'})…`);
        synthesize(narr, voice, spec.rate || 0);
      }
    }
    const audio = {};
    for (const n of narr) if (fs.existsSync(n.wav)) audio[n.i] = { b64: fs.readFileSync(n.wav).toString('base64'), dur: wavDuration(n.wav) };

    // 2) duração e imagens de cada cena
    const t = { ...(THEMES[spec.theme] || THEMES.escuro) };
    if (/^#?[0-9a-f]{6}$/i.test(spec.accent || '')) t.accent = spec.accent.replace('#', '').toUpperCase();
    const prepared = scenes.map((s, i) => {
      const words = [s.title, s.subtitle, s.text, ...(s.bullets || [])].filter(Boolean).join(' ').split(/\s+/).length;
      const narrDur = audio[i] ? audio[i].dur + 0.9 : 0;
      // duração pedida vale (só cresce se a narração for mais longa); sem ela, estima pelo texto
      const duration = +s.duration > 0 ? Math.max(+s.duration, narrDur) : Math.max(narrDur, audio[i] ? 0 : Math.min(12, 2.5 + words * 0.32), 2.5);
      let image = null;
      if (s.image) {
        const info = imageInfo(path.resolve(cwd, s.image));
        image = `data:image/${info.ext};base64,${info.buf.toString('base64')}`;
      }
      return { ...s, image, audio: audio[i] ? audio[i].b64 : null, duration };
    });
    const total = prepared.reduce((a, s) => a + s.duration, 0);
    if (total > MAX_SECONDS) throw new Error(`O vídeo teria ${Math.round(total)} s; o limite é ${MAX_SECONDS} s. Divida em partes.`);

    // 3) desenhar e gravar no Chrome headless
    onProgress(`Gravando ${Math.round(total)} s de vídeo…`);
    const b = new Browser({
      port: 9500 + Math.floor(Math.random() * 400), profile: path.join(tmp, 'chrome'), headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    let webm;
    try {
      await b.ensure();
      // em máquinas lentas a página em branco termina de carregar depois e apaga o que foi injetado:
      // espera ela ficar pronta e confere se o gravador continua lá (senão injeta de novo)
      const PIECE = 512 * 1024;
      const upload = async (key, str) => {
        for (let p = 0; p < str.length; p += PIECE) await b.eval(`window.rfData[${JSON.stringify(key)}] = (window.rfData[${JSON.stringify(key)}] || '') + ${JSON.stringify(str.slice(p, p + PIECE))}; 0`);
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        for (let w = 0; w < 50 && (await b.eval('document.readyState')) !== 'complete'; w++) await new Promise((r) => setTimeout(r, 100));
        await b.eval(`(${recorderPage.toString()})(); window.rfData = {}; document.body.style.margin = 0; true`);
        for (const [i, s] of prepared.entries()) {
          if (s.audio) await upload('a' + i, s.audio);
          if (s.image) await upload('i' + i, s.image);
        }
        if (await b.eval(`typeof window.rfVideo === 'function' && Object.keys(window.rfData).length === ${prepared.filter((s) => s.audio).length + prepared.filter((s) => s.image).length}`)) break;
      }
      const width = +spec.width || 1280, height = +spec.height || 720;
      const payload = { scenes: prepared.map((s) => ({ ...s, audio: !!s.audio, image: !!s.image })), theme: t, width, height, fps: 30, bitrate: 4_000_000, subtitles: !!spec.subtitles };
      const abortWatch = signal ? setInterval(() => { if (signal.aborted) b.quit(); }, 500) : null;
      const r = await b.cdp.send('Runtime.evaluate', { expression: `window.rfVideo(${JSON.stringify(payload)})`, awaitPromise: true, returnByValue: true }, (total + 60) * 1000);
      if (abortWatch) clearInterval(abortWatch);
      if (r.exceptionDetails) throw new Error('Falha ao gravar: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      const size = r.result.value.size;
      if (!size) throw new Error('A gravação do vídeo saiu vazia (o Chrome não gerou quadros). Tente de novo.');
      const parts = [];
      // pedaços de 1 MB: mensagens grandes demais derrubam o WebSocket do DevTools
      const CHUNK = 1024 * 1024;
      for (let p = 0; p < size; p += CHUNK) parts.push(Buffer.from(await b.eval(`window.rfChunk(${p}, ${CHUNK})`), 'base64'));
      webm = fixWebmDuration(Buffer.concat(parts), total * 1000);
    } finally {
      await b.quit();
    }

    // 4) salvar (e converter para MP4 se der)
    fs.mkdirSync(path.dirname(out), { recursive: true });
    let final = out;
    if (wantMp4) {
      const ff = findFfmpeg();
      const tmpWebm = path.join(tmp, 'video.webm');
      fs.writeFileSync(tmpWebm, webm);
      if (ff) {
        onProgress('Convertendo para MP4…');
        const r = spawnSync(ff, ['-y', '-i', tmpWebm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { windowsHide: true, encoding: 'utf8' });
        if (r.status !== 0) throw new Error('ffmpeg falhou: ' + (r.stderr || '').slice(-400));
      } else {
        final = out.replace(/\.mp4$/i, '.webm');
        fs.writeFileSync(final, webm);
        notes.push('O vídeo saiu em WebM porque o ffmpeg não está instalado (WebM abre no navegador, no VLC e na maioria dos players). Apenas informe isso ao usuário; NÃO instale nada por conta própria. Se ele quiser MP4, ele mesmo pode instalar o ffmpeg com: winget install Gyan.FFmpeg');
      }
    } else {
      if (!/\.webm$/i.test(final)) final += '.webm';
      fs.writeFileSync(final, webm);
    }
    const bare = prepared.filter((s) => s.type !== 'capa' && s.type !== 'encerramento' && !(s.bullets || []).length && !s.image && !s.text).length;
    if (bare) notes.push(`Atenção: ${bare} cena(s) ficaram só com título (tela vazia). Se o usuário pediu algo mais completo, refaça com bullets e emoji.`);
    return { file: final, seconds: Math.round(total * 10) / 10, scenes: prepared.length, voice, notes };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o Chrome pode segurar arquivos por alguns segundos */ }
  }
}

const VIDEO_TOOL_DEF = {
  name: 'create_video',
  description: 'Cria um vídeo animado (estilo apresentação) com narração por voz sintetizada (Windows, voz pt-BR) e legendas opcionais. '
    + 'Cada cena: title, bullets[] (2 a 4 tópicos curtos que aparecem um a um), emoji? (um ícone grande, ex. ♻️), image? (PNG/JPG), text?, subtitle?, '
    + 'narration (o que a voz fala, 2 a 3 frases; define a duração), duration? (s), type? (capa|encerramento: título centralizado). '
    + 'Só a capa e o encerramento ficam sem bullets. A voz fala ~2,5 palavras por segundo: para um vídeo de 30 s escreva ~75 palavras de narração no total. '
    + 'Salva em .webm; .mp4 se o ffmpeg estiver instalado. A gravação leva o tempo real do vídeo (limite 10 min).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Arquivo de saída (.mp4 ou .webm)' },
      scenes: { type: 'array', items: { type: 'object' } },
      theme: { type: 'string', enum: Object.keys(THEMES) },
      accent: { type: 'string', description: 'Cor de destaque em hex (opcional)' },
      voice: { type: 'string', description: 'Parte do nome da voz (padrão: a primeira pt-BR)' },
      rate: { type: 'integer', description: 'Velocidade da fala, -10 a 10 (padrão 0)' },
      subtitles: { type: 'boolean', description: 'Mostrar a narração como legenda' },
      target_seconds: { type: 'integer', description: 'Duração pedida pelo usuário em segundos (se ele disse); a ferramenta confere se a narração bate' },
      force: { type: 'boolean', description: 'Pula a revisão do roteiro (só se o usuário pediu exatamente assim)' },
    },
    required: ['path', 'scenes'],
  },
};

module.exports = { createVideo, reviewScenes, VIDEO_TOOL_DEF, fixWebmDuration, wavDuration, listVoices, findFfmpeg };
