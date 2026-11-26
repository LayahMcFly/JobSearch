/* Tests for Folio's Projects section (Folio v1.4.0 with Worker 1.3.0). Run from the repo root:  node --no-warnings folio/tests/projects.test.cjs
   Real Chromium runs the real page. Its calls to the publishing service go to the REAL Worker code (SQLite stands in for D1, a Map for KV).
   Turnstile and the Vimeo player page are SIMULATED. This does not prove that Vimeo plays inside a published page: the test only proves
   Folio puts the right player address in a frame that the page allows. */
const fs = require('fs'), path = require('path'), zlib = require('zlib'), { pathToFileURL } = require('url'); const { chromium } = require('playwright'); const { makeD1 } = require('./d1-shim.cjs');
const results = []; const eq = (n, c, note) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !note ? '' : '  :: ' + note)); };
const wait = ms => new Promise(r => setTimeout(r, ms)); const MB = 1024 * 1024, MAX = 15 * MB;
const HOME = 'http://x.test/folio/', API = 'https://folio-pages.test', SITEKEY = 'TEST-SITEKEY', CFG = /const PUBLISH = \{ api: '[^']*', siteKey: '[^']*' \};/;
const APP = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(CFG, `const PUBLISH = { api: '${API}', siteKey: '${SITEKEY}' };`);
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return b => { let c = 0xFFFFFFFF; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }; })();
const png = (w, h, rgb, padTo) => { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3); const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crcT(td)); return Buffer.concat([l, td, c]); }; const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const out = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]); return padTo ? Buffer.concat([out, Buffer.alloc(padTo - out.length)]) : out; };
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const fakeKV = () => { const m = new Map(), kv = { m, async put(k, v, o) { m.set(k, { v: new Uint8Array(v), meta: (o && o.metadata) || null }); }, async get(k) { const e = m.get(k); return e ? e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength) : null; }, async getWithMetadata(k) { const e = m.get(k); return { value: e ? e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength) : null, metadata: e ? e.meta : null }; }, async delete(k) { m.delete(k); } }; return kv; };
let worker, env, seen = [], mode = {}, ipN = 10, vimeoHits = 0;
globalThis.fetch = async (url, init) => { const tok = new URLSearchParams(String(init.body)).get('response'); return new Response(JSON.stringify(tok !== 'bad-token' ? { success: true, hostname: 'x.test', action: 'folio-publish' } : { success: false }), { status: 200, headers: { 'content-type': 'application/json' } }); };
const newEnv = x => { env = Object.assign({ DB: makeD1(), MEDIA: fakeKV(), TURNSTILE_SECRET: 's', ALLOWED_ORIGIN: 'http://x.test', TURNSTILE_HOSTNAMES: 'x.test', RL_MEDIA_PAGE_HOUR: '500', RL_PUBLISH_IP_HOUR: '500', RL_PUBLISH_IP_DAY: '500', RL_UPDATE_PAGE_HOUR: '500' }, x || {}); seen = []; mode = {}; };
async function wire(ctx) {
  const ip = '198.51.100.' + (ipN++);
  await ctx.route('**/*', async r => {
    const req = r.request(), u = req.url();
    if (u.startsWith(HOME)) return r.fulfill({ body: APP, contentType: 'text/html' });
    if (u.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) return r.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={render:(el,o)=>{window.__ts=o;el.setAttribute("data-ts","1");return 7},reset:()=>{}};' });
    if (u.startsWith('https://player.vimeo.com/')) { vimeoHits++; return r.fulfill({ contentType: 'text/html', body: '<html><body>SIMULATED VIMEO PLAYER</body></html>' }); }
    if (u.startsWith(API + '/')) {
      const h = req.headers(), buf = req.postDataBuffer(), isImg = /^image\//.test(h['content-type'] || '');
      seen.push({ method: req.method(), url: u, auth: h.authorization || '', ct: h['content-type'] || '', len: buf ? buf.length : 0, body: isImg ? '' : (buf ? buf.toString() : '') });
      if (mode.network && mode.network(req.method(), u)) return r.abort();
      const hdr = { 'CF-Connecting-IP': ip }; for (const k of ['origin', 'authorization', 'content-type']) if (h[k]) hdr[k] = h[k];
      const res = await worker.fetch(new Request(u, { method: req.method(), headers: hdr, body: buf ? new Uint8Array(buf) : undefined, duplex: 'half' }), env);
      const out = {}; res.headers.forEach((v, k) => out[k] = v);
      return r.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    }
    r.abort();
  });
}
let browser; const ALLERRS = [];
async function open(ctxOpts, url) { const ctx = await browser.newContext(Object.assign({ viewport: { width: 1300, height: 1000 } }, ctxOpts || {})); await wire(ctx); const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => { p.errs.push(e.message); ALLERRS.push(e.message); }); p.ctx = ctx; await p.goto(url || HOME); await p.waitForFunction('typeof D !== "undefined" && typeof vimeoRef === "function"'); await wait(250); return p; }
const addProject = (p, o) => p.evaluate(o => { D.projects.push(Object.assign({ title: '', desc: '', url: '', video: '', image: '', alt: '' }, o)); renderPanel(); change(); }, o || {});
const openProjects = p => p.evaluate(() => { openCards.projects = true; renderPanel(); });
const choose = async (p, i, name, mime, buffer) => { await p.setInputFiles('[data-pimg="' + i + '"]', { name, mimeType: mime, buffer }); await wait(700); };
const status = (p, i) => p.locator('#pimgSt' + i).innerText();
const idbHas = (p, lid) => p.evaluate(l => new Promise(res => { const r = indexedDB.open('folio-store', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('img:' + l); g.onsuccess = () => res(!!g.result); g.onerror = () => res(false); }; r.onerror = () => res(false); }), lid);
const ready = async p => { await p.evaluate(() => { D.email = 'jordan@example-mail.com'; openCards.online = true; renderPanel(); }); await p.waitForSelector('#tsBox[data-ts]', { timeout: 5000 }); await wait(100); await p.evaluate(() => window.__ts.callback('good-token')); await p.check('#pubConsent'); };
const publish = async p => { await ready(p); await p.click('[data-pub=publish]'); await p.waitForFunction('document.querySelector("#pubLive") && /^(Published|The service|No clear|Fix|Too many|The human)/.test(document.querySelector("#pubLive").innerText)', null, { timeout: 15000 }); await wait(300); return p.locator('#pubLive').innerText(); };
const update = async p => { await p.evaluate(() => { openCards.online = true; renderPanel(); }); await wait(200); await p.click('[data-pub=update]'); await p.waitForFunction('document.querySelector("#pubLive") && /^(The service|Fix|No clear|The edit key|Too many)/.test(document.querySelector("#pubLive").innerText)', null, { timeout: 15000 }); await wait(300); return p.locator('#pubLive').innerText(); };

