// Lake Level Almanac fulfilment worker (lakelevelnow.com).
// Routes: GET /health, /catalog, /verify?session_id=, /file?t=, /hit?e=&l=&p=
// Bindings: KV ALMANAC_ASSETS (catalog + zips), KV ALMANAC_ORDERS (mint + hit counters),
// vars ALLOWED_ORIGINS, ALMANAC_MODE, LINK_SINGLE_ID, LINK_BUNDLE_ID (comma-separated lists),
// secrets SIGNING_KEY, STRIPE_SECRET_KEY.

const VERSION = "1.1.0";
const TEXT = { "content-type": "text/plain; charset=utf-8" };
const JSONH = { "content-type": "application/json; charset=utf-8" };
const TOKEN_TTL_S = 1800;
const MAX_MINTS_PER_SESSION = 60;
const COUNTER_TTL_S = 60 * 60 * 24 * 400;
const PAID_STATES = ["paid", "no_payment_required"];
const MAX_CUSTOM_FIELDS = 10;
const HIT_EVENTS = ["alm_view", "sample_view", "cta_click", "checkout_open", "thanks_view", "thanks_ok"];
const HIT_HOSTS = ["lakelevelnow.com", "localhost"];
const HIT_DIM_MAX = 40;
const MAX_HIT_WRITES = 3;

const enc = new TextEncoder();
const json = (obj, status, extra) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSONH, ...extra } });
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Comma-separated env list -> trimmed, non-empty entries (bounded by env var size).
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

function cors(origin, env) {
  const allowed = list(env.ALLOWED_ORIGINS);
  const ok = origin && allowed.includes(origin);
  return {
    "access-control-allow-origin": ok ? origin : allowed[0] || "https://lakelevelnow.com",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "origin"
  };
}

// ---- signed download tokens -------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = unb64url(token.slice(dot + 1));
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1e3)) {
    return null;
  }
  return payload;
}

// ---- Stripe + catalog -------------------------------------------------------

async function getSession(id, env) {
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`,
    { headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "stripe-version": "2024-06-20"
    } }
  );
  if (!r.ok) return { error: `stripe ${r.status}` };
  return { session: await r.json() };
}

async function catalog(env) {
  const raw = await env.ALMANAC_ASSETS.get("catalog.json");
  return raw ? JSON.parse(raw) : { lakes: [] };
}

function keyFor(sku, lake, cat) {
  if (sku === "bundle") return { key: "bundle.zip", filename: "All-Lakes-Lake-Level-Almanac.zip" };
  const hit = (cat.lakes || []).find((l) => l.slug === lake);
  return hit ? { key: `lake/${hit.slug}.zip`, filename: hit.zip } : null;
}

// Candidate lake strings, in priority order:
// 1. Checkout custom field key === "lake" (dropdown value, else text value)
// 2. client_reference_id
function lakeCandidates(session) {
  const out = [];
  const fields = Array.isArray(session.custom_fields) ? session.custom_fields : [];
  const n = Math.min(fields.length, MAX_CUSTOM_FIELDS);
  for (let i = 0; i < n; i++) {
    const f = fields[i];
    if (!f || f.key !== "lake") continue;
    const v = (f.dropdown && f.dropdown.value) || (f.text && f.text.value) || "";
    if (v) out.push(String(v));
  }
  if (session.client_reference_id) out.push(String(session.client_reference_id));
  return out;
}

// Returns { slug, tried }; slug is the canonical catalog slug or null.
// Both sides are normalised so "lakepowell" matches "lake-powell".
function resolveLake(session, cat) {
  const tried = lakeCandidates(session);
  const lakes = cat.lakes || [];
  for (const c of tried) {
    const n = norm(c);
    if (!n) continue;
    const hit = lakes.find((l) => norm(l.slug) === n);
    if (hit) return { slug: hit.slug, tried };
  }
  return { slug: null, tried };
}

// Validates the session id, loads the session, maps it to a SKU and checks payment.
// Returns { session, sku } on success or { fail: [body, status] }.
async function loadOrder(sid, env) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) {
    return { fail: [{ ok: false, error: "bad_session_id" }, 400] };
  }
  const { session, error } = await getSession(sid, env);
  if (error) return { fail: [{ ok: false, error: "lookup_failed" }, 502] };
  const link = session.payment_link;
  let sku = null;
  if (link && list(env.LINK_SINGLE_ID).includes(link)) sku = "single";
  else if (link && list(env.LINK_BUNDLE_ID).includes(link)) sku = "bundle";
  if (!sku) return { fail: [{ ok: false, error: "not_our_product" }, 403] };
  if (!PAID_STATES.includes(session.payment_status)) {
    return { fail: [{ ok: false, error: "not_paid", status: session.payment_status }, 402] };
  }
  return { session, sku };
}

async function handleVerify(url, env, ch) {
  const sid = url.searchParams.get("session_id") || "";
  const order = await loadOrder(sid, env);
  if (order.fail) return json(order.fail[0], order.fail[1], ch);
  const { session, sku } = order;
  const cat = await catalog(env);
  const lakes = cat.lakes || [];
  let lake = null;
  if (sku === "single") {
    const res = resolveLake(session, cat);
    if (!res.slug) {
      return json({
        ok: false,
        error: "unknown_lake",
        lake: null,
        tried: res.tried,
        lakes: lakes.map((l) => l.slug)
      }, 409, ch);
    }
    lake = res.slug;
  }
  const counterKey = `mints:${sid}`;
  const used = parseInt(await env.ALMANAC_ORDERS.get(counterKey) || "0", 10);
  if (used >= MAX_MINTS_PER_SESSION) {
    return json({ ok: false, error: "download_limit_reached" }, 429, ch);
  }
  await env.ALMANAC_ORDERS.put(counterKey, String(used + 1), { expirationTtl: COUNTER_TTL_S });
  const target = keyFor(sku, lake, cat);
  if (!target) return json({ ok: false, error: "no_such_file" }, 404, ch);
  const exp = Math.floor(Date.now() / 1e3) + TOKEN_TTL_S;
  const token = await sign({ k: target.key, f: target.filename, exp, s: sid }, env.SIGNING_KEY);
  const meta = sku === "single"
    ? lakes.find((l) => l.slug === lake)
    : { name: `All ${lakes.length} lakes`, bytes: cat.bundleBytes || null };
  return json({
    ok: true,
    payment_receipt: paymentReceipt(session, sku),
    sku,
    lake,
    name: meta?.name || null,
    bytes: meta?.bytes || null,
    filename: target.filename,
    url: `${url.origin}/file?t=${encodeURIComponent(token)}`,
    expiresIn: TOKEN_TTL_S,
    downloadsUsed: used + 1,
    downloadsAllowed: MAX_MINTS_PER_SESSION
  }, 200, ch);
}

// Analytics is stricter than delivery: free and test fulfillments are not purchases.
export function paymentReceipt(s, sku) {
  if (!s || s.livemode !== true || !/^cs_live_[A-Za-z0-9]+$/.test(s.id || '') ||
      s.status !== 'complete' || s.payment_status !== 'paid') return null;
  return { transaction_id: s.id, payment_status: 'paid', amount_unit: 'stripe_minor',
    amount_total: s.amount_total, amount_tax: s.total_details?.amount_tax ?? null,
    amount_shipping: s.total_details?.amount_shipping ?? null, currency: s.currency,
    item_id: sku === 'bundle' ? 'almanac_bundle' : 'almanac_single' };
}

async function handleFile(url, env, ch) {
  const t = url.searchParams.get("t") || "";
  const payload = await verifyToken(t, env.SIGNING_KEY);
  if (!payload) return new Response("link expired or invalid", { status: 403, headers: TEXT });
  const obj = await env.ALMANAC_ASSETS.get(payload.k, "arrayBuffer");
  if (!obj) return new Response("file not found", { status: 404, headers: TEXT });
  return new Response(obj, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${payload.f}"`,
      "cache-control": "private, no-store",
      ...ch
    }
  });
}

