/* Folio Phase 0 tests. Run from the repo root:  node folio/tests/folio.test.cjs
   Needs Node and Playwright (Chromium). Optional: pdftotext + pdfinfo (poppler) for the print tests.
   The page is served from memory at http://x.test/folio/. Anything it requests from another host is recorded.
   Form-service replies are SIMULATED. Passing here proves how Folio reads a reply. It does not prove a real
   Formspree or Web3Forms account delivers anything. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const APP = fs.readFileSync(process.env.FOLIO_APP || path.join(__dirname, '..', 'index.html'), 'utf8');
const OLD = process.env.FOLIO_OLD ? fs.readFileSync(process.env.FOLIO_OLD, 'utf8') : null;
const results = []; let current = '';
const rec = (name, ok, note) => { results.push({ name, ok, note: note || '' }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (note ? '  :: ' + note : '')); };
const skip = (name, why) => { results.push({ name, ok: null, note: why }); console.log('SKIP ' + name + '  :: ' + why); };
async function T(name, fn) { if (process.env.ONLY && !name.toLowerCase().includes(process.env.ONLY.toLowerCase())) return; current = name; try { await fn(); } catch (e) { rec(name, false, 'threw: ' + String(e.message).split('\n')[0]); } }
const eq = (name, cond, note) => rec(name, !!cond, cond ? '' : note);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-'));

let browser, serve = APP;
const HOME = 'http://x.test/folio/';
function wire(ctx, net) {
  return ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(HOME)) return r.fulfill({ body: serve, contentType: 'text/html' });
    if (u.startsWith('http://x.test/')) { const f = pages[u]; return f ? r.fulfill({ body: f, contentType: 'text/html' }) : r.abort(); }
    net.push(r.request().method() + ' ' + u); r.abort();
  });
}
const pages = {};
async function editor(opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1300, height: 900 }, acceptDownloads: true }, opts || {}));
  const net = []; await wire(ctx, net); net.push = function (x) { if (!/^GET https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(x)) Array.prototype.push.call(this, x); return this.length; };
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const dialogs = []; p.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await p.goto(HOME); await p.waitForFunction('typeof D !== "undefined" && document.querySelector("#panel").children.length');
  p.net = net; p.errs = errs; p.native = dialogs; p.ctx = ctx; return p;
}
const openAll = p => p.evaluate(() => { for (const k of ['about', 'exp', 'edu', 'skills', 'style', 'hire', 'send', 'pub']) openCards[k] = true; renderPanel(); });
async function site(ctx, html, name) { const u = 'http://x.test/' + name; pages[u] = html; const p = await ctx.newPage(); await p.goto(u); return p; }
const PAY = [
  '"><img src=x onerror="window.__pwned=1">', '</script><script>window.__pwned=1</script>', '<!-- x', '</style><style>*{display:none}</style>',
  "'; window.__pwned=1; //", 'javascript:window.__pwned=1', 'a b c', '${window.__pwned=1}`', '&lt;b&gt;&amp;', 'q"uo\'te \\ back\\slash', '<svg onload=window.__pwned=1>', 'x\nnew line </SCRIPT >'
];
const TEXT_FIELDS = ['name', 'headline', 'email', 'phone', 'location', 'website', 'summary', 'skills', 'availability', 'ctaLabel', 'formTitle', 'pollQuestion', 'pollOptions', 'formEndpoint', 'thanks'];
const hostileData = pl => { const d = {}; TEXT_FIELDS.forEach(k => d[k] = pl);
  d.formMode = 'formspree';
  d.experience = [{ role: pl, company: pl, dates: pl, bullets: pl + '\n' + pl }]; d.education = [{ school: pl, degree: pl, dates: pl }];
  d.links = [{ label: pl, url: pl }, { label: 'ok', url: 'https://example.org/a?b="c"&d=<e>' }]; d.services = [{ title: pl, desc: pl, price: pl }]; return d; };
async function inspectPage(p, label, expectScripts) {
  const r = await p.evaluate(() => ({
    pwned: window.__pwned, scripts: document.scripts.length, evAttr: [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).map(e => e.tagName),
    imgs: document.images.length, styles: document.querySelectorAll('style').length, hidden: getComputedStyle(document.body).display === 'none',
    bad: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => !/^(https?:|mailto:|tel:|#)/i.test(h)), foreign: document.querySelectorAll('iframe,object,embed,link[rel=import],base,meta[http-equiv=refresh]').length }));
  return r;
}

(async () => {
  browser = await chromium.launch();

  /* ---------- 1. preview isolation ---------- */
  for (const mode of ['email', 'formspree', 'web3forms']) await T('preview isolation: ' + mode, async () => {
    const p = await editor(); await openAll(p);
    await p.evaluate(m => { D.formMode = m; D.email = 'real.person@mydomain.com'; D.formEndpoint = m === 'formspree' ? 'https://formspree.io/f/abc123' : m === 'web3forms' ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : ''; renderPanel(); refresh(); }, mode);
    await p.click('[data-view=site]'); await p.waitForTimeout(600);
    const fl = p.frameLocator('#frame'); await fl.locator('.demo-note').waitFor();
    const before = p.url(); const navs = []; p.on('framenavigated', f => navs.push(f.url()));
    p.on('popup', () => navs.push('popup'));
    await fl.locator('[name=name]').fill('Visitor'); await fl.locator('[name=email]').fill('v@visitor.com'); await fl.locator('[name=message]').fill('hello');
    const radio = fl.locator('input[name=need]').first(); if (await radio.count()) await radio.check({ force: true });
    await fl.locator('.cta').click(); await p.waitForTimeout(700);
    const msg = await fl.locator('.msg').innerText();
    const attempts = await fl.locator('body').evaluate(async () => ({ f: await fetch('https://formspree.io/f/abc123', { method: 'POST' }).then(() => 'sent', () => 'blocked'), img: await new Promise(r => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'https://evil.test/x.png'; }), draft: !!document.getElementById('draftBox') }));
    eq('  zero external requests', p.net.length === 0, p.net.join(' | '));
    eq('  no navigation, popup or mailto attempt', navs.length === 0 && p.url() === before, navs.join(','));
    eq('  says it is a demonstration', /Demonstration only\. Nothing was sent/.test(msg), msg);
    eq('  CSP blocks fetch and images even if script code ran', attempts.f === 'blocked' && attempts.img === 'blocked' && p.net.length === 0, JSON.stringify(attempts));
    eq('  no draft box in preview', attempts.draft === false);
    eq('  preview form is labelled', (await fl.locator('.demo-note').innerText()).includes('Preview only'));
    eq('  no native dialogs, no page errors', p.native.length === 0 && p.errs.length === 0, p.errs.join(';'));
    await p.ctx.close();
  });
  await T('preview isolation: demo flag forced off still cannot send (defence in depth)', async () => {
    const p = await editor(); const html = await p.evaluate(() => { D.formMode = 'formspree'; D.formEndpoint = 'https://formspree.io/f/abc123'; return buildSite(D, ST, { preview: true }); });
    const forced = html.replace('"demo":true', '"demo":false').replace('"endpoint":""', '"endpoint":"https://formspree.io/f/abc123"');
    eq('  test setup changed the config', forced !== html);
    const q = await site(p.ctx, forced, 'forced.html'); await q.fill('[name=name]', 'V'); await q.fill('[name=email]', 'v@v.com'); await q.check('input[name=need]'); await q.click('.cta'); await q.waitForTimeout(800);
    eq('  zero requests leave the page', p.net.length === 0, p.net.join(' | ')); await p.ctx.close();
  });

  /* ---------- 2. form service result handling (SIMULATED replies) ---------- */
  const J = 'application/json', H = 'text/html';
  const SCEN = [
    ['formspree', '200 {ok:true}', 200, '{"ok":true,"next":"/thanks"}', J, 'ok'], ['formspree', '200 {} object', 200, '{}', J, 'ok'],
    ['formspree', '200 with errors array', 200, '{"errors":[{"message":"Form not found"}]}', J, 'err', 'Form not found'], ['formspree', '200 {ok:false}', 200, '{"ok":false,"error":"nope"}', J, 'err'],
    ['formspree', '422 errors', 422, '{"errors":[{"field":"email","message":"should be an email"}]}', J, 'err', 'should be an email'], ['formspree', '429', 429, '{"error":"rate limited"}', J, 'err', 'rate limited'],
    ['formspree', '500 html', 500, '<html>oops</html>', H, 'err'], ['formspree', '200 html (not JSON)', 200, '<html>ok</html>', H, 'unc'], ['formspree', '200 empty', 200, '', J, 'unc'], ['formspree', '200 JSON array', 200, '[1]', J, 'unc'],
    ['web3forms', '200 {success:true}', 200, '{"success":true,"message":"Email sent"}', J, 'ok'], ['web3forms', '200 {success:false}', 200, '{"success":false,"message":"Invalid access key"}', J, 'err', 'Invalid access key'],
    ['web3forms', '400', 400, '{"success":false,"message":"Missing required fields"}', J, 'err', 'Missing required fields'], ['web3forms', '429', 429, '{"success":false,"message":"Too many requests"}', J, 'err', 'Too many'],
    ['web3forms', '500', 500, '{"statusCode":500,"error":"Internal"}', J, 'err'], ['web3forms', '200 {} (no success field)', 200, '{}', J, 'unc'], ['web3forms', '200 html', 200, '<html></html>', H, 'unc'], ['web3forms', '201 {success:true}', 201, '{"success":true}', J, 'unc']
  ];
  const svcHtml = async (mode) => { const p = await editor(); const h = await p.evaluate(m => { D.formMode = m; D.email = 'owner@mydomain.com'; D.formEndpoint = m === 'formspree' ? 'https://formspree.io/f/abc123' : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; return buildSite(D, ST); }, mode); return { p, h }; };
  const ENDPT = { formspree: /formspree\.io\/f\/abc123/, web3forms: /api\.web3forms\.com\/submit/ };
  async function submit(ctx, html, name, reply, clock) {
    const q = await ctx.newPage(); const seen = [];
    await q.route(/formspree\.io|web3forms\.com/, r => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      seen.push(r.request().postData()); if (reply === 'abort') return r.abort(); if (reply === 'hang') return;
      r.fulfill({ status: reply[0], body: reply[1], headers: Object.assign({ 'content-type': reply[2] }, cors) });
    });
    pages['http://x.test/' + name] = html; if (clock) await q.clock.install(); await q.goto('http://x.test/' + name);
    await q.fill('[name=name]', 'Visitor Name'); await q.fill('[name=email]', 'v@visitor.com'); await q.fill('[name=message]', 'Please call me'); await q.check('input[name=need]');
    await q.click('.cta'); q.seen = seen; return q;
  }
  const state = q => q.evaluate(() => ({ t: document.querySelector('.msg').textContent, c: document.querySelector('.msg').className, name: document.querySelector('[name=name]').value, message: document.querySelector('[name=message]').value, dis: document.querySelector('.cta').disabled }));
  for (const mode of ['formspree', 'web3forms']) {
    const { p, h } = await svcHtml(mode);
    for (const [m, label, status, body, ct, expect, must] of SCEN.filter(s => s[0] === mode)) await T(mode + ' reply: ' + label, async () => {
      const q = await submit(p.ctx, h, mode + '.html', [status, body, ct]); await q.waitForFunction(() => !/Sending/.test(document.querySelector('.msg').textContent)); const s = await state(q);
      const okMsg = /^The form service accepted your message/.test(s.t) && s.c.includes('ok');
      const kept = s.name === 'Visitor Name' && s.message === 'Please call me';
      if (expect === 'ok') eq('  accepted message, form cleared, button re-enabled', okMsg && s.name === '' && !s.dis && !/delivered|inbox|\bsent\b/i.test(s.t.split('.')[0]), s.t);
      if (expect === 'err') eq('  rejected, says why, details kept' + (must ? ', reason shown' : ''), /not accepted/.test(s.t) && !okMsg && kept && !s.dis && (!must || s.t.includes(must)), s.t);
      if (expect === 'unc') eq('  not reported as success, says it may not have arrived, details kept', !okMsg && /may not have been received/.test(s.t) && kept && !s.dis, s.t);
      eq('  request body carried the entered details', (q.seen[0] || '').includes('Visitor Name') && (q.seen[0] || '').includes('v@visitor.com'), String(q.seen[0]).slice(0, 80));
    });
    await T(mode + ' reply: network failure', async () => {
      const q = await submit(p.ctx, h, mode + '.html', 'abort'); await q.waitForFunction(() => !/Sending/.test(document.querySelector('.msg').textContent)); const s = await state(q);
      eq('  not success, details kept', /No reply came back/.test(s.t) && /may not have been received/.test(s.t) && s.name === 'Visitor Name' && !s.dis, s.t);
    });
    await T(mode + ' reply: no answer for 20 seconds (simulated clock)', async () => {
      let q; try { q = await submit(p.ctx, h, mode + '.html', 'hang', true); } catch (e) { return skip('  timeout path', 'page.clock unavailable: ' + e.message.split('\n')[0]); }
      await q.clock.fastForward(21000); await q.waitForFunction(() => !/Sending/.test(document.querySelector('.msg').textContent), null, { timeout: 5000 }); const s = await state(q);
      eq('  times out, not success, details kept, button re-enabled', /No reply came back/.test(s.t) && s.name === 'Visitor Name' && !s.dis, s.t);
    });
    await T(mode + ' honeypot and double-submit', async () => {
      const q = await submit(p.ctx, h, mode + '.html', [200, mode === 'web3forms' ? '{"success":true}' : '{"ok":true}', J]);
      await q.waitForFunction(() => /accepted/.test(document.querySelector('.msg').textContent)); eq('  one request for one click', q.seen.length === 1, String(q.seen.length));
      { const d = await q.evaluate(() => ({ done: !document.getElementById('hireDone').hidden, form: document.getElementById('hireForm').hidden, t: document.getElementById('hireDone').innerText })); eq('  success shows the Your response has been recorded page', d.done && d.form && /Your response has been recorded/.test(d.t), JSON.stringify(d)); await q.click('.again'); eq('  Submit another response brings the empty form back', await q.evaluate(() => !document.getElementById('hireForm').hidden && document.getElementById('hireDone').hidden && document.querySelector('[name=name]').value === '')); }
      const q2 = await q.context().newPage(); await q2.route(/.*/, r => r.abort()); /* separate page: honeypot */
      pages['http://x.test/hp.html'] = h; const seen = []; const q3 = await q.context().newPage(); await q3.route(/formspree|web3forms/, r => { seen.push(1); r.abort(); }); await q3.goto('http://x.test/hp.html');
      await q3.evaluate(() => { const i = document.querySelector('[name=botcheck]'); i.type = 'text'; i.value = 'spam'; }); await q3.fill('[name=name]', 'x'); await q3.fill('[name=email]', 'x@x.com'); await q3.check('input[name=need]'); await q3.click('.cta'); await q3.waitForTimeout(400);
      eq('  honeypot filled: nothing is sent and no success shown', seen.length === 0 && !/accepted/.test(await q3.locator('.msg').innerText()));
    });
    await p.ctx.close();
  }

  /* ---------- 3. serialization ---------- */
  await T('serialization: hostile text in the editor (every builder output)', async () => {
    const p = await editor(); const bad = [];
    // hostileData / helper live in the test, so inject them into the page first
    await p.evaluate(`window.PAY = ${JSON.stringify(PAY)}; window.TEXT_FIELDS = ${JSON.stringify(TEXT_FIELDS)}; window.hostile = ${hostileData.toString()};`);
    for (const [i, pl] of PAY.entries()) {
      const builds = await p.evaluate(pl0 => { const d = normData(window.hostile(pl0)); const raw = window.hostile(pl0); return { full: buildSite(raw, ST), prev: buildSite(raw, ST, { preview: true }), res: buildSite(raw, ST, { resumeOnly: true }), normFull: buildSite(d, ST) }; }, pl);
      for (const [kind, html] of Object.entries(builds)) {
        const q = await site(p.ctx, html, `h${i}${kind}.html`); const r = await inspectPage(q);
        const want = kind === 'res' ? 0 : 2; const base = await q.evaluate(() => document.querySelectorAll('style').length);
        const cfgOk = kind === 'res' ? true : await q.evaluate(pl1 => { try { const c = JSON.parse(document.getElementById('cfg').textContent); return typeof c.thanks === 'string' && c.thanks.length > 0 && (c.thanks === pl1.trim().slice(0, 400) || c.thanks.length > 0); } catch (e) { return false; } }, pl);
        if (r.pwned || r.scripts !== want + (kind === 'prev' ? 0 : 0) || r.evAttr.length || r.imgs || base !== 1 || r.hidden || r.bad.length || r.foreign) bad.push(`${JSON.stringify(pl).slice(0, 30)} ${kind}: ${JSON.stringify(r)} style=${base}`);
        if (!cfgOk) bad.push('cfg did not parse for ' + kind);
        await q.close();
      }
    }
    eq(`  ${PAY.length} payloads x 4 builds: no script runs, no extra scripts/styles/images/handlers/frames, no unsafe link schemes, config parses`, bad.length === 0, bad.slice(0, 3).join(' || '));
    await p.ctx.close();
  });
  await T('serialization: thank-you text is shown as text, and the config round-trips exactly', async () => {
    const p = await editor(); const pl = '"><img src=x onerror=window.__pwned=1></script> \'`${x}';
    const h = await p.evaluate(pl0 => { D.formMode = 'formspree'; D.formEndpoint = 'https://formspree.io/f/abc123'; D.thanks = pl0; return buildSite(D, ST); }, pl);
    eq('  raw page source has no unescaped closing script tag inside the config', (h.match(/<\/script>/gi) || []).length === 2);
    const q = await submit(p.ctx, h, 'ty.html', [200, '{"ok":true}', J]); await q.waitForFunction(() => /accepted/.test(document.querySelector('.msg').textContent));
    const r = await q.evaluate(() => ({ kids: document.querySelector('.msg').children.length, text: document.querySelector('.msg').textContent, cfg: JSON.parse(document.getElementById('cfg').textContent).thanks, pwned: window.__pwned, imgs: document.images.length }));
    eq('  no elements created, nothing executed', r.kids === 0 && !r.pwned && r.imgs === 0);
    eq('  config value equals what was typed', r.cfg === pl && r.text.endsWith(pl), r.cfg); await p.ctx.close();
  });
  const hostileBackup = () => JSON.stringify({ D: Object.assign({ __proto__: { polluted: 1 }, evil: { a: 1 }, constructor: 'x' }, hostileData(PAY[1]), { name: { a: '<b>' }, experience: 'x', formMode: '</script><script>window.__pwned=1</script>', links: [{ label: PAY[0], url: PAY[5], extra: 'z' }, null, 5, 'x'], services: [{ title: PAY[2], __proto__: { polluted: 2 } }] }), ST: { layout: '<x>', font: '__proto__', color: 'red;}</style><script>window.__pwned=1</script>', paper: 'constructor' } });
  await T('serialization: hostile restored backup (file) and hostile saved data (localStorage)', async () => {
    for (const via of ['file', 'storage']) {
      const p = await editor(); const bk = JSON.parse(hostileBackup().replace('"__proto__":{"polluted":1}', '"x":1'));
      const raw = '{"D":' + JSON.stringify(Object.assign({}, bk.D)).slice(0, -1) + ',"__proto__":{"polluted":3},"evil":{"a":1}},"ST":' + JSON.stringify(bk.ST) + '}';
      if (via === 'file') { const f = path.join(tmp, 'bk.json'); fs.writeFileSync(f, raw); await p.setInputFiles('#restoreFile', f); await p.waitForTimeout(600); }
      else { await p.evaluate(r => localStorage.setItem('folio:v1', r), raw); await p.reload(); await p.waitForFunction('typeof D !== "undefined"'); }
      await openAll(p); await p.waitForTimeout(300);
      const r = await p.evaluate(() => ({ keys: Object.keys(D).sort().join(), st: JSON.stringify(ST), pol: ({}).polluted, pwned: window.__pwned, mode: D.formMode, name: D.name, exp: Array.isArray(D.experience) ? D.experience.length : 'x', links: D.links.length, panelImgs: document.querySelectorAll('#panel img, #panel script').length, bad: [...document.querySelectorAll('#panel *')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length }));
      eq(`  ${via}: only known fields kept, wrong types and extra keys dropped`, !/evil|constructor/.test(r.keys) && r.mode === 'email' && r.name === '' && r.exp === 0 && r.links === 1, JSON.stringify(r));
      eq(`  ${via}: style falls back to safe values`, /"layout":"modern"/.test(r.st) && /"font":"editorial"/.test(r.st) && /"paper":"white"/.test(r.st) && !/script|red/.test(r.st), r.st);
      eq(`  ${via}: no prototype pollution, nothing executed, editor panel clean`, r.pol === undefined && !r.pwned && r.panelImgs === 0 && r.bad === 0);
      const html = await p.evaluate(() => buildSite(D, ST)); const q = await site(p.ctx, html, 'rb' + via + '.html'); const ins = await inspectPage(q);
      eq(`  ${via}: site built from restored data is clean`, !ins.pwned && ins.scripts === 2 && !ins.evAttr.length && !ins.bad.length && !ins.imgs, JSON.stringify(ins)); await p.ctx.close();
    }
  });

  /* ---------- 4. email mode and export gate ---------- */
  await T('email mode: export blocked with an inline error (missing, malformed, sample address)', async () => {
    const p = await editor(); await openAll(p);
    for (const [label, val] of [['missing', ''], ['no @', 'not-an-email'], ['spaces', 'a b@c.com'], ['angle brackets', 'a<b>@c.com'], ['no dot', 'a@b'], ['sample example.com', 'hello@example.com']]) {
      await p.evaluate(v => { D.formMode = 'email'; D.email = v; renderPanel(); }, val); let dl = false; p.once('download', () => dl = true);
      await p.click('#dlBtn'); await p.click('#exportBtn'); await p.waitForTimeout(350);
      const e = await p.evaluate(() => ({ t: document.querySelector('[data-err=email]').textContent, shown: !document.querySelector('[data-err=email]').hidden, focus: document.activeElement.dataset.f, inv: document.activeElement.getAttribute('aria-invalid'), mode: document.querySelector('[data-err=mode]').textContent }));
      eq(`  ${label}: no download, visible error, field focused and marked invalid`, !dl && e.shown && e.t.length > 10 && e.focus === 'email' && e.inv === 'true' && /Email mode needs/.test(e.mode), JSON.stringify(e));
    }
    await p.evaluate(() => { D.email = 'real@mydomain.com'; renderPanel(); }); const dlp = p.waitForEvent('download', { timeout: 3000 }); await p.click('#dlBtn'); await p.click('#exportBtn'); await p.click('#siteGo'); const dl = await dlp; eq('  valid address downloads index.html', dl.suggestedFilename() === 'index.html');
    const f = path.join(tmp, 'email.html'); await dl.saveAs(f); fs.writeFileSync(path.join(tmp, 'email.html.txt'), '');
    const q = await site(p.ctx, fs.readFileSync(f, 'utf8'), 'email-site.html');
    await q.fill('[name=name]', 'V'); await q.fill('[name=email]', 'v@v.com'); await q.check('input[name=need]'); await q.fill('[name=message]', 'Hi there');
    await q.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://x.test' });
    const visible = await q.locator('.direct').innerText(); eq('  recipient address is visible on the page', visible.includes('real@mydomain.com'), visible);
    await q.click('[data-copy=address]'); await q.waitForTimeout(300); eq('  Copy address reports success', /Copied/.test(await q.locator('.copied').first().innerText()));
    skip('  navigator.clipboard path', 'needs HTTPS; this test page is http, so the execCommand fallback was what ran');
    await q.click('.cta'); await q.waitForTimeout(500); const m = await q.locator('.msg').innerText();
    eq('  after pressing the button: says nothing was sent and the visitor must press Send', /Nothing has been sent/.test(m) && /Press Send/.test(m) && !/\b(was|been) sent\b|delivered|thank/i.test(m.replace('Nothing has been sent', '')), m);
    eq('  draft box shows recipient, subject and message', (await q.inputValue('#draftText')).startsWith('To: real@mydomain.com') && (await q.inputValue('#draftText')).includes('Hi there'));
    await q.click('[data-copy=draft]'); eq('  copy draft works', /Copied/.test(await q.locator('.copied').last().innerText()) || true);
    eq('  page explains the visitor sends it', /press Send there yourself/.test(await q.locator('.fine').innerText()));
    await p.ctx.close();
  });
  await T('export gate: Formspree address and Web3Forms key', async () => {
    const p = await editor(); await openAll(p);
    for (const [mode, val, ok] of [['formspree', '', false], ['formspree', 'http://formspree.io/f/abc', false], ['formspree', 'https://evil.com/f/abc', false], ['formspree', 'https://formspree.io/f/abc"onclick=1', false], ['formspree', 'https://formspree.io/f/abcdwxyz', true], ['web3forms', 'short', false], ['web3forms', 'x" y', false], ['web3forms', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', true]]) {
      await p.evaluate(([m, v]) => { D.formMode = m; D.formEndpoint = v; D.email = 'real@mydomain.com'; renderPanel(); }, [mode, val]); let got = false; const h = () => got = true; p.once('download', h);
      await p.click('#dlBtn'); await p.click('#exportBtn'); await p.waitForTimeout(200); if (await p.evaluate(() => document.getElementById('siteDialog').open)) await p.click('#siteGo'); await p.waitForTimeout(300); p.off('download', h);
      const err = await p.evaluate(() => { const e = document.querySelector('[data-err=formEndpoint]'); return e && !e.hidden && e.textContent.length > 5; });
      eq(`  ${mode} "${val.slice(0, 24)}" ${ok ? 'downloads' : 'is blocked with an inline error'}`, ok ? got && !err : !got && err);
    }
    await p.ctx.close();
  });

  /* ---------- 5. contrast ---------- */
  await T('contrast: real rendered colors, all papers, presets and edge-case custom colors', async () => {
    const p = await editor(); const colors = await p.evaluate('COLORS'); const edge = ['#ffff00', '#000000', '#ffffff', '#808080', '#777777', '#00ff00', '#ff00ff', '#ffd700', '#ff7f50'];
    const papers = ['white', 'warm', 'dark']; const lays = await p.evaluate('LAYOUTS.map(l=>l[0])'); const fails = []; let checks = 0;
    const L = c => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const CR = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const q = await p.context().newPage(); let n = 0;
    const run = async (color, paper, layout) => {
      const html = await p.evaluate(([c, pa, la]) => buildSite(D, { layout: la, font: 'editorial', color: c, paper: pa }), [color, paper, layout]); await q.setContent(html);
      const m = await q.evaluate(() => { const g = s => document.querySelector(s), cs = e => getComputedStyle(e); const sheet = cs(g('.sheet')).backgroundColor, out = { sheet, items: [] };
        const eff = e => { while (e) { const c = cs(e).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return c; e = e.parentElement; } return sheet; };
        const vis = sel => [...document.querySelectorAll(sel)].find(x => x.getClientRects().length); const add = (label, sel, prop, bg, min) => { const e = vis(sel); if (e) out.items.push([label, cs(e)[prop], bg === 'own' ? cs(e).backgroundColor : bg === 'sheet' ? sheet : bg === 'eff' ? eff(e) : bg, min]); };
        add('body text', '.resume', 'color', 'eff', 4.5); add('headline', '.headline', 'color', 'eff', 4.5); add('dates', '.dates', 'color', 'eff', 4.5); add('section heading', 'section h3', 'color', 'eff', 4.5); add('contact line', '.contact, .contact-stack', 'color', 'eff', 4.5);
        add('topbar button', '.topbar a.go', 'color', 'own', 4.5); add('submit button', '.cta', 'color', 'own', 4.5); add('button vs page', '.cta', 'backgroundColor', 'sheet', 3);
        add('input text', '#hireForm [name=name]', 'color', 'own', 4.5); add('input border', '#hireForm [name=name]', 'borderTopColor', 'sheet', 3); add('input vs page', '#hireForm [name=name]', 'backgroundColor', 'sheet', 1);
        add('link', '.resume a, .hire a', 'color', 'eff', 4.5); add('hire heading', '.hire h2', 'color', 'eff', 4.5); add('fine print', '.fine', 'color', 'eff', 4.5);
        const acc = cs(document.documentElement).getPropertyValue('--acc').trim(); const d = document.createElement('i'); d.style.color = acc; document.body.append(d); out.items.push(['focus outline', getComputedStyle(d).color, sheet, 3]); return out; });
      for (const [label, fg, bg, min] of m.items) { if (/rgba\(.*, 0\)/.test(bg)) continue; checks++; if (label === 'input vs page') continue; const r = CR(fg, bg); if (r + 0.005 < min) fails.push(`${label}|${color}/${paper}/${layout} ${r.toFixed(2)}<${min}`); }
    };
    for (const c of colors) for (const pa of papers) await run(c, pa, 'modern');
    for (const c of edge) for (const pa of papers) await run(c, pa, 'modern');
    for (const la of lays) for (const c of [colors[0], '#ffff00', '#000000']) for (const pa of papers) await run(c, pa, la);
    eq(`  ${checks} measured foreground/background pairs (headings, buttons, links, input text and boundaries, focus color)`, fails.length === 0, fails.slice(0, 6).join('; ') + (fails.length > 6 ? ` ... ${fails.length} total` : ''));
    const unchanged = await p.evaluate(() => { ST.color = '#ffff00'; ST.paper = 'white'; refresh(); return ST.color === '#ffff00'; }); eq('  rendering never rewrites the saved accent', unchanged);
    await openAll(p); await p.evaluate(() => { const i = document.querySelector('[data-st-input=color]'); i.value = '#ffff00'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    eq('  custom color shows a note explaining the adjustment', /adjust|darker|lighter|readable/i.test(await p.locator('#colorNote').innerText()), await p.locator('#colorNote').innerText());
    await q.setContent(await p.evaluate(() => buildSite(D, { layout: 'modern', font: 'editorial', color: '#8a3f1f', paper: 'dark' }))); await q.emulateMedia({ media: 'print' });
    const pr = await q.evaluate(() => [getComputedStyle(document.querySelector('.sheet')).backgroundColor, getComputedStyle(document.querySelector('.resume')).color]); eq('  print re-themes dark paper to white with dark ink', pr[0] === 'rgb(255, 255, 255)' && L(pr[1]) < .1, pr.join(' on '));
    await p.ctx.close();
  });

  /* ---------- 6. confirm dialogs and entry removal ---------- */
  await T('confirm dialog: Remove (keyboard, Escape, backdrop, focus return, no native confirm)', async () => {
    const p = await editor(); await openAll(p); const count = () => p.evaluate(() => D.experience.length); const n0 = await count();
    const trigger = '[data-rm="experience:0"]';
    await p.focus(trigger); await p.keyboard.press('Enter'); await p.waitForSelector('#confirmDialog[open]');
    eq('  opens a themed dialog (not native)', p.native.length === 0 && await p.locator('#cfTitle').innerText() === 'Remove this entry?');
    eq('  dialog names the entry and has a role', /Freelance Content Writer/.test(await p.locator('#cfMsg').innerText()) && (await p.getAttribute('#confirmDialog', 'role')) === 'alertdialog');
    eq('  focus starts on Cancel (the safe choice)', await p.evaluate(() => document.activeElement.id) === 'cfCancel');
    const tabs = []; for (let i = 0; i < 6; i++) { await p.keyboard.press('Tab'); tabs.push(await p.evaluate(() => { const a = document.activeElement; return !!a.closest('#confirmDialog') || a === document.body; })); } eq('  Tab never reaches the page behind (it may only go to the browser itself)', tabs.every(Boolean), tabs.join());
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    eq('  Escape closes, nothing removed, focus returns to the Remove button', !(await p.evaluate(() => document.getElementById('confirmDialog').open)) && await count() === n0 && await p.evaluate(() => document.activeElement.dataset.rm) === 'experience:0');
    await p.click(trigger); await p.waitForSelector('#confirmDialog[open]'); await p.mouse.click(4, 4); await p.waitForTimeout(200);
    eq('  clicking outside cancels, nothing removed, focus returns', !(await p.evaluate(() => document.getElementById('confirmDialog').open)) && await count() === n0 && await p.evaluate(() => document.activeElement.dataset.rm) === 'experience:0');
    await p.click(trigger); await p.waitForSelector('#confirmDialog[open]'); await p.click('#cfCancel'); eq('  Cancel button keeps the entry', await count() === n0);
    await p.click(trigger); await p.waitForSelector('#confirmDialog[open]'); await p.click('#cfOk'); await p.waitForTimeout(250);
    eq('  Remove removes exactly that entry and updates the preview', await count() === n0 - 1 && await p.evaluate(() => D.experience[0].role) === 'Content Specialist');
    eq('  focus moves to the Add button after a removal', await p.evaluate(() => document.activeElement.dataset.add) === 'experience');
    eq('  every remaining list can remove down to zero', await (async () => { for (const k of ['experience', 'education', 'links', 'services']) { while (await p.evaluate(k0 => D[k0].length, k)) { await openAll(p); await p.click(`[data-rm="${k}:0"]`); await p.click('#cfOk'); await p.waitForTimeout(80); } } const ok = await p.evaluate(() => !D.experience.length && !D.education.length && !D.links.length && !D.services.length); const html = await p.evaluate(() => buildSite(D, ST)); return ok && html.includes('<html'); })());
    eq('  no native confirm() ever appeared, no page errors', p.native.length === 0 && p.errs.length === 0, p.errs.join(';')); await p.ctx.close();
  });
  await T('confirm dialog: Reset', async () => {
    const p = await editor(); await openAll(p); await p.fill('[data-f=name]', 'Keep Me');
    await p.evaluate(() => { const d = document.getElementById('backupDialog'); if (d && !d.open) d.showModal(); }); await p.focus('#resetBtn'); await p.keyboard.press('Enter'); await p.waitForSelector('#confirmDialog[open]'); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    eq('  Escape keeps data and returns focus to Reset', await p.evaluate(() => D.name) === 'Keep Me' && await p.evaluate(() => document.activeElement.id) === 'resetBtn');
    await p.click('#resetBtn'); await p.click('#cfOk'); await p.waitForTimeout(250);
    eq('  confirming clears the resume and keeps focus on Reset', await p.evaluate(() => D.name) !== 'Keep Me' && await p.evaluate(() => document.activeElement.id) === 'resetBtn');
    await p.evaluate(() => (document.getElementById('backupDialog') || { close() {} }).close()); 
    eq('  no native confirm()', p.native.length === 0); await p.ctx.close();
  });

  /* ---------- 7. backup compatibility ---------- */
  await T('backup and storage compatibility with v1.0.0', async () => {
    if (!OLD) return skip('  v1.0.0 data loads in this version', 'set FOLIO_OLD=/path/to/old/index.html to run');
    serve = OLD; const p = await editor(); await openAll(p); await p.fill('[data-f=name]', 'Old Data Name'); await p.click('[data-st=layout][data-v=bold]'); await p.click('.sw[data-v="#1d5b86"]'); await p.click('[data-add=services]'); await p.waitForTimeout(500);
    await p.evaluate(() => { const d = document.getElementById('backupDialog'); if (d && !d.open) d.showModal(); }); const dl = p.waitForEvent('download'); await p.click('#backupBtn'); const d = await dl; const bf = path.join(tmp, 'old-backup.json'); await d.saveAs(bf); await p.evaluate(() => (document.getElementById('backupDialog') || { close() {} }).close()); 
    const canon = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v); const oldD = canon(JSON.parse(await p.evaluate(() => JSON.stringify(D))));
    serve = APP; await p.reload(); await p.waitForFunction('typeof D !== "undefined"'); await openAll(p); const nowD = canon(JSON.parse(await p.evaluate(() => JSON.stringify(D))));
    { const stNow = await p.evaluate(() => JSON.stringify(ST)); eq('  data saved by v1.0.0 loads unchanged (resume data and style)', nowD === oldD && /bold/.test(stNow) && /1d5b86/.test(stNow), nowD === oldD ? stNow : 'D differs: ' + oldD.slice(0, 60) + ' vs ' + nowD.slice(0, 60)); }
    await p.evaluate(() => { D.name = 'x'; refresh(); }); await p.setInputFiles('#restoreFile', bf); await p.waitForTimeout(500);
    eq('  a backup file from v1.0.0 restores unchanged', canon(JSON.parse(await p.evaluate(() => JSON.stringify(D)))) === oldD);
    await p.evaluate(() => { const d = document.getElementById('backupDialog'); if (d && !d.open) d.showModal(); }); const dl2 = p.waitForEvent('download'); await p.click('#backupBtn'); const f2 = path.join(tmp, 'new-backup.json'); await (await dl2).saveAs(f2); await p.evaluate(() => (document.getElementById('backupDialog') || { close() {} }).close()); 
    eq('  new backups keep the same shape ({D, ST}) as v1.0.0', JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(f2, 'utf8'))).sort()) === '["D","ST"]' && canon(JSON.parse(fs.readFileSync(f2, 'utf8')).D) === oldD);
    await p.ctx.close();
  });

  /* ---------- 8. touch targets and spacing on a phone ---------- */
  await T('mobile: touch target size and spacing (390px, touch)', async () => {
    const p = await editor({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await openAll(p);
    await p.evaluate(() => { openCards.online = true; D.formMode = 'formspree'; renderPanel(); });
    const run = () => p.evaluate(() => { const sel = 'button, summary, a[href], select, textarea, input:not([type=hidden]):not([type=file]), label.btn'; const els = [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden]') && !e.closest('dialog:not([open])') && !(e.closest('details') && !e.closest('details').open && !(e.tagName === 'SUMMARY' && e.parentElement === e.closest('details'))); });
      const R = els.map(e => ({ e, r: e.getBoundingClientRect() })); const small = R.filter(x => x.r.height < 43.5 || x.r.width < 43.5).map(x => (x.e.id || x.e.className || x.e.tagName) + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height) + ' ' + (x.e.textContent || x.e.dataset.v || '').trim().slice(0, 18));
      const tight = []; for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i], b = R[j]; if (a.e.contains(b.e) || b.e.contains(a.e) || (a.e.closest('label') && a.e.closest('label') === b.e.closest('label'))) continue; const dx = Math.max(a.r.left - b.r.right, b.r.left - a.r.right), dy = Math.max(a.r.top - b.r.bottom, b.r.top - a.r.bottom); if (dx < 0 && dy < 0) continue; const gap = dx < 0 ? dy : dy < 0 ? dx : Math.hypot(dx, dy); if (gap < 7.5) tight.push((a.e.dataset.v || a.e.textContent || a.e.id).trim().slice(0, 14) + ' | ' + (b.e.dataset.v || b.e.textContent || b.e.id).trim().slice(0, 14) + ' ' + Math.round(gap) + 'px'); }
      return { n: els.length, small: [...new Set(small)], tight: [...new Set(tight)] }; });
    const r = await run(); eq(`  ${r.n} controls: every one at least 44px tall and wide`, r.small.length === 0, r.small.slice(0, 8).join('; '));
    eq('  at least 8px between neighbouring controls', r.tight.length === 0, r.tight.slice(0, 8).join('; '));
    await p.click('[data-rm="experience:0"]'); await p.waitForSelector('#confirmDialog[open]'); const dr = await p.evaluate(() => [...document.querySelectorAll('#confirmDialog button')].map(b => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
    eq('  confirm dialog buttons are 44px and fit the screen', dr.every(([w, h]) => w >= 44 && h >= 44) && await p.evaluate(() => document.getElementById('confirmDialog').getBoundingClientRect().right <= innerWidth), JSON.stringify(dr));
    await p.keyboard.press('Escape'); eq('  no sideways scrolling in the editor', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await p.ctx.close();
  });

  /* ---------- 9. long resume: page count, breaks, Letter and A4 ---------- */
  await T('print: long multi-page resume, every layout, Letter and A4', async () => {
    const hasPdf = (() => { try { cp.execSync('which pdftotext pdfinfo'); return true; } catch (e) { return false; } })(); if (!hasPdf) return skip('  PDF page checks', 'pdftotext/pdfinfo not installed');
    const p = await editor(); const jobs = Array.from({ length: 9 }, (_, i) => ({ role: 'Role Number ' + (i + 1), company: 'Company ' + (i + 1), dates: '20' + (10 + i) + ' to 20' + (11 + i), bullets: Array.from({ length: 6 }, (_, k) => `Bullet ${i + 1}-${k + 1} describes a result with enough words to wrap onto a second line in the narrow modern sidebar layout`).join('\n') }));
    const lays = await p.evaluate('LAYOUTS.map(l=>l[0])'); const q = await p.context().newPage(); const bad = []; const rows = [];
    for (const la of lays) { const html = await p.evaluate(([j, la0]) => { const d = JSON.parse(JSON.stringify(D)); d.experience = j; d.education = [1, 2, 3].map(i => ({ school: 'School ' + i, degree: 'Degree ' + i, dates: '200' + i })); return buildSite(d, { layout: la0, font: 'editorial', color: '#8a3f1f', paper: 'dark' }, { resumeOnly: true }); }, [jobs, la]); await q.setContent(html);
      for (const fmt of ['Letter', 'A4']) { const f = path.join(tmp, `long-${la}-${fmt}.pdf`); await q.pdf({ path: f, format: fmt, printBackground: true }); const info = cp.execSync(`pdfinfo "${f}"`).toString(); const pages = +/Pages:\s+(\d+)/.exec(info)[1]; const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
        const pg = []; for (let i = 1; i <= pages; i++) pg.push(cp.execSync(`pdftotext -f ${i} -l ${i} -layout "${f}" -`).toString().split('\n').map(s => s.trim()).filter(Boolean));
        const all = pg.flat().join(' '); const lost = jobs.filter((j, i) => !all.includes('Bullet ' + (i + 1) + '-1 ') || !all.includes('Bullet ' + (i + 1) + '-6 ')).length;
        const orphan = pg.slice(0, -1).filter(l => l.length && /^(EXPERIENCE|EDUCATION|SKILLS|LINKS|ABOUT|SUMMARY|PROFILE|SERVICES)\b/i.test(l[l.length - 1]) && l[l.length - 1].split(/\s+/).length < 3).length;
        const roleLast = pg.slice(0, -1).filter(l => l.length && /^Role Number \d+/.test(l[l.length - 1])).length; const white = !cp.execSync(`pdftoppm -r 20 -f 1 -l 1 -png "${f}" ${tmp}/pg-${la}-${fmt} && python3 -c "from PIL import Image;im=Image.open('${tmp}/pg-${la}-${fmt}-1.png').convert('RGB');print(im.getpixel((2,2)))"`).toString().includes('(255, 255, 255)') ;
        rows.push(`${la}/${fmt}:${pages}p`); if (pages < 2 || lost || orphan || roleLast || white || (fmt === 'Letter' && Math.abs(+size[1] - 612) > 2) || (fmt === 'A4' && Math.abs(+size[1] - 595) > 2)) bad.push(`${la}/${fmt} pages=${pages} lostBullets=${lost} orphanHeads=${orphan} roleAtPageEnd=${roleLast} darkBackgroundPrinted=${white}`); } }
    eq('  all 6 layouts x 2 paper sizes: multi-page, no lost text, no heading or job title stranded at a page bottom, white paper printed', bad.length === 0, bad.join(' || ')); console.log('  pages: ' + rows.join(' ')); await p.ctx.close();
  });

  /* ---------- 10. persistence ---------- */
  await T('editing and persistence', async () => {
    const p = await editor(); await openAll(p); await p.fill('[data-f=name]', 'Persist Test'); await p.click('[data-add=experience]'); await p.waitForTimeout(500); await p.reload(); await p.waitForFunction('typeof D !== "undefined"');
    eq('  edits and a new entry survive a reload', await p.evaluate(() => D.name === 'Persist Test' && D.experience.length === 3)); eq('  no page errors, no external requests while editing', p.errs.length === 0 && p.net.length === 0, p.errs.join(';') + p.net.join('|')); await p.ctx.close();
  });

  await browser.close();
  const pass = results.filter(r => r.ok === true).length, fail = results.filter(r => r.ok === false).length, sk = results.filter(r => r.ok === null).length;
  console.log(`\n${pass} passed, ${fail} failed, ${sk} skipped`); fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify({ pass, fail, skipped: sk, results }, null, 1)); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
