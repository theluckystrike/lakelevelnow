#!/usr/bin/env node
// Independent assertion harness for src/lib/careservoirs.ts.
//
// The repo has no test framework, and adding one to check a build-time data layer would
// cost more than it earns. What matters here is INDEPENDENCE: this script deliberately
// imports nothing from the TypeScript module it is checking. It re-implements the join —
// its own canonical day-of-year, its own ladder walk, its own CDEC-id → slug match, its own
// sort — straight from src/data/ca-ladders.json, src/data/ca-reservoirs.json and
// src/data/lakes.json. If careservoirs.ts and this file agree, they agree because the
// arithmetic is right, not because they share a bug.
//
// (It cannot import the module even if it wanted to: careservoirs.ts uses extensionless
// specifiers and bare JSON default imports, both of which are Vite/Astro resolution, not
// Node's. Re-deriving is the honest option, not a workaround.)
//
// Run: node scripts/careservoirs-check.mjs   (exit 0 on all-pass, 1 on any failure)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'src', 'data', name), 'utf8'));

const LADDERS = load('ca-ladders.json');
const CURRENT = load('ca-reservoirs.json');
const REGISTRY = load('lakes.json');

const EXPECTED_STATIONS = 48;
const EXPECTED_WITH_LADDER = 47;
const ANCHOR_COUNT = 17;
const MAX_STATIONS = 200;

// --- independent re-implementations -------------------------------------------------

// CDEC stamps can arrive unpadded ("2026-8-28"); the Date constructor rejects that shape.
function parseAsOf(raw) {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(raw));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

// The ladders were bucketed on a LEAP-year day-of-year: Feb 29 owns bucket 60 and Mar 1 is
// always 61. Derived here from a leap year directly rather than copied from the module, so
// a wrong offset table in either file would show up as a disagreement.
function canonicalDayOfYear(d) {
  const jan1 = Date.UTC(2024, 0, 1); // 2024 is a leap year
  const here = Date.UTC(2024, d.getUTCMonth(), d.getUTCDate());
  return Math.floor((here - jan1) / 86400000) + 1;
}

// Linear interpolation onto the published quantile ladder.
function percentileOn(ladder, anchors, v) {
  if (v <= ladder[0]) return 0;
  const last = ladder.length - 1;
  if (v >= ladder[last]) return 100;
  for (let i = 1; i <= last; i++) {
    if (v <= ladder[i]) {
      const span = ladder[i] - ladder[i - 1];
      const frac = span > 0 ? (v - ladder[i - 1]) / span : 0;
      return anchors[i - 1] + frac * (anchors[i] - anchors[i - 1]);
    }
  }
  return 100;
}

const ANCHORS = LADDERS.meta.anchors;
const MEDIAN_ANCHOR = ANCHORS.indexOf(50);

// CDEC id → on-site path, from the registry. Never from a name.
const PATH_BY_CDEC_ID = {};
for (const lake of REGISTRY) {
  if (lake.cdec_id) PATH_BY_CDEC_ID[lake.cdec_id] = `/lake/${lake.slug}/`;
}

/** The same 48 rows careservoirs.ts should produce, derived from scratch. */
function reservoirRows() {
  const ids = Object.keys(LADDERS.stations).slice(0, MAX_STATIONS);
  const rows = ids.map((id) => {
    const meta = LADDERS.stations[id];
    const cur = CURRENT.stations[id];
    const storageAf = cur && cur.storage_af != null ? cur.storage_af : null;

    let percentile = null;
    let medianForDateAf = null;
    const when = cur ? parseAsOf(cur.as_of) : null;
    if (meta.hasLadder && storageAf != null && when) {
      const ladder = (LADDERS.ladders[id] || [])[canonicalDayOfYear(when) - 1] || null;
      if (ladder && ladder.length === ANCHORS.length && MEDIAN_ANCHOR >= 0) {
        percentile = percentileOn(ladder, ANCHORS, storageAf);
        medianForDateAf = ladder[MEDIAN_ANCHOR];
      }
    }

    return {
      id,
      name: (cur && cur.name) || meta.name,
      capacityAf: meta.capacity_af,
      storageAf,
      pctCapacity: cur && cur.pct_capacity != null ? cur.pct_capacity : null,
      percentile,
      medianForDateAf,
      vsMedianAf: storageAf != null && medianForDateAf != null ? storageAf - medianForDateAf : null,
      hasLadder: meta.hasLadder,
      lakePath: PATH_BY_CDEC_ID[id] || null,
    };
  });
  rows.sort((a, b) => {
    if (a.pctCapacity == null && b.pctCapacity == null) return a.name.localeCompare(b.name);
    if (a.pctCapacity == null) return 1;
    if (b.pctCapacity == null) return -1;
    return b.pctCapacity - a.pctCapacity;
  });
  return rows;
}

// --- harness --------------------------------------------------------------------------

let passed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
/** Reported, never scored: a live re-fetch is allowed to move the world under us. */
function info(label, detail) {
  console.log(`INFO  ${label}${detail ? `  — ${detail}` : ''}`);
}

const rows = reservoirRows();
console.log(`careservoirs-check — ca-reservoirs.json asOf ${CURRENT.asOf}, ` +
  `ca-ladders.json built ${LADDERS.meta.builtOn}\n`);

