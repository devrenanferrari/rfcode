'use strict';
// Visual do rfcode no terminal: cores da marca, logo em pixel art, markdown nas respostas e spinner.
// Sem dependências. Respeita NO_COLOR e saídas que não são terminal (pipes, arquivos).

const os = require('os');

const enabled = () => !process.env.NO_COLOR && (process.env.FORCE_COLOR || process.stdout.isTTY);
const truecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM || '') || process.env.TERM_PROGRAM === 'vscode'
  || !!process.env.WT_SESSION || process.platform === 'win32';

const BRAND = {
  green: [118, 185, 0], lime: [143, 209, 26], text: [236, 239, 244], muted: [128, 134, 146],
  red: [241, 86, 86], amber: [222, 170, 40], blue: [97, 175, 239], cyan: [86, 182, 194],
};
// equivalentes de 16 cores quando não há truecolor
const BASIC = { green: 32, lime: 92, text: 97, muted: 90, red: 91, amber: 33, blue: 94, cyan: 36 };

const wrap = (open, close) => (s) => (enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const fg = (name) => (s) => {
  if (!enabled()) return String(s);
  return truecolor() ? `\x1b[38;2;${BRAND[name].join(';')}m${s}\x1b[39m` : `\x1b[${BASIC[name]}m${s}\x1b[39m`;
};

const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), under: wrap(4, 24),
  green: fg('green'), lime: fg('lime'), text: fg('text'), muted: fg('muted'),
  red: fg('red'), amber: fg('amber'), blue: fg('blue'), cyan: fg('cyan'),
};

// tira os códigos ANSI (para medir largura)
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => [...strip(s)].length;

// ---------- logo: ">" + "rf" com sublinhado, desenhado com meios-blocos ----------
// G = verde (chevron e sublinhado), W = texto. Cada linha de texto mostra 2 linhas de pixels.
const LOGO = [
  'GG.............WWW',
  '.GG...........WW..',
  '..GG...WW.WW.WWWW.',
  '...GG..WWW....WW..',
  '..GG...WW.....WW..',
  '.GG....WW.....WW..',
  'GG.....WW.....WW..',
  '..................',
  '.......GGGGGGGGGGG',
  '..................',
];

function logoLines() {
  const color = (ch) => (ch === 'G' ? BRAND.green : ch === 'W' ? BRAND.text : null);
  const out = [];
  for (let y = 0; y < LOGO.length; y += 2) {
    let line = '';
    for (let x = 0; x < LOGO[y].length; x++) {
      const top = color(LOGO[y][x]), bot = color((LOGO[y + 1] || '')[x]);
      if (!enabled()) { line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '; continue; }
      const f = (rgb) => (truecolor() ? `38;2;${rgb.join(';')}` : (rgb === BRAND.green ? '32' : '97'));
      const b = (rgb) => (truecolor() ? `48;2;${rgb.join(';')}` : (rgb === BRAND.green ? '42' : '107'));
      if (!top && !bot) line += ' ';
      else if (top && bot && top === bot) line += `\x1b[${f(top)}m█\x1b[0m`;
      else if (top && bot) line += `\x1b[${f(top)};${b(bot)}m▀\x1b[0m`;
      else if (top) line += `\x1b[${f(top)}m▀\x1b[0m`;
      else line += `\x1b[${f(bot)}m▄\x1b[0m`;
    }
    out.push(line);
  }
  return out;
}

// Caminho curto para caber na tela: ~\Desktop\...\pasta
function shortPath(p, max = 48) {
  let s = String(p);
  const home = os.homedir();
  if (s.toLowerCase().startsWith(home.toLowerCase())) s = '~' + s.slice(home.length);
  if (s.length <= max) return s;
  const sep = s.includes('\\') ? '\\' : '/';
  // mantém o começo e o fim; o meio vira "…" (um só), tirando pastas até caber
  const parts = s.split(sep);
  while (parts.length > 3 && parts.join(sep).length > max) {
    if (parts[1] === '…') parts.splice(2, 1);
    else parts.splice(1, 1, '…');
  }
  return parts.join(sep);
}

function banner({ version, model, cwd, memory = false }) {
  const logo = logoLines();
  const shortModel = String(model).split('/').pop();
  const info = [
    `${c.bold(c.text('rfcode'))} ${c.muted('v' + version)}`,
    c.muted('agente de IA · modelos de build.nvidia.com'),
    `${c.muted('modelo')} ${c.lime(shortModel)}${memory ? c.muted('  ·  memória ativa') : ''}`,
    `${c.muted('pasta ')} ${c.text(shortPath(cwd))}`,
    c.muted(`${c.lime('/')} comandos  ${c.lime('@')} anexa arquivo  ${c.lime('Ctrl+C')} interrompe`),
  ];
  const lines = logo.map((l, i) => `  ${l}   ${info[i] || ''}`);
  return '\n' + lines.join('\n') + '\n';
}

// ---------- markdown simples, linha a linha (as respostas chegam em pedaços) ----------
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.cyan(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, (_, a, x) => a + c.italic(x))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `${c.under(c.blue(t))} ${c.muted('(' + u + ')')}`);
}

