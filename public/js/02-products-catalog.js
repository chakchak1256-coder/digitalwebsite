// Stats strip, categories, product grid, best sellers, all-products page, product detail modal, and the showMain() view switcher.

// ===== STATS =====
function renderStats() {
  const p = DB.getAll('products').length, c = DB.getAll('categories').length;
  ['stat-prods','ab-prods'].forEach(id => { const el = document.getElementById(id); if(el) el.textContent = p; });
  ['stat-cats','ab-cats'].forEach(id =>  { const el = document.getElementById(id); if(el) el.textContent = c; });
  const heroP = document.getElementById('hero-stat-prods'); if (heroP) heroP.textContent = (p || 0) + '+ Products';
}

// ===== CATEGORIES =====
function renderCats() {
  const cats = DB.getAll('categories');
  const allProds = DB.getAll('products');
  const g = document.getElementById('cats-grid'); g.innerHTML = '';
  cats.forEach(c => g.appendChild(makeCatCard(c, allProds)));
}

function makeCatCard(cat, allProds) {
  const d = document.createElement('div');
  d.className = 'cat-card';
  const hasBg = cat.image && cat.image.length > 50;
  const count = (allProds || DB.getAll('products')).filter(p => cat._all || p.category === cat.name).length;
  d.innerHTML = `
    <div class="cat-bg">
      ${hasBg ? `<img class="cat-cover" src="${cat.image}" alt="" loading="lazy"/>` : ''}
      <div class="cat-card-body">
        ${!hasBg ? `<span class="cat-emoji">${cat.emoji||'📦'}</span>` : ''}
      </div>
    </div>
    <span class="cat-name">${cat.name}</span>
    <span class="cat-count">${count} Product${count === 1 ? '' : 's'}</span>`;
  // Clicking a category → opens all products page filtered to that category
  d.onclick = () => {
    openAllProducts(cat._all ? 'all' : cat.name);
  };
  return d;
}

// ===== PRODUCTS (last added) =====
function renderProducts() {
  const prods = DB.getAll('products'); // already sorted newest first (unshift on add)
  const s = Settings.get();
  const g = document.getElementById('products-grid'); g.innerHTML = '';
  if (!prods.length) {
    g.innerHTML = '<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:3rem">No products yet.</p>';
    return;
  }
  prods.slice(0, 8).forEach(p => g.appendChild(makeProductCard(p)));
}

function makeProductCard(prod) {
  const d = document.createElement('div'); d.className = 'product-card';
  const s = Settings.get();
  const img = (prod.images||[])[0] || generatePlaceholder(prod.name, 400, 300);
  const badgeCls = prod.badge ? { HOT:'', NEW:'new', SALE:'sale', 'BEST SELLER':'best', POPULAR:'', PREMIUM:'' }[prod.badge]||'' : '';
  const wishlisted = Wishlist.has(prod.id);
  const starsHtml = prod.rating ? buildStarsHtml(prod.rating, 'prod-stars') : '';
  const discountPct = (prod.oldPrice && prod.oldPrice > prod.price) ? Math.round((1 - prod.price / prod.oldPrice) * 100) : 0;
  d.innerHTML = `
    <div class="prod-img">
      ${prod.badge ? `<span class="prod-badge ${badgeCls}">${prod.badge}</span>` : ''}
      ${discountPct > 0 ? `<span class="prod-discount">-${discountPct}%</span>` : ''}
      <img src="${img}" alt="${prod.name}" loading="lazy"/>
      <button class="prod-heart ${wishlisted?'active':''}" onclick="event.stopPropagation();toggleWishlist('${prod.id}',this)" title="${wishlisted?'Remove from wishlist':'Add to wishlist'}">
        <i class="${wishlisted?'fa-solid':'fa-regular'} fa-heart"></i>
      </button>
    </div>
    <div class="prod-info">
      <div class="prod-cat">${prod.category||''}</div>
      <div class="prod-name">${prod.name}</div>
      ${starsHtml}
      <div class="prod-price-row">
        <div class="prod-prices">
          <span class="prod-price">${formatPrice(prod.price, s.currency)}</span>
          ${prod.oldPrice ? `<span class="prod-old">${prod.oldPrice.toLocaleString()} ${s.currency}</span>` : ''}
        </div>
        <button class="prod-add" title="Add to cart"><i class="fa-solid fa-plus"></i></button>
      </div>
    </div>`;
  d.querySelector('.prod-add').onclick = e => { e.stopPropagation(); if ((Number(prod.price)||0) <= 0) claimFreeProduct(prod); else addToCart(prod); };
  d.onclick = () => { trackRecentlyViewed(prod); openProductDetail(prod.id, false); };
  return d;
}

