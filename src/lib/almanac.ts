// Shared day-of-year context for lakelevelnow.com.
//
// One place computes "is today normal for this date", so the title, the meta description
// and the on-page block can never disagree with each other or with the gauge. They all
// read the same live gage value and the same published quantile ladder.
//
// The ladder (`src/data/almanac-doy.json`, ~830 KB) is imported in Astro frontmatter and
// never reaches a browser. It exists so the percentile can be recomputed on every daily
// build without refetching sixty years of record from a federal API.

import data from '../data/almanac.json';
import doy from '../data/almanac-doy.json';

export interface LakeSummary {
  slug: string; name: string; state: string | null;
  years: number; obs: number; recordStart: string; recordEnd: string;
  todayFt: number; todayDate: string; medianForDate: number; vsMedianFt: number;
  percentile: number; percentileOrdinal: string; read: string; sentence: string;
  feed: string; site: string; fullPoolFt: number | null;
  peakMonth: string | null; troughMonth: string | null;
  medianSwingFt: number | null;
  recordLowFt: number; recordLowDate: string;
  recordHighFt: number; recordHighDate: string;
  zipBytes: number | null;
}

export interface AlmanacContext {
  lake: LakeSummary;
  /** The elevation the sentence describes. The live gage where there is one. */
  ft: number;
  /** 0-100, interpolated onto the published ladder for this calendar date. */
  pct: number;
  median: number;
  vsMedian: number;
  monthName: string;
  /** Day of the month the reading belongs to, unpadded. */
  dayOfMonth: number;
  /** False when we fell back to the stored snapshot because no live reading was usable. */
  live: boolean;
  /** Set only on the fallback path, so the page can say which date it is describing. */
  asOfLabel: string | null;
}

export const PRICE_SINGLE = data.priceSingleUsd;
export const PRICE_BUNDLE = data.priceBundleUsd;
export const LAKE_COUNT = data.lakeCount;
export const DEEPEST_YEARS = data.deepestRecordYears;
export const TOTAL_READINGS = data.totalReadings;
export const ALMANAC_LAKES = data.lakes as LakeSummary[];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

/**
 * Parse an `as_of` stamp, tolerating both shapes the fetch pipeline produces.
 * USGS lakes carry a full ISO instant ("2026-08-07T20:15:00.000-05:00"); CDEC lakes carry
 * a bare, NOT zero-padded date ("2026-8-6"). `new Date("2026-8-6T00:00:00Z")` is Invalid
 * Date, which silently emptied this whole feature the first time it was wired. Pull the
 * calendar parts out with a regex rather than trusting the string to the Date constructor.
 */
export function parseAsOf(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const here = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((here - start) / 86400000) + 1;
}

/**
 * Where `v` sits on a published quantile ladder, 0-100, linear between anchors.
 * The ladder is denser at the tails (0,1,2,5 … 95,98,99,100) because that is where the
 * claims worth making live, and where a coarse grid would flatten a record low into an
 * unremarkable "below normal".
 */
export function percentileOn(ladder: number[], anchors: number[], v: number): number {
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

/**
 * Build the context for one lake, preferring the live reading.
 * Returns null when the lake has no long record, which is most of the 44 pages.
 */
export function almanacContext(
  slug: string,
  level?: number | null,
  asOf?: string | null,
): AlmanacContext | null {
  const lake = ALMANAC_LAKES.find((l) => l.slug === slug);
  if (!lake) return null;

  // A reading is usable only if it is a finite number inside this lake's operating range.
  // A unit slip or a sentinel that survived upstream cleaning must never become a
  // percentile; falling back to the snapshot is the safe failure.
  const usable = typeof level === 'number' && Number.isFinite(level)
    && level > 0 && Math.abs(level - lake.medianForDate) < 1000;
  const when = usable ? parseAsOf(asOf) : null;
  const ladders = (doy.grid as Record<string, (number[] | null)[]>)[slug];

  if (usable && when && ladders) {
    const ladder = ladders[dayOfYear(when) - 1];
    if (ladder) {
      const median = ladder[doy.anchors.indexOf(50)];
      return {
        lake, ft: level as number,
        pct: percentileOn(ladder, doy.anchors, level as number),
        median, vsMedian: (level as number) - median,
        monthName: MONTHS[when.getUTCMonth()], dayOfMonth: when.getUTCDate(),
        live: true, asOfLabel: null,
      };
    }
  }

  const d = parseAsOf(lake.todayDate) ?? new Date(Date.UTC(2026, 0, 1));
  return {
    lake, ft: lake.todayFt, pct: lake.percentile, median: lake.medianForDate,
    vsMedian: lake.vsMedianFt, monthName: MONTHS[d.getUTCMonth()], dayOfMonth: d.getUTCDate(),
    live: false,
    asOfLabel: d.toLocaleDateString('en-US',
      { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
  };
}

const fmt = (n: number, d = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** The free sentence. Four shapes, so the wording is true at every percentile. */
export function leadSentence(c: AlmanacContext): string {
  const pct = Math.round(c.pct);
  const head = `At ${fmt(c.ft)} ft, ${c.lake.name} is`;
  const tail = `${c.lake.years} years of daily record`;
  if (pct <= 1) return `${head} lower than it has been on this date in ${tail}.`;
  if (pct >= 99) return `${head} higher than it has been on this date in ${tail}.`;
  if (pct >= 50) return `${head} higher than ${pct}% of ${c.monthName}s in ${tail}.`;
  return `${head} lower than ${100 - pct}% of ${c.monthName}s in ${tail}.`;
}

/**
 * A clause for the <title>, or '' where the percentile is not striking enough to be worth
 * the characters. Google truncates, so "62nd percentile" would cost more than it earns;
 * only the tails read as a headline.
 */
export function titleClause(c: AlmanacContext): string {
  const pct = Math.round(c.pct);
  if (pct <= 1) return `, lowest for the date in ${c.lake.years} years`;
  if (pct >= 99) return `, highest for the date in ${c.lake.years} years`;
  if (pct < 10) return `, well below normal for ${c.monthName}`;
  if (pct > 90) return `, well above normal for ${c.monthName}`;
  return '';
}

/** A sentence for the meta description. Always worth including. */
export function descriptionClause(c: AlmanacContext): string {
  const pct = Math.round(c.pct);
  if (pct <= 1) {
    return ` That is lower than any ${c.monthName} ${c.dayOfMonth} in ${c.lake.years} years of record.`;
  }
  if (pct >= 99) {
    return ` That is higher than any ${c.monthName} ${c.dayOfMonth} in ${c.lake.years} years of record.`;
  }
  const side = pct >= 50 ? 'higher' : 'lower';
  const share = pct >= 50 ? pct : 100 - pct;
  return ` That is ${side} than ${share}% of ${c.monthName}s in ${c.lake.years} years of record.`;
}
