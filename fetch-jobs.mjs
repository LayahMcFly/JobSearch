#!/usr/bin/env node
/*
  fetch-jobs.mjs — Job finder for the Job Search Tracker (Tracker v2, Phase 2)

  Reads job-sources.json, pulls openings from public job APIs and RSS feeds,
  and writes jobs-feed.json for the app's Job Feed screen.
  It only reads public listings. It never applies or submits anything.

  Runs in GitHub Actions (.github/workflows/fetch-jobs.yml). To run it on
  your own computer with Node 20 or newer:
      ADZUNA_APP_ID=xxx ADZUNA_APP_KEY=yyy node fetch-jobs.mjs
  Adzuna is skipped (not failed) when those two values are missing.

  No dependencies: uses Node's built-in fetch.

  SECTIONS
    1. Settings
    2. Helpers (network, text, dates, matching)
    3. Source readers (Greenhouse, Lever, Remotive, RSS, Adzuna)
    4. Build the source list from job-sources.json
    5. Run every source, merge, write jobs-feed.json and the run log
*/

import { readFile, writeFile, appendFile } from 'node:fs/promises';

/* ============================================================
   1. SETTINGS
   ============================================================ */
const CONFIG_FILE = process.env.JOB_SOURCES_FILE || 'job-sources.json';
const OUTPUT_FILE = process.env.JOBS_FEED_FILE || 'jobs-feed.json';
const REQUEST_TIMEOUT_MS = 25000;
const PAUSE_BETWEEN_SOURCES_MS = 500;
const USER_AGENT = 'JobSearchTracker/2.0 (personal job feed, one run per day)';
const FEED_FORMAT = 1;
const DEFAULT_LIMITS = { maxAgeDays: 30, maxJobsPerSource: 200, maxDescriptionChars: 12000 };

/* ============================================================
   2. HELPERS
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Keep secret values out of logs and the feed file, whatever an error message contains.
function redact(text) {
  let s = String(text || '');
  for (const secret of [process.env.ADZUNA_APP_ID, process.env.ADZUNA_APP_KEY]) {
    if (secret) s = s.split(secret).join('***');
  }
  return s.replace(/(app_id|app_key)=[^&\s]+/gi, '$1=***');
}

// One GET request with a timeout. Retries once on network errors, 429 and 5xx.
async function request(url, accept = 'application/json', tries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: ctrl.signal, redirect: 'follow' });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
      if (res.status < 500 && res.status !== 429) break; // other 4xx errors won't fix themselves
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`No response after ${REQUEST_TIMEOUT_MS / 1000} seconds`) : e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < tries) await sleep(3000);
  }
  throw lastErr;
}
async function getJson(url) {
  const res = await request(url);
  try { return await res.json(); }
  catch { throw new Error('Response was not valid JSON'); }
}
async function getText(url) {
  return (await request(url, 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*')).text();
}

// HTML and XML text
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', trade: '™', reg: '®', copy: '©', eacute: 'é'
};
function decodeEntities(s = '') {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}
function htmlToText(html = '') {
  let s = String(html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split('\n')
    .map(line => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
function clip(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max).trimEnd() + `\n\n[Cut at ${max} characters. Open the job link for the full posting.]` : s;
}
const titleCase = s => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Dates: every job gets a YYYY-MM-DD datePosted when the source provides one.
function isoDate(v) {
  if (v === null || v === undefined || v === '') return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).trim());
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// Remote type from location or title text. Descriptions are not used: they mention "remote" too loosely.
function inferRemote(...parts) {
  const s = parts.filter(Boolean).join(' ');
  if (/\bhybrid\b/i.test(s)) return 'Hybrid';
  if (/\b(remote|work from home|wfh|anywhere)\b/i.test(s)) return 'Remote';
  if (/\b(on-?site|in[- ]office|in person)\b/i.test(s)) return 'Onsite';
  return '';
}

// Pay range written in the posting, e.g. "$60,000 - $75,000" or "$45/hr to $55/hr".
const PAY_UNIT = String.raw`(?:\s*(?:\/|per)\s*(?:hour|hr|year|yr|annum|annually|month|mo))?`;
const PAY_RE = new RegExp(String.raw`(?:US)?\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?` + PAY_UNIT +
  String.raw`\s*(?:-|–|—|to)\s*(?:US)?\$?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?` + PAY_UNIT);
function findPay(text) {
  const m = String(text || '').match(PAY_RE);
  return m ? clean(m[0]) : '';
}
const money = (n, symbol = '$') => symbol + Math.round(Number(n)).toLocaleString('en-US');

// Matching rules. Keep normText and normLink identical to section 6 of the app so duplicates line up.
function normText(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function normLink(s) {
  let u = String(s || '').trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('#')[0];
  const [path, query = ''] = u.split('?');
  const kept = query.split('&')
    .filter(p => p && !/^(utm_[^=]*|ref|refid|trk|trackingid|gh_src|lever-source|lever-origin|src|source)=/.test(p))
    .sort().join('&');
  return path.replace(/\/+$/, '') + (kept ? '?' + kept : '');
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = w => new RegExp('(^|[^a-z0-9])' + escapeRe(w.toLowerCase()) + '(s|es)?(?![a-z0-9])', 'i');

/* ============================================================
   3. SOURCE READERS
   Each reader returns plain objects:
   { externalId, title, company, link, location, remoteType, payRange,
     datePosted, description, descriptionIsSnippet }
   Missing fields are filled or inferred in makeJob().
   ============================================================ */

