// State-level day-of-year comparison for lakelevelnow.com.
//
// A state page that ranks reservoirs by percent full is answering the wrong question.
// Percent full compares a lake to its own concrete rim; it says nothing about whether
// today is unusual. San Luis sits at 57% full and is still higher than 78% of August 13ths
// in its record, because a pumped-storage reservoir is drawn down every summer by design.
// Pine Flat sits at 22% full and is at its 37th percentile for the date — low, but not the
// outlier the percent-full column implies. The two orderings genuinely disagree, and that
// disagreement is the only thing on this site the state reservoir tables do not already print.
//
// This module computes that comparison once, at build time, from the same quantile ladder
// (`src/data/almanac-doy.json`) and the same live readings (`src/data/levels.json`) the lake
// pages use, so a state page can never quote a number that contradicts the lake page it
// links to. Every figure here is derived. Nothing is typed by hand, and a field that is
// absent upstream stays null rather than becoming a guess.
//
// Cost note: the ladder is ~830 KB and is imported through almanac.ts in Astro frontmatter.
// It is read at build time and never reaches a browser.

import {
  almanacContext, parseAsOf,
  type AlmanacContext, type LakeSummary,
} from './almanac';
import { LAKES, feedLabel, type LakeEntry, type Reading } from './lakes';
import levels from '../data/levels.json';

const LEVELS = levels as Record<string, Reading>;

/** Upper bound on the registry sweep. The registry is ~44 lakes; this guards the loop. */
const MAX_LAKES = 500;

export type Band = 'much-lower' | 'lower' | 'normal' | 'higher' | 'much-higher';

export type BandLabel =
  | 'much lower than usual' | 'lower than usual' | 'about normal'
  | 'higher than usual' | 'much higher than usual';

/**
 * The percentile cut points, exported so no page can re-type them and drift.
 * `max` is the inclusive upper bound of the band except for 'normal' and 'higher',
 * which are open at the top (< 70 and < 90) so 70 reads as higher and 90 as much higher.
 * Ordered low to high; `bandFor` walks it in order and the last entry is the catch-all.
 */
export const BANDS: { band: Band; label: BandLabel; upTo: number; inclusive: boolean }[] = [
  { band: 'much-lower',  label: 'much lower than usual',  upTo: 10,  inclusive: true },
  { band: 'lower',       label: 'lower than usual',       upTo: 30,  inclusive: true },
  { band: 'normal',      label: 'about normal',           upTo: 70,  inclusive: false },
  { band: 'higher',      label: 'higher than usual',      upTo: 90,  inclusive: false },
  { band: 'much-higher', label: 'much higher than usual', upTo: Infinity, inclusive: true },
];

export interface StateRow {
  slug: string;
  name: string;
  /** Canonical on-site path, so a page never assembles the URL itself. */
  url: string;
  operator: string;
  river: string;
  /** The elevation the percentile describes: the live gage where one was usable. */
  levelFt: number;
  /** Zero-padded ISO calendar date of that reading (CDEC stamps are not padded upstream). */
  asOf: string;
  asOfLabel: string;
  /** False when almanacContext fell back to the stored snapshot. */
  live: boolean;
  feed: 'CDEC' | 'USGS' | 'USBR' | null;
  /** Null for elevation-only gages with no published storage. Never inferred. */
  pctFull: number | null;
  fullPoolFt: number | null;
  percentile: number;
  medianForDateFt: number;
  vsMedianFt: number;
  recordYears: number;
  observations: number;
  recordStart: string;
  recordEnd: string;
  recordLowFt: number;
  recordLowDate: string;
  recordHighFt: number;
  recordHighDate: string;
  // NOTE: `peakMonth` and `troughMonth` from almanac.json are deliberately NOT carried
  // here. They are the MODE of the calendar month in which each year's maximum and minimum
  // fell, and on a multi-decade trending series that collapses onto January and December as
  // an artifact of the trend rather than a seasonal rhythm. The archive carries no share or
  // count to qualify the mode, so the figure cannot be published honestly. Recompute a
  // typical peak and trough from the P50 day-of-year curve instead if a page ever needs one.
  medianSwingFt: number | null;
  band: Band;
  bandLabel: BandLabel;
}

