import { html, raw } from './html.js';
import { STATIC } from './static.generated.js';

// URL of a file from static/, with its content hash so browsers can cache it forever.
export const asset = (name) => `/static/${name}?v=${STATIC[name].hash}`;

export function money(cents) {
  const d = (cents || 0) / 100;
  return '$' + (cents % 100 === 0 ? d.toLocaleString('en-US') : d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

export function slugify(s) {
  return (
    String(s)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

export const itemPath = (it) => `/item/${it.id}-${slugify(`${it.brand} ${it.title}`)}`;
export const photoUrl = (name) => `/uploads/${name}`;
const shippingText = (s) => (s.shipping_cents > 0 ? `${money(s.shipping_cents)} flat-rate shipping` : 'Free shipping');
export const outfitPath = (o) => `/outfit/${o.id}-${slugify(o.title)}`;
// An outfit's cover: its own styled photo, or else its first piece's photo.
export const outfitCover = (o) => {
  const name = o.photos[0] || (o.items.find((it) => it.photos[0]) || { photos: [] }).photos[0];
  return name ? photoUrl(name) : null;
};
const separately = (o) => o.items.reduce((n, it) => n + it.price_cents, 0);
export const itemName = (it) => [it.brand, it.title].filter(Boolean).join(' ');

export function layout(ctx, { title, description, image, canonical, body, noindex }) {
  const s = ctx.settings;
  const fullTitle = title ? `${title} · ${s.shop_name}` : s.shop_name;
  const desc = description || s.tagline;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
${noindex ? raw('<meta name="robots" content="noindex">') : ''}
<meta property="og:site_name" content="${s.shop_name}">
<meta property="og:title" content="${title || s.shop_name}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
${canonical ? html`<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}">` : ''}
${image ? html`<meta property="og:image" content="${image}"><meta name="twitter:card" content="summary_large_image">` : ''}
<meta name="theme-color" content="#060B13">
<link rel="icon" href="${asset('favicon.svg')}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,wght@1,700&family=Manrope:wght@400;600;700&family=Rajdhani:wght@600;700&display=swap">
<link rel="stylesheet" href="${asset('shop.css')}">
<script src="${asset('shop.js')}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<p class="announce">Quality items <span aria-hidden="true">·</span> Fast shipping <span aria-hidden="true">·</span> Affordable prices</p>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="wordmark" href="/" aria-label="${s.shop_name}"><img src="${asset('logo-small.webp')}" alt="${s.shop_name}" width="160" height="73"></a>
    <nav class="site-nav" aria-label="Main">
      <a href="/">Shop</a>
      <a href="/about" class="nav-about">About</a>
      <a href="/bag" class="bag-link">Bag<span class="bag-count" data-bag-count hidden>0</span></a>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <div>
      <p class="footer-mark">${s.shop_name}</p>
      <p class="muted">${s.tagline}</p>
    </div>
    <ul class="footer-links">
      <li><a href="/about">About &amp; policies</a></li>
      ${s.instagram ? html`<li><a href="https://instagram.com/${s.instagram}" rel="noopener" target="_blank">Instagram @${s.instagram}</a></li>` : ''}
      ${s.contact_email ? html`<li><a href="mailto:${s.contact_email}">${s.contact_email}</a></li>` : ''}
      <li class="muted">Secure checkout by Stripe</li>
    </ul>
  </div>
</footer>
</body>
</html>`;
}

function badge(state) {
  if (state === 'sold') return html`<span class="badge badge-sold">Sold</span>`;
  if (state === 'hold') return html`<span class="badge">On hold</span>`;
  if (state === 'draft') return html`<span class="badge badge-draft">Draft</span>`;
  return '';
}

function placeholder(it) {
  return html`<div class="ph" aria-hidden="true"><span>${(it.brand || it.title || '?').trim().charAt(0).toUpperCase()}</span></div>`;
}

function card(ctx, it) {
  const state = ctx.state(it);
  const meta = [it.size && `Size ${it.size}`, it.condition].filter(Boolean).join(' · ');
  return html`<a class="card${state === 'sold' ? ' is-sold' : ''}" href="${itemPath(it)}">
  <div class="card-media">${it.photos[0] ? html`<img src="${photoUrl(it.photos[0])}" alt="${itemName(it)}" loading="lazy" decoding="async">` : placeholder(it)}${badge(state)}</div>
  <div class="card-body">
    ${it.brand ? html`<p class="brand">${it.brand}</p>` : ''}
    <p class="card-title">${it.title}</p>
    <p class="price">${money(it.price_cents)}${it.retail_cents > it.price_cents ? html`<s class="retail">${money(it.retail_cents)}</s>` : ''}</p>
    ${meta ? html`<p class="card-meta">${meta}</p>` : ''}
  </div>
</a>`;
}

function outfitCard(o) {
  const cover = outfitCover(o);
  const full = separately(o);
  return html`<a class="card card-outfit" href="${outfitPath(o)}">
  <div class="card-media">${cover ? html`<img src="${cover}" alt="${o.title}" loading="lazy" decoding="async">` : placeholder({ title: o.title })}<span class="badge badge-set">${o.items.length}-piece set</span></div>
  <div class="card-body">
    <p class="brand">Styled outfit</p>
    <p class="card-title">${o.title}</p>
    <p class="price">${money(o.price_cents)}${full > o.price_cents ? html`<s class="retail">${money(full)}</s>` : ''}</p>
  </div>
</a>`;
}

export function homePage(ctx, { items, sold, outfits = [], categories, brands, query, total }) {
  const s = ctx.settings;
  const href = (over) => {
    const q = { category: query.category, brand: query.brand, sort: query.sort, ...over };
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v));
    const str = p.toString();
    return str ? `/?${str}#shop` : '/#shop';
  };
  const filtered = Boolean(query.category || query.brand);
  let grid;
  if (total === 0) {
    grid = html`<div class="empty">
      <p class="empty-title">New pieces are on the way.</p>
      <p class="muted">The closet is being restocked.${s.instagram ? html` Follow <a href="https://instagram.com/${s.instagram}" rel="noopener" target="_blank">@${s.instagram}</a> to hear about drops first.` : ''}</p>
    </div>`;
  } else if (items.length === 0) {
    grid = html`<div class="empty"><p class="empty-title">Nothing here right now.</p><p><a href="/#shop">See everything in the closet</a></p></div>`;
  } else {
    grid = html`<div class="grid">${items.map((it) => card(ctx, it))}</div>`;
  }

  const body = html`
<section class="hero wrap">
  <img class="hero-logo" src="${asset('logo.webp')}" alt="${s.shop_name}" width="840" height="381">
  <h1>${s.headline || s.shop_name}</h1>
  ${s.tagline ? html`<p class="lede">${s.tagline}</p>` : ''}
  <p class="hero-cta"><a class="btn btn-primary" href="#shop">Shop now</a></p>
</section>
${outfits.length
    ? html`<section class="wrap outfit-strip" aria-labelledby="outfits-h">
  <h2 id="outfits-h" class="section-title">Styled outfits</h2>
  <p class="muted strip-note">Buy the whole look at a set price, or pick out single pieces.</p>
  <div class="grid">${outfits.map(outfitCard)}</div>
</section>`
    : ''}
<section class="wrap shop" id="shop" aria-label="Shop">
  ${total > 0
    ? html`<div class="toolbar">
    <nav class="chips" aria-label="Categories">
      <a class="chip${!query.category ? ' is-active' : ''}" href="${href({ category: '' })}">All</a>
      ${categories.map((c) => html`<a class="chip${query.category === c ? ' is-active' : ''}" href="${href({ category: c })}">${c}</a>`)}
    </nav>
    <form class="sorters" method="get" action="/#shop">
      ${query.category ? html`<input type="hidden" name="category" value="${query.category}">` : ''}
      <label class="select"><span class="sr-only">Designer</span>
        <select name="brand" data-autosubmit>
          <option value="">All designers</option>
          ${brands.map((b) => html`<option value="${b}"${query.brand === b ? raw(' selected') : ''}>${b}</option>`)}
        </select>
      </label>
      <label class="select"><span class="sr-only">Sort</span>
        <select name="sort" data-autosubmit>
          <option value="">Newest</option>
          <option value="price-asc"${query.sort === 'price-asc' ? raw(' selected') : ''}>Price: low to high</option>
          <option value="price-desc"${query.sort === 'price-desc' ? raw(' selected') : ''}>Price: high to low</option>
        </select>
      </label>
      <noscript><button class="btn btn-small" type="submit">Apply</button></noscript>
    </form>
  </div>
  <p class="result-count">${items.length} ${items.length === 1 ? 'piece' : 'pieces'}${filtered ? html` · <a href="/#shop">clear filters</a>` : ''}</p>`
    : ''}
  ${grid}
</section>
${sold.length
    ? html`<section class="wrap sold-strip" aria-labelledby="sold-h">
  <h2 id="sold-h" class="section-title">Recently sold</h2>
  <div class="grid">${sold.map((it) => card(ctx, it))}</div>
</section>`
    : ''}`;
  return layout(ctx, { body, canonical: `${ctx.baseUrl}/`, image: items[0] && items[0].photos[0] ? ctx.baseUrl + photoUrl(items[0].photos[0]) : null });
}

export function itemPage(ctx, it) {
  const s = ctx.settings;
  const state = ctx.state(it);
  const name = itemName(it);
  const specs = [
    ['Condition', it.condition],
    ['Size', it.size],
    ['Color', it.color],
    ['Category', it.category],
  ].filter(([, v]) => v);

  let action;
  if (state === 'available') {
    action = html`<button type="button" class="btn btn-primary btn-block" data-add-to-bag="${it.id}">Add to bag</button>`;
  } else if (state === 'hold') {
    action = html`<p class="notice">Someone is checking out with this piece right now. If they don't finish, it comes back within about half an hour.</p>`;
  } else if (state === 'sold') {
    action = html`<p class="notice notice-sold">This piece has sold. <a href="/#shop">See what's still available</a></p>`;
  } else {
    action = html`<p class="notice">Draft preview: only you can see this page. Make it live from the <a href="/admin">Studio</a> when you're ready.</p>`;
  }

  const photos = it.photos.length
    ? it.photos.map((p, i) => html`<figure class="gallery-slide"><img src="${photoUrl(p)}" alt="${name}, photo ${i + 1} of ${it.photos.length}" ${i === 0 ? '' : raw('loading="lazy" ')}decoding="async"></figure>`)
    : html`<figure class="gallery-slide">${placeholder(it)}</figure>`;

  const body = html`
<div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Shop</a><span aria-hidden="true">/</span><a href="/?category=${encodeURIComponent(it.category)}#shop">${it.category}</a></nav>
  <article class="product">
    <div class="gallery" data-gallery>
      <div class="gallery-track" data-gallery-track>${photos}</div>
      ${it.photos.length > 1 ? html`<p class="gallery-count" data-gallery-count>1 / ${it.photos.length}</p>` : ''}
    </div>
    <div class="details">
      ${it.brand ? html`<p class="brand brand-lg">${it.brand}</p>` : ''}
      <h1 class="product-title">${it.title}</h1>
      <p class="product-price">${money(it.price_cents)}${it.retail_cents > it.price_cents ? html`<span class="retail">Retail ${money(it.retail_cents)}</span>` : ''}${state === 'sold' ? html`<span class="badge badge-sold badge-inline">Sold</span>` : ''}</p>
      ${specs.length ? html`<dl class="specs">${specs.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
      <div class="buy">${action}</div>
      <p class="ship-note">${shippingText(s)} · ${s.shipping_label}</p>
      ${it.description ? html`<div class="description"><h2 class="mini-title">Details</h2><p>${it.description}</p></div>` : ''}
      ${s.policies ? html`<details class="policies"><summary>Authenticity, shipping &amp; returns</summary><p>${s.policies}</p></details>` : ''}
    </div>
  </article>
</div>`;
  const desc = [money(it.price_cents), it.condition, it.size && `Size ${it.size}`].filter(Boolean).join(' · ');
  return layout(ctx, {
    title: name,
    description: `${desc}. ${it.description}`.slice(0, 200),
    image: it.photos[0] ? ctx.baseUrl + photoUrl(it.photos[0]) : null,
    canonical: ctx.baseUrl + itemPath(it),
    noindex: state === 'draft',
    body,
  });
}

export function outfitPage(ctx, o, state) {
  const s = ctx.settings;
  const full = separately(o);
  const save = full - o.price_cents;
  const photoNames = [...o.photos, ...o.items.map((it) => it.photos[0]).filter(Boolean)];
  let action;
  if (state === 'available') action = html`<button type="button" class="btn btn-primary btn-block" data-add-outfit="${o.id}" data-outfit-items="${o.item_ids.join(',')}">Add outfit to bag</button>`;
  else if (state === 'sold') action = html`<p class="notice notice-sold">This outfit has sold. <a href="/#shop">See what's still available</a></p>`;
  else if (state === 'draft') action = html`<p class="notice">Draft preview: only you can see this page. Make it live from the <a href="/admin#outfits">Studio</a> when you're ready.</p>`;
  else action = html`<p class="notice">This outfit isn't available as a full set right now. Pieces still for sale are listed below.</p>`;
  const body = html`
<div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Shop</a><span aria-hidden="true">/</span><span>Styled outfits</span></nav>
  <article class="product">
    <div class="gallery" data-gallery>
      <div class="gallery-track" data-gallery-track>${photoNames.length
        ? photoNames.map((p, i) => html`<figure class="gallery-slide"><img src="${photoUrl(p)}" alt="${o.title}, photo ${i + 1} of ${photoNames.length}" ${i === 0 ? '' : raw('loading="lazy" ')}decoding="async"></figure>`)
        : html`<figure class="gallery-slide">${placeholder({ title: o.title })}</figure>`}</div>
      ${photoNames.length > 1 ? html`<p class="gallery-count" data-gallery-count>1 / ${photoNames.length}</p>` : ''}
    </div>
    <div class="details">
      <p class="brand brand-lg">Styled outfit · ${o.items.length} pieces</p>
      <h1 class="product-title">${o.title}</h1>
      <p class="product-price">${money(o.price_cents)}${save > 0 ? html`<span class="retail">${money(full)} separately · save ${money(save)}</span>` : ''}</p>
      <div class="buy">${action}</div>
      <p class="ship-note">${s.shipping_cents > 0 ? `${money(s.shipping_cents)} flat-rate shipping` : 'Free shipping'} · ${s.shipping_label}</p>
      <h2 class="mini-title pieces-h">In this outfit</h2>
      <ul class="pieces-list">
        ${o.items.map((it) => {
          const st = ctx.state(it);
          return html`<li>
          <a class="line-thumb" href="${itemPath(it)}">${it.photos[0] ? html`<img src="${photoUrl(it.photos[0])}" alt="">` : ''}</a>
          <div class="line-info">${it.brand ? html`<p class="brand">${it.brand}</p>` : ''}<p><a href="${itemPath(it)}">${it.title}</a></p>${it.size ? html`<p class="muted small">Size ${it.size}</p>` : ''}${st === 'sold' ? html`<p class="line-gone">Sold</p>` : st === 'hold' ? html`<p class="line-gone">On hold</p>` : ''}</div>
          <p class="line-price">${money(it.price_cents)}</p>
        </li>`;
        })}
      </ul>
      <p class="muted small">Want just one piece? Tap it to buy it on its own.</p>
      ${o.description ? html`<div class="description"><h2 class="mini-title">Details</h2><p>${o.description}</p></div>` : ''}
      ${s.policies ? html`<details class="policies"><summary>Authenticity, shipping &amp; returns</summary><p>${s.policies}</p></details>` : ''}
    </div>
  </article>
</div>`;
  const cover = outfitCover(o);
  return layout(ctx, {
    title: o.title,
    description: `${o.items.length}-piece outfit for ${money(o.price_cents)}. ${o.description}`.slice(0, 200),
    image: cover ? ctx.baseUrl + cover : null,
    canonical: ctx.baseUrl + outfitPath(o),
    noindex: state === 'draft',
    body,
  });
}

export function bagPage(ctx) {
  const body = html`
<section class="wrap page-narrow">
  <h1 class="page-title">Your bag</h1>
  <p class="flash" data-bag-flash role="status" hidden></p>
  <div data-bag><p class="muted">Loading your bag…</p></div>
  <noscript><p>Your bag needs JavaScript turned on in your browser.</p></noscript>
</section>`;
  return layout(ctx, { title: 'Your bag', body, noindex: true });
}

const STATUS_COPY = {
  pending: ['Waiting for payment', "We haven't received your payment yet. If you just paid, refresh this page in a minute."],
  processing: ['Payment processing', "Your payment is on its way through the bank. Your pieces are held for you, and we'll ship as soon as it clears."],
  paid: ['Order confirmed', "Your order is confirmed. It's being packed up now, and you'll get tracking as soon as it ships."],
  shipped: ['On its way', 'Your order has shipped.'],
  expired: ['Checkout not completed', 'This checkout timed out before payment, so nothing was charged.'],
  cancelled: ['Checkout cancelled', 'This checkout was cancelled, so nothing was charged.'],
  failed: ['Payment failed', "The payment didn't go through, so the order was cancelled and nothing was charged."],
};

function trackingUrl(o) {
  if (!o.tracking) return null;
  const t = encodeURIComponent(o.tracking);
  const c = (o.carrier || '').toLowerCase();
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
}

export function orderPage(ctx, o, { fresh }) {
  const s = ctx.settings;
  const [heading, copy] = STATUS_COPY[o.status] || STATUS_COPY.pending;
  const first = (o.customer_name || '').split(' ')[0];
  const done = o.status === 'paid' || o.status === 'shipped' || o.status === 'processing';
  const url = trackingUrl(o);
  const body = html`
<section class="wrap page-narrow order"${fresh && done ? html` data-clear-bag="${o.items.map((i) => i.id).join(',')}"` : ''}>
  <p class="eyebrow">Order #${o.number}</p>
  <h1 class="page-title">${o.status === 'paid' && first ? `Thank you, ${first}!` : heading}</h1>
  <p class="lede-sm">${copy}</p>
  ${o.status === 'shipped' && o.tracking ? html`<p class="tracking">${o.carrier || 'USPS'} tracking: <a href="${url}" rel="noopener" target="_blank">${o.tracking}</a></p>` : ''}
  ${done ? html`<p class="muted">Keep this page's link to check on your order. A receipt is on its way to ${o.customer_email || 'your email'}.</p>` : ''}
  <ul class="order-lines">
    ${o.items.map((i) => html`<li>
      <div class="line-thumb">${i.photo ? html`<img src="${photoUrl(i.photo)}" alt="">` : ''}</div>
      <div class="line-info">${i.brand ? html`<p class="brand">${i.brand}</p>` : ''}<p>${i.title}</p>${i.size ? html`<p class="muted small">Size ${i.size}</p>` : ''}${i.outfit ? html`<p class="muted small">Part of outfit: ${i.outfit}</p>` : ''}</div>
      <p class="line-price">${money(i.price_cents)}</p>
    </li>`)}
  </ul>
  <dl class="totals">
    <div><dt>Subtotal</dt><dd>${money(o.subtotal_cents)}</dd></div>
    <div><dt>Shipping</dt><dd>${o.shipping_cents ? money(o.shipping_cents) : 'Free'}</dd></div>
    <div class="grand"><dt>Total</dt><dd>${money(o.total_cents ?? o.subtotal_cents + o.shipping_cents)}</dd></div>
  </dl>
  ${done && o.shipping && o.shipping.city ? html`<p class="muted">Shipping to ${o.shipping.name}, ${o.shipping.city}${o.shipping.state ? `, ${o.shipping.state}` : ''}</p>` : ''}
  ${s.contact_email ? html`<p class="muted">Questions? Email <a href="mailto:${s.contact_email}?subject=${encodeURIComponent(`Order #${o.number}`)}">${s.contact_email}</a>.</p>` : ''}
  <p><a class="btn" href="/#shop">Keep shopping</a></p>
</section>`;
  return layout(ctx, { title: `Order #${o.number}`, body, noindex: true });
}

export function aboutPage(ctx) {
  const s = ctx.settings;
  const body = html`
<section class="wrap page-narrow prose">
  <p class="eyebrow">About</p>
  <h1 class="page-title">${s.shop_name}</h1>
  <p class="pre">${s.about}</p>
  ${s.policies ? html`<h2 class="section-title">Authenticity, shipping &amp; returns</h2><p class="pre">${s.policies}</p>` : ''}
  ${s.contact_email || s.instagram
    ? html`<h2 class="section-title">Say hi</h2><p>${s.contact_email ? html`Email <a href="mailto:${s.contact_email}">${s.contact_email}</a>` : ''}${s.contact_email && s.instagram ? ' or message me on ' : s.instagram ? 'Message me on ' : ''}${s.instagram ? html`<a href="https://instagram.com/${s.instagram}" rel="noopener" target="_blank">Instagram @${s.instagram}</a>` : ''}.</p>`
    : ''}
  <p><a class="btn" href="/#shop">Shop the closet</a></p>
</section>`;
  return layout(ctx, { title: 'About', body, canonical: `${ctx.baseUrl}/about` });
}

export function messagePage(ctx, { title, message, status }) {
  const body = html`
<section class="wrap page-narrow">
  <h1 class="page-title">${title}</h1>
  <p class="lede-sm">${message}</p>
  <p><a class="btn" href="/#shop">Back to the shop</a></p>
</section>`;
  return layout(ctx, { title, body, noindex: Boolean(status) });
}

export function slipPage(ctx, o) {
  const s = ctx.settings;
  const a = o.shipping || {};
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packing slip #${o.number}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Jost:wght@400;500&display=swap">
<link rel="stylesheet" href="${asset('admin.css')}">
<script src="${asset('slip.js')}" defer></script>
</head><body class="slip">
<div class="slip-actions"><button type="button" class="abtn abtn-primary" data-print>Print</button></div>
<section class="slip-label">
  <p class="slip-from">From: ${s.shop_name}</p>
  <p class="slip-to-h">Ship to</p>
  <p class="slip-to">${a.name}<br>${a.line1}${a.line2 ? html`<br>${a.line2}` : ''}<br>${a.city}, ${a.state} ${a.postal_code}${a.country && a.country !== 'US' ? html`<br>${a.country}` : ''}</p>
</section>
<section class="slip-body">
  <h1>${s.shop_name}</h1>
  <p>Order #${o.number} · ${new Date(o.paid_at || o.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
  <table><thead><tr><th>Item</th><th>Size</th><th class="num">Price</th></tr></thead><tbody>
  ${o.items.map((i) => html`<tr><td>${itemName(i)}</td><td>${i.size}</td><td class="num">${money(i.price_cents)}</td></tr>`)}
  </tbody></table>
  <p class="slip-thanks">Thank you so much for shopping my closet! ♡</p>
</section>
</body></html>`;
}


// The Studio's page shell; static/admin.js fills it in.
export function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Studio · UniqueResellzz</title>
<link rel="icon" href="${asset('favicon.svg')}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Jost:wght@400;500&display=swap">
<link rel="stylesheet" href="${asset('admin.css')}">
<script src="${asset('admin.js')}" defer></script>
</head>
<body class="studio">

<div class="login" data-login-screen hidden>
  <form class="login-card" data-login>
    <p class="login-mark" data-shop-name>UniqueResellzz</p>
    <h1>Studio</h1>
    <p class="muted">Sign in to post and manage your pieces.</p>
    <label class="field">
      <span class="field-label">Password</span>
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    <p class="form-error" data-login-error role="alert" hidden></p>
    <button class="abtn abtn-primary abtn-block" type="submit">Sign in</button>
    <a href="/" class="back-link">Back to the shop</a>
  </form>
</div>

<div class="app" data-app hidden>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="studio-mark" href="/admin"><span data-shop-name>UniqueResellzz</span> <em>Studio</em></a>
      <div class="topbar-actions">
        <a class="abtn abtn-ghost abtn-sm" href="/" target="_blank" rel="noopener">View shop</a>
        <button type="button" class="abtn abtn-ghost abtn-sm" data-logout>Sign out</button>
      </div>
    </div>
    <nav class="tabs" aria-label="Studio sections">
      <button type="button" class="tab" data-tab="items" aria-current="page">Items</button>
      <button type="button" class="tab" data-tab="outfits">Outfits</button>
      <button type="button" class="tab" data-tab="orders">Orders <span class="tab-badge" data-orders-badge hidden></span></button>
      <button type="button" class="tab" data-tab="settings">Shop settings</button>
    </nav>
  </header>
  <div class="banners" data-banners></div>
  <main class="panel" data-panel="items"></main>
  <main class="panel" data-panel="outfits" hidden></main>
  <main class="panel" data-panel="orders" hidden></main>
  <main class="panel" data-panel="settings" hidden></main>
</div>

<dialog class="editor" data-editor aria-labelledby="editor-title">
  <form class="editor-form" data-editor-form novalidate>
    <header class="editor-head">
      <h2 id="editor-title" data-editor-title>New item</h2>
      <button type="button" class="icon-btn" data-editor-close aria-label="Close">&times;</button>
    </header>
    <div class="editor-body">
      <section class="field-group">
        <p class="field-label">Photos <span class="muted">(first photo is the cover; up to 12)</span></p>
        <div class="photos" data-photos></div>
        <p class="hint">Tip: natural light, a plain background, and a close-up of the tag, logo and any wear.</p>
      </section>
      <section class="field-group" data-outfit-only hidden>
        <p class="field-label">Pieces in this outfit <span class="muted">(pick 2 or more; each can still be bought on its own)</span></p>
        <div class="pieces" data-pieces></div>
        <p class="hint" data-pieces-total></p>
      </section>
      <div class="field-row">
        <label class="field" data-item-only>
          <span class="field-label">Designer / brand</span>
          <input name="brand" list="brand-list" autocomplete="off" maxlength="60" placeholder="Gucci">
        </label>
        <label class="field">
          <span class="field-label">Title <span class="req">*</span></span>
          <input name="title" required maxlength="120" placeholder="GG Marmont small shoulder bag">
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Price <span class="req">*</span></span>
          <span class="money-input"><span>$</span><input name="price" inputmode="decimal" required placeholder="450"></span>
        </label>
        <label class="field" data-item-only>
          <span class="field-label">Original retail <span class="muted">(optional)</span></span>
          <span class="money-input"><span>$</span><input name="retail" inputmode="decimal" placeholder="1,290"></span>
        </label>
      </div>
      <div class="field-row field-row-3" data-item-only>
        <label class="field">
          <span class="field-label">Category</span>
          <select name="category" data-categories></select>
        </label>
        <label class="field">
          <span class="field-label">Condition</span>
          <select name="condition" data-conditions></select>
        </label>
        <label class="field">
          <span class="field-label">Size</span>
          <input name="size" maxlength="40" placeholder="S, 38, One size">
        </label>
      </div>
      <label class="field" data-item-only>
        <span class="field-label">Color</span>
        <input name="color" maxlength="40" placeholder="Black / gold hardware">
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <textarea name="description" rows="6" maxlength="5000" placeholder="Where it's from, measurements, what's included (dust bag, box, receipt), and any wear."></textarea>
      </label>
      <p class="form-error" data-editor-error role="alert" hidden></p>
    </div>
    <footer class="editor-foot" data-editor-foot></footer>
  </form>
</dialog>

<datalist id="brand-list"></datalist>
<div class="toast" data-toast role="status" hidden></div>
</body>
</html>
`;
}
