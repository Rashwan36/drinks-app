// Local / any-Node-host runner: serves the pages and the same API that Vercel runs.
// Run: node server.js   (Node 18+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const api = require('./api/index');
const { remote } = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PAGES = { '/': 'menu.html', '/kitchen': 'kitchen.html', '/admin': 'admin.html' };

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p.startsWith('/api/')) return api(req, res);
  const full = path.normalize(path.join(PUBLIC_DIR, PAGES[p] || p.slice(1)));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  Drinks app is running  (storage: ' + (remote ? 'Upstash Redis' : 'data/db.json') + ')\n');
  for (const ip of ips.length ? ips : ['localhost']) {
    console.log(`  Menu (employees):  http://${ip}:${PORT}/`);
    console.log(`  Kitchen:           http://${ip}:${PORT}/kitchen`);
    console.log(`  Admin:             http://${ip}:${PORT}/admin\n`);
  }
  if (!process.env.ADMIN_PIN) console.log('  ⚠  Admin PIN is the default 1234 — set ADMIN_PIN to change it.\n');
});
