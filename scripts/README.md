# Data + launch pipeline (`scripts/`)

The engine that keeps lakelevelnow.com *fresh*: live USGS/CDEC readings regenerated into
`src/data/`, plus the one-time launch scripts for Cloudflare / Porkbun / GSC / IndexNow.

| Script | Does | Reads | Writes |
|---|---|---|---|
| `fetch-levels.mjs` | Pull **free, keyless** USGS IV + CDEC reservoir data, discover each lake's gage, **gate on freshness (≤7d)**, compute percent full. Never ships a stale or fabricated reading. | `src/data/lakes.seed.json` | `src/data/lakes.json`, `src/data/levels.json` |
| `indexnow-submit.mjs` | Submit every sitemap URL to IndexNow (Bing/Yandex/Seznam) for fast crawl. Run after deploy. | `.indexnow-key`, `dist/sitemap-*.xml` | — (pings IndexNow API) |
| `cf-zone-create.mjs` | Create the `lakelevelnow.com` Cloudflare zone, print nameservers, optionally add the GSC DNS TXT. Idempotent. | env `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GOOGLE_SITE_VERIFICATION` | `/tmp/lakelevelnow-zone.json` |
| `porkbun-set-ns.mjs` | Point the domain's nameservers at Cloudflare via the Porkbun API (the DNS cutover). | env `PORKBUN_APIKEY`, `PORKBUN_SECRET`, `CF_NS` | — |

## Weekly cadence

`.github/workflows/deploy.yml` runs the full pipeline on push, weekly (Mon), and manually:
**`fetch-levels` → `build` → `wrangler deploy` → `indexnow`**. No human action needed to keep
readings current — that is the freshness moat.

## Honesty rules baked in

- **Freshness gate.** A reading is shown as live only if ≤7 days old (matches `FRESH_DAYS` in `src/consts.ts`); older ones are flagged "may be delayed," never silently current.
- **No fake numbers.** If a feed isn't wired or returns nothing fresh, the lake page shows reference data + "Live level feed connecting" — never a fabricated level.
- **Verified gages only.** USGS site IDs are *discovered* (state + name + `LK` type) and confirmed to return data, not guessed from memory.

## Data sources (all free, public, keyless)

- **USGS Water Services** — gage height (00065), reservoir elevation (62614/00062), instantaneous values.
- **CDEC (California Data Exchange)** — reservoir storage (sensor 15) + elevation (sensor 6), daily. Used for California reservoirs → accurate percent full.

## Adding a feed / region (the growth plan)

To wire a new source (LCRA for Texas Highland Lakes, USBR for Mead/Powell, USACE districts): add a
`fetchX()` function in `fetch-levels.mjs` mirroring `fetchCDEC`, set the lake's feed id in
`lakes.seed.json`, and re-run. The Design Practices & Growth tab in MASTER-DASHBOARD ranks the
next data categories and regions to ship weekly.
