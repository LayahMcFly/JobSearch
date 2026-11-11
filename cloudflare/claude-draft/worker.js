/*
  claude-draft — Cloudflare Worker for the Job Search Tracker (Phase 5)

  The app sends a prompt here. This Worker calls the Claude API with your
  key and sends back the draft text. The key lives only in this Worker's
  encrypted secrets, never in the app or the repo.

  Normally this runs inside the "jobsearch" Worker, which also hosts the app:
  the app calls  https://jobsearch.<you>.workers.dev/api/draft  and
  Cloudflare builds both from GitHub (see wrangler.jsonc at the repo root).
  It also works pasted on its own into a separate Worker.
  Setup steps: see README.md in this folder.

  Cloudflare Workers Free plan: 100,000 requests a day, no time limit while
  the browser waits, and time spent waiting on Claude doesn't count toward
  the 10 ms CPU limit.

  SECRETS (Worker > Settings > Variables and Secrets, type "Secret")
    CLAUDE_API_KEY     required  Your Claude API key.
    APP_ACCESS_CODE    required  A long passphrase you also type into the app's
                                 Settings. Requests without it are refused.
    ALLOWED_ORIGINS    required  Sites allowed to call from a browser, comma separated,
                                 for example: https://layahmcfly.github.io
    DRAFT_MAX_TOKENS   optional  Longest reply allowed, thinking included. Default 6000.
    DRAFT_EFFORT       optional  How much Claude thinks first: low, medium (default),
                                 high, or none to leave it unset.

  REQUEST  (POST, JSON body; the app sends it as text/plain so browsers skip
           the CORS preflight)  { accessCode, prompt, model, kind }   or   { accessCode, ping: true }
  REPLY    { ok: true, text, model, stopReason, usage: { input, output } }
           { ok: false, code, error }   codes are listed in ERROR_CODES below

  SECTIONS
    1. Settings
    2. Helpers (CORS, access code check, replies)
    3. Claude API call
    4. Request handler
*/

/* ============================================================
   1. SETTINGS
   ============================================================ */
const MODELS = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5' };
const DEFAULT_MODEL = 'claude-haiku-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_PROMPT_CHARS = 200000;
const CLAUDE_TIMEOUT_MS = 170000; // give up on Claude after this; the app waits a little longer

// Claude API status -> code the app turns into a plain-language message
const ERROR_CODES = {
  400: 'claude_request',   // includes "spend limit reached" and "credit balance too low"
  401: 'claude_key',
  402: 'billing',
  403: 'claude_permission',
  404: 'claude_model',
  413: 'too_large',
  429: 'rate_limit',
  500: 'claude_error',
  504: 'claude_timeout',
  529: 'overloaded'
};

/* ============================================================
   2. HELPERS
   ============================================================ */
const read = (env, name) => String((env && env[name]) || '').trim();

// Accepts sloppy entries: quotes, spaces, missing https://, or a path such as /JobSearch.
function normalizeOrigin(s) {
  s = String(s || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!s) return '';
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).origin.toLowerCase(); }
  catch { return s.replace(/\/+$/, '').toLowerCase(); }
}
function allowedOrigins(env) {
  return read(env, 'ALLOWED_ORIGINS').split(',').map(normalizeOrigin).filter(Boolean);
}
// The browser is always allowed to read the reply, so the app can show a clear
// message (including "this site isn't allowed"). The access code still protects
// the Worker, and requests from sites not in ALLOWED_ORIGINS are refused below.
function corsHeaders(origin) {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
}
// Compare secrets without leaking how many characters matched.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b)))
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

/* ============================================================
   3. CLAUDE API CALL
   ============================================================ */
