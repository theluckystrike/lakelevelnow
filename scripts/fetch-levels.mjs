// fetch-levels.mjs — lakelevelnow.com data pipeline (v2, NASA-grade).
//
// Pulls current lake/reservoir levels from FREE, keyless government APIs:
//   • CDEC  — California Data Exchange (cdec.water.ca.gov)
//   • USGS  — USGS NWIS Instantaneous Values (waterservices.usgs.gov)
//   • USBR  — Bureau of Reclamation Lower Colorado hourly JSON (usbr.gov)
//
// ── Reliability rules (the "NASA rules" the project runs under) ─────────────
//  1. DETERMINISTIC INPUTS — every lake's feed is an explicit binding in
//     src/data/sources.json. The pipeline NEVER does runtime name-discovery
//     against a search API. (Discovery is a dev-only tool: discover-sources.mjs.)
//  2. BOUNDED EXECUTION — every network call has a hard timeout and a fixed
//     retry budget with exponential backoff. No call can hang the run.
//  3. FAIL-SAFE — a transient upstream failure NEVER drops a lake that had data.
//     The previous reading is kept and re-labeled stale. We ship the freshest
//     reading we have; we label it honestly. No silent data loss.
//  4. FAIL-CLOSED FRESHNESS — a reading older than FRESH_DAYS is never marked
//     fresh, regardless of where it came from. The homepage "live" set only
//     contains genuinely current readings.
//  5. SINGLE SOURCE OF TRUTH — sources.json binds feeds; lakes.seed.json holds
//     metadata; this script emits lakes.json + levels.json + health.json. The
//     site reads only the emitted files (lib/lakes.ts).
//  6. NO SILENT FAILURES — every outcome is logged and recorded in health.json
//     with per-lake feed, as_of, age, and a status string. Exit code is 0 unless
//     the ENTIRE run produced zero fresh readings (circuit-breaker), so a flaky
//     single lake never fails CI.
//
// Run locally and in CI:  node scripts/fetch-levels.mjs   (npm run fetch)
// No API keys required.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src', 'data');
const SEED_PATH = join(DATA, 'lakes.seed.json');
const SOURCES_PATH = join(DATA, 'sources.json');
const LAKES_OUT = join(DATA, 'lakes.json');
const LEVELS_OUT = join(DATA, 'levels.json');
const HEALTH_OUT = join(DATA, 'health.json');

const FRESH_DAYS = 7;
const SERIES_DAYS = 30;
const UA = 'lakelevelnow-data/1.0 (+https://lakelevelnow.com; contact@lakelevelnow.com)';
const TIMEOUT_MS = 20000;
const RETRIES = 3;

const now = Date.now();
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => now - n * 86400000;
const ageDays = (iso) => (iso ? (now - new Date(iso).getTime()) / 86400000 : Infinity);
const todayISO = () => new Date(now).toISOString();

// ---- bounded, retried HTTP (NASA rule 2) -------------------------------------
async function httpGet(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** attempt); // 0.8s, 1.6s, 3.2s
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ac.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RDB (tab-delimited, '#' comment line, header + dash line) → objects.
function parseRDB(rdb) {
  const lines = rdb.split('\n').filter((l) => l.length && !l.startsWith('#'));
  if (lines.length < 3) return [];
  const header = lines[0].split('\t');
  return lines.slice(2).map((l) => {
    const c = l.split('\t');
    const o = {};
    header.forEach((h, i) => (o[h] = c[i]));
    return o;
  });
}

// ---- adapters: each returns a uniform reading or null ------------------------
// Uniform reading: { level_ft, storage_af, pct_full, as_of, series:[{t,v}], msl }
//   msl=true means level_ft is an elevation (feet above mean sea level), so it
//   can be compared to full_pool_ft. msl=false means stage/gage height.
const USGS_PARAM_META = {
  '62614': { label: 'reservoir elevation', msl: true },
  '00062': { label: 'reservoir elevation', msl: true },
  '00065': { label: 'gage height', msl: false },
};

