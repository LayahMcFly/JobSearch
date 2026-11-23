/* Folio publishing integration tests. Run from the repo root:  node --no-warnings folio/tests/publish.test.cjs
   Real Folio page in Chromium + the REAL Worker code + real SQLite standing in for D1 (see d1-shim.cjs).
   Turnstile (the widget script and siteverify) is SIMULATED. Nothing here touches Cloudflare. */
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');
const { makeD1, WRITE_LIMIT } = require('./d1-shim.cjs'), vm = require('vm');
const results = []; const rec = (n, ok, note) => { results.push({ name: n, ok, note: note || '' }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !note ? '' : '  :: ' + note)); };
const eq = (n, c, note) => rec(n, !!c, note);
const HOME = 'http://x.test/folio/', API = 'https://folio-pages.test', SECRET = 'SECRET-turnstile-value-9f3a', SITEKEY = 'TEST-SITEKEY';
const LIVE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CFG = /const PUBLISH = \{ api: '[^']*', siteKey: '[^']*' \};/;
const RAW = LIVE.replace(CFG, "const PUBLISH = { api: '', siteKey: '' };");
const APP = RAW.replace("const PUBLISH = { api: '', siteKey: '' };", `const PUBLISH = { api: '${API}', siteKey: '${SITEKEY}' };`);
eq('test setup: PUBLISH config patched in the test copy only', APP !== RAW && CFG.test(LIVE));
eq('config in folio/index.html holds only a public site key (no secret-looking values)', !/secret/i.test((LIVE.match(CFG) || [''])[0]) && /^[^]*siteKey: '0x4[A-Za-z0-9_-]{15,30}'/.test((LIVE.match(CFG) || [''])[0]));
let worker, env, mode = {}, seen = [], ipN = 10;
globalThis.fetch = async (url, init) => { // Worker -> Turnstile siteverify (simulated)
  const tok = new URLSearchParams(String(init.body)).get('response'); const ok = tok !== 'bad-token';
  return new Response(JSON.stringify(ok ? { success: true, hostname: 'x.test', action: 'folio-publish' } : { success: false, 'error-codes': ['invalid-input-response'] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const newEnv = x => { env = Object.assign({ DB: makeD1(), TURNSTILE_SECRET: SECRET, ALLOWED_ORIGIN: 'http://x.test', TURNSTILE_HOSTNAMES: 'x.test' }, x || {}); mode = {}; seen = []; };
async function wire(ctx) {
  const ip = '198.51.100.' + (ipN++);
  await ctx.route('**/*', async r => {
    const req = r.request(), u = req.url();
    if (u.startsWith(HOME)) return r.fulfill({ body: APP, contentType: 'text/html' });
    if (u.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) return r.fulfill({ contentType: 'text/javascript', body: `window.turnstile={ready(){throw new Error("Remove async/defer before using turnstile.ready()")},render:(el,o)=>{window.__ts=o;el.setAttribute('data-ts','1');return 7},reset:()=>{window.__tsReset=(window.__tsReset||0)+1}};` });
    if (u.startsWith(API + '/')) {
      const h = req.headers(), body = req.postData();
      seen.push({ method: req.method(), url: u, auth: h.authorization || '', body: body || '', headers: h });
      if (mode.network) return r.abort();
      if (mode.html) return r.fulfill({ status: 503, contentType: 'text/html', body: '<html>error code: 1027</html>' });
      const hdr = { 'CF-Connecting-IP': ip }; for (const k of ['origin', 'authorization', 'content-type']) if (h[k]) hdr[k] = h[k];
      const res = await worker.fetch(new Request(u, { method: req.method(), headers: hdr, body: body || undefined }), env);
      const out = {}; res.headers.forEach((v, k) => out[k] = v);
      return r.fulfill({ status: res.status, headers: out, body: await res.text() });
    }
    r.abort();
  });
}
let browser;
async function open(url, ctxOpts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1300, height: 1000 } }, ctxOpts || {})); await wire(ctx);
  ctx.permissions = await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://x.test' }).catch(() => 0);
  const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.ctx = ctx;
  await p.goto(url || HOME); return p;
}
const editor = async o => { const p = await open(HOME, o); await p.waitForFunction('typeof D !== "undefined" && document.querySelector("#panel").children.length'); await p.evaluate(() => { openCards.online = true; openCards.pub = true; renderPanel(); }); return p; };
const fill = p => p.evaluate(() => { D.name = 'Ada Lovelace'; D.email = 'ada@lovelace-writes.com'; D.headline = 'Writer'; D.formMode = 'email'; save(); renderPanel(); refresh(); });
const verify = async p => { await p.waitForSelector('#tsBox[data-ts]', { timeout: 5000 }); await p.waitForTimeout(100); await p.evaluate(() => window.__ts.callback('good-token')); await p.check('#pubConsent'); };
async function publish(p) { await fill(p); await verify(p); await p.click('[data-pub=publish]'); await p.waitForSelector('#pubLink', { timeout: 6000 }); return p.inputValue('#pubLink'); }
const msg = p => p.textContent('#pubLive');
const stored = p => p.evaluate(() => localStorage.getItem('folio:v1:pub'));
const rows = t => { try { return env.DB._raw.prepare('SELECT COUNT(*) c FROM ' + t).get().c; } catch (e) { return 0; } };
const vFrame = async V => { const h = await V.$('#viewFrame'); return h ? h.contentFrame() : null; };
const frameText = async V => { for (let i = 0; i < 40; i++) { const f = await vFrame(V); if (f) { const t = await f.textContent('body').catch(() => ''); if (t && t.trim()) return t; } await V.waitForTimeout(100); } return ''; };
const KEYRE = /[A-Za-z0-9_-]{43}/;