class MarkdownStream {
  constructor(write) { this.write = write; this.buf = ''; this.inCode = false; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.line(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
  }
  flush() { if (this.buf) { this.line(this.buf); this.buf = ''; } }
  line(l) {
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(l);
    if (fence) {
      this.inCode = !this.inCode;
      this.write(this.inCode ? `  ${c.muted('┌─ ' + (fence[1] || 'código'))}\n` : `  ${c.muted('└─')}\n`);
      return;
    }
    if (this.inCode) { this.write(`  ${c.muted('│')} ${c.text(l)}\n`); return; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)/.exec(l))) { this.write(`\n  ${c.bold(c.lime(m[2]))}\n`); return; }
    if ((m = /^(\s*)[-*+]\s+(.*)/.exec(l))) { this.write(`  ${m[1]}${c.green('•')} ${inlineMd(m[2])}\n`); return; }
    if ((m = /^(\s*)(\d+)[.)]\s+(.*)/.exec(l))) { this.write(`  ${m[1]}${c.green(m[2] + '.')} ${inlineMd(m[3])}\n`); return; }
    if ((m = /^>\s?(.*)/.exec(l))) { this.write(`  ${c.muted('▎')} ${c.italic(inlineMd(m[1]))}\n`); return; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) { this.write(`  ${c.muted('─'.repeat(32))}\n`); return; }
    this.write(l.trim() ? `  ${inlineMd(l)}\n` : '\n');
  }
}

// ---------- spinner ----------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
class Spinner {
  constructor(write) { this.write = write; this.timer = null; }
  start(text) {
    this.stop();
    if (!process.stdout.isTTY) return;
    const t0 = Date.now();
    let i = 0;
    const draw = () => {
      const secs = Math.floor((Date.now() - t0) / 1000);
      this.write(`\r\x1b[2K  ${c.lime(FRAMES[i++ % FRAMES.length])} ${c.muted(text + '…' + (secs ? ` ${secs}s` : ''))}`);
    };
    draw();
    this.timer = setInterval(draw, 90);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.write('\r\x1b[2K');
  }
}

// "Read(src/a.js)" -> ícone + verbo em destaque + alvo
function toolLine(label) {
  const m = /^([A-Za-z]+)\(([\s\S]*)\)(\s*&)?$/.exec(label || '');
  const verb = m ? m[1] : '', target = m ? m[2] : label;
  return `  ${c.green('●')} ${c.bold(c.text(verb || 'Ação'))} ${c.muted(target)}${m && m[3] ? c.muted(' (segundo plano)') : ''}`;
}

const prompt = () => `${c.lime('❯')} `;

module.exports = { c, strip, width, banner, logoLines, shortPath, MarkdownStream, Spinner, toolLine, prompt, inlineMd };
