# Live search Worker

`live-search.js` is a Cloudflare Worker. The tracker calls it when you press **Search live** in the Job Feed. It reads Jobicy, We Work Remotely and the Greenhouse and Lever companies listed in `job-sources.json` at that moment, and searches the Remotive jobs the GitHub run saved (Remotive's rules allow 4 requests a day, so live search never calls it). Nothing is stored. It needs no key, no card and no Claude credits.

## Set up (about 5 minutes)

1. Sign in at dash.cloudflare.com and open **Workers & Pages**.
2. Choose **Create application**, then **Start with Hello World!**. Name it `job-search-live` and choose **Deploy**.
3. Choose **Edit code**. Select everything in the editor, delete it, and paste the full contents of `live-search.js`. Choose **Deploy**.
4. Copy the address at the top of the page. It ends in `.workers.dev`.
5. Open the tracker, go to **Settings**, paste the address into **Live search address**, and choose **Save settings**.
6. Go to **Job Feed**, type a word such as `copywriter`, and press **Search live**.

To check the Worker alone, open `your-address/health` in a browser. It should show `{"ok":true,...}`.

## Limits on the free plan

- 100,000 requests a day and 10 ms of CPU per request. Each search is one request.
- A search reads at most 25 company boards, so a long Greenhouse and Lever list is cut off after 25.
- Greenhouse results show title, company and location only. The description opens on the job link.
- The Worker answers only requests that come from `layahmcfly.github.io`. To use another site, change `ALLOWED_ORIGINS` at the top of the file.
