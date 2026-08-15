// Fetch the National Park Service "Lake Level Effects to Launch Ramps and Services"
// table for Glen Canyon and write it to src/data/powell-ramps.json.
//
// WHY THIS EXISTS: the per-ramp minimum elevation is a stable constant, but the
// availability columns are operational and change as the lake drops. Carrying status as
// a hand-edited constant would eventually publish "Available" for a ramp NPS has closed,
// which is the exact class of stale claim rules.md forbids. So it refreshes on every
// build, next to the gage readings.
//
// FAILURE POSTURE, same as fetch-levels.mjs: any network or parse failure keeps the
// previous file untouched and exits 0. A build must never break because NPS changed
// their markup, and a stale table is re-labelled rather than silently served as current.
// No axios (supply-chain rule), native fetch only, bounded retries.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'data', 'powell-ramps.json');
const SOURCE = 'https://www.nps.gov/glca/learn/changing-lake-levels.htm';
const TIMEOUT_MS = 20000;
const RETRIES = 3;
const MAX_ROWS = 40;          // bounded loop; the real table is ~14 rows
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
  throw lastErr;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&rsquo;/g, "'").replace(/&ndash;/g, '-').replace(/&mdash;/g, '-');
const clean = (s) => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

// Normalize the availability wording NPS uses into a short label the page can render.
function availability(raw) {
  const v = String(raw || '').toLowerCase();
  if (!v) return null;
  if (v.includes('at your own risk')) return 'at your own risk';
  if (v.includes('available')) return 'available';
  if (v.includes('closed')) return 'closed';
  return clean(raw).toLowerCase();
}

function parseRamps(htmlText) {
  const rows = String(htmlText).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const ramps = [];
  for (let i = 0; i < rows.length && ramps.length < MAX_ROWS; i++) {
    const cells = rows[i].match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    if (cells.length < 5) continue;
    const vals = cells.map((c) => clean(c.replace(/^<t[dh][^>]*>/i, '').replace(/<\/t[dh]>$/i, '')));
    const elevCell = vals.find((v) => /^\s*3\d{3}\s*ft\s*$/i.test(v));
    if (!elevCell) continue;
    const minFt = Number(String(elevCell).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(minFt) || minFt < 3000 || minFt > 3800) continue;
    const idx = vals.indexOf(elevCell);
    const name = vals[0];
    if (!name) continue;
    ramps.push({
      name,
      minFt,
      houseboats: availability(vals[1]),
      smallMotorized: availability(vals[2]),
      nonMotorized: availability(vals[3]),
      note: vals[idx + 1] || '',
    });
  }
  return ramps;
}

async function main() {
  let ramps = [];
  try {
    const htmlText = await httpGet(SOURCE);
    ramps = parseRamps(htmlText);
  } catch (e) {
    console.error(`Powell ramps: fetch failed (${e && e.message ? e.message : e}); keeping the previous table.`);
    process.exit(0);
  }

  // A parse that finds almost nothing means NPS changed their markup. Keeping the old
  // file is strictly better than publishing an empty ramp table.
  if (ramps.length < 5) {
    console.error(`Powell ramps: parsed only ${ramps.length} rows, refusing to overwrite. NPS markup likely changed.`);
    process.exit(0);
  }

  let previous = null;
  if (existsSync(OUT)) {
    try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { previous = null; }
  }
  const changed = !previous || JSON.stringify(previous.ramps) !== JSON.stringify(ramps);

  const payload = {
    source: SOURCE,
    as_of: new Date().toISOString(),
    // Only advance the content stamp when the table actually changed, so an unchanged
    // page does not claim a fresher review than it had.
    table_changed_at: changed ? new Date().toISOString() : (previous?.table_changed_at ?? new Date().toISOString()),
    ramps,
  };
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Powell ramps: ${ramps.length} rows -> src/data/powell-ramps.json${changed ? ' (table changed)' : ' (unchanged)'}`);
}

main().catch((e) => {
  console.error(`Powell ramps: unexpected error (${e && e.message ? e.message : e}); keeping the previous table.`);
  process.exit(0);
});
