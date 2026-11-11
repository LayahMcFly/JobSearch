/*
  claude-draft — Supabase Edge Function for the Job Search Tracker (Phase 5)

  The app sends a prompt here. This function calls the Claude API with your
  key and sends back the draft text. The key lives only in this project's
  Edge Function secrets, never in the app or the repo.

  One file, no imports, so it can be pasted into the Supabase dashboard editor.
  Setup steps: see README.md in this folder.

  SECRETS (Edge Functions > Secrets in the Supabase dashboard)
    CLAUDE_API_KEY     required  Your Claude API key.
    APP_ACCESS_CODE    required  A long passphrase you also type into the app's
                                 Settings. Requests without it are refused.
    ALLOWED_ORIGINS    required  Sites allowed to call from a browser, comma separated,
                                 for example: https://layahmcfly.github.io
    DRAFT_MAX_TOKENS   optional  Longest reply allowed, thinking included. Default 6000.
    DRAFT_EFFORT       optional  How much Claude thinks first: low, medium (default),
                                 high, or none to leave it unset.

  JWT verification must be OFF for this function (the app has no login; the
  access code does the checking). See README.md, step 3.

  REQUEST  (POST, JSON)  { accessCode, prompt, model, kind }   or   { accessCode, ping: true }
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
const CLAUDE_TIMEOUT_MS = 140000; // Supabase ends a request with no response after 150 seconds

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

const env = name => (Deno.env.get(name) || '').trim();

/* ============================================================
   2. HELPERS
   ============================================================ */
function allowedOrigins() {
  return env('ALLOWED_ORIGINS').split(',').map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
}
function corsHeaders(origin) {
  const ok = origin && allowedOrigins().includes(origin.toLowerCase());
  return ok
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Max-Age': '86400', Vary: 'Origin' }
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
async function handle(req) {
  const origin = req.headers.get('origin') || '';
  const cors = corsHeaders(origin);
  const reply = (status, payload) => json(payload, status, cors);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { ok: false, code: 'method', error: 'Use POST.' });
  if (origin && !cors['Access-Control-Allow-Origin']) {
    return reply(403, { ok: false, code: 'origin', error: `Requests from ${origin} are not allowed. Add it to ALLOWED_ORIGINS.` });
  }

  const key = env('CLAUDE_API_KEY');
  const accessCode = env('APP_ACCESS_CODE');
  if (!key || !accessCode) {
    return reply(500, { ok: false, code: 'not_configured', error: 'CLAUDE_API_KEY or APP_ACCESS_CODE is not set in Edge Function secrets.' });
  }

  let body;
  try { body = await req.json(); }
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
  const maxTokens = Math.min(16000, Math.max(1000, parseInt(env('DRAFT_MAX_TOKENS'), 10) || 6000));
  const effort = (env('DRAFT_EFFORT') || 'medium').toLowerCase();

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
    return reply(502, { ok: false, code: 'network', error: 'The function could not reach the Claude API.' });
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

Deno.serve(handle);
