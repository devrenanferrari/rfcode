'use strict';
// Skills: conhecimento que a empresa ou o usuário ensina ao rfcode, sem mexer no código.
// Cada skill é uma pasta com SKILL.md (cabeçalho com name e description) e, se quiser, arquivos de apoio
// (modelos, scripts, exemplos). Mesmo formato das skills do Claude Code: .claude/skills do projeto também é lido.
// O prompt leva só a lista (nome + descrição); o conteúdo entra quando o agente chama use_skill.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');

function skillDirs(cwd) {
  return [
    { dir: path.join(HOME(), 'skills'), scope: 'usuario' },
    { dir: path.join(cwd, '.claude', 'skills'), scope: 'projeto' },
    { dir: path.join(cwd, '.rfcode', 'skills'), scope: 'projeto' },
  ];
}

// cabeçalho YAML simples (chave: valor, uma por linha)
function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

// [{ name, description, dir, file, scope, keywords }]; o do projeto sobrescreve o do usuário
function listSkills(cwd) {
  const out = new Map();
  for (const { dir, scope } of skillDirs(cwd)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null;
      if (!file || !fs.existsSync(file)) continue;
      try {
        const { meta, body } = parseSkill(fs.readFileSync(file, 'utf8'));
        const name = (meta.name || e.name.replace(/\.md$/, '')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        const description = meta.description || body.trim().split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
        const keywords = (meta.keywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        out.set(name, { name, description: description.slice(0, 300), dir: path.dirname(file), file, scope, keywords });
      } catch { /* skill ilegível: ignora */ }
    }
  }
  return [...out.values()];
}

function loadSkill(cwd, name) {
  const s = listSkills(cwd).find((x) => x.name === String(name || '').toLowerCase());
  if (!s) {
    const all = listSkills(cwd).map((x) => x.name);
    throw new Error(`Skill "${name}" não existe.${all.length ? ` Disponíveis: ${all.join(', ')}` : ' Nenhuma skill instalada.'}`);
  }
  const { body } = parseSkill(fs.readFileSync(s.file, 'utf8'));
  // arquivos de apoio: o agente lê com read_file / read_document quando precisar
  const extra = [];
  const walk = (d, depth = 0) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (f !== s.file) extra.push(f);
    }
  };
  if (path.basename(s.file) === 'SKILL.md') walk(s.dir);
  return `# Skill: ${s.name}\n${body.trim()}${extra.length ? `\n\nArquivos da skill (leia quando precisar):\n${extra.slice(0, 40).map((f) => `- ${f}`).join('\n')}` : ''}`;
}

// trecho do prompt com as skills disponíveis
function skillsPrompt(cwd) {
  const list = listSkills(cwd);
  if (!list.length) return '';
  return `\n# Skills (procedimentos ensinados pelo usuário ou pela empresa)\nAntes de uma tarefa coberta por uma skill, carregue-a com use_skill e siga o que ela diz.\n${list.slice(0, 60).map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
}

const TEMPLATE = (name, desc) => `---
name: ${name}
description: ${desc || 'Quando usar esta skill (uma frase: o agente decide por ela)'}
keywords: palavra1, palavra2
---

# ${name}

## Quando usar
Descreva a situação.

## Passo a passo
1. ...
2. ...

## Regras
- O que sempre fazer.
- O que nunca fazer.

## Exemplos
Entrada e resultado esperado.
`;

function createSkill(cwd, name, { scope = 'projeto', description = '' } = {}) {
  const clean = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  if (!clean) throw new Error('Informe o nome da skill.');
  const base = scope === 'usuario' ? path.join(HOME(), 'skills') : path.join(cwd, '.rfcode', 'skills');
  const file = path.join(base, clean, 'SKILL.md');
  if (fs.existsSync(file)) throw new Error(`Já existe: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATE(clean, description));
  return file;
}

module.exports = { listSkills, loadSkill, skillsPrompt, createSkill, parseSkill, skillDirs };
