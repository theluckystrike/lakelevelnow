/* GA4 funnel: public page context and allowlisted product metadata only.
   Checkout clicks express intent, never confirmed payment. */
(function () {
  'use strict';
  var script = document.currentScript;
  var measurementId = script && script.getAttribute('data-measurement-id');
  if (!/^G-[A-Z0-9]+$/.test(measurementId || '') || window.__siteGA4) return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  window.__siteGA4 = true;
  var lake = script.getAttribute('data-site') === 'lakelevelnow';
  var site = lake ? 'lakelevelnow' : 'ingredientcalculator';
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var cleanLocation = location.origin + location.pathname;
  var referrer = '';
  try { referrer = document.referrer ? new URL(document.referrer).origin + '/' : ''; } catch (_) {}
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  var gtag = window.gtag;
  gtag('js', new Date());
  gtag('config', measurementId, {
    send_page_view: false,
    page_location: cleanLocation,
    page_referrer: referrer,
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });
  var once = Object.create(null);
  var campaign = {};
  var query = new URLSearchParams(location.search);
  ['source', 'medium', 'campaign', 'id'].forEach(function (field) {
    var value = query.get('utm_' + field);
    // Campaign names must be short public tokens; reject free text and contact data.
    if (value && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) campaign['campaign_' + (field === 'campaign' ? 'name' : field)] = value;
  });
  function event(name, params, key) {
    if (key && once[key]) return;
    if (key) once[key] = true;
    gtag('event', name, Object.assign({ send_to: measurementId, site_name: site,
      page_location: cleanLocation, page_referrer: referrer, transport_type: 'beacon' }, campaign, params || {}));
  }
  event('page_view', {}, 'page_view');
  // Invoked only by the return page after its existing paid-verification response.
  // Persist the transaction identifier alone; never pass licenses or customer fields.
  var paidSeen = new Set();
  window.__siteGA4Purchase = function (receipt, requestedSession) {
    if (path !== (lake ? '/almanac/thanks' : '/welcome') || !receipt ||
        !/^cs_live_[A-Za-z0-9]+$/.test(requestedSession || '') ||
        receipt.transaction_id !== requestedSession || receipt.payment_status !== 'paid' ||
        receipt.amount_unit !== 'stripe_minor') return;
    var allowed = lake ? ['almanac_single', 'almanac_bundle'] : ['ingredientcalculator_pro'];
    if (allowed.indexOf(receipt.item_id) < 0 || paidSeen.has(requestedSession)) return;
    var key = 'ga4_purchase_' + site + '_' + requestedSession;
    try { if (localStorage.getItem(key)) return; } catch (_) {}
    var params = { transaction_id: requestedSession, payment_verified: true, revenue_status: 'not_reported' };
    var currency = String(receipt.currency || '').toUpperCase();
    // Explicit supported charge units. Unknown currencies retain a count without guessed money.
    var divisor = /^(USD|EUR|GBP|PLN|CAD|AUD|NZD|CHF|SEK|NOK|DKK|SGD|HKD|INR|BRL|MXN|ZAR)$/.test(currency) ? 100 : /^(JPY|KRW)$/.test(currency) ? 1 : 0;
    var amounts = [receipt.amount_total, receipt.amount_tax, receipt.amount_shipping];
    if (divisor && amounts.every(function (v) { return Number.isSafeInteger(v) && v >= 0; }) &&
        receipt.amount_tax + receipt.amount_shipping <= receipt.amount_total) {
      params.currency = currency;
      params.value = (receipt.amount_total - receipt.amount_tax - receipt.amount_shipping) / divisor;
      params.tax = receipt.amount_tax / divisor;
      params.shipping = receipt.amount_shipping / divisor;
      params.revenue_status = 'verified';
      params.items = [{ item_id: receipt.item_id, price: params.value, quantity: 1 }];
    }
    paidSeen.add(requestedSession);
    event('purchase', params);
    try { localStorage.setItem(key, '1'); } catch (_) {}
  };
  document.dispatchEvent(new Event('site-ga4-ready'));
  var tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
  document.head.appendChild(tag);
  var products = lake ? {
    '00w3cw2oafoc7VXgjj43S0q': { item_id: 'almanac_single', item_name: 'Lake Level Almanac single', price: 19, quantity: 1 },
    '4gM5kE1k63Fugst0kl43S0B': { item_id: 'almanac_bundle', item_name: 'Lake Level Almanac bundle', price: 79, quantity: 1 }
  } : {
    'cNieVe7Iu3Fuccd3wx43S0A': { item_id: 'ingredientcalculator_pro', item_name: 'IngredientCalculator Pro', price: 79, quantity: 1 }
  };
  function productFor(anchor) {
    try {
      var url = new URL(anchor.href, location.href);
      return url.hostname === 'buy.stripe.com' ? products[url.pathname.slice(1)] : null;
    } catch (_) { return null; }
  }
  function placement(anchor) {
    var section = anchor.closest('[data-alm-place], [data-mt-paywall], header, footer, nav');
    if (!section) return 'content';
    var place = section.getAttribute('data-alm-place');
    return /^[a-z0-9-]{1,40}$/.test(place || '') ? place : section.hasAttribute('data-mt-paywall') ? 'paywall' : section.tagName.toLowerCase();
  }
  function payload(product, anchor) {
    return { currency: 'USD', value: product.price, items: [product], placement: placement(anchor) };
  }
  if (lake ? path === '/almanac' : path === '/pro' || path === '/kitchen-pack') {
    event('pricing_view', { content_id: lake ? 'almanac' : 'ingredientcalculator_pro' }, 'pricing_view');
  }
  if (lake && path === '/almanac/sample') event('sample_view', { content_id: 'almanac_sample' }, 'sample_view');
  document.addEventListener('click', function (ev) {
    var anchor = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!anchor || anchor.getAttribute('aria-disabled') === 'true') return;
    var product = productFor(anchor);
    if (product) {
      event('begin_checkout', payload(product, anchor), 'checkout:' + product.item_id);
      return;
    }
    var url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    var target = url.pathname.replace(/\/+$/, '');
    var intent = lake ? target === '/almanac' || target === '/almanac/sample' : target === '/pro' || target === '/kitchen-pack';
    if (intent) event('select_content', { content_type: 'paid_offer', content_id: target,
      placement: placement(anchor) }, 'select:' + target);
  }, true);
  function observeOffers() {
    if (!window.IntersectionObserver) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5) return;
        var product = productFor(entry.target);
        if (product) event('view_item', payload(product, entry.target), 'offer:' + product.item_id);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    var observed = new WeakSet();
    function register(root) {
      var anchors = root.matches && root.matches('a[href]') ? [root] : [];
      if (root.querySelectorAll) anchors = anchors.concat(Array.from(root.querySelectorAll('a[href]')));
      anchors.forEach(function (anchor) {
        if (!observed.has(anchor) && productFor(anchor)) {
          observed.add(anchor);
          observer.observe(anchor);
        }
      });
    }
    register(document);
    // Paywalls can render after an asynchronous license check.
    new MutationObserver(function (records) {
      records.forEach(function (record) { record.addedNodes.forEach(register); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeOffers, { once: true });
  else observeOffers();
})();
