# claude-draft: AI drafting for the Job Search Tracker

This Appwrite Function receives a draft prompt from the tracker app, sends it to the Claude API with your API key, and returns the draft text. The key stays in Appwrite. It never goes in the app, the repo, or your browser.

**Billing:** Claude API usage is billed by Anthropic separately from a Claude Pro subscription. Pro does not include API credits. You pay per use in the Claude Console, so set a spend limit (step 1).

## 1. Get a Claude API key and set a spend limit

1. Sign in at https://platform.claude.com (the Claude Console). Add a payment method or credits under Billing.
2. Create a key under **API keys**. Copy it now; it is shown once.
3. Set a monthly cap: click your organization name (bottom left) > **Organization settings** > **Billing** > **Spend limits** > **Set limit**. When the limit is reached, the API refuses requests until the 1st of the next month (00:00 UTC). The app shows that refusal as a plain message.

## 2. Create the function in Appwrite

1. In the Appwrite Console, open your project (or create one) > **Functions** > **Create function**.
2. Connect your GitHub repo **LayahMcFly/JobSearch** and set:
   - **Branch:** `main`
   - **Root directory:** `appwrite-functions/claude-draft`
   - **Runtime:** Node.js 22 (any Node 18 or newer works; the function uses built-in `fetch`)
   - **Entrypoint:** `src/main.js`
   - **Build commands:** leave empty (there are no packages to install)
   Appwrite redeploys the function each time this folder changes on `main`.

## 3. Function settings

In the function's **Settings** tab:

- **Execute access:** `Any`. The app has no login, so the access code below is what keeps strangers out.
- **Timeout:** `60` seconds. Requests through the function's domain stop at 60 seconds whatever this says, which is why the function asks Claude for a quick, low-effort answer.

## 4. Environment variables

In **Settings** > **Environment variables**, add these. Mark the first two as **secret**.

| Name | Value |
| --- | --- |
| `CLAUDE_API_KEY` | The key from step 1 |
| `APP_ACCESS_CODE` | A long passphrase you make up, at least 20 characters. You'll type it into the app once per device. |
| `ALLOWED_ORIGINS` | `https://layahmcfly.github.io` (your site's address with no path and no trailing slash; add more, comma separated) |
| `DRAFT_MAX_TOKENS` | Optional. Default `4000`. |
| `DRAFT_EFFORT` | Optional. Default `low`. Use `medium` only if drafts finish well under 60 seconds. |

Variable changes apply after the next deployment: open **Deployments** and redeploy the latest one.

## 5. Allow your site and copy the function address

- **Allowing your site:** `ALLOWED_ORIGINS` is the allow list. The function answers browser requests only from those addresses. A request from any other site is refused.
- **Function address:** open the function's **Domains** tab and copy the generated domain (it ends in `appwrite.run`). The app sends requests there.

## 6. Connect the app

1. Open the tracker > **Settings** > **AI drafting**.
2. Paste the function address and your access code, then press **Save AI settings**. The access code stays on that device and is left out of backup files.
3. Switch **AI drafting** to On, then press **Test connection**. The test checks the address and code without calling Claude, so it costs nothing.
4. Choose which drafts use AI (resumes, application answers, cover emails), a default model, and a monthly draft limit.

## Troubleshooting

| App message mentions | Fix |
| --- | --- |
| Could not reach your function | Check the address in the app. Check `ALLOWED_ORIGINS` matches the site exactly, starting with `https://`. |
| Access code | The code in the app must match `APP_ACCESS_CODE` exactly. Redeploy after changing it. |
| API key | Create a new key in the Claude Console, update `CLAUDE_API_KEY`, redeploy. |
| Spend limit or credit | Raise the limit or add credits in the Claude Console Billing page. |
| Took too long | Use Haiku 5.5, or shorten the job description. |

Logs in the function's **Executions** tab show the model, token counts, and error types. Prompts and drafts are never logged.
