'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { expandMentions } = require('../lib/mentions');

describe('expandMentions', () => {
  it('should expand existing file mention and append content', async () => {
    const tempDir = path.join(process.cwd(), 'temp-test-mentions');
    fs.mkdirSync(tempDir, { recursive: true });
    const testFile = path.join(tempDir, 'test.txt');
    const fileContent = 'Hello, world!\nThis is a test.';
    fs.writeFileSync(testFile, fileContent, 'utf8');

    try {
      const input = 'Check @test.txt';
      const expanded = expandMentions(input, tempDir);
      // Expect original input plus the file block
      assert.strictEqual(
        expanded,
        'Check @test.txt\n--- Begin file: @test.txt ---\nHello, world!\nThis is a test.\n--- End file: @test.txt ---'
      );
    } finally {
      // Clean up
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should truncate file content to 20000 characters', async () => {
    const tempDir = path.join(process.cwd(), 'temp-test-mentions-truncate');
    fs.mkdirSync(tempDir, { recursive: true });
    const testFile = path.join(tempDir, 'big.txt');
    const bigContent = 'x'.repeat(25000); // 25000 chars
    fs.writeFileSync(testFile, bigContent, 'utf8');

    try {
      const input = '@big.txt';
      const expanded = expandMentions(input, tempDir);
      // The content should be truncated to 20000 plus the notice
      assert.ok(expanded.includes('@big.txt'), 'Should contain the mention');
      assert.ok(expanded.includes('--- Begin file: @big.txt ---'), 'Should have begin marker');
      assert.ok(expanded.includes('--- End file: @big.txt ---'), 'Should have end marker');
      // The content part between markers should be: newline, truncated content, notice, newline
      const contentBlock = expanded.split('--- Begin file: @big.txt ---')[1].split('--- End file: @big.txt ---')[0];
      const notice = '\n... [truncado, limite de 20.000 caracteres atingido]';
      const expectedBlock = '\n' + 'x'.repeat(20000) + notice + '\n';
      assert.strictEqual(contentBlock, expectedBlock);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should leave non-existing file mention unchanged', async () => {
    const tempDir = path.join(process.cwd(), 'temp-test-mentions-nonexistent');
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const input = 'Check @nonexistent.txt';
      const expanded = expandMentions(input, tempDir);
      // Should be exactly the same because the file doesn't exist
      assert.strictEqual(expanded, input);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle multiple mentions', async () => {
    const tempDir = path.join(process.cwd(), 'temp-test-mentions-multiple');
    fs.mkdirSync(tempDir, { recursive: true });
    const file1 = path.join(tempDir, 'a.txt');
    const file2 = path.join(tempDir, 'b.txt');
    fs.writeFileSync(file1, 'content A', 'utf8');
    fs.writeFileSync(file2, 'content B', 'utf8');

    try {
      const input = '@a.txt and @b.txt';
      const expanded = expandMentions(input, tempDir);
      // Order of matches is left to right, so a then b
      const expected =
        '@a.txt and @b.txt\n--- Begin file: @a.txt ---\ncontent A\n--- End file: @a.txt ---\n--- Begin file: @b.txt ---\ncontent B\n--- End file: @b.txt ---';
      assert.strictEqual(expanded, expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});