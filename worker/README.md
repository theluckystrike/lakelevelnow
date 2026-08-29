# lake-level-almanac worker

Fulfilment service for the paid Lake Level Almanac (lakelevelnow.com).
Live at https://lake-level-almanac.lipmichal.workers.dev

## Routes
- `GET /health` - `{ok, version, mode, lakes, configured:{...}}`; every `configured` flag must be true.
- `GET /catalog` - `catalog.json` from KV (19 lakes), cached 1h.
- `GET /verify?session_id=cs_...` - checks the Stripe Checkout session (`paid` or `no_payment_required`),
  resolves the lake (custom field `lake`, then `client_reference_id`, hyphen-insensitive) and mints a
  30-minute signed download URL. Max 60 mints per session (`mints:<sid>` in ALMANAC_ORDERS).
- `GET /file?t=<token>` - streams the ZIP from KV.
- `GET /hit?e=<event>&l=<lake>&p=<placement>` - beacon; events alm_view, sample_view, cta_click,
  checkout_open, thanks_view, thanks_ok. Counts only when Origin/Referer host is lakelevelnow.com or
  localhost. Always 204.

## Bindings (wrangler.toml)
KV `ALMANAC_ASSETS` (catalog.json, bundle.zip, lake/<slug>.zip) and `ALMANAC_ORDERS` (counters).
Vars ALLOWED_ORIGINS, ALMANAC_MODE, LINK_SINGLE_ID, LINK_BUNDLE_ID (all comma-separated lists). Secrets SIGNING_KEY and
STRIPE_SECRET_KEY live only in the dashboard. ZIP backups: `~/satellite-repos/lakelevelnow-almanac-assets/`.

## Deploy
    cd worker && CLOUDFLARE_API_TOKEN=<cfut_...> CLOUDFLARE_ACCOUNT_ID=dd3f2a29b7707e21a87f26a622c0bb9d \
      npx --no-install wrangler deploy && bash test/smoke.sh

## Read the beacon counters
Keys: `hits:<YYYY-MM-DD UTC>:<event>[:<lake>|:p:<placement>]`, plain integers (KV is eventually consistent).
    A=dd3f2a29b7707e21a87f26a622c0bb9d; NS=bd1eb77d66e24161bd8997381ba856de; H="Authorization: Bearer $CF_TOKEN"
    curl -s -H "$H" "https://api.cloudflare.com/client/v4/accounts/$A/storage/kv/namespaces/$NS/keys?prefix=hits:" | jq -r '.result[].name'
    curl -s -H "$H" "https://api.cloudflare.com/client/v4/accounts/$A/storage/kv/namespaces/$NS/values/hits:2026-08-29:alm_view"

## Test environment
`wrangler deploy --env test` ships a twin at https://lake-level-almanac-test.lipmichal.workers.dev
(mode `test`): Stripe TEST links plink_1U9ZnuJKCamubEm1214M88PV (single $19, lake dropdown) and
plink_1U9ZnwJKCamubEm1VQO8LYi3 (bundle $79), own KV (assets befded96e5634a86897a6d2e02b086ac holds
the real catalog but only dummy fixture ZIPs - never product files; orders c4a151a2dd1a46eea2c84552d5ec2165)
and own secrets (sk_test key + separate SIGNING_KEY, set via `wrangler secret put <NAME> --env test`).
E2E: `node ~/satellite-repos/_lln-e2e-test.mjs <test-link-url> "Medina Lake" <outDir>` pays with card
4242, lands on /almanac/thanks/?session_id=cs_test_..., then `/verify` on the test worker must return
`ok:true`. The thanks page itself calls the PROD worker, so it shows an error for cs_test ids - expected.
