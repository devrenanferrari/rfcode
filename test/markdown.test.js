'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { render } = require('../media/markdown');

test('markdown: títulos', () => {
  assert.match(render('# Título'), /<h2>Título<\/h2>/);
  assert.match(render('### Sub'), /<h4>Sub<\/h4>/);
});

test('markdown: listas com e sem número', () => {
  const html = render('- a\n- b\n\n1. um\n2. dois');
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>um<\/li><li>dois<\/li><\/ol>/);
});

test('markdown: código inline não recebe negrito', () => {
  const html = render('use `a**b**c` e **forte**');
  assert.match(html, /<code>a\*\*b\*\*c<\/code>/);
  assert.match(html, /<strong>forte<\/strong>/);
});

test('markdown: bloco de código com linguagem e botão copiar', () => {
  const html = render('```js\nconst x = 1 < 2;\n```');
  assert.match(html, /class="lang">js</);
  assert.match(html, /class="copy"/);
  assert.match(html, /data-lang="js">const x = 1 &lt; 2;<\/code>/);
});

test('markdown: bloco sem linguagem', () => {
  assert.match(render('```\nabc\n```'), /class="lang">código</);
});

test('markdown: escapa HTML', () => {
  const html = render('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('markdown: citação e links só http(s)', () => {
  const html = render('> nota\n\n[ok](https://x.dev) [ruim](javascript:alert(1))');
  assert.match(html, /<blockquote>nota<\/blockquote>/);
  assert.match(html, /<a href="https:\/\/x.dev">ok<\/a>/);
  assert.ok(!html.includes('href="javascript'));
});
