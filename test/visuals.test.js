'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPptx, readDocument, runOfficeTool } = require('../lib/office');
const { fmtNum, VISUALS, visualType } = require('../lib/pptx-visuals');
const { readZip } = require('../lib/zip');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rf-vis-'));

const SLIDES = [
  { type: 'capa', title: 'Deck' },
  { type: 'grafico', title: 'Colunas', chart: { type: 'empilhado', categories: ['2023', '2024'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [3, 4] }], cagr: true }, takeaway: 'Cresceu', source: 'IBGE', notes: 'Roteiro do slide' },
  { type: 'grafico', title: 'Duplo', charts: [{ type: 'rosca', categories: ['x', 'y'], values: [60, 40], suffix: '%' }, { type: 'linha', categories: ['a', 'b', 'c'], series: [{ name: 'S1', values: [1, 2, 3] }, { name: 'S2', values: [3, 2, 1] }] }], insights: ['ok'] },
  { type: 'grafico', title: 'Cascata', chart: { type: 'cascata', items: [{ label: 'Receita', value: 100, total: true }, { label: 'Custo', value: -40 }, { label: 'Lucro', total: true }] } },
  { type: 'grafico', title: 'Barras', chart: { type: 'barras', categories: ['a', 'b'], values: [5, 7], highlight: 1, diff: [0, 1] } },
  { type: 'processo', title: 'Processo', steps: [{ title: 'Um', text: 'a' }, 'Dois'] },
  { type: 'linha_do_tempo', title: 'Tempo', events: [{ date: '2020', title: 'Início' }] },
  { type: 'funil', title: 'Funil', stages: [{ label: 'Leads', value: '100' }, { label: 'Vendas', value: '10' }] },
  { type: 'piramide', title: 'Pirâmide', levels: [{ title: 'Topo', text: 't' }, { title: 'Base' }] },
  { type: 'matriz', title: 'Matriz', quadrants: [{ title: 'Q1' }, { title: 'Q2' }, { title: 'Q3' }, { title: 'Q4' }], x_label: 'Esforço', y_label: 'Impacto', points: [{ label: 'P', x: 0.5, y: 0.5 }] },
  { type: 'ciclo', title: 'Ciclo', steps: ['A', 'B', 'C'], center: 'Centro' },
  { type: 'cartoes', title: 'Cartões', cards: [{ title: 'C1', text: 't', icon: '⚡' }, { title: 'C2', value: '42%' }] },
  { type: 'hub', title: 'Hub', center: 'Núcleo', items: ['A', 'B', 'C'] },
  { type: 'venn', title: 'Venn', sets: ['A', 'B', 'C'], center: 'Meio' },
  { type: 'tabela', title: 'Tabela', headers: ['Nome', 'Valor'], rows: [['x', '10'], ['y', '20']], highlight_row: 0 },
  { type: 'agenda', title: 'Agenda', items: ['Um', 'Dois'] },
  { type: 'mercado', title: 'Mercado', levels: [{ label: 'TAM', value: 'R$ 10 bi', text: 'Total' }, { label: 'SOM', value: 'R$ 1 bi' }] },
  { type: 'numeros', title: 'KPIs', stats: [{ value: '10', label: 'x', delta: '-2%', good: true }] },
];

test('pptx com todos os gráficos e diagramas: estrutura válida, textos e notas legíveis', () => {
  const dir = tmp();
  const file = path.join(dir, 'v.pptx');
  const r = createPptx(file, { theme: 'consultoria', slides: SLIDES }, dir);
  assert.strictEqual(r.slides, SLIDES.length);
  assert.strictEqual(r.notes, 1);
  const zip = readZip(fs.readFileSync(file));
  assert.ok(zip.get('ppt/notesMasters/notesMaster1.xml'), 'tem notesMaster');
  assert.ok(zip.get('ppt/notesSlides/notesSlide2.xml'), 'nota no slide 2');
  assert.match(zip.get('[Content_Types].xml').toString(), /notesSlide2\.xml/);
  assert.match(zip.get('ppt/presentation.xml').toString(), /notesMasterIdLst/);
  for (const [k, v] of zip) if (k.endsWith('.xml')) assert.doesNotMatch(v.toString(), /NaN|undefined|Infinity/, k);
  const text = readDocument(file);
  for (const s of ['CAGR', 'Fonte: IBGE', 'Cresceu', 'Roteiro do slide', 'Receita', 'Leads', 'Q4', 'Núcleo', 'Meio', 'Nome', '▼']) assert.ok(text.includes(s), s);
  assert.match(text, /a:tbl|Nome/);
});

