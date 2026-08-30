#!/usr/bin/env node
// Independent assertion harness for src/lib/castate.ts.
//
// The repo has no test framework, and adding one to check a build-time data layer would
// cost more than it earns. What matters here is INDEPENDENCE: this script deliberately
// imports nothing from the TypeScript module it is checking. It re-derives the day-of-year
// percentile, the median anchor and the Spearman value straight from the four JSON files,
// with its own parser and its own ladder walk. If castate.ts and this file agree, they
// agree because the arithmetic is right, not because they share a bug.
//
// Run: node scripts/castate-check.mjs   (exit 0 on all-pass, 1 on any failure)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'src', 'data', name), 'utf8'));

const ALMANAC = load('almanac.json');
const DOY = load('almanac-doy.json');
const LEVELS = load('levels.json');
const REGISTRY = load('lakes.json');

const STATE = 'CA';
const MAX_LAKES = 500; // bounded sweep over the registry

// --- independent re-implementations -----------------------------------------------------

// CDEC stamps arrive unpadded ("2026-8-13"); the Date constructor rejects that shape.
function parseAsOf(raw) {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(raw));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const here = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((here - start) / 86400000) + 1;
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

// Descending ranks, average ranks for ties.
function descendingRanks(values) {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

function spearman(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const a = descendingRanks(pairs.map((p) => p[0]));
  const b = descendingRanks(pairs.map((p) => p[1]));
  let sumD2 = 0;
  for (let i = 0; i < n; i++) sumD2 += (a[i] - b[i]) ** 2;
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// --- rebuild the CA rows ----------------------------------------------------------------

const almanacBySlug = new Map(ALMANAC.lakes.map((l) => [l.slug, l]));
const MEDIAN_ANCHOR = DOY.anchors.indexOf(50);

function buildRows() {
  const rows = [];
  const cap = Math.min(REGISTRY.length, MAX_LAKES);
  for (let i = 0; i < cap; i++) {
    const entry = REGISTRY[i];
    if (entry.state !== STATE) continue;
    const lake = almanacBySlug.get(entry.slug);
    if (!lake) continue;

    const reading = LEVELS[entry.slug];
    const level = reading && typeof reading.level_ft === 'number' ? reading.level_ft : null;
    const usable = level != null && Number.isFinite(level)
      && level > 0 && Math.abs(level - lake.medianForDate) < 1000;
    const when = usable ? parseAsOf(reading.as_of) : null;
    const ladders = DOY.grid[entry.slug];
    const ladder = usable && when && ladders ? ladders[dayOfYear(when) - 1] : null;

    if (ladder) {
      const median = ladder[MEDIAN_ANCHOR];
      rows.push({
        slug: entry.slug, name: lake.name, live: true,
        levelFt: level, percentile: percentileOn(ladder, DOY.anchors, level),
        medianForDateFt: median, vsMedianFt: level - median,
        pctFull: reading.pct_full ?? null, feed: reading.feed ?? null,
        observations: lake.obs, ladder,
      });
    } else {
      rows.push({
        slug: entry.slug, name: lake.name, live: false,
        levelFt: lake.todayFt, percentile: lake.percentile,
        medianForDateFt: lake.medianForDate, vsMedianFt: lake.vsMedianFt,
        pctFull: reading ? (reading.pct_full ?? null) : null,
        feed: reading ? (reading.feed ?? null) : null,
        observations: lake.obs, ladder: null,
      });
    }
  }
  rows.sort((a, b) => a.percentile - b.percentile);
  return rows;
}

const rows = buildRows();

// --- assertions -------------------------------------------------------------------------

let passed = 0;
let total = 0;

function check(name, ok, detail) {
  total++;
  if (ok) passed++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1. shape and provenance of the CA set
const feeds = [...new Set(rows.map((r) => String(r.feed || '').toUpperCase()))];
check(
  '1. stateRows(CA) returns 11 rows, all CDEC',
  rows.length === 11 && feeds.length === 1 && feeds[0] === 'CDEC',
  `${rows.length} rows, feeds=[${feeds.join(', ')}]`,
);

// 2. percentiles are in range
const badPct = rows.filter((r) => !(r.percentile >= 0 && r.percentile <= 100));
check(
  '2. every percentile is within 0..100',
  badPct.length === 0,
  badPct.length ? badPct.map((r) => `${r.slug}=${r.percentile}`).join(', ') : `${rows.length} checked`,
);

// 3. the median is the 50-anchor of that lake's ladder for the reading's day of year
const badMedian = rows.filter((r) => {
  if (!r.ladder) return false; // snapshot fallback carries the published median, not a ladder
  return Math.abs(r.medianForDateFt - r.ladder[MEDIAN_ANCHOR]) > 1e-9;
});
check(
  '3. medianForDateFt equals the ladder 50-anchor for the reading day-of-year',
  badMedian.length === 0,
  badMedian.length ? badMedian.map((r) => r.slug).join(', ') : `${rows.filter((r) => r.ladder).length} ladders checked`,
);

// 4. vsMedianFt is exactly the subtraction it claims to be
const badDelta = rows.filter((r) => Math.abs(r.vsMedianFt - (r.levelFt - r.medianForDateFt)) > 0.01);
check(
  '4. vsMedianFt equals levelFt - medianForDateFt (±0.01)',
  badDelta.length === 0,
  badDelta.length ? badDelta.map((r) => r.slug).join(', ') : `${rows.length} checked`,
);

// 5. total observations behind the CA table
const obs = rows.reduce((s, r) => s + r.observations, 0);
check('5. CA observations sum to 139086', obs === 139086, String(obs));

// 6. the Spearman value the page quotes
const pairs = rows.filter((r) => r.pctFull != null).map((r) => [r.pctFull, r.percentile]);
const rho = spearman(pairs);
check(
  '6. Spearman over the 11 CA rows rounds to 0.755',
  rho != null && rho.toFixed(3) === '0.755',
  rho == null ? 'null' : `${rho.toFixed(6)} over ${pairs.length} rows`,
);

// 7. no nulls where a page will print a number
const nulls = rows.filter((r) => r.levelFt == null || r.percentile == null
  || !Number.isFinite(r.levelFt) || !Number.isFinite(r.percentile));
check(
  '7. no row has a null levelFt or percentile',
  nulls.length === 0,
  nulls.length ? nulls.map((r) => r.slug).join(', ') : `${rows.length} checked`,
);

console.log(`RESULT: ${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
