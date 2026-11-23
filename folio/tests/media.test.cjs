/* Tests for portfolio files in the folio-pages Worker. Run from the repo root:  node folio/tests/media.test.cjs
   The REAL Worker code runs against real SQLite (d1-shim) and an in-memory KV stand-in (kv-shim). Not real Cloudflare. */
const path = require('path'), { pathToFileURL } = require('url');
const { makeD1 } = require('./d1-shim.cjs'), { makeKV } = require('./kv-shim.cjs');
const results = []; const eq = (n, c, note) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !note ? '' : '  :: ' + note)); };
const ORIGIN = 'https://layahmcfly.github.io', ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rid = () => Array.from({ length: 12 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
globalThis.fetch = async (u, i) => new Response(JSON.stringify({ success: true, hostname: 'layahmcfly.github.io', action: 'folio-publish' }), { status: 200, headers: { 'content-type': 'application/json' } });
const bytes = {
  'image/jpeg': Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]),
  'image/png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200, 7)]),
  'image/gif': Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 7)]),
  'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200, 7)]),
  'video/mp4': Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(1000, 7)]),
  'video/webm': Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(1000, 7)])
};
let worker, env, ipN = 0;
const fresh = extra => { env = Object.assign({ DB: makeD1(), MEDIA: makeKV(), TURNSTILE_SECRET: 's', ALLOWED_ORIGIN: ORIGIN, RL_PUBLISH_IP_HOUR: '999', RL_PUBLISH_IP_DAY: '999', RL_PUBLISH_GLOBAL_DAY: '999' }, extra || {}); };
const ip = () => '203.0.113.' + (ipN++ % 250 + 1);
async function call(method, p, o) {
  o = o || {}; const h = { 'CF-Connecting-IP': o.ip || ip(), Origin: ORIGIN }; if (o.key) h.Authorization = 'Bearer ' + o.key; if (o.ct) h['Content-Type'] = o.ct; if (o.headers) Object.assign(h, o.headers);
  const init = { method, headers: h }; if (o.body !== undefined) init.body = o.body; if (o.json) { init.body = JSON.stringify(o.json); h['Content-Type'] = 'application/json'; }
  const r = await worker.fetch(new Request('https://folio-pages.test' + p, init), env); const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) { /* binary */ } return { s: r.status, h: r.headers, buf, j };
}
const baseD = pf => ({ name: 'A', headline: 'h', email: 'a@b.com', phone: '', location: 'x', website: '', summary: 's', skills: 'a', availability: '', ctaLabel: 'Hire me', formTitle: 't', pollQuestion: 'q', pollOptions: 'a\nb', formEndpoint: '', thanks: 't', formMode: 'email', experience: [], education: [], links: [], services: [], portfolio: pf });
const entry = (type, over) => Object.assign({ id: rid(), kind: type.split('/')[0], type, name: 'f.bin', caption: 'cap', alt: 'alt', size: bytes[type].length }, over || {});
const data = pf => ({ D: baseD(pf), ST: { layout: 'modern', font: 'editorial', color: '#8a3f1f', paper: 'white' } });
const publish = async pf => (await call('POST', '/api/pages', { json: { data: data(pf), turnstile: 't-' + Math.random() } })).j;
const put = (page, e, buf, type, o) => call('PUT', '/api/pages/' + page.id + '/media/' + e.id, Object.assign({ key: page.editKey, ct: type || e.type, body: buf, headers: { 'Content-Length': String(buf.length) } }, o || {}));
const count = t => env.DB._raw.prepare('SELECT COUNT(*) c FROM ' + t).get().c;

