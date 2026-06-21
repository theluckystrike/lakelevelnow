// fetch-levels.mjs — lakelevelnow.com data pipeline.
// Reads src/data/lakes.seed.json, discovers/verifies the live data source per lake
// (USGS Water Services for most, CDEC for California), fetches the current reading
// + ~30-day series, GATES ON FRESHNESS (<=7 days) so we never ship stale data,
// and writes the registry (src/data/lakes.json) + readings (src/data/levels.json).
//
// Run locally and in the weekly GitHub Action:  node scripts/fetch-levels.mjs
// No API keys required (USGS + CDEC are free and keyless).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src', 'data');
const FRESH_DAYS = 7;
const SERIES_DAYS = 30;

const today = () => new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

// ---- helpers ----
const UA = 'lakelevelnow-data/1.0 (+https://lakelevelnow.com; contact@lakelevelnow.com)';
async function getJSON(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// Parse USGS RDB (tab-delimited w/ header + a '#' comment line) into array of objects.
function parseRDB(rdb) {
  const lines = rdb.split('\n').filter((l) => l.length && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  return lines.slice(2).map((l) => {
    const c = l.split('\t');
    const o = {};
    header.forEach((h, i) => (o[h] = c[i]));
    return o;
  });
}

// Distinctive search term from a lake name (strip generic words).
function searchTerm(name) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(lake|reservoir|the|o\.?\s*h\.?)\b/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

// Discover the best USGS lake-type site for a lake via the Site Service.
// Requires a "major filter" (stateCd). Returns {site,name,lat,lon} or null.
const STATE = { TX: 'tx', NV: 'nv', UT: 'ut', GA: 'ga', OK: 'ok', MO: 'mo', VA: 'va', NC: 'nc', KY: 'ky', AL: 'al', CA: 'ca' };
async function discoverUSGSSite(lake) {
  const st = STATE[lake.state];
  if (!st) return null;
  const term = searchTerm(lake.name);
  const url = `https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=${st}&siteName=${encodeURIComponent(term)}&siteType=LK,ST&siteStatus=all`;
  let rows;
  try {
    rows = parseRDB(await getJSON(url));
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const want = term.split(' ').filter((w) => w.length > 2);
  // Rank: name-token overlap, prefer LK type, prefer sites that look like the reservoir.
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    const nm = (r.station_nm || '').toLowerCase();
    const isLK = r.site_tp_code === 'LK';
    let score = isLK ? 2 : 0;
    for (const w of want) if (nm.includes(w)) score += 1;
    if (nm.includes('lake') || nm.includes('reservoir')) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = { site: r.site_no, name: r.station_nm, lat: r.dec_lat_va, lon: r.dec_long_va, type: r.site_tp_code };
    }
  }
  return bestScore >= 2 ? best : null;
}

// Fetch USGS instantaneous values (last 30d) for a site across candidate params.
// Reservoir elevation params (62614, 00062) are feet-msl (comparable to full_pool_ft);
// 00065 is gage height above datum (NOT msl).
const USGS_PARAMS = [
  { code: '62614', label: 'reservoir elevation', msl: true },
  { code: '00062', label: 'reservoir elevation', msl: true },
  { code: '00065', label: 'gage height', msl: false },
];
async function fetchUSGS(site) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=62614,00062,00065&siteStatus=all&period=P${SERIES_DAYS}D`;
  let d;
  try {
    d = JSON.parse(await getJSON(url));
  } catch {
    return null;
  }
  const ts = d?.value?.timeSeries || [];
  if (!ts.length) return null;
  // Prefer MSL-elevation params, then freshest.
  const ranked = ts
    .map((t) => {
      const code = t.variable.variableCode[0].value;
      const meta = USGS_PARAMS.find((p) => p.code === code) || { label: 'stage', msl: false };
      const vals = t.values[0].value.filter((v) => v.value && v.value !== '-999999');
      if (!vals.length) return null;
      const last = vals[vals.length - 1];
      return {
        code,
        msl: meta.msl,
        label: meta.label,
        level: parseFloat(last.value),
        as_of: last.dateTime,
        series: vals.map((v) => ({ t: v.dateTime, v: parseFloat(v.value) })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.msl - a.msl) || (new Date(b.as_of) - new Date(a.as_of)));
  return ranked[0] || null;
}

// Fetch CDEC storage (sensor 15) + elevation (sensor 6) daily series.
async function fetchCDEC(station, capacity) {
  const start = ymd(daysAgo(SERIES_DAYS + 5));
  const end = ymd(today());
  const url = `https://cdec.water.ca.gov/dynamicapp/req/JSONDataServlet?Stations=${station}&SensorNums=15,6&dur_code=D&Start=${start}&End=${end}`;
  let rows;
  try {
    rows = JSON.parse(await getJSON(url));
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const sto = rows.filter((r) => String(r.SENSOR_NUM) === '15' && r.value && r.value !== -9999).sort((a, b) => new Date(a.date) - new Date(b.date));
  const elev = rows.filter((r) => String(r.SENSOR_NUM) === '6' && r.value && r.value !== -9999).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!sto.length) return null;
  const last = sto[sto.length - 1];
  const lastElev = elev.length ? elev[elev.length - 1].value : null;
  const storage_af = last.value;
  return {
    code: 'CDEC-storage',
    msl: true,
    label: 'reservoir storage',
    level: lastElev ?? null, // elevation ft msl if available
    storage_af,
    pct_full: capacity ? Math.max(0, Math.min(100, Math.round((storage_af / capacity) * 100))) : null,
    as_of: last.date.replace(/(\d{4})-(\d{1,2})-(\d{1,2}).*/, '$1-$2-$3'),
    series: sto.slice(-SERIES_DAYS).map((r) => ({ t: r.date, v: r.value, storage: true })),
  };
}

