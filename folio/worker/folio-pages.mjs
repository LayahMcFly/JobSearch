/* folio-pages: the publishing service for Folio. One file, no dependencies. Paste it into a Cloudflare Worker.

   WHAT IT STORES: one row per published page in a D1 database (the page's resume data and style, nothing else),
   plus small rate-limit counters. It never renders HTML. Folio's viewer page does the rendering, after cleaning.

   WHAT IT NEEDS (see SETUP.md for the exact clicks):
     binding   DB                 a D1 database
     secret    TURNSTILE_SECRET   the Turnstile widget's secret key (never sent to a browser, never logged)
     variable  ALLOWED_ORIGIN     optional, default https://layahmcfly.github.io
     variable  TURNSTILE_HOSTNAMES optional, comma list, default layahmcfly.github.io
     variable  PUBLISHING_PAUSED  optional, set to "true" to stop new publishes (viewing keeps working)

   PERMISSIONS: the public page ID only lets someone VIEW. Publishing returns a separate private edit key once.
   Only its SHA-256 hash is stored. Updating, unpublishing and checking a key all need that key in an
   Authorization header (never in a URL). Public responses never contain a key or a hash.

   Nothing here logs request headers, bodies, keys, hashes or secrets. */

const VERSION = '1.0.1';
const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // 57 characters, no look-alikes
const ID_RE = /^[2-9A-HJ-NP-Za-km-z]{12}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 100000; // bytes

// Limits. Counters are exact (one D1 database, atomic upserts) but use fixed windows, so a burst can straddle a
// window edge and briefly reach up to twice the limit. Each can be overridden with an environment variable.
const DEFAULT_LIMITS = {
  publishIpHour: 5, publishIpDay: 12, publishGlobalDay: 300,
  updatePageHour: 30, failIpHour: 30, checkIpHour: 60
};

const STR = { name: 120, headline: 200, email: 254, phone: 60, location: 120, website: 300, summary: 2000, skills: 2000, availability: 200, ctaLabel: 60, formTitle: 200, pollQuestion: 200, pollOptions: 1500, formEndpoint: 300, thanks: 400 };
const LIST = {
  experience: [{ role: 120, company: 120, dates: 60, bullets: 4000 }, 30], education: [{ school: 120, degree: 120, dates: 60 }, 20],
  links: [{ label: 80, url: 300 }, 20], services: [{ title: 100, desc: 600, price: 60 }, 20]
};
const MODES = ['email', 'formspree', 'web3forms', 'gscript'];
const LAYOUTS = ['modern', 'classic', 'minimal', 'bold', 'compact', 'elegant'];
const FONTS = ['editorial', 'clean', 'friendly', 'classic', 'typewriter', 'warm'];
const PAPERS = ['white', 'warm', 'dark'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, win INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS used_tokens (h TEXT PRIMARY KEY, at INTEGER NOT NULL)'
];

/* ---------- small helpers ---------- */
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const limits = env => ({
  publishIpHour: num(env.RL_PUBLISH_IP_HOUR, DEFAULT_LIMITS.publishIpHour), publishIpDay: num(env.RL_PUBLISH_IP_DAY, DEFAULT_LIMITS.publishIpDay),
  publishGlobalDay: num(env.RL_PUBLISH_GLOBAL_DAY, DEFAULT_LIMITS.publishGlobalDay), updatePageHour: num(env.RL_UPDATE_PAGE_HOUR, DEFAULT_LIMITS.updatePageHour),
  failIpHour: num(env.RL_FAIL_IP_HOUR, DEFAULT_LIMITS.failIpHour), checkIpHour: num(env.RL_CHECK_IP_HOUR, DEFAULT_LIMITS.checkIpHour)
});
const allowedOrigin = env => String(env.ALLOWED_ORIGIN || 'https://layahmcfly.github.io');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
function sameString(a, b) { // constant-time for equal-length strings
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
function randomId() {
  let out = ''; const buf = new Uint8Array(32);
  while (out.length < 12) { crypto.getRandomValues(buf); for (const b of buf) { if (b < 228 && out.length < 12) out += ID_ALPHABET[b % 57]; } } // 228 = 57 * 4: no modulo bias
  return out;
}
function randomKey() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // 43 characters, 256 bits
}
function ipBucket(request) {
  const ip = String(request.headers.get('CF-Connecting-IP') || 'unknown').trim().toLowerCase();
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':'); // IPv6: one /64 counts as one visitor
  return ip;
}
const secondsToUtcMidnight = now => { const d = new Date(now); return Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000)); };

