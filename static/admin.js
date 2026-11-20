// UniqueResellzz: the Studio (admin). Post pieces, make them live, ship orders.
(function () {
  'use strict';

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (cents) {
    var whole = cents % 100 === 0;
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  };
  var dollars = function (cents) { return cents == null ? '' : String(cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)); };
  var when = function (ms) {
    return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  var day = function (ms) { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  var phone = function (p) {
    var m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || '');
    return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : p;
  };

  var DESIGNERS = ['Alexander McQueen', 'Balenciaga', 'Balmain', 'Bottega Veneta', 'Burberry', 'Celine', 'Chanel', 'Chloé', 'Christian Louboutin',
    'Coach', 'Dior', 'Dolce & Gabbana', 'Fendi', 'Givenchy', 'Gucci', 'Hermès', 'Jacquemus', 'Jimmy Choo', 'Kate Spade', 'Loewe', 'Louis Vuitton',
    'Marc Jacobs', 'Michael Kors', 'Miu Miu', 'Moncler', 'Off-White', 'Prada', 'Saint Laurent', 'Salvatore Ferragamo', 'Stella McCartney',
    'Tory Burch', 'Valentino', 'Versace'];

  var state = { me: null, items: [], orders: [], openCheckouts: 0, settings: null, tab: 'items', filter: 'all' };

  // ---------- plumbing ----------

  function api(method, url, body) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && url !== '/api/admin/login') showLogin();
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = $('[data-toast]');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function fail(err) { toast(err.message || String(err)); }

  // ---------- sign in ----------

  function showLogin(message) {
    $('[data-app]').hidden = true;
    $('[data-login-screen]').hidden = false;
    var e = $('[data-login-error]');
    e.textContent = message || '';
    e.hidden = !message;
    var f = $('[data-login] input[name=password]');
    if (f) setTimeout(function () { f.focus(); }, 30);
  }

  $('[data-login]').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = ev.target;
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    api('POST', '/api/admin/login', { password: form.password.value })
      .then(function () { form.reset(); boot(); })
      .catch(function (err) { showLogin(err.message); })
      .then(function () { btn.disabled = false; });
  });

  $('[data-logout]').addEventListener('click', function () {
    api('POST', '/api/admin/logout').then(function () { showLogin(); });
  });

  function boot() {
    api('GET', '/api/admin/me')
      .then(function (me) {
        if (!me.ok) return showLogin();
        state.me = me;
        $('[data-login-screen]').hidden = true;
        $('[data-app]').hidden = false;
        fillSelects();
        renderBanners();
        return Promise.all([loadItems(), loadOrders(), loadSettings()]);
      })
      .catch(function (err) { if (err.status !== 401) showLogin(err.message); else showLogin(); });
  }

  // ---------- tabs ----------

  function setTab(name) {
    state.tab = name;
    $$('[data-tab]').forEach(function (b) {
      if (b.getAttribute('data-tab') === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $$('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    if (name === 'orders') loadOrders();
    try { history.replaceState(null, '', name === 'items' ? '/admin' : '/admin#' + name); } catch (e) { /* ignore */ }
  }
  $$('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); }); });

  function renderBanners() {
    var p = state.me.payments;
    var out = [];
    if (!p.connected) {
      out.push('<div class="banner banner-warn"><strong>Payments aren’t connected yet.</strong> Shoppers can browse, but checkout is closed until STRIPE_SECRET_KEY is set on the server (see the README).</div>');
    } else {
      if (p.mode === 'test') out.push('<div class="banner"><strong>Stripe test mode:</strong> no real money moves. Try a purchase with card 4242 4242 4242 4242, any future date and any CVC.</div>');
      if (!p.webhook) out.push('<div class="banner banner-warn"><strong>Stripe webhook not set.</strong> Sales still record when a buyer reaches the thank-you page, but add STRIPE_WEBHOOK_SECRET so a sale is never missed.</div>');
    }
    $('[data-banners]').innerHTML = out.join('');
  }

  function fillSelects() {
    $('[data-categories]').innerHTML = state.me.categories.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
    $('[data-conditions]').innerHTML = '<option value="">Choose…</option>' + state.me.conditions.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  }

  // ---------- items ----------

  function loadItems() {
    return api('GET', '/api/admin/items').then(function (j) {
      state.items = j.items;
      state.storage = j.storage;
      var brands = DESIGNERS.slice();
      j.items.forEach(function (it) { if (it.brand && brands.indexOf(it.brand) < 0) brands.push(it.brand); });
      brands.sort(function (a, b) { return a.localeCompare(b); });
      $('#brand-list').innerHTML = brands.map(function (b) { return '<option value="' + esc(b) + '">'; }).join('');
      renderItems();
    }).catch(fail);
  }

  var PILL = { draft: ['Draft', 'pill-draft'], available: ['Live', 'pill-live'], hold: ['In checkout', 'pill-hold'], sold: ['Sold', 'pill-sold'] };
  var FILTERS = [['all', 'All'], ['draft', 'Drafts'], ['live', 'Live'], ['sold', 'Sold']];
  var matches = function (it, f) {
    return f === 'all' || (f === 'live' ? it.state === 'available' || it.state === 'hold' : it.state === f);
  };

  function renderItems() {
    var panel = $('[data-panel="items"]');
    var list = state.items.filter(function (it) { return matches(it, state.filter); });
    var chips = FILTERS.map(function (f) {
      var n = state.items.filter(function (it) { return matches(it, f[0]); }).length;
      return '<button type="button" class="fchip' + (state.filter === f[0] ? ' is-on' : '') + '" data-filter="' + f[0] + '">' + f[1] + ' <span>' + n + '</span></button>';
    }).join('');

    var body;
    if (!state.items.length) {
      body = '<div class="empty-card"><p class="empty-h">Post your first piece</p>' +
        '<p class="muted">Snap a few photos, add the designer and price, then make it live. Drafts stay hidden from shoppers until you’re ready.</p>' +
        '<button type="button" class="abtn abtn-primary" data-new>+ New item</button></div>';
    } else if (!list.length) {
      body = '<p class="muted pad">Nothing in this list.</p>';
    } else {
      body = '<ul class="item-list">' + list.map(rowHtml).join('') + '</ul>';
    }

    var st = state.storage;
    var meter = '';
    if (st && st.count) {
      var pct = Math.min(100, Math.round((st.used_bytes / st.limit_bytes) * 100));
      var mb = function (b) { return b >= 1e9 ? (b / 1e9) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB'; };
      meter = '<p class="storage' + (pct >= 80 ? ' storage-warn' : '') + '">Photo storage: ' + mb(st.used_bytes) + ' of ' + mb(st.limit_bytes) + ' used (' + st.count + ' photos)' +
        (pct >= 80 ? '. Getting full: delete sold pieces you no longer need to free up room.' : '') + '</p>';
    }
    panel.innerHTML =
      '<div class="panel-head"><h1>Items</h1><button type="button" class="abtn abtn-primary" data-new>+ New item</button></div>' +
      (state.items.length ? '<div class="fchips">' + chips + '</div>' : '') + body + meter;

    $$('[data-new]', panel).forEach(function (b) { b.addEventListener('click', function () { openEditor(null); }); });
    $$('[data-filter]', panel).forEach(function (b) {
      b.addEventListener('click', function () { state.filter = b.getAttribute('data-filter'); renderItems(); });
    });
    $$('[data-act]', panel).forEach(function (b) { b.addEventListener('click', onItemAction); });
  }

  function rowHtml(it) {
    var pill = PILL[it.state];
    var thumb = it.photos[0] ? '<img src="/uploads/' + esc(it.photos[0]) + '" alt="" loading="lazy">' : '<span class="no-photo">No photo</span>';
    var meta = [money(it.price_cents), it.category, it.size && 'Size ' + it.size, it.photos.length + (it.photos.length === 1 ? ' photo' : ' photos')].filter(Boolean).join(' · ');
    var a = function (act, label, cls) { return '<button type="button" class="abtn abtn-sm ' + (cls || '') + '" data-act="' + act + '" data-id="' + it.id + '">' + label + '</button>'; };
    var more = [];
    var main = [a('edit', 'Edit')];
    if (it.state === 'draft') {
      main.push(a('live', 'Make live', 'abtn-primary'));
      more.push('<a class="menu-item" href="' + esc(it.url) + '" target="_blank" rel="noopener">Preview</a>');
    } else if (it.state === 'available') {
      main.push('<a class="abtn abtn-sm" href="' + esc(it.url) + '" target="_blank" rel="noopener">View</a>');
      more.push('<button type="button" class="menu-item" data-act="draft" data-id="' + it.id + '">Unpublish (back to draft)</button>');
      more.push('<button type="button" class="menu-item" data-act="sold" data-id="' + it.id + '">Mark sold (sold elsewhere)</button>');
    } else if (it.state === 'hold') {
      main.push('<a class="abtn abtn-sm" href="' + esc(it.url) + '" target="_blank" rel="noopener">View</a>');
    } else if (it.state === 'sold') {
      more.push('<button type="button" class="menu-item" data-act="live" data-id="' + it.id + '">Relist (put back on sale)</button>');
    }
    if (it.state !== 'hold') more.push('<button type="button" class="menu-item menu-danger" data-act="delete" data-id="' + it.id + '">Delete</button>');

    return '<li class="item-row">' +
      '<button type="button" class="row-thumb" data-act="edit" data-id="' + it.id + '" aria-label="Edit ' + esc(it.title) + '">' + thumb + '</button>' +
      '<div class="row-main">' +
        (it.brand ? '<p class="row-brand">' + esc(it.brand) + '</p>' : '') +
        '<p class="row-title">' + esc(it.title) + '</p>' +
        '<p class="row-meta"><span class="pill ' + pill[1] + '">' + pill[0] + '</span> ' + esc(meta) + '</p>' +
        (it.state === 'hold' ? '<p class="row-note">A shopper is checking out with this right now.</p>' : '') +
      '</div>' +
      '<div class="row-actions">' + main.join('') +
        (more.length ? '<details class="menu"><summary class="abtn abtn-sm" aria-label="More actions">More</summary><div class="menu-pop">' + more.join('') + '</div></details>' : '') +
      '</div>' +
    '</li>';
  }

  function onItemAction(ev) {
    var b = ev.currentTarget;
    var id = Number(b.getAttribute('data-id'));
    var it = state.items.find(function (x) { return x.id === id; });
    var act = b.getAttribute('data-act');
    var menu = b.closest('details');
    if (menu) menu.open = false;
    if (!it) return;
    if (act === 'edit') return openEditor(it);
    if (act === 'delete') {
      if (!confirm('Delete “' + it.title + '”? This can’t be undone.')) return;
      return api('DELETE', '/api/admin/items/' + id).then(function () { toast('Deleted.'); loadItems(); }).catch(fail);
    }
    if (act === 'sold' && !confirm('Mark “' + it.title + '” as sold? It will show as Sold in the shop.')) return;
    var msg = { live: 'It’s live! Shoppers can see it now.', draft: 'Unpublished. It’s hidden from shoppers.', sold: 'Marked as sold.' }[act];
    api('POST', '/api/admin/items/' + id + '/status', { status: act }).then(function () { toast(msg); loadItems(); }).catch(fail);
  }

  document.addEventListener('click', function (ev) {
    $$('details.menu[open]').forEach(function (d) { if (!d.contains(ev.target)) d.open = false; });
  });

  // ---------- item editor ----------

  var dialog = $('[data-editor]');
  var form = $('[data-editor-form]');
  var editing = null;

  function openEditor(it) {
    editing = { id: it ? it.id : null, status: it ? it.status : 'draft', state: it ? it.state : 'draft', photos: it ? it.photos.slice() : [], uploading: 0, dirty: false, saving: false };
    form.reset();
    form.brand.value = it ? it.brand : '';
    form.title.value = it ? it.title : '';
    form.price.value = it ? dollars(it.price_cents) : '';
    form.retail.value = it ? dollars(it.retail_cents) : '';
    form.category.value = it ? it.category : state.me.categories[0];
    form.condition.value = it ? it.condition : '';
    form.size.value = it ? it.size : '';
    form.color.value = it ? it.color : '';
    form.description.value = it ? it.description : '';
    $('[data-editor-title]').textContent = it ? 'Edit item' : 'New item';
    setEditorError('');
    renderPhotos();
    renderFoot();
    dialog.showModal();
    if (!it) form.brand.focus();
  }

  function renderFoot() {
    var foot = $('[data-editor-foot]');
    var busy = editing.uploading > 0 || editing.saving;
    var cancel = '<button type="button" class="abtn" data-editor-close>Cancel</button>';
    if (editing.status === 'draft') {
      foot.innerHTML = cancel +
        '<button type="submit" class="abtn" data-save="draft"' + (busy ? ' disabled' : '') + '>Save draft</button>' +
        '<button type="submit" class="abtn abtn-primary" data-save="live"' + (busy ? ' disabled' : '') + '>Save &amp; make live</button>';
    } else {
      foot.innerHTML = cancel + '<button type="submit" class="abtn abtn-primary" data-save="keep"' + (busy ? ' disabled' : '') + '>Save changes</button>';
    }
    $$('[data-editor-close]', dialog).forEach(function (b) { b.onclick = closeEditor; });
  }

  function closeEditor() {
    if (editing && editing.dirty && !confirm('Discard your changes?')) return;
    if (editing) editing.dirty = false;
    dialog.close();
  }
  $('[data-editor-close]').addEventListener('click', closeEditor);
  dialog.addEventListener('cancel', function (ev) {
    if (editing && editing.dirty && !confirm('Discard your changes?')) ev.preventDefault();
  });
  form.addEventListener('input', function () { if (editing) editing.dirty = true; });

  function setEditorError(msg) {
    var e = $('[data-editor-error]');
    e.textContent = msg;
    e.hidden = !msg;
  }

  function renderPhotos() {
    var box = $('[data-photos]');
    var n = editing.photos.length;
    var tiles = editing.photos.map(function (p, i) {
      return '<div class="photo">' +
        '<img src="/uploads/' + esc(p) + '" alt="Photo ' + (i + 1) + '">' +
        (i === 0 ? '<span class="cover-tag">Cover</span>' : '') +
        '<div class="photo-tools">' +
          '<button type="button" data-photo="left" data-i="' + i + '" aria-label="Move earlier"' + (i === 0 ? ' disabled' : '') + '>&larr;</button>' +
          '<button type="button" data-photo="remove" data-i="' + i + '" aria-label="Remove photo">&times;</button>' +
          '<button type="button" data-photo="right" data-i="' + i + '" aria-label="Move later"' + (i === n - 1 ? ' disabled' : '') + '>&rarr;</button>' +
        '</div>' +
      '</div>';
    });
    for (var k = 0; k < editing.uploading; k++) tiles.push('<div class="photo is-loading"><span class="spinner" aria-label="Uploading"></span></div>');
    if (n + editing.uploading < 12) {
      tiles.push('<label class="photo photo-add" data-drop>' +
        '<input type="file" accept="image/*" multiple data-photo-input>' +
        '<span class="plus">+</span><span>Add photos</span></label>');
    }
    box.innerHTML = tiles.join('');
    $$('[data-photo]', box).forEach(function (b) { b.addEventListener('click', onPhotoTool); });
    var input = $('[data-photo-input]', box);
    if (input) input.addEventListener('change', function () { addFiles(input.files); });
    var drop = $('[data-drop]', box);
    if (drop) {
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('is-over'); addFiles(e.dataTransfer.files); });
    }
  }

  function onPhotoTool(ev) {
    var b = ev.currentTarget;
    var i = Number(b.getAttribute('data-i'));
    var p = editing.photos;
    var act = b.getAttribute('data-photo');
    if (act === 'remove') p.splice(i, 1);
    if (act === 'left' && i > 0) p.splice(i - 1, 0, p.splice(i, 1)[0]);
    if (act === 'right' && i < p.length - 1) p.splice(i + 1, 0, p.splice(i, 1)[0]);
    editing.dirty = true;
    renderPhotos();
  }

  // Phone photos are huge. Shrink to 1500px on the long side (about 200-400 KB) before uploading.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1500 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var tryQuality = function (q) {
          c.toBlob(function (blob) {
            if (!blob) return reject(new Error('Could not process that photo.'));
            if (blob.size > 1700000 && q > 0.5) return tryQuality(q - 0.12);
            resolve(blob);
          }, 'image/jpeg', q);
        };
        tryQuality(0.84);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('“' + file.name + '” isn’t a photo this browser can read. Try a JPG or PNG.')); };
      img.src = url;
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name); });
    var room = 12 - editing.photos.length - editing.uploading;
    if (files.length > room) { toast('Up to 12 photos per item.'); files = files.slice(0, Math.max(0, room)); }
    if (!files.length) return;
    var session = editing;
    session.uploading += files.length;
    session.dirty = true;
    renderPhotos();
    renderFoot();
    // Upload in order so the photos keep the order they were picked in.
    files.reduce(function (chain, file) {
      return chain.then(function () {
        return shrink(file)
          .then(function (blob) {
            return fetch('/api/admin/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
          })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed.'); return j; }); })
          .then(function (j) { session.photos.push(j.name); })
          .catch(function (err) { toast(err.message); })
          .then(function () {
            session.uploading -= 1;
            if (editing === session) { renderPhotos(); renderFoot(); }
          });
      });
    }, Promise.resolve());
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var mode = (ev.submitter && ev.submitter.getAttribute('data-save')) || (editing.status === 'draft' ? 'draft' : 'keep');
    if (!form.title.value.trim()) { setEditorError('Give the item a title.'); form.title.focus(); return; }
    if (!form.price.value.trim()) { setEditorError('Add a price.'); form.price.focus(); return; }
    if (mode === 'live' && !editing.photos.length) { setEditorError('Add at least one photo before making it live.'); return; }
    var body = {
      brand: form.brand.value, title: form.title.value, price: form.price.value, retail: form.retail.value, category: form.category.value,
      condition: form.condition.value, size: form.size.value, color: form.color.value, description: form.description.value, photos: editing.photos,
    };
    if (mode === 'live') body.status = 'live';
    editing.saving = true;
    renderFoot();
    setEditorError('');
    var req = editing.id ? api('PUT', '/api/admin/items/' + editing.id, body) : api('POST', '/api/admin/items', body);
    req.then(function () {
      editing.dirty = false;
      dialog.close();
      toast(mode === 'live' ? 'It’s live! Shoppers can see it now.' : mode === 'draft' ? 'Saved as a draft. Only you can see it.' : 'Saved.');
      if (mode === 'live' && state.filter === 'draft') state.filter = 'all';
      loadItems();
    }).catch(function (err) {
      setEditorError(err.message);
    }).then(function () {
      editing.saving = false;
      if (dialog.open) renderFoot();
    });
  });

  // ---------- orders ----------

  function loadOrders() {
    return api('GET', '/api/admin/orders').then(function (j) {
      state.orders = j.orders;
      state.openCheckouts = j.open_checkouts;
      var toShip = j.orders.filter(function (o) { return o.status === 'paid'; }).length;
      var badge = $('[data-orders-badge]');
      badge.textContent = String(toShip);
      badge.hidden = toShip === 0;
      renderOrders();
    }).catch(fail);
  }

  function addressText(a) {
    if (!a) return '';
    return [a.name, a.line1, a.line2, (a.city || '') + (a.state ? ', ' + a.state : '') + ' ' + (a.postal_code || ''), a.country && a.country !== 'US' ? a.country : '']
      .filter(function (l) { return l && l.trim(); }).join('\n');
  }

  function trackUrl(o) {
    var t = encodeURIComponent(o.tracking);
    var c = (o.carrier || '').toLowerCase();
    if (c.indexOf('ups') >= 0) return 'https://www.ups.com/track?tracknum=' + t;
    if (c.indexOf('fedex') >= 0) return 'https://www.fedex.com/fedextrack/?trknbr=' + t;
    return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + t;
  }

  function mailtoTracking(o) {
    var first = (o.customer_name || '').split(' ')[0] || 'there';
    var shop = (state.settings && state.settings.shop_name) || "UniqueResellzz";
    var subject = 'Your ' + shop + ' order #' + o.number + ' has shipped';
    var body = 'Hi ' + first + ',\n\nYour order #' + o.number + ' is on its way!\n\n' +
      (o.tracking ? (o.carrier || 'USPS') + ' tracking: ' + o.tracking + '\n' + trackUrl(o) + '\n\n' : '') +
      'You can also check on it here: ' + location.origin + '/order/' + o.token + '\n\nThank you so much for shopping my closet!\nUniqueResellzz';
    return 'mailto:' + encodeURIComponent(o.customer_email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function orderCard(o) {
    var items = o.items.map(function (i) {
      return '<li><span class="oi-thumb">' + (i.photo ? '<img src="/uploads/' + esc(i.photo) + '" alt="">' : '') + '</span>' +
        '<span class="oi-name">' + (i.brand ? '<strong>' + esc(i.brand) + '</strong> ' : '') + esc(i.title) + (i.size ? ' <span class="muted">· Size ' + esc(i.size) + '</span>' : '') + '</span>' +
        '<span class="oi-price">' + money(i.price_cents) + '</span></li>';
    }).join('');
    var pill = { paid: ['To ship', 'pill-hold'], shipped: ['Shipped', 'pill-live'], processing: ['Payment processing', 'pill-draft'] }[o.status];
    var addr = addressText(o.shipping);
    var shipPart;
    if (o.status === 'paid') {
      shipPart = '<form class="ship-form" data-ship="' + o.id + '">' +
        '<label class="field"><span class="field-label">Tracking number</span><input name="tracking" autocomplete="off" placeholder="9400 1000 0000 0000 0000 00"></label>' +
        '<label class="field field-carrier"><span class="field-label">Carrier</span><select name="carrier"><option>USPS</option><option>UPS</option><option>FedEx</option></select></label>' +
        '<button type="submit" class="abtn abtn-primary">Mark shipped</button></form>';
    } else if (o.status === 'shipped') {
      shipPart = '<div class="shipped-row"><p>Shipped ' + esc(day(o.shipped_at)) + (o.tracking ? ' · ' + esc(o.carrier || 'USPS') + ' <a href="' + esc(trackUrl(o)) + '" target="_blank" rel="noopener">' + esc(o.tracking) + '</a>' : '') + '</p>' +
        '<div class="btn-row">' + (o.customer_email ? '<a class="abtn abtn-sm abtn-primary" href="' + esc(mailtoTracking(o)) + '">Email buyer the tracking</a>' : '') +
        '<button type="button" class="abtn abtn-sm" data-unship="' + o.id + '">Undo shipped</button></div></div>';
    } else {
      shipPart = '<p class="row-note">The buyer’s bank payment hasn’t cleared yet. Don’t ship until this says To ship.</p>';
    }
    return '<article class="order-card">' +
      '<header class="order-head"><p class="order-no">#' + o.number + '</p><span class="pill ' + pill[1] + '">' + pill[0] + '</span><p class="muted order-when">' + (o.paid_at ? 'Paid ' + esc(when(o.paid_at)) : 'Ordered ' + esc(when(o.created_at))) + '</p></header>' +
      (o.note ? '<p class="order-warn">' + esc(o.note) + '</p>' : '') +
      '<ul class="order-items">' + items + '</ul>' +
      '<div class="order-grid">' +
        '<div><p class="field-label">Ship to</p><address class="addr">' + esc(addr).replace(/\n/g, '<br>') + '</address>' +
          '<div class="btn-row"><button type="button" class="abtn abtn-sm" data-copy="' + esc(addr) + '">Copy address</button>' +
          '<a class="abtn abtn-sm" href="/admin/orders/' + o.id + '/slip" target="_blank" rel="noopener">Packing slip</a></div></div>' +
        '<div><p class="field-label">Buyer</p><p class="buyer">' + esc(o.customer_name) +
          (o.customer_email ? '<br><a href="mailto:' + esc(o.customer_email) + '">' + esc(o.customer_email) + '</a>' : '') +
          (o.customer_phone ? '<br><a href="tel:' + esc(o.customer_phone) + '">' + esc(phone(o.customer_phone)) + '</a>' : '') + '</p>' +
          '<p class="field-label">Paid</p><p class="buyer">' + money(o.total_cents || 0) + ' <span class="muted">incl. ' + (o.shipping_cents ? money(o.shipping_cents) + ' shipping' : 'free shipping') + '</span></p></div>' +
      '</div>' + shipPart +
    '</article>';
  }

  function renderOrders() {
    var panel = $('[data-panel="orders"]');
    var byOldest = function (a, b) { return (a.paid_at || a.created_at) - (b.paid_at || b.created_at); };
    var toShip = state.orders.filter(function (o) { return o.status === 'paid'; }).sort(byOldest);
    var processing = state.orders.filter(function (o) { return o.status === 'processing'; });
    var shipped = state.orders.filter(function (o) { return o.status === 'shipped'; }).sort(function (a, b) { return b.shipped_at - a.shipped_at; });
    var html = '<div class="panel-head"><h1>Orders</h1></div>';
    if (state.openCheckouts) html += '<p class="muted pad-b">' + state.openCheckouts + (state.openCheckouts === 1 ? ' shopper is' : ' shoppers are') + ' in checkout right now.</p>';
    if (!state.orders.length) {
      html += '<div class="empty-card"><p class="empty-h">No orders yet</p><p class="muted">When someone buys, their order and shipping address land here, and Stripe emails you a payment notice too.</p></div>';
    }
    if (toShip.length) html += '<h2 class="group-h">To ship <span>' + toShip.length + '</span></h2>' + toShip.map(orderCard).join('');
    if (processing.length) html += '<h2 class="group-h">Payment processing</h2>' + processing.map(orderCard).join('');
    if (shipped.length) html += '<h2 class="group-h">Shipped</h2>' + shipped.map(orderCard).join('');
    panel.innerHTML = html;

    $$('[data-copy]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        var text = b.getAttribute('data-copy');
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(function () { toast('Address copied.'); })
          .catch(function () { prompt('Copy the address:', text); });
      });
    });
    $$('[data-ship]', panel).forEach(function (f) {
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!f.tracking.value.trim() && !confirm('Mark shipped without a tracking number?')) return;
        api('POST', '/api/admin/orders/' + f.getAttribute('data-ship') + '/ship', { tracking: f.tracking.value, carrier: f.carrier.value })
          .then(function () { toast('Marked shipped. Send the buyer their tracking next.'); loadOrders(); })
          .catch(fail);
      });
    });
    $$('[data-unship]', panel).forEach(function (b) {
      b.addEventListener('click', function () {
        api('POST', '/api/admin/orders/' + b.getAttribute('data-unship') + '/ship', { shipped: false }).then(loadOrders).catch(fail);
      });
    });
  }

  // ---------- settings ----------

  function loadSettings() {
    return api('GET', '/api/admin/settings').then(function (j) {
      state.settings = j.settings;
      $$('[data-shop-name]').forEach(function (el) { el.textContent = j.settings.shop_name; });
      renderSettings();
    }).catch(fail);
  }

  function renderSettings() {
    var s = state.settings;
    var f = function (name, label, value, opts) {
      opts = opts || {};
      var input = opts.area
        ? '<textarea name="' + name + '" rows="' + (opts.rows || 5) + '">' + esc(value) + '</textarea>'
        : (opts.money ? '<span class="money-input"><span>$</span>' : '') +
          '<input name="' + name + '" value="' + esc(value) + '"' + (opts.attrs || '') + '>' + (opts.money ? '</span>' : '');
      return '<label class="field"><span class="field-label">' + label + '</span>' + input + (opts.hint ? '<span class="hint">' + opts.hint + '</span>' : '') + '</label>';
    };
    $('[data-panel="settings"]').innerHTML =
      '<div class="panel-head"><h1>Shop settings</h1></div>' +
      '<form class="settings-form" data-settings>' +
        '<section class="card-section"><h2>Front page</h2>' +
          f('shop_name', 'Shop name', s.shop_name, { attrs: ' maxlength="60" required' }) +
          f('headline', 'Headline', s.headline, { attrs: ' maxlength="120"' }) +
          f('tagline', 'Tagline', s.tagline, { area: true, rows: 2 }) +
        '</section>' +
        '<section class="card-section"><h2>Shipping</h2>' +
          '<div class="field-row">' +
            f('shipping', 'Shipping charge per order', dollars(s.shipping_cents), { money: true, attrs: ' inputmode="decimal"', hint: 'One charge per order, however many pieces. Enter 0 for free shipping.' }) +
            f('shipping_label', 'Shipping method shown at checkout', s.shipping_label, { attrs: ' maxlength="60"' }) +
          '</div>' +
          '<p class="hint">Checkout collects a US shipping address and phone number for every order.</p>' +
        '</section>' +
        '<section class="card-section"><h2>About &amp; policies</h2>' +
          f('about', 'About me', s.about, { area: true, rows: 6 }) +
          f('policies', 'Authenticity, shipping &amp; returns', s.policies, { area: true, rows: 6, hint: 'Shown on every item page and the About page. Make sure it matches how you actually work.' }) +
        '</section>' +
        '<section class="card-section"><h2>Contact</h2>' +
          '<div class="field-row">' +
            f('contact_email', 'Contact email', s.contact_email, { attrs: ' type="email" maxlength="120" placeholder="you@example.com"' }) +
            f('instagram', 'Instagram handle', s.instagram, { attrs: ' maxlength="60" placeholder="naleyahscloset"' }) +
          '</div>' +
        '</section>' +
        '<p class="form-error" data-settings-error role="alert" hidden></p>' +
        '<div class="settings-foot"><button type="submit" class="abtn abtn-primary">Save settings</button></div>' +
      '</form>';
    $('[data-settings]').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fm = ev.target;
      var body = {};
      ['shop_name', 'headline', 'tagline', 'shipping', 'shipping_label', 'about', 'policies', 'contact_email', 'instagram'].forEach(function (k) { body[k] = fm[k].value; });
      var err = $('[data-settings-error]');
      err.hidden = true;
      api('PUT', '/api/admin/settings', body).then(function (j) {
        state.settings = j.settings;
        $$('[data-shop-name]').forEach(function (el) { el.textContent = j.settings.shop_name; });
        toast('Settings saved.');
        renderSettings();
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
    });
  }

  // ---------- go ----------

  boot();
  var start = location.hash.replace('#', '');
  if (start === 'orders' || start === 'settings') setTab(start);
})();