async function fetchUSGS(site) {
  // Probe the three reservoir params at once; rank elevation above stage.
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=62614,00062,00065&siteStatus=all&period=P${SERIES_DAYS}D`;
  const d = JSON.parse(await httpGet(url));
  const ts = d?.value?.timeSeries || [];
  const ranked = ts
    .map((t) => {
      const code = String(t.variable.variableCode[0].value);
      const meta = USGS_PARAM_META[code] || { label: 'stage', msl: false };
      const vals = t.values[0].value.filter((v) => v.value && v.value !== '-999999');
      if (!vals.length) return null;
      return {
        code,
        msl: meta.msl,
        label: meta.label,
        level: parseFloat(vals[vals.length - 1].value),
        as_of: vals[vals.length - 1].dateTime,
        series: vals.map((v) => ({ t: v.dateTime, v: parseFloat(v.value) })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.msl - a.msl) || (new Date(b.as_of) - new Date(a.as_of)));
  const r = ranked[0];
  if (!r) return null;
  return { level_ft: r.level, storage_af: null, pct_full: null, as_of: r.as_of, series: r.series.slice(-SERIES_DAYS), msl: r.msl, param_label: r.label };
}

async function fetchCDEC(station, capacity) {
  const start = ymd(daysAgo(SERIES_DAYS + 5));
  const end = ymd(now);
  const url = `https://cdec.water.ca.gov/dynamicapp/req/JSONDataServlet?Stations=${station}&SensorNums=15,6&dur_code=D&Start=${start}&End=${end}`;
  const rows = JSON.parse(await httpGet(url));
  if (!Array.isArray(rows) || !rows.length) return null;
  const ok = (r) => r.value !== null && r.value !== undefined && r.value !== -9999 && r.value !== '-9999';
  const sto = rows.filter((r) => String(r.SENSOR_NUM) === '15' && ok(r)).sort((a, b) => new Date(a.date) - new Date(b.date));
  const elev = rows.filter((r) => String(r.SENSOR_NUM) === '6' && ok(r)).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!sto.length && !elev.length) return null;
  const useElev = elev.length > 0;
  const src = useElev ? elev : sto;
  const last = src[src.length - 1];
  const storage_af = sto.length ? Number(sto[sto.length - 1].value) : null;
  const level = useElev ? Number(last.value) : null;
  const pct = capacity && storage_af ? Math.max(0, Math.min(100, Math.round((storage_af / capacity) * 100))) : null;
  const as_of = String(last.date).replace(/(\d{4})-(\d{1,2})-(\d{1,2}).*/, '$1-$2-$3');
  return {
    level_ft: level,
    storage_af,
    pct_full: pct,
    as_of,
    series: src.slice(-SERIES_DAYS).map((r) => ({ t: String(r.date), v: Number(r.value), storage: !useElev })),
    msl: useElev, // elevation sensor is msl; pure-storage fallback is not
    param_label: useElev ? 'reservoir elevation' : 'reservoir storage',
  };
}

