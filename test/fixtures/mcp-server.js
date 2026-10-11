'use strict';
// Servidor MCP mínimo para os testes: stdio (padrão) ou HTTP (--http).
const tools = [
  { name: 'somar', description: 'Soma dois números', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, annotations: { readOnlyHint: true } },
  { name: 'criar_tarefa', description: 'Cria uma tarefa no sistema', inputSchema: { type: 'object', properties: { titulo: { type: 'string' } } } },
];
const tasks = [];
function handle(m) {
  if (m.method === 'initialize') return { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'teste', version: '1' }, instructions: 'Servidor de teste.' };
  if (m.method === 'tools/list') return { tools };
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'somar') return { content: [{ type: 'text', text: String(a.a + a.b) }] };
    if (name === 'criar_tarefa') { tasks.push(a.titulo); return { content: [{ type: 'text', text: `Tarefa #${tasks.length} criada: ${a.titulo}` }] }; }
    return { content: [{ type: 'text', text: 'ferramenta desconhecida' }], isError: true };
  }
  return null;
}
if (process.argv.includes('--http')) {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(); }
      const m = JSON.parse(body || '{}');
      if (m.id == null) { res.statusCode = 202; return res.end(); }
      res.setHeader('mcp-session-id', 's1');
      res.setHeader('content-type', 'text/event-stream');
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: handle(m) })}\n\n`);
    });
  }).listen(0, () => console.log(srv.address().port));
} else {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id == null) continue;
      const result = handle(m);
      process.stdout.write(JSON.stringify(result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'x' } }) + '\n');
    }
  });
}
