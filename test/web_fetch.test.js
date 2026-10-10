'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { Agent } = require('../lib/agent');

// Helper to create a mock Response object
class MockResponse {
  constructor(text, status = 200, statusText = 'OK') {
    this.text = () => Promise.resolve(text);
    this.ok = status >= 200 && status < 300;
    this.status = status;
    this.statusText = statusText;
  }
}

test('web_fetch tool is defined in TOOL_DEFS', () => {
  const { Agent: _, TOOL_DEFS } = require('../lib/agent');
  const names = TOOL_DEFS.map(t => t.name);
  assert.ok(names.includes('web_fetch'));
});

test('web_fetch fetches and processes HTML', async () => {
  const html = `
    <html>
      <head>
        <title>Test</title>
        <script>console.log('remove me');</script>
        <style>body { display: none; }</style>
      </head>
      <body>
        Hello &amp; welcome! <b>Bold</b>
        <!-- comment -->
      </body>
    </html>
  `;
  const expectedText = 'Hello & welcome! Bold\n... [truncado, 0 caracteres omitidos]'; // Actually, we expect the truncation only if over 20000
  // But our HTML is short, so no truncation. Let's compute expected:
  // After removing script/style: 
  //   <html><head><title>Test</title></head><body>Hello &amp; welcome! <b>Bold</b><!-- comment --></body></html>
  // After removing tags: 
  //   TestHello &amp; welcome! Bold
  // After replacing entities: 
  //   TestHello & welcome! Bold
  // However, note that our removal of script/style might leave newlines? We'll just check that the result contains the expected string without tags and entities.
  // We'll do a more precise check in the test.

  // Mock fetch
  const mockFetch = async (url) => {
    assert.strictEqual(url, 'http://example.com');
    return new MockResponse(html);
  };
  global.fetch = mockFetch;

  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  // We can call the tool directly via the agent's method (since it's public)
  const result = await agent.web_fetch({ url: 'http://example.com' });
  // Check that the result does not contain script or style tags, and entities are replaced
  assert.notStrictEqual(result.includes('<script>'), true);
  assert.notStrictEqual(result.includes('</script>'), true);
  assert.notStrictEqual(result.includes('<style>'), true);
  assert.notStrictEqual(result.includes('</style>'), true);
  assert.notStrictEqual(result.includes('&amp;'), true); // should be replaced
  assert.ok(result.includes('Hello & welcome!'));
  assert.ok(result.includes('Bold'));
  // Also check that the title text is present (since we didn't remove title tag? Actually we remove all tags, so title text remains)
  assert.ok(result.includes('Test'));
});

test('web_fetch rejects non-http/https URLs', async () => {
  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  await assert.rejects(
    async () => {
      await agent.web_fetch({ url: 'file:///etc/passwd' });
    },
    (err) => {
      assert.ok(err.message.includes('Erro: URL deve começar com http:// ou https://'));
      return true;
    }
  );
});

test('web_fetch handles timeout', async () => {
  const originalSetTimeout = global.setTimeout;
  // We'll override setTimeout to call the callback immediately for the 20000ms delay
  global.setTimeout = (cb, delay) => {
    if (delay === 20000) {
      // Call the callback immediately (via setImmediate to avoid blocking)
      setImmediate(cb);
      return {}; // dummy id
    }
    return originalSetTimeout(cb, delay);
  };

  // Mock fetch that respects the abort signal
  const mockFetch = (url, options) => {
    return new Promise((resolve, reject) => {
      if (options.signal) {
        // If already aborted, reject immediately
        if (options.signal.aborted) {
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        // Otherwise, listen for abort
        const abortListener = () => {
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        };
        options.signal.addEventListener('abort', abortListener);
        // We leave the promise pending; it will be rejected when abort occurs
      } else {
        // No signal, leave pending forever (should not happen in our case)
      }
    });
  };
  global.fetch = mockFetch;

  const agent = new Agent({ apiKey: 'x', cwd: os.tmpdir() });
  let caughtError = null;
  const webFetchPromise = agent.web_fetch({ url: 'http://example.com' });
  try {
    await webFetchPromise;
  } catch (err) {
    caughtError = err;
  } finally {
    global.setTimeout = originalSetTimeout;
    delete global.fetch;
  }

  assert.ok(caughtError);
  assert.ok(caughtError.message.includes('Timeout ao buscar URL (20s)'));
});

// Clean up
test.afterEach(() => {
  delete global.fetch;
});