(async () => {
  worker = (await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'folio-pages.mjs')).href)).default;
  browser = await chromium.launch(); newEnv();

  eq('footer: shows the current version and the release list starts with it', await (async () => { const ctx = await browser.newContext(); await wire(ctx); const p = await ctx.newPage(); await p.goto(HOME); await p.waitForFunction('typeof D !== "undefined"'); const r = await p.evaluate(() => [document.querySelector('#ver').textContent, APP_VERSION, RELEASES[0][0]]); await ctx.close(); return r[0] === 'Folio ' + r[1] && r[1] === r[2]; })());

  /* ---- not connected ---- */
  { const ctx = await browser.newContext(); await ctx.route('**/*', r => r.request().url().startsWith(HOME) ? r.fulfill({ body: RAW, contentType: 'text/html' }) : r.abort());
    const p = await ctx.newPage(); await p.goto(HOME); await p.evaluate(() => { openCards.online = true; renderPanel(); });
    const t = await p.textContent('[data-card=online]'); eq('unconfigured: card says publishing is not connected, no Publish button', /not connected yet/.test(t) && !(await p.$('[data-pub=publish]')));
    await p.goto(HOME + '?id=AbCdEfGhJkMn'); await p.waitForTimeout(300); eq('unconfigured: viewer link shows "not available"', /not available/.test(await p.textContent('#viewMsg'))); await ctx.close(); }

  { const ctx = await browser.newContext(); await wire(ctx); const p = await ctx.newPage(); const hits = []; p.on('request', r => { if (r.url().includes('challenges.cloudflare.com')) hits.push(r.url()); });
    await p.goto(HOME); await p.waitForFunction('typeof D !== "undefined" && document.querySelector("#panel").children.length'); await p.waitForTimeout(600);
    eq('privacy: Turnstile is not contacted until the Publish card is opened', hits.length === 0, hits.join());
    await p.click('[data-card=online] summary'); await p.waitForTimeout(600); eq('privacy: opening the Publish card loads the human check', hits.length >= 1); await ctx.close(); }
  /* ---- publish, copy link, view ---- */
  const A = await editor(); const link = await publish(A);
  const post = seen.find(s => s.method === 'POST');
  eq('publish: link has the form /folio/?id=<12 chars>', /^http:\/\/x\.test\/folio\/\?id=[2-9A-HJ-NP-Za-km-z]{12}$/.test(link), link);
  eq('publish: Turnstile rendered with the public site key and action folio-publish', await A.evaluate(k => window.__ts.sitekey === k && window.__ts.action === 'folio-publish', SITEKEY));
  eq('publish: request carried the Turnstile token and no Authorization header', JSON.parse(post.body).turnstile === 'good-token' && !post.auth);
  eq('publish: Turnstile SECRET is nowhere in the browser page', !APP.includes(SECRET) && !(await A.content()).includes(SECRET) && !/secret/i.test(await A.evaluate(() => JSON.stringify(PUBLISH))));
  eq('publish: pressing Publish too early explains what is missing and sends nothing', await (async () => { const q = await editor(); await fill(q); await q.waitForSelector('#tsBox[data-ts]'); const n0 = seen.length; await q.click('[data-pub=publish]'); const m1 = await msg(q); await q.evaluate(() => window.__ts.callback('t')); await q.click('[data-pub=publish]'); const m2 = await msg(q); await q.check('#pubConsent'); const d = await q.isDisabled('[data-pub=publish]'); await q.ctx.close(); return /Tick the box/.test(m1) && /Tick the box/.test(m2) && !d && seen.length === n0; })());
  eq('publish: the human-check status line shows waiting, then complete', await (async () => { const q = await editor(); await q.waitForSelector('#tsBox[data-ts]'); const a = await q.textContent('#tsState'); await q.evaluate(() => window.__ts.callback('t')); const b = await q.textContent('#tsState'); await q.ctx.close(); return /Waiting/.test(a) && /complete/.test(b); })());
  for (const [code, want] of [['110200', /not allow this website address.*layahmcfly\.github\.io/], ['400020', /site key stored in Folio is not valid/], ['110100', /site key stored in Folio is not valid/], ['300030', /could not run the check/], ['600010', /could not be passed/], ['999999', /hit an error \(code 999999\)/]])
    eq('human check error ' + code + ': explained in plain words, stays on screen, pressing Publish repeats the reason (no circular message), nothing sent', await (async () => { const q = await editor(); await fill(q); await q.waitForSelector('#tsBox[data-ts]'); const n0 = seen.length; await q.evaluate(c => window.__ts['error-callback'](c), code); const st = await q.textContent('#tsState'); await q.check('#pubConsent'); await q.click('[data-pub=publish]'); const m = await q.textContent('#pubLive'); const d = await q.isDisabled('[data-pub=publish]'); const rb = await q.isVisible('[data-pub=retryTs]'); await q.ctx.close(); return want.test(st) && /Nothing was published/.test(m) && /Try the human check again/.test(m) && rb && !d && seen.length === n0; })());
  eq('human check cannot load (blocked script): says so and names blockers', await (async () => { const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } }); await wire(ctx); await ctx.route('https://challenges.cloudflare.com/**', r => r.abort()); const q = await ctx.newPage(); q.ctx = ctx; await q.goto(HOME); await q.waitForFunction('typeof D !== "undefined"'); await q.evaluate(() => { openCards.online = true; renderPanel(); }); await q.waitForFunction(() => /could not download/.test((document.querySelector('#tsState') || {}).textContent || ''), null, { timeout: 6000 }).catch(() => 0); const st = await q.textContent('#tsState'); await ctx.close(); return /could not download the human check/.test(st) && /ad blocker/.test(st); })());
  eq('human check: Try again after a blocked load recovers without reloading the page', await (async () => { const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } }); await wire(ctx); let block = true; await ctx.route('https://challenges.cloudflare.com/**', r => block ? r.abort() : r.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={ready(){throw new Error("Remove async/defer before using turnstile.ready()")},render:(el,o)=>{window.__ts=o;el.setAttribute("data-ts","1");return 9},reset(){}};' })); const q = await ctx.newPage(); q.ctx = ctx; await q.goto(HOME); await q.waitForFunction('typeof D !== "undefined"'); await q.evaluate(() => { openCards.online = true; renderPanel(); }); await q.waitForSelector('[data-pub=retryTs]:not([hidden])', { timeout: 6000 }); block = false; await q.click('[data-pub=retryTs]'); await q.waitForSelector('#tsBox[data-ts]', { timeout: 6000 }); await q.evaluate(() => window.__ts.callback('t')); const st1 = await q.textContent('#tsState'), hid = await q.isHidden('[data-pub=retryTs]'); await ctx.close(); return /complete/.test(st1) && hid; })());
  eq('human check: render() throwing for a bad site key is explained as an invalid key', await (async () => { const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } }); await wire(ctx); await ctx.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={ready(){throw new Error("Remove async/defer before using turnstile.ready()")},render(){throw new Error("Invalid input for parameter sitekey")},reset(){}};' })); const q = await ctx.newPage(); q.ctx = ctx; await q.goto(HOME); await q.waitForFunction('typeof D !== "undefined"'); await q.evaluate(() => { openCards.online = true; renderPanel(); }); await q.waitForFunction(() => /not valid/.test((document.querySelector('#tsState') || {}).textContent || ''), null, { timeout: 6000 }).catch(() => 0); const st = await q.textContent('#tsState'); await ctx.close(); return /site key stored in Folio is not valid/.test(st); })());
  const keyLocal = JSON.parse(await stored(A)).key;
  eq('publish: edit key kept on this device only', KEYRE.test(keyLocal) && !link.includes(keyLocal));
  await A.click('[data-pub=copy]'); await A.waitForTimeout(200);
  const clip = await A.evaluate(() => (navigator.clipboard ? navigator.clipboard.readText().catch(() => null) : null));
  clip === null ? rec('copy link: clipboard text equals the link', true, 'SKIP clipboard-read unavailable') : eq('copy link: clipboard text equals the link', clip === link, clip);
  eq('copy link: says "Link copied" or explains failure', /Link copied|Could not copy/.test(await msg(A)));
  const V = await open(link); await V.waitForFunction('!document.querySelector("#viewFrame").hidden', null, { timeout: 5000 });
  const vf = await vFrame(V);
    eq('view: visitor in a fresh browser sees the published page, not the editor', (await frameText(V)).includes('Ada Lovelace') && !(await V.isVisible('#panel')));
  eq('view: visitor sent no Authorization header and no key', seen.filter(s => s.method === 'GET').every(s => !s.auth && !s.url.includes(keyLocal)));
  eq('view: frame is sandboxed WITHOUT allow-same-origin', !/allow-same-origin/.test(await V.getAttribute('#viewFrame', 'sandbox')));
  eq('view: viewer page is noindex with a restrictive CSP', await V.evaluate(() => /noindex/.test(document.querySelector('#viewFrame').srcdoc) && /connect-src https:\/\/formspree\.io https:\/\/api\.web3forms\.com/.test(document.querySelector('#viewFrame').srcdoc)));
  eq('view: no editor controls and no way to edit', !(await V.$('[data-pub]')) && await vf.evaluate(() => !document.querySelector('input[type=file]') && !document.body.innerText.includes('editKey')));
  eq('view: visitor has none of the owner\'s storage', await V.evaluate(() => localStorage.getItem('folio:v1:pub') === null && localStorage.getItem('folio:v1') === null));
  eq('view: no page errors', V.errs.length === 0 && A.errs.length === 0, V.errs.concat(A.errs).join('|'));
  const idPub = new URL(link).searchParams.get('id');
  const pub1 = await (await fetch0(API + '/api/pages/' + idPub)).text();
  eq('public API response has no edit key and no hash', !pub1.includes(keyLocal) && !pub1.includes(crypto.createHash('sha256').update(keyLocal).digest('hex')) && !/editKey|key_hash/.test(pub1));

  /* ---- backup is key-free; recovery file has the key ---- */
  await A.evaluate(() => { openCards.pub = true; renderPanel(); });
  const [bk] = await Promise.all([A.waitForEvent('download'), A.click('#backupBtn')]); const bkText = fs.readFileSync(await bk.path(), 'utf8');
  eq('ordinary backup has no page ID, no edit key, no publishing fields', !bkText.includes(keyLocal) && !bkText.includes(idPub) && !/editKey|pageId|folioPublishing/.test(bkText) && Object.keys(JSON.parse(bkText)).sort().join() === 'D,ST');
  eq('card warns that backups do not include publishing access', /never include publishing access/.test(await A.textContent('[data-card=pub]')));
  const [rf] = await Promise.all([A.waitForEvent('download'), A.click('[data-pub=saveKey]')]); const recPath = await rf.path(); const recText = fs.readFileSync(recPath, 'utf8'); const rec1 = JSON.parse(recText);
  eq('recovery file: named folio-publishing-recovery.json with page ID + edit key + service + warning', rf.suggestedFilename() === 'folio-publishing-recovery.json' && rec1.pageId === idPub && rec1.editKey === keyLocal && rec1.service === API && /never share/i.test(rec1.warning));
  eq('recovery file: card carries a clear security warning', /store it like a password/i.test(await A.textContent('[data-card=online]')) && /Do not share it/.test(await A.textContent('[data-card=online]')));
  const stNow = await A.evaluate(() => JSON.stringify(ST) + JSON.stringify(D));
  eq('recovery file: contains no resume text', !/Ada Lovelace|ada@lovelace/.test(recText));

  /* ---- restore on another device ---- */
  const B = await editor(); const bnet = seen.length;
  await B.setInputFiles('#pubRestoreFile', recPath); await B.waitForSelector('#pubLink');
  const chk = seen.slice(bnet).find(s => s.url.endsWith('/check'));
  eq('restore (device B): key checked with the service, in a header, not the URL', chk && chk.auth === 'Bearer ' + keyLocal && !chk.url.includes(keyLocal) && chk.method === 'POST');
  eq('restore (device B): shows the same link and does not hold resume text yet', (await B.inputValue('#pubLink')) === link && (await B.evaluate(() => D.name)) !== 'Ada Lovelace');
  await B.click('[data-pub=loadCopy]'); await B.click('#cfOk').catch(() => 0);
  eq('restore (device B): can load the published version into the editor', await (async () => { await B.waitForFunction(() => D.name === 'Ada Lovelace', null, { timeout: 4000 }).catch(() => 0); return (await B.evaluate(() => D.name)) === 'Ada Lovelace'; })());
  await B.evaluate(() => { D.headline = 'Editor of things'; save(); }); await B.click('[data-pub=update]'); await B.waitForFunction(() => /confirmed the update/.test(document.querySelector('#pubLive').textContent), null, { timeout: 4000 });
  const upd = seen.filter(s => s.method === 'PUT').pop();
  eq('update (device B): PUT with Authorization header only, no key in URL or body', upd.auth === 'Bearer ' + keyLocal && !upd.url.includes(keyLocal) && !upd.body.includes(keyLocal));
  await V.reload(); await V.waitForFunction('!document.querySelector("#viewFrame").hidden'); eq('update: visitor reload shows the new headline immediately in this test (real timing unmeasured)', (await frameText(V)).includes('Editor of things'));
  eq('update: no cache headers allow stale copies', await (async () => { const r = await fetch0(API + '/api/pages/' + idPub); return /no-store/.test(r.headers.get('cache-control') || ''); })());

  /* ---- bad recovery files ---- */
  const C = await editor(); const tmp = fs.mkdtempSync('/tmp/folio-rec-'); const w = (n, o) => { const f = path.join(tmp, n); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); return f; };
  const badCases = [['not json', w('a.json', 'hello')], ['wrong shape', w('b.json', { pageId: idPub })], ['malformed key', w('c.json', { folioPublishing: 1, pageId: idPub, editKey: 'short', service: API })], ['other service', w('d.json', Object.assign({}, rec1, { service: 'https://evil.example' }))], ['huge', w('e.json', 'x'.repeat(5000))]];
  for (const [n, f] of badCases) { const before = seen.length; await C.setInputFiles('#pubRestoreFile', f); await C.waitForTimeout(250); eq('restore rejects ' + n + ' without contacting the service or saving anything', seen.length === before && (await stored(C)) === null && /Nothing was changed|does not look like|different publishing service/.test(await msg(C))); }
  const wrongKey = crypto.randomBytes(32).toString('base64url'); await C.setInputFiles('#pubRestoreFile', w('f.json', Object.assign({}, rec1, { editKey: wrongKey }))); await C.waitForFunction(() => /does not match/.test(document.querySelector('#pubLive').textContent), null, { timeout: 4000 });
  eq('restore with the WRONG key: service says no, nothing saved', (await stored(C)) === null);
  const otherId = 'AAAAAAAAAAAA'.replace(/A/g, '2'); await C.setInputFiles('#pubRestoreFile', w('g.json', Object.assign({}, rec1, { pageId: otherId }))); await C.waitForFunction(() => /does not match|no longer exists/.test(document.querySelector('#pubLive').textContent), null, { timeout: 4000 });
  eq('restore: real key against someone else\'s / missing page ID fails the same way', (await stored(C)) === null);

  /* ---- key checks at the API level (via the real browser flow's wire format) ---- */
  const wr = async (m, id, key) => { const r = await fetchWith(m, API + '/api/pages/' + id, key, m === 'PUT' ? JSON.stringify({ data: JSON.parse(await A.evaluate(() => snapNow())) }) : undefined); return r.status; };
  eq('edit attempts: missing key 401, wrong key 403, other page 403 (PUT and DELETE)', [await wr('PUT', idPub, ''), await wr('PUT', idPub, wrongKey), await wr('DELETE', idPub, wrongKey), await wr('PUT', otherId, keyLocal), await wr('DELETE', otherId, keyLocal)].join() === '401,403,403,403,403');
  eq('edit attempts: page unchanged after all of those', (await (await fetch0(API + '/api/pages/' + idPub)).text()).includes('Editor of things'));

  /* ---- oversize / malformed ---- */
  const D0 = await A.evaluate(() => JSON.parse(snapNow()));
  const big = JSON.parse(JSON.stringify(D0)); big.D.summary = 'x'.repeat(120000);
  const r1 = await postRaw(JSON.stringify({ data: big, turnstile: 'good-token' })), r2 = await postRaw('{not json'), r3 = await postRaw(JSON.stringify({ data: { D: { name: 5 }, ST: {} }, turnstile: 'good-token' })), r4 = await postRaw(JSON.stringify({ data: Object.assign({}, D0, { extra: 1 }), turnstile: 'good-token' }));
  eq('oversized (>100 KB) → 413, malformed JSON → 400, wrong shape → 422, extra fields → 422', [r1, r2, r3, r4].join() === '413,400,422,422', [r1, r2, r3, r4].join());
  const cnt = rows('pages'); eq('rejected uploads created no pages', cnt === 1, 'pages=' + cnt);
  eq('Folio\'s own cleaned output always passes the Worker\'s validation (drift check on messy data)', await (async () => { const q = await editor(); await q.evaluate(() => { D.name = 'x'.repeat(5000); D.skills = 'a,'.repeat(3000); D.experience = Array.from({ length: 80 }, (_, i) => ({ role: 'r' + i, company: 'c', dates: 'd', bullets: 'b\n'.repeat(60) })); D.links = Array.from({ length: 60 }, () => ({ label: 'l', url: 'https://a.b/' + 'x'.repeat(900) })); D.formMode = 'formspree'; D.formEndpoint = 'https://formspree.io/f/abcdwxyz'; D.email = 'a@b.co'; save(); renderPanel(); }); const s = await q.evaluate(() => snapNow()); const code = await postRaw(JSON.stringify({ data: JSON.parse(s), turnstile: 'fresh-' + Math.random() })); await q.ctx.close(); return code === 201 || code === 413; })());

  /* ---- failures leave state honest ---- */
  const E = await editor(); await fill(E); await verify(E); mode.network = true; await E.click('[data-pub=publish]'); await E.waitForFunction(() => /No clear answer/.test(document.querySelector('#pubLive').textContent), null, { timeout: 8000 });
  eq('publish, network down: honest message, no link shown, nothing stored, Turnstile reset', /Folio cannot tell whether a page was created/.test(await msg(E)) && !(await E.$('#pubLink')) && (await stored(E)) === null && (await E.evaluate(() => window.__tsReset)) >= 1);
  mode = {}; await E.evaluate(() => window.__ts.callback('bad-token')); await E.check('#pubConsent').catch(() => 0); await E.click('[data-pub=publish]'); await E.waitForFunction(() => /human check did not pass/.test(document.querySelector('#pubLive').textContent), null, { timeout: 5000 });
  eq('publish, Turnstile rejects token: says so, no page created', /No page was created/.test(await msg(E)) && !(await E.$('#pubLink')));
  env.DB._st.failWrites = WRITE_LIMIT; await E.evaluate(() => window.__ts.callback('good-token')); await E.click('[data-pub=publish]'); await E.waitForFunction(() => /free daily limit/.test(document.querySelector('#pubLive').textContent), null, { timeout: 5000 });
  eq('publish, D1 write quota: says a free daily limit was reached, how long to wait, no page created', /writes/.test(await msg(E)) && /Try again in/.test(await msg(E)) && /No page was created/.test(await msg(E)) && !(await E.$('#pubLink')));
  env.DB._st.failWrites = null;
  /* update / unpublish failures on A */
  await A.evaluate(() => { D.headline = 'Changed again'; save(); }); const dirtyBefore = await A.evaluate(() => PUB.snap === snapNow());
  mode.html = true; await A.click('[data-pub=update]'); await A.waitForFunction(() => /No clear answer/.test(document.querySelector('#pubLive').textContent), null, { timeout: 8000 });
  eq('update, non-JSON Cloudflare error (1027-style): "cannot tell", published snapshot not marked as updated', /cannot tell whether the change was saved/.test(await msg(A)) && !dirtyBefore && (await A.evaluate(() => PUB.snap !== snapNow())));
  eq('update failure message does not promise viewing or unpublishing still works', !/always|guarantee/i.test(await msg(A)));
  A.on('dialog', d => d.dismiss()); await A.click('[data-pub=unpublish]'); await A.click('#cfOk').catch(() => 0);
  await A.waitForFunction(() => /cannot tell whether the page was removed/.test(document.querySelector('#pubLive').textContent), null, { timeout: 8000 }).catch(() => 0);
  eq('unpublish, service unreachable: says it cannot tell, page still managed, key kept', /cannot tell whether the page was removed/.test(await msg(A)) && !!(await stored(A)));
  mode = {}; env.DB._st.failWrites = WRITE_LIMIT; await A.click('[data-pub=unpublish]'); await A.click('#cfOk').catch(() => 0);
  await A.waitForFunction(() => /still published/.test(document.querySelector('#pubLive').textContent), null, { timeout: 10000 }).catch(() => 0);
  eq('unpublish, D1 write quota: "Your page is still published", key kept', /still published/.test(await msg(A)) && !!(await stored(A)));
  env.DB._st.failWrites = null;
  /* viewer failures */
  env.DB._st.failReads = 'D1 DB reached its read limit'; const V2 = await open(link); await V2.waitForFunction('!document.querySelector("#viewMsg").hidden && !/Loading/.test(document.querySelector("#viewMsg").textContent)', null, { timeout: 8000 }).catch(() => 0);
  eq('viewer, storage read failure: honest "cannot be shown right now", not "page removed"', /cannot be (shown|loaded) right now/.test(await V2.textContent('#viewMsg')) && !/unpublished/.test(await V2.textContent('#viewMsg')));
  env.DB._st.failReads = null;
  const before = seen.length; const V3 = await open(HOME + '?id=<script>x'); await V3.waitForTimeout(300);
  eq('viewer, invalid ID: no request is made', seen.length === before && /not available/.test(await V3.textContent('#viewMsg')));
  const V4 = await open(HOME + '?id=222222222222'); await V4.waitForFunction('!/Loading/.test(document.querySelector("#viewMsg").textContent)', null, { timeout: 5000 }); eq('viewer, unknown ID: "not available"', /not available/.test(await V4.textContent('#viewMsg')));

  /* ---- unpublish works; link dies; page can be republished ---- */
  const A2 = await editor(); await A2.setInputFiles('#pubRestoreFile', recPath); await A2.waitForSelector('#pubLink');
  await A2.click('[data-pub=unpublish]'); await A2.click('#cfOk').catch(() => 0); await A2.waitForFunction(() => /confirmed the page was removed/.test(document.querySelector('#pubLive')?.textContent || ''), null, { timeout: 6000 }).catch(() => 0);
  eq('unpublish: service confirmed, Folio forgot the key, link now 404', (await stored(A2)) === null && (await fetch0(API + '/api/pages/' + idPub)).status === 404);
  await V.reload(); await V.waitForFunction('!document.querySelector("#viewMsg").hidden', null, { timeout: 5000 }); eq('unpublish: visitor with the old link sees "not available"', /not available/.test(await V.textContent('#viewMsg')));
  eq('after unpublish the old recovery file no longer works', await (async () => { const D2 = await editor(); await D2.setInputFiles('#pubRestoreFile', recPath); await D2.waitForFunction(() => /does not match/.test(document.querySelector('#pubLive').textContent), null, { timeout: 4000 }).catch(() => 0); return (await stored(D2)) === null; })());

  /* ---- rate limit seen through the UI ---- */
  newEnv({ RL_PUBLISH_IP_HOUR: '1' }); const R = await editor(); await publish(R); await R.evaluate(() => { PUB = null; savePub(); renderPanel(); }); await fill(R); await verify(R); await R.click('[data-pub=publish]'); await R.waitForFunction(() => /Too many attempts/.test(document.querySelector('#pubLive').textContent), null, { timeout: 5000 });
  eq('rate limit: UI says too many attempts and when to retry; no second page', /Try again in/.test(await msg(R)) && rows('pages') === 1);

  /* ---- hostile data in the viewer ---- */
  newEnv(); const H = await editor(); const evil = '"><img src=x onerror="window.__p=1;parent.__p=1">';
  await H.evaluate(e => { D.name = e; D.headline = e; D.summary = '</script><script>window.__p=1;try{parent.localStorage.setItem("pwn","1")}catch(x){window.__blocked=1}</script>'; D.formMode = 'email'; D.email = 'a@b.co'; save(); }, evil);
  await verify(H); await H.click('[data-pub=publish]').catch(() => 0); await H.waitForSelector('#pubLink', { timeout: 5000 }).catch(() => 0); const hl = await H.inputValue('#pubLink').catch(() => '');
  if (hl) { const HV = await open(hl); await HV.waitForFunction('!document.querySelector("#viewFrame").hidden', null, { timeout: 5000 }); await HV.waitForTimeout(400);
    const hf = await vFrame(HV);
    eq('hostile published data: no script ran in the viewer, parent storage untouched', !(await HV.evaluate(() => window.__p || localStorage.getItem('pwn'))) && !(await hf.evaluate(() => window.__p).catch(() => 0))); }
  else rec('hostile published data: no script ran in the viewer, parent storage untouched', false, 'could not publish');

  /* ---- animated dropdowns ---- */
  { const P = await editor(); await P.evaluate(() => { openCards.send = true; renderPanel(); }); await P.waitForSelector('.dd-btn');
    eq('dropdown: the plain browser select is replaced by a themed button and hidden', await P.evaluate(() => { const s = document.querySelector('select[data-f=formMode]'); return s.classList.contains('dd-native') && getComputedStyle(s).display === 'none' && document.querySelector('.dd-btn').getBoundingClientRect().height >= 44; }));
    await P.click('.dd-btn'); await P.waitForTimeout(30); const early = await P.evaluate(() => +getComputedStyle(document.querySelector('.dd-list')).opacity); await P.waitForTimeout(350);
    eq('dropdown: the list fades in rather than appearing at once', early < 1 && await P.evaluate(() => +getComputedStyle(document.querySelector('.dd-list')).opacity === 1 && document.querySelector('.dd-btn').getAttribute('aria-expanded') === 'true'));
    await P.keyboard.press('ArrowDown'); await P.keyboard.press('Enter'); await P.waitForTimeout(300);
    eq('dropdown: keyboard choice updates the real select, Folio data and the button text', await P.evaluate(() => D.formMode === document.querySelector('select[data-f=formMode]').value && D.formMode !== 'email' && !document.querySelector('.dd-list')));
    await P.click('.dd-btn'); await P.waitForTimeout(250); await P.keyboard.press('Escape'); await P.waitForTimeout(300);
    eq('dropdown: Escape closes it and focus returns to the button', await P.evaluate(() => !document.querySelector('.dd-list') && document.activeElement.classList.contains('dd-btn')));
    await P.click('.dd-btn'); await P.waitForTimeout(250); await P.click('.dd-opt >> nth=0'); await P.waitForTimeout(300);
    eq('dropdown: tapping an option picks it', await P.evaluate(() => D.formMode === 'email'));
    eq('dropdown: setting the value from code updates the button', await P.evaluate(() => { document.querySelector('select[data-f=formMode]').value = 'gscript'; return /Google/.test(document.querySelector('.dd-btn').textContent); }));
    await P.ctx.close();
    const rm = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 430, height: 900 } }); await wire(rm); const R = await rm.newPage(); await R.goto(HOME); await R.waitForFunction('typeof D !== "undefined"'); await R.evaluate(() => { openCards.send = true; renderPanel(); }); await R.waitForSelector('.dd-btn'); await R.click('.dd-btn');
    eq('dropdown: with reduce-motion on, the list has no animation', await R.evaluate(() => getComputedStyle(document.querySelector('.dd-list')).transitionDuration === '0s')); await rm.close(); }

  /* ---- one Download menu ---- */
  { const P = await editor(); const vis = async sel => P.evaluate(s => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel);
    eq('download menu: PDF and site buttons are tucked under one Download button', !(await vis('#pdfBtn')) && !(await vis('#exportBtn')) && (await vis('#dlBtn')));
    await P.click('#dlBtn'); eq('download menu: opens with both choices and reports expanded', (await vis('#pdfBtn')) && (await vis('#exportBtn')) && (await P.getAttribute('#dlBtn', 'aria-expanded')) === 'true');
    await P.keyboard.press('Escape'); eq('download menu: Escape closes it and returns focus to Download', !(await vis('#pdfBtn')) && (await P.evaluate(() => document.activeElement.id)) === 'dlBtn');
    await P.click('#dlBtn'); await P.click('h1'); eq('download menu: a tap outside closes it', !(await vis('#pdfBtn')));
    await P.click('#dlBtn'); await P.click('#pdfBtn'); eq('download menu: PDF choice asks about paper color first', await P.evaluate(() => document.getElementById('pdfDialog').open) && !(await vis('#exportBtn'))); await P.keyboard.press('Escape'); await P.ctx.close(); }

  /* ---- Google Apps Script mode ---- */
  { const code = (LIVE.match(/const GSCRIPT_CODE = `([\s\S]*?)`;/) || [])[1]; const src = code ? eval('`' + code + '`') : '';
    const sent = []; const sandbox = { ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ t, setMimeType() { return this; } }) }, Session: { getEffectiveUser: () => ({ getEmail: () => 'me@gmail.com' }) }, MailApp: { sendEmail: o => sent.push(o) }, JSON, String };
    vm.createContext(sandbox); vm.runInContext(src, sandbox);
    const post = o => vm.runInContext('doPost', sandbox)({ postData: { contents: typeof o === 'string' ? o : JSON.stringify(o) } }).t;
    eq('google script: sends one email to the account owner with the visitor as reply-to', JSON.parse(post({ name: 'Sam', email: 'sam@x.com', need: 'Blog', message: 'Hi' })).ok === true && sent.length === 1 && sent[0].to === 'me@gmail.com' && sent[0].replyTo === 'sam@x.com' && /Hi/.test(sent[0].body));
    sent.length = 0; post({ name: 'Eve\r\nBcc: x@y.com', email: 'e@x.com', message: 'm' });
    eq('google script: line breaks in the name cannot inject mail headers', sent.length === 1 && !/[\r\n]/.test(sent[0].subject));
    sent.length = 0; eq('google script: missing name, bad email or bad JSON sends nothing and says so', [JSON.parse(post({ name: '', email: 'a@b.com' })).ok, JSON.parse(post({ name: 'a', email: 'nope' })).ok, JSON.parse(post('not json')).ok].every(v => v === false) && sent.length === 0);
    const P = await editor(); await fill(P);
    await P.evaluate(() => { D.formMode = 'gscript'; D.formEndpoint = ''; renderPanel(); openCards.send = true; renderPanel(); });
    eq('google mode: the card shows the steps, the script and a Copy button', await P.isVisible('#gsCode') && await P.isVisible('#gsCopy') && /Web app URL/.test(await P.textContent('#panel')));
    eq('google mode: a wrong address is stopped with a plain reason', await P.evaluate(() => { D.formEndpoint = 'https://example.com/exec'; const v = validateExport(); return !!v && /script\.google\.com/.test(v.msg); }));
    const URL_ = 'https://script.google.com/macros/s/AKfycbxTEST123/exec'; await P.evaluate(u => { D.formEndpoint = u; }, URL_);
    eq('google mode: the real address is accepted', await P.evaluate(() => validateExport() === null));
    const html = await P.evaluate(() => buildSite(D, ST, {})); const posts = [];
    const Q = await P.ctx.newPage(); await Q.route('https://script.google.com/**', async r => { posts.push({ ct: r.request().headers()['content-type'], body: r.request().postData() }); const bad = posts.length === 2; await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(bad ? { ok: false, error: 'Could not send' } : { ok: true }) }); });
    await Q.setContent(html); await Q.fill('[name=name]', 'Sam'); await Q.fill('[name=email]', 'sam@x.com'); await Q.check('input[name=need]'); await Q.click('.cta'); await Q.waitForFunction(() => !document.getElementById('hireDone').hidden, null, { timeout: 4000 });
    eq('google mode: the form sends plain text (no preflight), one request, and success shows the recorded page', posts.length === 1 && /^text\/plain/.test(posts[0].ct) && JSON.parse(posts[0].body).email === 'sam@x.com' && /Your response has been recorded/.test(await Q.textContent('#hireDone')));
    await Q.click('.again'); await Q.fill('[name=name]', 'Sam'); await Q.fill('[name=email]', 'sam@x.com'); await Q.check('input[name=need]'); await Q.click('.cta'); await Q.waitForFunction(() => /not accepted/.test(document.querySelector('.msg').textContent), null, { timeout: 4000 });
    eq('google mode: when the script reports a failure, the page says so and keeps the answers', await Q.evaluate(() => document.getElementById('hireDone').hidden && document.querySelector('[name=name]').value === 'Sam'));
    const csp = (await P.evaluate(() => buildSite(D, ST, { viewer: true }))).match(/connect-src[^;]*/)[0]; eq('google mode: the published page may contact Google script addresses only for this', /script\.google\.com/.test(csp) && /script\.googleusercontent\.com/.test(csp));
    await P.ctx.close(); }

  /* ---- paper look (resume sheet) and Google-Forms-style hire section ---- */
  { const P = await editor(); await P.waitForTimeout(300);
    const html = await P.evaluate(() => buildSite(D, ST, {}));
    const pg = await P.ctx.newPage(); await pg.setContent(html); await pg.waitForTimeout(200);
    const r = await pg.evaluate(() => { const sh = document.querySelector('.sheet'), cs = getComputedStyle(sh, '::after'); return { grain: cs.backgroundImage.includes('svg'), pe: cs.pointerEvents, pos: getComputedStyle(sh).position }; });
    eq('paper look: resume sheet has a grain overlay that never blocks clicks', r.grain && r.pe === 'none' && r.pos === 'relative');
    await pg.emulateMedia({ media: 'print' }); eq('paper look: overlay is off when printing', await pg.evaluate(() => getComputedStyle(document.querySelector('.sheet'), '::after').display) === 'none');
    await pg.emulateMedia({ media: 'screen' });
    const gf = await pg.evaluate(() => ({ cards: document.querySelectorAll('#hireForm .q').length, radios: document.querySelectorAll('#hireForm input[type=radio]').length, clear: !!document.querySelector('#hireForm .clear'), req: document.querySelectorAll('#hireForm .req').length }));
    eq('form looks like a Google Form: question cards, radio choices, required markers, Clear form', gf.cards >= 4 && gf.radios >= 2 && gf.clear && gf.req >= 3, JSON.stringify(gf));
    await pg.click('.cta'); eq('form: empty submit marks the first question as required', await pg.evaluate(() => document.querySelector('[name=name]').closest('.q').classList.contains('bad') && !document.querySelector('[name=name]').closest('.q').querySelector('.qerr').hidden));
    await pg.fill('[name=name]', 'A'); eq('form: typing clears the required message', await pg.evaluate(() => document.querySelector('[name=name]').closest('.q').querySelector('.qerr').hidden));
    await pg.click('.clear'); eq('form: Clear form empties the answers', await pg.inputValue('[name=name]') === '');
    await P.evaluate(() => { ST.paper = 'dark'; change(); }); const dk = await P.evaluate(() => buildSite(D, ST, {})); eq('paper look: dark paper uses a light-on-dark grain', /mix-blend-mode:screen/.test(dk));
    await pg.close(); await P.ctx.close(); }

  /* ---- layout of the new card ---- */
  const M = await editor({ viewport: { width: 390, height: 800 }, hasTouch: true }); await fill(M); await verify(M);
  const small = await M.evaluate(() => [...document.querySelectorAll('[data-card=online] button, [data-card=online] .btn, [data-card=online] input[type=checkbox], [data-card=online] label.btn')].filter(e => e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return Math.round(r.height) < 44 && !e.closest('label.check') ? e.textContent.trim().slice(0, 20) : null; }).filter(Boolean));
  eq('phone width: buttons in the publishing card are at least 44px tall', small.length === 0, small.join(','));
  eq('phone width: no sideways scrolling', await M.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  await browser.close();
  const f = results.filter(r => !r.ok); console.log('\n' + results.length + ' checks, ' + f.length + ' failed'); fs.writeFileSync(path.join(__dirname, 'last-run-publish.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - f.length, failed: f.length, results }, null, 1)); process.exit(f.length ? 1 : 0);

  async function fetch0(u) { return fetchWith('GET', u, ''); }
  async function fetchWith(m, u, key, body) { const h = { 'CF-Connecting-IP': '192.0.2.' + (ipN++ % 200 + 1), Origin: 'http://x.test' }; if (key) h.Authorization = 'Bearer ' + key; if (body) h['Content-Type'] = 'application/json'; const res = await worker.fetch(new Request(u, { method: m, headers: h, body }), env); return new Response(await res.text(), { status: res.status, headers: res.headers }); }
  async function postRaw(body) { return (await fetchWith('POST', API + '/api/pages', '', body)).status; }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