// Greenhouse public job board API. Board token = the word after
// boards.greenhouse.io/ or job-boards.greenhouse.io/ in a job link.
// The list endpoint gives a last-updated date, not the first-posted date.
async function readGreenhouse({ token, company }) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;
  let name = company;
  if (!name) {
    try { name = (await getJson(base)).name; } catch { /* use the token below */ }
  }
  name = name || titleCase(token);
  const data = await getJson(`${base}/jobs?content=true`);
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected response: no jobs list');
  return data.jobs.map(j => ({
    externalId: `${token}:${j.id}`,
    title: j.title,
    company: name,
    link: j.absolute_url,
    location: j.location?.name || '',
    datePosted: isoDate(j.first_published || j.updated_at),
    description: htmlToText(decodeEntities(j.content || '')) // Greenhouse sends HTML as escaped entities
  }));
}

// Lever public postings API. Company name = the word after jobs.lever.co/ in a job link.
async function readLever({ name, company, region }) {
  const host = region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const data = await getJson(`https://${host}/v0/postings/${encodeURIComponent(name)}?mode=json`);
  if (!Array.isArray(data)) throw new Error('Unexpected response: no postings list');
  return data.map(p => {
    const lists = (p.lists || []).map(l => `${l.text || ''}\n${htmlToText(l.content || '')}`).join('\n\n');
    const description = [p.descriptionPlain || htmlToText(p.description || ''), lists, p.additionalPlain || htmlToText(p.additional || '')]
      .filter(Boolean).join('\n\n').trim();
    const wt = String(p.workplaceType || '').toLowerCase();
    const remoteType = wt === 'remote' ? 'Remote' : wt === 'hybrid' ? 'Hybrid' : wt === 'onsite' ? 'Onsite' : '';
    let payRange = '';
    const sr = p.salaryRange;
    if (sr && (sr.min || sr.max)) {
      const sym = !sr.currency || sr.currency === 'USD' ? '$' : sr.currency + ' ';
      const per = { 'per-year-salary': ' a year', 'per-month-salary': ' a month', 'per-hour-wage': ' an hour', 'one-time': ' one time' };
      payRange = [sr.min, sr.max].filter(Boolean).map(n => money(n, sym)).join('–') +
        (sr.interval ? (per[sr.interval] || ' ' + String(sr.interval).replace(/-/g, ' ')) : '');
    }
    return {
      externalId: `${name}:${p.id}`,
      title: p.text,
      company: company || titleCase(name),
      link: p.hostedUrl || p.applyUrl,
      applyLink: p.applyUrl && p.applyUrl !== p.hostedUrl ? p.applyUrl : '',
      location: p.categories?.location || (p.categories?.allLocations || []).join(', '),
      remoteType,
      payRange,
      datePosted: isoDate(p.createdAt),
      description
    };
  });
}

