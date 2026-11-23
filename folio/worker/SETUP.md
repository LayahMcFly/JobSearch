# Folio publishing: setup (browser only)

Nothing in this folder has been deployed. Nothing is created until you approve the exact actions listed in section 1.
You do not need a terminal, Node, or any command. Everything below is done in the Cloudflare dashboard and on github.com.

## 1. Exact actions that need your approval

| # | Action | Where | Cost / billing |
|---|--------|-------|----------------|
| 1 | Create one D1 database named `folio-pages` | Cloudflare dashboard > Storage & databases > D1 | Free plan. No card needed. |
| 2 | Create one Worker named `folio-pages` and paste in `folio/worker/folio-pages.mjs` | Workers & Pages > Create > Start with Hello World > Deploy, then Edit code | Free plan |
| 3 | Add a D1 binding named `DB` to that Worker, pointing at `folio-pages` | Worker > Settings > Bindings | Free |
| 4 | Create one Turnstile widget (hostname `layahmcfly.github.io`, mode Managed) | Dashboard > Turnstile > Add widget | Free |
| 5 | Add the Turnstile **secret** to the Worker as a secret named `TURNSTILE_SECRET` | Worker > Settings > Variables and Secrets > Type: Secret | Free |
| 6 | Edit two public values (`api` and `siteKey`) in `folio/index.html` on the `folio-publishing` branch, then (only after you approve merging) publish it | github.com | Free |

No billing changes. If Cloudflare asks for a payment method at any step, stop: that is not part of this plan.
The `folio-pages` Worker is the only thing that gets a public address (`https://folio-pages.<your-subdomain>.workers.dev`).

## 2. Steps

1. **D1 database.** Dashboard > Storage & databases > D1 SQL database > Create database. Name: `folio-pages`. You do not create tables. The Worker creates them the first time it runs.
2. **Worker.** Workers & Pages > Create application > Start with Hello World > name `folio-pages` > Deploy > Edit code. Delete the sample, paste the whole of `folio/worker/folio-pages.mjs`, Deploy.
3. **Bind the database.** Worker > Settings > Bindings > Add > D1 database. Variable name must be exactly `DB`. Choose `folio-pages`. Deploy.
4. **Turnstile widget.** Dashboard > Turnstile > Add widget. Hostname: `layahmcfly.github.io`. Widget mode: Managed. Create. Copy the **Site key** (public) and the **Secret key** (private).
5. **Secret.** Worker > Settings > Variables and Secrets > Add. Type **Secret**, name `TURNSTILE_SECRET`, value = the Secret key. Deploy. Never paste the secret anywhere else: not in Folio, not on GitHub, not in a chat.
6. **Optional settings** (Type: Text). Leave them out to use the defaults.
   - `ALLOWED_ORIGIN` default `https://layahmcfly.github.io` (the only website allowed to call the service from a browser)
   - `TURNSTILE_HOSTNAMES` default `layahmcfly.github.io`
   - `PUBLISHING_PAUSED` set to `true` to stop new publishing and updates immediately
   - `RL_PUBLISH_IP_HOUR` (5), `RL_PUBLISH_IP_DAY` (12), `RL_PUBLISH_GLOBAL_DAY` (300), `RL_UPDATE_PAGE_HOUR` (30), `RL_FAIL_IP_HOUR` (30), `RL_CHECK_IP_HOUR` (60)
7. **Test the Worker.** Open `https://folio-pages.<your-subdomain>.workers.dev/api/status` in a browser. You should see `{"ok":true,"service":"folio-pages",...}`.
8. **Connect Folio.** On github.com open `folio/index.html` on the `folio-publishing` branch, find the line `const PUBLISH = { api: '', siteKey: '' };` and fill in the Worker address (no trailing slash) and the Turnstile **Site key**. Commit to the branch.
9. **Try it** before any merge: open the branch's version of Folio, Publish a test page, open the link in a private window, Update, Unpublish.

## 3. How protection works

**Turnstile.** The browser gets a one-time token from the Turnstile widget (using only the public site key). The Worker sends that token and the private secret to Cloudflare's `siteverify` endpoint. It publishes only if Cloudflare says `success`, the hostname is `layahmcfly.github.io`, and the action is `folio-publish`. If Cloudflare cannot be reached or the secret is missing, publishing is refused (it fails closed). The Worker also remembers each token it accepted, so one token cannot create two pages.

