// Every reservoir in CDEC's Daily Reservoir Storage Summary, against its own record.
//
// CDEC's table prints percent of capacity. Percent of capacity compares a reservoir to its
// concrete rim, which is a fact about the dam, not about the water year. Pyramid sits at
// 89% of capacity and is still at the bottom of its own record for the date, because it is
// a pumped-storage forebay held near the top of its range all year: 89% is its floor, not
// its ceiling. San Luis reads far lower and is nowhere near unusual, because a pumped
// reservoir is drawn down every summer by design. The two orderings genuinely disagree, and
// that disagreement is the one column the state's own report does not carry.
//
// Two files meet here, and the split is deliberate:
//   • src/data/ca-ladders.json  — 615,712 daily observations reduced to a 17-anchor quantile
//     ladder per station per day-of-year, plus each station's static history metadata.
//     Committed. A forty-year record does not change between builds, and re-harvesting it
//     on every build would be minutes of federal API traffic for an identical answer.
//   • src/data/ca-reservoirs.json — today's readings only, rewritten by
//     scripts/fetch-ca-reservoirs.mjs on every `npm run fetch`.
//
// Both are read in Astro frontmatter at build time and neither reaches a browser.
//
// Nothing here is guessed. A station with no ladder for the reading's calendar day, or no
// reported storage, gets `percentile: null` and the page says so. CDEC's '---' arrives as
// null from the fetcher and stays null all the way to the table.

import { parseAsOf, percentileOn } from './almanac';
import { bandFor, type Band, type BandLabel } from './castate';
import { LAKES } from './lakes';
import ladderData from '../data/ca-ladders.json';
import currentData from '../data/ca-reservoirs.json';

// The band thresholds live in castate.ts and are re-exported, never re-typed, so the
// California page and the state pages can never label the same percentile differently.
export { BANDS, bandFor } from './castate';
export type { Band, BandLabel } from './castate';

interface StationMeta {
  name: string;
  county: string;
  operator: string;
  river_basin: string;
  capacity_af: number;
  record_years: number;
  observations: number;
  record_start: string;
  record_end: string;
  record_low_af: number;
  record_low_date: string;
  record_high_af: number;
  record_high_date: string;
  hasLadder: boolean;
}

interface CurrentReading {
  id: string;
  name: string;
  capacity_af: number | null;
  elevation_ft: number | null;
  storage_af: number | null;
  storage_change_af: number | null;
  pct_capacity: number | null;
  cdec_avg_storage_af: number | null;
  cdec_pct_average: number | null;
  as_of: string;
  carried: boolean;
}

const LADDERS = ladderData.ladders as Record<string, (number[] | null)[]>;
const STATIONS = ladderData.stations as unknown as Record<string, StationMeta>;
const ANCHORS = ladderData.meta.anchors as number[];
const CURRENT = currentData.stations as unknown as Record<string, CurrentReading>;

/** Where the 50th percentile sits on every ladder. Resolved once; -1 would be a silent bug. */
const MEDIAN_ANCHOR = ANCHORS.indexOf(50);

/** Upper bound on the roster sweep. The roster is 48 stations; this guards the loop. */
const MAX_STATIONS = 200;

export interface ReservoirRow {
  id: string;
  name: string;
  county: string;
  operator: string;
  riverBasin: string;
  capacityAf: number;
  /** Null when CDEC printed '---'. Never 0, and never inferred from percent of capacity. */
  storageAf: number | null;
  elevationFt: number | null;
  pctCapacity: number | null;
  /** CDEC's own average-for-the-date storage, transcribed. Not our median. */
  cdecAvgStorageAf: number | null;
  cdecPctAverage: number | null;
  storageChangeAf: number | null;
  /** 0-100 on this station's own day-of-year ladder. Null wherever it cannot be earned. */
  percentile: number | null;
  medianForDateAf: number | null;
  vsMedianAf: number | null;
  recordYears: number;
  observations: number;
  recordStart: string;
  recordEnd: string;
  recordLowAf: number;
  recordLowDate: string;
  recordHighAf: number;
  recordHighDate: string;
  hasLadder: boolean;
  /** Null exactly when percentile is null — there is no band without a percentile. */
  band: Band | null;
  bandLabel: BandLabel | null;
  /** The on-site page for this reservoir, or null. Matched by CDEC id, never by name. */
  lakePath: string | null;
}

export interface ReservoirSummary {
  stations: number;
  withStorage: number;
  withPercentile: number;
  totalStorageAf: number;
  totalCapacityAf: number;
  /** Statewide storage as a percent of the capacity actually reporting. Null if none is. */
  statewidePctCapacity: number | null;
  belowMedian: number;
  aboveMedian: number;
  asOf: string;
  asOfLabel: string;
  observations: number;
  longestRecordYears: number;
  earliestRecordStart: string;
  spearman: number | null;
  biggestDisagreement: ReservoirDisagreement | null;
}

