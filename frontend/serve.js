// A deliberately tiny static file server — just enough to serve index.html over HTTP
// so the browser treats it as a real origin (with its own URL, able to fetch() the
// API on a different origin) instead of a file:// page, which browsers restrict much
// more. No framework needed for "serve one HTML file"; adding one here would be the
// unnecessary-abstraction the brief explicitly warns against.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(ROOT, path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Frontend listening on http://localhost:${PORT}`);
});
