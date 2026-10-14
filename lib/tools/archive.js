'use strict';
// Compactar e extrair arquivos .zip, sem instalar nada (usa o lib/zip.js do próprio rfcode).
// Útil para empacotar uma entrega ou abrir um pacote baixado.

const fs = require('fs');
const path = require('path');
const { createZip, readZip } = require('../zip');

const IGNORE = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function collect(root) {
  const out = [];
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && (IGNORE.has(e.name) || e.name.startsWith('.git'))) continue;
      const full = path.join(dir, e.name);
      const name = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, name);
      else out.push({ name, data: fs.readFileSync(full) });
    }
  };
  walk(root, '');
  return out;
}

function zip(a, { cwd }) {
  const outFile = a.out ? path.resolve(cwd, a.out) : null;
  if (!outFile) throw new Error('Informe out (arquivo .zip de destino).');
  let entries = [];
  if (Array.isArray(a.files) && a.files.length) {
    for (const rel of a.files) {
      const abs = path.resolve(cwd, rel);
      const st = fs.statSync(abs);
      if (st.isDirectory()) entries.push(...collect(abs).map((e) => ({ name: `${path.basename(abs)}/${e.name}`, data: e.data })));
      else entries.push({ name: path.basename(abs), data: fs.readFileSync(abs) });
    }
  } else if (a.dir) {
    entries = collect(path.resolve(cwd, a.dir));
  } else throw new Error('Informe files (lista) ou dir (pasta) para compactar.');
  if (!entries.length) throw new Error('Nada para compactar.');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, createZip(entries));
  const total = entries.reduce((s, e) => s + e.data.length, 0);
  return `Criado ${path.relative(cwd, outFile).replace(/\\/g, '/')} com ${entries.length} arquivo(s) (${total} bytes originais).`;
}

function unzip(a, { cwd }) {
  if (!a.file) throw new Error('Informe file (o .zip a extrair).');
  const dest = path.resolve(cwd, a.dir || path.basename(a.file).replace(/\.zip$/i, '') || 'extraido');
  const files = readZip(fs.readFileSync(path.resolve(cwd, a.file)));
  const names = [];
  for (const [name, data] of files) {
    const target = path.resolve(dest, name);
    if (!target.startsWith(dest + path.sep) && target !== dest) continue; // trava zip-slip
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    names.push(name);
  }
  return `Extraídos ${names.length} arquivo(s) para ${path.relative(cwd, dest).replace(/\\/g, '/')}/.`
    + (names.length <= 20 ? `\n- ${names.join('\n- ')}` : '');
}

module.exports = {
  defs: [{
    name: 'archive',
    description: 'Compacta ou extrai arquivos .zip, sem instalar nada. action=zip cria out a partir de files (lista) ou dir (pasta inteira, ignorando node_modules/.git); '
      + 'action=unzip extrai file para dir. Protegido contra path traversal. Para empacotar entregas ou abrir pacotes.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['zip', 'unzip'] },
        files: { type: 'array', items: { type: 'string' }, description: 'zip: arquivos/pastas a incluir' },
        dir: { type: 'string', description: 'zip: pasta a compactar; unzip: pasta destino' },
        file: { type: 'string', description: 'unzip: o .zip de origem' },
        out: { type: 'string', description: 'zip: o .zip de destino' },
      },
      required: ['action'],
    },
  }],
  run(name, a, ctx) { return a.action === 'unzip' ? unzip(a, ctx) : zip(a, ctx); },
  describe: (name, a) => `Arquivo(${a.action} ${a.out || a.file || a.dir || ''})`,
  needsApproval: () => true, // escreve arquivos no disco
  group: {
    name: 'arquivo', desc: 'compactar/extrair .zip',
    hint: /\b(zip|compact|descompact|extrair|descompact|arquivar|empacotar|\.zip\b)/i,
  },
  _test: { collect },
};
