// porkbun-to-pages.mjs — point lakelevelnow.com at GitHub Pages (the apex host),
// replacing the old Porkbun forwarder. Run with a valid Porkbun API key + SECRET:
//   PORKBUN_APIKEY=pk1_... PORKBUN_SECRET=sk1_... node scripts/porkbun-to-pages.mjs
// Porkbun v3 REQUIRES the secret (sk1_) — the pk1_ "API Key" alone auth-fails.
// The secret is shown ONCE when you create a key (not in the dashboard table).
import { readFileSync } from 'node:fs';

const DOMAIN = 'lakelevelnow.com';
const API = 'https://api.porkbun.com/api/json/v3';
const apikey = process.env.PORKBUN_APIKEY;
const secretapikey = process.env.PORKBUN_SECRET;
if (!apikey || !secretapikey) {
  console.error('Set PORKBUN_APIKEY (pk1_) AND PORKBUN_SECRET (sk1_).');
  process.exit(1);
}

// GitHub Pages apex A-records + www CNAME.
const PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];

async function call(path, body = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey, secretapikey, ...body }),
  });
  return res.json();
}

async function listRecords() {
  const d = await call(`/dns/list/${DOMAIN}`);
  if (d.status !== 'SUCCESS') throw new Error('list failed: ' + JSON.stringify(d));
  return d.records;
}

async function deleteRecord(id) {
  const d = await call(`/dns/delete/${DOMAIN}/${id}`);
  return d.status === 'SUCCESS';
}

async function createRecord(rec) {
  const d = await call(`/dns/create/${DOMAIN}`, rec);
  return d.status === 'SUCCESS';
}

const ping = await call('/ping');
if (ping.status !== 'SUCCESS') {
  console.error('Porkbun auth failed:', ping.status, ping.message);
  process.exit(1);
}
console.log('porkbun: authenticated as', ping.yourIp);

const records = await listRecords();
console.log(`porkbun: ${records.length} records on ${DOMAIN}`);

// 1) Remove existing A/AAAA/CNAME at root + www (the forwarder + anything stale).
let removed = 0;
for (const r of records) {
  if ((r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME' || r.type === 'ALIAS' || r.type === 'URL') &&
      (r.name === DOMAIN || r.name === `www.${DOMAIN}`)) {
    if (await deleteRecord(r.id)) { removed++; console.log(`  deleted ${r.type} ${r.name} -> ${r.content}`); }
  }
}
console.log(`porkbun: removed ${removed} stale/forward records`);

// 2) Add GitHub Pages apex A-records.
for (const ip of PAGES_A) {
  if (await createRecord({ type: 'A', name: '', content: ip, ttl: 600 })) console.log(`  added A @ ${ip}`);
}
// 3) www -> GitHub Pages.
if (await createRecord({ type: 'CNAME', name: 'www', content: 'theluckystrike.github.io', ttl: 600 })) {
  console.log('  added CNAME www -> theluckystrike.github.io');
}

console.log('\nDone. DNS now points to GitHub Pages. lakelevelnow.com resolves within minutes;');
console.log('GitHub auto-issues the HTTPS cert once the apex answers on the Pages IPs.');