/* ---------- responses ---------- */
function headersFor(request, env, extra) {
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' };
  const o = request.headers.get('Origin'); if (o && o === allowedOrigin(env)) h['access-control-allow-origin'] = o;
  return Object.assign(h, extra || {});
}
const reply = (request, env, status, body, extra) => new Response(JSON.stringify(body), { status, headers: headersFor(request, env, extra) });
const fail = (request, env, status, error, more, extra) => reply(request, env, status, Object.assign({ error }, more || {}), extra);

/* Map a thrown storage error to an honest reply. Nothing is claimed as done. */
function storageFailure(request, env, e) {
  const msg = String((e && e.message) || e);
  const m = /exceeded D1's free tier daily row (read|write) limit/i.exec(msg);
  if (m) { const s = secondsToUtcMidnight(Date.now()); return fail(request, env, 503, 'daily_limit', { which: m[1].toLowerCase(), retryAfterSeconds: s }, { 'retry-after': String(s) }); }
  return fail(request, env, 503, 'storage_unavailable');
}

/* ---------- validation: reject anything that is not exactly the expected shape ---------- */
function validateData(data) {
  if (!isObj(data) || !isObj(data.D) || !isObj(data.ST)) return 'data must contain D and ST objects';
  if (Object.keys(data).length !== 2) return 'unexpected fields in data';
  const D = data.D, ST = data.ST, want = [...Object.keys(STR), 'formMode', ...Object.keys(LIST)];
  for (const k of Object.keys(D)) if (!want.includes(k)) return 'unexpected field D.' + k;
  for (const k of want) if (!own(D, k)) return 'missing field D.' + k;
  for (const k in STR) { if (typeof D[k] !== 'string') return 'D.' + k + ' must be text'; if (D[k].length > STR[k]) return 'D.' + k + ' is too long'; }
  if (!MODES.includes(D.formMode)) return 'D.formMode is not valid';
  for (const k in LIST) {
    const [shape, max] = LIST[k]; const arr = D[k];
    if (!Array.isArray(arr) || arr.length > max) return 'D.' + k + ' must be a list of at most ' + max;
    for (const e of arr) {
      if (!isObj(e)) return 'D.' + k + ' has an entry that is not an object';
      for (const f of Object.keys(e)) if (!own(shape, f)) return 'unexpected field in D.' + k;
      for (const f in shape) { if (typeof e[f] !== 'string') return 'D.' + k + '.' + f + ' must be text'; if (e[f].length > shape[f]) return 'D.' + k + '.' + f + ' is too long'; }
    }
  }
  for (const k of Object.keys(ST)) if (!['layout', 'font', 'color', 'paper'].includes(k)) return 'unexpected field ST.' + k;
  if (!LAYOUTS.includes(ST.layout) || !FONTS.includes(ST.font) || !PAPERS.includes(ST.paper)) return 'ST has an unknown layout, font or paper';
  if (typeof ST.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(ST.color)) return 'ST.color must look like #8a3f1f';
  return null;
}

async function readJson(request, env) {
  const ct = String(request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return { res: fail(request, env, 415, 'json_required') };
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return { res: fail(request, env, 413, 'too_large', { maxBytes: MAX_BODY }) };
  let total = 0; const chunks = [];
  if (request.body) {
    const rd = request.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; total += value.byteLength; if (total > MAX_BODY) { try { await rd.cancel(); } catch (e) { /* ignore */ } return { res: fail(request, env, 413, 'too_large', { maxBytes: MAX_BODY }) }; } chunks.push(value); }
  }
  const all = new Uint8Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  try { return { json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)) }; } catch (e) { return { res: fail(request, env, 400, 'bad_json') }; }
}

/* ---------- storage ---------- */
const schemaDone = new WeakMap();
async function ensureSchema(env) {
  if (schemaDone.get(env.DB)) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  schemaDone.set(env.DB, true);
}
/* Count one event. Returns { ok, n, retryAfter }. The upsert is a single atomic statement. */
async function hit(env, key, windowSec, limit, now) {
  const win = Math.floor(now / 1000 / windowSec) * windowSec;
  const row = await env.DB.prepare('INSERT INTO counters(k,n,win) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN win < ?2 THEN 1 ELSE n + 1 END, win = MAX(win, ?2) RETURNING n').bind(key, win).first();
  const n = row ? Number(row.n) : 1; return { ok: n <= limit, n, retryAfter: Math.max(1, win + windowSec - Math.floor(now / 1000)) };
}
async function peek(env, key, windowSec, now) {
  const win = Math.floor(now / 1000 / windowSec) * windowSec;
  const row = await env.DB.prepare('SELECT n FROM counters WHERE k = ?1 AND win >= ?2').bind(key, win).first();
  return row ? Number(row.n) : 0;
}
const tooMany = (request, env, r, error) => fail(request, env, 429, error || 'rate_limited', { retryAfterSeconds: r.retryAfter }, { 'retry-after': String(r.retryAfter) });

