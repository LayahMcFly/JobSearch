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
const MAX_RESULTS = 100;
const MAX_COMPANY_BOARDS = 25;  // Greenhouse + Lever boards read per search (50 request limit)
const MAX_DESC = 6000;
const USER_AGENT = 'JobSearchTracker/2.0 (personal live search)';

const WWR_FEEDS = [
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
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_DESC);
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
// Every search word must appear in the job's title, company, location or tags.
function hits(ws, ...fields) {
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
    live: true
  };
}

/* ---------- readers: each returns [] or throws ---------- */
async function readJobicy(ws, ctx) {
  const src = { type: 'jobicy', label: 'Jobicy', name: 'Jobicy (live)' };
  // Jobicy's own tag search finds the most relevant posts; matching below is stricter.
  const tag = encodeURIComponent(ws.join(' '));
  const data = await getCached(`https://jobicy.com/api/v2/remote-jobs?count=50${ws.length ? '&tag=' + tag : ''}`, 'json', ctx);
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected response');
  return data.jobs
    .filter(j => hits(ws, j.jobTitle, j.companyName, j.jobGeo, (j.jobIndustry || []).join(' '), (j.jobType || []).join(' ')))
    .map(j => job(src, {
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
    if (!hits(ws, title, company, region)) continue; // cheap check before any text conversion
    const link = decode(xmlTag(it, 'link'));
    out.push(job(src, {
      externalId: decode(xmlTag(it, 'guid')) || link, title, company, link, location: region,
      remoteType: 'Remote', datePosted: isoDate(xmlTag(it, 'pubDate')),
      description: toText(decode(xmlTag(it, 'description')))
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
  return data.filter(p => hits(ws, p.text, b.company || b.name, p.categories?.location, p.categories?.team))
    .map(p => {
      const wt = String(p.workplaceType || '').toLowerCase();
      return job(src, {
        externalId: `${b.name}:${p.id}`, title: p.text, company: b.company || titleCase(b.name), link: p.hostedUrl || p.applyUrl,
        applyLink: p.applyUrl && p.applyUrl !== p.hostedUrl ? p.applyUrl : '',
        location: p.categories?.location || (p.categories?.allLocations || []).join(', '),
        remoteType: wt === 'remote' ? 'Remote' : wt === 'hybrid' ? 'Hybrid' : wt === 'onsite' ? 'Onsite' : '',
        datePosted: isoDate(p.createdAt),
        description: p.descriptionPlain || toText(p.description || '')
      });
    });
}

// Remotive asks for 4 requests a day, so live search never calls it.
// It searches the jobs the 3-hour GitHub run already saved from Remotive.
async function readRemotiveSaved(ws, ctx) {
  const feed = await getCached(new URL('jobs-feed.json', SITE_URL).href, 'json', ctx);
  return (feed.jobs || []).filter(j => /^remotive:/.test(j.id || '') && hits(ws, j.title, j.company, j.location))
    .map(j => ({ ...j, live: false }));
}

/* ---------- search ---------- */
async function search(q, ctx) {
  const ws = words(q);
  const log = [];
  const tasks = [];
  const run = (name, fn) => tasks.push(fn().then(
    jobs => { log.push({ name, status: 'ok', count: jobs.length }); return jobs; },
    e => { log.push({ name, status: 'failed', message: String(e.message || e) }); return []; }
  ));

  run('Jobicy', () => readJobicy(ws, ctx));
  for (const f of WWR_FEEDS) run(f.name, () => readWwr(f, ws, ctx));
  run('Remotive (saved)', () => readRemotiveSaved(ws, ctx));

  let boards = { greenhouse: [], lever: [] };
  try {
    const cfg = await getCached(new URL('job-sources.json', SITE_URL).href, 'json', ctx);
    boards = { greenhouse: cfg.greenhouse?.boards || cfg.greenhouse || [], lever: cfg.lever?.boards || cfg.lever || [] };
  } catch (e) { log.push({ name: 'Company list (job-sources.json)', status: 'failed', message: String(e.message || e) }); }
  const gh = (Array.isArray(boards.greenhouse) ? boards.greenhouse : []).filter(b => b && b.token && b.enabled !== false);
  const lv = (Array.isArray(boards.lever) ? boards.lever : []).filter(b => b && b.name && b.enabled !== false);
  let room = MAX_COMPANY_BOARDS;
  for (const b of gh) if (room-- > 0) run(`Greenhouse: ${b.company || b.token}`, () => readGreenhouse(b, ws, ctx));
  for (const b of lv) if (room-- > 0) run(`Lever: ${b.company || b.name}`, () => readLever(b, ws, ctx));

  const seen = new Set(), jobs = [];
  for (const j of (await Promise.all(tasks)).flat()) {
    if (!j.title || !j.link) continue;
    const key = j.link.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() || j.id;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(j);
  }
  jobs.sort((a, b) => String(b.datePosted).localeCompare(String(a.datePosted)));
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
      const q = (url.searchParams.get('q') || '').slice(0, 120);
      try { return reply(await search(q, ctx)); }
      catch (e) { return reply({ ok: false, error: String(e.message || e) }, 500); }
    }
    return reply({ ok: false, error: 'Not found. Try /health or /search?q=copywriter' }, 404);
  }
};
