// What the shop saves:
//   - items, orders and settings live in a Cloudflare D1 (SQLite) database
//   - photo files live in Cloudflare KV (the database keeps only their name and size)
//
// D1 can't hold a transaction open across awaits, so every change that must be
// all-or-nothing is either one conditional UPDATE or one db.batch() (which D1
// runs as a single transaction).

// Every piece is one of a kind, so a checkout puts the items "on hold" for the
// buyer. The Stripe session lives 31 minutes; the hold outlives it by a few
// minutes so a payment can never land after the hold has lapsed.
export const CHECKOUT_MS = 31 * 60 * 1000;
export const HOLD_MS = 35 * 60 * 1000;
// Bank-transfer style payments can take days to clear. Keep those items held.
const PROCESSING_HOLD_MS = 10 * 24 * 60 * 60 * 1000;

export const CATEGORIES = ['Bags', 'Clothing', 'Shoes', 'Accessories', 'Jewelry', 'Other'];
export const CONDITIONS = ['New with tags', 'New without tags', 'Like new', 'Excellent', 'Very good', 'Good', 'Fair'];
export const PHOTO_NAME = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
export const MAX_PHOTO_BYTES = 5_000_000; // the Studio shrinks photos to a few hundred KB before upload
export const PHOTO_STORAGE_BYTES = 1000 * 1000 * 1000; // KV free plan: 1 GB
const SWEEP_BATCH = 40; // KV deletes per request, kept well under the free plan's per-request limits
const MAX_PHOTOS = 12;
const PHOTO_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export const DEFAULT_SETTINGS = {
  shop_name: 'UniqueResellzz',
  headline: 'Quality items. Fast shipping. Affordable prices.',
  tagline: 'Designer pieces from Burberry, Prada, Gucci and more, plus styled outfits. Every item checked, photographed and packed by hand.',
  about:
    "Welcome to UniqueResellzz: designer pieces and styled outfits at prices that make sense.\n\n" +
    'Every item is photographed by me, described honestly (flaws included), and packed by hand. ' +
    "If you'd like more photos or measurements before you buy, just ask.",
  policies:
    'Authenticity: every piece is authentic.\n' +
    'Condition: described honestly, and any wear is shown in the photos.\n' +
    'Shipping: orders ship within 2 business days by USPS, with tracking.\n' +
    'Returns: because every item is one of a kind, all sales are final. Please ask any questions before you buy.',
  contact_email: '',
  instagram: '',
  shipping_cents: 800,
  shipping_label: 'USPS Priority Mail',
};

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const HOLD_MESSAGE = 'Someone is checking out with this piece right now. Try again in half an hour.';

