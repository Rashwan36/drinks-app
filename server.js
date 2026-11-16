// Office drinks ordering app — zero-dependency Node.js server.
// Run: node server.js   (Node 18+)
// Pages:  /         → employee menu (English)
//         /kitchen  → kitchen orders screen (English)
//         /admin    → menu management (Arabic, PIN protected)

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const KEEP_DAYS = 7;

// ---------- storage ----------
const DEFAULT_MENU = [
  { id: 'tea', cat: 'hot', name: 'Tea', desc: 'Classic black tea', sugar: true, available: true },
  { id: 'milktea', cat: 'hot', name: 'Tea with milk', desc: 'Tea with hot milk', sugar: true, available: true },
  { id: 'turkish', cat: 'hot', name: 'Turkish coffee', desc: 'A small cup', sugar: true, available: true },
  { id: 'nescafe', cat: 'hot', name: 'Nescafé', desc: 'With or without milk', sugar: true, available: true },
  { id: 'capp', cat: 'hot', name: 'Cappuccino', desc: 'With milk foam', sugar: true, available: true },
  { id: 'anise', cat: 'hot', name: 'Anise', desc: 'Herbal drink', sugar: true, available: true },
  { id: 'water', cat: 'cold', name: 'Water', desc: 'Chilled bottle', sugar: false, available: true },
  { id: 'lemon', cat: 'cold', name: 'Lemon mint', desc: 'Fresh, with ice', sugar: true, available: true },
  { id: 'orange', cat: 'cold', name: 'Orange juice', desc: 'Freshly squeezed', sugar: true, available: true },
  { id: 'iced', cat: 'cold', name: 'Iced coffee', desc: 'Coffee over ice', sugar: true, available: true }
];
const SUGAR = ['No sugar', 'Light sugar', 'Medium sugar', 'Extra sugar'];
const STATUSES = ['new', 'prep', 'ready', 'done', 'cancelled'];
const NEXT = { new: 'prep', prep: 'ready', ready: 'done' };

function today() { return new Date().toISOString().slice(0, 10); }

// Storage: Upstash Redis (for free cloud hosts whose disk is wiped on restart)
// when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set; else a local file.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = process.env.DB_KEY || 'drinks-app-db';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);

async function redis(cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('Upstash: ' + (j.error || r.status));
  return j.result;
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    menu: Array.isArray(d.menu) ? d.menu : DEFAULT_MENU.slice(),
    orders: Array.isArray(d.orders) ? d.orders : [],
    counter: d.counter || { date: today(), n: 0 }
  };
}

