'use strict';
// Stand-in for nginx when Docker is unavailable: serves web/index.html and proxies /api/* to the gateway.
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:3000';
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'));
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    try {
      const r = await fetch(GATEWAY + req.url.slice(4), { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', 'x-api-key': req.headers['x-api-key'] || '', 'idempotency-key': req.headers['idempotency-key'] || '' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502); res.end('{"error":"BAD_GATEWAY"}'); }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
}).listen(Number(process.env.PORT || 8081), () => console.log('dev web on', process.env.PORT || 8081));