export interface StateSummary {
  stateCode: string;
  /** Rows actually returned: registry lakes in the state that carry an almanac record. */
  lakes: number;
  /** All registry lakes in the state, almanac or not. The gap is the honest coverage note. */
  registryLakes: number;
  observations: number;
  longestRecordYears: number;
  earliestRecordStart: string;
  belowMedian: number;
  aboveMedian: number;
  /** Latest asOf across the rows — the date the table as a whole describes. */
  snapshotDate: string;
  snapshotLabel: string;
  allLive: boolean;
  feeds: string[];
  spearman: number | null;
  biggestDisagreement: Disagreement | null;
}

export interface Disagreement {
  slug: string;
  name: string;
  /** 1 = fullest by percent full. */
  rankByPercentFull: number;
  /** 1 = highest for the calendar date. */
  rankByPercentile: number;
  pctFull: number;
  percentile: number;
}

/** Which band a percentile falls in. Total: BANDS ends with an Infinity catch-all. */
export function bandFor(percentile: number): { band: Band; label: BandLabel } {
  for (let i = 0; i < BANDS.length; i++) {
    const b = BANDS[i];
    const hit = b.inclusive ? percentile <= b.upTo : percentile < b.upTo;
    if (hit) return { band: b.band, label: b.label };
  }
  const last = BANDS[BANDS.length - 1];
  return { band: last.band, label: last.label };
}