function addToCart(prod) { Cart.add(prod); Analytics.logCart(prod.id, prod.name); showToast(`"${prod.name}" added to cart`); }

// ── FREE products (price === 0) — no cart, no payment ──────────────
// Delivers the product straight to My Products for a signed-in user.
// If auto-delivery (a link/PDF) is configured on the product, the
// purchase is created already completed; otherwise it's queued as
// pending, same as any manually-fulfilled order.
async function claimFreeProduct(prod) {
  const user = UserAuth.current();
  if (!user) { openLoginModal('checkout'); return; }

  // Don't hand out a second copy of a free product someone already owns.
  // "Owns" here means any existing purchase record for this product (and
  // variant, if it has one) — pending or delivered — since that's the
  // real source of truth for My Products, not anything stored locally.
  try {
    const existing = await Purchases.forUser(user.id);
    const already = existing.find(p =>
      p.productId === prod.id &&
      (p.variantLabel || '') === (prod.variantLabel || '')
    );
    if (already) {
      showToast(`ℹ️ You already have "${prod.name}" — check My Products`);
      closeProductDetail();
      openMyProducts();
      return;
    }
  } catch (e) {
    console.warn('[claimFreeProduct] ownership check failed:', e);
    // Fail open — a transient read error shouldn't block a legitimate claim.
  }

  const fullProd = (DB.getById ? DB.getById('products', prod.id) : null) || prod;
  const orderId  = 'FREE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

  try {
    const purchase = await Purchases.add(
      user.id, user.email,
      {
        id:       prod.id,
        name:     prod.variantLabel ? `${prod.name} — ${prod.variantLabel}` : prod.name,
        images:   fullProd.images || [],
        category: fullProd.category || '',
      },
      {
        customerName:  user.name  || '',
        customerEmail: user.email || '',
        paymentMethod: 'free',
        orderId,
        variantLabel:  prod.variantLabel || null,
      }
    );

    if (fullProd.autoDeliver && fullProd.deliveryLink) {
      const dtype = fullProd.deliveryType === 'pdf' ? 'pdf' : 'link';
      const accessData = {
        '_DeliveryType': dtype,
        'Download Link': fullProd.deliveryLink,
      };
      // Multi-file delivery: attach the full file list (if any) so My Products
      // can offer every uploaded file, not just the first one.
      if (dtype === 'pdf' && Array.isArray(fullProd.deliveryFiles) && fullProd.deliveryFiles.length) {
        accessData['_Files'] = fullProd.deliveryFiles.map(f => ({ url: f.url, name: f.name }));
      }
      await Purchases.update(purchase.id, {
        accessData,
        accessLink:   fullProd.deliveryLink,
        deliveryType: dtype,
      });
      showToast(`✅ "${prod.name}" is free — added to My Products!`);
    } else {
      showToast(`✅ "${prod.name}" added — the seller will deliver it shortly.`);
    }

    closeProductDetail();
    openMyProducts();
  } catch (err) {
    console.error('[claimFreeProduct]', err);
    showToast('❌ Something went wrong. Please try again.');
  }
}

