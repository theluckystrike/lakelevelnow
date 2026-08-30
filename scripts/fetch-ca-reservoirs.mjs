// fetch-ca-reservoirs.mjs — daily current conditions for CDEC's 48-reservoir summary.
//
// Pulls ONE page: CDEC's Daily Reservoir Storage Summary
//   https://cdec.water.ca.gov/reportapp/javareports?name=RES
// and writes the current column set (storage, elevation, % of capacity, CDEC's own
// average) to src/data/ca-reservoirs.json.
//
// This script is deliberately the SMALL half of the California reservoir page. The
// expensive half — 615,712 daily observations turned into per-station, per-day-of-year
// quantile ladders — is harvested once and committed as src/data/ca-ladders.json,
// because a 40-year record does not change between builds. Only the readings do.
// src/lib/careservoirs.ts joins the two.
//
// ── Reliability rules (the same "NASA rules" fetch-levels.mjs runs under) ───────────
//  1. DETERMINISTIC INPUTS — the station roster is NOT discovered from the page. It is
//     the committed ca-ladders.json `stations` map. One URL, one request, no search.
//  2. BOUNDED EXECUTION — hard timeout + fixed retry budget with exponential backoff.
//     No call can hang the run.
//  3. FAIL-SAFE — a transient upstream failure NEVER destroys a good reading. On any
//     fetch or parse failure the previous src/data/ca-reservoirs.json is left exactly
//     as it is. A station that vanishes from an otherwise-good report is carried
//     forward from the previous file and re-labeled (`carried: true`) with its own
//     older `as_of`, so the page can date it honestly instead of dropping a row.
//  4. FAIL-CLOSED FRESHNESS — nothing here is ever stamped "fresh". The file carries
//     only the report's own `asOf`, and a parse whose asOf is unreadable, or OLDER
//     than the asOf already on disk, is rejected rather than written. Stale data can
//     therefore never overwrite newer data, and no reader can be told a date is
//     current when it is not. A report older than FRESH_DAYS is logged loudly.
//  5. NO SILENT FAILURES — every outcome is logged: rows parsed, stations missing from
//     the roster, stations carried forward, and the count with a real storage value.
//  6. '---' IS NOT ZERO — CDEC prints '---' for a value it does not have. Every such
//     cell becomes null. A reservoir with no reported storage must never render as
//     empty; it renders as unknown.
//
// Exit code: 0 on success AND on a transient failure with a previous file on disk
// (a flaky single fetch must never break CI). 1 only when there is no previous file
// to fall back on — a first run with no data has to fail loudly.
//
// Run:  node scripts/fetch-ca-reservoirs.mjs   (npm run fetch)
// No API keys required.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src', 'data');
const LADDERS_PATH = join(DATA, 'ca-ladders.json');
const OUT_PATH = join(DATA, 'ca-reservoirs.json');

const REPORT_URL = 'https://cdec.water.ca.gov/reportapp/javareports?name=RES';
const UA = 'lakelevelnow-data/1.0 (+https://lakelevelnow.com; contact@lakelevelnow.com)';
const TIMEOUT_MS = 20000;
const RETRIES = 3;
const FRESH_DAYS = 7;
/** A good report always carries the whole roster. Below this the parse is not trusted. */
const MIN_ROWS = 40;
/** Upper bound on the table sweep (rule 2 applies to loops as well as to sockets). */
const MAX_ROWS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

// ---- bounded, retried HTTP (rule 2) -------------------------------------------------
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
        headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,*/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      console.log(`  · attempt ${attempt + 1}/${RETRIES + 1} failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---- HTML → values ------------------------------------------------------------------
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

/**
 * A numeric cell, or null. CDEC prints '---' where it has no value; that is a statement
 * about the reservoir, not a zero, and is the single most dangerous cell on the page to
 * coerce (rule 6). Anything that is not a finite number after removing thousands commas
 * is null too.
 */
function num(cell) {
  const t = strip(cell);
  if (!t || /^-+$/.test(t)) return null;
  const v = Number(t.replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/** "Ending at midnight - 08/28/2026" → "2026-08-28". Null when the stamp is not there. */
function parseAsOf(html) {
  const m = /Ending at midnight\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(html);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** "Report generated: August 29, 2026 13:05" → that string. Null when absent. */
function parseGenerated(html) {
  const m = /Report generated:\s*([^<\n]+)/.exec(html);
  return m ? m[1].trim() : null;
}

/**
 * The 12-column "Water Storage" table. Basin header rows carry a <th class='header3'>
 * and no <td>s; they are skipped here because the basin already lives, permanently, in
 * ca-ladders.json. The station id comes from the staMeta link rather than the cell text,
 * which is the only place on the row where it is unambiguous.
 */
function parseTable(html) {
  const start = html.indexOf('<table id="RES"');
  if (start < 0) throw new Error('table id="RES" not found');
  const end = html.indexOf('</table>', start);
  if (end < 0) throw new Error('unterminated table id="RES"');
  const table = html.slice(start, end);

  const out = [];
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (out.length >= MAX_ROWS) break;
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 9) continue; // basin header + thead rows
    const link = /station_id=([A-Z0-9]+)/.exec(tds[1]);
    const id = link ? link[1] : strip(tds[1]);
    if (!/^[A-Z0-9]{2,6}$/.test(id)) continue;
    out.push({
      id,
      name: strip(tds[0]),
      capacity_af: num(tds[2]),
      elevation_ft: num(tds[3]),
      storage_af: num(tds[4]),
      storage_change_af: num(tds[5]),
      pct_capacity: num(tds[6]),
      cdec_avg_storage_af: num(tds[7]),
      cdec_pct_average: num(tds[8]),
    });
  }
  return out;
}

// ---- fail-safe helpers (rule 3) ------------------------------------------------------
function readPrevious() {
  if (!existsSync(OUT_PATH)) return null;
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    return prev && prev.stations ? prev : null;
  } catch (e) {
    console.log(`! previous ca-reservoirs.json is unreadable (${e.message}) — treated as absent`);
    return null;
  }
}

/** Keep what is on disk and stop. Exit 0 when there IS something to keep, 1 when not. */
function bail(reason, previous) {
  if (previous) {
    console.log(`! ${reason}`);
    console.log(`  → KEEPING existing src/data/ca-reservoirs.json (asOf ${previous.asOf}, ` +
      `${Object.keys(previous.stations).length} stations). Exit 0: a flaky fetch is not a build failure.`);
    process.exit(0);
  }
  console.error(`! ${reason}`);
  console.error('  → no previous src/data/ca-reservoirs.json to fall back on. Exit 1.');
  process.exit(1);
}

const daysBetween = (isoA, isoB) => {
  const a = Date.parse(`${isoA}T00:00:00Z`);
  const b = Date.parse(`${isoB}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 86400000 : null;
};