/** Zero-pad an upstream stamp to a real ISO date. Returns '' when it cannot be parsed. */
function isoDate(raw: string | null | undefined): string {
  const d = parseAsOf(raw);
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

/** "August 13, 2026" for an already-parsed ISO date. Returns '' on an unparseable stamp. */
function humanDate(iso: string): string {
  const d = parseAsOf(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Assemble one row from the three sources that already agree with each other:
 * the registry entry, the live reading, and the almanac context built from both.
 * Returns null only when the lake has no almanac record, which is most of the registry.
 */
function rowFor(entry: LakeEntry, reading: Reading | undefined): StateRow | null {
  const ctx: AlmanacContext | null =
    almanacContext(entry.slug, reading?.level_ft ?? null, reading?.as_of ?? null);
  if (!ctx) return null;

  const lake: LakeSummary = ctx.lake;
  // The context tells us which reading it actually used; take the date from that source
  // rather than from whichever stamp happens to be newer, so asOf always matches levelFt.
  const asOf = isoDate(ctx.live ? reading?.as_of : lake.todayDate);
  const { band, label } = bandFor(ctx.pct);

  return {
    slug: entry.slug,
    name: lake.name,
    url: `/lake/${entry.slug}/`,
    operator: entry.operator,
    river: entry.river,
    levelFt: ctx.ft,
    asOf,
    asOfLabel: ctx.asOfLabel ?? humanDate(asOf),
    live: ctx.live,
    feed: feedLabel(reading?.feed) ?? feedLabel(lake.feed),
    pctFull: reading?.pct_full ?? null,
    fullPoolFt: entry.full_pool_ft ?? lake.fullPoolFt ?? null,
    percentile: ctx.pct,
    medianForDateFt: ctx.median,
    vsMedianFt: ctx.vsMedian,
    recordYears: lake.years,
    observations: lake.obs,
    recordStart: lake.recordStart,
    recordEnd: lake.recordEnd,
    recordLowFt: lake.recordLowFt,
    recordLowDate: lake.recordLowDate,
    recordHighFt: lake.recordHighFt,
    recordHighDate: lake.recordHighDate,
    medianSwingFt: lake.medianSwingFt,
    band,
    bandLabel: label,
  };
}

/**
 * Every lake in one state that has a long enough record to be compared to itself,
 * sorted ascending by percentile so the reservoir furthest below its own normal leads.
 * Lakes without an almanac record are skipped, never padded with a placeholder row.
 */
export function stateRows(stateCode: string): StateRow[] {
  if (!stateCode) return [];
  const rows: StateRow[] = [];
  const n = Math.min(LAKES.length, MAX_LAKES);
  for (let i = 0; i < n; i++) {
    const entry = LAKES[i];
    if (entry.state !== stateCode) continue;
    const row = rowFor(entry, LEVELS[entry.slug]);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => a.percentile - b.percentile);
  return rows;
}

/**
 * Descending competition ranks with average ranks for ties (1 = largest value).
 * Average ranks are what makes the tie-corrected d^2 shortcut below behave.
 */
function descendingRanks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const ranks = new Array<number>(values.length).fill(0);
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

/**
 * Spearman rank correlation between "fullest first" and "highest for the date first".
 *
 * Computed only over rows with a non-null pctFull — an elevation-only gage has no percent
 * full to rank, and dropping it is honest where inventing one would not be. Returns null
 * below 3 such rows, where a correlation is not a statement about anything.
 *
 * Uses the textbook shortcut rho = 1 - 6*sum(d^2)/(n*(n^2-1)). That form is exact only
 * when there are NO ties in either ranking. Ties are given average ranks above, which keeps
 * the value continuous and close, but a tie-heavy input will differ slightly from the
 * Pearson-on-ranks definition. pctFull is published as a whole percent, so ties are
 * possible; the value is therefore reported to three decimals and read as an indication of
 * how far the two orderings diverge, not as a p-value.
 */
export function spearman(rows: StateRow[]): number | null {
  const usable = rows.filter((r) => r.pctFull != null);
  const n = usable.length;
  if (n < 3) return null;

  const byFull = descendingRanks(usable.map((r) => r.pctFull as number));
  const byPct = descendingRanks(usable.map((r) => r.percentile));

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = byFull[i] - byPct[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

/**
 * The lake whose two ranks disagree most — the single row that proves the table earns
 * its place. Null when fewer than 3 rows carry a pctFull, matching spearman()'s floor.
 */
function biggestDisagreement(rows: StateRow[]): Disagreement | null {
  const usable = rows.filter((r) => r.pctFull != null);
  if (usable.length < 3) return null;

  const byFull = descendingRanks(usable.map((r) => r.pctFull as number));
  const byPct = descendingRanks(usable.map((r) => r.percentile));

  let best = -1;
  let at = -1;
  for (let i = 0; i < usable.length; i++) {
    const gap = Math.abs(byFull[i] - byPct[i]);
    if (gap > best) { best = gap; at = i; }
  }
  if (at < 0) return null;

  const row = usable[at];
  return {
    slug: row.slug,
    name: row.name,
    rankByPercentFull: byFull[at],
    rankByPercentile: byPct[at],
    pctFull: row.pctFull as number,
    percentile: row.percentile,
  };
}

/** Latest asOf across the rows. '' when no row carries a parseable stamp. */
function latestAsOf(rows: StateRow[]): string {
  let latest = '';
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].asOf;
    if (d && d > latest) latest = d;
  }
  return latest;
}

/** How many registry lakes the state has at all, almanac record or not. */
function registryCount(stateCode: string): number {
  let n = 0;
  const cap = Math.min(LAKES.length, MAX_LAKES);
  for (let i = 0; i < cap; i++) if (LAKES[i].state === stateCode) n++;
  return n;
}

/**
 * Roll the rows up into the figures a page headline needs. Every count is derived from
 * the rows passed in, so a summary can never describe a table the reader is not looking at.
 */
export function stateSummary(rows: StateRow[], stateCode: string): StateSummary {
  const snapshotDate = latestAsOf(rows);
  // Feed labels are a closed set; widen to string only after the nulls are gone, so the
  // summary never prints an empty chip for a lake whose feed the registry does not name.
  const feeds: string[] = [...new Set(
    rows.map((r) => r.feed).filter((f): f is 'CDEC' | 'USGS' | 'USBR' => f != null),
  )].sort();

  let observations = 0;
  let longestRecordYears = 0;
  let earliestRecordStart = '';
  let belowMedian = 0;
  let aboveMedian = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    observations += r.observations;
    if (r.recordYears > longestRecordYears) longestRecordYears = r.recordYears;
    if (r.recordStart && (!earliestRecordStart || r.recordStart < earliestRecordStart)) {
      earliestRecordStart = r.recordStart;
    }
    if (r.vsMedianFt < 0) belowMedian++;
    else if (r.vsMedianFt > 0) aboveMedian++;
  }

  return {
    stateCode,
    lakes: rows.length,
    registryLakes: registryCount(stateCode),
    observations,
    longestRecordYears,
    earliestRecordStart,
    belowMedian,
    aboveMedian,
    snapshotDate,
    snapshotLabel: humanDate(snapshotDate),
    allLive: rows.length > 0 && rows.every((r) => r.live),
    feeds,
    spearman: spearman(rows),
    biggestDisagreement: biggestDisagreement(rows),
  };
}