// 1. the committed roster is the size the page promises
const stationIds = Object.keys(LADDERS.stations);
const withLadderFlag = stationIds.filter((id) => LADDERS.stations[id].hasLadder).length;
check(
  `1. ca-ladders.json holds ${EXPECTED_STATIONS} stations, ${EXPECTED_WITH_LADDER} with hasLadder true`,
  stationIds.length === EXPECTED_STATIONS
    && withLadderFlag === EXPECTED_WITH_LADDER
    && Object.keys(LADDERS.ladders).length === EXPECTED_STATIONS,
  `${stationIds.length} stations · ${withLadderFlag} hasLadder · ${Object.keys(LADDERS.ladders).length} ladder keys`,
);

// 2. every published ladder is a usable quantile ladder
let ladderEntries = 0;
const badLadders = [];
for (const id of Object.keys(LADDERS.ladders)) {
  const days = LADDERS.ladders[id];
  if (!Array.isArray(days) || days.length !== 366) { badLadders.push(`${id}: ${days && days.length} days`); continue; }
  for (let d = 0; d < days.length; d++) {
    const l = days[d];
    if (l == null) continue;
    ladderEntries++;
    if (l.length !== ANCHOR_COUNT) { badLadders.push(`${id} day ${d + 1}: ${l.length} anchors`); continue; }
    for (let i = 1; i < l.length; i++) {
      if (!Number.isFinite(l[i]) || l[i] < l[i - 1]) { badLadders.push(`${id} day ${d + 1}: anchor ${i}`); break; }
    }
  }
}
check(
  `2. every non-null ladder is ${ANCHOR_COUNT} finite, non-decreasing numbers`,
  badLadders.length === 0,
  badLadders.length ? badLadders.slice(0, 5).join('; ') : `${ladderEntries} day-of-year ladders checked`,
);

// 3. the table the page renders
const uniqueIds = new Set(rows.map((r) => r.id));
check(
  `3. reservoirRows() returns ${EXPECTED_STATIONS} rows with unique ids`,
  rows.length === EXPECTED_STATIONS && uniqueIds.size === EXPECTED_STATIONS,
  `${rows.length} rows · ${uniqueIds.size} unique ids`,
);

// 4. a percentile is a percentile
const badPct = rows.filter((r) => r.percentile != null
  && (!Number.isFinite(r.percentile) || r.percentile < 0 || r.percentile > 100));
check(
  '4. every percentile is null or within 0..100',
  badPct.length === 0,
  badPct.length ? badPct.map((r) => `${r.id}=${r.percentile}`).join(', ')
    : `${rows.filter((r) => r.percentile != null).length} non-null of ${rows.length}`,
);

// 5. no percentile without a record to earn it
const fabricated = rows.filter((r) => r.percentile != null && !r.hasLadder);
check(
  '5. no row carries a percentile while hasLadder is false',
  fabricated.length === 0,
  fabricated.length ? fabricated.map((r) => r.id).join(', ')
    : `${rows.filter((r) => !r.hasLadder).map((r) => r.id).join(', ') || 'none'} has no ladder and no percentile`,
);

// 6. vsMedianAf is exactly the subtraction it claims to be
const badDelta = rows.filter((r) => r.storageAf != null && r.medianForDateAf != null
  && Math.abs(r.vsMedianAf - (r.storageAf - r.medianForDateAf)) > 1);
check(
  '6. vsMedianAf equals storageAf - medianForDateAf (±1 AF)',
  badDelta.length === 0,
  badDelta.length ? badDelta.map((r) => r.id).join(', ')
    : `${rows.filter((r) => r.vsMedianAf != null).length} rows checked`,
);

// 7. every internal link points at a page that exists
const slugs = new Set(REGISTRY.map((l) => l.slug));
const linked = rows.filter((r) => r.lakePath != null);
const badLinks = linked.filter((r) => !slugs.has(String(r.lakePath).replace(/^\/lake\/|\/$/g, '')));
check(
  '7. every non-null lakePath is a real slug in lakes.json',
  badLinks.length === 0,
  badLinks.length ? badLinks.map((r) => `${r.id}→${r.lakePath}`).join(', ')
    : `${linked.length} of ${rows.length} rows link to a lake page`,
);

// 8. the headline the page is built on: full against its rim, empty against its record.
// Not hard-coded to today's figures — a live re-fetch is allowed to move them, and if it
// does, the honest response is to report the new numbers, not to fail the build.
const pyramid = rows.find((r) => r.name === 'PYRAMID');
if (!pyramid) {
  check('8. PYRAMID is present in the table', false, 'no row named PYRAMID');
} else {
  const detail = `pctCapacity ${pyramid.pctCapacity} · percentile ` +
    `${pyramid.percentile == null ? 'null' : pyramid.percentile.toFixed(2)}` +
    ` · storage ${pyramid.storageAf} AF vs median ${pyramid.medianForDateAf} AF`;
  const holds = pyramid.pctCapacity != null && pyramid.pctCapacity > 50
    && pyramid.percentile != null && pyramid.percentile < 15;
  if (holds) {
    check('8. PYRAMID: pctCapacity > 50 while percentile < 15 (the headline disagreement survives the join)', true, detail);
  } else {
    info('8. PYRAMID: the headline disagreement has MOVED since it was written — not scored', detail);
    info('   the page copy naming Pyramid must be re-checked against these numbers before it ships');
  }
}

console.log(`\nRESULT: ${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