test('dados inconsistentes no gráfico geram erro claro', () => {
  const dir = tmp();
  assert.throws(() => createPptx(path.join(dir, 'x.pptx'), { slides: [{ type: 'grafico', chart: { categories: ['a', 'b'], values: [1] } }] }, dir), /1 valores para 2 categorias/);
  assert.throws(() => createPptx(path.join(dir, 'x.pptx'), { slides: [{ type: 'grafico', chart: { type: 'radar', values: [1] } }] }, dir), /Tipo de gráfico desconhecido/);
});

test('formato de números em pt-BR com sinal antes do prefixo', () => {
  assert.strictEqual(fmtNum(-620, { prefix: 'R$ ' }), '-R$ 620');
  assert.strictEqual(fmtNum(1460.5, { decimals: 1, suffix: ' mi' }), '1.460,5 mi');
  assert.strictEqual(fmtNum(0.3, { decimals: 2 }), '0,30');
});

test('aliases em inglês e revisão do roteiro', () => {
  assert.strictEqual(visualType('timeline'), 'linha_do_tempo');
  assert.strictEqual(visualType('chart'), 'grafico');
  assert.ok(Object.keys(VISUALS).length >= 12);
  const dir = tmp();
  const plain = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, bullets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
  const out = runOfficeTool('create_pptx', { path: 'p.pptx', slides: [{ type: 'capa', title: 'x' }, ...plain] }, dir);
  assert.match(out, /só texto/);
  assert.match(out, /7 tópicos/);
  assert.match(out, /notes/);
});

test('aceita o formato que o modelo manda: tipo como chave, slides em texto, JSON quebrado e spec_file', () => {
  const dir = tmp();
  const slides = [{ title: 'Capa' }, { title: 'Receita', grafico: { type: 'linha', title: 'Receita', categories: ['a', 'b'], values: [1, 2] } }, { title: 'Resumo', topicos: { bullets: ['x'] } }];
  const out = runOfficeTool('create_pptx', { path: 'a.pptx', slides: JSON.stringify(slides) + ']}' }, dir);
  assert.match(out, /3 slides/);
  const text = readDocument(path.join(dir, 'a.pptx'));
  assert.ok(text.includes('x'));
  const zip = readZip(fs.readFileSync(path.join(dir, 'a.pptx')));
  for (const [k, v] of zip) if (/slides\/slide\d+\.xml$/.test(k)) assert.doesNotMatch(v.toString(), /<a:lstStyle\/><\/p:txBody>/, `${k}: caixa de texto sem parágrafo`);
  // JSON gravado pelo PowerShell em UTF-16
  fs.writeFileSync(path.join(dir, 'deck.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ theme: 'papel', slides }), 'utf16le')]));
  assert.match(runOfficeTool('create_pptx', { path: 'b.pptx', spec_file: 'deck.json' }, dir), /3 slides/);
  assert.throws(() => runOfficeTool('create_pptx', { path: 'c.pptx', slides: [{ title: 'a' }, { title: 'vazio' }] }, dir), /sem conteúdo/);
});

test('revisão aponta títulos genéricos e pizza de 2 fatias', () => {
  const dir = tmp();
  const g = (t, c) => ({ type: 'grafico', title: t, chart: c });
  const out = runOfficeTool('create_pptx', { path: 'r.pptx', slides: [{ type: 'capa', title: 'x' },
    g('Receita', { categories: ['a', 'b'], values: [1, 2] }), g('Lucro', { categories: ['a', 'b'], values: [1, 2] }),
    g('Canal', { type: 'pizza', categories: ['a', 'b'], values: [1, 2] })] }, dir);
  assert.match(out, /títulos de ação/);
  assert.match(out, /2 fatias/);
  assert.match(out, /mesmas categorias/);
});

test('corrige acentos lidos como ANSI, porcentagem em fração e tipo declarado errado', () => {
  const dir = tmp();
  const spec = { slides: [{ type: 'capa', title: 'x' }, { type: 'topicos', title: 'Margem', takeaway: 'Cresce mÃªs a mÃªs', charts: [{ type: 'linha', suffix: ' %', categories: ['a', 'b'], series: [{ name: 'M', values: '0.44 0.52' }] }] }] };
  fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify(spec));
  runOfficeTool('create_pptx', { path: 'd.pptx', spec_file: 'd.json' }, dir);
  const text = readDocument(path.join(dir, 'd.pptx'));
  assert.ok(text.includes('mês a mês'));
  assert.ok(text.includes('44 %') && text.includes('52 %'));
});