// ---- beacon counters --------------------------------------------------------

// Hostname of the Origin (else Referer) header, "" when absent or unparsable.
function hitHost(request) {
  const src = request.headers.get("origin") || request.headers.get("referer") || "";
  try {
    return new URL(src).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sanitiseDim(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, HIT_DIM_MAX);
}

async function bump(env, key) {
  const cur = parseInt(await env.ALMANAC_ORDERS.get(key) || "0", 10);
  await env.ALMANAC_ORDERS.put(key, String(cur + 1), { expirationTtl: COUNTER_TTL_S });
}

// Always 204. Writes only for whitelisted events from our own site (bot filter).
async function handleHit(url, request, env, ch) {
  const headers = { ...ch, "cache-control": "no-store" };
  const done = () => new Response(null, { status: 204, headers });
  const event = url.searchParams.get("e") || "";
  if (!HIT_EVENTS.includes(event)) return done();
  if (!HIT_HOSTS.includes(hitHost(request))) return done();
  const lake = sanitiseDim(url.searchParams.get("l"));
  const place = sanitiseDim(url.searchParams.get("p"));
  const day = new Date().toISOString().slice(0, 10);
  const keys = [`hits:${day}:${event}`];
  if (lake) keys.push(`hits:${day}:${event}:${lake}`);
  if (place) keys.push(`hits:${day}:${event}:p:${place}`);
  const n = Math.min(keys.length, MAX_HIT_WRITES);
  for (let i = 0; i < n; i++) await bump(env, keys[i]);
  return done();
}

// ---- router -----------------------------------------------------------------

async function handleHealth(env, ch) {
  const cat = await catalog(env);
  return json({
    ok: true,
    service: "lake-level-almanac",
    version: VERSION,
    mode: env.ALMANAC_MODE,
    lakes: (cat.lakes || []).length,
    configured: {
      stripeKey: Boolean(env.STRIPE_SECRET_KEY),
      signingKey: Boolean(env.SIGNING_KEY),
      linkSingle: Boolean(env.LINK_SINGLE_ID),
      linkBundle: Boolean(env.LINK_BUNDLE_ID)
    }
  }, 200, ch);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ch = cors(request.headers.get("origin"), env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: TEXT });
    try {
      switch (url.pathname) {
        case "/health":
          return handleHealth(env, ch);
        case "/catalog":
          return json(await catalog(env), 200, { ...ch, "cache-control": "public, max-age=3600" });
        case "/verify":
          return handleVerify(url, env, ch);
        case "/file":
          return handleFile(url, env, ch);
        case "/hit":
          return handleHit(url, request, env, ch);
        default:
          return new Response("not found", { status: 404, headers: TEXT });
      }
    } catch (e) {
      console.error("almanac worker error", (e && e.stack) || String(e));
      return json({ ok: false, error: "internal" }, 500, ch);
    }
  }
};
