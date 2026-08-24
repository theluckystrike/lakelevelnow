// Fetch Reclamation's COMPLETE daily pool-elevation record for Lake Powell (site 919)
// and write the statistics computed from it to src/data/powell-history.json.
//
// WHY THIS EXISTS: the site carried `recordLowFt: 3519.92` as a hand-typed constant in
// src/lib/lakes.ts, labelled "Record low since first fill" and set on 2023-04-13. On
// 2026-08-20 the lake fell BELOW that figure, so two live pages began rendering
// "-1.0 ft above the record low" — a negative number inside a hardcoded "above", next to
// a label that was no longer true. A constant cannot track a record. This computes it.
//
// It also settles the sourcing problem src/lib/lakes.ts documents at length: no agency
// page states in words which single DAY of the record was the lowest, so the ranking may
// not be asserted from a query window or from a press release. Reclamation's own complete
// daily file is the one source that CAN establish it, because it carries every reading
// from 1963-12-28 onward. Computing the minimum over that file is not an inference, it is
// a measurement over the whole population, and that is what this script does.
//
// THE FIRST-FILL BOUNDARY IS OURS AND IS ALWAYS STATED. Lake Powell reached full pool on
// 1980-06-22. Readings before that are the reservoir filling for the first time, not
// operations, which is why the 1964 minimum of 3,394.50 ft is not comparable to a modern
// drawdown. FIRST_FILL_CUTOFF is a deliberately conservative 1981-01-01 and every figure
// derived from it is published next to the boundary that produced it, never implied.
//
// FAILURE POSTURE, same as fetch-levels.mjs and fetch-powell-ramps.mjs: any network or
// parse failure keeps the previous file untouched and exits 0. A build must never break
// because Reclamation changed a header. No axios (supply-chain rule), native fetch only,
// bounded retries, bounded loops.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One entry per lake with a complete Reclamation daily pool-elevation file. Adding a lake here
// is the whole job: the fetch, the parse, the statistics and the encoded series all follow.
//
// firstFillCutoff is OURS, not Reclamation's, and every figure derived from it is published next
// to it. It marks the point after which the reservoir was being operated rather than filled for
// the first time, because the filling years reach far lower than any modern drawdown and are not
// a comparable state. Powell reached full pool in 1980; Mead first passed 1,220 ft on 1941-07-24,
// verified in the file itself.
const LAKES = [
  {
    slug: 'powell',
    name: 'Lake Powell',
    site: '919',
    out: 'powell-history.json',
    catalog: 'https://data.usbr.gov/catalog/2362/item/508',
    firstFillCutoff: '1981-01-01',
  },
  {
    slug: 'mead',
    name: 'Lake Mead',
    site: '921',
    out: 'mead-history.json',
    catalog: 'https://data.usbr.gov/catalog/2362/item/508',
    firstFillCutoff: '1942-01-01',
  },
];
const srcOf = (site) => `https://www.usbr.gov/uc/water/hydrodata/reservoir_data/${site}/csv/49.csv`;
const TIMEOUT_MS = 30000;
const RETRIES = 3;
const MAX_ROWS = 40000;        // bounded; the real file is ~22,900 rows
const MIN_ROWS = 1000;         // a truncated file is not a series
const UA = 'lakelevelnow/1.0 (+https://lakelevelnow.com)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed');
}

// Parse "datetime,pool elevation" rows. Drops the header, blank lines, malformed dates and
// the -999999 / empty sentinels Reclamation uses for a missing reading.
function parseSeries(txt) {
  const lines = String(txt).split('\n');
  const out = [];
  for (let i = 1; i < lines.length && out.length < MAX_ROWS; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 2) continue;
    const d = c[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const v = Number(c[1]);
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push({ d, v });
  }
  return out;
}

