'use strict';
// Engenharia reversa — análise ESTÁTICA (só leitura) de binários, com os projetos de referência do GitHub:
// radare2 (radareorg/radare2) / rizin (rizinorg/rizin), Ghidra headless (NationalSecurityAgency/ghidra),
// binwalk (ReFirmLabs/binwalk) e as binutils clássicas (file, strings, nm, objdump).
// Nenhuma ação executa o binário analisado: é inspeção estática, como ler um arquivo. Por isso roda sem aprovação.
// Uso legítimo: pesquisa de segurança, análise de malware em ambiente controlado, depuração e interoperabilidade.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, has } = require('./_exec');

// Primeiro CLI disponível entre alternativas equivalentes (radare2 ou rizin).
function pick(...bins) { return bins.find((b) => has(b)); }

function resolveFile(cwd, file) {
  if (!file) throw new Error('file é obrigatório (caminho do binário a analisar).');
  const p = path.resolve(cwd, file);
  if (!fs.existsSync(p)) throw new Error(`Arquivo não encontrado: ${file}`);
  return p;
}

// radare2/rizin em modo lote (-q): executa comandos de análise e sai. Nunca roda o binário.
function r2(file, cmds, ctx) {
  const bin = pick('rizin', 'r2', 'radare2');
  if (!bin) throw new Error('radare2/rizin não encontrado. Instale radare2 (radareorg/radare2) ou rizin (rizinorg/rizin).');
  const args = [];
  for (const c of cmds) args.push('-c', c);
  args.push('-q', '-e', 'scr.color=0', file);
  return run(bin, args, { ...ctx, timeout: 300000 });
}

function info(file, ctx) {
  // file + headers/seções/imports via radare2; cai para "file"/objdump se não houver r2.
  if (pick('rizin', 'r2', 'radare2')) {
    const { out } = r2(file, ['i', 'iS', 'ii~[0-6]'], ctx);
    return `Informações do binário (radare2/rizin):\n\n${out}`;
  }
  const parts = [];
  if (has('file')) parts.push(run('file', [file], ctx).out);
  if (has('objdump')) parts.push(run('objdump', ['-f', '-h', file], ctx).out);
  if (!parts.length) throw new Error('Nenhuma ferramenta disponível. Instale radare2 (radareorg/radare2) ou binutils (file/objdump).');
  return `Informações do binário (binutils):\n\n${parts.join('\n\n')}`;
}

function strings(file, ctx, min = 5) {
  if (has('strings')) return `strings (binutils):\n\n${run('strings', ['-n', String(min), file], ctx).out}`;
  if (pick('rizin', 'r2', 'radare2')) return `strings (radare2/rizin):\n\n${r2(file, ['izzq'], ctx).out}`;
  throw new Error('Nenhuma ferramenta de strings. Instale binutils (strings) ou radare2/rizin.');
}

function symbols(file, ctx) {
  if (pick('rizin', 'r2', 'radare2')) return `Símbolos/imports (radare2/rizin):\n\n${r2(file, ['is', 'ii'], ctx).out}`;
  if (has('nm')) return `Símbolos (nm):\n\n${run('nm', ['-C', file], ctx).out}`;
  throw new Error('Nenhuma ferramenta de símbolos. Instale radare2/rizin ou binutils (nm).');
}

function disasm(file, ctx, fn) {
  if (pick('rizin', 'r2', 'radare2')) {
    // aaa analisa; pdf desmonta a função (padrão: main); pdf @ entry0 para o ponto de entrada.
    const where = fn ? `s sym.${fn} 2>/dev/null || s ${fn}` : 's main 2>/dev/null || s entry0';
    const { out } = r2(file, ['aa', where, 'pdf'], ctx);
    return `Desmontagem (radare2/rizin):\n\n${out}`;
  }
  if (has('objdump')) return `Desmontagem (objdump):\n\n${run('objdump', ['-d', '-M', 'intel', file], ctx).out}`;
  throw new Error('Nenhum desmontador. Instale radare2/rizin ou binutils (objdump).');
}