/* ---------- Turnstile: server-side verification is mandatory ---------- */
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return { ok: false, unavailable: true };
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip === 'unknown' ? '' : ip })
    });
    if (!r.ok) return { ok: false, unavailable: true };
    const out = await r.json();
    if (!out || out.success !== true) return { ok: false };
    const hosts = String(env.TURNSTILE_HOSTNAMES || 'layahmcfly.github.io').split(',').map(s => s.trim()).filter(Boolean);
    if (!hosts.includes(out.hostname) || out.action !== 'folio-publish') return { ok: false };
    return { ok: true };
  } catch (e) { return { ok: false, unavailable: true }; }
}

/* ---------- authorization for update, unpublish and check ---------- */
function bearer(request) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  return m ? m[1] : null;
}
/* Returns { res } to stop, or { ok:true }. The same 403 is used for a wrong key and for a page that does not exist. */
async function authorize(request, env, id, key, now) {
  const L = limits(env), ip = await sha256(ipBucket(request));
  if ((await peek(env, 'failip:' + ip, 3600, now)) >= L.failIpHour) return { res: tooMany(request, env, { retryAfter: 3600 - (Math.floor(now / 1000) % 3600) }) };
  const row = await env.DB.prepare('SELECT key_hash FROM pages WHERE id = ?1').bind(id).first();
  const stored = row ? String(row.key_hash) : '0'.repeat(64);
  const good = sameString(await sha256(key), stored) && !!row;
  if (!good) { await hit(env, 'failip:' + ip, 3600, L.failIpHour, now); return { res: fail(request, env, 403, 'forbidden') }; }
  return { ok: true };
}

/* ---------- routes ---------- */
async function publish(request, env, now) {
  if (String(env.PUBLISHING_PAUSED).toLowerCase() === 'true') return fail(request, env, 503, 'publishing_paused');
  const body = await readJson(request, env); if (body.res) return body.res;
  const b = body.json;
  if (!isObj(b) || Object.keys(b).some(k => k !== 'data' && k !== 'turnstile')) return fail(request, env, 400, 'bad_request');
  const why = validateData(b.data); if (why) return fail(request, env, 422, 'invalid_data', { detail: why });
  if (typeof b.turnstile !== 'string' || !b.turnstile || b.turnstile.length > 2048) return fail(request, env, 400, 'verification_required');
  await ensureSchema(env);
  const L = limits(env), ip = await sha256(ipBucket(request)), ipk = ip.slice(0, 24);
  const h1 = await hit(env, 'pubh:' + ipk, 3600, L.publishIpHour, now); if (!h1.ok) return tooMany(request, env, h1);
  const h2 = await hit(env, 'pubd:' + ipk, 86400, L.publishIpDay, now); if (!h2.ok) return tooMany(request, env, h2);
  // A token can be used once. Turnstile's own replay detection is eventually consistent, so Folio records each token too.
  const th = await sha256(b.turnstile);
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO used_tokens(h, at) VALUES(?1, ?2)').bind(th, Math.floor(now / 1000)).run();
  if (!ins.meta || ins.meta.changes !== 1) return fail(request, env, 400, 'verification_failed');
  const v = await verifyTurnstile(env, b.turnstile, ipBucket(request));
  if (v.unavailable) return fail(request, env, 503, 'verification_unavailable');
  if (!v.ok) return fail(request, env, 400, 'verification_failed');
  // Only visitors who passed the challenge count toward the shared daily cap, so failed attempts cannot use it up.
  const g = await hit(env, 'pubglobal', 86400, L.publishGlobalDay, now); if (!g.ok) return tooMany(request, env, g, 'busy');
  const key = randomKey(), keyHash = await sha256(key), data = JSON.stringify({ D: b.data.D, ST: b.data.ST }), t = Math.floor(now / 1000);
  let id = '';
  for (let i = 0; i < 5; i++) {
    id = randomId();
    const r = await env.DB.prepare('INSERT OR IGNORE INTO pages(id, key_hash, data, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?4)').bind(id, keyHash, data, t).run();
    if (r.meta && r.meta.changes === 1) {
      try { await env.DB.batch([env.DB.prepare('DELETE FROM counters WHERE win < ?1').bind(t - 172800), env.DB.prepare('DELETE FROM used_tokens WHERE at < ?1').bind(t - 3600)]); } catch (e) { /* housekeeping only */ }
      return reply(request, env, 201, { id, editKey: key, updatedAt: t });
    }
    id = '';
  }
  return fail(request, env, 503, 'could_not_create');
}