// Remotive public API. Terms: name Remotive as the source and link back to the
// Remotive job page (the job link does this), fetch at most 4 times a day.
async function readRemotive({ category, search }) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (search) params.set('search', search);
  const data = await getJson(`https://remotive.com/api/remote-jobs?${params}`);
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected response: no jobs list');
  return data.jobs.map(j => ({
    externalId: String(j.id),
    title: j.title,
    company: j.company_name,
    link: j.url,
    location: j.candidate_required_location || '',
    remoteType: 'Remote',
    payRange: clean(j.salary),
    datePosted: isoDate(j.publication_date),
    description: htmlToText(j.description || '')
  }));
}

// RSS 2.0 or Atom feeds. Small regex reader, enough for job board feeds.
function xmlTag(block, name) {
  const m = block.match(new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRe(name)}>`, 'i'));
  return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim() : '';
}
async function readRss(feed) {
  const xml = await getText(feed.url);
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  if (!items.length && !/<(rss|feed|rdf)[\s>]/i.test(xml)) throw new Error('Response is not an RSS or Atom feed');
  return items.map(it => {
    let title = htmlToText(xmlTag(it, 'title'));
    let company = feed.company || '';
    // We Work Remotely titles look like "Company: Job title"
    if (!company && feed.titleFormat === 'company: title') {
      const i = title.indexOf(': ');
      if (i > 0) { company = title.slice(0, i).trim(); title = title.slice(i + 2).trim(); }
    }
    if (!company) company = htmlToText(xmlTag(it, 'company') || xmlTag(it, 'dc:creator'));
    let link = decodeEntities(xmlTag(it, 'link'));
    if (!link) { const m = it.match(/<link[^>]*href="([^"]+)"/i); if (m) link = decodeEntities(m[1]); }
    let raw = xmlTag(it, 'content:encoded') || xmlTag(it, 'description') || xmlTag(it, 'summary') || xmlTag(it, 'content');
    if (!/<[a-z]/i.test(raw) && /&lt;/i.test(raw)) raw = decodeEntities(raw); // HTML sent as escaped text
    const guid = htmlToText(xmlTag(it, 'guid') || xmlTag(it, 'id')) || link || title;
    return {
      externalId: `${slug(feed.name)}:${guid}`,
      title,
      company,
      link,
      location: htmlToText(xmlTag(it, 'region') || xmlTag(it, 'location')),
      remoteType: feed.remoteType || '',
      datePosted: isoDate(xmlTag(it, 'pubDate') || xmlTag(it, 'published') || xmlTag(it, 'updated') || xmlTag(it, 'dc:date')),
      description: htmlToText(raw)
    };
  });
}

// Adzuna search API (needs a free developer account). Adzuna returns only a
// short snippet of each description, so those jobs are marked as snippets.
async function readAdzuna(search, country) {
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID,
    app_key: process.env.ADZUNA_APP_KEY,
    results_per_page: String(Math.min(Number(search.resultsPerPage) || 50, 50)),
    what: search.what,
    'content-type': 'application/json'
  });
  if (search.where) params.set('where', search.where);
  if (search.maxDaysOld) params.set('max_days_old', String(search.maxDaysOld));
  if (search.whatExclude) params.set('what_exclude', search.whatExclude);
  const data = await getJson(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params}`);
  if (!Array.isArray(data.results)) throw new Error('Unexpected response: no results list');
  const sym = { us: '$', ca: 'C$', au: 'A$', nz: 'NZ$', gb: '£' }[country] ?? '';
  return data.results.map(r => {
    let payRange = '';
    const lo = Number(r.salary_min) || 0, hi = Number(r.salary_max) || 0;
    if (lo || hi) {
      payRange = (lo && hi && lo !== hi ? `${money(lo, sym)}–${money(hi, sym)}` : money(lo || hi, sym)) + ' a year' +
        (String(r.salary_is_predicted) === '1' ? ' (Adzuna estimate)' : '');
    }
    const title = htmlToText(r.title || '');
    const location = r.location?.display_name || '';
    return {
      externalId: String(r.id),
      title,
      company: r.company?.display_name || '',
      link: r.redirect_url,
      location,
      remoteType: inferRemote(title, location),
      payRange,
      datePosted: isoDate(r.created),
      description: htmlToText(r.description || ''),
      descriptionIsSnippet: true
    };
  });
}

