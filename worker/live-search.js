/* ============================================================
   Live job search relay for the Job Search Tracker.
   Runs on a free Cloudflare Worker. The tracker page calls it
   when you press "Search live" in the Job Feed. Nothing is saved
   here: every search reads the job boards at that moment, so a
   job that a board has taken down stops showing up.

   Endpoints
     GET /health           returns {"ok":true}
     GET /search?q=words   returns matching openings

   Needs no keys, no card and no Claude credits.

   Free plan limits this file is written around:
     10 ms CPU per request, 50 outside requests per search.
   So it filters on titles first and converts descriptions to
   plain text only for the few jobs that match.
   ============================================================ */

// Your tracker site. The Worker reads job-sources.json (company lists)
// and jobs-feed.json (Remotive jobs) from here, and only answers this site.
const SITE_URL = 'https://layahmcfly.github.io/JobSearch/';
const ALLOWED_ORIGINS = ['https://layahmcfly.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];

const CACHE_SECONDS = 300;      // same search within 5 minutes reuses the answer
const MAX_RESULTS = 500;      // per request; each board group is its own request
const MAX_AGE_DAYS = 30;       // postings older than this are dropped; postings with no date are kept
const MAX_COMPANY_BOARDS = 25;  // Greenhouse + Lever boards read per search (50 request limit)
const MAX_DESC = 6000;
const USER_AGENT = 'JobSearchTracker/2.0 (personal live search)';

const WWR_FEEDS = [
  { name: 'We Work Remotely: All Jobs', url: 'https://weworkremotely.com/remote-jobs.rss' },
  { name: 'We Work Remotely: Programming', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss' },
  { name: 'We Work Remotely: Design', url: 'https://weworkremotely.com/categories/remote-design-jobs.rss' },
  { name: 'We Work Remotely: Customer Support', url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss' },
  { name: 'We Work Remotely: Sales and Marketing', url: 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss' },
  { name: 'We Work Remotely: All Other', url: 'https://weworkremotely.com/categories/all-other-remote-jobs.rss' }
];

const memory = new Map(); // best effort; a cold start empties it

/* ---------- small helpers ---------- */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' };
function decode(s = '') {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
function toText(html = '') {
  return decode(String(html).slice(0, MAX_DESC * 3)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/(^|\n)- *\n+/g, '$1- ').trim().slice(0, MAX_DESC);
}
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const titleCase = s => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function isoDate(v) {
  if (v === undefined || v === null || v === '') return '';
  const d = new Date(typeof v === 'number' ? v : String(v));
  return d.getTime() > 0 ? d.toISOString().slice(0, 10) : '';
}
function inferRemote(...parts) {
  const t = parts.join(' ').toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'Hybrid';
  if (/\b(remote|work from home|anywhere|distributed)\b/.test(t)) return 'Remote';
  return '';
}
const PAY_RE = /(?:US)?\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?(?:\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|mo))?(?:\s*(?:-|–|to)\s*(?:US)?\$?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?(?:\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|mo))?)?/;
const findPay = t => (String(t).match(PAY_RE) || [''])[0].trim();

function words(q) { return clean(q).toLowerCase().split(' ').filter(w => w.length > 1 || /\d/.test(w)); }
// Every search word must appear somewhere in the job (title, company, location, tags, description). The words can be in different places.
// A search with several terms separated by | (the app sends the keywords from Settings this way) matches a job
// that satisfies any one term, and each term needs all of its own words.
function hits(ws, ...fields) {
  if (ws.alts) { const hay = fields.join(' ').toLowerCase(); return ws.alts.some(t => t.every(w => hay.includes(w))); }
  if (!ws.length) return true;
  const hay = fields.join(' ').toLowerCase();
  return ws.every(w => hay.includes(w));
}

async function getCached(url, kind, ctx) {
  const key = kind + '|' + url;
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return hit.body;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: kind === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = kind === 'json' ? await res.json() : await res.text();
  memory.set(key, { at: Date.now(), body });
  if (memory.size > 60) memory.delete(memory.keys().next().value);
  return body;
}

function job(src, f) {
  const location = clean(f.location);
  const description = f.description || '';
  return {
    id: `${src.type}:${f.externalId}`,
    title: clean(f.title),
    company: clean(f.company),
    link: String(f.link || '').trim(),
    ...(f.applyLink ? { applyLink: f.applyLink } : {}),
    source: src.label,
    sourceName: src.name,
    location,
    remoteType: f.remoteType || inferRemote(location, f.title),
    payRange: clean(f.payRange) || findPay(description),
    datePosted: f.datePosted || '',
    description,
    descriptionIsSnippet: Boolean(f.snippet),
    rank: f.rank || 0, // 0 = the search words are in the title, company or location; 1 = only in the description
    live: true
  };
}

/* ---------- readers: each returns [] or throws ---------- */
async function readJobicy(ws, ctx) {
  const src = { type: 'jobicy', label: 'Jobicy', name: 'Jobicy (live)' };
  // Jobicy's own tag search finds the most relevant posts; matching below is stricter.
  const tag = encodeURIComponent(ws.join(' '));
  const data = await getCached(`https://jobicy.com/api/v2/remote-jobs?count=100${ws.length ? '&tag=' + tag : ''}`, 'json', ctx);
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected response');
  return data.jobs
    .map(j => { const head = [j.jobTitle, j.companyName, j.jobGeo, (j.jobIndustry || []).join(' '), (j.jobType || []).join(' ')]; return { j, top: hits(ws, ...head), any: hits(ws, ...head, j.jobDescription || j.jobExcerpt || '') }; })
    .filter(x => x.any)
    .map(({ j, top }) => job(src, {
      rank: top ? 0 : 1,
      externalId: String(j.id), title: j.jobTitle, company: j.companyName, link: j.url, location: j.jobGeo,
      remoteType: 'Remote', datePosted: isoDate(j.pubDate),
      payRange: j.salaryMin || j.salaryMax ? [j.salaryMin, j.salaryMax].filter(Boolean).map(n => '$' + Number(n).toLocaleString('en-US')).join(' to ') + (j.salaryPeriod ? ' ' + j.salaryPeriod : '') : '',
      description: toText(j.jobDescription || j.jobExcerpt || '')
    }));
}

function xmlTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim() : '';
}
async function readWwr(feed, ws, ctx) {
  const xml = await getCached(feed.url, 'text', ctx);
  const src = { type: 'wwr', label: 'We Work Remotely', name: feed.name + ' (live)' };
  const out = [];
  for (const it of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    let title = decode(xmlTag(it, 'title')), company = '';
    const i = title.indexOf(': ');
    if (i > 0) { company = title.slice(0, i).trim(); title = title.slice(i + 2).trim(); }
    const region = decode(xmlTag(it, 'region'));
    const top = hits(ws, title, company, region);
    const raw = decode(xmlTag(it, 'description'));
    if (!top && !hits(ws, title, company, region, raw)) continue; // cheap checks before any text conversion
    const link = decode(xmlTag(it, 'link'));
    out.push(job(src, {
      rank: top ? 0 : 1,
      externalId: decode(xmlTag(it, 'guid')) || link, title, company, link, location: region,
      remoteType: 'Remote', datePosted: isoDate(xmlTag(it, 'pubDate')),
      description: toText(raw)
    }));
  }
  return out;
}

async function readGreenhouse(b, ws, ctx) {
  const src = { type: 'greenhouse', label: 'Greenhouse', name: `Greenhouse: ${b.company || titleCase(b.token)} (live)` };
  // Without content=true the list is small and cheap. Descriptions open on the job link.
  const data = await getCached(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs`, 'json', ctx);
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected response');
  return data.jobs.filter(j => hits(ws, j.title, b.company || b.token, j.location?.name))
    .map(j => job(src, {
      externalId: `${b.token}:${j.id}`, title: j.title, company: b.company || titleCase(b.token), link: j.absolute_url,
      location: j.location?.name, datePosted: isoDate(j.first_published || j.updated_at), snippet: true
    }));
}

async function readLever(b, ws, ctx) {
  const src = { type: 'lever', label: 'Lever', name: `Lever: ${b.company || titleCase(b.name)} (live)` };
  const host = b.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const data = await getCached(`https://${host}/v0/postings/${encodeURIComponent(b.name)}?mode=json`, 'json', ctx);
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data.map(p => { const head = [p.text, b.company || b.name, p.categories?.location, p.categories?.team]; return { p, top: hits(ws, ...head), any: hits(ws, ...head, p.descriptionPlain || '') }; })
    .filter(x => x.any)
    .map(({ p, top }) => {
      const wt = String(p.workplaceType || '').toLowerCase();
      return job(src, {
        rank: top ? 0 : 1,
        externalId: `${b.name}:${p.id}`, title: p.text, company: b.company || titleCase(b.name), link: p.hostedUrl || p.applyUrl,
        applyLink: p.applyUrl && p.applyUrl !== p.hostedUrl ? p.applyUrl : '',
        location: p.categories?.location || (p.categories?.allLocations || []).join(', '),
        remoteType: wt === 'remote' ? 'Remote' : wt === 'hybrid' ? 'Hybrid' : wt === 'onsite' ? 'Onsite' : '',
        datePosted: isoDate(p.createdAt),
        description: p.descriptionPlain || toText(p.description || '')
      });
    });
}

// Remote OK: one public list of the newest ~100 postings. Terms ask us to name Remote OK as the source and link to
// its posting page, which the card does (source name, and "Open link" goes to remoteok.com).
async function readRemoteOk(ws, ctx) {
  const src = { type: 'remoteok', label: 'Remote OK', name: 'Remote OK (live)' };
  const data = await getCached('https://remoteok.com/api', 'json', ctx);
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data.filter(j => j && j.position && j.url)
    .map(j => { const head = [j.position, j.company, j.location, (j.tags || []).join(' ')]; return { j, top: hits(ws, ...head), any: hits(ws, ...head, j.description || '') }; })
    .filter(x => x.any)
    .map(({ j, top }) => job(src, {
      rank: top ? 0 : 1,
      externalId: String(j.id || j.slug), title: decode(j.position), company: decode(j.company || ''), link: j.url,
      applyLink: j.apply_url || '', location: j.location || 'Worldwide', remoteType: 'Remote', datePosted: isoDate(j.date),
      payRange: j.salary_min > 0 ? '$' + Number(j.salary_min).toLocaleString('en-US') + (j.salary_max > 0 ? ' to $' + Number(j.salary_max).toLocaleString('en-US') : '') + ' a year' : '',
      description: toText(j.description || '')
    }));
}

// Arbeitnow: free list, mostly Europe. Only postings marked remote are kept.
async function readArbeitnow(ws, ctx) {
  const src = { type: 'arbeitnow', label: 'Arbeitnow', name: 'Arbeitnow (live)' };
  const pages = await Promise.allSettled([1, 2, 3].map(n => getCached(`https://www.arbeitnow.com/api/job-board-api?page=${n}`, 'json', ctx)));
  const okPages = pages.filter(p => p.status === 'fulfilled' && Array.isArray(p.value?.data));
  if (!okPages.length) throw new Error(pages[0]?.reason?.message || 'Unexpected response');
  const data = { data: okPages.flatMap(p => p.value.data) };
  return data.data.filter(j => j && j.remote && j.title && j.url)
    .map(j => { const head = [j.title, j.company_name, j.location, (j.tags || []).join(' '), (j.job_types || []).join(' ')]; return { j, top: hits(ws, ...head), any: hits(ws, ...head, j.description || '') }; })
    .filter(x => x.any)
    .map(({ j, top }) => job(src, {
      rank: top ? 0 : 1,
      externalId: String(j.slug || j.url), title: decode(j.title), company: decode(j.company_name || ''), link: j.url,
      location: j.location, remoteType: 'Remote',
      datePosted: isoDate(typeof j.created_at === 'number' && j.created_at < 1e12 ? j.created_at * 1000 : j.created_at),
      description: toText(j.description || '')
    }));
}

// Working Nomads: public list of remote jobs.
async function readWorkingNomads(ws, ctx) {
  const src = { type: 'nomads', label: 'Working Nomads', name: 'Working Nomads (live)' };
  const data = await getCached('https://www.workingnomads.com/api/exposed_jobs/', 'json', ctx);
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data.filter(j => j && j.title && j.url)
    .map(j => { const tags = Array.isArray(j.tags) ? j.tags.join(' ') : String(j.tags || ''); const head = [j.title, j.company_name, j.location, j.category_name, tags]; return { j, top: hits(ws, ...head), any: hits(ws, ...head, j.description || '') }; })
    .filter(x => x.any)
    .map(({ j, top }) => job(src, {
      rank: top ? 0 : 1,
      externalId: String(j.url), title: decode(j.title), company: decode(j.company_name || ''), link: j.url,
      location: j.location, remoteType: 'Remote', datePosted: isoDate(j.pub_date),
      description: toText(j.description || '')
    }));
}

// The Muse: free public list, no key. It has no keyword search, so the newest Flexible / Remote postings
// (10 pages of 20) are read and matched here.
async function readMuse(ws, ctx) {
  const src = { type: 'muse', label: 'The Muse', name: 'The Muse (live)' };
  const pages = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
    getCached(`https://www.themuse.com/api/public/jobs?page=${n}&location=${encodeURIComponent('Flexible / Remote')}`, 'json', ctx)));
  const ok = pages.filter(p => p.status === 'fulfilled' && Array.isArray(p.value?.results));
  if (!ok.length) throw new Error(pages[0]?.reason?.message || 'Unexpected response');
  const names = list => (Array.isArray(list) ? list : []).map(x => x && x.name).filter(Boolean);
  return ok.flatMap(p => p.value.results)
    .filter(j => j && j.name && j.refs?.landing_page)
    .map(j => {
      const loc = names(j.locations).join(', ');
      const head = [j.name, j.company?.name, loc, names(j.categories).join(' '), names(j.levels).join(' ')];
      return { j, loc, top: hits(ws, ...head), any: hits(ws, ...head, j.contents || '') };
    })
    .filter(x => x.any)
    .map(({ j, loc, top }) => job(src, {
      rank: top ? 0 : 1,
      externalId: String(j.id), title: decode(j.name), company: decode(j.company?.name || ''), link: j.refs.landing_page,
      location: loc, remoteType: /flexible|remote/i.test(loc) ? 'Remote' : '', datePosted: isoDate(j.publication_date),
      description: toText(j.contents || '')
    }));
}

// Hacker News "Who is hiring": the newest monthly thread, searched through the free Algolia HN search.
// Each top-level comment is one posting. The first line usually reads "Company | Role | Location | Remote".
async function readHackerNews(ws, ctx) {
  const src = { type: 'hn', label: 'Hacker News: Who is hiring', name: 'Hacker News: Who is hiring (live)' };
  const threads = await getCached('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10', 'json', ctx);
  const thread = (threads.hits || []).find(h => /who is hiring/i.test(h.title || ''));
  if (!thread) throw new Error('Could not find this month\'s thread');
  const q = encodeURIComponent(ws.join(' '));
  const data = await getCached(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${thread.objectID}&hitsPerPage=500${ws.length ? '&query=' + q : ''}`, 'json', ctx);
  if (!Array.isArray(data.hits)) throw new Error('Unexpected response');
  return data.hits.filter(h => String(h.parent_id) === String(thread.objectID) && h.comment_text)
    .map(h => {
      const text = toText(String(h.comment_text).replace(/<p>/gi, '</p>')); // HN separates paragraphs with a bare <p>
      const first = text.split('\n')[0];
      const parts = first.split('|').map(x => clean(x));
      const multi = parts.length >= 3;
      const head = multi ? parts.join(' ') : first;
      return { h, text, parts, multi, top: hits(ws, head), any: hits(ws, text) };
    })
    .filter(x => x.any)
    .map(({ h, text, parts, multi, top }) => job(src, {
      rank: top ? 0 : 1,
      externalId: String(h.objectID), title: multi ? (parts[1] || parts[0]) : text.split('\n')[0].slice(0, 120), company: multi ? parts[0] : '',
      link: `https://news.ycombinator.com/item?id=${h.objectID}`,
      location: multi ? parts.slice(2).join(' | ') : '', remoteType: /\bremote\b/i.test(text.split('\n')[0]) ? 'Remote' : '',
      datePosted: isoDate(h.created_at), description: text
    }));
}

