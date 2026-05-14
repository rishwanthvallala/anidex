// Static server — serves .br files as Brotli, .gz files as gzip, rest normally
// Run: node server.js  →  http://localhost:8080/dashboard.html

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;

const MIME = {
  '.html':   'text/html',
  '.js':     'text/javascript',
  '.css':    'text/css',
  '.json':   'application/json',
  '.ndjson': 'application/x-ndjson',
};

http.createServer((req, res) => {
  const urlPath  = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? '/dashboard.html' : urlPath);
  const ext      = path.extname(filePath);
  const mime     = MIME[ext] || 'application/octet-stream';

  // Brotli: prefer .br variant if it exists
  const brPath = filePath + '.br';
  if (fs.existsSync(brPath)) {
    const stat = fs.statSync(brPath);
    res.writeHead(200, {
      'Content-Type':     mime,
      'Content-Encoding': 'br',
      'Content-Length':   stat.size,
      'Cache-Control':    'public, max-age=3600',
    });
    fs.createReadStream(brPath).pipe(res);
    return;
  }

  // Gzip fallback
  const gzPath = filePath + '.gz';
  if (fs.existsSync(gzPath)) {
    const stat = fs.statSync(gzPath);
    res.writeHead(200, {
      'Content-Type':     mime,
      'Content-Encoding': 'gzip',
      'Content-Length':   stat.size,
      'Cache-Control':    'public, max-age=3600',
    });
    fs.createReadStream(gzPath).pipe(res);
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type':   mime,
    'Content-Length': stat.size,
    'Cache-Control':  'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);

}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}/dashboard.html`);
  console.log(`main.bin   → ${(fs.statSync('main.bin.br').size/1024).toFixed(0)}KB brotli (binary)`);
  console.log(`display.json → ${(fs.statSync('display.json.br').size/1024).toFixed(0)}KB brotli (background)`);
});
