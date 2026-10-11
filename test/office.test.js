'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZip, readZip, crc32 } = require('../lib/zip');
const { createPptx, createDocx, readDocument, runOfficeTool } = require('../lib/office');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-office-'));

test('zip: grava e lê de volta (com e sem compressão)', () => {
  const big = 'abc'.repeat(1000);
  const buf = createZip([{ name: 'a.txt', data: 'oi' }, { name: 'pasta/b.txt', data: big }, { name: 'c.bin', data: Buffer.from([0, 1, 2, 255]) }]);
  const files = readZip(buf);
  assert.strictEqual(files.get('a.txt').toString(), 'oi');
  assert.strictEqual(files.get('pasta/b.txt').toString(), big);
  assert.deepStrictEqual([...files.get('c.bin')], [0, 1, 2, 255]);
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('pptx: estrutura válida, um arquivo por slide, imagem embutida e texto legível', () => {
  const dir = tmp();
  const png = path.join(__dirname, '..', 'media', 'logo.png');
  fs.copyFileSync(png, path.join(dir, 'logo.png'));
  const file = path.join(dir, 'a.pptx');
  const r = createPptx(file, {
    theme: 'claro', accent: '#ff0000', footer: 'rodapé',
    slides: [
      { type: 'capa', title: 'Título & <teste>', subtitle: 'Sub' },
      { title: 'Tópicos', bullets: ['um **forte**', '  sub'] },
      { type: 'duas_colunas', title: 'Colunas', columns: [['a'], ['b']] },
      { type: 'imagem', title: 'Img', image: 'logo.png' },
      { type: 'numeros', title: 'N', stats: [{ value: '10', label: 'x' }] },
      { type: 'citacao', quote: 'Frase', author: 'Eu' },
      { type: 'secao', title: 'Seção', number: 2 },
      { type: 'encerramento', title: 'Fim' },
    ],
  }, dir);
  assert.deepStrictEqual(r, { slides: 8, images: 1 });
  const files = readZip(fs.readFileSync(file));
  assert.ok(files.has('[Content_Types].xml'));
  assert.strictEqual([...files.keys()][0], '[Content_Types].xml', 'Content_Types vem primeiro');
  for (let i = 1; i <= 8; i++) assert.ok(files.has(`ppt/slides/slide${i}.xml`), `slide${i}`);
  assert.ok(files.has('ppt/media/image1.png'));
  assert.match(files.get('ppt/slides/_rels/slide4.xml.rels').toString(), /media\/image1\.png/);
  assert.match(files.get('ppt/theme/theme1.xml').toString(), /FF0000/, 'cor de destaque aplicada');
  const pres = files.get('ppt/presentation.xml').toString();
  assert.strictEqual((pres.match(/<p:sldId /g) || []).length, 8);
  const text = readDocument(file);
  assert.match(text, /Título & <teste>/, 'escapa e desescapa XML');
  assert.match(text, /um forte/, '**negrito** vira run, sem asteriscos');
  assert.match(text, /## Slide 8\nFim/);
});

test('pptx: sem slides dá erro claro; caminho precisa ser .pptx', () => {
  const dir = tmp();
  assert.throws(() => createPptx(path.join(dir, 'x.pptx'), { slides: [] }), /pelo menos um slide/);
  assert.throws(() => runOfficeTool('create_pptx', { path: 'x.ppt', slides: [{ title: 'a' }] }, dir), /\.pptx/);
});

test('docx: markdown vira títulos, listas, tabela, citação e código', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.docx');
  createDocx(file, {
    title: 'Relatório',
    markdown: '# Intro\nTexto **forte** e *itálico*.\n\n- a\n- b\n\n1. um\n2. dois\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> nota\n\n```\ncode()\n```\n\n\\pagebreak\n## Fim',
  });
  const files = readZip(fs.readFileSync(file));
  const doc = files.get('word/document.xml').toString();
  assert.match(doc, /w:val="Heading1"/);
  assert.match(doc, /w:val="Heading2"/);
  assert.match(doc, /<w:numPr>/);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:gridCol w:w="4500"\/><w:gridCol w:w="4500"\/>/);
  assert.match(doc, /w:val="Quote"/);
  assert.match(doc, /w:val="Code"/);
  assert.match(doc, /<w:br w:type="page"\/>/);
  assert.match(files.get('word/numbering.xml').toString(), /w:numId="2"/, 'lista numerada própria');
  const text = readDocument(file);
  assert.match(text, /Relatório/);
  assert.match(text, /Texto forte e itálico\./);
});

test('read_document lê xlsx (strings compartilhadas e números)', () => {
  const dir = tmp();
  const file = path.join(dir, 'p.xlsx');
  fs.writeFileSync(file, createZip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Vendas" sheetId="1"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Produto</t></si><si><t>Café</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>3.5</v></c></row></sheetData></worksheet>' },
  ]));
  const text = readDocument(file);
  assert.match(text, /## Planilha: Vendas/);
  assert.match(text, /Produto;10/);
  assert.match(text, /Café;;3\.5/);
});