function computeStats(series, FIRST_FILL_CUTOFF) {
  const latest = series[series.length - 1];
  let seriesLow = series[0];
  let recordHigh = series[0];
  let postFillLow = null;
  let daysBelowLatest = 0;
  let firstBelowDate = null;
  let lastBelowDate = null;

  for (let i = 0; i < series.length; i += 1) {
    const r = series[i];
    if (r.v < seriesLow.v) seriesLow = r;
    if (r.v > recordHigh.v) recordHigh = r;
    if (r.d >= FIRST_FILL_CUTOFF && (postFillLow === null || r.v < postFillLow.v)) postFillLow = r;
    if (r.v < latest.v) {
      daysBelowLatest += 1;
      if (firstBelowDate === null) firstBelowDate = r.d;
      lastBelowDate = r.d;
    }
  }

  // Same calendar date across every year the file covers.
  const md = latest.d.slice(5);
  const sameDate = [];
  for (let i = 0; i < series.length; i += 1) if (series[i].d.slice(5) === md) sameDate.push(series[i]);
  const sorted = sameDate.map((r) => r.v).slice().sort((a, b) => a - b);
  const medianForDate = sorted.length
    ? (sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;
  let rankForDate = 1;
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i] < latest.v) rankForDate += 1;

  // The single lowest reading recorded on this calendar date, whichever year it fell in.
  let lowestSameDate = sameDate.length ? sameDate[0] : null;
  for (let i = 0; i < sameDate.length; i += 1) if (sameDate[i].v < lowestSameDate.v) lowestSameDate = sameDate[i];

  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

  // Seasonal shape, counted rather than averaged. For every COMPLETE calendar year on or after
  // the first-fill cutoff, find the month carrying that year's highest reading and the month
  // carrying its lowest, then count how often each month wins. A count over whole years is
  // evidenced by the rows that carry each extreme; a monthly mean or median is not, which is why
  // this is phrased as "July takes the annual high most often" and never as an average level.
  const byYear = new Map();
  for (let i = 0; i < series.length; i += 1) {
    const r = series[i];
    if (r.d < FIRST_FILL_CUTOFF) continue;
    const y = r.d.slice(0, 4);
    let e = byYear.get(y);
    if (!e) { e = { hi: r, lo: r, n: 0 }; byYear.set(y, e); }
    if (r.v > e.hi.v) e.hi = r;
    if (r.v < e.lo.v) e.lo = r;
    e.n += 1;
  }
  const hiMonths = new Array(12).fill(0);
  const loMonths = new Array(12).fill(0);
  let completeYears = 0;
  for (const [, e] of byYear) {
    if (e.n < 300) continue;                 // skip partial years at either end of the file
    completeYears += 1;
    hiMonths[Number(e.hi.d.slice(5, 7)) - 1] += 1;
    loMonths[Number(e.lo.d.slice(5, 7)) - 1] += 1;
  }
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const topOf = (arr) => {
    let bi = 0;
    for (let i = 1; i < arr.length; i += 1) if (arr[i] > arr[bi]) bi = i;
    return { month: MONTHS[bi], count: arr[bi] };
  };
  const secondLoOf = () => {
    const idx = loMonths.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]);
    return idx.length > 1 ? { month: MONTHS[idx[1][1]], count: idx[1][0] } : null;
  };
  const peakMonth = topOf(hiMonths);
  const troughMonth = topOf(loMonths);
  const runnerUpTrough = secondLoOf();

  // How CONCENTRATED the annual cycle is, not merely which month wins. Powell is snowmelt-driven
  // and its high lands in one month nearly half the time. Mead sits below Hoover Dam and is
  // governed by release schedules, so its annual high is scattered across February, December and
  // July with no month taking more than about a quarter of the years. Reporting only the winning
  // month would imply a rhythm Mead does not have, so the share is carried alongside it and the
  // page is required to state which case it is looking at.
  const share = (c) => (completeYears > 0 ? Math.round((c / completeYears) * 1000) / 10 : null);
  const top3 = (arr) => arr
    .map((c, i) => ({ month: MONTHS[i], count: c }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return {
    completeYears,
    peakMonth: peakMonth.month, peakMonthCount: peakMonth.count,
    troughMonth: troughMonth.month, troughMonthCount: troughMonth.count,
    runnerUpTroughMonth: runnerUpTrough ? runnerUpTrough.month : null,
    runnerUpTroughCount: runnerUpTrough ? runnerUpTrough.count : null,
    peakMonthShare: share(peakMonth.count),
    troughMonthShare: share(troughMonth.count),
    peakTop3: top3(hiMonths),
    troughTop3: top3(loMonths),
    // A pronounced cycle is one where a single month carries the annual extreme in at least
    // 40 percent of complete years. Below that the page says the rhythm is weak and shows the
    // spread instead of naming a season.
    seasonalIsPronounced: share(peakMonth.count) !== null && share(peakMonth.count) >= 40,
    latestDate: latest.d,
    latestFt: r2(latest.v),
    totalDays: series.length,
    recordStart: series[0].d,
    recordEnd: latest.d,
    recordHighFt: r2(recordHigh.v),
    recordHighDate: recordHigh.d,
    seriesLowFt: r2(seriesLow.v),
    seriesLowDate: seriesLow.d,
    postFillLowFt: r2(postFillLow ? postFillLow.v : null),
    postFillLowDate: postFillLow ? postFillLow.d : null,
    firstFillCutoff: FIRST_FILL_CUTOFF,
    // True when the most recent reading IS the lowest since the reservoir first filled.
    latestIsPostFillLow: !!(postFillLow && postFillLow.d === latest.d),
    daysBelowLatest,
    firstBelowDate,
    lastBelowDate,
    // True when every reading below the latest one predates the first-fill cutoff, i.e.
    // the only lower water on record was the reservoir filling for the first time.
    allLowerDaysArePreFill: daysBelowLatest > 0 && lastBelowDate !== null && lastBelowDate < FIRST_FILL_CUTOFF,
    medianForDateFt: r2(medianForDate),
    rankForDate,
    yearsForDate: sameDate.length,
    lowestSameDateFt: r2(lowestSameDate ? lowestSameDate.v : null),
    lowestSameDateDate: lowestSameDate ? lowestSameDate.d : null,
    vsMedianForDateFt: r2(medianForDate == null ? null : latest.v - medianForDate),
  };
}

async function oneLake(lake) {
  const SOURCE = srcOf(lake.site);
  const OUT = path.join(ROOT, 'src', 'data', lake.out);
  let txt;
  try {
    txt = await httpGet(SOURCE);
  } catch (e) {
    console.error(`${lake.name} history: fetch failed (${e && e.message ? e.message : e}); keeping the previous file.`);
    return;
  }

  const series = parseSeries(txt);
  if (series.length < MIN_ROWS) {
    console.error(`${lake.name} history: only ${series.length} usable rows (< ${MIN_ROWS}); keeping the previous file.`);
    return;
  }

  const stats = computeStats(series, lake.firstFillCutoff);

  // The chart plots one point per month (the month's last reading) so the payload stays
  // small enough to ship inline, while still showing every year of the record.
  const monthly = [];
  let currentKey = null;
  for (let i = 0; i < series.length; i += 1) {
    const key = series[i].d.slice(0, 7);
    if (key !== currentKey) {
      if (currentKey !== null) monthly.push(series[i - 1]);
      currentKey = key;
    }
  }
  monthly.push(series[series.length - 1]);

  // The COMPLETE daily series, delta-encoded, so the page can answer "what was it on this date"
  // and "how often has it been this low" in the reader's browser from the same numbers the chart
  // draws, rather than from an estimate or a round trip. Encoding: a start date, then one
  // base-36 signed delta per day in hundredths of a foot, comma separated. Days the file skips
  // are encoded as an explicit gap so a date lookup never silently returns a neighbour's value.
  const daily = [];
  let prevHundredths = null;
  let prevDayNum = null;
  const dayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
  for (let i = 0; i < series.length; i += 1) {
    const hv = Math.round(series[i].v * 100);
    const dn = dayNum(series[i].d);
    if (prevHundredths === null) { daily.push(String(hv)); }
    else {
      const gap = dn - prevDayNum;
      const delta = hv - prevHundredths;
      daily.push((gap > 1 ? 'g' + gap.toString(36) + ':' : '') + delta.toString(36));
    }
    prevHundredths = hv; prevDayNum = dn;
  }

  const payload = {
    lake: lake.name,
    slug: lake.slug,
    source: SOURCE,
    catalog: lake.catalog,
    as_of: new Date().toISOString(),
    stats,
    monthly: monthly.map((r) => [r.d, Math.round(r.v * 100) / 100]),
    dailyStart: series[0].d,
    daily: daily.join(','),
  };

  let previous = null;
  if (existsSync(OUT)) {
    try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { previous = null; }
  }
  const changed = !previous || JSON.stringify(previous.stats) !== JSON.stringify(stats);

  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `${lake.name} history: ${series.length} daily rows ${stats.recordStart}..${stats.recordEnd}, `
    + `latest ${stats.latestFt} ft, post-fill low ${stats.postFillLowFt} ft on ${stats.postFillLowDate}`
    + `${stats.latestIsPostFillLow ? ' (latest IS the post-fill low)' : ''}, `
    + `${monthly.length} monthly points -> src/data/${lake.out}${changed ? ' (changed)' : ' (unchanged)'}`,
  );
}

async function main() {
  for (let i = 0; i < LAKES.length; i += 1) {
    // Sequential on purpose: two fetches of a ~500 KB federal file should not race, and a
    // failure on one lake must not stop the others.
    // eslint-disable-next-line no-await-in-loop
    await oneLake(LAKES[i]);
  }
}

main().catch((e) => {
  console.error(`Lake history: unexpected error (${e && e.message ? e.message : e}); keeping the previous file.`);
  process.exit(0);
});
