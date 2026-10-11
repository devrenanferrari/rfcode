'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixWebmDuration, wavDuration, createVideo } = require('../lib/video');
const { findChrome } = require('../lib/browser');

test('fixWebmDuration acrescenta a duração no Info do WebM', () => {
  // EBML header vazio + Segment de tamanho desconhecido + Info com TimecodeScale + Cluster
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
  const segHead = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const info = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]); // TimecodeScale = 1 000 000
  const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00]);
  const fixed = fixWebmDuration(Buffer.concat([ebml, segHead, info, cluster]), 12345);
  const at = fixed.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  assert.ok(at > 0, 'Duration inserido');
  assert.strictEqual(fixed.readDoubleBE(at + 3), 12345);
  assert.ok(fixed.slice(-6).equals(cluster), 'o resto do arquivo continua igual');
  assert.ok(fixWebmDuration(fixed, 1).equals(fixed), 'não duplica se já existe');
});

test('wavDuration lê a duração do cabeçalho', () => {
  const rate = 8000, seconds = 1.5, data = Buffer.alloc(rate * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rfwav-')), 'a.wav');
  fs.writeFileSync(f, Buffer.concat([h, data]));
  assert.strictEqual(wavDuration(f), 1.5);
});

test('create_video grava um WebM curto de verdade (Chrome headless)', { skip: !findChrome() && 'Chrome não encontrado', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfvideo-'));
  const r = await createVideo({ path: 'v.webm', scenes: [{ title: 'Teste', bullets: ['um', 'dois'], duration: 2.5 }] }, dir);
  assert.strictEqual(path.basename(r.file), 'v.webm');
  const buf = fs.readFileSync(r.file);
  assert.ok(buf.length > 5000, 'tem conteúdo');
  assert.ok(buf.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'é WebM/EBML');
  assert.ok(buf.indexOf(Buffer.from([0x44, 0x89, 0x88])) > 0, 'tem duração no cabeçalho');
  assert.strictEqual(r.seconds, 2.5);
});

test('reviewScenes barra roteiro pobre antes de gravar', () => {
  const { reviewScenes } = require('../lib/video');
  const bad = reviewScenes([{ type: 'capa', title: 'A', narration: 'oi' }, { title: 'B', bullets: ['x'], narration: 'curta demais.' }], 30);
  assert.strictEqual(bad.length, 3, 'bullets, narração curta e duração');
  const good = reviewScenes([{ type: 'capa', title: 'A' }, { title: 'B', bullets: ['x', 'y'], narration: 'uma narração com palavras suficientes para passar na revisão do roteiro sem problemas' }]);
  assert.deepStrictEqual(good, []);
});