// Remotive asks for 4 requests a day, so live search never calls it.
// It searches the jobs the 3-hour GitHub run already saved from Remotive.
async function readRemotiveSaved(ws, ctx) {
  const feed = await getCached(new URL('jobs-feed.json', SITE_URL).href, 'json', ctx);
  return (feed.jobs || []).filter(j => /^remotive:/.test(j.id || '') && hits(ws, j.title, j.company, j.location))
    .map(j => ({ ...j, live: false }));
}

/* ---------- search ---------- */
async function search(q, ctx, only) {
  const terms = String(q).split('|').map(words).filter(t => t.length).slice(0, 25);
  const ws = terms.length > 1 ? Object.assign([], { alts: terms }) : (terms[0] || []);
  const log = [];
  const tasks = [];
  const want = only ? only.split(',').map(x => x.trim()) : null; // groups: jobicy, wwr, remoteok, arbeitnow, nomads, muse, hn, remotive, boards
  const has = g => !want || want.includes(g);
  const run = (name, fn) => tasks.push(fn().then(
    jobs => { log.push({ name, status: 'ok', count: jobs.length }); return jobs; },
    e => { log.push({ name, status: 'failed', message: String(e.message || e) }); return []; }
  ));

  if (has('jobicy')) run('Jobicy', () => readJobicy(ws, ctx));
  if (has('wwr')) for (const f of WWR_FEEDS) run(f.name, () => readWwr(f, ws, ctx));
  if (has('remoteok')) run('Remote OK', () => readRemoteOk(ws, ctx));
  if (has('arbeitnow')) run('Arbeitnow', () => readArbeitnow(ws, ctx));
  if (has('nomads')) run('Working Nomads', () => readWorkingNomads(ws, ctx));
  if (has('muse')) run('The Muse', () => readMuse(ws, ctx));
  if (has('hn')) run('Hacker News: Who is hiring', () => readHackerNews(ws, ctx));
  if (has('remotive')) run('Remotive (saved)', () => readRemotiveSaved(ws, ctx));

  let boards = { greenhouse: [], lever: [] };
  if (has('boards')) try {
    const cfg = await getCached(new URL('job-sources.json', SITE_URL).href, 'json', ctx);
    boards = { greenhouse: cfg.greenhouse?.boards || cfg.greenhouse || [], lever: cfg.lever?.boards || cfg.lever || [] };
  } catch (e) { log.push({ name: 'Company list (job-sources.json)', status: 'failed', message: String(e.message || e) }); }
  const gh = (Array.isArray(boards.greenhouse) ? boards.greenhouse : []).filter(b => b && b.token && b.enabled !== false);
  const lv = (Array.isArray(boards.lever) ? boards.lever : []).filter(b => b && b.name && b.enabled !== false);
  let room = MAX_COMPANY_BOARDS;
  for (const b of gh) if (room-- > 0) run(`Greenhouse: ${b.company || b.token}`, () => readGreenhouse(b, ws, ctx));
  for (const b of lv) if (room-- > 0) run(`Lever: ${b.company || b.name}`, () => readLever(b, ws, ctx));

  const seen = new Set(), jobs = [];
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  for (const j of (await Promise.all(tasks)).flat()) {
    if (!j.title || !j.link) continue;
    const key = j.link.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() || j.id;
    if (seen.has(key)) continue;
    if (j.datePosted && j.datePosted < cutoff) continue; // more than a month old
    seen.add(key);
    jobs.push(j);
  }
  jobs.sort((a, b) => (a.rank - b.rank) || String(b.datePosted).localeCompare(String(a.datePosted)));
  return { ok: true, q: clean(q), fetchedAt: new Date().toISOString(), count: Math.min(jobs.length, MAX_RESULTS), jobs: jobs.slice(0, MAX_RESULTS), sources: log };
}

/* ---------- entry point ---------- */
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin'
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reply({ ok: false, error: 'Use GET.' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/health') return reply({ ok: true, name: 'job-search-live' });
    if (url.pathname === '/search') {
      if (origin && !allowed) return reply({ ok: false, error: 'This site is not allowed to use the search.' }, 403);
      const q = (url.searchParams.get('q') || '').slice(0, 900);
      try { return reply(await search(q, ctx, (url.searchParams.get('only') || '').slice(0, 60))); }
      catch (e) { return reply({ ok: false, error: String(e.message || e) }, 500); }
    }
    return reply({ ok: false, error: 'Not found. Try /health or /search?q=copywriter' }, 404);
  }
};
