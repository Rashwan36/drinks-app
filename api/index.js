// All /api/* routes. Runs as one Vercel serverless function, or under server.js locally.
'use strict';
const crypto = require('crypto');
const { cmd } = require('../lib/store');

const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
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
const NEXT = { new: 'prep', prep: 'ready', ready: 'done' };
const ACTIVE = ['new', 'prep', 'ready'];

// ---------- data ----------
async function getMenu() {
  const raw = await cmd('GET', 'menu');
  if (raw) return JSON.parse(raw);
  await saveMenu(DEFAULT_MENU);
  return DEFAULT_MENU.slice();
}
function saveMenu(menu) { return cmd('SET', 'menu', JSON.stringify(menu)); }
async function activeOrders() {
  const flat = (await cmd('HGETALL', 'orders')) || [];
  const out = [];
  for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i]));
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
async function getOrder(id) {
  const raw = (await cmd('HGET', 'orders', id)) || (await cmd('GET', 'order:' + id));
  return raw ? JSON.parse(raw) : null;
}
async function putOrder(o) {
  if (ACTIVE.includes(o.status)) return cmd('HSET', 'orders', o.id, JSON.stringify(o));
  // finished orders leave the kitchen list but stay readable for a day
  await cmd('SET', 'order:' + o.id, JSON.stringify(o), 'EX', 86400);
  return cmd('HDEL', 'orders', o.id);
}

// ---------- helpers ----------
function today() { return new Date().toISOString().slice(0, 10); }
function toWesternDigits(s) { return String(s || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))); }
function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function publicItem(m) { return { id: m.id, cat: m.cat, name: m.name, desc: m.desc, sugar: m.sugar, available: m.available }; }
function validItem(body) {
  const name = cleanText(body.name, 40);
  if (!name) return { error: 'اكتب اسم المشروب' };
  return { value: { name, cat: body.cat === 'cold' ? 'cold' : 'hot', desc: cleanText(body.desc, 60), sugar: body.sugar !== false, available: body.available !== false } };
}
// Stateless admin token: "<expiry>.<hmac>" signed with the PIN.
function sign(exp) { return crypto.createHmac('sha256', 'drinks-admin:' + ADMIN_PIN).update(String(exp)).digest('hex'); }
function makeToken() { const exp = Date.now() + 12 * 36e5; return exp + '.' + sign(exp); }
function isAdmin(req) {
  const t = String(req.headers['x-admin-token'] || ''); const [exp, mac] = t.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 16384) throw new Error('too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// ---------- routes ----------
async function route(req, res, p) {
  const m = req.method;
  let match;

  if (p === 'ping') return send(res, 200, { ok: true });

  if (p === 'menu' && m === 'GET') return send(res, 200, (await getMenu()).filter(i => i.available).map(publicItem));

  if (p === 'orders' && m === 'POST') {
    const body = await readBody(req);
    const desk = toWesternDigits(body.desk).replace(/\D/g, '').slice(0, 6);
    if (!desk) return send(res, 400, { error: 'Please enter your desk number.' });
    const lines = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    if (!lines.length) return send(res, 400, { error: 'Your order is empty.' });
    const menu = await getMenu();
    const items = [];
    for (const l of lines) {
      const it = menu.find(x => x.id === l.id);
      if (!it || !it.available) return send(res, 409, { error: `Sorry, ${it ? it.name : 'an item'} is not available right now.` });
      const qty = Math.min(20, Math.max(1, parseInt(l.qty, 10) || 1));
      const sugar = it.sugar ? Math.min(3, Math.max(0, parseInt(l.sugar, 10) || 0)) : null;
      items.push({ id: it.id, name: it.name, qty, sugar: sugar == null ? null : SUGAR[sugar], note: cleanText(l.note, 100) });
    }
    const counterKey = 'counter:' + today();
    const no = await cmd('INCR', counterKey);
    if (no === 1) await cmd('EXPIRE', counterKey, 172800);
    const order = { id: crypto.randomBytes(8).toString('hex'), no: Number(no), desk, items, status: 'new', createdAt: Date.now(), updatedAt: Date.now() };
    await putOrder(order);
    return send(res, 201, order);
  }

  if (p === 'orders' && m === 'GET') return send(res, 200, await activeOrders());

  if ((match = p.match(/^orders\/([a-f0-9]{16})$/))) {
    const order = await getOrder(match[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (m === 'GET') return send(res, 200, order);
    if (m === 'PATCH') {
      const to = (await readBody(req)).status;
      if (NEXT[order.status] !== to && !(to === 'cancelled' && ACTIVE.includes(order.status))) return send(res, 409, { error: 'Invalid status change' });
      order.status = to; order.updatedAt = Date.now();
      await putOrder(order);
      return send(res, 200, order);
    }
  }
  if ((match = p.match(/^orders\/([a-f0-9]{16})\/cancel$/)) && m === 'POST') {
    const order = await getOrder(match[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (order.status !== 'new') return send(res, 409, { error: 'The kitchen already started on this order.' });
    order.status = 'cancelled'; order.updatedAt = Date.now();
    await putOrder(order);
    return send(res, 200, order);
  }

  // ---------- admin ----------
  if (p === 'admin/login' && m === 'POST') {
    const a = Buffer.from(String((await readBody(req)).pin || '')), b = Buffer.from(ADMIN_PIN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'الرقم السري غلط' });
    return send(res, 200, { token: makeToken() });
  }
  if (p.startsWith('admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'سجّل دخول الأول' });
    const menu = await getMenu();
    if (p === 'admin/menu' && m === 'GET') return send(res, 200, menu.map(publicItem));
    if (p === 'admin/items' && m === 'POST') {
      const v = validItem(await readBody(req));
      if (v.error) return send(res, 400, { error: v.error });
      const item = Object.assign({ id: 'i' + crypto.randomBytes(5).toString('hex') }, v.value);
      menu.push(item); await saveMenu(menu);
      return send(res, 201, item);
    }
    if ((match = p.match(/^admin\/items\/([A-Za-z0-9_-]{1,40})$/))) {
      const idx = menu.findIndex(x => x.id === match[1]);
      if (idx < 0) return send(res, 404, { error: 'المشروب مش موجود' });
      if (m === 'PUT') {
        const v = validItem(Object.assign({}, menu[idx], await readBody(req)));
        if (v.error) return send(res, 400, { error: v.error });
        menu[idx] = Object.assign({ id: menu[idx].id }, v.value);
        await saveMenu(menu);
        return send(res, 200, menu[idx]);
      }
      if (m === 'DELETE') { menu.splice(idx, 1); await saveMenu(menu); return send(res, 200, { ok: true }); }
    }
  }
  return send(res, 404, { error: 'Not found' });
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // Vercel rewrite passes the original sub-path as ?path=..., local server passes the URL.
  const p = (url.searchParams.get('path') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  try { await route(req, res, p); }
  catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.message === 'too large' ? 413 : 500, { error: 'Something went wrong, please try again.' });
  }
};