// ---- run -----------------------------------------------------------------------------
const previous = readPrevious();

let roster;
try {
  roster = JSON.parse(readFileSync(LADDERS_PATH, 'utf8')).stations;
  if (!roster || typeof roster !== 'object') throw new Error('no stations map');
} catch (e) {
  // Rule 1: without the committed roster there is no deterministic input, so there is
  // nothing to validate the report against. That is a repo problem, not a network one.
  console.error(`! cannot read station roster from src/data/ca-ladders.json: ${e.message}`);
  process.exit(1);
}
const rosterIds = Object.keys(roster);
console.log(`CDEC daily reservoir summary — roster ${rosterIds.length} stations (ca-ladders.json)`);

let html;
try {
  html = await httpGet(REPORT_URL);
  console.log(`✓ GET ${REPORT_URL} → ${html.length.toLocaleString('en-US')} bytes`);
} catch (e) {
  bail(`fetch failed after ${RETRIES + 1} attempts: ${e.message}`, previous);
}

let asOf = null;
let reportGenerated = null;
let parsed = [];
try {
  asOf = parseAsOf(html);
  reportGenerated = parseGenerated(html);
  if (!asOf) throw new Error('no "Ending at midnight - MM/DD/YYYY" stamp on the page');
  parsed = parseTable(html);
  if (parsed.length < MIN_ROWS) {
    throw new Error(`only ${parsed.length} station rows parsed, below the ${MIN_ROWS} floor`);
  }
} catch (e) {
  bail(`parse failed: ${e.message}`, previous);
}

console.log(`  asOf ${asOf} · report generated ${reportGenerated ?? '(unstamped)'} · ${parsed.length} rows parsed`);

// Rule 4: never let an older report overwrite a newer one already on disk.
if (previous && previous.asOf && asOf < previous.asOf) {
  bail(`report asOf ${asOf} is OLDER than the ${previous.asOf} already on disk`, previous);
}
const age = daysBetween(asOf, nowISO().slice(0, 10));
if (age != null && age > FRESH_DAYS) {
  console.log(`! upstream report is ${age.toFixed(0)} days old (> ${FRESH_DAYS}); writing it, ` +
    'but nothing here is labeled fresh — the page dates every figure by asOf.');
}

const byId = new Map(parsed.map((r) => [r.id, r]));
const stations = {};
let carried = 0;
for (let i = 0; i < rosterIds.length; i++) {
  const id = rosterIds[i];
  const row = byId.get(id);
  if (row) {
    stations[id] = { ...row, as_of: asOf, carried: false };
    continue;
  }
  // Rule 3: absent from today's report — keep yesterday's number, dated yesterday.
  const old = previous?.stations?.[id];
  if (old) {
    stations[id] = { ...old, carried: true };
    carried++;
    console.log(`  · ${id} absent from today's report — carried forward from ${old.as_of}`);
  } else {
    console.log(`  · ${id} absent from today's report and has no previous reading — omitted`);
  }
}

const extra = parsed.filter((r) => !roster[r.id]).map((r) => r.id);
if (extra.length) {
  console.log(`  · ${extra.length} station(s) in the report but not in the roster: ${extra.join(', ')}`);
  console.log('    (kept out of ca-reservoirs.json — they have no committed history to join to)');
}
const missing = rosterIds.filter((id) => !stations[id]);
if (missing.length) console.log(`  · ${missing.length} roster station(s) with no reading at all: ${missing.join(', ')}`);

const ok = Object.values(stations).filter((s) => s.storage_af != null).length;
const nullStorage = Object.entries(stations).filter(([, s]) => s.storage_af == null).map(([id]) => id);

mkdirSync(DATA, { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify({
  asOf,
  reportGenerated,
  fetchedAt: nowISO(),
  stations,
  ok,
}, null, 2));

console.log(`\nDone. ${Object.keys(stations).length} stations written → ${ok} with a storage value · ` +
  `${nullStorage.length} reported '---' (null, never 0) · ${carried} carried forward.`);
if (nullStorage.length) console.log(`  no storage reported: ${nullStorage.join(', ')}`);
console.log('  → src/data/ca-reservoirs.json');
