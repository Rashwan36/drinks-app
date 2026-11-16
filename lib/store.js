// Tiny key-value layer: Upstash Redis REST when its env vars are set,
// otherwise an in-memory store saved to data/db.json (local use).
'use strict';
const fs = require('fs');
const path = require('path');

// Reads a setting, forgiving stray spaces, lower case or quotes pasted into its name or value.
function env(...names) {
  const want = names.map(n => n.toUpperCase());
  for (const [k, v] of Object.entries(process.env)) {
    if (!want.includes(k.trim().toUpperCase())) continue;
    const val = String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (val) return val;
  }
  return '';
}
const URL_ = env('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL').replace(/\/+$/, '');
const TOKEN = env('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN');
const PREFIX = env('DB_PREFIX') || 'drinks:';
const remote = !!(URL_ && TOKEN);

async function remoteCmd(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('Upstash: ' + (j.error || r.status));
  return j.result;
}

// ---- local fallback (single process) ----
const FILE = path.join(__dirname, '..', 'data', 'db.json');
let mem = null;
function localLoad() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { mem = {}; }
  return mem;
}
function localSave() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(mem));
  fs.renameSync(FILE + '.tmp', FILE);
}
function localCmd([op, key, ...args]) {
  const d = localLoad();
  const now = Date.now();
  if (d[key] && d[key].exp && d[key].exp < now) delete d[key];
  const e = d[key];
  switch (op) {
    case 'GET': return e ? e.v : null;
    case 'SET': d[key] = { v: args[0] }; if (args[1] === 'EX') d[key].exp = now + Number(args[2]) * 1000; localSave(); return 'OK';
    case 'INCR': { const n = (e ? Number(e.v) : 0) + 1; d[key] = Object.assign(e || {}, { v: String(n) }); localSave(); return n; }
    case 'EXPIRE': if (e) { e.exp = now + Number(args[0]) * 1000; localSave(); } return e ? 1 : 0;
    case 'HSET': { const h = (e && e.v) || {}; h[args[0]] = args[1]; d[key] = { v: h }; localSave(); return 1; }
    case 'HGET': return e && e.v[args[0]] != null ? e.v[args[0]] : null;
    case 'HDEL': if (e && e.v[args[0]] != null) { delete e.v[args[0]]; localSave(); return 1; } return 0;
    case 'HGETALL': { if (!e) return []; const out = []; for (const k of Object.keys(e.v)) out.push(k, e.v[k]); return out; }
    default: throw new Error('Unsupported command ' + op);
  }
}

function cmd(...parts) {
  parts[1] = PREFIX + parts[1];
  return remote ? remoteCmd(parts) : Promise.resolve(localCmd(parts));
}

module.exports = { cmd, remote, env };
