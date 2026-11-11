# claude-draft: AI drafting for the Job Search Tracker (Supabase)

This Supabase Edge Function receives a draft prompt from the tracker app, sends it to the Claude API with your API key, and returns the draft text. The key stays in Supabase's encrypted secrets. It never goes in the app, the repo, or your browser.

**Billing:** Claude API usage is billed by Anthropic separately from a Claude Pro subscription. Pro does not include API credits. You pay per use in the Claude Console, so set a spend limit (step 1). Supabase's Free plan covers this function's light use.

## 1. Get a Claude API key and set a spend limit

1. Sign in at https://platform.claude.com (the Claude Console). Add a payment method or credits under Billing.
2. Create a key under **API keys**. Copy it now; it is shown once.
3. Set a monthly cap: click your organization name (bottom left) > **Organization settings** > **Billing** > **Spend limits** > **Set limit**. When the limit is reached, the API refuses requests until the 1st of the next month (00:00 UTC). The app shows that refusal as a plain message.

## 2. Create the function

1. Sign in at https://supabase.com and open your project, or create one (the Free plan is enough).
2. Go to **Edge Functions** > **Deploy a new function** > **Via Editor**.
3. Name it exactly `claude-draft`.
4. Delete the sample code, paste the full contents of `index.ts` from this folder, and press **Deploy function**.

If you use the Supabase CLI instead: `supabase functions deploy claude-draft --no-verify-jwt` from the repo root.

## 3. Turn off JWT verification

Open the function's details page and switch off **JWT verification** (sometimes labeled "Enforce JWT verification" or "Verify JWT"), then save.

Why: with it on, Supabase rejects every request that lacks a Supabase login token before your code runs, including the browser's preflight check. The app has no login. The access code from step 4 is what keeps strangers out.

## 4. Add secrets

Go to **Edge Functions** > **Secrets** and add:

| Name | Value |
| --- | --- |
| `CLAUDE_API_KEY` | The key from step 1 |
| `APP_ACCESS_CODE` | A long passphrase you make up, at least 20 characters. You'll type it into the app once per device. |
| `ALLOWED_ORIGINS` | `https://layahmcfly.github.io` (your site's address with no path and no trailing slash; add more, comma separated) |
| `DRAFT_MAX_TOKENS` | Optional. Default `6000`. |
| `DRAFT_EFFORT` | Optional. Default `medium`. Use `low` for faster, cheaper drafts. |

Secrets apply to new requests right away; no redeploy is needed.

## 5. Allow your site and copy the function address

- **Allowing your site:** `ALLOWED_ORIGINS` is the allow list. The function answers browser requests only from those addresses. A request from any other site is refused.
- **Function address:** `https://YOUR-PROJECT-REF.supabase.co/functions/v1/claude-draft`. The project ref is in **Project Settings** > **General**, and the function's details page shows the full URL.

## 6. Connect the app

1. Open the tracker > **Settings** > **AI drafting**.
2. Paste the function address and your access code, then press **Save AI settings**. The access code stays on that device and is left out of backup files.
3. Switch **AI drafting** to On, then press **Test connection**. The test checks the address and code without calling Claude, so it costs nothing.
4. Choose which drafts use AI (resumes, application answers, cover emails), a default model, and a monthly draft limit.

## Limits worth knowing

Supabase ends a request that sends no response within 150 seconds. The function stops waiting for Claude at 140 seconds and tells the app, which shows a plain message. Haiku 5.5 drafts usually finish well inside that.

## Troubleshooting

| App message mentions | Fix |
| --- | --- |
| Could not reach your function | Check the address. Check that `ALLOWED_ORIGINS` matches the site exactly, starting with `https://`. Check that JWT verification is off. |
| Supabase blocked the request | JWT verification is still on. Turn it off (step 3). |
| Access code | The code in the app must match `APP_ACCESS_CODE` exactly. |
| API key | Create a new key in the Claude Console and update `CLAUDE_API_KEY`. |
| Spend limit or credit | Raise the limit or add credits in the Claude Console Billing page. |
| Took too long | Use Haiku 5.5, set `DRAFT_EFFORT` to `low`, or shorten the job description. |

The function's **Logs** tab in Supabase shows the model, token counts, and error types. Prompts and drafts are never logged.
