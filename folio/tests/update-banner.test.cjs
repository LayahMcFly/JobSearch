/* New-version banner tests for Folio and the Hub. Run: node --no-warnings folio/tests/update-banner.test.cjs
   The "published" page is simulated: the version check receives a copy of the file with a different version. */
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const results = []; const eq = (n, c, note) => { results.push({ n, ok: !!c }); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  :: ' + (note || ''))); };
const root = path.join(__dirname, '..', '..');
const apps = [
  { name: 'Folio', file: 'folio/index.html', url: 'http://x.test/folio/', varName: 'APP_VERSION' },
  { name: 'Hub', file: 'hub/index.html', url: 'http://x.test/hub/', varName: 'HUB_VERSION' },
  { name: 'Job Search', file: 'index.html', url: 'http://x.test/js/', varName: 'APP_VERSION' }
];
(async () => {
  const browser = await chromium.launch();
  for (const a of apps) {
    const html = fs.readFileSync(path.join(root, a.file), 'utf8'); const cur = new RegExp("const " + a.varName + " = '(v[\\d.]+)'").exec(html)[1];
    const bump = v => v.replace(/(\d+)$/, n => String(Number(n) + 1)); const newer = bump(cur);
    let published = html, checks = 0, served = html, navs = [];
    const open = async (extra, qs) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
      await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(a.url)) { if (/versioncheck=/.test(u)) { checks++; return r.fulfill({ body: published, contentType: 'text/html' }); } navs.push(u); return r.fulfill({ body: served, contentType: 'text/html' }); } r.abort(); });
      const p = await ctx.newPage(); p.ctx = ctx; await p.goto(a.url + (qs || '')); await p.waitForTimeout(700); return p;
    };
    let p = await open(); eq(a.name + ': same version published, no banner', await p.isHidden('#updateBanner') && checks >= 1, 'checks=' + checks); await p.ctx.close();
    published = html.replace("const " + a.varName + " = '" + cur + "'", "const " + a.varName + " = '" + newer + "'");
    p = await open(); eq(a.name + ': newer version published, banner names both versions', await p.isVisible('#updateBanner') && (await p.textContent('#updateBanner')).includes(newer) && (await p.textContent('#updateBanner')).includes(cur), await p.textContent('#updateBanner'));
    const small = await p.evaluate(() => [...document.querySelectorAll('#updateBanner button')].map(b => Math.round(b.getBoundingClientRect().height)));
    eq(a.name + ': banner buttons are at least 44px tall and fit the phone width' + (a.name === 'Job Search' ? ' (tracker keeps its own small-button style: width only)' : ''), small.length === 2 && (a.name === 'Job Search' || small.every(h => h >= 44)) && await p.evaluate(() => document.querySelector('#updateBanner').getBoundingClientRect().right <= innerWidth), small.join());
    await p.click('#updateLaterBtn'); eq(a.name + ': Later hides the banner', await p.isHidden('#updateBanner'));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(500); eq(a.name + ': Later is remembered for this session', await p.isHidden('#updateBanner')); await p.ctx.close();
    p = await open(); const nav = p.waitForURL(u => /\?v=/.test(u.toString()), { timeout: 3000 }).catch(() => 0); await p.click('#updateNowBtn'); await nav; eq(a.name + ': Update now reloads the page with ?v=<new version>', p.url().includes('?v=' + newer), p.url()); await p.ctx.close();
    published = html.replace("const " + a.varName + " = '" + cur + "'", "const " + a.varName + " = '" + cur.replace(/\d+\.(\d+)$/, '0.$1') + "'");
    p = await open(); eq(a.name + ': an older published version shows no banner', await p.isHidden('#updateBanner')); await p.ctx.close();

    /* stale browser copy: pressing Update now still gives the OLD page. The banner must say so and keep offering Reload again until the newest version shows. */
    published = html.replace("const " + a.varName + " = '" + cur + "'", "const " + a.varName + " = '" + newer + "'"); served = html; navs = [];
    p = await open(); await p.click('#updateNowBtn'); await p.waitForURL(u => /\?v=/.test(u.toString()), { timeout: 4000 }).catch(() => 0); await p.waitForTimeout(900);
    const t1 = (await p.textContent('#updateBanner')) || '';
    eq(a.name + ': Update now URL is cache-busting (?v=<new>&_=<time>)', /\?v=[^&]+&_=\d+/.test(p.url()), p.url());
    eq(a.name + ': stale copy after Update now -> banner says "Still showing <old>" and offers Reload again', await p.isVisible('#updateBanner') && t1.includes('Still showing ' + cur) && t1.includes(newer) && (await p.textContent('#updateNowBtn')).trim() === 'Reload again' && await p.isHidden('#updateLaterBtn').catch(() => true), t1);
    const u1 = p.url(); await p.click('#updateNowBtn'); await p.waitForURL(u => u.toString() !== u1, { timeout: 4000 }).catch(() => 0); await p.waitForTimeout(900);
    eq(a.name + ': still stale -> still asks to reload again, with a fresh cache-busting URL', p.url() !== u1 && /Still showing/.test((await p.textContent('#updateBanner')) || '') && await p.isVisible('#updateBanner'), p.url());
    served = published; const u2 = p.url(); await p.click('#updateNowBtn'); await p.waitForURL(u => u.toString() !== u2, { timeout: 4000 }).catch(() => 0); await p.waitForTimeout(1200);
    eq(a.name + ': newest version loads -> banner gone and the ?v=&_= parameters removed from the address', await p.isHidden('#updateBanner') && !/[?&]v=/.test(p.url()) && !/[?&]_=/.test(p.url()), p.url());
    await p.ctx.close(); served = html;
    if (a.name === 'Folio') { published = html.replace("const APP_VERSION = '" + cur + "'", "const APP_VERSION = '" + newer + "'"); checks = 0; p = await open(); await p.ctx.close(); const before = checks; p = await open('', '?id=222222222222'); eq('Folio: the shared-page viewer makes no version check and shows no banner', checks === before && await p.isHidden('#updateBanner'), 'checks ' + before + '->' + checks); await p.ctx.close(); }
  }
  await browser.close(); const f = results.filter(r => !r.ok); console.log('\n' + results.length + ' checks, ' + f.length + ' failed'); process.exit(f.length ? 1 : 0);
})().catch(e => { console.error('HARNESS', e); process.exit(2); });