async function getPage(request, env, id) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT data, updated_at FROM pages WHERE id = ?1').bind(id).first(); // never selects key_hash
  if (!row) return fail(request, env, 404, 'not_found');
  return reply(request, env, 200, { id, updatedAt: Number(row.updated_at), data: JSON.parse(row.data) });
}

async function updatePage(request, env, id, now) {
  const key = bearer(request); if (!key) return fail(request, env, 401, 'edit_key_required');
  const declared = Number(request.headers.get('content-length')); if (Number.isFinite(declared) && declared > MAX_BODY) return fail(request, env, 413, 'too_large', { maxBytes: MAX_BODY });
  await ensureSchema(env);
  const a = await authorize(request, env, id, key, now); if (a.res) return a.res;
  const body = await readJson(request, env); if (body.res) return body.res;
  const b = body.json;
  if (!isObj(b) || Object.keys(b).some(k => k !== 'data')) return fail(request, env, 400, 'bad_request');
  const why = validateData(b.data); if (why) return fail(request, env, 422, 'invalid_data', { detail: why });
  const u = await hit(env, 'upd:' + id, 3600, limits(env).updatePageHour, now); if (!u.ok) return tooMany(request, env, u);
  const t = Math.floor(now / 1000), kh = await sha256(key);
  const r = await env.DB.prepare('UPDATE pages SET data = ?1, updated_at = ?2 WHERE id = ?3 AND key_hash = ?4').bind(JSON.stringify({ D: b.data.D, ST: b.data.ST }), t, id, kh).run();
  if (!r.meta || r.meta.changes !== 1) return fail(request, env, 403, 'forbidden');
  return reply(request, env, 200, { id, updatedAt: t });
}

async function deletePage(request, env, id, now) {
  const key = bearer(request); if (!key) return fail(request, env, 401, 'edit_key_required');
  await ensureSchema(env);
  const a = await authorize(request, env, id, key, now); if (a.res) return a.res;
  const r = await env.DB.prepare('DELETE FROM pages WHERE id = ?1 AND key_hash = ?2').bind(id, await sha256(key)).run();
  if (!r.meta || r.meta.changes !== 1) return fail(request, env, 403, 'forbidden');
  return reply(request, env, 200, { deleted: true });
}

async function checkKey(request, env, id, now) {
  const key = bearer(request); if (!key) return fail(request, env, 401, 'edit_key_required');
  await ensureSchema(env);
  const c = await hit(env, 'chk:' + (await sha256(ipBucket(request))).slice(0, 24), 3600, limits(env).checkIpHour, now); if (!c.ok) return tooMany(request, env, c);
  const a = await authorize(request, env, id, key, now); if (a.res) return a.res;
  return reply(request, env, 200, { ok: true });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url), now = Date.now(), method = request.method;
      const origin = request.headers.get('Origin');
      if (method === 'OPTIONS') {
        if (!origin || origin !== allowedOrigin(env)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600', vary: 'Origin' } });
      }
      if (method !== 'GET' && method !== 'HEAD' && origin && origin !== allowedOrigin(env)) return fail(request, env, 403, 'origin_not_allowed');
      const p = url.pathname.replace(/\/+$/, '');
      if (p === '/api/status' && method === 'GET') return reply(request, env, 200, { ok: true, service: 'folio-pages', version: VERSION, publishing: String(env.PUBLISHING_PAUSED).toLowerCase() !== 'true', maxBytes: MAX_BODY });
      if (!env.DB) return fail(request, env, 503, 'storage_unavailable');
      if (p === '/api/pages' && method === 'POST') return await publish(request, env, now);
      const m = /^\/api\/pages\/([^/]+)(\/check)?$/.exec(p);
      if (m && ID_RE.test(m[1])) {
        const id = m[1];
        if (m[2]) return method === 'POST' ? await checkKey(request, env, id, now) : fail(request, env, 405, 'method_not_allowed');
        if (method === 'GET') return await getPage(request, env, id);
        if (method === 'PUT') return await updatePage(request, env, id, now);
        if (method === 'DELETE') return await deletePage(request, env, id, now);
        return fail(request, env, 405, 'method_not_allowed');
      }
      return fail(request, env, 404, 'not_found');
    } catch (e) {
      if (e && /D1|SQLITE|database|storage|exceeded/i.test(String(e.message || e))) return storageFailure(request, env, e);
      console.error('folio-pages unexpected error', String((e && e.name) || 'Error')); // name only: never headers, bodies or keys
      return fail(request, env, 500, 'internal_error');
    }
  }
};