/* ============================================================
   4. BUILD THE SOURCE LIST FROM job-sources.json
   Order matters for duplicates: the first source to list a job keeps it,
   so sources with full descriptions run before Adzuna's snippets.
   ============================================================ */
function hostLabel(url) {
  try { return titleCase(new URL(url).hostname.replace(/^www\./, '').split('.')[0]); }
  catch { return 'RSS'; }
}
function buildSources(config) {
  const list = [];
  for (const g of config.greenhouse || []) {
    const o = typeof g === 'string' ? { token: g } : g;
    if (!o || !o.token) continue;
    list.push({ type: 'greenhouse', label: 'Greenhouse', name: `Greenhouse: ${o.company || o.token}`, run: () => readGreenhouse(o) });
  }
  for (const l of config.lever || []) {
    const o = typeof l === 'string' ? { name: l } : l;
    if (!o || !o.name) continue;
    list.push({ type: 'lever', label: 'Lever', name: `Lever: ${o.company || o.name}`, run: () => readLever(o) });
  }
  if (config.remotive && config.remotive.enabled) {
    list.push({ type: 'remotive', label: 'Remotive', name: `Remotive: ${config.remotive.category || 'all categories'}`, run: () => readRemotive(config.remotive) });
  }
  for (const f of config.rss || []) {
    if (!f || !f.url) continue;
    const name = f.name || f.url;
    list.push({ type: 'rss', label: f.label || hostLabel(f.url), name: `RSS: ${name}`, run: () => readRss({ ...f, name }) });
  }
  const az = config.adzuna;
  if (az && Array.isArray(az.searches)) {
    const hasKeys = Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
    const country = String(az.country || 'us').toLowerCase();
    for (const s of az.searches) {
      if (!s || !s.what) continue;
      list.push({
        type: 'adzuna', label: 'Adzuna',
        name: `Adzuna: "${s.what}"${s.where ? ' in ' + s.where : ''}`,
        skip: hasKeys ? '' : 'ADZUNA_APP_ID and ADZUNA_APP_KEY secrets are not set',
        run: () => readAdzuna(s, country)
      });
    }
  }
  return list;
}

function makeJob(src, f, limits) {
  const description = clip(f.description, limits.maxDescriptionChars);
  const location = clean(f.location);
  return {
    id: `${src.type}:${f.externalId}`,
    title: clean(f.title),
    company: clean(f.company),
    link: String(f.link || '').trim(),
    ...(f.applyLink ? { applyLink: String(f.applyLink).trim() } : {}),
    source: src.label,
    sourceName: src.name,
    location,
    remoteType: f.remoteType || inferRemote(location, f.title),
    payRange: clean(f.payRange) || findPay(f.description),
    datePosted: f.datePosted || '',
    description,
    descriptionIsSnippet: Boolean(f.descriptionIsSnippet)
  };
}

/* ============================================================
   5. RUN, MERGE, WRITE
   ============================================================ */
async function readPrevious() {
  try { return JSON.parse(await readFile(OUTPUT_FILE, 'utf8')); }
  catch { return null; }
}