function delta24(series) {
  if (!series || series.length < 2) return null;
  const a = series[series.length - 1].v;
  const b = series[series.length - 2].v;
  return Math.round((a - b) * 100) / 100;
}

// ---- main ----
const seed = JSON.parse(readFileSync(join(DATA, 'lakes.seed.json'), 'utf8'));
const lakes = [];
const levels = {};
let fresh = 0;

for (const lk of seed) {
  process.stdout.write(`• ${lk.name} (${lk.state}) … `);
  let reading = null;
  let feed = null;
  let site = null;

  if (lk.cdec_id) {
    feed = 'CDEC';
    reading = await fetchCDEC(lk.cdec_id, lk.capacity_af).catch(() => null);
  }
  if (!reading) {
    const found = await discoverUSGSSite(lk).catch(() => null);
    if (found) {
      site = found.site;
      feed = 'USGS';
      reading = await fetchUSGS(found.site).catch(() => null);
    }
  }

  const isFresh = reading && ageDays(reading.as_of) <= FRESH_DAYS;
  if (isFresh) fresh++;

  // registry entry (registry = the moat; ships regardless so the page exists)
  lakes.push({
    slug: lk.slug,
    name: lk.name,
    state: lk.state,
    river: lk.river,
    operator: lk.operator,
    full_pool_ft: lk.full_pool_ft ?? null,
    capacity_af: lk.capacity_af ?? null,
    vol: lk.vol,
    kd: lk.kd,
    feed,
    usgs_site: site,
    cdec_id: lk.cdec_id ?? null,
    lat: null,
    lon: null,
  });

  if (reading) {
    let feet_from_full = null;
    if (reading.msl && lk.full_pool_ft && reading.level) {
      feet_from_full = Math.round((lk.full_pool_ft - reading.level) * 100) / 100;
    }
    levels[lk.slug] = {
      level_ft: reading.level,
      storage_af: reading.storage_af ?? null,
      pct_full: reading.pct_full ?? null,
      feet_from_full,
      param: reading.label,
      delta_24h: delta24(reading.series),
      series: reading.series.slice(-SERIES_DAYS),
      as_of: reading.as_of,
      feed,
      fresh: !!isFresh,
    };
  }
  console.log(reading ? `${feed} ${reading.level ?? reading.storage_af + ' AF'} @ ${reading.as_of.slice(0, 10)} ${isFresh ? '✓ fresh' : '· stale, gated'}` : 'no data found');
}

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'lakes.json'), JSON.stringify(lakes, null, 2));
writeFileSync(join(DATA, 'levels.json'), JSON.stringify(levels, null, 2));

console.log(`\nDone. ${lakes.length} lakes in registry, ${fresh} with fresh (<=${FRESH_DAYS}d) live data.`);
console.log(`  → src/data/lakes.json, src/data/levels.json`);
