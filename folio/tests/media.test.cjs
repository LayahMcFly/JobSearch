/* Tests for the project-image routes of the folio-pages Worker (version 1.3.0). Run from the repo root:  node --no-warnings folio/tests/media.test.cjs
   The REAL Worker code runs against SQLite (d1-shim.cjs) and a Map-based stand-in for Cloudflare KV. This proves the Worker's logic:
   the 15 MB cap, file-type checks, quotas, who may upload, and cleanup. It does not prove how real KV behaves (latency, limits, billing). */
const path = require('path'), { pathToFileURL } = require('url'), crypto = require('crypto'); const { makeD1 } = require('./d1-shim.cjs');
const results = []; const eq = (n, c, note) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !note ? '' : '  :: ' + note)); };
const ORIGIN = 'https://layahmcfly.github.io', MB = 1024 * 1024, MAX = 15 * MB;
const fakeKV = () => { const m = new Map(), kv = { m, failPut: false, puts: 0, async put(k, v, o) { kv.puts++; if (kv.failPut) throw new Error('KV put failed'); m.set(k, { v: new Uint8Array(v), meta: (o && o.metadata) || null }); }, async get(k) { const e = m.get(k); return e ? e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength) : null; },
  async getWithMetadata(k) { const e = m.get(k); return { value: e ? e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength) : null, metadata: e ? e.meta : null }; }, async delete(k) { m.delete(k); } }; return kv; };