// USBR Lower Colorado JSON carries Mead/Mohave/Havasu in one request. Cache it.
let _usbr = null;
async function usbrSeries() {
  if (_usbr) return _usbr;
  const txt = await httpGet('https://www.usbr.gov/lc/region/g4000/riverops/webreports/hourlyweb.json');
  _usbr = JSON.parse(txt)?.Series || [];
  return _usbr;
}
const ELEV_DT = 'reservoir ws elevation, end of period primary reading';
const STO_DT = 'storage, end of period reading';
function dmyToIso(t) {
  // "6/19/2026 11:00:00 AM" → ISO
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(String(t).trim());
  if (!m) return String(t);
  const [, mo, da, yr, hh, mm, ss, ap] = m;
  let h = +hh % 12;
  if (/PM/i.test(ap || '')) h += 12;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mm}:${ss}`;
}
async function fetchUSBR(siteName, capacity) {
  const series = await usbrSeries();
  const elev = series.find((s) => s.SiteName === siteName && s.DataTypeName === ELEV_DT);
  const sto = series.find((s) => s.SiteName === siteName && s.DataTypeName === STO_DT);
  if (!elev && !sto) return null;
  const pick = elev || sto;
  const data = (pick.Data || []).filter((p) => p.v !== null && p.v !== '' && p.v !== undefined);
  if (!data.length) return null;
  const last = data[data.length - 1];
  const storage_af = sto ? Number((sto.Data.find((p) => p.v) && [...sto.Data].reverse().find((p) => p.v)?.v)) : null;
  const level = elev ? Number(last.v) : null;
  const pct = capacity && storage_af ? Math.max(0, Math.min(100, Math.round((storage_af / capacity) * 100))) : null;
  return {
    level_ft: level,
    storage_af,
    pct_full: pct,
    as_of: dmyToIso(last.t),
    series: data.slice(-SERIES_DAYS * 24).map((p) => ({ t: dmyToIso(p.t), v: Number(p.v) })),
    msl: !!elev,
    param_label: elev ? 'reservoir elevation' : 'reservoir storage',
  };
}

// ---- load inputs (NASA rule 5: single source of truth) -----------------------
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
const sourcesRaw = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
const SOURCES = Object.fromEntries(Object.entries(sourcesRaw).filter(([k]) => !k.startsWith('_')));
const prevLevels = safeReadJSON(LEVELS_OUT, {}); // last-known-good cache (rule 3)

function safeReadJSON(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function delta24(series) {
  if (!series || series.length < 2) return null;
  const a = series[series.length - 1].v;
  // value ~24h earlier (or earliest available)
  const lastT = new Date(series[series.length - 1].t).getTime();
  let b = series[0].v;
  for (let i = series.length - 2; i >= 0; i--) {
    if (lastT - new Date(series[i].t).getTime() >= 20 * 3600000) { b = series[i].v; break; }
  }
  return Math.round((a - b) * 100) / 100;
}

// ---- main --------------------------------------------------------------------
const lakes = [];
const levels = {};
const health = [];
let fresh = 0;
let stale = 0;
let missing = 0;

for (const lk of seed) {
  const src = SOURCES[lk.slug];
  process.stdout.write(`• ${lk.name} (${lk.state}) … `);

  let newReading = null;
  let err = null;
  if (src) {
    try {
      if (src.feed === 'cdec') newReading = await fetchCDEC(src.site, lk.capacity_af);
      else if (src.feed === 'usgs') newReading = await fetchUSGS(src.site);
      else if (src.feed === 'usbr') newReading = await fetchUSBR(src.site, lk.capacity_af);
    } catch (e) {
      err = e.message;
    }
  }

  const cached = prevLevels[lk.slug] || null;

  // Rule 3+4: choose the freshest reading we have; label honestly.
  let chosen = null;
  let status = 'missing';
  if (newReading && (!cached || ageDays(newReading.as_of) <= ageDays(cached.as_of))) {
    chosen = newReading;
    status = ageDays(newReading.as_of) <= FRESH_DAYS ? 'fresh' : 'stale-upstream';
  } else if (cached) {
    chosen = cached;
    status = newReading ? 'stale-cached-fresher' : (err ? `stale-fetch-failed:${err}` : 'stale-cached');
  }
  const chosenFresh = chosen && ageDays(chosen.as_of) <= FRESH_DAYS;

  if (chosenFresh) fresh++;
  else if (chosen) stale++;
  else missing++;

  // registry entry (always ships — the page is the SEO asset)
  lakes.push({
    slug: lk.slug,
    name: lk.name,
    state: lk.state,
    river: lk.river,
    operator: lk.operator,
    full_pool_ft: lk.full_pool_ft ?? null,
    capacity_af: lk.capacity_af ?? null,
    vol: lk.vol ?? null,
    kd: lk.kd ?? null,
    feed: src?.feed ?? null,
    usgs_site: src?.feed === 'usgs' ? src.site : null,
    cdec_id: src?.feed === 'cdec' ? src.site : (lk.cdec_id ?? null),
    lat: null,
    lon: null,
  });

  if (chosen) {
    let feet_from_full = null;
    if (chosen.msl && lk.full_pool_ft && chosen.level_ft != null) {
      feet_from_full = Math.round((lk.full_pool_ft - chosen.level_ft) * 100) / 100;
    }
    levels[lk.slug] = {
      level_ft: chosen.level_ft,
      storage_af: chosen.storage_af ?? null,
      pct_full: chosen.pct_full ?? null,
      feet_from_full,
      param: chosen.param_label,
      delta_24h: delta24(chosen.series),
      series: chosen.series.slice(-SERIES_DAYS),
      as_of: chosen.as_of,
      feed: src?.feed ?? chosen.feed ?? null,
      fresh: !!chosenFresh,
      status,
    };
    console.log(
      `${chosenFresh ? '✓' : '·'} ${chosen.level_ft ?? (chosen.storage_af != null ? chosen.storage_af + ' AF' : '?')} ` +
      `(feed=${src?.feed}) @ ${String(chosen.as_of).slice(0, 10)} age=${ageDays(chosen.as_of).toFixed(1)}d [${status}]`
    );
  } else {
    console.log(`✗ no live feed${src ? '' : ' (registry only)'}`);
  }

  health.push({
    slug: lk.slug,
    feed: src?.feed ?? null,
    as_of: chosen ? chosen.as_of : null,
    age_days: chosen ? Math.round(ageDays(chosen.as_of) * 10) / 10 : null,
    fresh: !!chosenFresh,
    status,
  });
}

mkdirSync(DATA, { recursive: true });
writeFileSync(LAKES_OUT, JSON.stringify(lakes, null, 2));
writeFileSync(LEVELS_OUT, JSON.stringify(levels, null, 2));
writeFileSync(
  HEALTH_OUT,
  JSON.stringify(
    {
      run_at: todayISO(),
      total: seed.length,
      fresh,
      stale,
      missing,
      fresh_slugs: health.filter((h) => h.fresh).map((h) => h.slug),
      lakes: health,
    },
    null,
    2,
  ),
);

console.log(`\nDone. ${seed.length} lakes → ${fresh} fresh · ${stale} stale(cached) · ${missing} no-feed.`);
console.log(`  → lakes.json · levels.json · health.json`);
console.log(`  Circuit-breaker: ${fresh === 0 ? 'ZERO fresh — exit 1' : 'ok'}`);

// Rule 6: nonzero exit ONLY when the whole run is cold (zero fresh data),
// which signals a systemic outage rather than one flaky lake. CI stays green
// while individual lakes degrade gracefully to last-known-good.
if (fresh === 0 && seed.length > 0) process.exit(1);