async function callClaude({ key, model, prompt, maxTokens, effort }) {
  const payload = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (effort && effort !== 'none') payload.output_config = { effort };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    return { r, data };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   4. REQUEST HANDLER
   ============================================================ */
async function handle(request, env) {
  const origin = request.headers.get('origin') || '';
  const cors = corsHeaders(origin);
  const reply = (status, payload) => json(payload, status, cors);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    // Opening this address in a browser shows which settings the running Worker can see.
    // Only yes/no is shown, never the values.
    const has = name => read(env, name) !== '';
    return reply(405, {
      ok: false, code: 'method', error: 'Use POST.',
      setup: {
        CLAUDE_API_KEY: has('CLAUDE_API_KEY'),
        APP_ACCESS_CODE: has('APP_ACCESS_CODE'),
        ALLOWED_ORIGINS: has('ALLOWED_ORIGINS')
      },
      note: 'false means the running Worker cannot see that setting. Add it under the Worker > Settings > Variables and Secrets (not under Build), type Secret, then Deploy.'
    });
  }
  // The app hosted by this same Worker (at /api/draft) is always allowed.
  const sameSite = origin && normalizeOrigin(origin) === normalizeOrigin(new URL(request.url).origin);
  if (origin && !sameSite) {
    const allowed = allowedOrigins(env);
    if (!allowed.length) {
      return reply(403, { ok: false, code: 'origin_unset', error: 'ALLOWED_ORIGINS is not set in the Worker secrets.' });
    }
    if (!allowed.includes(normalizeOrigin(origin))) {
      return reply(403, { ok: false, code: 'origin', error: `Requests from ${origin} are not allowed. Add it to ALLOWED_ORIGINS.` });
    }
  }

  const key = read(env, 'CLAUDE_API_KEY');
  const accessCode = read(env, 'APP_ACCESS_CODE');
  if (!key || !accessCode) {
    const missing = [!key && 'CLAUDE_API_KEY', !accessCode && 'APP_ACCESS_CODE'].filter(Boolean);
    return reply(500, { ok: false, code: 'not_configured', missing,
      error: `The running Worker cannot see: ${missing.join(' and ')}. Add it under the Worker > Settings > Variables and Secrets (not under Build), then Deploy.` });
  }

  let body;
  try { body = await request.json(); }
  catch { return reply(400, { ok: false, code: 'bad_json', error: 'The request was not valid JSON.' }); }
  body = body && typeof body === 'object' ? body : {};

  if (!body.accessCode || !(await sameSecret(body.accessCode, accessCode))) {
    return reply(401, { ok: false, code: 'access_code', error: 'The access code does not match APP_ACCESS_CODE.' });
  }
  // "Test connection" in the app: checks setup without calling Claude or spending anything.
  if (body.ping) return reply(200, { ok: true, ping: true, models: Object.keys(MODELS) });

  const model = MODELS[body.model] ? body.model : DEFAULT_MODEL;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return reply(400, { ok: false, code: 'empty_prompt', error: 'The prompt was empty.' });
  if (prompt.length > MAX_PROMPT_CHARS) return reply(413, { ok: false, code: 'too_large', error: 'The prompt is too long.' });
  const maxTokens = Math.min(16000, Math.max(1000, parseInt(read(env, 'DRAFT_MAX_TOKENS'), 10) || 6000));
  const effort = (read(env, 'DRAFT_EFFORT') || 'medium').toLowerCase();

  let r, data;
  try {
    ({ r, data } = await callClaude({ key, model, prompt, maxTokens, effort }));
    // If this model rejects the effort setting, try once without it.
    if (r.status === 400 && /effort|output_config/i.test(data?.error?.message || '')) {
      console.log('Retrying without output_config.effort');
      ({ r, data } = await callClaude({ key, model, prompt, maxTokens, effort: 'none' }));
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      return reply(504, { ok: false, code: 'claude_timeout', error: `Claude did not finish within ${CLAUDE_TIMEOUT_MS / 1000} seconds.` });
    }
    console.error('Claude request failed: ' + (e?.message || e));
    return reply(502, { ok: false, code: 'network', error: 'The Worker could not reach the Claude API.' });
  }

  if (!r.ok) {
    // Log the type only. Prompts and drafts are never written to the logs.
    console.log(`Claude error ${r.status}: ${data?.error?.type || 'unknown'}`);
    return reply(r.status >= 500 ? 502 : r.status, {
      ok: false,
      code: ERROR_CODES[r.status] || 'claude_error',
      claudeStatus: r.status,
      error: data?.error?.message || `Claude API error ${r.status}`,
      requestId: data?.request_id || ''
    });
  }

  if (data?.stop_reason === 'refusal') {
    return reply(200, { ok: false, code: 'refusal', error: 'Claude declined to write this draft.' });
  }
  const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) return reply(502, { ok: false, code: 'empty', error: 'Claude returned no text.' });

  const usage = { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 };
  console.log(`Draft done: ${model}, ${usage.input} input tokens, ${usage.output} output tokens, stop: ${data.stop_reason}`);
  return reply(200, { ok: true, text, model: data.model || model, stopReason: data.stop_reason, usage });
}

export default {
  async fetch(request, env) {
    try {
      // Two ways to run this file:
      // 1. Inside the "jobsearch" Worker that also hosts the app (wrangler.jsonc at the repo root).
      //    Only /api/* reaches this code; everything else is the app's files, served by ASSETS.
      // 2. On its own Worker, where every request is a drafting request.
      if (env && env.ASSETS && !new URL(request.url).pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }
      return await handle(request, env);
    } catch (e) {
      // Never fail silently: an unexpected error still comes back as JSON the app can read.
      console.error('Unexpected error: ' + (e?.stack || e?.message || e));
      const origin = request.headers.get('origin') || '';
      return json({ ok: false, code: 'worker_error', error: 'The Worker hit an unexpected error. Check its Logs in Cloudflare.' }, 500, corsHeaders(origin));
    }
  }
};
