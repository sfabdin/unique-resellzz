// UniqueResellzz on Cloudflare Workers.
//
// One Worker serves everything: shop pages, the bag and checkout API, the
// Stripe webhook, photos, the Studio (admin), and the styles and browser
// scripts from static/ (packed into static.generated.js at build time).
//
// Bindings and secrets (see wrangler.jsonc and the README):
//   DB                     D1 database (items, orders, settings)
//   PHOTOS                 KV namespace (the photo files)
//   ADMIN_PASSWORD         password for /admin, 8+ characters
//   STRIPE_SECRET_KEY      sk_test_... or sk_live_...; checkout is closed without it
//   STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe webhook
//   BASE_URL               optional; the shop's public address if not the one in the request

import { createStore, ensureSchema, HttpError, CATEGORIES, CONDITIONS, PHOTO_NAME, MAX_PHOTO_BYTES } from './store.js';
import { createStripe, verifyStripeSignature, timingSafeEqual, hmacHex } from './stripe.js';
import * as views from './views.js';
import { STATIC } from './static.generated.js';

const ADMIN_COOKIE = 'nc_admin';
const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BAG = 10;
const LOCKED =
  'The Studio is locked. In Cloudflare, open Workers & Pages, choose this site, then Settings > Variables and Secrets. ' +
  'Add a Secret named ADMIN_PASSWORD (8 or more characters), then reload this page.';

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function respond(body, status = 200, headers = {}) {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  return new Response(body, { status, headers: h });
}
const page = (markup, status = 200, headers = {}) => respond(String(markup), status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
const json = (obj, status = 200, headers = {}) => respond(JSON.stringify(obj), status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
const redirect = (location, status = 302) => respond(null, status, { Location: location });

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(request) {
  if (Number(request.headers.get('content-length') || 0) > 1_000_000) throw new HttpError(413, 'That request is too big.');
  try {
    const v = await request.json();
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'That request could not be read.');
  }
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

const parseIds = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => parseInt(x, 10)).filter((n) => n > 0))].slice(0, MAX_BAG);