export interface ReservoirDisagreement {
  id: string;
  name: string;
  /** 1 = fullest against its own rim. */
  rankByPctCapacity: number;
  /** 1 = highest against its own record for the date. */
  rankByPercentile: number;
  pctCapacity: number;
  percentile: number;
}

/**
 * The canonical day-of-year index, 1..366, that the ladders were bucketed on.
 *
 * This is NOT the calendar day-of-year. The harvest assigned every observation a bucket
 * from its month and day using LEAP-year cumulative offsets, so Feb 29 owns bucket 60 and
 * Mar 1 is 61 in every year, leap or not. Using a plain day-of-year here would read the
 * wrong ladder for 306 days out of every common year — off by one, silently, all summer.
 */
const MONTH_OFFSET = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
function canonicalDayOfYear(d: Date): number {
  return MONTH_OFFSET[d.getUTCMonth()] + d.getUTCDate();
}

/** The registry's CDEC id → on-site path. Built once; a name is never parsed into a slug. */
const LAKE_PATH_BY_CDEC_ID: Record<string, string> = {};
for (let i = 0; i < LAKES.length; i++) {
  const id = LAKES[i].cdec_id;
  if (id) LAKE_PATH_BY_CDEC_ID[id] = `/lake/${LAKES[i].slug}/`;
}

