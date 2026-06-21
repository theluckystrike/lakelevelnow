// Porkbun nameserver switch — points lakelevelnow.com at Cloudflare's nameservers
// via the Porkbun API (the DNS migration cutover). Idempotent: re-running with the
// same NS is a no-op on Porkbun's side.
//
//   PORKBUN_APIKEY=pk1_... PORKBUN_SECRET=sk1_... \
//   CF_NS="alice.ns.cloudflare.com,bob.ns.cloudflare.com" \
//   node scripts/porkbun-set-ns.mjs
//
// Requires: lakelevelnow.com opted into API access (Porkbun -> Domain Management ->
// Details -> API Access, or the account-wide "Opt all domains" toggle).
const DOMAIN = 'lakelevelnow.com';
const API = 'https://api.porkbun.com/api/json/v3';

const apikey = process.env.PORKBUN_APIKEY;
const secretapikey = process.env.PORKBUN_SECRET;
const ns = (process.env.CF_NS || '').split(',').map((s) => s.trim()).filter(Boolean);

function die(m) { console.error('porkbun: ' + m); process.exit(1); }
if (!apikey || !secretapikey) die('set PORKBUN_APIKEY and PORKBUN_SECRET');
if (ns.length < 2) die('set CF_NS to the two Cloudflare nameservers (comma-separated)');

async function call(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey, secretapikey, ...body }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok && j.status === 'SUCCESS', j };
}

// 1. Auth + connectivity check.
const ping = await call('/ping', {});
if (!ping.ok) die('ping failed (bad keys?): ' + JSON.stringify(ping.j));
console.log('porkbun: authenticated, your IP', ping.j.yourIp);

// 2. Set nameservers.
const upd = await call(`/domain/updateNs/${DOMAIN}`, { ns });
if (!upd.ok) die('updateNs failed: ' + JSON.stringify(upd.j));
console.log(`porkbun: nameservers for ${DOMAIN} set ->`, ns.join(', '));

// 3. Read back to confirm.
const got = await call(`/domain/getNs/${DOMAIN}`, {});
if (got.ok) console.log('porkbun: confirmed NS now', (got.j.ns || []).join(', '));
console.log('Done. Cloudflare will email when the zone goes Active (minutes-hours).');
