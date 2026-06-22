// discover-sources.mjs — DEV-ONLY tool (never run in CI/build).
//
// NASA rule: the live pipeline must be DETERMINISTIC — no runtime name-discovery
// against the USGS site service. This script is the one place discovery happens.
// Run it by hand after adding lakes, verify the candidates it prints, then bake
// the verified {feed, site, param} triples into src/data/sources.json. The live
// fetch-levels.mjs then reads ONLY those explicit bindings.
//
// For every non-CDEC lake it:
//   1. queries the USGS site service by name (+state, LK/ST),
//   2. for each candidate site, probes IV for elevation params (62614/00062)
//      and gage height (00065),
//   3. prints the freshest reading and a ready-to-bake sources.json fragment.
//
// Run: node scripts/discover-sources.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src', 'data');
const UA = 'lakelevelnow-data/1.0 (+https://lakelevelnow.com; contact@lakelevelnow.com)';

const STATE = { TX: 'tx', NV: 'nv', UT: 'ut', GA: 'ga', OK: 'ok', MO: 'mo', VA: 'va', NC: 'nc', KY: 'ky', AL: 'al', AZ: 'az', AR: 'ar' };

async function httpGet(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' } }, );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

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

function term(name) {
  return name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\b(lake|reservoir|the|lewis|smith|kerr|buggs|island|oh|o\.?h\.?)\b/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').trim().split(/\s+/).filter(Boolean);
}

async function candidateSites(lake) {
  const st = STATE[lake.state];
  if (!st) return [];
  const words = term(lake.name);
  const q = encodeURIComponent(words.slice(0, 2).join(' '));
  let rows;
  try {
    rows = parseRDB(await httpGet(`https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=${st}&siteName=${q}&siteType=LK,ST,RS&siteStatus=all`));
  } catch {
    return [];
  }
  // Rank: LK first, then station name token overlap, then "near <reservoir town>".
  const want = words.filter((w) => w.length > 2);
  const scored = rows.map((r) => {
    const nm = (r.station_nm || '').toLowerCase();
    let score = r.site_tp_code === 'LK' ? 3 : 0;
    for (const w of want) if (nm.includes(w)) score += 2;
    if (/lake|reservoir|lk\b/.test(nm)) score += 1;
    return { site: r.site_no, name: r.station_nm, type: r.site_tp_code, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= 4).slice(0, 4);
}

async function probeIV(site) {
  let d;
  try {
    d = JSON.parse(await httpGet(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=62614,00062,00065&siteStatus=all&period=P30D`));
  } catch {
    return null;
  }
  const ts = d?.value?.timeSeries || [];
  const out = [];
  for (const t of ts) {
    const code = t.variable.variableCode[0].value;
    const vals = t.values[0].value.filter((v) => v.value && v.value !== '-999999');
    if (!vals.length) continue;
    const last = vals[vals.length - 1];
    out.push({ code, value: parseFloat(last.value), as_of: last.dateTime, n: vals.length });
  }
  // Prefer elevation (msl), then gage height.
  const rank = { '62614': 3, '00062': 2, '00065': 1 };
  out.sort((a, b) => (rank[b.code] || 0) - (rank[a.code] || 0));
  return out[0] || null;
}

const seed = JSON.parse(readFileSync(join(DATA, 'lakes.seed.json'), 'utf8'));
const bindings = {};
let found = 0;
let missing = [];

for (const lk of seed) {
  if (lk.cdec_id) continue; // CDEC lakes are already bound
  process.stdout.write(`• ${lk.name} (${lk.state}) … `);
  const cands = await candidateSites(lk);
  let pick = null;
  for (const c of cands) {
    const r = await probeIV(c.site);
    if (!r) continue;
    pick = { ...c, ...r };
    break;
  }
  if (pick) {
    found++;
    const param = pick.code; // 62614/00062 = elevation msl; 00065 = gage height
    bindings[lk.slug] = { feed: 'usgs', site: pick.site, param };
    console.log(`✓ site ${pick.site} [${pick.type}] ${pick.name}  param=${param} last=${pick.value} @ ${pick.as_of?.slice(0, 10)}`);
  } else {
    missing.push(lk.slug);
    console.log(`✗ no IV candidate${cands.length ? ` (checked ${cands.map((c) => c.site).join(',')})` : ''}`);
  }
}

console.log(`\n=== verified ${found} USGS bindings; missing ${missing.length}: ${missing.join(', ')} ===`);
console.log('\n// Bake into src/data/sources.json:');
console.log(JSON.stringify(bindings, null, 2));