const img = (type, size) => { const b = new Uint8Array(size || 64); const sig = { jpeg: [0xFF, 0xD8, 0xFF, 0xE0], png: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50] }[type]; b.set(sig, 0); return b; };
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'folio-pages.mjs')).href), worker = mod.default; let n = 0;
  const mkEnv = x => Object.assign({ DB: makeD1(), MEDIA: fakeKV(), TURNSTILE_SECRET: 's', ALLOWED_ORIGIN: ORIGIN }, x || {});
  const req = (env, method, url, o) => worker.fetch(new Request('https://w.test' + url, { method, headers: Object.assign({ Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.' + (n++ % 200 + 1) }, (o && o.headers) || {}), body: o && o.body, duplex: 'half' }), env);
  const KEYA = 'a'.repeat(43), KEYB = 'b'.repeat(43), PID = 'AbCdEfGhJkMn', PID2 = 'ZyXwVuTsRqPn';
  const makePages = async env => { await req(env, 'GET', '/api/pages/' + PID); const ins = (id, k) => env.DB.prepare('INSERT INTO pages(id, key_hash, data, created_at, updated_at) VALUES(?1, ?2, ?3, 1, 1)').bind(id, sha(k), '{}').run(); await ins(PID, KEYA); await ins(PID2, KEYB); };
  const up = (env, key, type, bytes, id, extra) => req(env, 'PUT', '/api/pages/' + (id || PID) + '/media', { headers: Object.assign({ 'content-type': type, 'content-length': String(bytes.length) }, key ? { Authorization: 'Bearer ' + key } : {}, extra || {}), body: bytes });
  const base = projects => ({ D: { name: 'A', headline: '', email: '', phone: '', location: '', website: '', summary: '', skills: '', availability: '', ctaLabel: 'Hire me', formTitle: 't', pollQuestion: '', pollOptions: '', formEndpoint: '', thanks: 't', formMode: 'email', experience: [], education: [], links: [], services: [], projects }, ST: { layout: 'modern', font: 'editorial', color: '#8a3f1f', paper: 'white' } });
  const proj = o => Object.assign({ title: 'P', desc: '', url: '', video: '', image: '', alt: '' }, o);
  const put = (env, key, data, id) => req(env, 'PUT', '/api/pages/' + (id || PID), { headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ data }) });

  let env = mkEnv(); await makePages(env);
  let r = await req(env, 'GET', '/api/status'), j = await r.json(); eq('status says image storage is on and names the 15 MB limit', j.version === '1.3.0' && j.media === true && j.maxImageBytes === MAX, JSON.stringify(j));
  r = await req(mkEnv({ MEDIA: undefined }), 'GET', '/api/status'); eq('status says image storage is off when the binding is missing', (await r.json()).media === false);

  /* uploads and serving */
  r = await up(env, KEYA, 'image/jpeg', img('jpeg', 2000)); j = await r.json(); const id1 = j.id;
  eq('upload: a JPEG is accepted (201, new id, size, type)', r.status === 201 && /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(id1) && j.size === 2000 && j.type === 'image/jpeg', JSON.stringify(j));
  eq('upload: kept in storage and listed against the page', env.MEDIA.m.has(id1) && (await env.DB.prepare('SELECT page_id FROM media WHERE id = ?1').bind(id1).first()).page_id === PID);
  r = await req(env, 'GET', '/api/media/' + id1); const body = new Uint8Array(await r.arrayBuffer());
  eq('serve: the same bytes come back, as an image, for anyone', r.status === 200 && body.length === 2000 && body[0] === 0xFF && r.headers.get('content-type') === 'image/jpeg');
  eq('serve: cached for a year, no type guessing, cannot run as a page, usable from other sites', /immutable/.test(r.headers.get('cache-control')) && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')) && r.headers.get('cross-origin-resource-policy') === 'cross-origin');
  r = await req(env, 'GET', '/api/media/ZZZZZZZZZZZZ'); eq('serve: an unknown id is 404', r.status === 404);
  r = await req(env, 'GET', '/api/media/short'); eq('serve: a malformed id is 404', r.status === 404);
  for (const t of ['png', 'webp', 'gif']) { r = await up(env, KEYA, MIME[t], img(t, 500)); eq('upload: ' + t + ' accepted', r.status === 201); }

  /* the 15 MB cap */
  r = await up(mkEnv(), KEYA, 'image/jpeg', img('jpeg', MAX)); // fresh env has no pages
  env = mkEnv(); await makePages(env);
  r = await up(env, KEYA, 'image/jpeg', img('jpeg', MAX)); eq('15 MB cap: exactly 15 MB is accepted', r.status === 201, r.status + ' ' + JSON.stringify(await r.clone().json()));
  r = await up(env, KEYA, 'image/jpeg', img('jpeg', MAX + 1)); j = await r.json(); eq('15 MB cap: one byte over is refused (413 image_too_large)', r.status === 413 && j.error === 'image_too_large' && j.maxBytes === MAX, r.status + ' ' + JSON.stringify(j));
  const before = env.MEDIA.puts;
  const big = img('jpeg', MAX + 5000), stream = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(big.subarray(i, i + 65536)); c.close(); } });
  r = await req(env, 'PUT', '/api/pages/' + PID + '/media', { headers: { 'content-type': 'image/jpeg', Authorization: 'Bearer ' + KEYA }, body: stream });
  eq('15 MB cap: leaving out the length header does not get around it (cut off while streaming)', r.status === 413 && env.MEDIA.puts === before, r.status);
  r = await up(env, KEYA, 'image/jpeg', img('jpeg', 100), PID, { 'content-length': String(MAX + 100) }); eq('15 MB cap: a length header over the cap is refused before any data is read', r.status === 413);

  /* what counts as an image */
  r = await up(env, KEYA, 'image/jpeg', img('png', 300)); eq('type: a PNG sent as a JPEG is refused (not_an_image)', r.status === 415 && (await r.json()).error === 'not_an_image');
  r = await up(env, KEYA, 'image/svg+xml', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')); eq('type: SVG is refused (image_type)', r.status === 415 && (await r.json()).error === 'image_type');
  r = await up(env, KEYA, 'image/png', new TextEncoder().encode('<html><script>alert(1)</script></html>')); eq('type: HTML sent as a PNG is refused', r.status === 415 && (await r.json()).error === 'not_an_image');
  r = await up(env, KEYA, 'image/png', new Uint8Array(0)); eq('type: an empty file is refused', r.status === 415);
  r = await up(env, KEYA, 'application/pdf', img('png', 100)); eq('type: other content types are refused', r.status === 415 && (await r.json()).error === 'image_type');

  /* who may upload */
  const good = img('png', 300);
  r = await up(env, null, 'image/png', good); eq('auth: no edit key is 401', r.status === 401);
  r = await up(env, KEYB, 'image/png', good); eq('auth: another page\'s key is 403', r.status === 403);
  r = await up(env, 'c'.repeat(43), 'image/png', good); eq('auth: a wrong key is 403', r.status === 403);
  r = await up(env, KEYA, 'image/png', good, 'QqQqQqQqQqQq'); eq('auth: an unknown page is 403, same as a wrong key', r.status === 403);
  r = await up(mkEnv({ MEDIA: undefined }), KEYA, 'image/png', good); eq('no storage binding: 503 media_not_set_up', r.status === 503 && (await r.json()).error === 'media_not_set_up');

  /* quotas */
  env = mkEnv({ RL_MEDIA_PAGE_HOUR: '100' }); await makePages(env); let codes = [];
  for (let i = 0; i < 13; i++) codes.push((await up(env, KEYA, 'image/png', img('png', 300))).status);
  eq('quota: 12 images per page, the 13th is 409 too_many_images', codes.slice(0, 12).every(c => c === 201) && codes[12] === 409, codes.join());
  env = mkEnv({ RL_MEDIA_PAGE_HOUR: '100' }); await makePages(env); const six = []; for (let i = 0; i < 7; i++) six.push((await up(env, KEYA, 'image/jpeg', img('jpeg', MAX))).status);
  eq('quota: 100 MB per page (six 15 MB images fit, the seventh is 409 page_image_space)', six.slice(0, 6).every(c => c === 201) && six[6] === 409, six.join());
  env = mkEnv({ MEDIA_GLOBAL_MB: '1' }); await makePages(env); const c1 = (await up(env, KEYA, 'image/jpeg', img('jpeg', 600000))).status, c2 = (await up(env, KEYA, 'image/jpeg', img('jpeg', 600000))); eq('quota: shared free storage full -> 503 media_full, nothing stored', c1 === 201 && c2.status === 503 && (await c2.json()).error === 'media_full' && env.MEDIA.m.size === 1);
  env = mkEnv({ RL_MEDIA_PAGE_HOUR: '2' }); await makePages(env); codes = []; for (let i = 0; i < 3; i++) codes.push((await up(env, KEYA, 'image/png', img('png', 300))).status); eq('rate limit: uploads per page per hour, then 429', codes.join() === '201,201,429', codes.join());
  env = mkEnv(); await makePages(env); env.MEDIA.failPut = true; r = await up(env, KEYA, 'image/png', img('png', 300)); eq('storage failure: 503 media_unavailable and no row left behind', r.status === 503 && (await r.json()).error === 'media_unavailable' && (await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first()).n === 0);

  /* pages that refer to images */
  env = mkEnv(); await makePages(env); const A = (await (await up(env, KEYA, 'image/png', img('png', 300))).json()).id, B = (await (await up(env, KEYB, 'image/png', img('png', 300), PID2)).json()).id;
  r = await put(env, KEYA, base([proj({ image: A, video: 'https://vimeo.com/123456789/abcdef1234', url: 'https://example.com/work' })])); eq('page: refers to its own image, a Vimeo link and a web link -> accepted', r.status === 200, r.status + ' ' + (await r.clone().text()).slice(0, 120));
  r = await put(env, KEYA, base([proj({ image: 'QqQqQqQqQqQq' })])); eq('page: refers to an image that was never uploaded -> 422', r.status === 422 && /image that was not uploaded/.test((await r.json()).detail));
  r = await put(env, KEYA, base([proj({ image: B })])); eq('page: refers to another page\'s image -> 422', r.status === 422);
  r = await put(env, KEYA, base([proj({ image: 'local:abc12345' })])); eq('page: a browser-only image reference is refused -> 422', r.status === 422);
  r = await put(env, KEYA, base([proj({ video: 'https://youtube.com/watch?v=abc' })])); eq('page: a video that is not Vimeo -> 422', r.status === 422 && /Vimeo/.test((await r.json()).detail));
  r = await put(env, KEYA, base([proj({ video: 'https://evil.example/vimeo.com/1234567' })])); eq('page: a lookalike Vimeo address -> 422', r.status === 422);
  r = await put(env, KEYA, base([proj({ url: 'javascript:alert(1)' })])); eq('page: a javascript: link -> 422', r.status === 422);
  r = await put(env, KEYA, base([proj({ title: 'x'.repeat(101) })])); eq('page: a title over 100 characters -> 422', r.status === 422);
  r = await put(env, KEYA, base(Array.from({ length: 13 }, () => proj()))); eq('page: more than 12 projects -> 422', r.status === 422);
  const old = base([]); delete old.D.projects; r = await put(env, KEYA, old); eq('page: a page from an older Folio (no projects at all) is still accepted', r.status === 200);
  // creating a page cannot carry images
  const mk = await req(env, 'POST', '/api/pages', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: base([proj({ image: A })]), turnstile: 't' }) }); eq('publish: a brand new page cannot refer to images (they can only come after)', mk.status === 422 && /after the page is published/.test((await mk.json()).detail), mk.status);

  /* cleanup */
  env = mkEnv(); await makePages(env); const ids = []; for (let i = 0; i < 3; i++) ids.push((await (await up(env, KEYA, 'image/png', img('png', 300))).json()).id);
  await env.DB.prepare('UPDATE media SET created_at = created_at - 5000 WHERE id IN (?1, ?2)').bind(ids[0], ids[1]).run(); // two uploads are old, one is fresh
  r = await put(env, KEYA, base([proj({ image: ids[0] })])); const left = (await env.DB.prepare('SELECT id FROM media').all()).results.map(x => x.id).sort();
  eq('cleanup: on update, old images the page no longer uses are deleted (storage and list), the one still used stays', r.status === 200 && !env.MEDIA.m.has(ids[1]) && env.MEDIA.m.has(ids[0]) && !left.includes(ids[1]) && left.includes(ids[0]));
  eq('cleanup: a fresh upload that is not used yet is kept (grace period, an upload may be in progress)', env.MEDIA.m.has(ids[2]) && left.includes(ids[2]));
  r = await req(env, 'DELETE', '/api/pages/' + PID, { headers: { Authorization: 'Bearer ' + KEYA } });
  eq('cleanup: unpublishing deletes every image of the page', r.status === 200 && env.MEDIA.m.size === 0 && (await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first()).n === 0);
  r = await req(env, 'GET', '/api/media/' + ids[0]); eq('cleanup: a deleted image is 404', r.status === 404);

  console.log('\n' + results.filter(Boolean).length + ' passed, ' + results.filter(x => !x).length + ' failed'); process.exit(results.every(Boolean) ? 0 : 1);
})();
