/* Tests for the folio-pages Worker. Run from the repo root:  node folio/tests/worker.test.cjs
   The REAL Worker code runs against a real SQLite engine (see d1-shim.cjs) with Turnstile's siteverify simulated.
   This proves the Worker's logic. It does not prove anything about real Cloudflare D1, Turnstile or quotas. */
const path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');
const { makeD1, WRITE_LIMIT, READ_LIMIT } = require('./d1-shim.cjs');
const results = []; const rec = (n, ok, note) => { results.push({ name: n, ok, note: note || '' }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !note ? '' : '  :: ' + note)); };
const eq = (n, c, note) => rec(n, !!c, note);
const ORIGIN = 'https://layahmcfly.github.io', SECRET = 'SECRET-turnstile-value-9f3a';
const logs = []; for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => { if (k === 'log' && typeof a[0] === 'string' && /^(PASS|FAIL|SKIP)/.test(a[0]) || /passed,/.test(String(a[0]))) process.stdout.write(a.join(' ') + '\n'); else logs.push(a.map(String).join(' ')); };
let worker, T0 = 1800000000000, fakeNow = null; const realNow = Date.now; Date.now = () => (fakeNow === null ? realNow() : fakeNow);
let tsMode = 'ok', tsCalls = [];
globalThis.fetch = async (url, init) => {
  tsCalls.push({ url: String(url), body: String(init && init.body) });
  if (tsMode === 'throw') throw new Error('network down');
  if (tsMode === '500') return new Response('x', { status: 500 });
  const tok = new URLSearchParams(String(init.body)).get('response');
  const ok = tsMode === 'ok' && tok !== 'bad-token';
  const body = ok ? { success: true, hostname: tsMode === 'ok' && tok === 'wrong-host' ? 'evil.example' : 'layahmcfly.github.io', action: tok === 'wrong-action' ? 'login' : 'folio-publish', 'error-codes': [] } : { success: false, 'error-codes': ['invalid-input-response'] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const D = () => ({ name: 'A Person', headline: 'h', email: 'a@b.com', phone: '', location: 'x', website: '', summary: 's', skills: 'a, b', availability: '', ctaLabel: 'Hire me', formTitle: 't', pollQuestion: 'q', pollOptions: 'a\nb', formEndpoint: '', thanks: 'Thanks', formMode: 'email',
  experience: [{ role: 'r', company: 'c', dates: 'd', bullets: 'b' }], education: [{ school: 's', degree: 'd', dates: 'd' }], links: [{ label: 'l', url: 'https://example.org' }], services: [{ title: 't', desc: 'd', price: 'p' }] });
const ST = () => ({ layout: 'modern', font: 'editorial', color: '#8a3f1f', paper: 'white' });
const payload = (over, tok) => Object.assign({ data: { D: D(), ST: ST() }, turnstile: tok || 'tok-' + Math.random().toString(36).slice(2) }, over || {});
let env, n = 0;
const fresh = extra => { env = Object.assign({ DB: makeD1(), TURNSTILE_SECRET: SECRET, ALLOWED_ORIGIN: ORIGIN }, extra || {}); tsMode = 'ok'; tsCalls = []; fakeNow = null; return env; };
let ipN = 0;
async function call(method, p, o) {
  o = o || {}; const h = { 'CF-Connecting-IP': o.ip || '203.0.113.' + (ipN++ % 250 + 1) }; if (o.origin !== null) h.Origin = o.origin || ORIGIN;
  if (o.key) h.Authorization = 'Bearer ' + o.key; if (o.auth) h.Authorization = o.auth;
  let body = o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined; if (body !== undefined && o.ct !== null) h['Content-Type'] = o.ct || 'application/json'; if (o.len) h['Content-Length'] = String(o.len);
  const init = { method, headers: h, body }; if (o.stream) { init.body = o.stream; init.duplex = 'half'; }
  const r = await worker.fetch(new Request('https://folio-pages.test' + p, init), env); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ } return { s: r.status, j, text, h: r.headers };
}
const pub = async (o) => { const r = await call('POST', '/api/pages', Object.assign({ body: payload() }, o)); return r; };
const count = tbl => { try { return env.DB._raw.prepare('SELECT COUNT(*) c FROM ' + tbl).get().c; } catch (e) { return 0; } };
const allPublic = [];

(async () => {
  worker = (await import(pathToFileURL(process.env.WORKER_FILE || path.join(__dirname, '..', 'worker', 'folio-pages.mjs')).href)).default;

  /* ---- publish and view ---- */
  fresh(); let A = await pub();
  eq('publish: 201 with a 12-character ID and a 43-character edit key', A.s === 201 && /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(A.j.id) && /^[A-Za-z0-9_-]{43}$/.test(A.j.editKey), JSON.stringify(A.j));
  eq('publish: response holds only id, editKey, updatedAt', JSON.stringify(Object.keys(A.j).sort()) === '["editKey","id","updatedAt"]');
  const row = env.DB._raw.prepare('SELECT * FROM pages').get();
  eq('publish: only the SHA-256 hash of the key is stored, never the key', row.key_hash === sha(A.j.editKey) && !JSON.stringify(row).includes(A.j.editKey));
  let g = await call('GET', '/api/pages/' + A.j.id, { origin: null }); allPublic.push(g.text);
  eq('view: public GET returns the data, needs no key', g.s === 200 && g.j.data.D.name === 'A Person' && g.j.id === A.j.id);
  eq('view: public response has no edit key, no hash and no key fields', !g.text.includes(A.j.editKey) && !g.text.includes(row.key_hash) && !/editKey|key_hash|keyHash/i.test(g.text), g.text.slice(0, 120));
  eq('view: responses are never cached by browsers or CDNs', /no-store/.test(g.h.get('cache-control')) && g.h.get('x-content-type-options') === 'nosniff');
  eq('view: unknown page is 404, and a malformed ID is 404 without touching the database', (await call('GET', '/api/pages/' + 'Z'.repeat(12))).s === 404 && await (async () => { const q0 = env.DB._st.queries; const r = await call('GET', '/api/pages/..%2F..%2Fetc'); const r2 = await call('GET', '/api/pages/abc'); return r.s === 404 && r2.s === 404 && env.DB._st.queries === q0; })());
  eq('status: reachable without a database and reveals no secrets', await (async () => { const e0 = env; env = { ALLOWED_ORIGIN: ORIGIN, TURNSTILE_SECRET: SECRET }; const r = await call('GET', '/api/status'); env = e0; return r.s === 200 && r.j.ok === true && !r.text.includes(SECRET); })());

  /* ---- Turnstile ---- */
  fresh(); let r = await pub({ body: { data: payload().data } });
  eq('turnstile: publish without a token is refused and nothing is stored', r.s === 400 && r.j.error === 'verification_required' && count('pages') === 0);
  r = await pub({ body: payload({}, 'bad-token') }); eq('turnstile: a token Cloudflare rejects is refused, nothing stored', r.s === 400 && r.j.error === 'verification_failed' && count('pages') === 0);
  tsCalls = []; r = await pub({ body: payload({}, 'good-1') });
  eq('turnstile: the Worker itself calls siteverify with the secret, the token and the visitor IP', r.s === 201 && tsCalls.length === 1 && /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/.test(tsCalls[0].url) && tsCalls[0].body.includes('secret=' + SECRET) && tsCalls[0].body.includes('response=good-1'));
  eq('turnstile: the secret is never in any response', !r.text.includes(SECRET) && !JSON.stringify([...r.h.entries()]).includes(SECRET));
  tsCalls = []; r = await pub({ body: payload({}, 'good-1') }); eq('turnstile: replaying a used token is refused without calling siteverify again', r.s === 400 && tsCalls.length === 0 && count('pages') === 1);
  r = await pub({ body: payload({}, 'wrong-host') }); eq('turnstile: a token from another website is refused', r.s === 400 && count('pages') === 1);
  r = await pub({ body: payload({}, 'wrong-action') }); eq('turnstile: a token for a different action is refused', r.s === 400 && count('pages') === 1);
  tsMode = 'throw'; r = await pub({ body: payload({}, 'n1') }); eq('turnstile: if Cloudflare cannot be reached, publishing fails closed with 503', r.s === 503 && r.j.error === 'verification_unavailable' && count('pages') === 1);
  tsMode = '500'; r = await pub({ body: payload({}, 'n2') }); eq('turnstile: a siteverify server error fails closed with 503', r.s === 503 && count('pages') === 1);
  tsMode = 'ok'; const noSecret = env.TURNSTILE_SECRET; delete env.TURNSTILE_SECRET; r = await pub({ body: payload({}, 'n3') }); env.TURNSTILE_SECRET = noSecret; eq('turnstile: with no secret configured, publishing is refused (never open by default)', r.s === 503 && count('pages') === 1);
  r = await pub({ body: payload({ turnstile: 'x'.repeat(2049) }) }); eq('turnstile: a token over 2048 characters is refused before any lookup', r.s === 400);

  /* ---- malformed and oversized data ---- */
  fresh(); const bad = async (name, o, status) => { const x = await pub(o); eq('data: ' + name, x.s === status && count('pages') === 0, x.s + ' ' + x.text.slice(0, 100)); };
  await bad('not JSON is 400', { raw: '{nope', body: undefined }, 400); await bad('wrong content type is 415', { raw: '{}', ct: 'text/plain' }, 415); await bad('non-object body is 400', { raw: '[1]' }, 400);
  await bad('declared size over 100 KB is 413', { raw: '{}', len: 100001 }, 413);
  await bad('a body over 100 KB sent without a length is 413 (stream cut off)', { stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":"' + 'x'.repeat(60000))); c.enqueue(new TextEncoder().encode('x'.repeat(60000) + '"}')); c.close(); } }) }, 413);
  await bad('unknown top-level field is 400', { body: Object.assign(payload(), { admin: true }) }, 400);
  const mut = (f, label, st) => { const p = payload(); f(p.data); return bad(label, { body: p }, st || 422); };
  await mut(d => { d.D.extra = 'x'; }, 'unknown D field is 422'); await mut(d => { delete d.D.name; }, 'missing D field is 422'); await mut(d => { d.D.name = { a: 1 }; }, 'wrong type is 422');
  await mut(d => { d.D.summary = 'x'.repeat(2001); }, 'text over its limit is 422'); await mut(d => { d.D.formMode = '</script>'; }, 'bad formMode is 422'); await mut(d => { d.ST.layout = 'x'; }, 'unknown layout is 422');
  await mut(d => { d.ST.color = 'red'; }, 'bad color is 422'); await mut(d => { d.ST.color = '#8a3f1f;}</style>'; }, 'color with markup is 422'); await mut(d => { d.D.experience = Array(31).fill(D().experience[0]); }, 'too many entries is 422');
  await mut(d => { d.D.links = [null]; }, 'non-object list entry is 422'); await mut(d => { d.D.links = [{ label: 'a', url: 'b', extra: 'c' }]; }, 'unknown list field is 422'); await mut(d => { d.D.education = 'x'; }, 'list that is not a list is 422');
  await bad('a "__proto__" key is rejected, not merged', { raw: '{"data":{"D":{"__proto__":{"x":1}},"ST":{}},"turnstile":"t"}' }, 422); await bad('invalid UTF-8 is 400', { raw: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }, 400);
  r = await pub({ body: payload() }); eq('data: a maximum-size valid page is accepted', await (async () => { const p = payload(); for (const k of Object.keys({ name: 120, headline: 200, email: 254, phone: 60, location: 120, website: 300, summary: 2000, skills: 2000, availability: 200, ctaLabel: 60, formTitle: 200, pollQuestion: 200, pollOptions: 1500, formEndpoint: 300, thanks: 400 })) p.data.D[k] = 'x'.repeat({ name: 120, headline: 200, email: 254, phone: 60, location: 120, website: 300, summary: 2000, skills: 2000, availability: 200, ctaLabel: 60, formTitle: 200, pollQuestion: 200, pollOptions: 1500, formEndpoint: 300, thanks: 400 }[k]); p.data.D.experience = Array(30).fill({ role: 'r'.repeat(120), company: 'c'.repeat(120), dates: 'd'.repeat(60), bullets: 'b'.repeat(4000) }); const x = await pub({ body: p }); return x.s === 201 || x.s === 413; })());

  /* ---- keys: missing, wrong, other page ---- */
  fresh(); A = await pub(); const B = await pub(); const Aid = A.j.id, Ak = A.j.editKey, Bid = B.j.id, Bk = B.j.editKey, wrong = 'A'.repeat(43);
  const body2 = () => ({ data: { D: Object.assign(D(), { name: 'Changed' }), ST: ST() } });
  const nameOf = async id => (await call('GET', '/api/pages/' + id)).j.data.D.name;
  eq('keys: no Authorization header is 401 for update, unpublish and check', (await call('PUT', '/api/pages/' + Aid, { body: body2() })).s === 401 && (await call('DELETE', '/api/pages/' + Aid)).s === 401 && (await call('POST', '/api/pages/' + Aid + '/check')).s === 401);
  eq('keys: malformed Authorization values are 401', (await call('PUT', '/api/pages/' + Aid, { body: body2(), auth: 'Basic ' + Ak })).s === 401 && (await call('PUT', '/api/pages/' + Aid, { body: body2(), auth: 'Bearer short' })).s === 401 && (await call('PUT', '/api/pages/' + Aid, { body: body2(), auth: Ak })).s === 401);
  eq('keys: the key in the URL (query string) grants nothing', (await call('PUT', '/api/pages/' + Aid + '?editKey=' + Ak + '&key=' + Ak, { body: body2() })).s === 401 && (await call('DELETE', '/api/pages/' + Aid + '?key=' + Ak)).s === 401 && await nameOf(Aid) === 'A Person');
  let w = await call('PUT', '/api/pages/' + Aid, { body: body2(), key: wrong }); eq('keys: a wrong key is 403 and the page is unchanged', w.s === 403 && await nameOf(Aid) === 'A Person');
  eq('keys: a wrong key cannot unpublish', (await call('DELETE', '/api/pages/' + Aid, { key: wrong })).s === 403 && (await call('GET', '/api/pages/' + Aid)).s === 200);
  const ghost = await call('PUT', '/api/pages/' + 'Z'.repeat(12), { body: body2(), key: wrong }); eq('keys: a page that does not exist gives the same 403 as a wrong key (no existence hint beyond the public GET)', ghost.s === 403 && ghost.text === w.text);
  eq("keys: page A's key cannot update, unpublish or check page B", (await call('PUT', '/api/pages/' + Bid, { body: body2(), key: Ak })).s === 403 && (await call('DELETE', '/api/pages/' + Bid, { key: Ak })).s === 403 && (await call('POST', '/api/pages/' + Bid + '/check', { key: Ak })).s === 403 && await nameOf(Bid) === 'A Person');
  eq("keys: updating page A with A's key leaves page B untouched", (await call('PUT', '/api/pages/' + Aid, { body: body2(), key: Ak })).s === 200 && await nameOf(Aid) === 'Changed' && await nameOf(Bid) === 'A Person');
  eq('keys: the check call confirms a right key and rejects a wrong one', (await call('POST', '/api/pages/' + Aid + '/check', { key: Ak })).j.ok === true && (await call('POST', '/api/pages/' + Aid + '/check', { key: wrong })).s === 403);
  const up = await call('PUT', '/api/pages/' + Aid, { body: { data: { D: Object.assign(D(), { name: 'x'.repeat(500) }), ST: ST() } }, key: Ak }); eq('keys: an invalid update is refused and the page keeps its last good data', up.s === 422 && await nameOf(Aid) === 'Changed');
  eq('unpublish: right key deletes at once; the page is then 404', (await call('DELETE', '/api/pages/' + Aid, { key: Ak })).j.deleted === true && (await call('GET', '/api/pages/' + Aid)).s === 404);
  eq('unpublish: repeating it, or updating afterwards, is refused', (await call('DELETE', '/api/pages/' + Aid, { key: Ak })).s === 403 && (await call('PUT', '/api/pages/' + Aid, { body: body2(), key: Ak })).s === 403 && await nameOf(Bid) === 'A Person');
  const pubs = [g.text]; for (const id of [Aid, Bid]) { const x = await call('GET', '/api/pages/' + id); pubs.push(x.text); }
  eq('keys: no public response ever contained a key or hash', pubs.every(t => !t.includes(Ak) && !t.includes(Bk) && !t.includes(sha(Ak)) && !t.includes(sha(Bk))) && [w.text, ghost.text].every(t => !t.includes(sha(Ak))));

  /* ---- rate limits ---- */
  fresh(); const ipP = '198.51.100.7'; const codes = []; for (let i = 0; i < 6; i++) codes.push((await pub({ ip: ipP })).s);
  let lim = await pub({ ip: ipP });
  eq('rate limit: 5 publishes per hour per visitor, then 429 with a wait time', codes.slice(0, 5).every(c => c === 201) && codes[5] === 429 && lim.s === 429 && lim.j.retryAfterSeconds > 0 && Number(lim.h.get('retry-after')) > 0, codes.join());
  eq('rate limit: another visitor is not affected', (await pub({ ip: '198.51.100.8' })).s === 201);
  eq('rate limit: IPv6 addresses in the same /64 share one allowance', await (async () => { const out = []; for (let i = 0; i < 7; i++) out.push((await pub({ ip: '2001:db8:1:2:' + i + ':0:0:1' })).s); return out.slice(0, 5).every(c => c === 201) && out[5] === 429; })());
  fakeNow = realNow() + 3600 * 1000 + 5000; eq('rate limit: the allowance returns when the hour window rolls over', (await pub({ ip: ipP })).s === 201); fakeNow = null;
  fresh({ RL_PUBLISH_GLOBAL_DAY: '3' }); const gc = []; for (let i = 0; i < 4; i++) gc.push((await pub()).s); eq('rate limit: the shared daily cap stops new publishes with 429 "busy"', gc.join() === '201,201,201,429', gc.join());
  fresh({ RL_PUBLISH_GLOBAL_DAY: '3' }); for (let i = 0; i < 8; i++) await pub({ body: payload({}, 'bad-token') }); const after = []; for (let i = 0; i < 3; i++) after.push((await pub()).s); eq('rate limit: failed challenges do not use up the shared daily cap', after.join() === '201,201,201', after.join());
  fresh({ RL_FAIL_IP_HOUR: '3' }); A = await pub(); const atk = '198.51.100.99'; for (let i = 0; i < 3; i++) await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: wrong, ip: atk });
  eq('rate limit: after repeated wrong keys that visitor is blocked, even with the right key', (await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey, ip: atk })).s === 429);
  eq('rate limit: the real owner on another connection is NOT locked out by someone guessing', (await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey, ip: '198.51.100.100' })).s === 200);
  fresh({ RL_UPDATE_PAGE_HOUR: '2' }); A = await pub(); const us = []; for (let i = 0; i < 3; i++) us.push((await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey })).s); eq('rate limit: updates to one page are capped per hour', us.join() === '200,200,429', us.join());
  fresh({ RL_CHECK_IP_HOUR: '2' }); A = await pub(); const cs = []; for (let i = 0; i < 3; i++) cs.push((await call('POST', '/api/pages/' + A.j.id + '/check', { key: A.j.editKey, ip: '198.51.100.5' })).s); eq('rate limit: key checks are capped per visitor', cs.join() === '200,200,429', cs.join());

  /* ---- quota and storage failures ---- */
  fresh(); A = await pub(); const ok1 = A.j; env.DB._st.failWrites = WRITE_LIMIT;
  r = await pub(); eq('quota: write limit reached, publish says so (503, daily_limit, write) and returns no ID or key', r.s === 503 && r.j.error === 'daily_limit' && r.j.which === 'write' && !r.j.id && !r.j.editKey && Number(r.h.get('retry-after')) >= 60, r.text.slice(0, 120));
  eq('quota: no half-created page was left behind', count('pages') === 1);
  eq('quota: viewing still works while only writes are exhausted (reads are a separate limit)', (await call('GET', '/api/pages/' + ok1.id)).s === 200);
  r = await call('PUT', '/api/pages/' + ok1.id, { body: body2(), key: ok1.editKey }); eq('quota: an update during write exhaustion is reported as failed, not as saved', r.s === 503 && r.j.error === 'daily_limit' && await (async () => { env.DB._st.failWrites = null; const n = await nameOf(ok1.id); env.DB._st.failWrites = WRITE_LIMIT; return n === 'A Person'; })());
  r = await call('DELETE', '/api/pages/' + ok1.id, { key: ok1.editKey }); eq('quota: unpublish during write exhaustion fails honestly and the page stays public', r.s === 503 && count('pages') === 1);
  env.DB._st.failWrites = null; env.DB._st.failReads = READ_LIMIT; r = await call('GET', '/api/pages/' + ok1.id); eq('quota: read limit reached, viewing returns 503 (not "not found" and not stale data)', r.s === 503 && r.j.error === 'daily_limit' && r.j.which === 'read' && !r.text.includes('A Person'), r.s + ' ' + r.text.slice(0, 80));
  env.DB._st.failReads = null; env.DB._st.failAll = 'D1_ERROR: Network connection lost'; r = await call('GET', '/api/pages/' + ok1.id); eq('quota: any other storage failure is 503 storage_unavailable', r.s === 503 && r.j.error === 'storage_unavailable');
  env.DB._st.failAll = null; eq('quota: everything works again once the limit lifts, nothing was lost', (await call('PUT', '/api/pages/' + ok1.id, { body: body2(), key: ok1.editKey })).s === 200);
  const e0 = env; env = { ALLOWED_ORIGIN: ORIGIN }; r = await call('GET', '/api/pages/' + ok1.id); env = e0; eq('quota: with no database bound the Worker says so (503)', r.s === 503);
  fresh({ PUBLISHING_PAUSED: 'true' }); env.DB._raw.exec('select 1'); const pz = await pub(); eq('pause switch: PUBLISHING_PAUSED=true stops new publishes only', pz.s === 503 && pz.j.error === 'publishing_paused');
  fresh(); A = await pub(); env.PUBLISHING_PAUSED = 'true'; eq('pause switch: viewing, updating and unpublishing keep working while paused', (await call('GET', '/api/pages/' + A.j.id)).s === 200 && (await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey })).s === 200 && (await call('DELETE', '/api/pages/' + A.j.id, { key: A.j.editKey })).s === 200);

  /* ---- CORS ---- */
  fresh(); A = await pub(); let pf = await worker.fetch(new Request('https://folio-pages.test/api/pages', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  eq('cors: preflight from the Folio site is allowed and lists Authorization', pf.status === 204 && pf.headers.get('access-control-allow-origin') === ORIGIN && /Authorization/.test(pf.headers.get('access-control-allow-headers')));
  pf = await worker.fetch(new Request('https://folio-pages.test/api/pages', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env); eq('cors: preflight from another website is refused', pf.status === 403 && !pf.headers.get('access-control-allow-origin'));
  eq('cors: a publish or update claiming another origin is refused', (await pub({ origin: 'https://evil.example' })).s === 403 && (await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey, origin: 'https://evil.example' })).s === 403);
  g = await call('GET', '/api/pages/' + A.j.id); const g2 = await call('GET', '/api/pages/' + A.j.id, { origin: 'https://evil.example' }); eq('cors: responses name only the Folio site, never a wildcard', g.h.get('access-control-allow-origin') === ORIGIN && !g2.h.get('access-control-allow-origin'));

  /* ---- ids, schema, consistency ---- */
  fresh({ RL_PUBLISH_IP_HOUR: '9999', RL_PUBLISH_IP_DAY: '9999', RL_PUBLISH_GLOBAL_DAY: '9999' }); const ids = new Set(), keys = new Set(); for (let i = 0; i < 300; i++) { const x = await pub(); ids.add(x.j.id); keys.add(x.j.editKey); }
  eq('ids: 300 publishes gave 300 different IDs and 300 different keys, all well-formed', ids.size === 300 && keys.size === 300 && [...ids].every(i => /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(i)));
  fresh(); await pub(); await pub(); eq('schema: tables are created on first use, with no manual setup, and reusing them is harmless', count('pages') === 2 && env.DB._raw.prepare("select count(*) c from sqlite_master where type='table'").get().c === 3);
  fresh(); A = await pub(); await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey }); const immediate = await nameOf(A.j.id); await call('DELETE', '/api/pages/' + A.j.id, { key: A.j.editKey }); eq('consistency (this SQLite stand-in only): update and unpublish are visible on the very next read', immediate === 'Changed' && (await call('GET', '/api/pages/' + A.j.id)).s === 404);

  /* ---- nothing sensitive was ever logged ---- */
  fresh(); A = await pub(); const secretsSeen = [A.j.editKey, sha(A.j.editKey), SECRET, 'Bearer']; env.DB._st.failAll = 'D1_ERROR: boom Bearer ' + A.j.editKey; await call('PUT', '/api/pages/' + A.j.id, { body: body2(), key: A.j.editKey }); env.DB._st.failAll = null; env.DB.prepare = () => { throw new TypeError('weird ' + A.j.editKey); }; await call('GET', '/api/pages/' + A.j.id);
  const text = logs.join('\n'); eq('logging: across every test above, the Worker logged no keys, hashes, secrets or Authorization values', !secretsSeen.some(s => text.includes(s)), text.slice(0, 200)); eq('logging: the only log line ever written is the error name', logs.every(l => /^folio-pages unexpected error \w+$/.test(l)), [...new Set(logs)].slice(0, 3).join(' | '));
  const f = results.filter(x => !x.ok).length; console.log(`\n${results.length - f} passed, ${f} failed`); process.exit(f ? 1 : 0);
})().catch(e => { process.stdout.write('FATAL ' + (e && e.stack) + '\n'); process.exit(2); });