/** "August 28, 2026" for an ISO date. '' when the stamp cannot be parsed. */
function humanDate(iso: string): string {
  const d = parseAsOf(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * One row: the static history joined to today's reading.
 *
 * The percentile is located on the ladder for the READING's own calendar day, not the build
 * date. CDEC's summary describes midnight of the previous day and can lag further; reading a
 * mid-August number against a late-August ladder would quietly shift every value in the
 * table during the steepest part of the drawdown curve.
 */
function rowFor(id: string, meta: StationMeta, cur: CurrentReading | undefined): ReservoirRow {
  const storageAf = cur?.storage_af ?? null;

  let percentile: number | null = null;
  let medianForDateAf: number | null = null;
  const when = cur ? parseAsOf(cur.as_of) : null;
  if (meta.hasLadder && storageAf != null && when) {
    const ladder = LADDERS[id]?.[canonicalDayOfYear(when) - 1] ?? null;
    // A day-of-year bucket with too few observations was published as null and no ladder
    // was fabricated for it. That stays null here rather than borrowing a neighbouring day.
    if (ladder && ladder.length === ANCHORS.length && MEDIAN_ANCHOR >= 0) {
      percentile = percentileOn(ladder, ANCHORS, storageAf);
      medianForDateAf = ladder[MEDIAN_ANCHOR];
    }
  }
  const band = percentile == null ? null : bandFor(percentile);

  return {
    id,
    name: cur?.name ?? meta.name,
    county: meta.county,
    operator: meta.operator,
    riverBasin: meta.river_basin,
    capacityAf: meta.capacity_af,
    storageAf,
    elevationFt: cur?.elevation_ft ?? null,
    pctCapacity: cur?.pct_capacity ?? null,
    cdecAvgStorageAf: cur?.cdec_avg_storage_af ?? null,
    cdecPctAverage: cur?.cdec_pct_average ?? null,
    storageChangeAf: cur?.storage_change_af ?? null,
    percentile,
    medianForDateAf,
    vsMedianAf: storageAf != null && medianForDateAf != null ? storageAf - medianForDateAf : null,
    recordYears: meta.record_years,
    observations: meta.observations,
    recordStart: meta.record_start,
    recordEnd: meta.record_end,
    recordLowAf: meta.record_low_af,
    recordLowDate: meta.record_low_date,
    recordHighAf: meta.record_high_af,
    recordHighDate: meta.record_high_date,
    hasLadder: meta.hasLadder,
    band: band ? band.band : null,
    bandLabel: band ? band.label : null,
    lakePath: LAKE_PATH_BY_CDEC_ID[id] ?? null,
  };
}

/**
 * All 48 reservoirs, fullest first, the ones CDEC could not report last.
 *
 * The sweep is driven by the committed roster, not by today's download, so a station that
 * drops out of one report still renders — with nulls the page can label — instead of the
 * table silently changing length between builds.
 */
export function reservoirRows(): ReservoirRow[] {
  const ids = Object.keys(STATIONS);
  const rows: ReservoirRow[] = [];
  const n = Math.min(ids.length, MAX_STATIONS);
  for (let i = 0; i < n; i++) {
    rows.push(rowFor(ids[i], STATIONS[ids[i]], CURRENT[ids[i]]));
  }
  rows.sort((a, b) => {
    if (a.pctCapacity == null && b.pctCapacity == null) return a.name.localeCompare(b.name);
    if (a.pctCapacity == null) return 1;
    if (b.pctCapacity == null) return -1;
    return b.pctCapacity - a.pctCapacity;
  });
  return rows;
}

/**
 * Descending competition ranks, average ranks for ties (1 = largest value).
 * Average ranks are what keeps the tie-corrected d^2 shortcut below well behaved.
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

/** Rows that can be ranked both ways. Everything below is computed over exactly this set. */
function comparable(rows: ReservoirRow[]): ReservoirRow[] {
  return rows.filter((r) => r.pctCapacity != null && r.percentile != null);
}

/**
 * Spearman rank correlation between "fullest first" and "highest for the date first".
 *
 * Only rows carrying BOTH numbers are ranked; a reservoir CDEC did not report has no
 * percent of capacity to rank, and dropping it is honest where inventing one would not be.
 * Null below 3 such rows, where a correlation is not a statement about anything.
 *
 * Uses rho = 1 - 6*sum(d^2)/(n*(n^2-1)). That shortcut is exact only with no ties in either
 * ranking; ties take average ranks above, which keeps it continuous and close. CDEC prints
 * percent of capacity as a whole number, so ties are common — read the value as how far the
 * two orderings diverge, not as a p-value.
 */
export function spearman(rows: ReservoirRow[]): number | null {
  const usable = comparable(rows);
  const n = usable.length;
  if (n < 3) return null;

  const byFull = descendingRanks(usable.map((r) => r.pctCapacity as number));
  const byPct = descendingRanks(usable.map((r) => r.percentile as number));

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = byFull[i] - byPct[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

/**
 * The reservoir whose two ranks disagree most — the single row that proves the table earns
 * its place. Null below 3 comparable rows, matching spearman()'s floor.
 */
function biggestDisagreement(rows: ReservoirRow[]): ReservoirDisagreement | null {
  const usable = comparable(rows);
  if (usable.length < 3) return null;

  const byFull = descendingRanks(usable.map((r) => r.pctCapacity as number));
  const byPct = descendingRanks(usable.map((r) => r.percentile as number));

  let best = -1;
  let at = -1;
  for (let i = 0; i < usable.length; i++) {
    const gap = Math.abs(byFull[i] - byPct[i]);
    if (gap > best) { best = gap; at = i; }
  }
  if (at < 0) return null;

  const row = usable[at];
  return {
    id: row.id,
    name: row.name,
    rankByPctCapacity: byFull[at],
    rankByPercentile: byPct[at],
    pctCapacity: row.pctCapacity as number,
    percentile: row.percentile as number,
  };
}

/**
 * Roll the rows up into the figures a headline needs. Every count is derived from the rows
 * passed in, so a summary can never describe a table the reader is not looking at.
 *
 * statewidePctCapacity divides total reported storage by the capacity of the reservoirs that
 * actually reported. Dividing by all 48 capacities would understate the state by the eight
 * reservoirs CDEC printed as '---'.
 */
export function reservoirSummary(rows: ReservoirRow[]): ReservoirSummary {
  let withStorage = 0;
  let withPercentile = 0;
  let totalStorageAf = 0;
  let totalCapacityAf = 0;
  let belowMedian = 0;
  let aboveMedian = 0;
  let observations = 0;
  let longestRecordYears = 0;
  let earliestRecordStart = '';

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    observations += r.observations;
    if (r.recordYears > longestRecordYears) longestRecordYears = r.recordYears;
    if (r.recordStart && (!earliestRecordStart || r.recordStart < earliestRecordStart)) {
      earliestRecordStart = r.recordStart;
    }
    if (r.storageAf != null) {
      withStorage++;
      totalStorageAf += r.storageAf;
      totalCapacityAf += r.capacityAf;
    }
    if (r.percentile != null) withPercentile++;
    if (r.vsMedianAf != null) {
      if (r.vsMedianAf < 0) belowMedian++;
      else if (r.vsMedianAf > 0) aboveMedian++;
    }
  }

  const asOf = currentData.asOf as string;
  return {
    stations: rows.length,
    withStorage,
    withPercentile,
    totalStorageAf,
    totalCapacityAf,
    statewidePctCapacity: totalCapacityAf > 0 ? (totalStorageAf / totalCapacityAf) * 100 : null,
    belowMedian,
    aboveMedian,
    asOf,
    asOfLabel: humanDate(asOf),
    observations,
    longestRecordYears,
    earliestRecordStart,
    spearman: spearman(rows),
    biggestDisagreement: biggestDisagreement(rows),
  };
}
