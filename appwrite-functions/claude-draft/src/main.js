/*
  claude-draft — Appwrite Function for the Job Search Tracker (Phase 5)

  The app sends a prompt here. This function calls the Claude API with your
  key and sends back the draft text. The key lives only in this function's
  environment variables, never in the app or the repo.

  Setup steps: see README.md in this folder.

  ENVIRONMENT VARIABLES
    CLAUDE_API_KEY     required  Your Claude API key (mark it as secret).
    APP_ACCESS_CODE    required  A long passphrase you also type into the app's
                                 Settings. Requests without it are refused.
    ALLOWED_ORIGINS    required  Sites allowed to call from a browser, comma separated,
                                 for example: https://layahmcfly.github.io
    DRAFT_MAX_TOKENS   optional  Longest draft allowed, default 4000.
    DRAFT_EFFORT       optional  How much Claude thinks first: low (default), medium,
                                 high, or none to leave it unset. Low keeps replies
                                 inside Appwrite's 60-second limit.

  REQUEST  (POST, JSON)  { accessCode, prompt, model, kind }   or   { accessCode, ping: true }
  REPLY    { ok: true, text, model, stopReason, usage: { input, output } }
           { ok: false, code, error }   codes are listed in ERROR_CODES below

  SECTIONS
    1. Settings
    2. Helpers (CORS, access code check)
    3. Claude API call
    4. Request handler
*/

import { createHash, timingSafeEqual } from 'node:crypto';

/* ============================================================
   1. SETTINGS
   ============================================================ */
const MODELS = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5' };
const DEFAULT_MODEL = 'claude-haiku-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_PROMPT_CHARS = 200000;
const CLAUDE_TIMEOUT_MS = 55000; // calls through the function's domain end at 60 seconds

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
function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
}
function corsHeaders(origin) {
  const ok = origin && allowedOrigins().includes(origin.toLowerCase());
  return ok
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
}
// Compare secrets without leaking how many characters matched.
function sameSecret(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
function readBody(req) {
  if (req.bodyJson && typeof req.bodyJson === 'object') return req.bodyJson;
  const raw = req.bodyText ?? req.body ?? '';
  if (raw && typeof raw === 'object') return raw;
  return raw ? JSON.parse(raw) : {};
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
export default async ({ req, res, log, error }) => {
  const origin = req.headers?.origin || '';
  const cors = corsHeaders(origin);
  const reply = (status, payload) => res.json(payload, status, cors);

  if (req.method === 'OPTIONS') return res.send('', 204, cors);
  if (req.method !== 'POST') return reply(405, { ok: false, code: 'method', error: 'Use POST.' });
  if (origin && !cors['Access-Control-Allow-Origin']) {
    return reply(403, { ok: false, code: 'origin', error: `Requests from ${origin} are not allowed. Add it to ALLOWED_ORIGINS.` });
  }

  const key = process.env.CLAUDE_API_KEY;
  const accessCode = process.env.APP_ACCESS_CODE;
  if (!key || !accessCode) {
    return reply(500, { ok: false, code: 'not_configured', error: 'CLAUDE_API_KEY or APP_ACCESS_CODE is not set in the function.' });
  }

  let body;
  try { body = readBody(req); }
  catch { return reply(400, { ok: false, code: 'bad_json', error: 'The request was not valid JSON.' }); }

  if (!body.accessCode || !sameSecret(body.accessCode, accessCode)) {
    return reply(401, { ok: false, code: 'access_code', error: 'The access code does not match APP_ACCESS_CODE.' });
  }
  // "Test connection" in the app: checks setup without calling Claude or spending anything.
  if (body.ping) return reply(200, { ok: true, ping: true, models: Object.keys(MODELS) });

  const model = MODELS[body.model] ? body.model : DEFAULT_MODEL;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return reply(400, { ok: false, code: 'empty_prompt', error: 'The prompt was empty.' });
  if (prompt.length > MAX_PROMPT_CHARS) return reply(413, { ok: false, code: 'too_large', error: 'The prompt is too long.' });
  const maxTokens = Math.min(8000, Math.max(500, parseInt(process.env.DRAFT_MAX_TOKENS, 10) || 4000));
  const effort = String(process.env.DRAFT_EFFORT || 'low').toLowerCase();

  let r, data;
  try {
    ({ r, data } = await callClaude({ key, model, prompt, maxTokens, effort }));
    // If this model rejects the effort setting, try once without it.
    if (r.status === 400 && /effort|output_config/i.test(data?.error?.message || '')) {
      log('Retrying without output_config.effort');
      ({ r, data } = await callClaude({ key, model, prompt, maxTokens, effort: 'none' }));
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      return reply(504, { ok: false, code: 'claude_timeout', error: `Claude did not finish within ${CLAUDE_TIMEOUT_MS / 1000} seconds.` });
    }
    error('Claude request failed: ' + e.message);
    return reply(502, { ok: false, code: 'network', error: 'The function could not reach the Claude API.' });
  }

  if (!r.ok) {
    // Log the type only. Prompts and drafts are never written to the logs.
    log(`Claude error ${r.status}: ${data?.error?.type || 'unknown'}`);
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
  log(`Draft done: ${model}, ${usage.input} input tokens, ${usage.output} output tokens, stop: ${data.stop_reason}`);
  return reply(200, { ok: true, text, model: data.model || model, stopReason: data.stop_reason, usage });
};