(async () => {
  worker = (await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'folio-pages.mjs')).href)).default; newEnv(); browser = await chromium.launch();
  let p = await open();

  /* ----- Vimeo addresses ----- */
  const vr = s => p.evaluate(s => { const r = vimeoRef(s); return r && { id: r.id, h: r.h, url: r.url, embed: r.embed }; }, s);
  const ok = async (s, id, h) => { const r = await vr(s); eq('Vimeo: ' + s, r && r.id === id && r.h === (h || '') && r.url === 'https://vimeo.com/' + id + (h ? '/' + h : ''), JSON.stringify(r)); };
  await ok('https://vimeo.com/123456789', '123456789'); await ok('vimeo.com/123456789', '123456789'); await ok('  https://www.vimeo.com/123456789  ', '123456789'); await ok('https://vimeo.com/123456789/abcdef1234', '123456789', 'abcdef1234');
  await ok('https://player.vimeo.com/video/123456789?h=ABCDEF1234&dnt=1', '123456789', 'abcdef1234'); await ok('https://vimeo.com/channels/staffpicks/123456789', '123456789'); await ok('https://vimeo.com/123456789?share=copy', '123456789');
  const emb = await vr('https://vimeo.com/123456789/abcdef1234'); eq('Vimeo: the player address carries the code and asks not to track (dnt=1)', emb.embed === 'https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1&title=0&byline=0&portrait=0', emb.embed);
  for (const s of ['https://youtube.com/watch?v=abc12345', 'https://vimeo.com/staffpicks', 'https://vimeo.com/', 'https://evilvimeo.com/123456789', 'https://vimeo.com.evil.com/123456789', 'https://evil.com/vimeo.com/123456789', 'javascript:alert(1)//vimeo.com/123456789', '123456789', '']) eq('Vimeo: rejects "' + s + '"', (await vr(s)) === null);

  /* ----- the card ----- */
  await openProjects(p); eq('Projects is a card in the editor, numbered 5, with Add a project', /5\. Projects/.test(await p.locator('details[data-card=projects] summary').innerText()) && (await p.locator('[data-add=projects]').count()) === 1);
  await p.click('[data-add=projects]'); await p.fill('[data-l=projects][data-k=title]', 'Brand voice guide'); await p.fill('[data-l=projects][data-k=video]', 'https://youtu.be/xyz');
  eq('card: a Vimeo link that is not Vimeo is explained as you type', /does not look like a Vimeo link/.test(await p.locator('#pvid0').innerText()));
  await p.fill('[data-l=projects][data-k=video]', 'https://vimeo.com/123456789'); eq('card: a good Vimeo link says which video was found', /Found Vimeo video 123456789/.test(await p.locator('#pvid0').innerText()));
  await p.fill('[data-l=projects][data-k=video]', 'https://youtu.be/xyz'); await p.evaluate(() => { D.email = 'jordan@example-mail.com'; }); const bad = await p.evaluate(() => validateExport()); eq('publishing is blocked, with a plain reason, while a Vimeo link is wrong', bad && /Brand voice guide: the Vimeo link does not look right/.test(bad.msg));
  await p.fill('[data-l=projects][data-k=video]', ''); await p.fill('[data-l=projects][data-k=url]', 'javascript:alert(1)'); const bad2 = await p.evaluate(() => validateExport()); eq('publishing is blocked while a project link is not a web address', bad2 && /must be a web address/.test(bad2.msg)); await p.fill('[data-l=projects][data-k=url]', 'example.com/work');
  eq('a link typed without https:// is accepted and saved in full', await p.evaluate(() => validateExport() === null && normData(D).projects[0].url === 'https://example.com/work'));

  /* ----- images: the 15 MB rule and file types ----- */
  const exact = png(300, 200, [20, 120, 200], MAX); eq('test file really is exactly 15 MB', exact.length === MAX);
  await choose(p, 0, 'exact.png', 'image/png', exact); let ref = await p.evaluate(() => D.projects[0].image), st = await status(p, 0);
  eq('image: exactly 15 MB is accepted and kept in the browser', /^local:[a-z0-9]{8}$/.test(ref) && /exact\.png, 15\.0 MB/.test(st) && await idbHas(p, ref.slice(6)), ref + ' | ' + st);
  const over = png(300, 200, [20, 120, 200], MAX + 1); await choose(p, 0, 'over.png', 'image/png', over);
  eq('image: one byte over 15 MB is refused, with the size and the limit, and the earlier image stays', /over\.png|That image is 15\.0 MB\. The limit is 15 MB/.test(await status(p, 0)) && (await p.evaluate(() => D.projects[0].image)) === ref && await idbHas(p, ref.slice(6)), await status(p, 0));
  await choose(p, 0, 'big.png', 'image/png', png(300, 200, [1, 2, 3], 17 * MB)); eq('image: 17 MB is refused with a way forward', /17\.0 MB\. The limit is 15 MB\. Save a smaller copy/.test(await status(p, 0)));
  await choose(p, 0, 'logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')); eq('image: SVG is refused and the reason mentions HEIC and SVG', /not a JPEG, PNG, WebP or GIF/.test(await status(p, 0)) && /HEIC/.test(await status(p, 0)));
  await choose(p, 0, 'notes.png', 'image/png', Buffer.from('this is just text pretending to be a picture '.repeat(10))); eq('image: a text file renamed .png is refused', /not a JPEG, PNG, WebP or GIF/.test(await status(p, 0)));
  await choose(p, 0, 'broken.png', 'image/png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('junk junk junk junk junk')])); eq('image: a damaged picture is refused: "could not open"', /could not open that image/.test(await status(p, 0)));
  eq('image: after all those refusals the good image is still the one in place', (await p.evaluate(() => D.projects[0].image)) === ref);
  const jpeg = Buffer.from(await p.evaluate(() => new Promise(res => { const c = document.createElement('canvas'); c.width = 80; c.height = 50; c.getContext('2d').fillRect(0, 0, 80, 50); c.toBlob(b => b.arrayBuffer().then(a => res([...new Uint8Array(a)])), 'image/jpeg'); })));
  const webp = Buffer.from(await p.evaluate(() => new Promise(res => { const c = document.createElement('canvas'); c.width = 80; c.height = 50; c.getContext('2d').fillRect(0, 0, 80, 50); c.toBlob(b => b.arrayBuffer().then(a => res([...new Uint8Array(a)])), 'image/webp'); })));
  for (const [nm, mime, buf] of [['a.jpg', 'image/jpeg', jpeg], ['a.webp', 'image/webp', webp], ['a.gif', 'image/gif', GIF], ['a.png', 'image/png', png(50, 30, [9, 9, 9])]]) { await choose(p, 0, nm, mime, buf); const t = await p.evaluate(() => D.projects[0].image); eq('image: ' + nm + ' is accepted', /^local:/.test(t) && new RegExp(nm.replace('.', '\\.')).test(await status(p, 0)), await status(p, 0)); }
  const oldLid = (await p.evaluate(() => D.projects[0].image)).slice(6); await choose(p, 0, 'next.png', 'image/png', png(50, 30, [5, 5, 5])); eq('image: choosing another one replaces it and frees the old copy', !(await idbHas(p, oldLid)) && /next\.png/.test(await status(p, 0)));
  const lid1 = (await p.evaluate(() => D.projects[0].image)).slice(6); await p.click('[data-pimgrm="0"]'); await wait(300); eq('image: Remove image clears it and frees the copy', (await p.evaluate(() => D.projects[0].image)) === '' && !(await idbHas(p, lid1)));

  /* ----- the page the visitor sees ----- */
  const site = (d, o) => p.evaluate(([d, o]) => buildSite(Object.assign({}, D, d), ST, o), [d, o || {}]);
  const P1 = { title: 'Brand voice guide', desc: 'For a software team.', url: 'https://example.com/work', video: 'https://vimeo.com/123456789/abcdef1234', image: 'AbCdEfGhJkMn', alt: 'Cover of the guide' };
  let h = await site({ projects: [P1] }, { viewer: true });
  eq('page: has a Projects section, a Projects link in the top bar, and the card', /<section class="work no-print" id="work">/.test(h) && /<a class="alt" href="#work">Projects<\/a>/.test(h) && /<article class="proj">/.test(h));
  eq('page: the published image comes from the Folio service and opens full size in a new tab', h.includes(`<img src="${API}/api/media/AbCdEfGhJkMn"`) === false ? false : /target="_blank" rel="noopener noreferrer" aria-label="Open the full image of Brand voice guide"/.test(h) || /class="pm vid"/.test(h));
  eq('page: a project with a video shows a Play button and a "Watch on Vimeo" link, and nothing is loaded from Vimeo until Play', /class="play"/.test(h) && /Watch on Vimeo/.test(h) && !/<iframe/.test(h.split('<script')[0]) && /data-embed="https:\/\/player\.vimeo\.com\/video\/123456789\?h=abcdef1234/.test(h));
  const csp = s => (s.match(/Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
  eq('page: the viewer\'s security rules allow images from the Folio service and frames from player.vimeo.com, and nothing else new', /img-src data: https:\/\/folio-pages\.test;/.test(csp(h)) && /frame-src https:\/\/player\.vimeo\.com/.test(csp(h)) && /default-src 'none'/.test(csp(h)));
  const h2 = await site({ projects: [{ title: 'Text only', desc: 'No media.', url: '', video: '', image: '', alt: '' }] }, { viewer: true });
  eq('page: with no images or videos the rules stay as tight as before (no frame-src, images only from data:)', !/frame-src/.test(csp(h2)) && /img-src data:;/.test(csp(h2)));
  const h3 = await site({ projects: [{ title: 'Only image', desc: '', url: '', video: '', image: 'AbCdEfGhJkMn', alt: '' }] }, { viewer: true }); eq('page: an image alone adds the service to img-src but no frame-src', /img-src data: https:\/\/folio-pages\.test;/.test(csp(h3)) && !/frame-src/.test(csp(h3)));
  const hostile = await site({ projects: [{ title: '<img src=x onerror=alert(1)>', desc: '"><script>alert(2)</script>', url: 'javascript:alert(3)', video: 'https://vimeo.com/123456789"onload="alert(4)', image: 'local:abcd1234', alt: '' }] }, { viewer: true });
  eq('page: hostile text is escaped, a javascript: link is dropped, an invalid Vimeo address is ignored, a browser-only picture is ignored', !/<img src=x/.test(hostile.split('<section class="work')[1] || '') && !/<script>alert/.test(hostile) && !/javascript:alert\(3\)/.test(hostile) && !/class="pm vid"/.test(hostile) && /&lt;img src=x onerror/.test(hostile));
  eq('page: an empty project is not shown, and neither is the section or the top-bar link', !/id="work"/.test(await site({ projects: [{ title: '', desc: '', url: '', video: '', image: '', alt: '' }] }, { viewer: true })) && !/href="#work"/.test(await site({ projects: [] }, { viewer: true })));
  eq('page: the resume PDF/print version never includes projects', !/id="work"/.test(await site({ projects: [P1] }, { resumeOnly: true })));
  eq('page: with no projects the page is as it was (no Projects link, hire-me link still there)', /<a class="go" href="#hire">/.test(await site({ projects: [] }, { viewer: true })));

  /* ----- all six layouts and dark paper: nothing runs off the screen ----- */
  const three = [P1, { title: 'Local picture', desc: 'x '.repeat(80), url: '', video: '', image: 'local:abcd1234', alt: '' }, { title: 'Text only project with a very long title that has to wrap onto lines', desc: 'Short.', url: 'https://example.com', video: '', image: '', alt: '' }];
  await p.evaluate(() => { WEB_THUMBS.abcd1234 = 'data:image/png;base64,' + btoa(String.fromCharCode(...new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))); });
  for (const lay of ['modern', 'classic', 'minimal', 'bold', 'compact', 'elegant']) for (const paper of ['white', 'dark']) {
    const html = await p.evaluate(([lay, paper, three]) => buildSite(Object.assign({}, D, { projects: three }), Object.assign({}, ST, { layout: lay, paper }), { preview: true }), [lay, paper, three]);
    const q = await open({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }); await q.setContent('<iframe id="f" style="width:390px;height:800px;border:0"></iframe>'); await q.evaluate(h => { document.getElementById('f').srcdoc = h; }, html); await wait(500);
    const m = await q.frames()[1].evaluate(() => { const r = document.querySelector('.projs').getBoundingClientRect(), cards = [...document.querySelectorAll('.proj')].map(c => c.getBoundingClientRect()); return { wide: document.documentElement.scrollWidth > innerWidth + 1, inside: cards.every(c => c.left >= -0.5 && c.right <= innerWidth + 0.5), n: cards.length, linkH: Math.min(...[...document.querySelectorAll('.pl a')].map(a => a.getBoundingClientRect().height)) }; });
    eq('layout ' + lay + '/' + paper + ': phone width, no sideways scroll, 3 cards inside the screen, links 44px tall', !m.wide && m.inside && m.n === 3 && m.linkH >= 43.5, JSON.stringify(m)); await q.ctx.close();
  }

  /* ----- publishing images, end to end through the real Worker ----- */
  const A = png(300, 200, [200, 90, 60]), B = png(300, 200, [10, 90, 200], MAX), C = png(60, 40, [30, 160, 60]);
  const media = () => seen.filter(c => c.method === 'PUT' && /\/media$/.test(c.url)), pageCalls = m => seen.filter(c => c.method === m && /\/api\/pages(\/[^/]+)?$/.test(c.url));
  newEnv(); p = await open(); await openProjects(p);
  await addProject(p, { title: 'One', desc: 'First.' }); await addProject(p, { title: 'Two', url: 'https://example.com/two' }); await addProject(p, { title: 'Three', video: 'https://vimeo.com/123456789' }); await openProjects(p);
  await choose(p, 0, 'one.png', 'image/png', A); await choose(p, 1, 'two.png', 'image/png', B);
  const lids = await p.evaluate(() => D.projects.map(x => (x.image || '').slice(6))); let msg = await publish(p); const key = await p.evaluate(() => PUB.key), pid = await p.evaluate(() => PUB.id);
  eq('publish with images: says published and that 2 images were uploaded', /^Published\./.test(msg) && /2 images uploaded\./.test(msg), msg);
  const post = pageCalls('POST')[0], pb = JSON.parse(post.body);
  eq('publish with images: the first request to create the page carries no browser-only image references', !/local:/.test(post.body) && pb.data.D.projects.every(x => x.image === '') && pb.data.D.projects.length === 3);
  eq('publish with images: each image went to the new page with the new edit key, the right type and the exact size (one is exactly 15 MB)', media().length === 2 && media().every(c => c.auth === 'Bearer ' + key && c.ct === 'image/png' && c.url === API + '/api/pages/' + pid + '/media') && media()[0].len === A.length && media()[1].len === B.length, JSON.stringify(media().map(c => [c.len, c.ct])));
  const put = pageCalls('PUT').pop(), pj = JSON.parse(put.body).data.D.projects;
  eq('publish with images: the page is then updated with the real image ids (and none for the text-only project)', /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(pj[0].image) && /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(pj[1].image) && pj[2].image === '' && pj[1].url === 'https://example.com/two' && pj[2].video === 'https://vimeo.com/123456789' && !/local:/.test(put.body), put.body.slice(0, 200));
  eq('publish with images: the editor now holds the real ids, the browser copies are freed, and it says everything is published', await p.evaluate(() => D.projects.every(x => !/^local:/.test(x.image))) && !(await idbHas(p, lids[0])) && !(await idbHas(p, lids[1])) && /matches what is in Folio/.test(await p.locator('#pubDirty').innerText()));
  eq('publish with images: the Worker holds both images and lists them against the page', env.MEDIA.m.size === 2 && (await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE page_id = ?1').bind(pid).first()).n === 2);
  const V = await open(null, HOME + '?id=' + pid); await V.waitForSelector('#viewFrame:not([hidden])', { timeout: 8000 }); await wait(1500); const vf = V.frames().find(f => f.url() === 'about:srcdoc');
  const vi = await vf.evaluate(() => ({ cards: document.querySelectorAll('.proj').length, imgs: [...document.querySelectorAll('.pm img')].map(i => [i.complete, i.naturalWidth]), alt: document.querySelector('.pm img') && document.querySelector('.pm img').alt, link: !!document.querySelector('a.pm[target=_blank]') }));
  eq('visitor: the public page shows 3 projects and both pictures load from the Folio service (the page\'s security rules allow it)', vi.cards === 3 && vi.imgs.length === 2 && vi.imgs.every(x => x[0] && x[1] === 300), JSON.stringify(vi));
  await vf.click('.play'); await V.waitForTimeout(800); const hits0 = vimeoHits;
  const vf2 = await vf.evaluate(() => { const f = document.querySelector('.vid iframe'); return f ? { src: f.src, allow: f.getAttribute('allow'), title: f.title } : null; });
  eq('visitor: pressing Play puts the Vimeo player (with autoplay) in the card, and the frame is allowed to load it', vf2 && /^https:\/\/player\.vimeo\.com\/video\/123456789\?.*autoplay=1$/.test(vf2.src) && /fullscreen/.test(vf2.allow) && hits0 >= 1, JSON.stringify(vf2) + ' hits ' + hits0);
  await V.ctx.close();

  /* update: text only sends no images; removing a project's picture and updating cleans up on the Worker */
  seen.length = 0; await p.evaluate(() => { D.projects[2].desc = 'Edited.'; change(); }); msg = await update(p);
  eq('update with only text changes: no image is uploaded again', /^The service confirmed/.test(msg) && media().length === 0 && pageCalls('PUT').length === 1, msg);
  const firstId = await p.evaluate(() => D.projects[0].image); await p.evaluate(() => { D.projects[0].image = ''; change(); }); await env.DB.prepare('UPDATE media SET created_at = created_at - 5000').run(); await update(p);
  eq('update after removing a picture: the Worker deletes the unused image from storage (the other stays)', !env.MEDIA.m.has(firstId) && env.MEDIA.m.size === 1);
  await p.ctx.close();

  /* image storage not turned on, then turned on */
  newEnv({ MEDIA: undefined }); p = await open(); await openProjects(p); await addProject(p, { title: 'Solo' }); await openProjects(p); await wait(500);
  eq('card: when the service has no image storage, the card says so and how to connect it (without hiding other fields)', /not turned on for your Folio service/.test(await p.locator('#mediaNote').innerText()) && /MEDIA/.test(await p.locator('#mediaNote').innerText()));
  await choose(p, 0, 'solo.png', 'image/png', A); msg = await publish(p);
  eq('storage off: the page is still published, and the message names the problem, the project and what to do', /^Published\./.test(msg) && /1 image was not uploaded: "Solo": Image storage is not turned on/.test(msg) && /press Update published page/.test(msg), msg);
  eq('storage off: the picture stays in the browser, the service got none, and Folio says there is more to publish', await p.evaluate(() => /^local:/.test(D.projects[0].image)) && !/local:/.test(pageCalls('PUT').pop().body) && /not published yet/.test(await p.locator('#pubDirty').innerText()));
  env.MEDIA = fakeKV(); seen.length = 0; msg = await update(p);
  eq('storage turned on later: Update uploads the waiting picture and finishes', /1 image uploaded\./.test(msg) && media().length === 1 && await p.evaluate(() => /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(D.projects[0].image)) && /matches what is in Folio/.test(await p.locator('#pubDirty').innerText()), msg);
  await p.ctx.close();
  newEnv(); p = await open(); await openProjects(p); await wait(400); eq('card: with image storage on there is no warning', (await p.locator('#mediaNote').innerText()) === ''); await p.ctx.close();

  /* one picture fails and the other still goes through */
  newEnv(); p = await open(); await addProject(p, { title: 'Flaky' }); await addProject(p, { title: 'Steady' }); await openProjects(p); await choose(p, 0, 'f.png', 'image/png', A); await choose(p, 1, 's.png', 'image/png', C);
  let n = 0; mode.network = (m, u) => /\/media$/.test(u) && ++n === 1; msg = await publish(p);
  eq('one upload fails: the message names that project and the reason, and the other picture is uploaded', /1 image uploaded\./.test(msg) && /1 image was not uploaded: "Flaky": No answer from the service/.test(msg), msg);
  eq('one upload fails: the page shows only the good picture, the failed one waits in the browser', await p.evaluate(() => /^local:/.test(D.projects[0].image) && /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(D.projects[1].image)) && JSON.parse(pageCalls('PUT').pop().body).data.D.projects.map(x => x.image.length).join() === '0,12');
  mode.network = null; msg = await update(p); eq('one upload fails: pressing Update again uploads the one that failed', /1 image uploaded\./.test(msg) && await p.evaluate(() => D.projects.every(x => /^[2-9A-HJ-NP-Za-km-z]{12}$/.test(x.image))), msg); await p.ctx.close();

  /* a picture survives a reload and is still uploaded */
  newEnv(); p = await open(); await addProject(p, { title: 'Reload me' }); await openProjects(p); await choose(p, 0, 'keep.png', 'image/png', A); await wait(500); await p.reload(); await p.waitForFunction('typeof D !== "undefined" && typeof loadLocalImages === "function"'); await wait(800); await openProjects(p); await wait(300);
  eq('reload: the picture is still there, with its name and a preview', /keep\.png/.test(await status(p, 0)) && (await p.locator('.pthumb').count()) === 1 && await p.evaluate(() => /^local:/.test(D.projects[0].image)));
  msg = await publish(p); eq('reload: after the reload the picture still uploads (the file was kept in the browser)', /1 image uploaded\./.test(msg) && media().length === 1 && media()[0].len === A.length, msg);
  await p.ctx.close();

  /* removing a project frees its picture; backups and downloads */
  newEnv(); p = await open(); await addProject(p, { title: 'Gone soon' }); await addProject(p, { title: 'Stays' }); await openProjects(p); await choose(p, 0, 'g.png', 'image/png', A); await choose(p, 1, 's.png', 'image/png', C);
  const l0 = (await p.evaluate(() => D.projects[0].image)).slice(6); await p.click('[data-rm="projects:0"]'); await p.waitForSelector('dialog[open] button', { timeout: 3000 }).catch(() => {}); await p.evaluate(() => { const d = document.querySelector('dialog[open]'); if (d) { const b = [...d.querySelectorAll('button')].find(x => /Remove/.test(x.textContent)); if (b) b.click(); } }); await wait(500);
  eq('removing a project also frees its picture in the browser', (await p.evaluate(() => D.projects.length)) === 1 && !(await idbHas(p, l0)));
  await p.evaluate(() => { document.getElementById('backupDialog').showModal(); }); const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#backupBtn')]); const bk = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  eq('backup: pictures that are not published are left out (reference and description cleared), the rest of the project stays, and the dialog says so', bk.D.projects.length === 1 && bk.D.projects[0].image === '' && bk.D.projects[0].title === 'Stays' && /not part of a backup/.test(await p.locator('#backupDialog').innerText()));
  await p.evaluate(() => document.getElementById('backupDialog').close()); await p.evaluate(() => { document.getElementById('siteDialog'); });
  const htmlLocal = await p.evaluate(() => buildSite(D, ST)); eq('download: a picture not yet published is included as a small embedded copy', /<img src="data:image\/jpeg;base64,/.test(htmlLocal) && !/folio-pages\.test\/api\/media/.test(htmlLocal));
  const htmlPub = await p.evaluate(() => buildSite(Object.assign({}, D, { projects: [Object.assign({}, D.projects[0], { image: 'AbCdEfGhJkMn' })] }), ST)); eq('download: a published picture loads from the Folio service', htmlPub.includes('<img src="' + API + '/api/media/AbCdEfGhJkMn"') && !/Content-Security-Policy/.test(htmlPub));
  eq('data from an older Folio or Worker (no projects at all) loads as an empty list', await p.evaluate(() => { const o = normData({ name: 'x', experience: [] }); return Array.isArray(o.projects) && o.projects.length === 0; })); await p.ctx.close();

  /* phone: touch size and spacing in the open Projects card */
  newEnv(); { const mp = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await addProject(mp, { title: 'Phone check', desc: 'Words.', video: 'https://vimeo.com/123456789' }); await openProjects(mp); await choose(mp, 0, 'm.png', 'image/png', A); await wait(300);
    const q = await mp.evaluate(() => { const els = [...document.querySelectorAll('details[data-card=projects] button, details[data-card=projects] textarea, details[data-card=projects] label.btn, details[data-card=projects] input:not([type=file])')].filter(e => e.getBoundingClientRect().width > 0); const R = els.map(e => ({ e, r: e.getBoundingClientRect() })), small = R.filter(x => x.r.height < 43.5 || x.r.width < 43.5).map(x => x.e.getAttribute('data-k') || x.e.textContent.trim().slice(0, 16)), tight = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i], c = R[j]; if (a.e.contains(c.e) || c.e.contains(a.e)) continue; const dx = Math.max(a.r.left - c.r.right, c.r.left - a.r.right), dy = Math.max(a.r.top - c.r.bottom, c.r.top - a.r.bottom); if (dx < 0 && dy < 0) continue; const g = dx < 0 ? dy : dy < 0 ? dx : Math.hypot(dx, dy); if (g < 7.5) tight.push((a.e.getAttribute('data-k') || a.e.textContent.trim().slice(0, 14)) + ' | ' + (c.e.getAttribute('data-k') || c.e.textContent.trim().slice(0, 14)) + ' ' + Math.round(g) + 'px'); }
      return { n: els.length, small, tight, wide: document.documentElement.scrollWidth > innerWidth + 1 }; });
    eq('phone: every control in the Projects card is at least 44px tall and wide (' + q.n + ' controls)', q.small.length === 0, q.small.join('; ')); eq('phone: at least 8px between neighbouring controls, and no sideways scroll', q.tight.length === 0 && !q.wide, q.tight.join('; ')); await mp.ctx.close(); }
  eq('no page errors in any test', ALLERRS.length === 0, ALLERRS.join(' | '));
  console.log('\n' + results.filter(Boolean).length + ' passed, ' + results.filter(x => !x).length + ' failed'); await browser.close(); process.exit(results.every(Boolean) ? 0 : 1);
})();