const SCHEMA = [
  // AUTOINCREMENT: a deleted item's number is never reused, so old links and saved bags can't point at a different piece.
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    size TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    retail_cents INTEGER,
    description TEXT NOT NULL DEFAULT '',
    photos TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'sold')),
    reserved_order_id INTEGER,
    reserved_until INTEGER,
    sold_order_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER,
    sold_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'paid', 'shipped', 'expired', 'cancelled', 'failed')),
    stripe_session_id TEXT UNIQUE,
    items TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    total_cents INTEGER,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    shipping TEXT,
    carrier TEXT NOT NULL DEFAULT '',
    tracking TEXT NOT NULL DEFAULT '',
    note TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    paid_at INTEGER,
    shipped_at INTEGER
  )`,
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS photos (name TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS hits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS items_status ON items (status)',
  'CREATE INDEX IF NOT EXISTS orders_status ON orders (status)',
];

const schemaReady = new WeakMap();
export function ensureSchema(db) {
  let p = schemaReady.get(db);
  if (!p) {
    p = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((err) => {
      schemaReady.delete(db);
      throw err;
    });
    schemaReady.set(db, p);
  }
  return p;
}

function toCents(v, field, required) {
  if (v === '' || v == null) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, `${field} must be a dollar amount.`);
  return Math.round(n * 100);
}

export function randomHex(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param db   D1 database binding
 * @param kv   KV namespace binding that holds the photo files
 * @param now  clock (tests move it)
 */
export function createStore(db, kv, now = () => Date.now()) {
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  const one = (sql, ...args) => q(sql, ...args).first();
  const all = async (sql, ...args) => (await q(sql, ...args).all()).results;
  const run = (sql, ...args) => q(sql, ...args).run();
  const marks = (n) => Array(n).fill('?').join(',');

  // ---------- settings ----------

  async function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of await all("SELECT key, value FROM settings WHERE substr(key, 1, 1) != '_'")) {
      if (row.key in DEFAULT_SETTINGS) out[row.key] = typeof DEFAULT_SETTINGS[row.key] === 'number' ? Number(row.value) : row.value;
    }
    return out;
  }

  async function saveSettings(body) {
    const s = await getSettings();
    const str = (k, max) => (body[k] === undefined ? s[k] : String(body[k]).trim().slice(0, max));
    const next = {
      shop_name: str('shop_name', 60) || DEFAULT_SETTINGS.shop_name,
      headline: str('headline', 120),
      tagline: str('tagline', 240),
      about: str('about', 4000),
      policies: str('policies', 4000),
      contact_email: str('contact_email', 120),
      instagram: str('instagram', 60).replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/, ''),
      shipping_label: str('shipping_label', 60) || DEFAULT_SETTINGS.shipping_label,
      shipping_cents: body.shipping === undefined ? s.shipping_cents : toCents(body.shipping, 'Shipping', true),
    };
    if (next.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.contact_email)) {
      throw new HttpError(400, 'That contact email does not look right.');
    }
    if (next.instagram && !/^[A-Za-z0-9._]{1,30}$/.test(next.instagram)) {
      throw new HttpError(400, 'Instagram should be just the handle, like naleyahscloset.');
    }
    if (next.shipping_cents > 10000) throw new HttpError(400, 'Shipping looks too high. Enter it in dollars, like 8.');
    await db.batch(
      Object.entries(next).map(([k, v]) => q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v))),
    );
    return getSettings();
  }

  async function secret(key) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, randomHex(32));
    return (await one('SELECT value FROM settings WHERE key = ?', key)).value;
  }

  // Counts hits per key in a time window; true while under the limit.
  async function allow(key, max, windowMs) {
    const t = Date.now();
    const row = await one(
      `INSERT INTO hits (key, n, reset) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN reset < ?3 THEN 1 ELSE n + 1 END,
         reset = CASE WHEN reset < ?3 THEN ?2 ELSE reset END
       RETURNING n`,
      key, t + windowMs, t,
    );
    if (row.n === 1) await run('DELETE FROM hits WHERE reset < ?', t);
    return row.n <= max;
  }

  // ---------- items ----------

  const rowToItem = (row) => (row ? { ...row, photos: JSON.parse(row.photos) } : null);

  function itemState(it, t = now()) {
    if (it.status === 'sold') return 'sold';
    if (it.status === 'draft') return 'draft';
    if (it.reserved_until && it.reserved_until > t) return 'hold';
    return 'available';
  }

  const getItem = async (id) => rowToItem(await one('SELECT * FROM items WHERE id = ?', Number(id) || 0));

  async function listItems({ statuses } = {}) {
    const rows = statuses
      ? await all(`SELECT * FROM items WHERE status IN (${marks(statuses.length)}) ORDER BY COALESCE(published_at, created_at) DESC, id DESC`, ...statuses)
      : await all('SELECT * FROM items ORDER BY updated_at DESC, id DESC');
    return rows.map(rowToItem);
  }

  async function cleanItem(body) {
    const str = (k, max) => String(body[k] ?? '').trim().slice(0, max);
    const title = str('title', 120);
    if (!title) throw new HttpError(400, 'Give the item a title.');
    const price_cents = toCents(body.price, 'Price', true);
    if (price_cents < 100) throw new HttpError(400, 'Price must be at least $1.');
    const retail_cents = toCents(body.retail, 'Original retail price', false);
    const photos = [...new Set(Array.isArray(body.photos) ? body.photos.map(String) : [])];
    if (photos.length > MAX_PHOTOS) throw new HttpError(400, `Up to ${MAX_PHOTOS} photos per item.`);
    if (photos.some((p) => !PHOTO_NAME.test(p))) throw new HttpError(400, 'One of the photos is missing. Try adding it again.');
    if (photos.length) {
      const found = await all(`SELECT name FROM photos WHERE name IN (${marks(photos.length)})`, ...photos);
      if (found.length !== photos.length) throw new HttpError(400, 'One of the photos is missing. Try adding it again.');
    }
    return {
      title,
      brand: str('brand', 60),
      category: CATEGORIES.includes(body.category) ? body.category : 'Other',
      size: str('size', 40),
      color: str('color', 40),
      condition: CONDITIONS.includes(body.condition) ? body.condition : '',
      price_cents,
      retail_cents: retail_cents && retail_cents > 0 ? retail_cents : null,
      description: str('description', 5000),
      photos,
    };
  }

  async function createItem(body) {
    const f = await cleanItem(body);
    const t = now();
    const r = await run(
      `INSERT INTO items (title, brand, category, size, color, condition, price_cents, retail_cents, description, photos, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      f.title, f.brand, f.category, f.size, f.color, f.condition, f.price_cents, f.retail_cents, f.description, JSON.stringify(f.photos), t, t,
    );
    const id = r.meta.last_row_id;
    if (body.status === 'live') await setItemStatus(id, 'live');
    await sweepPhotos();
    return getItem(id);
  }

  async function updateItem(id, body) {
    const it = await getItem(id);
    if (!it) throw new HttpError(404, 'That item no longer exists.');
    const f = await cleanItem(body);
    if (it.status === 'live' && f.photos.length === 0) throw new HttpError(400, 'A live item needs at least one photo.');
    await run(
      `UPDATE items SET title = ?, brand = ?, category = ?, size = ?, color = ?, condition = ?, price_cents = ?, retail_cents = ?,
       description = ?, photos = ?, updated_at = ? WHERE id = ?`,
      f.title, f.brand, f.category, f.size, f.color, f.condition, f.price_cents, f.retail_cents, f.description, JSON.stringify(f.photos), now(), it.id,
    );
    if (body.status === 'live' && it.status === 'draft') await setItemStatus(it.id, 'live');
    await dropUnusedPhotos(it.photos.filter((p) => !f.photos.includes(p)));
    return getItem(it.id);
  }

  async function setItemStatus(id, status) {
    const it = await getItem(id);
    if (!it) throw new HttpError(404, 'That item no longer exists.');
    const t = now();
    let r;
    if (status === 'live') {
      if (it.photos.length === 0) throw new HttpError(400, 'Add at least one photo before making it live.');
      r = await run("UPDATE items SET status = 'live', published_at = COALESCE(published_at, ?), sold_order_id = NULL, sold_at = NULL, updated_at = ? WHERE id = ?", t, t, it.id);
    } else if (status === 'draft') {
      r = await run("UPDATE items SET status = 'draft', updated_at = ? WHERE id = ? AND (reserved_until IS NULL OR reserved_until <= ?)", t, it.id, t);
    } else if (status === 'sold') {
      r = await run(
        "UPDATE items SET status = 'sold', sold_at = ?, reserved_order_id = NULL, reserved_until = NULL, updated_at = ? WHERE id = ? AND (reserved_until IS NULL OR reserved_until <= ?)",
        t, t, it.id, t,
      );
    } else {
      throw new HttpError(400, 'Unknown status.');
    }
    if (r.meta.changes === 0) throw new HttpError(409, HOLD_MESSAGE);
    return getItem(it.id);
  }

  async function deleteItem(id) {
    const it = await getItem(id);
    if (!it) return;
    const r = await run('DELETE FROM items WHERE id = ? AND (reserved_until IS NULL OR reserved_until <= ?)', it.id, now());
    if (r.meta.changes === 0) throw new HttpError(409, HOLD_MESSAGE);
    await dropUnusedPhotos(it.photos);
  }

  // ---------- photos ----------

  async function savePhoto(bytes) {
    let ext = null;
    const b = bytes;
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ext = 'jpg';
    else if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ext = 'png';
    else if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') ext = 'webp';
    if (!ext) throw new HttpError(400, 'That file is not a JPG, PNG or WebP photo.');
    if (b.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too big. Try a smaller one.');
    const name = `${randomHex(12)}.${ext}`;
    await kv.put(name, b, { metadata: { type: PHOTO_TYPES[ext] } });
    await run('INSERT INTO photos (name, type, size, created_at) VALUES (?, ?, ?, ?)', name, PHOTO_TYPES[ext], b.length, now());
    return name;
  }

  // Streams the file straight from KV. Photo names never change, so KV may
  // keep its edge copy for a day.
  async function getPhoto(name) {
    const { value, metadata } = await kv.getWithMetadata(name, { type: 'stream', cacheTtl: 86400 });
    if (!value) return null;
    return { type: (metadata && metadata.type) || PHOTO_TYPES[name.split('.').pop()], body: value };
  }

  async function photoUsage() {
    const row = await one('SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS count FROM photos');
    return { used_bytes: row.used, count: row.count, limit_bytes: PHOTO_STORAGE_BYTES };
  }

  const UNUSED = `NOT EXISTS (SELECT 1 FROM items WHERE instr(items.photos, photos.name) > 0)
       AND NOT EXISTS (SELECT 1 FROM orders WHERE instr(orders.items, photos.name) > 0)`;

  // Delete the given photos unless an item or a past order still shows them.
  async function dropUnusedPhotos(names) {
    if (!names.length) return;
    const gone = await all(`DELETE FROM photos WHERE name IN (${marks(names.length)}) AND ${UNUSED} RETURNING name`, ...names);
    await Promise.all(gone.map((r) => kv.delete(r.name)));
  }

  // About once a day, clear photos that were uploaded but never saved onto an item.
  async function sweepPhotos() {
    const t = now();
    const day = 24 * 60 * 60 * 1000;
    const last = await one("SELECT value FROM settings WHERE key = '_photo_sweep'");
    if (last && Number(last.value) > t - day) return;
    const gone = await all(
      `DELETE FROM photos WHERE name IN (SELECT name FROM photos WHERE created_at < ? AND ${UNUSED} LIMIT ${SWEEP_BATCH}) RETURNING name`,
      t - day,
    );
    await Promise.all(gone.map((r) => kv.delete(r.name)));
    // A full batch means there may be more: leave the clock alone so the next save continues.
    if (gone.length < SWEEP_BATCH) {
      await run("INSERT INTO settings (key, value) VALUES ('_photo_sweep', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(t));
    }
  }

  // ---------- orders ----------

  const rowToOrder = (row) => (row ? { ...row, items: JSON.parse(row.items), shipping: row.shipping ? JSON.parse(row.shipping) : null, number: 1000 + row.id } : null);
  const getOrder = async (id) => rowToOrder(await one('SELECT * FROM orders WHERE id = ?', Number(id) || 0));
  const getOrderByToken = async (token) => rowToOrder(await one('SELECT * FROM orders WHERE token = ?', String(token || '')));
  const getOrderBySession = async (sid) => rowToOrder(await one('SELECT * FROM orders WHERE stripe_session_id = ?', String(sid || '')));

  // Put the requested items on hold and open a pending order for them.
  async function reserve(ids) {
    const settings = await getSettings();
    const t = now();
    const found = new Map((await all(`SELECT * FROM items WHERE id IN (${marks(ids.length)})`, ...ids)).map((r) => [r.id, rowToItem(r)]));
    const unavailable = ids.filter((id) => !found.get(id) || itemState(found.get(id), t) !== 'available');
    if (unavailable.length) throw new HttpError(409, 'Some pieces in your bag were just taken.', { unavailable });
    const items = ids.map((id) => found.get(id));
    const snapshot = items.map((it) => ({
      id: it.id, title: it.title, brand: it.brand, size: it.size, condition: it.condition, price_cents: it.price_cents, photo: it.photos[0] || null,
    }));
    const subtotal = items.reduce((sum, it) => sum + it.price_cents, 0);
    const r = await run(
      "INSERT INTO orders (token, status, items, subtotal_cents, shipping_cents, created_at, expires_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)",
      randomToken(), JSON.stringify(snapshot), subtotal, settings.shipping_cents, t, t + HOLD_MS,
    );
    const orderId = r.meta.last_row_id;
    // Each hold only lands if the piece is still free, so two buyers can never both get it.
    const held = await db.batch(
      items.map((it) => q("UPDATE items SET reserved_order_id = ?, reserved_until = ? WHERE id = ? AND status = 'live' AND (reserved_until IS NULL OR reserved_until <= ?)", orderId, t + HOLD_MS, it.id, t)),
    );
    const lost = items.filter((it, i) => held[i].meta.changes !== 1).map((it) => it.id);
    if (lost.length) {
      await release(orderId, 'cancelled');
      throw new HttpError(409, 'Some pieces in your bag were just taken.', { unavailable: lost });
    }
    return { order: await getOrder(orderId), items, checkoutExpiresAt: t + CHECKOUT_MS };
  }

  const attachSession = (orderId, sessionId) => run('UPDATE orders SET stripe_session_id = ? WHERE id = ?', sessionId, orderId);

  async function release(orderId, status = 'expired') {
    await db.batch([
      q("UPDATE orders SET status = ? WHERE id = ? AND status IN ('pending', 'processing')", status, orderId),
      q("UPDATE items SET reserved_order_id = NULL, reserved_until = NULL WHERE reserved_order_id = ? AND status != 'sold'", orderId),
    ]);
    return getOrder(orderId);
  }

  async function orderForSession(session) {
    return (await getOrderBySession(session.id)) || (session.metadata && session.metadata.order_id ? getOrder(session.metadata.order_id) : null);
  }

  function customerFields(session) {
    const cd = session.customer_details || {};
    const sd = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || null;
    const a = (sd && sd.address) || cd.address || {};
    return {
      name: cd.name || (sd && sd.name) || '',
      email: cd.email || '',
      phone: cd.phone || '',
      shipping: {
        name: (sd && sd.name) || cd.name || '',
        line1: a.line1 || '', line2: a.line2 || '', city: a.city || '', state: a.state || '', postal_code: a.postal_code || '', country: a.country || '',
      },
    };
  }

  // Apply a Stripe Checkout Session we trust (signed webhook, or fetched from
  // Stripe's API). Safe to call any number of times for the same session.
  async function applySession(session) {
    const order = await orderForSession(session);
    if (!order) return null;
    if (order.status === 'paid' || order.status === 'shipped') return order;
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    const c = customerFields(session);

    if (!paid && session.status === 'complete') {
      // Payment submitted but still clearing (e.g. a bank debit). Keep the hold.
      if (order.status === 'pending') {
        const until = now() + PROCESSING_HOLD_MS;
        await db.batch([
          q(`UPDATE orders SET status = 'processing', stripe_session_id = COALESCE(stripe_session_id, ?), customer_name = ?, customer_email = ?,
             customer_phone = ?, shipping = ?, expires_at = ? WHERE id = ? AND status = 'pending'`,
            session.id, c.name, c.email, c.phone, JSON.stringify(c.shipping), until, order.id),
          q('UPDATE items SET reserved_until = ? WHERE reserved_order_id = ?', until, order.id),
        ]);
      }
      return getOrder(order.id);
    }
    if (!paid) return order;

    const t = now();
    const sold = await db.batch(
      order.items.map((s) => q("UPDATE items SET status = 'sold', sold_order_id = ?, sold_at = ?, reserved_order_id = NULL, reserved_until = NULL, updated_at = ? WHERE id = ? AND status != 'sold'", order.id, t, t, s.id)),
    );
    const problems = [];
    for (let i = 0; i < order.items.length; i++) {
      if (sold[i].meta.changes === 1) continue;
      const s = order.items[i];
      const it = await getItem(s.id);
      const label = [s.brand, s.title].filter(Boolean).join(' ');
      if (!it) problems.push(`${label} was deleted from the shop`);
      else if (it.sold_order_id !== order.id) problems.push(`${label} had already sold`);
    }
    const shippingCents = session.shipping_cost && Number.isFinite(session.shipping_cost.amount_total) ? session.shipping_cost.amount_total : order.shipping_cents;
    const total = Number.isFinite(session.amount_total) ? session.amount_total : order.subtotal_cents + shippingCents;
    const note = problems.length ? `Refund needed in Stripe: ${problems.join('; ')}.` : null;
    await run(
      `UPDATE orders SET status = 'paid', stripe_session_id = COALESCE(stripe_session_id, ?), customer_name = ?, customer_email = ?, customer_phone = ?,
       shipping = ?, shipping_cents = ?, total_cents = ?, paid_at = ?, note = ? WHERE id = ? AND status NOT IN ('paid', 'shipped')`,
      session.id, c.name, c.email, c.phone, JSON.stringify(c.shipping), shippingCents, total, t, note, order.id,
    );
    return getOrder(order.id);
  }

  async function listOrders() {
    // Checkouts nobody finished: close them out once their hold has lapsed.
    await run("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", now());
    return (await all("SELECT * FROM orders WHERE status IN ('paid', 'shipped', 'processing') ORDER BY id DESC")).map(rowToOrder);
  }

  const openCheckouts = async () => (await one("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending' AND expires_at > ?", now())).n;

  async function shipOrder(id, body) {
    const o = await getOrder(id);
    if (!o) throw new HttpError(404, 'That order no longer exists.');
    if (o.status !== 'paid' && o.status !== 'shipped') throw new HttpError(409, 'Only paid orders can be marked shipped.');
    if (body.shipped === false) {
      await run("UPDATE orders SET status = 'paid', shipped_at = NULL WHERE id = ?", o.id);
    } else {
      const tracking = String(body.tracking ?? '').replace(/\s+/g, '').slice(0, 60);
      const carrier = String(body.carrier ?? 'USPS').trim().slice(0, 30) || 'USPS';
      await run("UPDATE orders SET status = 'shipped', carrier = ?, tracking = ?, shipped_at = COALESCE(shipped_at, ?) WHERE id = ?", carrier, tracking, now(), o.id);
    }
    return getOrder(o.id);
  }

  return {
    now, getSettings, saveSettings, secret, allow,
    itemState, getItem, listItems, createItem, updateItem, setItemStatus, deleteItem,
    savePhoto, getPhoto, photoUsage,
    getOrder, getOrderByToken, getOrderBySession, reserve, attachSession, release, applySession, listOrders, openCheckouts, shipOrder,
  };
}