function carve(file, ctx) {
  if (!has('binwalk')) throw new Error('binwalk não encontrado. Instale binwalk (ReFirmLabs/binwalk) para procurar arquivos/firmware embutidos.');
  return `binwalk (ReFirmLabs/binwalk) — assinaturas embutidas:\n\n${run('binwalk', [file], ctx).out}`;
}

function ghidra(file, ctx) {
  // Ghidra headless: analisa e exporta o resultado. Usa um projeto temporário descartável.
  const headless = pick('analyzeHeadless', 'analyzeHeadless.bat');
  if (!headless) throw new Error('Ghidra headless (analyzeHeadless) não encontrado no PATH. Baixe o Ghidra (NationalSecurityAgency/ghidra) e aponte o PATH para support/.');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-ghidra-'));
  const r = run(headless, [proj, 'rf', '-import', file, '-analysisTimeoutPerFile', '240', '-deleteProject'], { ...ctx, timeout: 900000 });
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* temporário */ }
  return `Ghidra headless (NationalSecurityAgency/ghidra) — análise automática:\n\n${r.out}`;
}

function reverse(a, { cwd, signal }) {
  const file = resolveFile(cwd, a.file);
  const ctx = { cwd, signal };
  switch (a.action) {
    case 'info': return info(file, ctx);
    case 'strings': return strings(file, ctx, a.min_len);
    case 'symbols': return symbols(file, ctx);
    case 'disasm': return disasm(file, ctx, a.function);
    case 'carve': return carve(file, ctx);
    case 'ghidra': return ghidra(file, ctx);
    default: throw new Error('action: info, strings, symbols, disasm, carve ou ghidra');
  }
}

module.exports = {
  defs: [{
    name: 'reverse_engineer',
    description: 'Análise ESTÁTICA (só leitura, não executa o binário) de arquivos binários/executáveis para pesquisa de segurança, '
      + 'análise de malware, depuração e interoperabilidade, usando os projetos de referência do GitHub. '
      + 'action=info (cabeçalhos/seções, radare2/rizin ou file+objdump), strings (textos legíveis), symbols (símbolos/imports), '
      + 'disasm (desmonta uma função — radare2/rizin ou objdump), carve (binwalk, ReFirmLabs/binwalk — acha arquivos embutidos), '
      + 'ghidra (análise automática headless, NationalSecurityAgency/ghidra). '
      + 'Instale radare2 (radareorg/radare2)/rizin, binutils, binwalk ou Ghidra conforme a ação.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Caminho do binário a analisar (relativo ao projeto)' },
        action: { type: 'string', enum: ['info', 'strings', 'symbols', 'disasm', 'carve', 'ghidra'] },
        function: { type: 'string', description: 'disasm: nome da função a desmontar (padrão: main/entry)' },
        min_len: { type: 'number', description: 'strings: tamanho mínimo (padrão 5)' },
      },
      required: ['file', 'action'],
    },
  }],
  run: (name, a, ctx) => reverse(a, ctx),
  describe: (name, a) => `RE(${a.action} ${String(a.file || '').slice(0, 60)})`,
  // análise estática é leitura: roda direto, sem aprovação (como ler um arquivo).
  needsApproval: () => false,
  group: {
    name: 'reverse', desc: 'engenharia reversa / análise estática de binários (radare2, rizin, Ghidra, binwalk, binutils)',
    hint: /\b(engenharia reversa|reverse engineer|radare2?|\br2\b|rizin|ghidra|binwalk|desmontar|disassembl|desmontagem|bin[aá]rio|execut[aá]vel|\.(exe|dll|elf|so|bin|dylib|o|a)\b|opcode|assembly|malware|shellcode|firmware)\b/i,
  },
  _test: { pick },
};
