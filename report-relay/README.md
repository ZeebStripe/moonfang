# Moonfang report relay

A tiny Cloudflare Worker that turns in-app bug reports into GitHub issues. The app only sends a report when the user
presses **Send** in its report dialog, and it shows them exactly what will be sent. The GitHub token is stored as a
Worker secret, so it never ships inside the app (anything inside a public app can be extracted).

Until it is deployed and its URL is set in `src/meta.ts` (`REPORT_ENDPOINT`), the app falls back to opening the
prefilled GitHub issue form in the browser.

## Setup (about 10 minutes)

1. **Pick where reports go.** Create a private repository, for example `ZeebStripe/moonfang-reports` (reports contain
   system details such as the GPU and browser, so a private repo is kinder to reporters). Put its name in
   `wrangler.toml` (`GITHUB_REPO`). To use the public `moonfang` repo instead, also set `PUBLIC_REPO = "true"` and
   change the wording in `src/ui/report.ts` that tells users their report stays private.
2. **Create a GitHub token:** GitHub → Settings → Developer settings → Fine-grained tokens → Generate. Repository
   access: *only* the repo from step 1. Permissions: **Issues: Read and write** (nothing else). Pick an expiry and set a
   reminder to renew it.
3. **Log in to Cloudflare** (opens your browser): `npx wrangler@4 login`
4. **Rate limiting** (recommended): `npx wrangler@4 kv namespace create RATE`, then paste the printed id into the
   commented `[[kv_namespaces]]` block in `wrangler.toml` and uncomment it.
5. **Store the token** (paste it when asked; it is never written to disk here): `npx wrangler@4 secret put GITHUB_TOKEN`
6. **Deploy:** `npx wrangler@4 deploy`. It prints a URL like `https://moonfang-reports.<you>.workers.dev`.
7. In the app, set `REPORT_ENDPOINT` in `src/meta.ts` to that URL plus `/report`, rebuild and release.

Run the commands from this folder (`report-relay/`).

## Limits

- 32 KB per report; field length caps in `src/index.js`.
- With the `RATE` namespace: 5 reports per hour per connection (only a salted hash of the IP address is kept, for one
  hour) and 200 reports per day in total.
- `@mentions` and code fences in user text are neutralised so reports can't ping people or break formatting.
- Issues get the labels `bug` and `user-report`.
