# LakeLevelNow

**Live US lake & reservoir water levels** — current level, percent full, and a 30-day trend pulled straight from USGS and CDEC public feeds, with a plain-English "can I launch?" read. Static, SEO-first, live-data-first. Portfolio Empire build.

- **Stack:** Astro 4 (static output) + Cloudflare Workers (static assets) + GitHub Actions.
- **Data:** `scripts/fetch-levels.mjs` pulls USGS Water Services + California Data Exchange (CDEC), gates every reading on freshness (≤7 days), computes percent full, and writes `src/data/lakes.json` (registry) + `src/data/levels.json` (readings). No API keys needed.
- **Live set (this build):** 12 lakes with verified-current readings — 11 California reservoirs via CDEC (Shasta, Oroville, Folsom, Berryessa, Isabella, Millerton, New Melones, Don Pedro, San Luis, Cachuma, Casitas) + Lake Allatoona via USGS. 42 lakes total in the registry.

## Quick start

```bash
npm install
npm run fetch      # pull live USGS/CDEC data -> src/data/*.json
npm run build      # Astro build -> dist/
npm run preview    # local preview of dist/
```

## Add a lake

Edit `src/data/lakes.seed.json` (add `{slug,name,state,river,operator,full_pool_ft,...}`; for CA reservoirs add `cdec_id` + `capacity_af`), then `npm run fetch && npm run build`. The fetcher discovers the USGS gage automatically and only ships the lake if it returns a current reading. (See "data feeds" below for the ones that need extra wiring.)

---

# Launch runbook — take it live

This is the ordered checklist for DNS → Cloudflare → GitHub → GSC → IndexNow. Steps that need your credentials are marked **[you]** and are runnable as `! <cmd>` in this session.

## 0. Prereqs (API tokens / keys)

- **Cloudflare** — create an API token with `Zone:Zone:Edit`, `Zone:DNS:Edit`, and `Workers Scripts:Edit` (all zones). Grab your Account ID.
- **Porkbun** — opt `lakelevelnow.com` into API access (Domain Management → Details → API Access), create an API key + secret.
- **GitHub** — the current `GITHUB_TOKEN` is **invalid**; re-auth with `! gh auth login` before pushing. **[you]**

Store Cloudflare creds as GitHub repo secrets after the repo exists (step 3).

## 1. Create the Cloudflare zone **[you]**

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
GOOGLE_SITE_VERIFICATION='google-site-verification=...' \
node scripts/cf-zone-create.mjs
```

- Creates `lakelevelnow.com` (idempotent), prints the **two Cloudflare nameservers** (`CF_NS=...`).
- If `GOOGLE_SITE_VERIFICATION` is set (copy it from GSC → "Domain name provider" verification), adds the GSC DNS TXT record now.

## 2. Migrate DNS from Porkbun → Cloudflare **[you]**

```bash
PORKBUN_APIKEY=pk1_... PORKBUN_SECRET=sk1_... \
CF_NS="alice.ns.cloudflare.com,bob.ns.cloudflare.com" \
node scripts/porkbun-set-ns.mjs
```

Pointing the nameservers at Cloudflare is the actual DNS cutover. Cloudflare emails when the zone goes **Active** (minutes–hours). Until then, the site serves on the `*.workers.dev` preview URL.

## 3. GitHub — repo + connect everything **[you]**

```bash
gh repo create lakelevelnow --private --source=. --push      # after `gh auth login`
gh secret set CLOUDFLARE_API_TOKEN --body "..."
gh secret set CLOUDFLARE_ACCOUNT_ID --body "..."
```

On every push to `main`, `.github/workflows/deploy.yml` runs the full pipeline: **fetch → build → `wrangler deploy` → IndexNow**. Nothing else to wire.

## 4. Deploy + custom domain

`wrangler deploy` (run by CI) serves `dist/` on a Worker and — because `wrangler.toml` lists `lakelevelnow.com` + `www.lakelevelnow.com` as `custom_domain` routes — auto-binds them and creates the DNS records **once the zone is Active**. First push after step 2 completes the loop.

Manual one-off (if you want to deploy before CI): `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler@4.80.0 deploy`.

## 5. Google Search Console **[you]**

- Add property `lakelevelnow.com` (Domain type covers all subdomains).
- Verify via the DNS TXT added in step 1 (or paste the token into `SITE.gscVerification` in `src/consts.ts` for the meta-tag method).
- Submit `https://lakelevelnow.com/sitemap-index.xml`.
- This is what measures traffic — the goal of "add to GSC."

## 6. IndexNow

Runs automatically at the end of every CI deploy. Manual first run after deploy: `npm run indexnow` (submits all sitemap URLs; key is in `.indexnow-key` + `public/<key>.txt`).

---

## Monetization wiring (recreation affiliate)

The make-it-right plan: recreation affiliate, **not display ads**. Sign up for FishingBooker, Captain Experiences, Boatsetter, paste tracked links into `AFFILIATES` in `src/consts.ts` (currently `REPLACE_ME`), and the lake-page booking buttons + `/disclosure` activate automatically. Until then the buttons show a clear placeholder (never a dead/broken link). Leaving them `REPLACE_ME` blocks no functionality — the build's QA gate flags them.

## Data feeds

| Feed | Covers | Status |
|---|---|---|
| **CDEC** | California reservoirs (storage → % full) | ✅ live |
| **USGS IV** | Any US reservoir/dam gage with a current reading (freshness-gated) | ✅ live (opportunistic) |
| **LCRA HydroMet** | Texas Highland Lakes (Travis, Buchanan, LBJ …) — highest-volume region | ⚠️ not reachable from the build env; wire next |
| **USBR RISE** | Mead, Powell (highest search volume) | ⚠️ wire next |
| **USACE districts** | Lanier, Eufaula, Texoma, Kerr … | ⚠️ wire next |

The weekly cadence (`deploy.yml` cron) regenerates readings every Monday; add feeds/lakes in `src/data/lakes.seed.json` per the Design Practices & Growth tab.

## SEO (already in place)

- `@astrojs/sitemap` 3.1.6 (pinned) → `sitemap-index.xml`; `robots.txt` allows all + points to sitemap.
- Per-page canonical, OG/Twitter tags, branded OG image (`public/og-default.png`).
- JSON-LD: `Organization`, `WebSite`, `LakeBodyOfWater` (with `Observation`), `FAQPage`, `BreadcrumbList`.
- `public/_headers`: HSTS, CSP, X-Frame-Options, nosniff, referrer policy, asset caching.

## Honesty rails

- **Freshness gate:** a reading shows as live only if ≤7 days old; older readings are flagged "may be delayed."
- **No fake numbers:** lakes without a live feed show reference data + "Live level feed connecting" — never a fabricated level.
- **No emojis, no AI slop**; every datum carries a source badge + timestamp.
- **No axios dependency** (supply-chain rule: axios 1.14.1/0.30.4 compromised 2026-03-31; all HTTP uses native fetch).
