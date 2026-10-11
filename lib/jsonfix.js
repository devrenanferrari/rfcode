'use strict';
// Conserta os argumentos JSON que modelos menores às vezes mandam quebrados:
// cercas de markdown, vírgula sobrando, aspas simples, quebras de linha cruas dentro de strings e chaves faltando.

// Escapa caracteres de controle que aparecem crus dentro de strings ("linha1<enter>linha2").
function escapeControlInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

// Fecha strings, colchetes e chaves que ficaram abertos (resposta cortada).
function closeOpen(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  return s + (inStr ? '"' : '') + stack.reverse().join('');
}

function attempts(raw) {
  let s = String(raw ?? '').trim();
  const out = [s];
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = s.search(/[{[]/);
  if (first > 0) s = s.slice(first);
  out.push(s);
  s = escapeControlInStrings(s);
  out.push(s);
  s = s.replace(/,\s*([}\]])/g, '$1');
  out.push(s);
  if (!s.includes('"') && s.includes("'")) { s = s.replace(/'/g, '"'); out.push(s); }
  s = s.replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":'); // chaves sem aspas
  out.push(s);
  out.push(closeOpen(s));
  return out;
}

// Devolve { value, repaired } ou lança erro se nada funcionar.
function parseArgs(raw) {
  if (raw == null || String(raw).trim() === '') return { value: {}, repaired: false };
  let i = 0;
  for (const a of attempts(raw)) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, repaired: i > 0 };
    } catch { /* tenta o próximo */ }
    i++;
  }
  throw new Error('JSON inválido');
}

module.exports = { parseArgs, closeOpen, escapeControlInStrings };
