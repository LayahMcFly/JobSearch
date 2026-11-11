# claude-draft: AI drafting for the Job Search Tracker (Cloudflare Workers)

This Cloudflare Worker receives a draft prompt from the tracker app, sends it to the Claude API with your API key, and returns the draft text. The key stays in Cloudflare's encrypted secrets. It never goes in the app, the repo, or your browser.

**Cost:** The Cloudflare Workers Free plan allows 100,000 requests a day, which is far more than this app uses. No credit card is needed for it.

**Claude API billing:** Claude API usage is billed by Anthropic separately from a Claude Pro subscription. Pro does not include API credits. You pay per use in the Claude Console, so set a spend limit (step 1).

## 1. Get a Claude API key and set a spend limit

1. Sign in at https://platform.claude.com (the Claude Console). Add a payment method or credits under Billing.
2. Create a key under **API keys**. Copy it now; it is shown once.
3. Set a monthly cap: click your organization name (bottom left) > **Organization settings** > **Billing** > **Spend limits** > **Set limit**. When the limit is reached, the API refuses requests until the 1st of the next month (00:00 UTC). The app shows that refusal as a plain message.

## 2. Create the Worker

1. Sign up or sign in at https://dash.cloudflare.com (free account).
2. Go to **Workers & Pages** > **Create** > **Create Worker** (the "Hello World" starter).
3. Name it `claude-draft`, then select **Deploy**.
4. Select **Edit code**. Delete the sample code, paste the full contents of `worker.js` from this folder, and select **Deploy**.

If you use the Wrangler command line tool instead, `wrangler deploy worker.js --name claude-draft` from this folder works too.

## 3. Add secrets

In the Worker, go to **Settings** > **Variables and Secrets** > **Add**. Choose type **Secret** for each:

| Name | Value |
| --- | --- |
| `CLAUDE_API_KEY` | The key from step 1 |
| `APP_ACCESS_CODE` | A long passphrase you make up, at least 20 characters. You'll type it into the app once per device. |
| `ALLOWED_ORIGINS` | `https://layahmcfly.github.io` (your site's address with no path and no trailing slash; add more, comma separated) |
| `DRAFT_MAX_TOKENS` | Optional. Default `6000`. |
| `DRAFT_EFFORT` | Optional. Default `medium`. Use `low` for faster, cheaper drafts. |

Select **Deploy** to apply them.

## 4. Allow your site and copy the Worker address

- **Allowing your site:** `ALLOWED_ORIGINS` is the allow list. The Worker answers browser requests only from those addresses. A request from any other site is refused.
- **Worker address:** shown on the Worker's overview page. It looks like `https://claude-draft.YOUR-SUBDOMAIN.workers.dev`.

## 5. Connect the app

1. Open the tracker > **Settings** > **AI drafting**.
2. Paste the Worker address and your access code, then press **Save AI settings**. The access code stays on that device and is left out of backup files.
3. Switch **AI drafting** to On, then press **Test connection**. The test checks the address and code without calling Claude, so it costs nothing.
4. Choose which drafts use AI (resumes, application answers, cover emails), a default model, and a monthly draft limit.

## Troubleshooting

| App message mentions | Fix |
| --- | --- |
| Could not reach your Worker | Check the address. Check that `ALLOWED_ORIGINS` matches the site exactly, starting with `https://`. |
| Access code | The code in the app must match `APP_ACCESS_CODE` exactly. Select Deploy after changing a secret. |
| API key | Create a new key in the Claude Console and update `CLAUDE_API_KEY`. |
| Spend limit or credit | Raise the limit or add credits in the Claude Console Billing page. |
| Took too long | Use Haiku 5.5, set `DRAFT_EFFORT` to `low`, or shorten the job description. |

The Worker's **Logs** (Observability) tab shows the model, token counts, and error types. Prompts and drafts are never logged.
