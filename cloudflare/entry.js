/*
  Entry point for the "jobsearch" and "job-search-live" Workers, both built from this repo.
  - /search and /health  -> live job search (worker/live-search.js)
  - everything else      -> what the repo did before (AI drafting at /api/*, the app's files)
*/
import draft from './claude-draft/worker.js';
import live from '../worker/live-search.js';

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/search' || path === '/health') return live.fetch(request, env, ctx);
    return draft.fetch(request, env, ctx);
  }
};
