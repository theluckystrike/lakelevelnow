// IndexNow submit — pings IndexNow (Bing, Yandex, Seznam, et al.) with every URL
// in the LIVE sitemap so new/changed pages are crawled fast. Run AFTER deploy,
// from the workflow that publishes the apex (pages.yml → GitHub Pages).
//   node scripts/indexnow-submit.mjs
// Reads the public key from .indexnow-key; the matching key file must be live at
// https://lakelevelnow.com/<key>.txt (it is, via public/<key>.txt).
//
// Best-effort by design (NASA Power of 10, see ~/Desktop/NASA/NASA.md):
//   - This runs AFTER a successful Cloudflare deploy. IndexNow is a non-critical
//     crawl hint (search engines still discover pages via the sitemap), so a
//     ping failure is LOW severity and MUST NOT fail an already-live deploy.
//   - Every network call is bounded: a per-request AbortController timeout and a
//     retry loop with a hard attempt ceiling + capped exponential backoff.
//     IndexNow's 403 "UserForbiddedToAccessSite" is a transient key-verification
//     result (their fetch of the key file raced the deploy), so it is retried.
//   - No unhandled rejections; the process always exits 0.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'lakelevelnow.com';
const ORIGIN = `https://${HOST}`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const UA = 'lakelevelnow-indexnow/1.0 (+https://lakelevelnow.com)';

// --- Named constants (NASA: no magic numbers, every bound explicit) ---
const MAX_ATTEMPTS = 4; // hard ceiling on total submit tries
const TIMEOUT_MS = 15000; // per-request hard ceiling
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s ...
const BACKOFF_CEILING_MS = 30000; // capped exponential backoff
const MAX_URLS = 10000; // IndexNow per-request URL limit
const MAX_SHARDS = 50; // hard ceiling on sitemap-N.xml shards fetched
const KEY_RE = /^[a-f0-9]{8,}$/i;
const SUCCESS_STATUS = new Set([200, 202]);
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

const info = (msg) => console.log(`IndexNow: ${msg}`);
const warn = (msg) => console.warn(`IndexNow [WARN]: ${msg}`);

/** Best-effort exit: log a reason and never fail the deploy that already shipped. */
function skip(reason) {
  warn(`${reason} — skipping (deploy already succeeded; non-fatal).`);
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read + validate the IndexNow key. Returns the key, or null if unusable. */
function readKey() {
  try {
    const key = readFileSync(join(ROOT, '.indexnow-key'), 'utf8').trim();
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** GET a URL with a hard timeout. Returns the body text, or null on any failure. */
async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect unique <loc> URLs from the LIVE sitemap shards (sitemap-0.xml,
 * sitemap-1.xml, …). Runs post-deploy, so the live sitemap is the source of
 * truth for what actually shipped. Bounded by MAX_SHARDS and MAX_URLS; stops at
 * the first shard that is absent.
 */
async function collectUrls() {
  const seen = new Set();
  const shards = [];
  for (let i = 0; i < MAX_SHARDS; i++) {
    const name = `sitemap-${i}.xml`;
    const xml = await getText(`${ORIGIN}/${name}`);
    if (xml === null) break; // first missing shard ends the sequence
    shards.push(name);
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const loc = m[1].trim();
      if (loc.startsWith(ORIGIN)) seen.add(loc); // only our own host
      if (seen.size >= MAX_URLS) break;
    }
    if (seen.size >= MAX_URLS) break;
  }
  return { shards, urls: [...seen] };
}

/** One POST with a hard timeout. Returns {status,text}; status 0 on network error. */
async function postOnce(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    return { status: res.status, text };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(err);
    return { status: 0, text: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded retry with capped exponential backoff. Returns true on success. */
async function submitWithRetry(body) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { status, text } = await postOnce(body);
    if (SUCCESS_STATUS.has(status)) {
      info(`OK (${status}) — ${body.urlList.length} URLs submitted (attempt ${attempt}).`);
      return true;
    }
    const retryable = status === 0 || RETRYABLE_STATUS.has(status);
    warn(`attempt ${attempt}/${MAX_ATTEMPTS} got status ${status}: ${String(text).slice(0, 200)}`);
    if (!retryable || attempt === MAX_ATTEMPTS) return false;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CEILING_MS);
    await sleep(delay);
  }
  return false;
}

async function main() {
  const key = readKey();
  if (!key) skip('missing/invalid .indexnow-key');

  const collected = await collectUrls();
  if (collected.shards.length === 0) skip(`no live sitemap at ${ORIGIN}/sitemap-0.xml`);
  if (collected.urls.length === 0) skip('no URLs parsed from live sitemaps');

  const body = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: collected.urls };
  info(`submitting ${collected.urls.length} URLs for ${HOST} (from ${collected.shards.join(', ')})…`);

  const ok = await submitWithRetry(body);
  if (!ok) {
    warn('all attempts failed; search engines will still crawl via sitemap.');
  }
  // Best-effort ping: always succeed so a crawl hint never blocks a live deploy.
  process.exit(0);
}

main();
