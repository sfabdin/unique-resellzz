// Runs the Worker in plain Node against stand-ins for Cloudflare's database (D1)
// and photo storage (KV) and a fake Stripe, so the whole shop can be tested
// offline with no accounts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.js';
import { D1Shim } from './d1-shim.js';
import { KVShim } from './kv-shim.js';
import { startMockStripe, stripeSignature } from './mock-stripe.js';

const PASSWORD = 'correct horse battery';
const WHSEC = 'whsec_test_secret';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(1)]);
const MIN = 60 * 1000;
const ORIGIN = 'https://shop.test';

let mock, handler, env, cookie;
const clock = { t: Date.UTC(2026, 10, 19, 15, 0, 0) };

before(async () => {
  mock = await startMockStripe();
  handler = createHandler({ now: () => clock.t, stripeApiBase: mock.base, checkoutsPerTenMinutes: 1000 });
  env = { DB: new D1Shim(), PHOTOS: new KVShim(), ADMIN_PASSWORD: PASSWORD, STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WHSEC };
});

after(() => mock.close());

async function call(method, url, { body, auth, raw, type, headers = {}, useEnv = env, useHandler = handler } = {}) {
  const h = new Headers(headers);
  if (auth) h.set('Cookie', cookie);
  let payload;
  if (raw) { payload = raw; h.set('Content-Type', type); }
  else if (body !== undefined) { payload = JSON.stringify(body); h.set('Content-Type', 'application/json'); }
  const res = await useHandler(new Request(ORIGIN + url, { method, headers: h, body: payload }), useEnv);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function login() {
  const r = await call('POST', '/api/admin/login', { body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
}

async function photo() {
  const r = await call('POST', '/api/admin/photos', { auth: true, raw: JPEG, type: 'image/jpeg' });
  assert.equal(r.status, 201, r.text);
  return r.json.name;
}

async function newItem(fields = {}, { live = true } = {}) {
  const body = { brand: 'Gucci', title: `Marmont bag ${Math.random().toString(36).slice(2, 7)}`, price: '450', category: 'Bags', condition: 'Excellent', photos: [await photo()], ...fields };
  if (live) body.status = 'live';
  const r = await call('POST', '/api/admin/items', { auth: true, body });
  assert.equal(r.status, 201, r.text);
  return r.json.item;
}

const itemState = async (id) => (await call('GET', `/api/bag?ids=${id}`)).json.items[0].state;
const lastSessionCall = () => mock.calls.filter((c) => c.url === '/v1/checkout/sessions').at(-1);
const tokenFrom = (params) => new URL(params.cancel_url).searchParams.get('cancelled');

async function checkout(ids) {
  const r = await call('POST', '/api/checkout', { body: { ids } });
  assert.equal(r.status, 200, r.text);
  return { sid: r.json.url.split('/').pop(), token: tokenFrom(lastSessionCall().params) };
}

function webhook(type, session, secret = WHSEC) {
  const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type, data: { object: session } });
  return call('POST', '/stripe/webhook', { raw: payload, type: 'application/json', headers: { 'Stripe-Signature': stripeSignature(payload, secret) } });
}

function freshEnv(over = {}) {
  return { DB: new D1Shim(), PHOTOS: new KVShim(), ...over };
}

// ---------------------------------------------------------------------------

test('the Studio is locked without the right password', async () => {
  assert.equal((await call('GET', '/api/admin/items')).status, 401);
  assert.deepEqual((await call('GET', '/api/admin/me')).json, { ok: false }, 'signed out: says so without an error');
  assert.equal((await call('POST', '/api/admin/login', { body: { password: 'nope' } })).status, 401);
  await login();
  assert.match(cookie, /^nc_admin=\d+\.[0-9a-f]{64}$/);
  const r = await call('POST', '/api/admin/login', { body: { password: PASSWORD } });
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  assert.equal((await call('GET', '/api/admin/items', { auth: true })).status, 200);
  const me = await call('GET', '/api/admin/me', { auth: true });
  assert.deepEqual(me.json.payments, { connected: true, mode: 'test', webhook: true });
});

test('a forged or expired admin cookie is refused', async () => {
  const forged = cookie.replace(/\.[0-9a-f]+$/, `.${'0'.repeat(64)}`);
  assert.equal((await call('GET', '/api/admin/items', { headers: { Cookie: forged } })).status, 401);
  const expired = cookie.replace(/=\d+\./, '=1000.');
  assert.equal((await call('GET', '/api/admin/items', { headers: { Cookie: expired } })).status, 401);
});

test('too many wrong passwords from one visitor are cut off', async () => {
  const e = freshEnv({ ADMIN_PASSWORD: PASSWORD });
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await call('POST', '/api/admin/login', { body: { password: 'guess' }, useEnv: e, headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  const other = await call('POST', '/api/admin/login', { body: { password: PASSWORD }, useEnv: e, headers: { 'CF-Connecting-IP': '198.51.100.1' } });
  assert.equal(other.status, 200, 'a different visitor is not blocked');
});

test('drafts stay hidden from shoppers until made live', async () => {
  const it = await newItem({ title: 'Nova check trench coat', brand: 'Burberry', category: 'Clothing' }, { live: false });
  assert.equal(it.status, 'draft');
  assert.doesNotMatch((await call('GET', '/')).text, /Nova check trench coat/);
  assert.equal((await call('GET', it.url)).status, 404, 'public cannot open a draft');
  const preview = await call('GET', it.url, { auth: true });
  assert.equal(preview.status, 200, 'admin can preview a draft');
  assert.match(preview.text, /Draft preview/);

  const live = await call('POST', `/api/admin/items/${it.id}/status`, { auth: true, body: { status: 'live' } });
  assert.equal(live.json.item.state, 'available');
  const home = await call('GET', '/');
  assert.match(home.text, /Nova check trench coat/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  const pg = await call('GET', it.url);
  assert.equal(pg.status, 200);
  assert.match(pg.text, /data-add-to-bag="\d+"/);

  await call('POST', `/api/admin/items/${it.id}/status`, { auth: true, body: { status: 'draft' } });
  assert.doesNotMatch((await call('GET', '/')).text, /Nova check trench coat/);
});

test('an item cannot go live without a photo', async () => {
  const r = await call('POST', '/api/admin/items', { auth: true, body: { title: 'No photo yet', price: '100', status: 'live' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /photo/);
});

test('item links survive a title change, and old links redirect', async () => {
  const it = await newItem({ title: 'Re-Edition 2005 bag', brand: 'Prada' });
  assert.match(it.url, /^\/item\/\d+-prada-re-edition-2005-bag$/);
  await call('PUT', `/api/admin/items/${it.id}`, { auth: true, body: { ...it, price: '900', title: 'Re-Edition 2005 nylon bag' } });
  const r = await call('GET', it.url);
  assert.equal(r.status, 301);
  assert.match(r.headers.get('location'), /prada-re-edition-2005-nylon-bag$/);
});

test('shop text is escaped, never run as code', async () => {
  await newItem({ title: '<script>alert(1)</script>', brand: '<img src=x onerror=alert(1)>' });
  const home = (await call('GET', '/')).text;
  assert.doesNotMatch(home, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(home, /<img src=x onerror/);
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('photos are stored and served back byte-for-byte', async () => {
  const bad = await call('POST', '/api/admin/photos', { auth: true, raw: new TextEncoder().encode('not an image at all'), type: 'image/jpeg' });
  assert.equal(bad.status, 400);
  const big = new Uint8Array(5_000_100);
  big.set([0xff, 0xd8, 0xff]);
  const tooBig = await call('POST', '/api/admin/photos', { auth: true, raw: big, type: 'image/jpeg' });
  assert.equal(tooBig.status, 413);
  const name = await photo();
  assert.match(name, /^[a-f0-9]{24}\.jpg$/);
  const res = await handler(new Request(`${ORIGIN}/uploads/${name}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPEG);
  assert.equal((await call('GET', '/uploads/..%2Fsecret')).status, 404);
  assert.equal((await call('POST', '/api/admin/photos', { raw: JPEG, type: 'image/jpeg' })).status, 401, 'uploads need the Studio password');
  const items = await call('GET', '/api/admin/items', { auth: true });
  assert.ok(items.json.storage.used_bytes > 0);
  assert.equal(items.json.storage.limit_bytes, 1_000_000_000);
  assert.equal(env.PHOTOS.map.size, items.json.storage.count, 'every stored file is accounted for');
});

test('photos removed from an item, or from a deleted item, are cleaned up', async () => {
  const keep = await photo();
  const drop = await photo();
  const it = await newItem({ title: 'Cleanup bag', photos: [keep, drop] });
  await call('PUT', `/api/admin/items/${it.id}`, { auth: true, body: { ...it, price: '450', photos: [keep] } });
  assert.equal((await call('GET', `/uploads/${drop}`)).status, 404);
  assert.equal((await call('GET', `/uploads/${keep}`)).status, 200);
  await call('DELETE', `/api/admin/items/${it.id}`, { auth: true });
  assert.equal((await call('GET', `/uploads/${keep}`)).status, 404);
  assert.ok(!env.PHOTOS.map.has(keep) && !env.PHOTOS.map.has(drop), 'the files themselves are gone, not just the records');
});

test('photos uploaded but never saved onto an item are swept after a day', async () => {
  const e = freshEnv({ ADMIN_PASSWORD: PASSWORD });
  const t = { now: clock.t };
  const h = createHandler({ now: () => t.now });
  const go = (method, url, opts = {}) => call(method, url, { ...opts, useEnv: e, useHandler: h });
  const r = await go('POST', '/api/admin/login', { body: { password: PASSWORD } });
  const auth = { headers: { Cookie: r.headers.get('set-cookie').split(';')[0] } };
  const up = async () => (await go('POST', '/api/admin/photos', { ...auth, raw: JPEG, type: 'image/jpeg' })).json.name;
  const orphan = await up();
  const used = await up();
  await go('POST', '/api/admin/items', { ...auth, body: { title: 'First', price: '10', photos: [used] } });
  assert.ok(e.PHOTOS.map.has(orphan), 'a fresh upload is left alone (the editor may still be open)');
  t.now += 25 * 60 * MIN;
  await go('POST', '/api/admin/items', { ...auth, body: { title: 'Second', price: '10', photos: [await up()] } });
  assert.ok(!e.PHOTOS.map.has(orphan), 'the abandoned upload is gone');
  assert.ok(e.PHOTOS.map.has(used), 'photos on items are kept');
});

test('checkout puts pieces on hold, sends the right order to Stripe, and turns a second buyer away', async () => {
  const a = await newItem({ price: '1,250', brand: 'Gucci', title: 'Horsebit 1955 bag', size: 'One size' });
  const b = await newItem({ price: '89.50', brand: 'Prada', title: 'Logo hair clip' });
  const { token } = await checkout([a.id, b.id]);
  const { params: p, headers } = lastSessionCall();
  assert.equal(headers.authorization, 'Bearer sk_test_mock');
  assert.match(headers['idempotency-key'], /^order-/);
  assert.equal(p.mode, 'payment');
  assert.equal(p['line_items[0][price_data][unit_amount]'], '125000');
  assert.equal(p['line_items[0][price_data][product_data][name]'], 'Gucci Horsebit 1955 bag');
  assert.equal(p['line_items[0][price_data][product_data][description]'], 'Size One size · Excellent');
  assert.match(p['line_items[0][price_data][product_data][images][0]'], /^https:\/\/shop\.test\/uploads\/[a-f0-9]{24}\.jpg$/);
  assert.equal(p['line_items[1][price_data][unit_amount]'], '8950');
  assert.equal(p['shipping_options[0][shipping_rate_data][fixed_amount][amount]'], '800');
  assert.equal(p['shipping_address_collection[allowed_countries][0]'], 'US');
  assert.equal(p['phone_number_collection[enabled]'], 'true');
  assert.equal(Number(p.expires_at), Math.floor((clock.t + 31 * MIN) / 1000), 'Stripe session lives 31 minutes');
  assert.equal(p.success_url, 'https://shop.test/checkout/success?session_id={CHECKOUT_SESSION_ID}');
  assert.ok(token && token.length > 20);

  assert.equal(await itemState(a.id), 'hold');
  assert.equal(await itemState(b.id), 'hold');
  const pg = await call('GET', a.url);
  assert.match(pg.text, /checking out with this piece/);
  assert.doesNotMatch(pg.text, /data-add-to-bag/);

  const second = await call('POST', '/api/checkout', { body: { ids: [a.id] } });
  assert.equal(second.status, 409);
  assert.deepEqual(second.json.unavailable, [a.id]);
});

test('if Stripe refuses the checkout, the pieces are released again', async () => {
  const it = await newItem({ title: 'Stripe down bag' });
  const e = { ...env };
  const broken = createHandler({ now: () => clock.t, stripeApiBase: 'http://127.0.0.1:9', checkoutsPerTenMinutes: 1000 });
  const r = await call('POST', '/api/checkout', { body: { ids: [it.id] }, useHandler: broken, useEnv: e });
  assert.equal(r.status, 502);
  assert.equal(await itemState(it.id), 'available');
});

test('a signed Stripe webhook marks the order paid and the pieces sold (and repeats are harmless)', async () => {
  const it = await newItem({ price: '450', title: 'Webhook bag' });
  const { sid } = await checkout([it.id]);
  const session = mock.pay(sid, { total: 45800 });
  assert.equal((await webhook('checkout.session.completed', session)).status, 200);
  assert.equal((await webhook('checkout.session.completed', session)).status, 200);

  assert.equal(await itemState(it.id), 'sold');
  const orders = (await call('GET', '/api/admin/orders', { auth: true })).json.orders.filter((o) => o.stripe_session_id === sid);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.status, 'paid');
  assert.equal(o.total_cents, 45800);
  assert.equal(o.customer_email, 'jane@example.com');
  assert.deepEqual(o.shipping, { name: 'Jane Buyer', line1: '123 Main St', line2: 'Apt 4', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' });
  assert.equal(o.note, null);
  assert.match((await call('GET', '/')).text, /Recently sold[\s\S]*Webhook bag/);
});

test('an unsigned, wrongly signed or stale webhook is rejected and changes nothing', async () => {
  const it = await newItem({ title: 'Forgery target' });
  const { sid } = await checkout([it.id]);
  const session = mock.pay(sid, { total: 45800 });
  assert.equal((await webhook('checkout.session.completed', session, 'whsec_wrong')).status, 400);
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
  assert.equal((await call('POST', '/stripe/webhook', { raw: payload, type: 'application/json' })).status, 400);
  const stale = stripeSignature(payload, WHSEC, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await call('POST', '/stripe/webhook', { raw: payload, type: 'application/json', headers: { 'Stripe-Signature': stale } })).status, 400, 'replayed old events are refused');
  assert.equal(await itemState(it.id), 'hold');
});

test('the thank-you page records the sale even if the webhook never arrives', async () => {
  const it = await newItem({ title: 'No-webhook bag' });
  const { sid } = await checkout([it.id]);
  mock.pay(sid, { total: 45800 });
  const r = await call('GET', `/checkout/success?session_id=${sid}`);
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/order\/[\w-]+\?new=1$/);
  const pg = await call('GET', loc);
  assert.match(pg.text, /Thank you, Jane!/);
  assert.match(pg.text, /data-clear-bag="\d+"/);
  assert.match(pg.text, /Austin, TX/);
  assert.doesNotMatch(pg.text, /123 Main St/, 'the public order page does not print the street address');
  assert.equal(await itemState(it.id), 'sold');
});

test('backing out of Stripe checkout frees the pieces straight away', async () => {
  const it = await newItem({ title: 'Changed my mind bag' });
  const { sid, token } = await checkout([it.id]);
  assert.equal(await itemState(it.id), 'hold');
  assert.equal((await call('POST', '/api/checkout/cancel', { body: { token } })).status, 200);
  assert.equal(mock.sessions.get(sid).status, 'expired', 'the Stripe session is closed so it cannot be paid later');
  assert.equal(await itemState(it.id), 'available');
});

test('cancel after paying keeps the sale (Stripe has the final word)', async () => {
  const it = await newItem({ title: 'Paid then back button' });
  const { sid, token } = await checkout([it.id]);
  mock.pay(sid, { total: 45800 });
  await call('POST', '/api/checkout/cancel', { body: { token } });
  assert.equal(await itemState(it.id), 'sold');
});

test('an expired-checkout webhook frees the pieces', async () => {
  const it = await newItem({ title: 'Timed out bag' });
  const { sid } = await checkout([it.id]);
  const s = mock.sessions.get(sid);
  s.status = 'expired';
  assert.equal((await webhook('checkout.session.expired', s)).status, 200);
  assert.equal(await itemState(it.id), 'available');
});

test('a hold lapses on its own after 35 minutes, even with no webhook', async () => {
  const it = await newItem({ title: 'Abandoned bag' });
  await checkout([it.id]);
  clock.t += 34 * MIN;
  assert.equal(await itemState(it.id), 'hold');
  clock.t += 2 * MIN;
  assert.equal(await itemState(it.id), 'available');
  await checkout([it.id]);
  assert.equal(await itemState(it.id), 'hold');
  clock.t += 40 * MIN;
});

test('a payment for a piece that already sold is flagged for a refund, not double-sold', async () => {
  const it = await newItem({ title: 'Contested bag' });
  const first = await checkout([it.id]);
  clock.t += 36 * MIN;
  const second = await checkout([it.id]);
  await webhook('checkout.session.completed', mock.pay(second.sid, { total: 45800 }));
  // Defensive path: the first session somehow pays too.
  await webhook('checkout.session.completed', mock.pay(first.sid, { total: 45800 }));
  const orders = (await call('GET', '/api/admin/orders', { auth: true })).json.orders;
  const o1 = orders.find((o) => o.stripe_session_id === first.sid);
  const o2 = orders.find((o) => o.stripe_session_id === second.sid);
  assert.equal(o2.note, null);
  assert.match(o1.note, /Refund needed in Stripe: Gucci Contested bag had already sold/);
  clock.t += 40 * MIN;
});

test('bank payments that are still clearing keep the hold until they settle', async () => {
  const it = await newItem({ title: 'ACH bag' });
  const { sid } = await checkout([it.id]);
  const s = mock.pay(sid, { total: 45800, async: true });
  await webhook('checkout.session.completed', s);
  clock.t += 3 * 24 * 60 * MIN;
  assert.equal(await itemState(it.id), 'hold', 'still held days later while the bank payment clears');
  s.payment_status = 'paid';
  await webhook('checkout.session.async_payment_succeeded', s);
  assert.equal(await itemState(it.id), 'sold');

  const it2 = await newItem({ title: 'ACH bounced bag' });
  const c2 = await checkout([it2.id]);
  const s2 = mock.pay(c2.sid, { total: 45800, async: true });
  await webhook('checkout.session.completed', s2);
  await webhook('checkout.session.async_payment_failed', s2);
  assert.equal(await itemState(it2.id), 'available');
});

test("marking an order shipped puts the tracking number on the buyer's order page", async () => {
  const it = await newItem({ title: 'Ship me bag' });
  const { sid } = await checkout([it.id]);
  await webhook('checkout.session.completed', mock.pay(sid, { total: 45800 }));
  const o = (await call('GET', '/api/admin/orders', { auth: true })).json.orders.find((x) => x.stripe_session_id === sid);
  const slip = await call('GET', `/admin/orders/${o.id}/slip`, { auth: true });
  assert.match(slip.text, /123 Main St/);
  assert.equal((await call('GET', `/admin/orders/${o.id}/slip`)).status, 302, 'packing slip needs the Studio password');

  const r = await call('POST', `/api/admin/orders/${o.id}/ship`, { auth: true, body: { tracking: '9400 1000 0000 0000 0000 00', carrier: 'USPS' } });
  assert.equal(r.json.order.status, 'shipped');
  assert.equal(r.json.order.tracking, '9400100000000000000000');
  const pg = await call('GET', `/order/${o.token}`);
  assert.match(pg.text, /On its way/);
  assert.match(pg.text, /tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9400100000000000000000/);
});

test('shop settings change the storefront and the shipping charged at checkout', async () => {
  const r = await call('PUT', '/api/admin/settings', { auth: true, body: { headline: 'Gently loved luxury.', shipping: '12', instagram: '@naleyahscloset' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.shipping_cents, 1200);
  assert.equal(r.json.settings.instagram, 'naleyahscloset');
  const home = (await call('GET', '/')).text;
  assert.match(home, /Gently loved luxury\./);
  assert.match(home, /instagram\.com\/naleyahscloset/);
  const it = await newItem({ title: 'Settings bag' });
  assert.match((await call('GET', it.url)).text, /\$12 flat-rate shipping/);
  await checkout([it.id]);
  assert.equal(lastSessionCall().params['shipping_options[0][shipping_rate_data][fixed_amount][amount]'], '1200');
  assert.equal((await call('PUT', '/api/admin/settings', { auth: true, body: { contact_email: 'not-an-email' } })).status, 400);
});

test('a held piece cannot be deleted, unpublished or marked sold out from under a buyer', async () => {
  const it = await newItem({ title: 'Delete guard bag' });
  await checkout([it.id]);
  assert.equal((await call('DELETE', `/api/admin/items/${it.id}`, { auth: true })).status, 409);
  assert.equal((await call('POST', `/api/admin/items/${it.id}/status`, { auth: true, body: { status: 'draft' } })).status, 409);
  assert.equal((await call('POST', `/api/admin/items/${it.id}/status`, { auth: true, body: { status: 'sold' } })).status, 409);
  clock.t += 40 * MIN;
  assert.equal((await call('DELETE', `/api/admin/items/${it.id}`, { auth: true })).status, 200);
  assert.equal((await call('GET', it.url)).status, 404);
});

test('one visitor cannot spam checkout to hold the whole closet', async () => {
  const strict = createHandler({ now: () => clock.t, stripeApiBase: mock.base });
  const e = freshEnv({ ADMIN_PASSWORD: PASSWORD, STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WHSEC });
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await call('POST', '/api/checkout', { body: { ids: [] }, useEnv: e, useHandler: strict })).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 400, 400, 400, 429]);
});

test('checkout without Stripe configured says so instead of failing', async () => {
  const e = freshEnv({ ADMIN_PASSWORD: PASSWORD });
  assert.equal((await call('POST', '/api/checkout', { body: { ids: [1] }, useEnv: e })).status, 503);
  assert.equal((await call('GET', '/api/bag?ids=1', { useEnv: e })).json.checkout_enabled, false);
  assert.match((await call('GET', '/', { useEnv: e })).text, /New pieces are on the way/);
  assert.equal((await call('POST', '/stripe/webhook', { raw: '{}', type: 'application/json', useEnv: e })).status, 503);
});

test('the Studio stays locked when no admin password is configured', async () => {
  const e = freshEnv();
  assert.equal((await call('POST', '/api/admin/login', { body: { password: '' }, useEnv: e })).status, 503);
  assert.equal((await call('GET', '/api/admin/me', { useEnv: e })).status, 503);
  const shortPw = freshEnv({ ADMIN_PASSWORD: 'short' });
  assert.equal((await call('POST', '/api/admin/login', { body: { password: 'short' }, useEnv: shortPw })).status, 503);
});

test('unknown pages get a friendly 404, unknown API calls get JSON', async () => {
  const r = await call('GET', '/nope');
  assert.equal(r.status, 404);
  assert.match(r.text, /That page isn't here|That page isn&#39;t here/);
  const a = await call('GET', '/api/nope');
  assert.equal(a.status, 404);
  assert.equal(a.json.error, 'Not found');
});

test('the busiest requests stay inside the free plan limit of 50 database queries', async () => {
  const e = freshEnv({ ADMIN_PASSWORD: PASSWORD, STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WHSEC });
  const h = createHandler({ now: () => clock.t, stripeApiBase: mock.base, checkoutsPerTenMinutes: 1000 });
  const go = (method, url, opts = {}) => call(method, url, { ...opts, useEnv: e, useHandler: h });
  const counted = async (fn) => { const before = e.DB.queries; await fn(); return e.DB.queries - before; };
  const r = await go('POST', '/api/admin/login', { body: { password: PASSWORD } });
  const auth = { headers: { Cookie: r.headers.get('set-cookie').split(';')[0] } };
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const photos = [];
    for (let k = 0; k < 12; k++) photos.push((await go('POST', '/api/admin/photos', { ...auth, raw: JPEG, type: 'image/jpeg' })).json.name);
    ids.push((await go('POST', '/api/admin/items', { ...auth, body: { title: `Max ${i}`, price: '100', photos, status: 'live' } })).json.item.id);
  }
  const worst = {
    home: await counted(() => go('GET', '/')),
    bag: await counted(() => go('GET', `/api/bag?ids=${ids.join(',')}`)),
    checkout: await counted(() => go('POST', '/api/checkout', { body: { ids } })),
  };
  const sid = [...mock.sessions.keys()].at(-1);
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: mock.pay(sid, { total: 100800 }) } });
  worst.webhook = await counted(() => go('POST', '/stripe/webhook', { raw: payload, type: 'application/json', headers: { 'Stripe-Signature': stripeSignature(payload, WHSEC) } }));
  worst.deleteItemWith12Photos = await counted(() => go('DELETE', `/api/admin/items/${ids[0]}`, auth));
  // A cold start adds 7 schema statements on top, so 40 keeps a margin under 50.
  for (const [k, n] of Object.entries(worst)) assert.ok(n <= 40, `${k} used ${n} queries`);
  if (process.env.SHOW_QUERIES) console.log(worst);
});

test('styles and scripts are served by the site itself, cached by content hash', async () => {
  const home = (await call('GET', '/')).text;
  const css = home.match(/href="(\/static\/shop\.css\?v=[0-9a-f]{10})"/);
  const js = home.match(/src="(\/static\/shop\.js\?v=[0-9a-f]{10})"/);
  assert.ok(css && js, 'pages link versioned static files');
  const r = await call('GET', css[1]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.text, /--serif/);
  const again = await call('GET', css[1], { headers: { 'If-None-Match': r.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.doesNotMatch((await call('GET', '/static/shop.css?v=stale')).headers.get('cache-control'), /immutable/, 'an old version link is not cached forever');
  assert.match((await call('GET', js[1])).headers.get('content-type'), /^text\/javascript/);
  const admin = (await call('GET', '/admin')).text;
  for (const m of admin.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)) assert.equal((await call('GET', m[1])).status, 200, m[1]);
  assert.equal((await call('GET', '/static/nope.css')).status, 404);
  assert.equal((await call('GET', '/static/__proto__')).status, 404);
  const fresh = { DB: null, PHOTOS: null };
  assert.equal((await call('GET', css[1], { useEnv: fresh })).status, 200, 'static files do not touch the database');
});

test('robots.txt keeps search engines out of the Studio, bag and orders', async () => {
  const r = await call('GET', '/robots.txt');
  assert.equal(r.status, 200);
  assert.match(r.text, /Disallow: \/admin/);
  assert.match(r.text, /Disallow: \/order\//);
  assert.doesNotMatch(r.text, /Disallow: \/\n/, 'the shop itself stays visible');
});

test('HEAD requests (link previews, uptime checks) get the same answer as GET', async () => {
  assert.equal((await call('HEAD', '/')).status, 200);
  assert.equal((await call('HEAD', '/about')).status, 200);
  assert.equal((await call('HEAD', '/nope')).status, 404);
});

test("a deleted item's number is never reused (old links and saved bags can't point at a different piece)", async () => {
  const e = freshEnv({ ADMIN_PASSWORD: PASSWORD });
  const go = (method, url, opts = {}) => call(method, url, { ...opts, useEnv: e });
  const r = await go('POST', '/api/admin/login', { body: { password: PASSWORD } });
  const auth = { headers: { Cookie: r.headers.get('set-cookie').split(';')[0] } };
  const make = async (title) => (await go('POST', '/api/admin/items', { ...auth, body: { title, price: '10' } })).json.item;
  const first = await make('First');
  await go('DELETE', `/api/admin/items/${first.id}`, auth);
  const second = await make('Second');
  assert.notEqual(second.id, first.id);
  assert.equal((await go('GET', first.url, auth)).status, 404, 'the old link is dead, not redirected to the new piece');
});