// ===== BEST SELLERS =====
function renderBestSellers() {
  const list = document.getElementById('best-sellers-list');
  if (!list) return;
  const s = Settings.get();
  let prods = DB.getAll('products').slice();
  if (!prods.length) { const sec = document.getElementById('best-sellers'); if (sec) sec.style.display = 'none'; return; }
  prods.sort((a, b) => {
    const bb = (b.badge === 'BEST SELLER' ? 1 : 0) - (a.badge === 'BEST SELLER' ? 1 : 0);
    if (bb !== 0) return bb;
    return (b.rating || 0) - (a.rating || 0);
  });
  prods = prods.slice(0, 5);
  list.innerHTML = '';
  prods.forEach((p, i) => {
    const img = (p.images || [])[0] || generatePlaceholder(p.name, 200, 200);
    const row = document.createElement('div');
    row.className = 'bs-row';
    row.innerHTML = `
      <div class="bs-rank">${i + 1}</div>
      <div class="bs-img"><img src="${img}" alt="${p.name}" loading="lazy"/></div>
      <div class="bs-info">
        <div class="bs-name">${p.name}</div>
        <div class="bs-meta">
          ${p.rating ? `<span><i class="fa-solid fa-star"></i> ${p.rating}</span>` : ''}
          <span>${p.category || ''}</span>
        </div>
      </div>
      <div class="bs-price">${p.oldPrice ? `<span class="bs-old">${p.oldPrice.toLocaleString()} ${s.currency}</span>` : ''}${formatPrice(p.price, s.currency)}</div>`;
    row.onclick = () => { trackRecentlyViewed(p); openProductDetail(p.id, false); };
    list.appendChild(row);
  });
}

// ===== ALL PRODUCTS PAGE =====
function openAllProducts(filterCat = 'all') {
  document.getElementById('all-products-page').classList.add('active');
  document.body.classList.add('no-scroll');
  renderAllFilters(filterCat);
  renderAllProducts(filterCat);
  document.getElementById('all-products-page').scrollTo(0,0);
  const si = document.getElementById('search-input'); if (si) si.value = '';
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  const prodLink = document.querySelector('.nav-links a[data-section="products"]');
  if (prodLink) prodLink.classList.add('active');
}
function closeAllProducts() {
  document.getElementById('all-products-page').classList.remove('active');
  document.body.classList.remove('no-scroll');
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
}

