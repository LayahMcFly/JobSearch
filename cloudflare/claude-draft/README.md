# AI drafting for the Job Search Tracker (Cloudflare)

`worker.js` sends a draft prompt from the tracker app to the Claude API with your API key and returns the draft text. The key stays in Cloudflare's encrypted secrets. It never goes in the app, the repo, or your browser.

**Claude API billing:** Claude API usage is billed by Anthropic separately from a Claude Pro subscription. Pro does not include API credits. Set a spend limit in the Claude Console (step 1).

**Cloudflare cost:** the Workers Free plan allows 100,000 requests a day.

## How it is set up

One Cloudflare Worker named **jobsearch** does two jobs at one address:

- `https://jobsearch.YOUR-NAME.workers.dev/` serves the tracker app.
- `https://jobsearch.YOUR-NAME.workers.dev/api/draft` runs this drafting code.

The Worker is connected to the GitHub repo, so Cloudflare rebuilds it on every push to `main`. The settings live in `wrangler.jsonc` at the repo root, and `.assetsignore` keeps code and settings files private.

## 1. Claude API key and spend limit

1. Sign in at https://platform.claude.com. Add a payment method or credits under Billing.
2. Create a key under **API keys** and copy it.
3. Set a monthly cap: your organization name > **Organization settings** > **Billing** > **Spend limits** > **Set limit**.

## 2. Secrets on the jobsearch Worker

In Cloudflare: **Workers & Pages** > **jobsearch** > **Settings** > **Variables and Secrets** > **Add**. Use type **Secret**:

| Name | Value |
| --- | --- |
| `CLAUDE_API_KEY` | Your Claude API key |
| `APP_ACCESS_CODE` | A long passphrase you make up. You type it into the app once per device. |
| `ALLOWED_ORIGINS` | Optional. `https://layahmcfly.github.io` lets the GitHub Pages copy of the app use AI drafting too. The Cloudflare copy is always allowed. |
| `DRAFT_MAX_TOKENS` | Optional. Default `6000`. |
| `DRAFT_EFFORT` | Optional. Default `medium`. Use `low` for faster, cheaper drafts. |

Select **Deploy** after adding them. Secrets stay in place when new code deploys.

## 3. Connect the app

1. Open the app at `https://jobsearch.YOUR-NAME.workers.dev/` > **Settings** > **AI drafting**.
2. Switch **AI drafting** On. The Worker address fills in as `.../api/draft`.
3. Enter your access code and press **Test connection**. The test does not call Claude, so it costs nothing.

## Check it from a browser

Opening `https://jobsearch.YOUR-NAME.workers.dev/api/draft` should show `{"ok":false,"code":"method","error":"Use POST."}`. That means the drafting code is live.

## Running worker.js on its own

`worker.js` also works pasted into a separate Worker with no app files. In that case its address is the Worker's root URL, `ALLOWED_ORIGINS` must list the site the app runs on, and `cloudflare/claude-draft/wrangler.jsonc` describes that setup.