**Rate limits** are exact counters in D1 (one atomic SQL statement per event), not KV counters. They use fixed windows, so just before and after a window boundary a client can use up to about twice the limit in a short span.
- Publishing: 5 per hour and 12 per day per visitor address (IPv6 counted per /64), 300 per day for everyone.
- Updates: 30 per hour per page. Wrong-key attempts: 30 per hour per address (per address only, so a stranger cannot lock you out of your own page). Key checks: 60 per hour per address.

**Limits you should know.** A determined attacker using many addresses can still use up Cloudflare's free daily allowances (D1 writes, Worker requests). Public page views are not rate limited by Folio. No extra binding is needed for this plan, but Cloudflare's Rate Limiting rules (dashboard > Security > WAF) could be added later if you see abuse.

## 4. What happens when a free limit runs out

- **D1 write or read limit:** the Worker answers "daily limit" with how long until it resets (midnight UTC). Folio says a free Cloudflare limit was reached and what state your page is in (for example "Your page is still published").
- **Worker request limit:** Cloudflare itself answers with a plain error page, not from Folio's code. Folio then says it **cannot tell** whether the action happened.
- Folio does not promise that viewing, updating or unpublishing works while a limit is exhausted. Viewing a page needs a D1 read plus a Worker request; unpublishing needs writes.

## 5. Updates and unpublishing: delay

The service does not cache. It reads and writes one D1 database, and Folio asks the browser not to cache. In the simulated tests a change appears on the next reload. This has **not been measured on real Cloudflare**, and nothing guarantees a maximum delay. Folio tells owners to wait a little and reload if a page looks old. Copies other people saved, and anything search engines or web archives stored, cannot be removed by Folio.

## 6. Lost edit key

The page ID in the link only allows viewing. The edit key is shown once, kept in the owner's browser, and available as a recovery file. If both are lost, nobody (including you) can edit or unpublish that page through Folio. You, as the Cloudflare account owner, can delete a page manually: D1 > `folio-pages` > Console, run `DELETE FROM pages WHERE id = 'THE_ID';`. The page cannot be edited by anyone else.

## 7. Roll back

Set `PUBLISHING_PAUSED` to `true` (stops publishing and updates immediately). To remove everything: delete the Worker, the D1 database and the Turnstile widget in the dashboard. Published pages disappear with the database.

## 8. Portfolio files (images and videos): extra setup, Worker v1.1.0

Folio v1.2.0 lets a page show up to 6 images or videos (15 MB each). Online storage for them is a **Workers KV** namespace. KV is on the free plan and needs no payment card. Without it, everything else keeps working, and Publish stops with a plain message if a portfolio has files.

1. **Namespace.** A KV namespace named `folio-media` already exists in your Cloudflare account (id `2cd1222e15b144988bff1935a4c9b795`). If it is missing, create it: Dashboard > Storage & databases > KV > Create, name `folio-media`.
2. **New Worker code.** Worker `folio-pages` > Edit code. Replace everything with the current `folio/worker/folio-pages.mjs` (version 1.1.0), then Deploy.
3. **Bind the namespace.** Worker > Settings > Bindings > Add > KV namespace. Variable name exactly `MEDIA`, namespace `folio-media`. Deploy.
4. **Check.** Open `.../api/status`. It should show `"media":true` and `"version":"1.1.0"`.

Free KV limits: 1 GB stored, 1,000 writes and 1,000 deletes a day, 100,000 reads a day. Folio stops accepting files at 900 MB in total (change with the `MEDIA_TOTAL_CAP_MB` setting). A full page of 6 files can use 90 MB, so about 10 such pages fill it. KV can show a brand-new or just-deleted file for up to about a minute in some places.

Rules the Worker enforces: only the page's edit key can upload; JPEG, PNG, WebP, GIF, MP4 and WebM only (no SVG); the first bytes of each file must match its type, checked before anything is stored; 15 MB per file, 6 files and 90 MB per page; 60 uploads per page per hour. Files are deleted when you remove them and update, or when you unpublish. Visitors load files through the Worker (`/api/media/<page>/<file>`), which counts toward the Worker's free 100,000 requests a day. Videos play in pieces (byte ranges), and every piece is a request and a KV read.

Version 1.1.0 also accepts the new `gscript` message mode (Folio's Google Apps Script option). Pages using that mode will not publish until the Worker is updated.

## 9. Messages from the hire-me form (free options)

- **Google Apps Script** (in Folio section 7): a small script in your own Google account emails you each message. Free, about 100 emails a day. Folio shows the script and the steps.
- **Web3Forms** or **Formspree**: free tiers with a form address or key.
- **Email app draft** (default): sends nothing by itself. The visitor has to press Send in their own email app.
