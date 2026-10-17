'use strict';
// Servidor HTTP estático local para pré-visualizar um site/pasta (como o "serve"/"http-server", sem instalar nada).
// Roda em segundo plano no próprio processo do rfcode; start devolve a URL, stop encerra. Útil depois de web_scaffold
// ou para abrir um HTML no navegador do rfcode.

const http = require('http');
const fs = require('fs');
const path = require('path');

const servers = new Map(); // porta -> { server, root }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.map': 'application/json',
};

function serveStatic(root) {
  return (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
      let file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403); res.end('403'); return; } // trava path traversal
      let stat; try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end('Não encontrado'); return; }
      if (stat.isDirectory()) { file = path.join(file, 'index.html'); try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end('Sem index.html'); return; } }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(500); res.end('500'); }
  };
}

function start(a, { cwd }) {
  const root = path.resolve(cwd, a.dir || '.');
  if (!fs.existsSync(root)) throw new Error(`Pasta não encontrada: ${a.dir || '.'}`);
  const port = Math.max(1, Math.min(65535, Number(a.port) || 8080));
  if (servers.has(port)) return `Já tem um servidor na porta ${port} (${servers.get(port).root}). Use stop para trocar.`;
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveStatic(root));
    server.on('error', (e) => reject(new Error(`Não consegui abrir a porta ${port}: ${e.message}`)));
    server.listen(port, '127.0.0.1', () => {
      servers.set(port, { server, root });
      resolve(`Servindo ${path.relative(cwd, root).replace(/\\/g, '/') || '.'} em http://127.0.0.1:${port}/ (em segundo plano). Abra com browser open, ou use stop para encerrar.`);
    });
  });
}

function stop(a) {
  if (a.port) { const s = servers.get(Number(a.port)); if (!s) return `Nenhum servidor na porta ${a.port}.`; s.server.close(); servers.delete(Number(a.port)); return `Servidor da porta ${a.port} encerrado.`; }
  const n = servers.size; for (const [, s] of servers) s.server.close(); servers.clear();
  return `${n} servidor(es) encerrado(s).`;
}

module.exports = {
  defs: [{
    name: 'serve',
    description: 'Sobe um servidor HTTP estático local (127.0.0.1) para pré-visualizar um site ou HTML, sem instalar nada. '
      + 'action=start serve a pasta dir na porta port (padrão 8080) e devolve a URL; action=stop encerra. '
      + 'Depois do start, dá para abrir a URL com a ferramenta browser.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'] },
        dir: { type: 'string', description: 'Pasta a servir (padrão: pasta atual)' },
        port: { type: 'number', description: 'Porta (padrão 8080)' },
      },
      required: ['action'],
    },
  }],
  run(name, a, ctx) { return a.action === 'stop' ? stop(a) : start(a, ctx); },
  describe: (name, a) => `Servidor(${a.action}${a.port ? ` :${a.port}` : ''})`,
  needsApproval: (name, a) => a && a.action === 'start', // abre uma porta de rede local
  group: {
    name: 'preview', desc: 'servidor estático local para pré-visualizar sites/HTML',
    hint: /\b(servir|servidor|preview|pr[eé]-?visualiz|localhost|http-server|serve\b|abrir o site|rodar o site|porta \d)/i,
  },
  _test: { servers, serveStatic },
};