async function writeSummary(log, jobCount) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = log.map(l => `| ${l.status === 'ok' ? 'OK' : l.status === 'skipped' ? 'Skipped' : 'Failed'} | ${cell(l.name)} | ${cell(l.status === 'ok' ? `${l.count} kept of ${l.fetched}` : l.message)} |`);
  const md = ['## Job feed run', '',
    jobCount === null ? '**Every source failed. jobs-feed.json was not changed.**' : `**${jobCount} jobs written to ${OUTPUT_FILE}.**`,
    '', '| Result | Source | Details |', '| --- | --- | --- |', ...rows, ''].join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
}

async function main() {
  let config;
  try { config = JSON.parse(await readFile(CONFIG_FILE, 'utf8')); }
  catch (e) { throw new Error(`Could not read ${CONFIG_FILE}: ${e.message}`); }

  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const pre = config.prefilter || {};
  const preTitles = (pre.titleKeywords || []).map(normText).filter(Boolean);
  const preExcluded = (pre.excludedWords || []).filter(Boolean).map(wordRe);
  const cutoff = limits.maxAgeDays ? isoDate(Date.now() - limits.maxAgeDays * 86400000) : '';
  const now = new Date().toISOString();

  const previous = await readPrevious();
  const firstSeen = new Map((previous?.jobs || []).map(j => [j.id, j.firstSeenAt]));

  const sources = buildSources(config);
  const log = [];
  const all = [];

  for (const src of sources) {
    if (src.skip) {
      log.push({ name: src.name, type: src.type, status: 'skipped', count: 0, message: src.skip });
      console.log(`SKIP  ${src.name}: ${src.skip}`);
      continue;
    }
    const t0 = Date.now();
    try {
      const raw = await src.run();
      const jobs = raw.filter(f => f && f.title && f.link).map(f => makeJob(src, f, limits));
      const kept = jobs
        .filter(j => !cutoff || !j.datePosted || j.datePosted >= cutoff)
        .filter(j => !preTitles.length || preTitles.some(k => normText(j.title).includes(k)))
        .filter(j => !preExcluded.some(re => re.test(j.title)))
        .sort((a, b) => b.datePosted.localeCompare(a.datePosted))
        .slice(0, limits.maxJobsPerSource);
      all.push(...kept);
      log.push({ name: src.name, type: src.type, status: 'ok', count: kept.length, fetched: jobs.length, ms: Date.now() - t0 });
      console.log(`OK    ${src.name}: kept ${kept.length} of ${jobs.length}`);
    } catch (e) {
      const message = redact(e?.message || String(e));
      log.push({ name: src.name, type: src.type, status: 'failed', count: 0, message, ms: Date.now() - t0 });
      console.log(`FAIL  ${src.name}: ${message}`);
    }
    await sleep(PAUSE_BETWEEN_SOURCES_MS);
  }

  // Remove duplicates across sources: same id, same link, or same company + title.
  const seen = new Set();
  const merged = [];
  for (const j of all) {
    const tk = normText(j.company) && normText(j.title) ? 't:' + normText(j.company) + '|' + normText(j.title) : '';
    const keys = [j.id, normLink(j.link) ? 'l:' + normLink(j.link) : '', tk].filter(Boolean);
    if (keys.some(k => seen.has(k))) continue;
    keys.forEach(k => seen.add(k));
    j.firstSeenAt = firstSeen.get(j.id) || now;
    merged.push(j);
  }
  merged.sort((a, b) => b.datePosted.localeCompare(a.datePosted));

  const ran = log.filter(l => l.status !== 'skipped');
  if (ran.length && !ran.some(l => l.status === 'ok')) {
    console.error('Every source failed. jobs-feed.json was not changed.');
    await writeSummary(log, null);
    process.exitCode = 1;
    return;
  }

  const output = { app: 'job-search-tracker', feedFormat: FEED_FORMAT, generatedAt: now, sources: log, jobs: merged };
  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 1) + '\n');
  console.log(`\nWrote ${merged.length} jobs to ${OUTPUT_FILE}. ${ran.filter(l => l.status === 'ok').length} of ${ran.length} sources worked.`);
  await writeSummary(log, merged.length);
}

main().catch(e => {
  console.error(redact(e?.stack || e?.message || String(e)));
  process.exit(1);
});
