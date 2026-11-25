/* Tests for Folio's saving when the browser's storage is full. Run from the repo root:  node --no-warnings folio/tests/storage.test.cjs
   A real Chromium runs the real page. "Storage full" is simulated by making localStorage.setItem throw QuotaExceededError,
   which is what a browser does when the address's roughly 5,000 KB allowance is used up. */
const fs = require('fs'), path = require('path'); const { chromium } = require('playwright');
const APP = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const results = []; const eq = (n, c, note) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !note ? '' : '  :: ' + note)); };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1100, height: 900 } }); const errs = [];
  await ctx.addInitScript(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('full')) Storage.prototype.setItem = function () { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; };
    if (q.get('noidb')) { indexedDB.open = function () { throw new Error('IndexedDB is blocked'); }; }
  });
  const open = async (qs) => { const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route('http://x.test/**', r => r.fulfill({ body: APP, contentType: 'text/html' }));
    await p.goto('http://x.test/folio/' + (qs || '')); await p.waitForFunction('typeof D !== "undefined" && typeof renderPanel === "function"'); await wait(400); return p; };
  const setName = async (p, v) => { await p.evaluate(v => { D.name = v; change(); }, v); await wait(900); };
  const idbDraft = p => p.evaluate(() => new Promise(res => { const r = indexedDB.open('folio-store', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('draft'); g.onsuccess = () => res(g.result || null); }; r.onerror = () => res(null); }));

  // 1. normal save writes both copies
  let p = await open(); await setName(p, 'Old Name');
  const ls1 = await p.evaluate(() => JSON.parse(localStorage.getItem('folio:v1')));
  const ix1 = await idbDraft(p);
  eq('normal save: localStorage and the second copy both hold the work, with a time stamp', ls1 && ls1.D.name === 'Old Name' && ls1.at > 0 && ix1 && ix1.D.name === 'Old Name' && ix1.at === ls1.at);
  await p.close();

  // 2. localStorage full: work survives a reload, and the notice is a plain note, not an error
  p = await open('?full=1'); await setName(p, 'New Name');
  const toast = await p.locator('#toast').innerText(); const copyBtn = await p.locator('#toast .copyerr').count();
  eq('storage full: a plain note says the work went to a second place (not an error)', /second place/.test(toast) && copyBtn === 0, toast);
  await p.close();
  p = await open('?full=1');
  eq('storage full: after reload the NEW work is back, not the old', (await p.evaluate(() => D.name)) === 'New Name', await p.evaluate(() => D.name));
  eq('storage full: Folio says it restored from the second copy', /second saved copy/.test(await p.locator('#toast').innerText()));
  await p.close();

  // 3. storage full and IndexedDB blocked: an honest, copyable error
  p = await open('?full=1&noidb=1'); await setName(p, 'Third');
  const t3 = await p.locator('#toast').innerText();
  eq('both fail: the error says it could not save and has a Copy error button', /Could not save in this browser/.test(t3) && (await p.locator('#toast .copyerr').count()) === 1, t3);
  await p.close();

  // 4. a stale second copy never overwrites newer localStorage; old saves without a time stamp still load
  p = await open(); await p.evaluate(() => { localStorage.setItem('folio:v1', JSON.stringify({ D: Object.assign({}, D, { name: 'From local' }), ST, at: 5000 })); });
  await p.evaluate(() => new Promise(res => { const r = indexedDB.open('folio-store', 1); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ D: Object.assign({}, D, { name: 'Stale copy' }), ST, at: 1000 }, 'draft'); tx.oncomplete = res; }; }));
  await p.reload(); await p.waitForFunction('typeof D !== "undefined"'); await wait(500);
  eq('older second copy does not replace newer localStorage', (await p.evaluate(() => D.name)) === 'From local');
  await p.evaluate(() => { localStorage.setItem('folio:v1', JSON.stringify({ D: Object.assign({}, D, { name: 'Legacy save' }), ST })); });
  await p.evaluate(() => new Promise(res => { const r = indexedDB.open('folio-store', 1); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('draft'); tx.oncomplete = res; }; }));
  await p.reload(); await p.waitForFunction('typeof D !== "undefined"'); await wait(500);
  eq('a save from an older Folio (no time stamp) still loads', (await p.evaluate(() => D.name)) === 'Legacy save');
  await p.close();

  // 5. the private edit key gets a second copy too
  p = await open(); const api = await p.evaluate(() => PUBLISH.api);
  const key = 'k'.repeat(43), id = 'AbCdEfGhJkMn';
  await p.evaluate(({ api, id, key }) => { PUB = { id, key, api, at: 777, snap: '', saved: true }; savePub(); }, { api, id, key }); await wait(500);
  await p.evaluate(() => localStorage.removeItem('folio:v1:pub')); await p.reload(); await p.waitForFunction('typeof D !== "undefined"'); await wait(700);
  eq('edit key: restored from the second copy when localStorage lost it', await p.evaluate(() => !!PUB && PUB.id === 'AbCdEfGhJkMn' && PUB.key.length === 43));
  await p.evaluate(() => { PUB = null; savePub(); }); await wait(400);
  await p.reload(); await p.waitForFunction('typeof D !== "undefined"'); await wait(600);
  eq('edit key: forgetting it removes both copies', await p.evaluate(() => PUB === null));
  await p.close();

  // 6. storage check: groups by app, clears only PureFinds' saved store lists
  p = await open();
  await p.evaluate(() => { localStorage.setItem('pf_scan2|cotton|kotn.com', 'x'.repeat(60000)); localStorage.setItem('pf_etsy5|cotton|q', 'y'.repeat(20000)); localStorage.setItem('pf_favs', '["a"]'); localStorage.setItem('pf_ingCache2', '{"u":1}'); localStorage.setItem('jst:v1:settings', '{"app":{}}'); localStorage.setItem('petal:data', 'z'.repeat(500)); });
  await p.evaluate(() => $('#backupDialog').showModal()); await p.click('#storeCheck'); await wait(200);
  const rep = await p.locator('#storeOut').innerText();
  eq('storage check: lists PureFinds, Job Search Tracker and Petal separately', /PureFinds: 8\d(\.\d)? KB/.test(rep) && /Job Search Tracker/.test(rep) && /Petal/.test(rep) && /Folio:/.test(rep), rep.slice(0, 400));
  eq('storage check: names the largest item', /pf_scan2\|cotton\|kotn\.com/.test(rep));
  eq('storage check: offers to clear the re-downloadable store lists', (await p.locator('[data-store=free]').count()) === 1);
  await p.click('[data-store=free]'); await wait(300); await p.getByRole('button', { name: 'Clear them' }).click(); await wait(500);
  const left = await p.evaluate(() => Object.keys(localStorage).sort());
  eq('clearing removes the store lists and nothing else', !left.includes('pf_scan2|cotton|kotn.com') && !left.includes('pf_etsy5|cotton|q') && left.includes('pf_favs') && left.includes('pf_ingCache2') && left.includes('jst:v1:settings') && left.includes('petal:data') && left.includes('folio:v1'), left.join(', '));
  eq('after clearing, the report no longer offers it', (await p.locator('[data-store=free]').count()) === 0);
  await p.close();
  eq('no page errors in any test', errs.length === 0, errs.join(' | '));
  console.log('\n' + results.filter(Boolean).length + ' passed, ' + results.filter(x => !x).length + ' failed'); await b.close(); process.exit(results.every(Boolean) ? 0 : 1);
})();
