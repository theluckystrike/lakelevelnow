/* LakeLevelNow ad loader. Loads Google AdSense only when the Cloudflare trace on the site's own
   Worker (lakelevelnow.lipmichal.workers.dev) reports a country outside the EEA, UK and
   Switzerland. GitHub Pages has no /cdn-cgi/trace, hence the Worker. Unknown, XX, T1, a timeout
   or a failed lookup count as EEA, so nothing loads and the slots collapse. Global Privacy
   Control or Do Not Track asks Google for non-personalized ads. */
(function () {
  'use strict';
  var w = window, d = document;
  if (w.__llnAds) return;
  w.__llnAds = 1;
  var slots = [].slice.call(d.querySelectorAll('.ad-slot[data-ad-client]'));
  if (!slots.length) return;
  var TRACE = 'https://lakelevelnow.lipmichal.workers.dev/cdn-cgi/trace';
  var REGION = ('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE ' +
    'IS LI NO GB CH AX GF GP MQ RE YT MF GG JE IM GI').split(' ');
  function collapse() { slots.forEach(function (s) { s.hidden = true; s.style.minHeight = '0'; }); }
  function load(cc) {
    if (!cc || cc === 'XX' || cc === 'T1' || REGION.indexOf(cc) >= 0) return collapse();
    var client = slots[0].getAttribute('data-ad-client');
    if (!/^ca-pub-\d{10,20}$/.test(client || '')) return collapse();
    w.adsbygoogle = w.adsbygoogle || [];
    var n = navigator;
    if (n.globalPrivacyControl === true || n.doNotTrack === '1' || w.doNotTrack === '1') w.adsbygoogle.requestNonPersonalizedAds = 1;
    var s = d.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(client);
    (d.head || d.documentElement).appendChild(s);
    slots.forEach(function (box) {
      var id = box.getAttribute('data-ad-slot-id');
      if (!id || !/^\d{6,20}$/.test(id)) { box.hidden = true; return; }
      var ins = d.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.setAttribute('data-ad-client', client);
      ins.setAttribute('data-ad-slot', id);
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
      box.hidden = false;
      box.appendChild(ins);
      try { w.adsbygoogle.push({}); } catch (e) {}
    });
  }
  if (!w.fetch) return collapse();
  var ctl = w.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
  w.fetch(TRACE, { credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
    .then(function (r) { return r && r.ok ? r.text() : ''; })
    .then(function (t) { clearTimeout(timer); var m = /^loc=([A-Z0-9]{2})\s*$/m.exec(t || ''); load(m ? m[1] : null); },
      function () { clearTimeout(timer); collapse(); });
})();