async function loadDb() {
  if (useRedis) {
    const raw = await redis(['GET', REDIS_KEY]);
    return normalize(raw ? JSON.parse(raw) : null);
  }
  try { return normalize(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { return normalize(null); }
}
let db = normalize(null);

let saveTimer = null, saving = Promise.resolve();
function writeNow() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  db.orders = db.orders.filter(o => o.createdAt >= cutoff || ['new', 'prep', 'ready'].includes(o.status));
  const json = JSON.stringify(db);
  if (useRedis) {
    saving = saving.then(() => redis(['SET', REDIS_KEY, json])).catch(err => console.error('Save failed:', err.message));
    return saving;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_FILE);
  return Promise.resolve();
}
// Batch rapid changes into one write (keeps Upstash usage low).
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, useRedis ? 400 : 0);
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- helpers ----------
const adminTokens = new Map(); // token -> expiry
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  const exp = t && adminTokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(t); return false; }
  return true;
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 16 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function toWesternDigits(s) {
  return String(s || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function publicItem(m) { return { id: m.id, cat: m.cat, name: m.name, desc: m.desc, sugar: m.sugar, available: m.available }; }
function nextOrderNo() {
  if (db.counter.date !== today()) db.counter = { date: today(), n: 0 };
  db.counter.n += 1;
  return db.counter.n;
}
function validItem(body) {
  const name = cleanText(body.name, 40);
  if (!name) return { error: 'Name is required' };
  const cat = body.cat === 'cold' ? 'cold' : 'hot';
  return { value: { name, cat, desc: cleanText(body.desc, 60), sugar: body.sugar !== false, available: body.available !== false } };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PAGES = { '/': 'menu.html', '/kitchen': 'kitchen.html', '/admin': 'admin.html' };

function serveStatic(res, pathname) {
  const file = PAGES[pathname] || pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (!p.startsWith('/api/')) return serveStatic(res, p);

  // live stream
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/ping') return send(res, 200, { ok: true });

  // public menu (available items only)
  if (p === '/api/menu' && m === 'GET') {
    return send(res, 200, db.menu.filter(i => i.available).map(publicItem));
  }

  // place an order
  if (p === '/api/orders' && m === 'POST') {
    const body = await readBody(req);
    const desk = toWesternDigits(body.desk).replace(/\D/g, '').slice(0, 6);
    if (!desk) return send(res, 400, { error: 'Please enter your desk number.' });
    const lines = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    if (!lines.length) return send(res, 400, { error: 'Your order is empty.' });
    const items = [];
    for (const l of lines) {
      const it = db.menu.find(x => x.id === l.id);
      if (!it || !it.available) return send(res, 409, { error: `Sorry, ${it ? it.name : 'an item'} is not available right now.` });
      const qty = Math.min(20, Math.max(1, parseInt(l.qty, 10) || 1));
      const sugar = it.sugar ? Math.min(3, Math.max(0, parseInt(l.sugar, 10) || 0)) : null;
      items.push({ id: it.id, name: it.name, qty, sugar: sugar == null ? null : SUGAR[sugar], note: cleanText(l.note, 100) });
    }
    const order = { id: crypto.randomBytes(8).toString('hex'), no: nextOrderNo(), desk, items, status: 'new', createdAt: Date.now(), updatedAt: Date.now() };
    db.orders.push(order);
    saveDb();
    broadcast('order', order);
    return send(res, 201, order);
  }

  // kitchen: active orders
  if (p === '/api/orders' && m === 'GET') {
    return send(res, 200, db.orders.filter(o => ['new', 'prep', 'ready'].includes(o.status)));
  }

  let match;
  // one order (employee tracking)
  if ((match = p.match(/^\/api\/orders\/([a-f0-9]{16})$/))) {
    const order = db.orders.find(o => o.id === match[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (m === 'GET') return send(res, 200, order);
    if (m === 'PATCH') { // kitchen moves the order forward
      const body = await readBody(req);
      const to = body.status;
      if (!STATUSES.includes(to) || (NEXT[order.status] !== to && to !== 'cancelled')) return send(res, 409, { error: 'Invalid status change' });
      order.status = to; order.updatedAt = Date.now();
      saveDb(); broadcast('order', order);
      return send(res, 200, order);
    }
  }
  // employee cancels while still new
  if ((match = p.match(/^\/api\/orders\/([a-f0-9]{16})\/cancel$/)) && m === 'POST') {
    const order = db.orders.find(o => o.id === match[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (order.status !== 'new') return send(res, 409, { error: 'The kitchen already started on this order.' });
    order.status = 'cancelled'; order.updatedAt = Date.now();
    saveDb(); broadcast('order', order);
    return send(res, 200, order);
  }

  // ---------- admin ----------
  if (p === '/api/admin/login' && m === 'POST') {
    const body = await readBody(req);
    const a = Buffer.from(String(body.pin || '')), b = Buffer.from(ADMIN_PIN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'الرقم السري غلط' });
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.set(token, Date.now() + 12 * 36e5);
    return send(res, 200, { token });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'سجّل دخول الأول' });
    if (p === '/api/admin/menu' && m === 'GET') return send(res, 200, db.menu.map(publicItem));
    if (p === '/api/admin/items' && m === 'POST') {
      const v = validItem(await readBody(req));
      if (v.error) return send(res, 400, { error: 'اكتب اسم المشروب' });
      const item = Object.assign({ id: 'i' + crypto.randomBytes(5).toString('hex') }, v.value);
      db.menu.push(item); saveDb(); broadcast('menu', {});
      return send(res, 201, item);
    }
    if ((match = p.match(/^\/api\/admin\/items\/([A-Za-z0-9_-]{1,40})$/))) {
      const idx = db.menu.findIndex(x => x.id === match[1]);
      if (idx < 0) return send(res, 404, { error: 'المشروب مش موجود' });
      if (m === 'PUT') {
        const body = await readBody(req);
        const merged = Object.assign({}, db.menu[idx], body);
        const v = validItem(merged);
        if (v.error) return send(res, 400, { error: 'اكتب اسم المشروب' });
        db.menu[idx] = Object.assign({ id: db.menu[idx].id }, v.value);
        saveDb(); broadcast('menu', {});
        return send(res, 200, db.menu[idx]);
      }
      if (m === 'DELETE') {
        db.menu.splice(idx, 1); saveDb(); broadcast('menu', {});
        return send(res, 200, { ok: true });
      }
    }
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) send(res, err.message === 'too large' ? 413 : 400, { error: 'Bad request' });
  });
});

function shutdown() { clearTimeout(saveTimer); writeNow().then(() => process.exit(0), () => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loadDb().then(d => { db = d; return writeNow(); }).then(() => server.listen(PORT, () => {
  console.log('  Storage: ' + (useRedis ? 'Upstash Redis' : DB_FILE));
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  Drinks app is running\n');
  for (const ip of ips.length ? ips : ['localhost']) {
    console.log(`  Menu (employees):  http://${ip}:${PORT}/`);
    console.log(`  Kitchen:           http://${ip}:${PORT}/kitchen`);
    console.log(`  Admin:             http://${ip}:${PORT}/admin\n`);
  }
  if (ADMIN_PIN === '1234') console.log('  ⚠  Admin PIN is the default 1234 — set ADMIN_PIN to change it.\n');
})).catch(err => { console.error('Could not load data:', err.message); process.exit(1); });
