import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { resolveLake } from '../src/index.js';

const catalog = JSON.parse(readFileSync(new URL('../../src/data/almanac.json', import.meta.url)));
const attempt = '0123456789abcdef0123456789abcdef';

for (const lake of catalog.lakes) {
  assert.equal(resolveLake({ client_reference_id: lake.slug }, catalog).slug, lake.slug);
  assert.equal(resolveLake({ client_reference_id: lake.slug + '--' + attempt }, catalog).slug, lake.slug);
}
assert.equal(resolveLake({ client_reference_id: 'pine-flat-lake--bad' }, catalog).slug, null);
assert.equal(resolveLake({ client_reference_id: 'unknown--' + attempt }, catalog).slug, null);
assert.equal(resolveLake({ custom_fields: [{ key: 'lake', dropdown: { value: 'pine-flat-lake' } }] }, catalog).slug, 'pine-flat-lake');

const layout = readFileSync(new URL('../../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');
const inline = layout.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inline, 'Almanac inline script exists');

function clickFixture(optOut) {
  const listeners = {};
  const requests = [];
  const anchor = {
    href: 'https://buy.stripe.com/00w3cw2oafoc7VXgjj43S0q?client_reference_id=pine-flat-lake',
    dataset: {},
    getAttribute(key) { return key === 'href' ? this.href : key === 'data-lake' ? 'pine-flat-lake' : null; }
  };
  const place = { getAttribute: () => 'lake' };
  const target = { closest(selector) {
    if (selector === '[data-alm-place]') return place;
    if (selector === 'a[data-alm-buy],a[data-alm-cta],.alm-home-btn') return anchor;
    return null;
  } };
  const context = {
    URL,
    navigator: { globalPrivacyControl: optOut },
    location: { pathname: '/lake/pine-flat-lake/' },
    window: { doNotTrack: '0', crypto: { randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef' } },
    document: { addEventListener(name, fn) { listeners[name] = fn; } },
    fetch(url) { requests.push(url); return Promise.resolve(); }
  };
  vm.runInNewContext(inline, context);
  listeners.click({ target });
  return { anchor, requests };
}

const allowed = clickFixture(false);
assert.equal(new URL(allowed.anchor.href).searchParams.get('client_reference_id'), 'pine-flat-lake--' + attempt);
assert.equal(allowed.anchor.dataset.checkoutAttemptId, attempt);
assert.equal(allowed.requests.length, 1);
assert.equal(new URL(allowed.requests[0]).searchParams.get('a'), attempt);
const denied = clickFixture(true);
assert.equal(new URL(denied.anchor.href).searchParams.get('client_reference_id'), 'pine-flat-lake');
assert.equal(denied.requests.length, 0);

let writes = 0;
const recorded = [];
const env = {
  ALLOWED_ORIGINS: 'https://lakelevelnow.com',
  ALMANAC_ORDERS: { get: async () => '0', put: async (...args) => { writes++; recorded.push(args); } }
};
for (const name of ['Sec-GPC', 'DNT']) {
  const response = await worker.fetch(new Request('https://lake-level-almanac.example/hit?e=checkout_open&l=pine-flat-lake', {
    headers: { Origin: 'https://lakelevelnow.com', [name]: '1' }
  }), env);
  assert.equal(response.status, 204);
}
assert.equal(writes, 0, 'Opted-out hits must not reach KV');
const accepted = await worker.fetch(new Request('https://lake-level-almanac.example/hit?e=checkout_open&l=pine-flat-lake&p=lake&a=' + attempt, {
  headers: { Origin: 'https://lakelevelnow.com' }
}), env);
assert.equal(accepted.status, 204);
const clickReceipt = recorded.find(([key]) => key.startsWith('click:'));
assert.ok(clickReceipt, 'First-party click receipt exists');
assert.ok(clickReceipt[0].endsWith(':' + attempt));
assert.deepEqual(JSON.parse(clickReceipt[1]), { lake: 'pine-flat-lake', placement: 'lake' });
console.log('PASS: all catalog lakes, legacy and opaque references, opted-out browser/Worker beacons');
