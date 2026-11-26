/* Tests for Folio's Import a resume. Run from the repo root:  PDFJS_DIR=/path/to/pdfjs-dist/build node --no-warnings folio/tests/import.test.cjs
   PDFJS_DIR is a folder holding pdf.min.js and pdf.worker.min.js of pdfjs-dist 3.11.174 (npm install pdfjs-dist@3.11.174). Without it the PDF tests are skipped.
   Real Chromium runs the real page against real PDF, Word and text files in folio/tests/fixtures (made by make_fixtures.py, fictional person).
   Claude and the human check are SIMULATED, so the AI path proves Folio's side only, not that a real Claude key works. */
const fs = require('fs'), path = require('path'); const { chromium } = require('playwright');
const APP = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), FX = path.join(__dirname, 'fixtures'), PDFJS = process.env.PDFJS_DIR || '';
const results = []; const eq = (n, c, note) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !note ? '' : '  :: ' + note)); };
const skip = n => console.log('SKIP ' + n + '  :: set PDFJS_DIR to run');
const wait = ms => new Promise(r => setTimeout(r, ms)); const fx = n => path.join(FX, n);
(async () => {
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } }); const errs = [];
  let ai = { status: 200, json: null }, aiBodies = [];
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/*', r => { const f = r.request().url().split('/').pop(); if (PDFJS && fs.existsSync(path.join(PDFJS, f))) r.fulfill({ body: fs.readFileSync(path.join(PDFJS, f)), contentType: 'text/javascript' }); else r.abort(); });
  await ctx.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={render(el,o){window.__ts=o;el.dataset.ts="1";return 1},reset(){window.__tsReset=(window.__tsReset||0)+1}}' }));
  const open = async () => { const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route('http://x.test/**', r => r.fulfill({ body: APP.replace(/const PUBLISH = \{ api: '[^']*', siteKey: '[^']*' \};/, "const PUBLISH = { api: 'https://folio-pages.test', siteKey: 'TESTKEY' };"), contentType: 'text/html' }));
    await p.route('https://folio-pages.test/api/ai', r => { aiBodies.push(JSON.parse(r.request().postData())); r.fulfill({ status: ai.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(ai.json || {}) }); });
    await p.goto('http://x.test/folio/'); await p.waitForFunction('typeof readResumeFile === "function" && typeof D !== "undefined"'); await wait(300); return p; };
  const read = (p, name, bytes) => p.evaluate(async ({ name, bytes }) => { const f = new File([new Uint8Array(bytes)], name, { type: '' }); try { return { text: await readResumeFile(f) }; } catch (e) { return { err: String((e && e.message) || e) }; } }, { name, bytes: [...bytes] });
  const parse = (p, t) => p.evaluate(t => parseResume(t), t);
  let p = await open();

  /* ----- reading files ----- */
  const texts = {};
  for (const f of ['resume-classic.txt', 'resume-classic.pdf', 'resume-sidebar.pdf', 'resume-modern.docx', 'resume-older.txt']) {
    if (/\.pdf$/.test(f) && !PDFJS) { skip('read ' + f); continue; }
    const r = await read(p, f, fs.readFileSync(fx(f))); texts[f] = r.text;
    eq('read ' + f, r.text && /Jordan Ellis/i.test(r.text) && /Content Writer/.test(r.text), r.err);
  }
  eq('sidebar PDF: the column with the name is read first', !PDFJS || /^Jordan Ellis\nContent Strategist/.test(texts['resume-sidebar.pdf'] || ''));
  eq('Word file: bullets, the tab before dates and the education table survive', /• Led a six-person/.test(texts['resume-modern.docx']) && /Jan 2021 – Present/.test(texts['resume-modern.docx']) && /2010 – 2014/.test(texts['resume-modern.docx']));
  const bad = async (name, bytes, rx, label) => { const r = await read(p, name, Buffer.from(bytes)); eq(label, r.err && rx.test(r.err), r.err || 'no error'); };
  await bad('old.doc', 'x'.repeat(200), /\.doc.*cannot be read/i, 'old .doc: says to save as .docx or PDF');
  await bad('photo.jpg', 'x'.repeat(200), /Photos and scans/, 'photo: explains it cannot be read');
  await bad('resume.pages', 'x'.repeat(200), /not supported/, 'unknown type: says what is supported');
  await bad('empty.txt', '', /empty/, 'empty file: says so');
  await bad('short.txt', 'hello', /No text was found/, 'almost no text: says so');
  await bad('fake.docx', 'this is not a zip file at all, just words to fill the space here', /does not look like a Word/, 'fake .docx: says it is not Word');
  if (PDFJS) {
    await bad('broken.pdf', 'not a pdf '.repeat(30), /could not be opened/, 'broken PDF: says it could not be opened');
    const sc = await read(p, 'scan-no-text.pdf', fs.readFileSync(fx('scan-no-text.pdf'))); eq('scanned PDF (no text): explains and suggests a way out', /no text Folio can read/.test(sc.err || ''), sc.err);
  }

  /* ----- the built-in reader ----- */
  const want = async (label, t, roles) => {
    const j = await parse(p, t);
    eq(label + ': name, headline and contact details', j.name === 'Jordan Ellis' && j.headline === 'Content Strategist and SEO Writer' && j.email === 'jordan.ellis@example-mail.com' && j.phone === '(229) 555-0147' && j.location === 'Valdosta, GA' && /jordanellis\.com/.test(j.website), JSON.stringify([j.name, j.headline, j.email, j.phone, j.location, j.website]));
    eq(label + ': three jobs with the right role, company and dates', j.experience.length === 3 && j.experience[0].role === 'Senior Content Strategist' && /^Northwind Software/.test(j.experience[0].company) && j.experience[0].dates === 'Jan 2021 – Present' && j.experience[1].role === 'Freelance Writer' && j.experience[1].company === 'Self-employed' && j.experience[2].role === 'Content Writer' && /^Brightline Media/.test(j.experience[2].company) && j.experience[2].dates === 'Jun 2014 – Feb 2016', JSON.stringify(j.experience.map(e => [e.role, e.company, e.dates])));
    eq(label + ': bullets kept, and the wrapped bullet is one bullet', j.experience.map(e => e.bullets.split('\n').length).join() === '3,2,1' && /across two business units$/m.test(j.experience[0].bullets), JSON.stringify(j.experience.map(e => e.bullets.split('\n').length)));
    eq(label + ': education, skills, summary and LinkedIn', j.education.length === 1 && j.education[0].school === 'University of Georgia' && /B\.A\. in English/.test(j.education[0].degree) && j.education[0].dates === '2010 – 2014' && /^SEO, Content strategy, Editing/.test(j.skills) && j.skills.split(', ').length === 7 && /^Content strategist with eight years/.test(j.summary) && j.links.some(l => l.label === 'LinkedIn' && l.url === 'https://linkedin.com/in/jordan-ellis-writer'), JSON.stringify([j.education, j.skills, j.links]));
    return j;
  };
  const jt = await want('text', texts['resume-classic.txt']); eq('text: sections with no place in Folio are reported, not silently lost', jt.skipped === 'Certifications, Languages', jt.skipped);
  if (PDFJS) { await want('one-column PDF', texts['resume-classic.pdf']); await want('sidebar PDF', texts['resume-sidebar.pdf']); }
  await want('Word file', texts['resume-modern.docx']);
  const jo = await parse(p, texts['resume-older.txt']);
  eq('older style: ALL CAPS name, dotted phone, "Profile", "Work History" and "to" in dates', jo.name === 'Jordan Ellis' && jo.phone === '229.555.0147' && /^Writer with five years/.test(jo.summary) && jo.experience.length === 3 && jo.experience[0].dates === 'March 2016 to Present', JSON.stringify(jo.experience.map(e => e.dates)));
  eq('older style: "Role, Company", "Role at Company" and an intern job', jo.experience[0].role === 'Freelance Writer' && jo.experience[0].company === 'Self-employed' && jo.experience[1].role === 'Content Writer' && jo.experience[1].company === 'Brightline Media' && jo.experience[2].role === 'Editorial Intern' && jo.experience[2].company === 'Peachtree Weekly', JSON.stringify(jo.experience.map(e => [e.role, e.company])));
  eq('older style: education over three lines', jo.education.length === 1 && jo.education[0].school === 'University of Georgia' && /Bachelor of Arts/.test(jo.education[0].degree) && jo.education[0].dates === '2014', JSON.stringify(jo.education));
  const em = await p.evaluate(() => parseResume('Some Person\nI do things.\nSome text with no headings at all and no jobs, just a sentence.')); eq('no structure at all: warns instead of inventing jobs', em.experience.length === 0 && em.warnings.some(w => /No jobs were found/.test(w)));
  const nh = await p.evaluate(() => parseResume('Ana Reyes\nana@example.org\n\nDesigner, Studio North, 2019 - 2022\n- Made posters\n\nProduct Designer, Kite Labs, 2022 - Present\n- Built a design system')); eq('no "Experience" heading: finds jobs by their dates and says so', nh.experience.length === 2 && nh.warnings.some(w => /by their dates/.test(w)) && nh.experience[1].dates === '2022 - Present', JSON.stringify(nh.experience));

  /* ----- several resumes become one ----- */
  const merged = await p.evaluate(([a, o]) => mergeParsed([parseResume(a), parseResume(o)]), [texts['resume-classic.txt'], texts['resume-older.txt']]);
  eq('merge: the same job is not listed twice (4 jobs, newest first)', merged.experience.length === 4 && merged.experience.map(e => e.role).join() === 'Senior Content Strategist,Freelance Writer,Content Writer,Editorial Intern', merged.experience.map(e => e.role).join());
  eq('merge: bullets from both versions are combined without repeats', merged.experience[1].bullets.split('\n').length === 3 && /Managed client relationships/.test(merged.experience[1].bullets) && merged.experience[2].bullets.split('\n').length === 2, merged.experience.map(e => e.bullets.split('\n').length).join());
  eq('merge: skills joined without repeats, the longer profile kept, one school, dates and company from the fuller entry', merged.skills.split(', ').length === 8 && /Copywriting/.test(merged.skills) && /^Content strategist with eight years/.test(merged.summary) && merged.education.length === 1 && merged.experience[1].dates === 'Mar 2016 – Dec 2020' && merged.skipped === 'Certifications, Languages', merged.skills);
  if (PDFJS) { const m3 = await p.evaluate(a => mergeParsed(a.map(parseResume)), [texts['resume-classic.pdf'], texts['resume-modern.docx'], texts['resume-sidebar.pdf']]); eq('merge: the same resume as PDF, Word and sidebar PDF gives 3 jobs and no repeated bullets', m3.experience.length === 3 && m3.experience.map(e => e.bullets.split('\n').length).join() === '3,2,1', m3.experience.map(e => e.bullets.split('\n').length).join()); }

  /* ----- the card ----- */
  const openCard = async pg => { await pg.evaluate(() => { openCards.import = true; renderPanel(); }); await pg.waitForSelector('#impFile', { state: 'attached' }); await wait(150); };
  const before = await p.evaluate(() => JSON.stringify({ s: D.services, q: D.pollQuestion, a: D.availability, f: D.formMode }));
  await openCard(p);
  eq('the Import card is the first card in the editor', await p.evaluate(() => document.querySelector('#panel details.card').dataset.card === 'import'));
  await p.uncheck('#impAi'); await wait(200);
  await p.setInputFiles('#impFile', [fx('resume-classic.txt'), fx('resume-older.txt')]); await p.waitForFunction('impFiles.length === 2 && impFiles.every(f => f.status === "ok")');
  eq('two files listed, each read', (await p.locator('.implist li').count()) === 2 && /Read, \d+ words/.test(await p.locator('.implist li').first().innerText()));
  await p.click('#impGo'); await p.waitForSelector('#impDraftBox');
  const prev = await p.locator('#impDraftBox').innerText();
  eq('preview: names the built-in reader, the jobs found and what was not copied', /built-in reader/.test(prev) && /Jobs \(4\)/.test(prev) && /Editorial Intern at Peachtree Weekly/.test(prev) && /Not copied.*Certifications, Languages/.test(prev), prev.slice(0, 300));
  eq('nothing changed in the resume before pressing Use', await p.evaluate(() => D.name !== 'Jordan Ellis'));
  await p.click('#impUse'); await wait(300);
  const used = await p.evaluate(() => ({ n: D.name, e: D.experience.length, em: D.email, sk: D.skills, edu: D.education.length, sv: JSON.stringify(D.services), q: D.pollQuestion, a: D.availability, f: D.formMode }));
  eq('Use: the resume is filled in', used.n === 'Jordan Ellis' && used.e === 4 && used.em === 'jordan.ellis@example-mail.com' && used.edu === 1 && /Copywriting/.test(used.sk), JSON.stringify(used).slice(0, 200));
  eq('Use: services, poll question, availability and form settings stay', JSON.stringify({ s: JSON.parse(used.sv), q: used.q, a: used.a, f: used.f }) === before, used.sv.slice(0, 80));
  eq('Use: the editor shows the imported name', (await p.inputValue('[data-f="name"]')) === 'Jordan Ellis');
  await p.click('#impUndo'); await wait(300);
  eq('Undo: the earlier resume is back', await p.evaluate(() => D.name !== 'Jordan Ellis' && D.experience.length !== 4));

  /* paste, remove, too many files */
  await openCard(p); await p.fill('#impPaste', texts['resume-classic.txt']); await p.evaluate(() => { impFiles = []; }); await p.click('#impGo'); await p.waitForSelector('#impDraftBox');
  eq('pasted text is read the same way', /Jobs \(3\)/.test(await p.locator('#impDraftBox').innerText())); await p.click('#impNo'); await wait(100);
  await p.fill('#impPaste', ''); await p.click('#impGo'); await wait(200); eq('pressing Read with nothing chosen says what to do', /Choose a resume file or paste/.test(await p.locator('#impLive').innerText()));
  await p.setInputFiles('#impFile', [fx('resume-classic.txt')]); await p.waitForFunction('impFiles.length === 1 && impFiles[0].status === "ok"'); await p.click('[data-impdel]'); await wait(100); eq('Remove takes a file out of the list', (await p.locator('.implist li').count()) === 0);
  await p.evaluate(() => { impFiles = []; }); await p.setInputFiles('#impFile', Array(7).fill(fx('resume-older.txt'))); await wait(800); eq('more than 6 files: stops at 6 and says why', (await p.locator('.implist li').count()) === 6 && /up to 6 files/.test(await p.locator('#impLive').innerText()));
  await p.evaluate(() => { impFiles = []; }); await p.setInputFiles('#impFile', [{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x'.repeat(300)) }]); await wait(300); eq('a file that cannot be read shows its reason next to the name', /Photos and scans/.test(await p.locator('.implist li').first().innerText()));
  await p.close();

  /* ----- Claude path (simulated) and fallbacks ----- */
  const claudeDraft = { name: 'Jordan Ellis', headline: 'Content Strategist', email: 'jordan.ellis@example-mail.com', phone: '(229) 555-0147', location: 'Valdosta, GA', website: 'jordanellis.com', summary: 'From Claude.', skills: 'SEO, Editing', experience: [{ role: 'Senior Content Strategist', company: 'Northwind Software', dates: 'Jan 2021 – Present', bullets: 'Led a team' }], education: [{ school: 'University of Georgia', degree: 'B.A. in English', dates: '2014' }], links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/x' }, { label: 'Bad', url: 'javascript:alert(1)' }], services: [{ title: 'x' }], skipped: 'Languages' };
  const runUi = async (pg, files) => { await openCard(pg); await pg.setInputFiles('#impFile', files); await pg.waitForFunction(n => impFiles.length === n && impFiles.every(f => f.status !== 'reading'), files.length); await pg.waitForSelector('#impTsBox[data-ts]'); await pg.evaluate(() => window.__ts.callback('good-token')); await pg.click('#impGo'); await wait(700); };
  p = await open(); aiBodies = []; ai = { status: 200, json: { draft: claudeDraft, model: 'claude-haiku-5-5', skipped: 'Languages' } };
  await runUi(p, [fx('resume-classic.txt'), fx('resume-older.txt')]);
  eq('Claude path: asked once, in import mode, with every file labeled', aiBodies.length === 1 && aiBodies[0].mode === 'import' && aiBodies[0].turnstile === 'good-token' && /=== Resume 1: resume-classic\.txt ===/.test(aiBodies[0].text) && /=== Resume 2: resume-older\.txt ===/.test(aiBodies[0].text), JSON.stringify(Object.keys(aiBodies[0] || {})));
  const pc = await p.locator('#impDraftBox').innerText(); eq('Claude path: preview says Claude read it and shows its result', /Read by Claude/.test(pc) && /Jobs \(1\)/.test(pc) && /Not copied.*Languages/.test(pc), pc.slice(0, 200));
  eq('Claude path: the human check was reset for next time', await p.evaluate(() => window.__tsReset >= 1));
  await p.click('#impUse'); await wait(300); eq('Claude path: Use fills the resume, and a non-web link is dropped', await p.evaluate(() => D.summary === 'From Claude.' && D.links.length === 1 && D.links[0].url === 'https://linkedin.com/in/x' && D.experience.length === 1));
  await p.close();
  for (const [status, json, rx, label, offAfter] of [[502, { error: 'ai_billing', status: 400 }, /would not run the request/, 'Claude out of credit: says so, then the built-in reader does the job', true], [400, { error: 'bad_request' }, /needs Worker 1\.2\.0/, 'older Worker (no import mode): says it needs 1.2.0, built-in reader used', false], [422, { error: 'too_long' }, /too long for Claude/, 'Claude says too long: built-in reader used', false], [0, null, /Could not reach the Folio service/, 'no connection to the service: built-in reader used', false]]) {
    p = await open(); aiBodies = []; ai = { status: status || 500, json };
    if (!status) { await p.unroute('https://folio-pages.test/api/ai'); await p.route('https://folio-pages.test/api/ai', r => r.abort()); }
    await runUi(p, [fx('resume-classic.txt')]);
    const t = await p.locator('#impLive').innerText();
    eq(label, rx.test(t) && /built-in reader/.test(t) && (await p.locator('#impDraftBox').count()) === 1 && /Jobs \(3\)/.test(await p.locator('#impDraftBox').innerText()), t.slice(0, 260));
    if (offAfter) eq('after a billing or key problem, the Claude option turns itself off for this visit', await p.evaluate(() => impAiOff === true) && !(await p.isChecked('#impAi')));
    await p.close();
  }
  p = await open(); ai = { status: 200, json: { draft: claudeDraft } }; aiBodies = []; await openCard(p); await p.setInputFiles('#impFile', [fx('resume-classic.txt')]); await p.waitForFunction('impFiles.length === 1 && impFiles[0].status === "ok"'); await p.click('#impGo'); await wait(500);
  eq('human check not finished: built-in reader used at once, and it says why', aiBodies.length === 0 && /human check had not finished/.test(await p.locator('#impLive').innerText()) && (await p.locator('#impDraftBox').count()) === 1);
  await p.close();

  /* ----- on a phone: touch size and spacing inside the open card, with files listed and a preview showing ----- */
  { const mc = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await mc.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={render(el,o){window.__ts=o;el.dataset.ts="1";el.style.height="65px";return 1},reset(){}}' }));
    const mp = await mc.newPage(); mp.on('pageerror', e => errs.push(e.message));
    await mp.route('http://x.test/**', r => r.fulfill({ body: APP.replace(/const PUBLISH = \{ api: '[^']*', siteKey: '[^']*' \};/, "const PUBLISH = { api: 'https://folio-pages.test', siteKey: 'TESTKEY' };"), contentType: 'text/html' }));
    await mp.goto('http://x.test/folio/'); await mp.waitForFunction('typeof D !== "undefined"'); await openCard(mp); await mp.uncheck('#impAi');
    await mp.setInputFiles('#impFile', [{ name: 'a.txt', mimeType: 'text/plain', buffer: fs.readFileSync(fx('resume-classic.txt')) }, { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x'.repeat(300)) }]); await wait(600);
    await mp.click('#impGo'); await mp.waitForSelector('#impDraftBox'); await wait(150);
    const q = await mp.evaluate(() => { const els = [...document.querySelectorAll('#impBox button, #impBox textarea, #impBox label.btn, #impBox input:not([type=file])')].filter(e => e.getBoundingClientRect().width > 0); const R = els.map(e => ({ e, r: e.getBoundingClientRect() }));
      const small = R.filter(x => x.r.height < 43.5 || x.r.width < 43.5).map(x => x.e.id || x.e.textContent.trim().slice(0, 16)), tight = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i], c = R[j]; if (a.e.contains(c.e) || c.e.contains(a.e)) continue; const dx = Math.max(a.r.left - c.r.right, c.r.left - a.r.right), dy = Math.max(a.r.top - c.r.bottom, c.r.top - a.r.bottom); if (dx < 0 && dy < 0) continue; const g = dx < 0 ? dy : dy < 0 ? dx : Math.hypot(dx, dy); if (g < 7.5) tight.push((a.e.id || a.e.textContent.trim().slice(0, 14)) + ' | ' + (c.e.id || c.e.textContent.trim().slice(0, 14)) + ' ' + Math.round(g) + 'px'); }
      return { n: els.length, small, tight, wide: document.documentElement.scrollWidth > innerWidth + 1 }; });
    eq('phone: every control in the Import card is at least 44px tall and wide (' + q.n + ' controls)', q.small.length === 0, q.small.join('; '));
    eq('phone: at least 8px between neighbouring controls', q.tight.length === 0, q.tight.join('; '));
    eq('phone: the page does not scroll sideways', !q.wide);
    await mc.close(); }
  eq('no page errors in any test', errs.length === 0, errs.join(' | '));
  console.log('\n' + results.filter(Boolean).length + ' passed, ' + results.filter(x => !x).length + ' failed'); await b.close(); process.exit(results.every(Boolean) ? 0 : 1);
})();