(async () => {
  worker = (await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'folio-pages.mjs')).href)).default;
  fresh();
  const st = (await call('GET', '/api/status')).j; eq('status: reports media support, 15 MB and 6 files', st.media === true && st.maxMediaBytes === 15728640 && st.maxMediaFiles === 6);
  fresh({ MEDIA: undefined }); eq('status: without a KV namespace it says media is off', (await call('GET', '/api/status')).j.media === false);
  let pg; { const pe = entry('image/png'); pg = await publish([pe]); const nb = Object.assign({}, env, { MEDIA: undefined }); const saved = env; env = nb; const r = await put(pg, pe, bytes['image/png']); env = saved; eq('no bucket: upload is refused honestly (503 media_unavailable)', r.s === 503 && r.j.error === 'media_unavailable'); }
  fresh();
  const list = Object.keys(bytes).map(t => entry(t)); pg = await publish(list);
  eq('publish: a page may list 6 portfolio files', !!pg && !!pg.id, JSON.stringify(pg));
  for (const e of list) { const r = await put(pg, e, bytes[e.type]); eq('upload ' + e.type + ': accepted and recorded', r.s === 200 && r.j.size === bytes[e.type].length && env.MEDIA._files.has(pg.id + '/' + e.id), r.s + ' ' + (r.j && r.j.error)); }
  eq('uploads: six rows recorded', count('media') === 6);
  const e0 = list[0], got = await call('GET', '/api/media/' + pg.id + '/' + e0.id, { ip: ip() });
  eq('view: public GET returns the exact bytes with the right type', got.s === 200 && got.buf.equals(bytes[e0.type]) && got.h.get('content-type') === e0.type);
  eq('view: served with nosniff, locked-down CSP and no edit key anywhere', got.h.get('x-content-type-options') === 'nosniff' && /sandbox/.test(got.h.get('content-security-policy')) && !got.buf.toString('latin1').includes(pg.editKey));
  const vid = list.find(e => e.type === 'video/mp4'), rng = await call('GET', '/api/media/' + pg.id + '/' + vid.id, { headers: { Range: 'bytes=0-9' } });
  eq('view: video supports byte ranges (206 with Content-Range)', rng.s === 206 && rng.buf.length === 10 && /^bytes 0-9\/1012$/.test(rng.h.get('content-range')), rng.s + ' ' + rng.h.get('content-range'));
  eq('view: the allowed website may read files (CORS) and others may not', got.h.get('access-control-allow-origin') === ORIGIN && !(await call('GET', '/api/media/' + pg.id + '/' + e0.id, { headers: { Origin: 'https://evil.example' } })).h.get('access-control-allow-origin'));
  eq('view: unknown file is 404', (await call('GET', '/api/media/' + pg.id + '/' + rid())).s === 404);

  /* ---- permissions ---- */
  fresh(); pg = await publish([entry('image/png')]); const E = JSON.parse(JSON.stringify((await call('GET', '/api/pages/' + pg.id)).j.data.D.portfolio[0]));
  eq('permission: upload without a key is refused', (await put(pg, E, bytes['image/png'], undefined, { key: null })).s === 401 && count('media') === 0);
  eq('permission: upload with a wrong key is refused and stores nothing', (await put(pg, E, bytes['image/png'], undefined, { key: 'A'.repeat(43) })).s === 403 && env.MEDIA._files.size === 0);
  eq('permission: another page cannot upload to this page', await (async () => { const o = await publish([]); return (await put({ id: pg.id, editKey: o.editKey }, E, bytes['image/png'])).s === 403; })());

  /* ---- validation ---- */
  fresh(); const big = entry('image/png', { size: 15728641 }); eq('publish: a listed size over 15 MB is refused', (await call('POST', '/api/pages', { json: { data: data([big]), turnstile: 'x1' } })).s === 422);
  eq('publish: 7 files are refused', (await call('POST', '/api/pages', { json: { data: data(Array.from({ length: 7 }, () => entry('image/png'))), turnstile: 'x2' } })).s === 422);
  eq('publish: an SVG or unknown type is refused', (await call('POST', '/api/pages', { json: { data: data([entry('image/png', { type: 'image/svg+xml' })]), turnstile: 'x3' } })).s === 422);
  eq('publish: duplicate or malformed ids are refused', (await call('POST', '/api/pages', { json: { data: data([entry('image/png', { id: 'short' })]), turnstile: 'x4' } })).s === 422);
  const dup = entry('image/png'); eq('publish: the same id twice is refused', (await call('POST', '/api/pages', { json: { data: data([dup, dup]), turnstile: 'x5' } })).s === 422);
  eq('publish: pages without a portfolio still work (older Folio)', await (async () => { const d = data([]); delete d.D.portfolio; return (await call('POST', '/api/pages', { json: { data: d, turnstile: 'x6' } })).s === 201; })());
  pg = await publish([entry('image/png')]); const L = (await call('GET', '/api/pages/' + pg.id)).j.data.D.portfolio[0];
  eq('upload: a file the page does not list is refused', (await put(pg, { id: rid() }, bytes['image/png'], 'image/png')).s === 422);
  eq('upload: the wrong type for a listed file is refused', (await put(pg, L, bytes['image/jpeg'], 'image/jpeg')).s === 422);
  eq('upload: a Content-Type outside the list is refused', (await put(pg, L, bytes['image/png'], 'image/svg+xml')).s === 415);
  const fake = Buffer.concat([Buffer.from('<svg onload=alert(1)>'), Buffer.alloc(100)]);
  const r1 = await put(pg, L, fake, 'image/png'); eq('upload: a file labelled PNG whose bytes are not a PNG is refused and deleted', r1.s === 415 && r1.j.error === 'content_mismatch' && env.MEDIA._files.size === 0 && count('media') === 0);
  eq('upload: a Windows program labelled as MP4 is refused', await (async () => { const v = entry('video/mp4'); const p2 = await publish([v]); const r = await put(p2, v, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), 'video/mp4'); return r.s === 415 && env.MEDIA._files.size === 0; })());
  eq('upload: an iPhone .mov (QuickTime) labelled MP4 is refused', await (async () => { const v = entry('video/mp4'); const p2 = await publish([v]); const q = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  '), Buffer.alloc(100)]); return (await put(p2, v, q, 'video/mp4')).s === 415; })());
  const over = await call('PUT', '/api/pages/' + pg.id + '/media/' + L.id, { key: pg.editKey, ct: 'image/png', body: Buffer.alloc(10), headers: { 'Content-Length': String(15 * 1024 * 1024 + 1) } });
  eq('upload: a declared size over 15 MB is refused before any bytes are stored', (over.s === 413 || over.s === 400) && env.MEDIA._files.size === 0, String(over.s));
  eq('upload: an empty body is refused', (await call('PUT', '/api/pages/' + pg.id + '/media/' + L.id, { key: pg.editKey, ct: 'image/png', body: Buffer.alloc(0) })).s >= 400);

  /* ---- updating and removing ---- */
  fresh(); const a = entry('image/png'), b = entry('image/jpeg'); pg = await publish([a, b]); await put(pg, a, bytes['image/png']); await put(pg, b, bytes['image/jpeg']);
  const upd = await call('PUT', '/api/pages/' + pg.id, { key: pg.editKey, json: { data: data([b]) } });
  eq('update: dropping a file from the page deletes it from storage and the table', upd.s === 200 && !env.MEDIA._files.has(pg.id + '/' + a.id) && env.MEDIA._files.has(pg.id + '/' + b.id) && count('media') === 1);
  eq('update: the dropped file is no longer public', (await call('GET', '/api/media/' + pg.id + '/' + a.id)).s === 404);
  const del = await call('DELETE', '/api/pages/' + pg.id, { key: pg.editKey });
  eq('unpublish: the page and all its files are removed', del.s === 200 && env.MEDIA._files.size === 0 && count('media') === 0 && (await call('GET', '/api/media/' + pg.id + '/' + b.id)).s === 404);
  fresh(); pg = await publish([a]); await put(pg, a, bytes['image/png']); env.MEDIA._st.failDelete = true;
  const bad = await call('DELETE', '/api/pages/' + pg.id, { key: pg.editKey });
  eq('unpublish: if the files cannot be removed the page stays published and the reply says so', bad.s === 503 && bad.j.error === 'storage_unavailable' && count('pages') === 1);

  /* ---- limits ---- */
  fresh({ MEDIA_TOTAL_CAP_MB: '0.0001' }); pg = await publish([entry('image/png')]); const lim = (await call('GET', '/api/pages/' + pg.id)).j.data.D.portfolio[0];
  const full = await put(pg, lim, bytes['image/png']); eq('limit: when shared storage is full the upload is refused honestly', full.s === 503 && full.j.error === 'media_storage_full' && env.MEDIA._files.size === 0);
  fresh({ RL_MEDIA_PAGE_HOUR: '2' }); const many = [entry('image/png'), entry('image/png'), entry('image/png')]; pg = await publish(many); const rs = []; for (const e of many) rs.push((await put(pg, e, bytes['image/png'])).s);
  eq('limit: uploads per page per hour are capped', rs[0] === 200 && rs[1] === 200 && rs[2] === 429, rs.join());
  const f = results.filter(x => !x).length; console.log(`\n${results.length - f} passed, ${f} failed`); process.exit(f ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack)); process.exit(2); });
