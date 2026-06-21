// Cloudflare zone bootstrap — creates the lakelevelnow.com zone and prints the two
// assigned nameservers (to hand to Porkbun). Idempotent: if the zone already
// exists it just reads it back. Optionally adds a DNS TXT record for Google Search
// Console verification (set GOOGLE_SITE_VERIFICATION=... to use it).
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/cf-zone-create.mjs
//
// Token needs: Zone:Zone:Edit (create) + Zone:DNS:Edit, all zones.
import { writeFileSync } from 'node:fs';

const DOMAIN = 'lakelevelnow.com';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';

function die(m) { console.error('cf: ' + m); process.exit(1); }
if (!TOKEN || !ACCT) die('set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function cf(path, opts = {}) {
  const res = await fetch(`${CF}${path}`, { headers: H, ...opts });
  return res.json();
}

// Already exists?
let zone;
const list = await cf(`/zones?name=${DOMAIN}`);
if (list.success && list.result.length) {
  zone = list.result[0];
  console.log('cf: zone already exists, reusing.');
} else {
  const created = await cf('/zones', {
    method: 'POST',
    body: JSON.stringify({ name: DOMAIN, account: { id: ACCT }, type: 'full' }),
  });
  if (!created.success) die('zone create failed: ' + JSON.stringify(created.errors));
  zone = created.result;
  console.log('cf: zone CREATED.');
}

console.log('cf: zone id   ', zone.id);
console.log('cf: status    ', zone.status);
console.log('cf: nameservers (set these at Porkbun):');
(zone.name_servers || []).forEach((n) => console.log('   -', n));

// Optional: GSC verification via DNS TXT (set GOOGLE_SITE_VERIFICATION to the token
// Google shows under "Domain name provider" verification, without the quotes).
const gsc = process.env.GOOGLE_SITE_VERIFICATION;
if (gsc) {
  const txt = await cf(`/zones/${zone.id}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'TXT', name: DOMAIN, content: gsc, ttl: 1 }),
  });
  console.log('cf: GSC TXT record ' + (txt.success ? 'added.' : 'failed: ' + JSON.stringify(txt.errors)));
}

writeFileSync('/tmp/lakelevelnow-zone.json', JSON.stringify(zone));
// Print a ready-to-use CF_NS for the porkbun script.
console.log('\nCF_NS=' + (zone.name_servers || []).join(','));