// Styles, browser scripts and the icon from static/.
function serveStatic(request, url) {
  const name = url.pathname.slice('/static/'.length);
  const file = Object.hasOwn(STATIC, name) ? STATIC[name] : null;
  if (!file) return respond('Not found', 404);
  const etag = `"${file.hash}"`;
  // Pages link these with ?v=<hash>, so that exact URL can be cached for good.
  const headers = { 'Content-Type': file.type, ETag: etag, 'Cache-Control': url.searchParams.get('v') === file.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300' };
  if (request.headers.get('If-None-Match') === etag) return respond(null, 304, headers);
  return respond(file.body, 200, headers);
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]                 clock for holds and orders (tests move it)
 * @param {string} [opts.stripeApiBase]             Stripe API address (tests point it at a fake)
 * @param {number} [opts.checkoutsPerTenMinutes]    per-visitor checkout attempts (default 8)
 */
export function createHandler(opts = {}) {
  const now = opts.now || (() => Date.now());

  return async function handle(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/static/')) return serveStatic(request, url);
    let ctx = null;
    try {
      await ensureSchema(env.DB);
      const store = createStore(env.DB, env.PHOTOS, now);
      // STRIPE_API_BASE exists only so tests can point a built copy at a fake Stripe.
      const stripe = env.STRIPE_SECRET_KEY ? createStripe(env.STRIPE_SECRET_KEY, { apiBase: opts.stripeApiBase || env.STRIPE_API_BASE || undefined }) : null;
      const base = (env.BASE_URL || url.origin).replace(/\/+$/, '');
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const pageCtx = async () => (ctx = { settings: await store.getSettings(), baseUrl: base, state: (it) => store.itemState(it) });
      return await route({ request, env, url, store, stripe, base, ip, pageCtx, now, opts });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Something went wrong. Please try again.';
      if (status === 500) console.error(err && err.stack ? err.stack : err);
      if (isApi) return json({ error: message, ...(err.extra || {}) }, status);
      try {
        const c = ctx || { settings: await createStore(env.DB, env.PHOTOS, now).getSettings(), baseUrl: url.origin, state: () => 'available' };
        return page(views.messagePage(c, { title: status === 404 ? 'Not found' : 'Something went wrong', message, status }), status);
      } catch {
        return respond(message, status, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    }
  };
}

async function route(c) {
  const { request, env, url, store, stripe, base, ip, pageCtx, opts } = c;
  // Link previews and uptime checks often send HEAD; answer it like GET (Cloudflare drops the body).
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const path = url.pathname;
  let m;

  const notFound = async () =>
    page(views.messagePage(await pageCtx(), { title: 'Not found', message: "That page isn't here. The piece may have been taken down.", status: 404 }), 404);

  // ---------- admin session ----------

  const adminPassword = env.ADMIN_PASSWORD || '';
  const adminReady = adminPassword.length >= 8;
  let signingKey = null;
  const sign = async (exp) => {
    if (!signingKey) signingKey = await hmacHex(env.SESSION_SECRET || (await store.secret('_session_secret')), `key:${adminPassword}`);
    return hmacHex(signingKey, `admin:${exp}`);
  };
  async function isAdmin() {
    if (!adminReady) return false;
    const v = parseCookies(request.headers.get('Cookie'))[ADMIN_COOKIE];
    if (!v) return false;
    const [exp, sig] = v.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    return timingSafeEqual(sig, await sign(exp));
  }
  const adminCookie = (value, maxAgeMs) =>
    [`${ADMIN_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`, ...(url.protocol === 'https:' ? ['Secure'] : [])].join('; ');

  // ---------- Stripe webhook ----------

  if (method === 'POST' && path === '/stripe/webhook') {
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return respond('Webhook not configured', 503);
    const payload = await request.text();
    if (!(await verifyStripeSignature(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
      return respond('Bad signature', 400);
    }
    const event = JSON.parse(payload);
    const session = event.data && event.data.object;
    if (session && session.object === 'checkout.session') {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        await store.applySession(session);
      } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
        const o = await store.getOrderBySession(session.id);
        if (o) await store.release(o.id, event.type === 'checkout.session.expired' ? 'expired' : 'failed');
      }
    }
    return json({ received: true });
  }

  // ---------- storefront ----------

  if (method === 'GET' && path === '/healthz') return respond('ok', 200, { 'Content-Type': 'text/plain' });
  if (method === 'GET' && path === '/robots.txt') {
    return respond(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /bag\nDisallow: /order/\nDisallow: /checkout/\n`, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
  }

  if (method === 'GET' && (m = path.match(/^\/uploads\/([^/]+)$/))) {
    if (!PHOTO_NAME.test(m[1])) return respond('Not found', 404);
    const photo = await store.getPhoto(m[1]);
    if (!photo) return respond('Not found', 404);
    return respond(photo.body, 200, { 'Content-Type': photo.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  if (method === 'GET' && path === '/') {
    const all = await store.listItems({ statuses: ['live'] });
    const q = url.searchParams;
    const category = CATEGORIES.includes(q.get('category')) ? q.get('category') : '';
    const brand = (q.get('brand') || '').slice(0, 60);
    const sort = ['price-asc', 'price-desc'].includes(q.get('sort')) ? q.get('sort') : '';
    let items = all.filter((it) => (!category || it.category === category) && (!brand || it.brand === brand));
    if (sort === 'price-asc') items.sort((a, b) => a.price_cents - b.price_cents);
    if (sort === 'price-desc') items.sort((a, b) => b.price_cents - a.price_cents);
    // Pieces on hold sink below the ones you can buy right now.
    items = items.map((it, i) => [it, i]).sort((a, b) => (store.itemState(a[0]) === 'hold') - (store.itemState(b[0]) === 'hold') || a[1] - b[1]).map((p) => p[0]);
    const categories = CATEGORIES.filter((cat) => all.some((it) => it.category === cat));
    const brands = [...new Set(all.map((it) => it.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const sold = (await store.listItems({ statuses: ['sold'] })).sort((a, b) => (b.sold_at || 0) - (a.sold_at || 0)).slice(0, 8);
    const outfits = (await store.listOutfits({ status: 'live' })).filter((o) => store.outfitState(o) === 'available');
    return page(views.homePage(await pageCtx(), { items, sold, outfits, categories, brands, query: { category, brand, sort }, total: all.length }));
  }

  if (method === 'GET' && (m = path.match(/^\/item\/([^/]+)$/))) {
    const it = await store.getItem(parseInt(m[1], 10));
    if (!it || (it.status === 'draft' && !(await isAdmin()))) return notFound();
    const canonical = views.itemPath(it);
    if (path !== canonical) return redirect(canonical, 301);
    return page(views.itemPage(await pageCtx(), it), 200, it.status === 'draft' ? { 'Cache-Control': 'no-store' } : {});
  }

  if (method === 'GET' && (m = path.match(/^\/outfit\/([^/]+)$/))) {
    const o = await store.getOutfit(parseInt(m[1], 10));
    if (!o || (o.status === 'draft' && !(await isAdmin()))) return notFound();
    const canonical = views.outfitPath(o);
    if (path !== canonical) return redirect(canonical, 301);
    return page(views.outfitPage(await pageCtx(), o, store.outfitState(o)), 200, o.status === 'draft' ? { 'Cache-Control': 'no-store' } : {});
  }

  if (method === 'GET' && path === '/about') return page(views.aboutPage(await pageCtx()));
  if (method === 'GET' && path === '/bag') return page(views.bagPage(await pageCtx()));

  if (method === 'GET' && (m = path.match(/^\/order\/([\w-]+)$/))) {
    const o = await store.getOrderByToken(m[1]);
    if (!o) return notFound();
    return page(views.orderPage(await pageCtx(), o, { fresh: url.searchParams.get('new') === '1' }), 200, { 'Cache-Control': 'no-store' });
  }

  if (method === 'GET' && path === '/checkout/success') {
    const sid = url.searchParams.get('session_id') || '';
    let order = await store.getOrderBySession(sid);
    if (stripe && order && order.status === 'pending') {
      // Don't wait on the webhook: ask Stripe directly so the sale is recorded
      // even if the webhook is slow or was never set up.
      try {
        order = (await store.applySession(await stripe.retrieveCheckoutSession(sid))) || order;
      } catch (err) {
        console.error('checkout/success: could not fetch session', err.message);
      }
    }
    if (!order) {
      return page(views.messagePage(await pageCtx(), { title: 'Order not found', message: "We couldn't find that checkout. If you were charged, email us and we'll sort it out.", status: 404 }), 404);
    }
    return redirect(`/order/${order.token}?new=1`, 303);
  }

  // ---------- shopper API ----------

  if (method === 'GET' && path === '/api/bag') {
    const s = await store.getSettings();
    const items = [];
    for (const id of parseIds(url.searchParams.get('ids'))) {
      const it = await store.getItem(id);
      if (!it || it.status === 'draft') continue;
      items.push({
        id: it.id, url: views.itemPath(it), brand: it.brand, title: it.title, size: it.size, condition: it.condition,
        price_cents: it.price_cents, photo: it.photos[0] ? views.photoUrl(it.photos[0]) : null, state: store.itemState(it),
      });
    }
    const outfits = [];
    for (const id of parseIds(url.searchParams.get('outfits'))) {
      const o = await store.getOutfit(id);
      if (!o || o.status === 'draft') continue;
      outfits.push({
        id: o.id, url: views.outfitPath(o), title: o.title, price_cents: o.price_cents, separately_cents: o.items.reduce((n, it) => n + it.price_cents, 0),
        photo: views.outfitCover(o), state: store.outfitState(o), item_ids: o.item_ids, pieces: o.items.map((it) => views.itemName(it)),
      });
    }
    return json({ items, outfits, shipping_cents: s.shipping_cents, shipping_label: s.shipping_label, checkout_enabled: Boolean(stripe) });
  }

  if (method === 'POST' && path === '/api/checkout') {
    if (!stripe) return json({ error: "Checkout isn't open yet. Please check back soon!" }, 503);
    if (!(await store.allow(`checkout:${ip}`, opts.checkoutsPerTenMinutes || 8, 10 * 60 * 1000))) {
      return json({ error: 'Too many checkout attempts. Please wait a few minutes and try again.' }, 429);
    }
    const body = await readJson(request);
    const ids = parseIds(body.ids);
    // Outfits: every piece joins the order at its share of the set price.
    const sets = new Map();
    const goneOutfits = [];
    for (const oid of parseIds(body.outfits)) {
      const o = await store.getOutfit(oid);
      if (!o || store.outfitState(o) !== 'available') { goneOutfits.push(oid); continue; }
      const full = o.items.reduce((n, it) => n + it.price_cents, 0);
      let left = o.price_cents;
      o.items.forEach((it, i) => {
        const share = i === o.items.length - 1 ? left : Math.min(left, Math.round((o.price_cents * it.price_cents) / full));
        left -= share;
        sets.set(it.id, { price_cents: share, outfit: o.title });
        if (!ids.includes(it.id)) ids.push(it.id);
      });
    }
    if (goneOutfits.length) return json({ error: 'An outfit in your bag is no longer available as a set.', unavailable_outfits: goneOutfits }, 409);
    if (!ids.length) return json({ error: 'Your bag is empty.' }, 400);
    if (ids.length > 20) return json({ error: 'That is too many pieces for one order. Please split it in two.' }, 400);

    const { order, lines, checkoutExpiresAt } = await store.reserve(ids, sets);
    const s = await store.getSettings();
    const product = ({ item: it, outfit }) => {
      const p = { name: ((outfit ? `${outfit}: ` : '') + views.itemName(it)).slice(0, 250), metadata: { item_id: String(it.id) } };
      const d = [it.size && `Size ${it.size}`, it.condition].filter(Boolean).join(' · ');
      if (d) p.description = d;
      if (base.startsWith('https://') && it.photos[0]) p.images = [base + views.photoUrl(it.photos[0])];
      return p;
    };
    try {
      const session = await stripe.createCheckoutSession(
        {
          mode: 'payment',
          line_items: lines.map((l) => ({ quantity: 1, price_data: { currency: 'usd', unit_amount: l.price_cents, product_data: product(l) } })),
          shipping_address_collection: { allowed_countries: ['US'] },
          shipping_options: [
            { shipping_rate_data: { type: 'fixed_amount', display_name: s.shipping_label, fixed_amount: { amount: s.shipping_cents, currency: 'usd' } } },
          ],
          phone_number_collection: { enabled: true },
          expires_at: Math.floor(checkoutExpiresAt / 1000),
          client_reference_id: String(order.id),
          metadata: { order_id: String(order.id) },
          payment_intent_data: { description: `${s.shop_name} order #${order.number}`, metadata: { order_id: String(order.id) } },
          success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/bag?cancelled=${order.token}`,
        },
        `order-${order.token}`,
      );
      await store.attachSession(order.id, session.id);
      return json({ url: session.url });
    } catch (err) {
      await store.release(order.id, 'cancelled');
      console.error('checkout: Stripe refused the session', err.message);
      return json({ error: "Checkout couldn't start. Please try again in a moment." }, 502);
    }
  }

  // The buyer clicked "back" on Stripe's page: free their pieces right away.
  if (method === 'POST' && path === '/api/checkout/cancel') {
    const o = await store.getOrderByToken((await readJson(request)).token);
    if (!o || o.status !== 'pending') return json({ ok: true });
    if (!stripe || !o.stripe_session_id) {
      await store.release(o.id, 'cancelled');
      return json({ ok: true });
    }
    try {
      await stripe.expireCheckoutSession(o.stripe_session_id);
      await store.release(o.id, 'cancelled');
    } catch {
      // Already finished or expired on Stripe's side: trust what Stripe says.
      try {
        const session = await stripe.retrieveCheckoutSession(o.stripe_session_id);
        if (session.status === 'expired') await store.release(o.id, 'cancelled');
        else await store.applySession(session);
      } catch (err) {
        console.error('checkout/cancel: could not reach Stripe', err.message);
      }
    }
    return json({ ok: true });
  }

  // ---------- Studio (admin) ----------

  if (method === 'GET' && path === '/admin') return page(views.adminPage(), 200, { 'Cache-Control': 'no-store' });

  if (method === 'POST' && path === '/api/admin/login') {
    if (!adminReady) return json({ error: LOCKED }, 503);
    if (!(await store.allow(`login:${ip}`, 10, 15 * 60 * 1000))) return json({ error: 'Too many tries. Wait 15 minutes and try again.' }, 429);
    const given = await sha256(String((await readJson(request)).password || ''));
    const want = await sha256(adminPassword);
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= given[i] ^ want[i];
    if (diff !== 0) return json({ error: "That password isn't right." }, 401);
    const exp = Date.now() + ADMIN_SESSION_MS;
    return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(`${exp}.${await sign(exp)}`, ADMIN_SESSION_MS) });
  }

  if (method === 'POST' && path === '/api/admin/logout') return json({ ok: true }, 200, { 'Set-Cookie': adminCookie('', 0) });

  if (method === 'GET' && path === '/api/admin/me') {
    if (!adminReady) return json({ error: LOCKED }, 503);
    if (!(await isAdmin())) return json({ ok: false });
    return json({
      ok: true,
      payments: { connected: Boolean(stripe), mode: stripe ? stripe.mode : null, webhook: Boolean(stripe && env.STRIPE_WEBHOOK_SECRET) },
      categories: CATEGORIES,
      conditions: CONDITIONS,
    });
  }

  if (path.startsWith('/api/admin/')) {
    if (!(await isAdmin())) return json({ error: 'Please sign in again.' }, 401);
    const adminItem = (it) => ({ ...it, state: store.itemState(it), url: views.itemPath(it) });

    if (method === 'GET' && path === '/api/admin/items') {
      return json({ items: (await store.listItems()).map(adminItem), storage: await store.photoUsage() });
    }
    if (method === 'POST' && path === '/api/admin/items') return json({ item: adminItem(await store.createItem(await readJson(request))) }, 201);
    if ((m = path.match(/^\/api\/admin\/items\/(\d+)$/))) {
      if (method === 'PUT') return json({ item: adminItem(await store.updateItem(m[1], await readJson(request))) });
      if (method === 'DELETE') {
        await store.deleteItem(m[1]);
        return json({ ok: true });
      }
    }
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/items\/(\d+)\/status$/))) {
      return json({ item: adminItem(await store.setItemStatus(m[1], (await readJson(request)).status)) });
    }
    const adminOutfit = (o) => ({ ...o, items: o.items.map((it) => ({ id: it.id, title: it.title, brand: it.brand, price_cents: it.price_cents, photo: it.photos[0] || null, state: store.itemState(it) })), state: store.outfitState(o), url: views.outfitPath(o) });
    if (method === 'GET' && path === '/api/admin/outfits') return json({ outfits: (await store.listOutfits()).map(adminOutfit) });
    if (method === 'POST' && path === '/api/admin/outfits') return json({ outfit: adminOutfit(await store.createOutfit(await readJson(request))) }, 201);
    if ((m = path.match(/^\/api\/admin\/outfits\/(\d+)$/))) {
      if (method === 'PUT') return json({ outfit: adminOutfit(await store.updateOutfit(m[1], await readJson(request))) });
      if (method === 'DELETE') {
        await store.deleteOutfit(m[1]);
        return json({ ok: true });
      }
    }
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/outfits\/(\d+)\/status$/))) {
      return json({ outfit: adminOutfit(await store.setOutfitStatus(m[1], (await readJson(request)).status)) });
    }
    if (method === 'POST' && path === '/api/admin/photos') {
      if (!/^image\/(jpeg|png|webp)$/.test(request.headers.get('Content-Type') || '')) throw new HttpError(400, 'That file is not a JPG, PNG or WebP photo.');
      if (Number(request.headers.get('content-length') || 0) > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too big. Try a smaller one.');
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length) throw new HttpError(400, 'That upload was empty. Try the photo again.');
      const name = await store.savePhoto(bytes);
      return json({ name, url: views.photoUrl(name) }, 201);
    }
    if (method === 'GET' && path === '/api/admin/orders') return json({ orders: await store.listOrders(), open_checkouts: await store.openCheckouts() });
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/orders\/(\d+)\/ship$/))) {
      return json({ order: await store.shipOrder(m[1], await readJson(request)) });
    }
    if (path === '/api/admin/settings') {
      if (method === 'GET') return json({ settings: await store.getSettings() });
      if (method === 'PUT') return json({ settings: await store.saveSettings(await readJson(request)) });
    }
    return json({ error: 'Not found' }, 404);
  }

  if (method === 'GET' && (m = path.match(/^\/admin\/orders\/(\d+)\/slip$/))) {
    if (!(await isAdmin())) return redirect('/admin');
    const o = await store.getOrder(m[1]);
    if (!o || !o.shipping) return notFound();
    return page(views.slipPage(await pageCtx(), o), 200, { 'Cache-Control': 'no-store' });
  }

  if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
  return notFound();
}

export default { fetch: createHandler() };
