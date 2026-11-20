// UniqueResellzz: shopper-side behaviour (bag, gallery, filters, checkout).
(function () {
  'use strict';

  var KEY = 'nc_bag';

  function readBag() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (n) { return n > 0; }) : [];
    } catch (e) { return []; }
  }
  function writeBag(ids) {
    var uniq = [];
    ids.forEach(function (id) { id = Number(id); if (id > 0 && uniq.indexOf(id) < 0) uniq.push(id); });
    try { localStorage.setItem(KEY, JSON.stringify(uniq.slice(0, 10))); } catch (e) { /* private mode */ }
    updateCount();
    return uniq;
  }
  var OUTFIT_KEY = 'nc_outfits';
  function readOutfits() {
    try {
      var v = JSON.parse(localStorage.getItem(OUTFIT_KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (n) { return n > 0; }) : [];
    } catch (e) { return []; }
  }
  function writeOutfits(ids) {
    var uniq = [];
    ids.forEach(function (id) { id = Number(id); if (id > 0 && uniq.indexOf(id) < 0) uniq.push(id); });
    try { localStorage.setItem(OUTFIT_KEY, JSON.stringify(uniq.slice(0, 5))); } catch (e) { /* private mode */ }
    updateCount();
    return uniq;
  }
  function updateCount() {
    var n = readBag().length + readOutfits().length;
    document.querySelectorAll('[data-bag-count]').forEach(function (el) {
      el.textContent = String(n);
      el.hidden = n === 0;
    });
  }

  var money = function (cents) {
    var whole = cents % 100 === 0;
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ---------- add to bag ----------

  function markAdded(btn) {
    btn.classList.add('is-added');
    btn.textContent = 'In your bag · View bag';
    btn.dataset.added = '1';
  }
  document.querySelectorAll('[data-add-to-bag]').forEach(function (btn) {
    var id = Number(btn.getAttribute('data-add-to-bag'));
    if (readBag().indexOf(id) >= 0) markAdded(btn);
    btn.addEventListener('click', function () {
      if (btn.dataset.added) { location.href = '/bag'; return; }
      var bag = readBag();
      if (bag.length >= 10) { alert('Your bag holds up to 10 pieces at a time.'); return; }
      bag.push(id);
      writeBag(bag);
      markAdded(btn);
    });
  });

  // ---------- add an outfit (the whole set) ----------

  document.querySelectorAll('[data-add-outfit]').forEach(function (btn) {
    var id = Number(btn.getAttribute('data-add-outfit'));
    var pieceIds = btn.getAttribute('data-outfit-items').split(',').map(Number);
    if (readOutfits().indexOf(id) >= 0) markAdded(btn);
    btn.addEventListener('click', function () {
      if (btn.dataset.added) { location.href = '/bag'; return; }
      // The set replaces any of its pieces already in the bag one by one.
      writeBag(readBag().filter(function (x) { return pieceIds.indexOf(x) < 0; }));
      writeOutfits(readOutfits().concat([id]));
      markAdded(btn);
    });
  });

  // ---------- gallery counter (phones) ----------

  document.querySelectorAll('[data-gallery]').forEach(function (g) {
    var track = g.querySelector('[data-gallery-track]');
    var count = g.querySelector('[data-gallery-count]');
    if (!track || !count) return;
    var total = track.children.length;
    track.addEventListener('scroll', function () {
      var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      count.textContent = Math.min(total, i + 1) + ' / ' + total;
    }, { passive: true });
  });

  // ---------- filters ----------

  document.querySelectorAll('[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form.submit(); });
  });

  // ---------- order page: clear purchased pieces from the bag ----------

  var bought = document.querySelector('[data-clear-bag]');
  if (bought) {
    var ids = bought.getAttribute('data-clear-bag').split(',').map(Number);
    writeBag(readBag().filter(function (id) { return ids.indexOf(id) < 0; }));
    writeOutfits([]);
  }

  // ---------- bag page ----------

  var bagEl = document.querySelector('[data-bag]');
  var flash = document.querySelector('[data-bag-flash]');
  function say(msg) {
    if (!flash) return;
    flash.textContent = msg;
    flash.hidden = !msg;
  }

  function renderBag(data) {
    var outfits = data.outfits || [];
    // A piece that is already in the bag as part of an outfit is not listed twice.
    var inSets = [];
    outfits.forEach(function (o) { if (o.state === 'available') inSets = inSets.concat(o.item_ids); });
    var items = data.items.filter(function (it) { return inSets.indexOf(it.id) < 0; });
    // Drop pieces and outfits that were unpublished or deleted.
    var known = items.map(function (it) { return it.id; });
    if (known.length !== readBag().length) writeBag(known);
    var knownOutfits = outfits.map(function (o) { return o.id; });
    if (knownOutfits.length !== readOutfits().length) writeOutfits(knownOutfits);

    if (!items.length && !outfits.length) {
      bagEl.innerHTML = '<p class="lede-sm">Your bag is empty.</p><p><a class="btn" href="/#shop">Shop now</a></p>';
      return;
    }
    var buyable = items.filter(function (it) { return it.state === 'available'; });
    var buyableOutfits = outfits.filter(function (o) { return o.state === 'available'; });
    var subtotal = buyable.reduce(function (n, it) { return n + it.price_cents; }, 0) +
      buyableOutfits.reduce(function (n, o) { return n + o.price_cents; }, 0);
    var lines = outfits.map(function (o) {
      var gone = o.state !== 'available';
      return '<li class="' + (gone ? 'is-gone' : '') + '">' +
        '<a class="line-thumb" href="' + esc(o.url) + '">' + (o.photo ? '<img src="' + esc(o.photo) + '" alt="">' : '') + '</a>' +
        '<div class="line-info">' +
          '<p class="brand">Styled outfit · ' + o.pieces.length + ' pieces</p>' +
          '<p><a href="' + esc(o.url) + '">' + esc(o.title) + '</a></p>' +
          '<p class="set-pieces">' + esc(o.pieces.join(', ')) + '</p>' +
          (gone ? '<p class="line-gone">This outfit is no longer available as a full set. Open it to buy the pieces that are left.</p>' : '') +
          '<button type="button" class="line-remove" data-remove-outfit="' + o.id + '">Remove</button>' +
        '</div>' +
        '<p class="line-price">' + money(o.price_cents) + '</p>' +
      '</li>';
    }).join('') + items.map(function (it) {
      var gone = it.state !== 'available';
      return '<li class="' + (gone ? 'is-gone' : '') + '">' +
        '<a class="line-thumb" href="' + esc(it.url) + '">' + (it.photo ? '<img src="' + esc(it.photo) + '" alt="">' : '') + '</a>' +
        '<div class="line-info">' +
          (it.brand ? '<p class="brand">' + esc(it.brand) + '</p>' : '') +
          '<p><a href="' + esc(it.url) + '">' + esc(it.title) + '</a></p>' +
          (it.size ? '<p class="muted small">Size ' + esc(it.size) + '</p>' : '') +
          (it.state === 'sold' ? '<p class="line-gone">Sorry, this piece just sold.</p>' : '') +
          (it.state === 'hold' ? '<p class="line-gone">Someone is checking out with this piece. It may come back soon.</p>' : '') +
          '<button type="button" class="line-remove" data-remove="' + it.id + '">Remove</button>' +
        '</div>' +
        '<p class="line-price">' + money(it.price_cents) + '</p>' +
      '</li>';
    }).join('');
    var canBuy = buyable.length + buyableOutfits.length > 0;
    var ship = canBuy ? data.shipping_cents : 0;
    bagEl.innerHTML =
      '<ul class="bag-lines">' + lines + '</ul>' +
      '<dl class="totals">' +
        '<div><dt>Subtotal</dt><dd>' + money(subtotal) + '</dd></div>' +
        '<div><dt>Shipping <span class="small">(' + esc(data.shipping_label) + ')</span></dt><dd>' + (ship ? money(ship) : 'Free') + '</dd></div>' +
        '<div class="grand"><dt>Total</dt><dd>' + money(subtotal + ship) + '</dd></div>' +
      '</dl>' +
      '<div class="checkout-box">' +
        (data.checkout_enabled
          ? '<button type="button" class="btn btn-primary btn-block" data-checkout' + (canBuy ? '' : ' disabled') + '>Checkout</button>' +
            '<p class="checkout-note">Secure payment by Stripe. You’ll add your shipping address on the next page.</p>'
          : '<p class="notice">Checkout isn’t open just yet. Check back soon!</p>') +
      '</div>';

    bagEl.querySelectorAll('[data-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-remove'));
        writeBag(readBag().filter(function (x) { return x !== id; }));
        say('');
        loadBag();
      });
    });
    bagEl.querySelectorAll('[data-remove-outfit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-remove-outfit'));
        writeOutfits(readOutfits().filter(function (x) { return x !== id; }));
        say('');
        loadBag();
      });
    });
    var go = bagEl.querySelector('[data-checkout]');
    if (go) go.addEventListener('click', function () {
      checkout(go, buyable.map(function (it) { return it.id; }), buyableOutfits.map(function (o) { return o.id; }));
    });
  }

  function checkout(btn, ids, outfits) {
    btn.disabled = true;
    btn.textContent = 'Opening secure checkout…';
    fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids, outfits: outfits }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body.url) { location.href = res.body.url; return; }
        say(res.body.error || 'Checkout couldn’t start. Please try again.');
        loadBag();
      })
      .catch(function () {
        say('Checkout couldn’t start. Check your connection and try again.');
        btn.disabled = false;
        btn.textContent = 'Checkout';
      });
  }

  function loadBag() {
    var ids = readBag();
    var outfits = readOutfits();
    if (!ids.length && !outfits.length) { renderBag({ items: [], outfits: [] }); return; }
    fetch('/api/bag?ids=' + ids.join(',') + '&outfits=' + outfits.join(','), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(renderBag)
      .catch(function () { bagEl.innerHTML = '<p>Couldn’t load your bag. Refresh to try again.</p>'; });
  }

  if (bagEl) {
    var params = new URLSearchParams(location.search);
    var cancelled = params.get('cancelled');
    if (cancelled) {
      history.replaceState(null, '', '/bag');
      say('Checkout cancelled. Nothing was charged, and your pieces are still in your bag.');
      fetch('/api/checkout/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cancelled }) })
        .catch(function () {})
        .then(loadBag);
    } else {
      loadBag();
    }
  }

  updateCount();
})();
