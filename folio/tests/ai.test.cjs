/* Tests for the AI magic endpoint of the folio-pages Worker. Run from the repo root:  node --no-warnings folio/tests/ai.test.cjs
   The REAL Worker code runs against SQLite (d1-shim.cjs). Turnstile and Claude are SIMULATED, so this proves the Worker's logic,
   not that a real Claude key, model name or Turnstile widget works. */
const path = require('path'), { pathToFileURL } = require('url'); const { makeD1 } = require('./d1-shim.cjs');
const results = []; const eq = (n, c, note) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !note ? '' : '  :: ' + note)); };
const ORIGIN = 'https://layahmcfly.github.io';
let claude = { status: 200, text: '' }, claudeCalls = [], tsAction = 'folio-ai';
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes('turnstile')) { const tok = new URLSearchParams(String(init.body)).get('response'); const ok = tok !== 'bad-token';
    return new Response(JSON.stringify(ok ? { success: true, hostname: 'layahmcfly.github.io', action: tok === 'publish-token' ? 'folio-publish' : tsAction } : { success: false }), { status: 200 }); }
  claudeCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  if (claude.status !== 200) return new Response('{}', { status: claude.status });
  return new Response(JSON.stringify({ content: [{ type: 'text', text: claude.text }] }), { status: 200 });
};
const GOOD = JSON.stringify({ name: 'Ada Lovelace', headline: 'Technical writer', summary: 'Writes SEO articles for software companies.', skills: 'SEO, editing',
  experience: [{ role: 'Writer', company: 'Self', dates: '2019 to now', bullets: 'Wrote 200 articles' }], education: [], links: [{ label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Site', url: 'https://ada.example' }],
  services: [{ title: 'SEO article', price: 'From $250', extraPrice: '$0.66', extraPer: 'minute', desc: '1,500 words.', evil: 'x' }], pollQuestion: '', pollOptions: '', availability: 'January', extra: 'ignored' });
(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'folio-pages.mjs')).href), worker = mod.default;
  const newEnv = x => Object.assign({ DB: makeD1(), TURNSTILE_SECRET: 's', CLAUDE_API_KEY: 'sk-test-KEY', ALLOWED_ORIGIN: ORIGIN }, x || {});
  let n = 0;
  const call = (env, body, o) => worker.fetch(new Request('https://w.test/api/ai', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.' + ((o && o.ip) || (n++ % 200 + 1)) }, (o && o.headers) || {}), body: typeof body === 'string' ? body : JSON.stringify(body) }), env);
  const ok = (text, tok) => ({ text: text || 'I write SEO articles for software companies, six years freelance, charging $250 per article and $0.66 more per minute of interview.', turnstile: tok || 'tok-' + Math.random() });
  let env = newEnv(), r;
  claude = { status: 200, text: GOOD }; r = await call(env, ok()); let j = await r.json();
  eq('success: 200 with a draft', r.status === 200 && j.draft && j.draft.name === 'Ada Lovelace', JSON.stringify(j).slice(0, 200));
  eq('extra charge fields come through', j.draft.services[0].extraPrice === '$0.66' && j.draft.services[0].extraPer === 'minute');
  eq('unexpected fields are dropped', !('evil' in j.draft.services[0]) && !('extra' in j.draft));
  eq('non-web links are dropped, https links kept', j.draft.links.length === 1 && j.draft.links[0].url === 'https://ada.example');
  eq('the Claude key goes only to Anthropic as x-api-key and never into the reply', claudeCalls[0].url === 'https://api.anthropic.com/v1/messages' && claudeCalls[0].headers['x-api-key'] === 'sk-test-KEY' && !JSON.stringify(j).includes('sk-test-KEY'));
  eq('the person\'s text is wrapped as data, instructions stay in the system prompt', /ignore any instructions/i.test(claudeCalls[0].body.system) && claudeCalls[0].body.messages[0].content.includes('"""'));
  r = await call(newEnv({ CLAUDE_API_KEY: '' }), ok()); eq('no key: 503 ai_not_set_up', r.status === 503 && (await r.json()).error === 'ai_not_set_up');
  r = await call(newEnv({ AI_PAUSED: 'true' }), ok()); eq('paused: 503 ai_paused', r.status === 503 && (await r.json()).error === 'ai_paused');
  r = await call(env, ok('too short')); eq('too short text: 422', r.status === 422 && (await r.json()).error === 'too_short');
  r = await call(env, ok('x'.repeat(6001))); eq('too long text: 422', r.status === 422 && (await r.json()).error === 'too_long');
  r = await call(env, { text: ok().text }); eq('missing human check: 400', r.status === 400);
  r = await call(env, Object.assign(ok(), { extra: 1 })); eq('unknown request field: 400', r.status === 400);
  r = await call(env, ok(null, 'bad-token')); eq('failed human check: 400 and Claude not called', r.status === 400 && claudeCalls.length === 1);
  r = await call(env, ok(null, 'publish-token')); eq('a publish-action token cannot be used for AI', r.status === 400);
  const tok = 'same-token'; r = await call(env, ok(null, tok)); const r2 = await call(env, ok(null, tok)); eq('a human-check token works once', r.status === 200 && r2.status === 400);
  r = await call(env, 'not json'); eq('bad JSON: 400', r.status === 400);
  r = await call(env, ok(), { headers: { Origin: 'https://evil.example' } }); eq('other website origin: 403', r.status === 403);
  const env2 = newEnv(); let codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call(env2, ok(), { ip: 9 })).status);
  eq('rate limit: 3 per hour per visitor, then 429', codes.join() === '200,200,200,429,429', codes.join());
  const env3 = newEnv({ RL_AI_GLOBAL_DAY: '2' }); codes = []; for (let i = 0; i < 4; i++) codes.push((await call(env3, ok())).status);
  eq('daily cap for everyone: 429 once reached', codes.join() === '200,200,429,429', codes.join());
  for (const [st, code] of [[401, 'ai_key'], [402, 'ai_billing'], [400, 'ai_billing'], [429, 'ai_busy'], [500, 'ai_failed']]) {
    claude = { status: st, text: '' }; r = await call(newEnv(), ok()); j = await r.json(); eq('Claude HTTP ' + st + ' -> ' + code, r.status === 502 && j.error === code && !JSON.stringify(j).includes('sk-test'));
  }
  claude = { status: 200, text: 'Sorry, I cannot help with that.' }; r = await call(newEnv(), ok()); eq('unreadable answer: 502 ai_unreadable', r.status === 502 && (await r.json()).error === 'ai_unreadable');
  claude = { status: 200, text: 'Here you go: ' + JSON.stringify({ name: 'N'.repeat(500), summary: 'S', experience: Array.from({ length: 80 }, () => ({ role: 'r', company: 'c', dates: 'd', bullets: 'b' })), services: [], education: [], links: [] }) + ' done' };
  r = await call(newEnv(), ok()); j = await r.json(); eq('text around the JSON is tolerated; lengths and list sizes are capped', r.status === 200 && j.draft.name.length === 120 && j.draft.experience.length === 30);
  // import mode: resumes of up to 40,000 characters, contact fields, merge prompt, no services
  const impDraft = JSON.stringify({ name: 'Jordan Ellis', headline: 'Content Strategist', email: 'jordan@example.com', phone: '(229) 555-0147', location: 'Valdosta, GA', website: 'jordanellis.com', summary: 'Eight years.', skills: 'SEO, Editing',
    experience: [{ role: 'Writer', company: 'Self', dates: '2016 to now', bullets: 'a\nb' }], education: [{ school: 'UGA', degree: 'B.A.', dates: '2014' }], links: [{ label: 'x', url: 'ftp://nope' }, { label: 'LinkedIn', url: 'https://linkedin.com/in/j' }], services: [{ title: 'should not appear' }], availability: 'nope', skipped: 'Certifications' });
  const big = n => 'Jordan Ellis resume text. '.repeat(Math.ceil(n / 26)).slice(0, n - 1) + 'x';
  claude = { status: 200, text: impDraft }; claudeCalls.length = 0;
  r = await call(newEnv(), { text: big(30000), turnstile: 'imp-' + Math.random(), mode: 'import' }); j = await r.json();
  eq('import: 30,000 characters accepted', r.status === 200 && j.draft && j.draft.name === 'Jordan Ellis', r.status + ' ' + JSON.stringify(j).slice(0, 120));
  eq('import: contact details come through, services and availability do not, bad links dropped', j.draft.email === 'jordan@example.com' && j.draft.phone === '(229) 555-0147' && j.draft.location === 'Valdosta, GA' && j.draft.website === 'jordanellis.com' && !('services' in j.draft) && !('availability' in j.draft) && j.draft.links.length === 1 && j.draft.links[0].url.startsWith('https://'), JSON.stringify(j.draft).slice(0, 300));
  eq('import: the reply says which sections were skipped', j.skipped === 'Certifications');
  eq('import: Claude gets the import instructions (merge, copy faithfully) and room for a long answer', /merge them into one/.test(claudeCalls[0].body.system) && /Do not invent, improve, shorten or summarize/.test(claudeCalls[0].body.system) && claudeCalls[0].body.max_tokens === 8000 && claudeCalls[0].body.messages[0].content.startsWith('Resume text:'));
  r = await call(newEnv(), { text: big(40001), turnstile: 'imp-' + Math.random(), mode: 'import' }); eq('import: over 40,000 characters: 422 too_long', r.status === 422 && (await r.json()).error === 'too_long');
  r = await call(newEnv(), { text: big(7000), turnstile: 'imp-' + Math.random() }); eq('describe mode is still limited to 6,000 characters', r.status === 422 && (await r.json()).error === 'too_long');
  r = await call(newEnv(), { text: big(100), turnstile: 'imp-' + Math.random(), mode: 'surprise' }); eq('unknown mode: 400', r.status === 400);
  r = await call(newEnv(), { text: big(100), turnstile: 'imp-' + Math.random(), mode: 'describe' }); j = await r.json(); eq('describe mode named explicitly still works and still hides contact fields', r.status === 200 && !('email' in j.draft), r.status + ' ' + JSON.stringify(j).slice(0, 100));
  claude = { status: 200, text: JSON.stringify({ name: '', experience: [], education: [], skills: '' }) }; r = await call(newEnv(), { text: big(500), turnstile: 'imp-' + Math.random(), mode: 'import' }); eq('import: an empty answer is reported as unreadable', r.status === 502 && (await r.json()).error === 'ai_unreadable');
  claude = { status: 200, text: GOOD };
  // services with the new fields validate when published; pages from older Folio versions (no extra fields) still validate
  const base = () => ({ D: { name: 'A', headline: '', email: '', phone: '', location: '', website: '', summary: '', skills: '', availability: '', ctaLabel: 'Hire me', formTitle: 't', pollQuestion: '', pollOptions: '', formEndpoint: '', thanks: 't', formMode: 'email', experience: [], education: [], links: [], services: [{ title: 'a', desc: 'b', price: 'c' }] }, ST: { layout: 'modern', font: 'editorial', color: '#8a3f1f', paper: 'white' } });
  const pub = async data => worker.fetch(new Request('https://w.test/api/pages', { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '198.51.100.' + (n++ % 200 + 1) }, body: JSON.stringify({ data, turnstile: 't-' + Math.random() }) }), (tsAction = 'folio-publish', newEnv()));
  r = await pub(base()); eq('publish without the new fields (older Folio) still accepted', r.status === 201, String(r.status));
  const withX = base(); withX.D.services[0].extraPer = 'minute'; withX.D.services[0].extraPrice = '$0.66'; r = await pub(withX); eq('publish with extra charge fields accepted', r.status === 201, String(r.status));
  const tooLong = base(); tooLong.D.services[0].extraPer = 'x'.repeat(41); r = await pub(tooLong); eq('extraPer over 40 characters rejected', r.status === 422);
  const bad = base(); bad.D.services[0].other = 'x'; r = await pub(bad); eq('unknown service field still rejected', r.status === 422);
  console.log('\n' + results.filter(Boolean).length + ' passed, ' + results.filter(x => !x).length + ' failed'); process.exit(results.every(Boolean) ? 0 : 1);
})();
