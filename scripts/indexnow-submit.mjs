// IndexNow submit — pings IndexNow (Bing, Yandex, Seznam, et al.) with every URL
// in the built sitemap so new/changed pages are crawled fast. Run AFTER deploy.
//   node scripts/indexnow-submit.mjs
// Reads the public key from .indexnow-key; the matching key file must be live at
// https://lakelevelnow.com/<key>.txt (it is, via public/<key>.txt).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'lakelevelnow.com';
const UA = 'lakelevelnow-indexnow/1.0 (+https://lakelevelnow.com)';

function fail(msg) {
  console.error(`IndexNow: ${msg}`);
  process.exit(1);
}

const key = readFileSync(join(ROOT, '.indexnow-key'), 'utf8').trim();
if (!/^[a-f0-9]{8,}$/i.test(key)) fail('missing/invalid .indexnow-key');

// Pull URLs from every built sitemap shard (Astro emits sitemap-0.xml, sitemap-1.xml, ...).
const dist = join(ROOT, 'dist');
const shards = readdirSync(dist).filter((f) => /^sitemap-\d+\.xml$/.test(f));
if (shards.length === 0) fail('no sitemap-*.xml in dist/ — run `npm run build` first');
let urlList = [];
for (const s of shards) {
  const xml = readFileSync(join(dist, s), 'utf8');
  urlList.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
}
urlList = [...new Set(urlList)];
if (urlList.length === 0) fail('no URLs parsed from sitemaps');

const body = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList };

console.log(`IndexNow: submitting ${urlList.length} URLs for ${HOST} (from ${shards.join(', ')})…`);
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA },
  body: JSON.stringify(body),
});
// 200 = accepted, 202 = accepted/pending. Both are success.
if (res.status === 200 || res.status === 202) {
  console.log(`IndexNow: OK (${res.status}) — ${urlList.length} URLs submitted.`);
} else {
  fail(`unexpected status ${res.status}: ${await res.text()}`);
}