function renderAllFilters(activeCat = 'all') {
  const cats = DB.getAll('categories');
  const f = document.getElementById('filter-chips'); f.innerHTML = '';
  const makeChip = (label, val) => {
    const c = document.createElement('div');
    c.className = 'chip' + (val === activeCat ? ' active' : '');
    c.textContent = label; c.dataset.cat = val;
    c.onclick = () => {
      document.querySelectorAll('#filter-chips .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      renderAllProducts(val);
    };
    return c;
  };
  f.appendChild(makeChip('All', 'all'));
  cats.forEach(c => f.appendChild(makeChip(c.name, c.name)));
}

function renderAllProducts(filterCat) {
  if (filterCat === undefined) {
    const active = document.querySelector('#filter-chips .chip.active');
    filterCat = active ? active.dataset.cat : 'all';
  }
  const q = (document.getElementById('search-input')||{}).value?.toLowerCase()||'';
  let prods = DB.getAll('products');
  if (filterCat !== 'all') prods = prods.filter(p => p.category === filterCat);
  if (q) prods = prods.filter(p => p.name.toLowerCase().includes(q) || (p.description||'').toLowerCase().includes(q));
  const g = document.getElementById('all-products-grid'); g.innerHTML = '';
  if (!prods.length) { g.innerHTML = '<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:3rem">No products found.</p>'; return; }
  prods.forEach(p => g.appendChild(makeProductCard(p)));
}

// ===== PRODUCT DETAIL =====
function openProductDetail(id, fromAllPage = true) {
  const prod = DB.getById('products', id); if (!prod) return;
  Analytics.logView(prod.id, prod.name);
  Presence.setProduct(prod.id);
  fromAll = fromAllPage || document.getElementById('all-products-page').classList.contains('active');
  const s = Settings.get();
  const imgs = (prod.images||[]).length ? prod.images : [generatePlaceholder(prod.name, 600, 450)];

  document.getElementById('product-page').classList.add('active');
  document.getElementById('product-page').scrollTo(0, 0);
  if (!fromAll) document.body.classList.add('no-scroll');

  document.getElementById('pd-cat').textContent = prod.category||'';
  document.getElementById('pd-name').textContent = prod.name;
  document.getElementById('pd-price').textContent = formatPrice(prod.price, s.currency);
  document.getElementById('pd-desc').textContent = prod.description||'';

  const oldEl = document.getElementById('pd-old'), discEl = document.getElementById('pd-disc');
  if (prod.oldPrice) {
    oldEl.textContent = prod.oldPrice.toLocaleString() + ' ' + s.currency; oldEl.style.display = '';
    discEl.textContent = `-${Math.round((1-prod.price/prod.oldPrice)*100)}%`; discEl.style.display = '';
  } else { oldEl.style.display = 'none'; discEl.style.display = 'none'; }

  const badges = document.getElementById('pd-badges'); badges.innerHTML = '';
  if (prod.badge) badges.innerHTML += `<span class="pd-badge-pill"><i class="fa-solid fa-fire"></i> ${prod.badge}</span>`;
  
  badges.innerHTML += `<span class="pd-badge-pill"><i class="fa-solid fa-shield-halved"></i> Guaranteed</span>`;
  if (prod.language) badges.innerHTML += `<span class="pd-badge-pill"><i class="fa-solid fa-language"></i> ${prod.language}</span>`;

  // Stars
  const starsEl = document.getElementById('pd-stars-row');
  if (starsEl) { starsEl.innerHTML = prod.rating ? buildStarsHtml(prod.rating, 'pd-stars') : ''; }

  const mainImg = document.getElementById('gal-main'); mainImg.src = imgs[0];
  const thumbs = document.getElementById('gal-thumbs'); thumbs.innerHTML = '';
  imgs.forEach((img, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i===0?' active':'');
    t.innerHTML = `<img src="${img}" alt=""/>`;
    t.onclick = () => {
      mainImg.style.opacity='0'; setTimeout(()=>{ mainImg.src=img; mainImg.style.opacity='1'; },200);
      document.querySelectorAll('.thumb').forEach(x=>x.classList.remove('active')); t.classList.add('active');
    };
    thumbs.appendChild(t);
  });

  const meta = document.getElementById('pd-meta'); meta.innerHTML = '';
  [['Category',prod.category||'—'],['Language',prod.language||'International'],['Added',new Date(prod.createdAt).toLocaleDateString('en-DZ')]].forEach(([l,v]) => {
    meta.innerHTML += `<div class="meta-row"><span class="meta-lbl">${l}</span><span class="meta-val">${v}</span></div>`;
  });

  // ── Variant selector ───────────────────────────────────────────
  const variantWrap   = document.getElementById('pd-variant-wrap');
  const variantGroups = document.getElementById('pd-variant-groups');
  let   activeProd    = { ...prod }; // clone — price may be overridden by variant selection

  // Build group structures: prefer prod.variables (new format), fall back to legacy prod.variants
  let groups = [];
  if (prod.variables && prod.variables.length) {
    groups = prod.variables
      .filter(grp => grp.items && grp.items.some(it => it.label))
      .map(grp => ({
        title: grp.title || 'Option',
        items: grp.items.filter(it => it.label).map(it => ({
          label: it.label,
          price: it.price != null ? it.price : prod.price
        }))
      }));
  } else if (prod.variants && prod.variants.length) {
    groups = [{ title: prod.variantName || 'Option', items: prod.variants }];
  }

  // Track selected item per group; default to first item
  const selectedByGroup = groups.map(g => g.items[0] || null);

  function computeActiveVariant() {
    const parts = selectedByGroup.map(item => item ? item.label : null).filter(Boolean);
    const variantLabel = parts.join(' / ');
    const price = selectedByGroup[0] ? (selectedByGroup[0].price ?? prod.price) : prod.price;
    activeProd = { ...prod, price, variantLabel };
    document.getElementById('pd-price').textContent = formatPrice(price, s.currency);
    updatePdActionButtons();
  }

  // Free products (price <= 0) skip cart/payment entirely — only action
  // is claiming it straight into "My Products". Re-run whenever the
  // selected variant changes price, in case a variant makes it free (or not).
  function updatePdActionButtons() {
    const isFree = (Number(activeProd.price) || 0) <= 0;
    document.getElementById('pd-add-btn').style.display  = isFree ? 'none' : '';
    document.getElementById('pd-buy-btn').style.display  = isFree ? 'none' : '';
    document.getElementById('pd-free-btn').style.display = isFree ? '' : 'none';
  }

  if (groups.length) {
    variantGroups.innerHTML = '';
    const s2 = Settings.get();
    groups.forEach((grp, gi) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:1rem';

      const lbl = document.createElement('span');
      lbl.className = 'pd-variant-label';
      lbl.textContent = grp.title.toUpperCase();
      wrap.appendChild(lbl);

      const sel = document.createElement('select');
      sel.className = 'pd-variant-select';

      grp.items.forEach((item, ii) => {
        const opt = document.createElement('option');
        opt.value = ii;
        const priceStr = item.price != null ? ' — ' + item.price.toLocaleString() + ' ' + s2.currency : '';
        opt.textContent = item.label + priceStr;
        if (ii === 0) opt.selected = true;
        sel.appendChild(opt);
      });

      sel.addEventListener('change', function() {
        const idx = parseInt(this.value);
        selectedByGroup[gi] = isNaN(idx) ? null : grp.items[idx];
        computeActiveVariant();
      });

      wrap.appendChild(sel);
      variantGroups.appendChild(wrap);
    });

    variantWrap.style.display = '';
    computeActiveVariant();
  } else {
    variantWrap.style.display = 'none';
    if (variantGroups) variantGroups.innerHTML = '';
  }

  window.onVariantChange = function() {}; // no-op, replaced by per-group listeners

  document.getElementById('pd-add-btn').onclick = () => addToCart(activeProd);
  document.getElementById('pd-buy-btn').onclick = () => {
    if ((Number(activeProd.price)||0) <= 0) { claimFreeProduct(activeProd); return; }
    addToCart(activeProd); closeProductDetail(); toggleCart();
  };
  document.getElementById('pd-free-btn').onclick = () => claimFreeProduct(activeProd);
  updatePdActionButtons(); // set correct buttons immediately, even with no variants
  const wBtn = document.getElementById('pd-wish-btn');
  const updateWBtn = () => {
    const w = Wishlist.has(activeProd.id);
    wBtn.innerHTML = w ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';
    wBtn.style.color = w ? '#EF4444' : '';
    wBtn.title = w ? 'Remove from Wishlist' : 'Add to Wishlist';
  };
  updateWBtn();
  wBtn.onclick = () => { toggleWishlist(activeProd.id, wBtn); updateWBtn(); };
  document.getElementById('pd-back').onclick = closeProductDetail;

  // Load reviews
  renderProductReviews(prod.id);
}

function closeProductDetail() {
  document.getElementById('product-page').classList.remove('active');
  document.body.classList.remove('no-scroll');
  Presence.setProduct(null);
}

// ===== SHOW MAIN =====
function showMain() {
  closeAllProducts();
  closeProductDetail();
  closeMyProducts();
  closeWishlist();
  closeTracking();
}

