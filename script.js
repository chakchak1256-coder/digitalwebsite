// ===== STATE =====
let fromAll = false;
let _firebaseResolved = false; // true only after first auth:change fires

// ===== INIT =====
// Auth listener — outside DOMContentLoaded so it catches early Firebase events
window.addEventListener('auth:change', () => {
  _firebaseResolved = true;
  initUserAuth();
});

let _pendingHashScroll = window.location.hash || '';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUserAuth();
  updateCartBadge();
  updateWishlistBadge();
  initScrollSpy();
  window.addEventListener('cart:update', () => { updateCartBadge(); _coRefreshOrderSummary(); });
  // db:update fires when Firestore data arrives — renders happen here
  window.addEventListener('db:update', () => {
    renderCats();
    renderProducts();
    renderStats();
    renderBestSellers();
    renderContactSocials();
    updateFooter();
    updateWaFloat();
    renderRecentlyViewed();
    renderSocialProof();
    initFlashBanner();
    // Re-align to the URL's target section once real content has rendered —
    // async data above it (categories/products) can shift its position after
    // the browser's initial (pre-data) anchor jump.
    if (_pendingHashScroll) {
      const target = document.querySelector(_pendingHashScroll);
      if (target) {
        requestAnimationFrame(() => target.scrollIntoView());
      }
      _pendingHashScroll = '';
    }
  });
});

window.addEventListener('scroll', () => {
  document.getElementById('nav').classList.toggle('scrolled', scrollY > 50);
});

// ===== SCROLLSPY — active nav link ====
function initScrollSpy() {
  const sections = ['hero','about','categories','products','warranty','contact'];
  const navLinks = document.querySelectorAll('.nav-links a[data-section]');
  // Map section ids to nav link data-section (categories maps to nothing visible, products maps to products)
  const map = { hero:'hero', about:'about', categories:'products', products:'products', warranty:'warranty', contact:'contact' };
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const mapped = map[e.target.id] || e.target.id;
        navLinks.forEach(a => a.classList.toggle('active', a.dataset.section === mapped));
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach(id => { const el = document.getElementById(id); if (el) obs.observe(el); });
}

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
          <span class="prod-price">${prod.price.toLocaleString()} ${s.currency}</span>
          ${prod.oldPrice ? `<span class="prod-old">${prod.oldPrice.toLocaleString()} ${s.currency}</span>` : ''}
        </div>
        <button class="prod-add" title="Add to cart"><i class="fa-solid fa-plus"></i></button>
      </div>
    </div>`;
  d.querySelector('.prod-add').onclick = e => { e.stopPropagation(); addToCart(prod); };
  d.onclick = () => { trackRecentlyViewed(prod); openProductDetail(prod.id, false); };
  return d;
}

function addToCart(prod) { Cart.add(prod); showToast(`"${prod.name}" added to cart`); }

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
      <div class="bs-price">${p.oldPrice ? `<span class="bs-old">${p.oldPrice.toLocaleString()} ${s.currency}</span>` : ''}${p.price.toLocaleString()} ${s.currency}</div>`;
    row.onclick = () => { trackRecentlyViewed(p); openProductDetail(p.id, false); };
    list.appendChild(row);
  });
}

// ===== HERO SHOWCASE =====
function renderHeroShowcase() {
  const stage = document.getElementById('hero-showcase');
  if (!stage) return;
  const cards = stage.querySelectorAll('.hv-card');
  if (!cards.length) return;
  const s = Settings.get();
  let prods = DB.getAll('products').slice();
  prods.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  prods = prods.slice(0, cards.length);
  cards.forEach((card, i) => {
    const p = prods[i];
    if (!p) return; // keep static fallback content if not enough products
    const img = (p.images || [])[0] || generatePlaceholder(p.name, 300, 220);
    const imgEl = card.querySelector('.hv-card-media img');
    const tagEl = card.querySelector('.hv-card-tag');
    const nameEl = card.querySelector('.hv-card-name');
    const priceEl = card.querySelector('.hv-card-price');
    if (imgEl) imgEl.src = img;
    if (tagEl) tagEl.textContent = p.badge || p.category || 'Featured';
    if (nameEl) nameEl.textContent = p.name;
    if (priceEl) priceEl.textContent = `${p.price.toLocaleString()} ${s.currency}`;
    card.onclick = () => { trackRecentlyViewed(p); openProductDetail(p.id, false); };
    card.style.cursor = 'pointer';
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
  document.getElementById('wishlist-page').classList.remove('active');
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
  fromAll = fromAllPage || document.getElementById('all-products-page').classList.contains('active');
  const s = Settings.get();
  const imgs = (prod.images||[]).length ? prod.images : [generatePlaceholder(prod.name, 600, 450)];

  document.getElementById('product-page').classList.add('active');
  document.getElementById('product-page').scrollTo(0, 0);
  if (!fromAll) document.body.classList.add('no-scroll');

  document.getElementById('pd-cat').textContent = prod.category||'';
  document.getElementById('pd-name').textContent = prod.name;
  document.getElementById('pd-price').textContent = prod.price.toLocaleString() + ' ' + s.currency;
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
    document.getElementById('pd-price').textContent = price.toLocaleString() + ' ' + s.currency;
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
  document.getElementById('pd-buy-btn').onclick = () => { addToCart(activeProd); closeProductDetail(); toggleCart(); };
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
}

// ===== SHOW MAIN =====
function showMain() {
  closeAllProducts();
  closeProductDetail();
  closeMyProducts();
  closeWishlist();
  closeTracking();
}

// ===== CART =====
function toggleCart() {
  const ov = document.getElementById('cart-overlay');
  const dr = document.getElementById('cart-drawer');
  ov.classList.toggle('open'); dr.classList.toggle('open');
  if (dr.classList.contains('open')) { renderCartItems(); document.body.classList.add('no-scroll'); }
  else document.body.classList.remove('no-scroll');
}

function renderCartItems() {
  const items = Cart.get(); const s = Settings.get();
  const body = document.getElementById('cart-body');
  const foot = document.getElementById('cart-foot');
  if (!items.length) {
    body.innerHTML = `<div class="cart-empty"><i class="fa-solid fa-bag-shopping"></i><p>Your cart is empty</p><button class="btn btn-primary" style="margin-top:.5rem" onclick="toggleCart();document.getElementById('products').scrollIntoView({behavior:'smooth'})">Browse Products</button></div>`;
    foot.style.display = 'none'; return;
  }
  foot.style.display = 'block'; body.innerHTML = '';
  items.forEach(item => {
    const d = document.createElement('div'); d.className = 'cart-item';
    const img = item.img || generatePlaceholder(item.name, 60, 60);
    d.innerHTML = `
      <div class="cart-item-img"><img src="${img}" alt=""/></div>
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">${(item.price*item.qty).toLocaleString()} ${s.currency}</div>
        <div class="cart-item-row">
          <button class="qty-btn" onclick="changeQty('${item.id}',-1)"><i class="fa-solid fa-minus"></i></button>
          <span class="qty-num">${item.qty}</span>
          <button class="qty-btn" onclick="changeQty('${item.id}',1)"><i class="fa-solid fa-plus"></i></button>
          <button class="cart-del" onclick="removeItem('${item.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    body.appendChild(d);
  });
  document.getElementById('cart-total-val').textContent = Cart.total().toLocaleString() + ' ' + s.currency;
}

function changeQty(id, d) { Cart.setQty(id, (Cart.get().find(i=>i.id===id)?.qty||1)+d); renderCartItems(); }
function removeItem(id) { Cart.remove(id); renderCartItems(); }
function updateCartBadge() { const c=Cart.count(); const b=document.getElementById('cart-badge'); b.textContent=c; b.style.display=c?'flex':'none'; }

// ===== CHECKOUT =====
let _coProofFiles = []; // proof screenshots (File objects or data URLs)
let _coUseAccount = false;

function openCheckout() {
  const user = UserAuth.current();
  if (!user) { openLoginModal('checkout'); return; }
  document.getElementById('checkout-modal').classList.add('open');
  // Skip step 0 — go straight to form, auto-fill from account if available
  coChooseAccount(!!user);
}

function _showCoStep(step) {
  // step: 'account' | 'form' | 'proof' | 'success'
  document.getElementById('co-step-account').style.display  = step === 'account'  ? '' : 'none';
  document.getElementById('co-form-wrap').style.display     = step === 'form'     ? '' : 'none';
  document.getElementById('co-payment-step').style.display  = step === 'proof'    ? '' : 'none';
  document.getElementById('co-success').style.display       = step === 'success'  ? 'block' : 'none';

  if (step === 'success') {
    // Wire up buttons here so they always work regardless of DOM state
    const myProdsBtn = document.getElementById('co-success-myprods-btn');
    const continueBtn = document.getElementById('co-success-continue-btn');
    if (myProdsBtn) myProdsBtn.onclick = () => { _doCloseCheckout(); openMyProducts(); };
    if (continueBtn) continueBtn.onclick = () => { _doCloseCheckout(); };
  }
}

function coChooseAccount(useAccount) {
  _coUseAccount = useAccount;
  const user = UserAuth.current();
  if (useAccount && user) {
    // Pre-fill from account
    const nameEl = document.getElementById('co-name');
    const emailEl = document.getElementById('co-email');
    const phoneEl = document.getElementById('co-phone');
    if (nameEl)  nameEl.value  = user.name  || '';
    if (emailEl) emailEl.value = user.email || '';
    // Phone stored as "07XXXXXXXX" — split into prefix dropdown + 8-digit input
    if (user.phone && user.phone.length >= 10) {
      const pfx    = user.phone.slice(0, 2); // e.g. "07"
      const digits = user.phone.slice(2);     // e.g. "12345678"
      const prefixSel = document.getElementById('co-phone-prefix');
      if (prefixSel && ['05','06','07'].includes(pfx)) prefixSel.value = pfx;
      if (phoneEl) {
        phoneEl.value = digits;
        coValidatePhone(phoneEl);
      }
    } else if (phoneEl && user.phone) {
      phoneEl.value = user.phone;
    }
    // Show email field
    document.getElementById('co-email-group').style.display = '';
  } else {
    // Manual mode — hide email (optional)
    const emailEl = document.getElementById('co-email');
    if (emailEl) emailEl.value = '';
  }
  // Load payment instructions from settings
  coLoadPaymentInstructions();
  _showCoStep('form');
  _coRefreshOrderSummary();
}

function coBackToAccountStep() {
  _showCoStep('account');
}

function coBackToInfoStep() {
  _showCoStep('form');
}

function coLoadPaymentInstructions() {
  const s = Settings.get();
  // Will be used when a payment method is selected
}

function coShowPaymentInstructions(method) {
  const s = Settings.get();
  const instrEl = document.getElementById('co-payment-instructions');
  const textEl  = document.getElementById('co-instr-text');
  const titleEl = document.getElementById('co-instr-title');
  const copyEl  = document.getElementById('co-copy-numbers');

  // Mark selected card
  document.querySelectorAll('.co-method-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById('co-method-' + method);
  if (card) card.classList.add('selected');

  // Update Next button label
  const nextBtn = document.getElementById('co-submit-btn');
  if (nextBtn) {
    if (method === 'cib') {
      nextBtn.innerHTML = '<i class="fa-solid fa-credit-card"></i> Pay with Card →';
    } else {
      nextBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Next: Payment Proof';
    }
  }

  // CIB online payment — no instruction card needed
  if (method === 'cib') {
    if (instrEl) instrEl.style.display = 'none';
    _coRefreshOrderSummary(0);
    return;
  }

  // Default numbers (used for copy buttons)
  const flexyNumbers    = [
    s.flexyNumber1    || '0540431312',
    s.flexyNumber2    || '0793051230'
  ].filter(Boolean);
  const baridimobNumbers = [
    s.baridimobNumber || '00799999004421651019'
  ].filter(Boolean);

  const defaultFlexyText     = `يرجى تحويل المبلغ المطلوب عبر خدمة فليكسي إلى أحد الأرقام التالية:\n\nبعد إتمام التحويل، قم برفع صورة أو لقطة شاشة تثبت عملية الدفع حتى يتم التحقق من طلبك ومعالجته بسرعة.`;
  const defaultBaridiText    = `يرجى تحويل المبلغ المطلوب عبر بريدي موب إلى رقم الحساب التالي:\n\nبعد إتمام التحويل، قم برفع صورة أو لقطة شاشة تثبت عملية الدفع حتى يتم التحقق من طلبك ومعالجته بسرعة.`;

  const isFlexy = method === 'flexy';
  const baseTotal = Cart.total();
  const flexyFee  = isFlexy ? Math.round(baseTotal * 0.20) : 0;
  const finalTotal = baseTotal + flexyFee;
  const currency = s.currency || 'DA';

  const flexyNote = isFlexy
    ? `\n\n⚠️ ملاحظة: يُضاف رسم خدمة 20% عند الدفع عبر فليكسي.\nالمبلغ الأصلي: ${baseTotal.toLocaleString()} ${currency} + رسوم: ${flexyFee.toLocaleString()} ${currency} = المجموع: ${finalTotal.toLocaleString()} ${currency}`
    : '';

  const text = isFlexy
    ? (s.flexyInstructions || defaultFlexyText) + flexyNote
    : (s.baridimobInstructions || defaultBaridiText);

  titleEl.textContent = isFlexy ? '📱 تعليمات الدفع عبر فليكسي' : '🏦 تعليمات الدفع عبر بريدي موب';
  textEl.textContent  = text;

  // Update the order summary total to reflect flexy surcharge
  _coRefreshOrderSummary(isFlexy ? 0.20 : 0);

  // Build copy-number rows
  const numbers = method === 'flexy' ? flexyNumbers : baridimobNumbers;
  if (copyEl) {
    copyEl.innerHTML = '';
    numbers.forEach((num, i) => {
      const row = document.createElement('div');
      row.className = 'co-copy-row';
      const numSpan = document.createElement('span');
      numSpan.className = 'co-copy-number';
      numSpan.textContent = num;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'co-copy-btn';
      btn.innerHTML = '<i class="fa-regular fa-copy"></i> نسخ';
      btn.onclick = function() {
        navigator.clipboard.writeText(num).then(() => {
          btn.innerHTML = '<i class="fa-solid fa-check"></i> تم النسخ';
          btn.classList.add('copied');
          showToast('✓ تم نسخ الرقم');
          setTimeout(() => { btn.innerHTML = '<i class="fa-regular fa-copy"></i> نسخ'; btn.classList.remove('copied'); }, 2200);
        }).catch(() => showToast('Copy failed'));
      };
      row.appendChild(numSpan);
      row.appendChild(btn);
      copyEl.appendChild(row);
    });
  }

  instrEl.style.display = '';
  // Scroll the instructions into view inside the checkout box's own scroll container.
  // We wait two animation frames so the order-summary re-render above has finished
  // resizing the layout first — otherwise the scroll position is calculated against
  // a stale height and the card can end up just out of view.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const scrollBox = instrEl.closest('.checkout-box-inner') || instrEl.parentElement;
      if (scrollBox) {
        const boxRect = scrollBox.getBoundingClientRect();
        const elRect = instrEl.getBoundingClientRect();
        const offset = (elRect.top - boxRect.top) - 16; // small top padding
        scrollBox.scrollBy({ top: offset, behavior: 'smooth' });
      } else {
        instrEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });
}

// ── Build order summary HTML ───────────────────────────────────
function buildOrderSummaryHTML(surchargeRate) {
  const items = Cart.get();
  const s = Settings.get();
  if (!items.length) return '';
  const rate = surchargeRate != null ? surchargeRate : (_coSurchargeRate || 0);
  let rows = items.map((item, idx) => {
    const variant = item.variantLabel ? `<div style="font-size:.74rem;color:var(--text-muted);margin-top:.1rem">Variant: ${item.variantLabel}</div>` : '';
    // Use data-cartid attribute — avoids any quote/injection issues with the id string
    return `<div style="display:flex;align-items:center;gap:.6rem;padding:.55rem 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:.86rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.name}</div>
        ${variant}
        <div style="font-size:.73rem;color:var(--text-muted);margin-top:.1rem">Qty: ${item.qty || 1}</div>
      </div>
      <div style="font-family:'Syne',sans-serif;font-size:.9rem;font-weight:700;color:var(--accent);white-space:nowrap;flex-shrink:0;margin-right:.35rem">${((item.price)*(item.qty||1)).toLocaleString()} ${s.currency||'DA'}</div>
      <button type="button" class="co-summary-remove" data-cartid="${idx}" title="Remove item"
        style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(239,68,68,.25);background:rgba(239,68,68,.07);color:#EF4444;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:.7rem;transition:all .15s ease"
        onmouseover="this.style.background='rgba(239,68,68,.18)'" onmouseout="this.style.background='rgba(239,68,68,.07)'">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>`;
  }).join('');
  const baseTotal = Cart.total();
  const feeAmount = rate > 0 ? Math.round(baseTotal * rate) : 0;
  const finalTotal = baseTotal + feeAmount;
  const feeRow = rate > 0 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:.45rem">
      <span style="font-size:.8rem;color:#F59E0B;display:flex;align-items:center;gap:.35rem"><i class="fa-solid fa-circle-exclamation" style="font-size:.72rem"></i> Flexy fee (+${Math.round(rate*100)}%)</span>
      <span style="font-family:'Syne',sans-serif;font-size:.88rem;font-weight:700;color:#F59E0B">+${feeAmount.toLocaleString()} ${s.currency||'DA'}</span>
    </div>` : '';
  // Coupon discount row (if a coupon has been applied)
  let couponRow = '';
  let couponDiscount = 0;
  if (typeof _appliedCoupon !== 'undefined' && _appliedCoupon) {
    couponDiscount = _appliedCoupon.type === 'percent'
      ? Math.round(finalTotal * _appliedCoupon.value / 100)
      : Math.min(_appliedCoupon.value, finalTotal);
    couponRow = `<div style="display:flex;justify-content:space-between;align-items:center;padding-top:.45rem">
      <span style="font-size:.8rem;color:#10B981;display:flex;align-items:center;gap:.35rem"><i class="fa-solid fa-tag"></i> Promo: ${_appliedCoupon.code}</span>
      <span style="font-family:'Syne',sans-serif;font-size:.88rem;font-weight:700;color:#10B981">-${couponDiscount.toLocaleString()} ${s.currency||'DA'}</span>
    </div>`;
  }
  const grandTotal = finalTotal - couponDiscount;
  return `<div style="border-radius:var(--radius-sm);background:var(--bg3);border:1px solid var(--border);padding:.85rem 1rem;margin-bottom:1rem">
    <div style="font-size:.72rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted);margin-bottom:.5rem"><i class="fa-solid fa-receipt" style="color:var(--accent)"></i> Order Summary</div>
    ${rows}
    ${feeRow}
    ${couponRow}
    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:.55rem;margin-top:.1rem;${(rate>0||couponDiscount>0)?'border-top:1px solid var(--border);':''}">
      <span style="font-size:.88rem;font-weight:700;color:var(--text)">Total</span>
      <span style="font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:800;color:var(--accent)">${grandTotal.toLocaleString()} ${s.currency||'DA'}</span>
    </div>
  </div>`;
}

function coRemoveFromSummary(itemId) {
  Cart.remove(itemId);
  updateCartBadge();
  _coRefreshOrderSummary();
  // If cart is now empty, close checkout
  if (!Cart.get().length) closeCheckout();
}

// Inject/refresh order summary into co-form-wrap
let _coSurchargeRate = 0; // 0 = none, 0.20 = flexy +20%

function _coRefreshOrderSummary(surchargeRate) {
  if (surchargeRate !== undefined) _coSurchargeRate = surchargeRate;
  const wrap = document.getElementById('co-form-wrap');
  if (!wrap) return;
  const old = document.getElementById('co-order-summary-block');
  if (old) old.remove();
  const html = buildOrderSummaryHTML(_coSurchargeRate);
  if (!html) return;
  const block = document.createElement('div');
  block.id = 'co-order-summary-block';
  block.innerHTML = html;
  // Insert before the notes group (last form-group before buttons)
  const notesGroup = wrap.querySelector('#co-notes')?.closest('.form-group');
  if (notesGroup) {
    wrap.insertBefore(block, notesGroup);
  } else {
    const btnRow = wrap.querySelector('[style*="display:flex;gap:.7rem;margin-top:1rem"]');
    if (btnRow) wrap.insertBefore(block, btnRow);
    else wrap.appendChild(block);
  }
  // Attach remove handlers using the index to look up the actual cart id
  block.querySelectorAll('.co-summary-remove').forEach(btn => {
    btn.addEventListener('click', function() {
      const idx = parseInt(this.dataset.cartid);
      const items = Cart.get();
      if (isNaN(idx) || idx >= items.length) return;
      const cartId = items[idx].id; // the real cart key (may include variant suffix)
      Cart.remove(cartId);
      updateCartBadge();
      if (!Cart.get().length) { closeCheckout(); return; }
      _coRefreshOrderSummary();
    });
  });
}

// Phone validation — 10 digits, starts with 05/06/07
function isValidAlgerianPhone(val) {
  return /^(05|06|07)\d{8}$/.test(val);
}

function coValidatePhone(input) {
  // Only allow digits, max 8 (prefix is separate)
  input.value = input.value.replace(/\D/g, '').slice(0, 8);
  const val  = input.value;
  const hint = document.getElementById('co-phone-hint');
  const icon = document.getElementById('co-phone-icon');

  if (!val) {
    hint.style.display = 'none';
    input.style.borderColor = '';
    icon.textContent = '';
    return;
  }
  if (val.length === 8) {
    hint.style.display = 'none';
    input.style.borderColor = 'rgba(16,185,129,.6)';
    icon.textContent = '✓'; icon.style.color = '#10B981';
  } else {
    // Don't show a hint while typing — just no border feedback
    hint.style.display = 'none';
    input.style.borderColor = '';
    icon.textContent = '';
  }
}

// STEP 1 → STEP 2: validate info, then show proof upload
// Route the "Next" button based on selected payment method
function coHandleNextStep() {
  const method = document.querySelector('input[name="co-payment"]:checked')?.value || '';
  if (method === 'cib') {
    coInitiateSlickPayCheckout();
  } else {
    coProceedToProofStep();
  }
}

// ── CIB/EDAHABIA online payment via SlickPay/SATIM ──────────────
async function coInitiateSlickPayCheckout() {
  const currentUser = UserAuth.current();
  if (!currentUser) { openLoginModal('checkout'); closeCheckout(); return; }
  const cartItems = Cart.get();
  if (!cartItems.length) { closeCheckout(); return; }

  const errEl = document.getElementById('co-form-err');
  errEl.style.display = 'none';

  const name         = (document.getElementById('co-name')?.value || '').trim();
  const email        = (document.getElementById('co-email')?.value || currentUser.email || '').trim();
  const phonePfx     = (document.getElementById('co-phone-prefix')?.value || '07');
  const phoneDigits  = (document.getElementById('co-phone')?.value || '').trim();
  const phone        = phonePfx + phoneDigits;

  if (!name)  { errEl.textContent = '⚠️ Please enter your full name.'; errEl.style.display = 'block'; return; }
  if (!phoneDigits || phoneDigits.length !== 8 || !/^\d{8}$/.test(phoneDigits)) {
    errEl.textContent = '⚠️ Enter exactly 8 digits after the prefix.'; errEl.style.display = 'block'; return;
  }
  if (!email) { errEl.textContent = '⚠️ Email is required for online payment.'; errEl.style.display = 'block'; return; }

  // Split name into first/last
  const nameParts = name.split(' ');
  const firstname = nameParts[0];
  const lastname  = nameParts.slice(1).join(' ') || nameParts[0];

  const s = Settings.get();
  const currency = s.currency || 'DA';
  const total = Cart.total();
  if (total <= 100) {
    errEl.textContent = '⚠️ Total must be greater than 100 DA for online payment.';
    errEl.style.display = 'block'; return;
  }

  // Build a single combined product name for the invoice
  const productName = cartItems.length === 1
    ? (cartItems[0].variantLabel ? `${cartItems[0].name} — ${cartItems[0].variantLabel}` : cartItems[0].name)
    : `${s.storeName || 'Order'} (${cartItems.length} items)`;

  const btn = document.getElementById('co-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Redirecting to payment...';

  try {
    const backendUrl = (window.DIGISTORE_BACKEND_URL || '').replace(/\/+$/, '');
    const res = await fetch(`${backendUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id:   cartItems[0]?.productId || cartItems[0]?.id || '',
        product_name: productName,
        amount:       total,
        firstname,
        lastname,
        email,
        phone,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.payment_url) {
      errEl.textContent = '⚠️ ' + (data.error || 'Payment initiation failed. Please try another method.');
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Next';
      return;
    }

    // Store order ID for the return page
    try { sessionStorage.setItem('slickpay_order_id', data.order_id); } catch {}

    // Redirect to SATIM payment page
    window.location.href = data.payment_url;

  } catch (err) {
    errEl.textContent = '⚠️ Network error. Please check your connection and try again.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Next';
  }
}

function coProceedToProofStep() {
  const currentUser = UserAuth.current();
  if (!currentUser) { openLoginModal('checkout'); closeCheckout(); return; }
  if (!Cart.get().length) { closeCheckout(); return; }

  // Clear previous error
  const errEl = document.getElementById('co-form-err');
  errEl.style.display = 'none';

  const name  = (document.getElementById('co-name')?.value || '').trim();
  const _phonePfx    = (document.getElementById('co-phone-prefix')?.value || '07');
  const _phoneDigits = (document.getElementById('co-phone')?.value || '').trim();
  const phone        = _phonePfx + _phoneDigits; // full 10-digit string, e.g. "0712345678"
  const method = document.querySelector('input[name="co-payment"]:checked')?.value || '';

  if (!name)  { errEl.textContent = '⚠️ Please enter your full name.'; errEl.style.display = 'block'; return; }
  if (!_phoneDigits) { errEl.textContent = '⚠️ Phone number is required.'; errEl.style.display = 'block'; return; }
  if (_phoneDigits.length !== 8 || !/^\d{8}$/.test(_phoneDigits)) { errEl.textContent = '⚠️ Enter exactly 8 digits after the prefix.'; errEl.style.display = 'block'; return; }
  if (!method) { errEl.textContent = '⚠️ Please select a payment method.'; errEl.style.display = 'block'; return; }

  _showCoStep('proof');
}

// Internal: close checkout cleanly without re-opening cart
function _doCloseCheckout() {
  document.getElementById('checkout-modal').classList.remove('open');
  document.body.classList.remove('no-scroll');
  _showCoStep('form');
  document.getElementById('co-success').style.display = 'none';
  _coProofFiles = [];
  const prev = document.getElementById('co-proof-previews');
  if (prev) prev.innerHTML = '';
  const errEl = document.getElementById('co-proof-error');
  if (errEl) errEl.style.display = 'none';
  document.querySelectorAll('input[name="co-payment"]').forEach(r => r.checked = false);
  document.querySelectorAll('.co-method-card').forEach(c => c.classList.remove('selected'));
  const instrEl = document.getElementById('co-payment-instructions');
  if (instrEl) instrEl.style.display = 'none';
  _coSurchargeRate = 0;
  const phoneHint = document.getElementById('co-phone-hint');
  if (phoneHint) phoneHint.style.display = 'none';
  const phoneInput = document.getElementById('co-phone');
  if (phoneInput) phoneInput.style.borderColor = '';
}

function closeCheckout() {
  _doCloseCheckout();
  // Reset any applied coupon
  if (typeof _appliedCoupon !== 'undefined') { _appliedCoupon = null; }
  const _couponInp = document.getElementById('co-coupon-input');
  if (_couponInp) _couponInp.value = '';
  const _couponFb = document.getElementById('co-coupon-feedback');
  if (_couponFb) { _couponFb.className = ''; _couponFb.textContent = ''; }
  // Re-open cart only if the success screen is NOT showing
  const successShown = document.getElementById('co-success')?.style.display === 'block';
  if (!successShown) {
    const cartOverlay = document.getElementById('cart-overlay');
    const cartDrawer = document.getElementById('cart-drawer');
    if (cartOverlay && cartDrawer && !cartDrawer.classList.contains('open')) {
      cartOverlay.classList.add('open');
      cartDrawer.classList.add('open');
      renderCartItems();
      document.body.classList.add('no-scroll');
    }
  }
}

// Handle proof file selection — convert to base64 immediately to avoid CORS/Storage issues
async function coHandleProofFiles(files) {
  const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
  for (const f of [...files]) {
    if (!allowed.includes(f.type)) continue;
    const b64 = await _fileToBase64(f);
    if (b64) { _coProofFiles.push(b64); renderProofPreviews(); }
  }
}

function coHandleProofDrop(e) {
  e.preventDefault();
  document.getElementById('co-proof-zone').style.borderColor = '';
  coHandleProofFiles(e.dataTransfer.files);
}

function renderProofPreviews() {
  const wrap = document.getElementById('co-proof-previews');
  wrap.innerHTML = '';
  _coProofFiles.forEach((file, i) => {
    const div = document.createElement('div');
    div.style.cssText = 'position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border);flex-shrink:0';
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    // All entries in _coProofFiles are base64 data URLs
    img.src = file;
    const btn = document.createElement('button');
    btn.style.cssText = 'position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;border:none;cursor:pointer;font-size:.65rem;display:flex;align-items:center;justify-content:center';
    btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    btn.onclick = () => { _coProofFiles.splice(i, 1); renderProofPreviews(); };
    div.appendChild(img); div.appendChild(btn);
    wrap.appendChild(div);
  });
}

// Convert a File to a compressed base64 data URL
function _fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      // Compress via canvas to keep Firestore doc size reasonable
      const img = new Image();
      img.onload = () => {
        const MAX = 900;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => resolve(e.target.result); // fallback: original
      img.src = e.target.result;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

// STEP 2: submit order
async function placeOrderWithProof() {
  const currentUser = UserAuth.current();
  if (!currentUser) { openLoginModal('checkout'); closeCheckout(); return; }
  const cartItems = Cart.get();
  if (!cartItems.length) { closeCheckout(); return; }

  const errEl = document.getElementById('co-proof-error');
  errEl.style.display = 'none';

  const submitBtn = document.getElementById('co-proof-submit-btn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';

  // Files are already base64 strings (converted on upload to avoid CORS/Storage issues)
  const proofBase64 = _coProofFiles.filter(Boolean);

  const customerName   = (document.getElementById('co-name')?.value || '').trim();
  const customerEmail  = (document.getElementById('co-email')?.value || currentUser.email || '').trim();
  const _coPhonePrefix = (document.getElementById('co-phone-prefix')?.value || '07');
  const _coPhoneDigits = (document.getElementById('co-phone')?.value || '').trim();
  const customerPhone  = _coPhonePrefix + _coPhoneDigits; // full string e.g. "0712345678"
  const orderNotes     = (document.getElementById('co-notes')?.value || '').trim();
  const paymentMethod  = document.querySelector('input[name="co-payment"]:checked')?.value || '';
  const products       = DB.getAll ? DB.getAll('products') : [];
  const errors = [];

  // One shared orderId ties all items in this checkout together
  const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2,7).toUpperCase();

  for (const item of cartItems) {
    const fullProd = products.find(p => p.id === item.id || p.id === item.productId) || {};
    try {
      await Purchases.add(
        currentUser.id,
        customerEmail,
        {
          id:       item.productId || item.id,
          name:     item.name,
          images:   fullProd.images || (item.img ? [item.img] : []),
          category: fullProd.category || ''
        },
        {
          proofImages:   proofBase64,
          customerName,
          customerPhone,
          customerEmail,
          paymentMethod,
          orderNotes,
          orderId,
          variantLabel:  item.variantLabel || null,
        }
      );
    } catch(err) {
      errors.push(item.name + ': ' + (err.message || String(err)));
      console.error('[Checkout] Purchases.add failed:', err);
    }
  }

  submitBtn.disabled = false;
  submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Order';

  if (errors.length) {
    errEl.textContent = '⚠️ ' + errors.join(', ');
    errEl.style.display = 'block';
    return;
  }

  // Success — close cart first so nothing sits on top
  const cartOverlay = document.getElementById('cart-overlay');
  const cartDrawer = document.getElementById('cart-drawer');
  if (cartDrawer) { cartDrawer.classList.remove('open'); }
  if (cartOverlay) { cartOverlay.classList.remove('open'); }
  Cart.clear();
  _showCoStep('success');
}

// Helper: show error inside checkout info form (legacy, now using co-form-err)
function showCheckoutError(msg) {
  const errEl = document.getElementById('co-form-err');
  if (errEl) { errEl.textContent = '⚠️ ' + msg; errEl.style.display = 'block'; }
}

// Old proceedToProofStep kept for compatibility
function proceedToProofStep(e) {
  if (e) e.preventDefault();
  coProceedToProofStep();
}

// ===== CONTACT SOCIALS =====
function renderContactSocials() {
  const s = Settings.get(); const socials = s.social||{};
  const map = { facebook:{icon:'fa-brands fa-facebook',color:'#1877f2',label:'Facebook'}, instagram:{icon:'fa-brands fa-instagram',color:'#e1306c',label:'Instagram'}, whatsapp:{icon:'fa-brands fa-whatsapp',color:'#25d366',label:'WhatsApp'}, telegram:{icon:'fa-brands fa-telegram',color:'#229ed9',label:'Telegram'}, tiktok:{icon:'fa-brands fa-tiktok',color:'#ff0050',label:'TikTok'}, youtube:{icon:'fa-brands fa-youtube',color:'#ff0000',label:'YouTube'} };
  const el = document.getElementById('contact-socials'); el.innerHTML = '';
  let any = false;
  Object.entries(map).forEach(([k,v]) => {
    if (!socials[k]) return; any = true;
    const a = document.createElement('a'); a.className='soc-link'; a.href=socials[k]; a.target='_blank';
    a.innerHTML=`<div class="soc-icon" style="background:${v.color}20;color:${v.color}"><i class="${v.icon}"></i></div><span>${v.label}</span><i class="fa-solid fa-arrow-up-right-from-square" style="margin-left:auto;color:var(--text-muted);font-size:.72rem"></i>`;
    el.appendChild(a);
  });
  if (!any) el.innerHTML = '<p style="color:var(--text-muted);font-size:.88rem">Social links coming soon — set them in admin settings.</p>';
}

// ===== UTILS =====
function updateFooter() { const el=document.getElementById('footer-copy'); if(el) el.textContent=`© ${new Date().getFullYear()} DIGITCH · All rights reserved`; }
function handleContact(e) { e.preventDefault(); document.getElementById('contact-form').style.display='none'; document.getElementById('form-ok').style.display='block'; }
function showToast(msg) { document.getElementById('toast-msg').textContent=msg; const t=document.getElementById('toast'); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }
function toggleMobileNav() { document.getElementById('mobile-nav').classList.toggle('open'); }
function closeMobileNav() { document.getElementById('mobile-nav').classList.remove('open'); }

// ===== USER AUTH (index) =====
function initUserAuth() {
  const user = UserAuth.current();

  if (user) {
    // Confirmed logged in — update everything
    _firebaseResolved = true;
    try { localStorage.setItem('dz_auth', '1'); } catch(e) {}
    document.documentElement.setAttribute('data-authed', 'true');
    const userBtn = document.getElementById('user-btn');
    if (userBtn) userBtn.style.borderColor = 'rgba(var(--primary-rgb),.5)';
    const info = document.getElementById('user-menu-info');
    if (info) info.innerHTML = `<div style="font-size:.78rem;color:var(--text-muted)">Signed in as</div><div style="font-size:.88rem;font-weight:700;margin-top:.15rem">${user.name}</div><div style="font-size:.75rem;font-family:monospace;color:var(--text-muted)">${user.email}</div>`;
  } else if (_firebaseResolved) {
    // Firebase confirmed no user — safe to clear
    localStorage.removeItem('dz_auth');
    document.documentElement.setAttribute('data-authed', 'false');
  }
  // else: Firebase not resolved yet — do nothing, keep CSS from head script
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', e => {
  const menu = document.getElementById('user-menu');
  const btn = document.getElementById('user-btn');
  if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});

function openLoginModal(context) {
  const modal = document.getElementById('auth-modal');
  modal.style.display = 'flex';
  document.getElementById('am-error').style.display = 'none';
  document.getElementById('am-login').style.display = '';
  document.getElementById('am-google-step').style.display = 'none';
  const banner = document.getElementById('am-checkout-note');
  if (banner) banner.style.display = context === 'checkout' ? 'flex' : 'none';
}
function closeLoginModal() {
  document.getElementById('auth-modal').style.display = 'none';
  document.getElementById('am-login').style.display = '';
  document.getElementById('am-google-step').style.display = 'none';
}
function showAuthModalError(msg) { const e = document.getElementById('am-error'); e.textContent = msg; e.style.display = 'block'; }

async function doGoogleSignIn() {
  document.getElementById('am-error').style.display = 'none';
  const r = await UserAuth.loginWithGoogle();
  if (r.error) { showAuthModalError(r.error); return; }
  if (r.error === null) return; // popup closed

  if (r.isNewUser) {
    // New Google user — show username + phone step
    _googleProfile = r.googleProfile;
    document.getElementById('am-login').style.display = 'none';
    document.getElementById('am-google-step').style.display = 'block';
    document.getElementById('am-gs-email-display').textContent = r.googleProfile.email;
    document.getElementById('am-gs-username').value = r.googleProfile.displayName || '';
    document.getElementById('am-gs-error').style.display = 'none';
    return;
  }

  // Returning Google user — fully logged in
  const wasCheckout = document.getElementById('am-checkout-note').style.display !== 'none';
  closeLoginModal(); initUserAuth();
  showToast('Welcome back, ' + r.user.name + '! 👋');
  if (wasCheckout) setTimeout(() => document.getElementById('checkout-modal').classList.add('open'), 300);
}

// ── Google post-signup state ───────────────────────────────────────
let _googleProfile = null;

function gsValidatePhone(input) {
  input.value = input.value.replace(/\D/g, '').slice(0, 8);
  const val = input.value;
  const hint = document.getElementById('am-gs-phone-hint');
  const icon = document.getElementById('am-gs-phone-icon');
  if (!val) {
    hint.style.display = 'block'; hint.textContent = 'Enter 8 digits after the prefix'; hint.style.color = 'var(--text-muted)';
    icon.textContent = ''; input.style.borderColor = ''; return;
  }
  if (/^\d{8}$/.test(val)) {
    hint.style.display = 'none'; input.style.borderColor = 'rgba(16,185,129,.6)'; icon.textContent = '✓'; icon.style.color = '#10B981';
  } else {
    hint.style.display = 'none'; input.style.borderColor = ''; icon.textContent = '';
  }
}

function gsGetFullPhone() {
  const prefix = document.getElementById('am-gs-phone-prefix').value;
  const digits  = document.getElementById('am-gs-phone').value.trim();
  return prefix + digits;
}

async function doCompleteGoogleSignup() {
  const username = document.getElementById('am-gs-username').value.trim();
  const phone = gsGetFullPhone();
  const errEl = document.getElementById('am-gs-error');
  errEl.style.display = 'none';

  if (!username) { errEl.textContent = 'Please enter a username.'; errEl.style.display = 'block'; return; }
  const digits = document.getElementById('am-gs-phone').value.trim();
  if (!digits || !/^\d{8}$/.test(digits)) { errEl.textContent = 'Please enter a valid 8-digit phone number.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('am-gs-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating account…';

  const r = await UserAuth.completeGoogleRegistration(_googleProfile, username, phone);
  if (r.error) {
    errEl.textContent = r.error; errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Complete Sign Up';
    return;
  }

  const wasCheckout = document.getElementById('am-checkout-note').style.display !== 'none';
  closeLoginModal(); initUserAuth();
  showToast('Welcome, ' + r.user.name + '! 🎉');
  if (wasCheckout) setTimeout(() => document.getElementById('checkout-modal').classList.add('open'), 300);
}

// ── Validation helpers ────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
function isValidPhone(digits8) {
  // Only 8 digits allowed (prefix is separate) — for signup form with prefix dropdown
  return /^\d{8}$/.test(digits8);
}
// Full Algerian phone (10 digits, starts with 05/06/07) — used in checkout
function isValidAlgerianPhoneFull(val) {
  return /^(05|06|07)\d{8}$/.test(val);
}

function validateEmailField(input, hintId, iconId) {
  const val   = input.value.trim();
  const hint  = document.getElementById(hintId);
  const icon  = iconId ? document.getElementById(iconId) : null;
  if (!val) { hint.style.display = 'none'; if (icon) icon.textContent = ''; input.style.borderColor = ''; return; }
  if (isValidEmail(val)) {
    hint.style.display = 'none';
    input.style.borderColor = 'rgba(16,185,129,.6)';
    if (icon) { icon.textContent = '✓'; icon.style.color = '#10B981'; }
  } else {
    hint.textContent = 'Enter a valid email (e.g. you@example.com)';
    hint.style.display = 'block'; hint.style.color = '#EF4444';
    input.style.borderColor = 'rgba(239,68,68,.5)';
    if (icon) { icon.textContent = '✗'; icon.style.color = '#EF4444'; }
  }
}

function validatePhoneField(input, hintId, iconId) {
  // Strip non-digits
  input.value = input.value.replace(/\D/g, '').slice(0, 8);
  const val  = input.value;
  const hint = document.getElementById(hintId);
  const icon = iconId ? document.getElementById(iconId) : null;
  if (!val) {
    hint.textContent = 'Enter 8 digits after the prefix (e.g. 07 12345678)';
    hint.style.color = 'var(--text-muted)';
    if (icon) icon.textContent = '';
    input.style.borderColor = '';
    return;
  }
  if (isValidPhone(val)) {
    hint.style.display = 'none';
    input.style.borderColor = 'rgba(16,185,129,.6)';
    if (icon) { icon.textContent = '✓'; icon.style.color = '#10B981'; }
  } else {
    hint.style.display = 'none'; // no inline counter hint
    hint.style.display = 'block'; hint.style.color = '#F59E0B';
    input.style.borderColor = 'rgba(245,158,11,.5)';
    if (icon) { icon.textContent = ''; }
    if (otpRow) otpRow.style.display = 'none';
  }
}

function updatePassStrength(val) {
  const bar  = document.getElementById('am-r-pass-bar');
  const hint = document.getElementById('am-r-pass-hint');
  if (!bar) return;
  let score = 0;
  if (val.length >= 6)  score++;
  if (val.length >= 10) score++;
  if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score++;
  if (/\d/.test(val))   score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const levels = [
    { pct: '0%',   color: '',          label: '' },
    { pct: '25%',  color: '#EF4444',   label: 'Too short' },
    { pct: '50%',  color: '#F59E0B',   label: 'Weak' },
    { pct: '70%',  color: '#3B82F6',   label: 'Good' },
    { pct: '90%',  color: '#10B981',   label: 'Strong' },
    { pct: '100%', color: '#10B981',   label: 'Very strong' },
  ];
  const lvl = levels[Math.min(score, 5)];
  bar.style.width = lvl.pct;
  bar.style.background = lvl.color;
  if (hint) { hint.textContent = lvl.label; hint.style.color = lvl.color || 'var(--text-muted)'; }
}

function doUserLogout() {
  UserAuth.logout(); initUserAuth();
  document.getElementById('user-menu').style.display = 'none';
  showToast('Signed out.');
}


// ===== THEME TOGGLE =====
function initTheme() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('dz_theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}


// ===== MY PRODUCTS PAGE =====
let _mpFilter = 'all';
let _mpPurchases = null; // cache for this session

function openMyProducts() {
  closeProductDetail(); // close product detail first (it's fixed z-index:810 and blocks nav)
  const page = document.getElementById('my-products-page');
  page.classList.add('active');
  document.body.classList.add('no-scroll');
  page.scrollTo(0, 0);
  _mpFilter = 'all';
  mpLoadContent();
  // Mark My Products as active in nav
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  const mpLink = document.getElementById('my-products-link');
  if (mpLink) mpLink.classList.add('active');
  const mpLinkMobile = document.getElementById('my-products-link-mobile');
  if (mpLinkMobile) mpLinkMobile.classList.add('active');
}

// If My Products is open when Firebase finally resolves, re-render
window.addEventListener('auth:change', () => {
  if (document.getElementById('my-products-page').classList.contains('active')) {
    mpLoadContent();
  }
});

function closeMyProducts() {
  document.getElementById('my-products-page').classList.remove('active');
  document.getElementById('wishlist-page').classList.remove('active');
  document.body.classList.remove('no-scroll');
  const mpLink = document.getElementById('my-products-link');
  if (mpLink) mpLink.classList.remove('active');
  const mpLinkMobile = document.getElementById('my-products-link-mobile');
  if (mpLinkMobile) mpLinkMobile.classList.remove('active');
  // Unsubscribe realtime listener to avoid memory leaks
  if (_mpUnsubscribe) { _mpUnsubscribe(); _mpUnsubscribe = null; }
}

// Holds the Firestore unsubscribe function for realtime listener
let _mpUnsubscribe = null;

async function mpLoadContent() {
  const user = UserAuth.current();

  if (!user) {
    if (localStorage.getItem('dz_auth') === '1') {
      mpShowSkeleton();
      return;
    }
    mpRenderGuest();
    return;
  }

  document.getElementById('mp-hdr-sub').textContent = 'Welcome back, ' + user.name;

  // Tear down any existing listener before creating a new one
  if (_mpUnsubscribe) { _mpUnsubscribe(); _mpUnsubscribe = null; }

  // Show cached data instantly while Firestore connects
  const cacheKey = 'dz_mp_' + user.id;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      _mpPurchases = JSON.parse(cached);
      mpRenderStats(_mpPurchases);
      mpRenderChips(_mpPurchases);
      mpRenderList();
    } else {
      mpShowSkeleton();
    }
  } catch(e) { mpShowSkeleton(); }

  // Start realtime listener — updates UI instantly when admin delivers a product
  try {
    _mpUnsubscribe = Purchases.onSnapshotForUser(user.id, (purchases) => {
      _mpPurchases = purchases;
      try { sessionStorage.setItem(cacheKey, JSON.stringify(purchases)); } catch(ex) {}
      mpRenderStats(purchases);
      mpRenderChips(purchases);
      mpRenderList();
    });
  } catch(e) {
    // Fallback: one-time fetch if realtime not available (e.g. file://)
    const purchases = await Purchases.forUser(user.id);
    _mpPurchases = purchases;
    try { sessionStorage.setItem(cacheKey, JSON.stringify(purchases)); } catch(ex) {}
    mpRenderStats(purchases);
    mpRenderChips(purchases);
    mpRenderList();
  }
}

function mpShowSkeleton() {
  const grid = document.getElementById('mp-products-grid');
  grid.innerHTML = [1,2,3,4,5,6].map(() => `
    <div class="mp-skeleton">
      <div class="sk-img"></div>
      <div class="sk-body">
        <div class="sk-line"></div>
        <div class="sk-line short"></div>
        <div class="sk-line" style="width:80%;height:28px;border-radius:6px;margin-top:.5rem"></div>
      </div>
    </div>`).join('');
}

function mpRenderGuest() {
  document.getElementById('mp-stats-row').innerHTML = '';
  document.getElementById('mp-type-chips').innerHTML = '';
  document.getElementById('mp-hdr-sub').textContent = 'Sign in to access your library';
  document.getElementById('mp-products-grid').innerHTML = `
    <div class="mp-empty" style="grid-column:1/-1">
      <i class="fa-solid fa-lock"></i>
      <h3>Sign in to see your products</h3>
      <p>Create a free account or sign in to access your purchased products.</p>
      <button class="btn btn-primary" onclick="openLoginModal()"><i class="fa-solid fa-user"></i> Sign In / Register</button>
    </div>`;
}

function mpRenderStats(purchases) {
  const types = [...new Set(purchases.map(p => p.productType))];
  document.getElementById('mp-stats-row').innerHTML = `
    <div class="mp-stat">
      <div class="mp-stat-icon"><i class="fa-solid fa-box-archive"></i></div>
      <div><div class="mp-stat-num">${purchases.length}</div><div class="mp-stat-label">Total Products</div></div>
    </div>
    <div class="mp-stat">
      <div class="mp-stat-icon"><i class="fa-solid fa-tags"></i></div>
      <div><div class="mp-stat-num">${types.length}</div><div class="mp-stat-label">Categories</div></div>
    </div>
    <div class="mp-stat">
      <div class="mp-stat-icon"><i class="fa-solid fa-link"></i></div>
      <div><div class="mp-stat-num">${purchases.filter(p => p.accessLink).length}</div><div class="mp-stat-label">With Access Link</div></div>
    </div>`;
}

function mpRenderChips(purchases) {
  const types = [...new Set(purchases.map(p => p.productType).filter(Boolean))];
  const container = document.getElementById('mp-type-chips');
  container.innerHTML = '';
  types.forEach(t => {
    const chip = document.createElement('button');
    chip.className = 'chip'; chip.dataset.filter = t; chip.textContent = t;
    chip.onclick = () => mpSetFilter(chip, t);
    container.appendChild(chip);
  });
}

function mpSetFilter(el, val) {
  _mpFilter = val;
  document.querySelectorAll('#mp-filter-bar .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  mpRenderList();
}

function mpRenderList() {
  if (!_mpPurchases) return;
  const q = (document.getElementById('mp-search-input').value || '').toLowerCase();
  let list = _mpPurchases;
  if (_mpFilter !== 'all') list = list.filter(p => p.productType === _mpFilter);
  if (q) list = list.filter(p => (p.productName + ' ' + (p.productType||'')).toLowerCase().includes(q));
  const grid = document.getElementById('mp-products-grid');
  if (!list.length) {
    grid.innerHTML = `<div class="mp-empty">
      <i class="fa-solid fa-box-open"></i>
      <h3>${_mpFilter === 'all' && !q ? 'No purchases yet' : 'No results found'}</h3>
      <p>${_mpFilter === 'all' && !q ? 'Your purchased products appear here after checkout.' : 'Try a different filter or search term.'}</p>
      ${_mpFilter === 'all' && !q ? '<button class="btn btn-primary" onclick="closeMyProducts()"><i class="fa-solid fa-store"></i> Browse Store</button>' : ''}
    </div>`;
    return;
  }
  grid.innerHTML = '';
  list.forEach(p => grid.appendChild(mpMakeCard(p)));
}

function mpMakeCard(purchase) {
  const card = document.createElement('div');
  card.className = 'purchase-card';
  const img = purchase.productImage || generatePlaceholder(purchase.productName || 'Product', 400, 225);
  const ts = purchase.purchaseDate?.toDate?.() || purchase.purchaseDate || purchase.createdAt;
  const date = new Date(ts).toLocaleDateString('en-DZ', { year:'numeric', month:'short', day:'numeric' });
  const typeIcon = mpGetTypeIcon(purchase.productType);
  const hasLink = purchase.accessLink && purchase.accessLink.trim();
  const accessLabel = mpGetAccessLabel(purchase.productType);
  const safeLink = (purchase.accessLink||'').replace(/'/g, "\'").replace(/"/g, '&quot;');
  card.innerHTML = `
    <div class="pc-image">
      <img src="${img}" alt="${purchase.productName}" loading="lazy"/>
      <span class="pc-type-badge">${typeIcon} ${purchase.productType || 'Digital'}</span>
    </div>
    <div class="pc-body">
      <div class="pc-name">${purchase.productName}</div>
      <div class="pc-date"><i class="fa-regular fa-calendar"></i> Purchased ${date}</div>
      <div class="pc-actions">
        <button class="pc-access-btn" onclick="mpOpenDetailModal(_mpPurchases.find(p=>p.id==='${purchase.id}') || {id:'${purchase.id}'})">
          <i class="fa-solid fa-circle-info"></i> More Info
        </button>
      </div>
    </div>`;
  // click handled by More Info button
  return card;
}

function mpGetTypeIcon(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('stream')||t.includes('netflix')||t.includes('disney')) return '🎬';
  if (t.includes('music')||t.includes('spotify')) return '🎵';
  if (t.includes('ebook')||t.includes('book')) return '📚';
  if (t.includes('design')||t.includes('canva')) return '🎨';
  if (t.includes('vpn')||t.includes('security')) return '🔒';
  if (t.includes('gaming')||t.includes('game')) return '🎮';
  if (t.includes('template')) return '📄';
  return '📦';
}
function mpGetAccessLabel(type) {
  return 'Download';
}
function mpOpenAccess(link) {
  if (link.startsWith('http')) window.open(link, '_blank');
}
function mpCopyAccess(id, link) {
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById('copy-' + id);
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!'; setTimeout(() => { btn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy'; }, 2000); }
    showToast('Copied to clipboard!');
  }).catch(() => showToast('Copy failed.'));
}
function mpOpenDetailModal(purchase) {
  const ts = purchase.purchaseDate?.toDate?.() || purchase.purchaseDate || purchase.createdAt;
  const date = ts ? new Date(ts).toLocaleString('en-DZ') : '—';
  const img = purchase.productImage || generatePlaceholder(purchase.productName || 'Product', 400, 225);

  const dtype = purchase.deliveryType || 'credentials';
  const hasAccessData = purchase.accessData && Object.keys(purchase.accessData).filter(k => k !== '_note').length > 0;
  const hasAccessLink = purchase.accessLink && purchase.accessLink.trim();
  const note = purchase.deliverNote || (purchase.accessData && purchase.accessData['_note']) || '';
  let accessHtml = '';

  // Helper: open/copy button
  const openCopyBtns = (url, label = 'Open') => {
    const safe = (url||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return `<div style="display:flex;gap:.5rem;margin-top:.75rem">
      <button class="btn btn-primary" style="flex:1;padding:9px;font-size:.82rem" onclick="window.open('${safe}','_blank')"><i class="fa-solid fa-external-link-alt"></i> ${label}</button>
      <button class="btn btn-outline" style="flex:1;padding:9px;font-size:.82rem" onclick="navigator.clipboard.writeText('${safe}').then(()=>showToast('Copied!'))"><i class="fa-regular fa-copy"></i> Copy Link</button>
    </div>`;
  };

  if (hasAccessData || hasAccessLink) {
    const data = purchase.accessData || {};

    if (dtype === 'pdf' || (dtype === 'credentials' && (data['Download Link'] || data['File']))) {
      const url = data['Download Link'] || data['File'] || hasAccessLink;
      const fname = data['File Name'] || '';
      accessHtml = `<div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:var(--radius-sm);padding:1rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem">
          <i class="fa-solid fa-file-pdf" style="font-size:1.3rem;color:#EF4444"></i>
          <div><div style="font-size:.75rem;color:#EF4444;font-weight:700;text-transform:uppercase;letter-spacing:.06em">PDF / File</div>${fname?`<div style="font-size:.82rem;color:var(--text-muted)">${fname}</div>`:''}</div>
        </div>
        ${openCopyBtns(url, 'Download / Open')}
      </div>`;
    } else if (dtype === 'canva') {
      const url = data['Canva Template'] || data['Template Link'] || hasAccessLink;
      const tname = data['Template Name'] || '';
      accessHtml = `<div style="background:rgba(124,58,237,.06);border:1px solid rgba(124,58,237,.2);border-radius:var(--radius-sm);padding:1rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem">
          <i class="fa-brands fa-creative-commons" style="font-size:1.3rem;color:#7C3AED"></i>
          <div><div style="font-size:.75rem;color:#7C3AED;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Canva Template</div>${tname?`<div style="font-size:.82rem;color:var(--text-muted)">${tname}</div>`:''}</div>
        </div>
        <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:.4rem;line-height:1.5">Click to open your editable Canva template. You'll get your own copy to customize.</div>
        ${openCopyBtns(url, 'Open in Canva')}
      </div>`;
    } else if (dtype === 'ebook') {
      const url = data['Download Link'] || hasAccessLink;
      const title = data['Ebook Title'] || purchase.productName || '';
      const author = data['Author'] || '';
      accessHtml = `<div style="background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.2);border-radius:var(--radius-sm);padding:1rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem">
          <i class="fa-solid fa-book-open" style="font-size:1.3rem;color:#3B82F6"></i>
          <div><div style="font-size:.75rem;color:#3B82F6;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Ebook</div>${title?`<div style="font-size:.88rem;font-weight:600;color:var(--text)">${title}</div>`:''} ${author?`<div style="font-size:.78rem;color:var(--text-muted)">by ${author}</div>`:''}</div>
        </div>
        ${openCopyBtns(url, 'Download Ebook')}
      </div>`;
    } else if (dtype === 'link') {
      const url = data['Link'] || hasAccessLink;
      accessHtml = `<div style="background:rgba(var(--accent-rgb),.06);border:1px solid rgba(var(--accent-rgb),.2);border-radius:var(--radius-sm);padding:1rem">
        <div style="font-size:.75rem;color:var(--accent);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:.5rem"><i class="fa-solid fa-link"></i> Access Link</div>
        <div style="font-size:.84rem;word-break:break-all;background:rgba(0,0,0,.15);padding:.55rem .8rem;border-radius:8px;border:1px solid var(--border);font-family:monospace;color:var(--accent)">${url}</div>
        ${openCopyBtns(url, 'Open Link')}
      </div>`;
    } else {
      // credentials / custom — show key-value cards
      const filteredEntries = Object.entries(data).filter(([k]) => k !== '_note');
      const rows = filteredEntries.map(([lbl, val]) => {
        const safeVal = (val||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
        const isUrl = (val||'').startsWith('http');
        return `<div style="margin-bottom:.7rem">
          <div style="font-size:.7rem;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.28rem">${lbl}</div>
          <div style="display:flex;align-items:center;gap:.4rem">
            <div style="flex:1;font-size:.88rem;word-break:break-all;background:rgba(0,0,0,.15);padding:.5rem .75rem;border-radius:8px;border:1px solid var(--border);font-family:monospace;color:var(--accent)">${val||'—'}</div>
            ${val ? `<button style="flex-shrink:0;background:rgba(var(--accent-rgb),.1);color:var(--accent);border:1px solid rgba(var(--accent-rgb),.2);padding:6px 10px;border-radius:6px;font-size:.75rem;cursor:pointer" onclick="navigator.clipboard.writeText('${safeVal}').then(()=>showToast('Copied!'))"><i class="fa-regular fa-copy"></i></button>` : ''}
            ${isUrl ? `<button style="flex-shrink:0;background:rgba(var(--accent-rgb),.1);color:var(--accent);border:1px solid rgba(var(--accent-rgb),.2);padding:6px 10px;border-radius:6px;font-size:.75rem;cursor:pointer" onclick="window.open('${safeVal}','_blank')"><i class="fa-solid fa-external-link-alt"></i></button>` : ''}
          </div>
        </div>`;
      }).join('');
      accessHtml = `<div style="background:rgba(var(--accent-rgb),.06);border:1px solid rgba(var(--accent-rgb),.2);border-radius:var(--radius-sm);padding:1rem">
        <div style="font-size:.75rem;color:var(--accent);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:.75rem"><i class="fa-solid fa-key"></i> Access Information</div>
        ${rows}
      </div>`;
    }

    // Append note if any
    if (note) {
      accessHtml += `<div style="margin-top:.8rem;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:var(--radius-sm);padding:.75rem 1rem;font-size:.83rem;color:var(--text);line-height:1.6">
        <i class="fa-solid fa-circle-info" style="color:#F59E0B;margin-right:.4rem"></i> ${note}
      </div>`;
    }
  } else {
    accessHtml = `<div style="background:var(--card);border:1px dashed var(--border);border-radius:var(--radius-sm);padding:1.2rem;text-align:center;color:var(--text-muted);font-size:.85rem">
      <i class="fa-solid fa-clock" style="margin-bottom:.4rem;display:block;font-size:1.4rem;opacity:.25"></i>
      Your access information is being prepared. Check back soon!
    </div>`;
  }

  document.getElementById('mp-detail-content').innerHTML = `
    <div style="display:flex;gap:1rem;align-items:flex-start;margin-bottom:1.2rem">
      <img src="${img}" alt="" style="width:90px;height:68px;object-fit:cover;border-radius:10px;flex-shrink:0;background:var(--bg3)"/>
      <div>
        <div style="font-size:.72rem;color:var(--accent);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:.2rem">${purchase.productType || 'Digital'}</div>
        <div style="font-family:'Syne',sans-serif;font-size:1.05rem;font-weight:700;line-height:1.3">${purchase.productName || '—'}</div>
      </div>
    </div>
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:1rem;margin-bottom:1rem">
      <div style="font-size:.75rem;color:var(--text-muted);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:.6rem">Purchase Info</div>
      <div style="display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border)"><span style="font-size:.83rem;color:var(--text-muted)">Date</span><span style="font-size:.83rem;font-weight:600">${date}</span></div>
      <div style="display:flex;justify-content:space-between;padding:.3rem 0"><span style="font-size:.83rem;color:var(--text-muted)">Order ID</span><span style="font-size:.78rem;font-family:monospace;color:var(--text-muted)">${purchase.id}</span></div>
    </div>
    ${accessHtml}`;
  document.getElementById('mp-detail-modal').classList.add('open');
}



// ================================================================
// ===== FEATURE: STAR RATINGS =====
// ================================================================
function buildStarsHtml(rating, cls) {
  const r = Math.round(rating * 2) / 2; // round to 0.5
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    if (r >= i) stars += '<i class="fa-solid fa-star"></i>';
    else if (r >= i - 0.5) stars += '<i class="fa-solid fa-star-half-stroke"></i>';
    else stars += '<i class="fa-regular fa-star empty"></i>';
  }
  return `<div class="${cls}">${stars}<span class="${cls}-count">${r.toFixed(1)}</span></div>`;
}

// ================================================================
// ===== FEATURE: WISHLIST =====
// ================================================================
const Wishlist = {
  get() { try { return JSON.parse(localStorage.getItem('dz_wishlist')||'[]'); } catch { return []; } },
  _save(a) { try { localStorage.setItem('dz_wishlist', JSON.stringify(a)); } catch {} window.dispatchEvent(new Event('wishlist:update')); },
  has(id) { return this.get().includes(id); },
  add(id) { const a = this.get(); if (!a.includes(id)) { a.push(id); this._save(a); } },
  remove(id) { this._save(this.get().filter(x => x !== id)); },
  toggle(id) { this.has(id) ? this.remove(id) : this.add(id); return this.has(id); },
  count() { return this.get().length; }
};

function toggleWishlist(prodId, btn) {
  const isNow = Wishlist.toggle(prodId);
  if (btn) {
    btn.classList.toggle('active', isNow);
    btn.innerHTML = `<i class="${isNow?'fa-solid':'fa-regular'} fa-heart"></i>`;
    btn.title = isNow ? 'Remove from wishlist' : 'Add to wishlist';
  }
  updateWishlistBadge();
  showToast(isNow ? '❤️ Added to wishlist' : 'Removed from wishlist');
}

function updateWishlistBadge() {
  const c = Wishlist.count();
  const b = document.getElementById('wishlist-badge');
  if (!b) return;
  b.textContent = c;
  b.style.display = c ? 'flex' : 'none';
}

function openWishlist() {
  document.getElementById('wishlist-page').classList.add('active');
  document.body.classList.add('no-scroll');
  renderWishlist();
}
function closeWishlist() {
  document.getElementById('wishlist-page').classList.remove('active');
  document.body.classList.remove('no-scroll');
}
function renderWishlist() {
  const ids = Wishlist.get();
  const grid = document.getElementById('wishlist-grid');
  const prods = DB.getAll('products').filter(p => ids.includes(p.id));
  grid.innerHTML = '';
  if (!prods.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:4rem 2rem;border:1px dashed var(--border);border-radius:var(--radius)">
      <i class="fa-regular fa-heart" style="font-size:2.5rem;opacity:.2;display:block;margin-bottom:1rem"></i>
      <h3 style="color:var(--text-muted);font-size:1.1rem;margin-bottom:.4rem">Your wishlist is empty</h3>
      <p style="color:var(--text-muted);font-size:.85rem;margin-bottom:1rem">Save products you like by clicking the ❤ on any card.</p>
      <button class="btn btn-primary" onclick="closeWishlist();openAllProducts()"><i class="fa-solid fa-store"></i> Browse Products</button>
    </div>`;
    return;
  }
  prods.forEach(p => grid.appendChild(makeProductCard(p)));
}

window.addEventListener('wishlist:update', () => {
  updateWishlistBadge();
  if (document.getElementById('wishlist-page').classList.contains('active')) renderWishlist();
});

// ================================================================
// ===== FEATURE: NAV LIVE SEARCH =====
// ================================================================
let _nsDebounce = null;
function toggleNavSearch() {
  const panel = document.getElementById('nav-search-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  if (!isOpen) { setTimeout(() => document.getElementById('nav-search-q').focus(), 60); }
}
function navSearchQuery(q) {
  clearTimeout(_nsDebounce);
  _nsDebounce = setTimeout(() => {
    const res = document.getElementById('nav-search-results');
    if (!q.trim()) { res.innerHTML = '<div class="ns-empty">Start typing to search…</div>'; return; }
    const prods = DB.getAll('products').filter(p =>
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      (p.description||'').toLowerCase().includes(q.toLowerCase()) ||
      (p.category||'').toLowerCase().includes(q.toLowerCase())
    ).slice(0, 8);
    if (!prods.length) { res.innerHTML = '<div class="ns-empty">No products found.</div>'; return; }
    const s = Settings.get();
    res.innerHTML = prods.map(p => {
      const img = (p.images||[])[0] || '';
      return `<div class="ns-item" onclick="navSearchSelect('${p.id}')">
        ${img ? `<img class="ns-img" src="${img}" alt=""/>` : `<div class="ns-img" style="display:flex;align-items:center;justify-content:center;font-size:1.2rem;background:var(--bg3)">📦</div>`}
        <div class="ns-info">
          <div class="ns-name">${p.name}</div>
          <div class="ns-cat">${p.category||''}</div>
        </div>
        <div class="ns-price">${p.price.toLocaleString()} ${s.currency}</div>
      </div>`;
    }).join('');
  }, 200);
}
function navSearchSelect(id) {
  document.getElementById('nav-search-panel').classList.remove('open');
  document.getElementById('nav-search-q').value = '';
  document.getElementById('nav-search-results').innerHTML = '<div class="ns-empty">Start typing to search…</div>';
  const prod = DB.getById('products', id);
  if (prod) { trackRecentlyViewed(prod); openProductDetail(id, false); }
}
document.addEventListener('click', e => {
  const wrap = document.getElementById('nav-search-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('nav-search-panel').classList.remove('open');
  }
});

// ================================================================
// ===== FEATURE: FLASH SALE BANNER =====
// ================================================================
function initFlashBanner() {
  const s = Settings.get();
  if (!s.flashSaleEnabled || !s.flashSaleText) return;
  const endTime = s.flashSaleEnd ? new Date(s.flashSaleEnd).getTime() : null;
  if (endTime && endTime < Date.now()) return;
  const banner = document.getElementById('flash-banner');
  const textEl = document.getElementById('flash-banner-text');
  textEl.textContent = s.flashSaleText || 'Flash Sale!';
  banner.classList.add('visible');
  document.body.classList.add('flash-on');
  if (endTime) {
    const tick = () => {
      const diff = endTime - Date.now();
      if (diff <= 0) {
        banner.classList.remove('visible');
        document.body.classList.remove('flash-on');
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const sec = Math.floor((diff % 60000) / 1000);
      document.getElementById('flash-countdown').innerHTML =
        `<span class="flash-seg">${String(h).padStart(2,'0')}h</span>
         <span class="flash-seg">${String(m).padStart(2,'0')}m</span>
         <span class="flash-seg">${String(sec).padStart(2,'0')}s</span>`;
      setTimeout(tick, 1000);
    };
    tick();
  }
}
// (initFlashBanner is already wired to settings:update in DOMContentLoaded)

// ================================================================
// ===== FEATURE: COUPON / PROMO CODE =====
// ================================================================
let _appliedCoupon = null;

function applyCoupon() {
  const code = (document.getElementById('co-coupon-input').value || '').trim().toUpperCase();
  const fb = document.getElementById('co-coupon-feedback');
  if (!code) { fb.className = 'err'; fb.textContent = 'Enter a promo code.'; return; }
  const s = Settings.get();
  const coupons = s.coupons || {};
  if (!coupons[code]) {
    fb.className = 'err'; fb.textContent = '✕ Invalid or expired code.'; return;
  }
  const c = coupons[code];
  _appliedCoupon = { code, ...c };
  fb.className = 'ok';
  fb.textContent = `✓ ${c.type === 'percent' ? c.value + '% off' : c.value + ' DA off'} applied!`;
  _coRefreshOrderSummary();
}

// ================================================================
// ===== FEATURE: WHATSAPP ORDER (pre-filled cart) =====
// ================================================================
function waOrderCart() {
  const s = Settings.get();
  const wa = s.social && s.social.whatsapp;
  if (!wa) { showToast('WhatsApp not configured.'); return; }
  const items = Cart.get();
  if (!items.length) return;
  const cur = s.currency || 'DA';
  let msg = `🛒 *New Order Request*\n\n`;
  items.forEach((it, i) => {
    msg += `${i+1}. *${it.name}*${it.variantLabel ? ' — ' + it.variantLabel : ''}\n`;
    msg += `   Qty: ${it.qty} × ${it.price.toLocaleString()} ${cur} = ${(it.price*it.qty).toLocaleString()} ${cur}\n`;
  });
  msg += `\n*Total: ${Cart.total().toLocaleString()} ${cur}*`;
  if (_appliedCoupon) msg += `\n🏷 Promo: ${_appliedCoupon.code}`;
  const user = UserAuth.current();
  if (user) msg += `\n\n👤 ${user.name}\n📧 ${user.email}`;
  const phone = wa.replace(/[^0-9]/g, '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

// ================================================================
// ===== FEATURE: ORDER TRACKING =====
// ================================================================
function openTracking() {
  document.getElementById('tracking-page').classList.add('active');
  document.body.classList.add('no-scroll');
  document.getElementById('tracking-result').style.display = 'none';
  document.getElementById('tracking-error').style.display = 'none';
  document.getElementById('tracking-input').value = '';
}
function closeTracking() {
  document.getElementById('tracking-page').classList.remove('active');
  document.body.classList.remove('no-scroll');
}

async function trackOrder() {
  const raw = (document.getElementById('tracking-input').value || '').trim().toUpperCase();
  const errEl = document.getElementById('tracking-error');
  const resEl = document.getElementById('tracking-result');
  errEl.style.display = 'none';
  resEl.style.display = 'none';
  if (!raw) { errEl.textContent = 'Please enter your order ID.'; errEl.style.display = 'block'; return; }
  // Search purchases by orderId
  try {
    const snap = await _db.collection('purchases').where('orderId', '==', raw).limit(5).get();
    if (snap.empty) {
      errEl.textContent = 'No order found with this ID. Please check the ID and try again.';
      errEl.style.display = 'block';
      return;
    }
    const docs = snap.docs.map(d => d.data());
    const first = docs[0];
    const status = first.status || 'pending';
    const statusSteps = ['pending','processing','delivered'];
    const statusLabels = {
      pending:    { name: 'Order Received',   desc: 'Your order has been received and is awaiting review.', icon: 'fa-clock' },
      processing: { name: 'Verifying Payment', desc: 'We are confirming your payment and preparing your product.', icon: 'fa-spinner' },
      delivered:  { name: 'Delivered',         desc: 'Your product has been delivered. Check My Products!', icon: 'fa-circle-check' }
    };
    const curIdx = statusSteps.indexOf(status);
    const stepsHtml = statusSteps.map((s2, i) => {
      const st = statusLabels[s2] || { name: s2, desc: '', icon: 'fa-circle' };
      const cls = i < curIdx ? 'done' : i === curIdx ? 'current' : '';
      const icon = i <= curIdx ? 'fa-check' : st.icon;
      return `<div class="t-step">
        <div class="t-step-line"></div>
        <div class="t-dot ${cls}"><i class="fa-solid ${icon}"></i></div>
        <div class="t-step-info">
          <div class="t-step-name">${st.name}</div>
          <div class="t-step-desc">${st.desc}</div>
        </div>
      </div>`;
    }).join('');
    const date = first.createdAt ? new Date(first.createdAt).toLocaleDateString('en-DZ',{year:'numeric',month:'short',day:'numeric'}) : '—';
    const s3 = Settings.get();
    resEl.style.display = 'block';
    resEl.innerHTML = `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:1rem;margin-bottom:1.2rem">
        <div style="font-size:.72rem;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:.6rem">Order Details</div>
        <div style="display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border)"><span style="font-size:.83rem;color:var(--text-muted)">Order ID</span><span style="font-size:.78rem;font-family:monospace">${raw}</span></div>
        <div style="display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border)"><span style="font-size:.83rem;color:var(--text-muted)">Date</span><span style="font-size:.83rem;font-weight:600">${date}</span></div>
        <div style="display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border)"><span style="font-size:.83rem;color:var(--text-muted)">Items</span><span style="font-size:.83rem;font-weight:600">${docs.length}</span></div>
        <div style="display:flex;justify-content:space-between;padding:.3rem 0"><span style="font-size:.83rem;color:var(--text-muted)">Payment</span><span style="font-size:.83rem;font-weight:600;text-transform:capitalize">${first.paymentMethod||'—'}</span></div>
      </div>
      <div class="tracking-steps">${stepsHtml}</div>`;
  } catch(e) {
    errEl.textContent = 'Could not fetch order status. Please try again.';
    errEl.style.display = 'block';
  }
}

// ================================================================
// ===== FEATURE: REVIEWS =====
// ================================================================
let _rvSelectedStar = 0;
let _rvPurchases = null;

async function openReviewModal() {
  const user = UserAuth.current();
  const modal = document.getElementById('review-modal');
  modal.classList.add('open');

  // Reset
  _rvSelectedStar = 0;
  document.getElementById('rv-comment').value = '';
  document.getElementById('rv-error').style.display = 'none';
  document.getElementById('rv-already-reviewed').style.display = 'none';
  rvUpdateStars(0);

  // Hide all steps
  ['rv-step-product','rv-step-login','rv-step-no-purchases','rv-step-success'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  if (!user) {
    document.getElementById('rv-step-login').style.display = '';
    return;
  }

  // Load user's purchases
  try {
    const purchases = await Purchases.forUser(user.id);
    _rvPurchases = purchases;

    if (!purchases.length) {
      document.getElementById('rv-step-no-purchases').style.display = '';
      return;
    }

    // Populate dropdown (unique products only)
    const seen = new Set();
    const select = document.getElementById('rv-product-select');
    select.innerHTML = '<option value="">— Select a product —</option>';
    purchases.forEach(p => {
      const pid = p.productId || p.productName;
      if (!pid || seen.has(pid)) return;
      seen.add(pid);
      const opt = document.createElement('option');
      opt.value = p.productId || '';
      opt.dataset.name = p.productName || '';
      opt.textContent = p.productName || 'Unknown Product';
      select.appendChild(opt);
    });

    select.onchange = () => rvCheckAlreadyReviewed(select.value, user.id);
    document.getElementById('rv-step-product').style.display = '';
  } catch(e) {
    document.getElementById('rv-step-no-purchases').style.display = '';
  }
}

async function rvCheckAlreadyReviewed(productId, userId) {
  const el = document.getElementById('rv-already-reviewed');
  const btn = document.getElementById('rv-submit-btn');
  if (!productId) { el.style.display = 'none'; btn.disabled = false; return; }
  const already = await Reviews.hasReviewed(userId, productId);
  el.style.display = already ? '' : 'none';
  btn.disabled = already;
}

function rvSetStar(n) {
  _rvSelectedStar = n;
  rvUpdateStars(n);
}

function rvUpdateStars(n) {
  document.querySelectorAll('#rv-star-picker i').forEach((el, i) => {
    el.classList.toggle('empty', i >= n);
  });
}

async function submitReview() {
  const user = UserAuth.current();
  if (!user) return;

  const select = document.getElementById('rv-product-select');
  const productId = select.value;
  const productName = select.options[select.selectedIndex]?.dataset?.name || select.options[select.selectedIndex]?.textContent || '';
  const comment = document.getElementById('rv-comment').value.trim();
  const errEl = document.getElementById('rv-error');
  const btn = document.getElementById('rv-submit-btn');

  errEl.style.display = 'none';

  if (!productId) { errEl.textContent = 'Please select a product.'; errEl.style.display = ''; return; }
  if (_rvSelectedStar < 1) { errEl.textContent = 'Please select a star rating.'; errEl.style.display = ''; return; }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';

  const result = await Reviews.submit({
    userId: user.id,
    userName: user.name,
    productId,
    productName,
    stars: _rvSelectedStar,
    comment,
  });

  if (result.error) {
    errEl.textContent = 'Error: ' + result.error;
    errEl.style.display = '';
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Review';
    return;
  }

  // Show success
  document.getElementById('rv-step-product').style.display = 'none';
  document.getElementById('rv-step-success').style.display = '';
}

function closeReviewModal() {
  document.getElementById('review-modal').classList.remove('open');
}

// Render reviews section inside product detail page
async function renderProductReviews(productId) {
  const section = document.getElementById('pd-reviews-section');
  if (!section) return;

  const reviews = await Reviews.forProduct(productId);
  const list = document.getElementById('pd-reviews-list');
  const summaryEl = document.getElementById('pd-reviews-summary');
  const hdrBtn = document.getElementById('pd-reviews-write-btn');

  // Show/hide write button based on auth + purchase
  const user = UserAuth.current();
  if (hdrBtn) {
    hdrBtn.style.display = user ? '' : 'none';
    if (user) {
      hdrBtn.onclick = () => openReviewModal();
    }
  }

  if (!reviews.length) {
    if (summaryEl) summaryEl.style.display = 'none';
    if (list) list.innerHTML = '<div class="pd-reviews-empty"><i class="fa-regular fa-star" style="font-size:1.5rem;opacity:.2;display:block;margin-bottom:.5rem"></i> No reviews yet. Be the first!</div>';
    return;
  }

  const avg = reviews.reduce((s, r) => s + r.stars, 0) / reviews.length;
  if (summaryEl) {
    summaryEl.style.display = 'flex';
    summaryEl.innerHTML = `<span class="pd-reviews-avg">${avg.toFixed(1)}</span><span style="color:#F59E0B">${'<i class="fa-solid fa-star"></i>'.repeat(Math.round(avg))}</span><span style="color:var(--text-muted)">(${reviews.length} review${reviews.length>1?'s':''})</span>`;
  }

  if (list) {
    list.innerHTML = reviews.map(r => {
      const initials = (r.userName||'U').slice(0,2).toUpperCase();
      const date = new Date(r.createdAt).toLocaleDateString('en-DZ', { year:'numeric', month:'short', day:'numeric' });
      const stars = Array.from({length:5},(_,i)=>`<i class="fa-solid fa-star${i<r.stars?'':' empty'}"></i>`).join('');
      return `<div class="pd-review-card">
        <div class="pd-review-hdr">
          <div class="pd-review-user">
            <div class="pd-review-avatar">${initials}</div>
            <div>
              <div class="pd-review-name">${r.userName||'Customer'}</div>
              <div class="pd-review-date">${date}</div>
            </div>
          </div>
          <div class="pd-review-stars">${stars}</div>
        </div>
        ${r.comment ? `<div class="pd-review-text">${r.comment}</div>` : ''}
      </div>`;
    }).join('');
  }
}

// ================================================================
// ===== FEATURE: RECENTLY VIEWED / HISTORY PANEL =====
// ================================================================
function trackRecentlyViewed(prod) {
  try {
    let rv = JSON.parse(sessionStorage.getItem('dz_rv') || '[]');
    rv = rv.filter(x => x.id !== prod.id);
    rv.unshift({ id: prod.id });
    rv = rv.slice(0, 10);
    sessionStorage.setItem('dz_rv', JSON.stringify(rv));
  } catch(e) {}
  renderRecentlyViewed();
}

function renderRecentlyViewed() {
  try {
    const rv = JSON.parse(sessionStorage.getItem('dz_rv') || '[]');
    const grid = document.getElementById('rv-grid');
    const empty = document.getElementById('history-empty');
    const badge = document.getElementById('history-badge');
    if (!grid) return;
    const prods = rv.map(x => DB.getById('products', x.id)).filter(Boolean);

    if (badge) {
      if (prods.length) { badge.textContent = prods.length; badge.style.display = 'flex'; }
      else { badge.style.display = 'none'; }
    }

    if (!prods.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    const s = Settings.get();
    grid.innerHTML = prods.map(p => {
      const img = (p.images||[])[0] || generatePlaceholder(p.name, 100, 100);
      return `<div class="rv-item" data-id="${p.id}">
        <img src="${img}" alt="${p.name}" loading="lazy"/>
        <div style="flex:1;min-width:0">
          <div class="rv-item-name">${p.name}</div>
          <div class="rv-item-price">${p.price.toLocaleString()} ${s.currency}</div>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.rv-item').forEach(el => {
      el.onclick = () => {
        closeHistoryPanel();
        openProductDetail(el.dataset.id, false);
      };
    });
  } catch(e) {}
}

function toggleHistoryPanel() {
  const panel = document.getElementById('history-panel');
  const btn = document.getElementById('history-btn');
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  if (opening) {
    renderRecentlyViewed();
    panel.classList.add('open');
    if (btn) btn.classList.add('active');
    document.addEventListener('click', _historyOutsideClick);
  } else {
    closeHistoryPanel();
  }
}

function closeHistoryPanel() {
  const panel = document.getElementById('history-panel');
  const btn = document.getElementById('history-btn');
  if (panel) panel.classList.remove('open');
  if (btn) btn.classList.remove('active');
  document.removeEventListener('click', _historyOutsideClick);
}

function _historyOutsideClick(e) {
  const wrap = document.getElementById('history-wrap');
  if (wrap && !wrap.contains(e.target)) closeHistoryPanel();
}

function clearHistory() {
  try { sessionStorage.removeItem('dz_rv'); } catch(e) {}
  renderRecentlyViewed();
}

// ================================================================
// ===== FEATURE: SOCIAL PROOF (real customer reviews carousel) =====
// ================================================================
async function renderSocialProof() {
  const track = document.getElementById('testi-track');
  if (!track) return;
  let reviews = [];
  try { reviews = await Reviews.allApproved(24); } catch(e) { reviews = []; }

  if (!reviews.length) {
    track.style.animation = 'none';
    track.innerHTML = `<div class="testi-empty" id="testi-empty">
      <i class="fa-regular fa-comments"></i>
      <p>No reviews yet. Be the first to share your experience!</p>
    </div>`;
    return;
  }

  const cardHTML = (r) => {
    const stars = Array.from({length:5}, (_, i) =>
      `<i class="fa-solid fa-star${i < r.stars ? '' : ' empty'}"></i>`).join('');
    const initials = (r.userName || 'Customer').trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();
    const comment = (r.comment || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const product = (r.productName || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="testi-card">
      <div class="testi-stars">${stars}</div>
      <p class="testi-text">"${comment}"</p>
      <div class="testi-author">
        <div class="testi-avatar">${initials || 'C'}</div>
        <div>
          <div class="testi-name">${(r.userName || 'Customer').replace(/</g,'&lt;')}</div>
          <div class="testi-role">${product || 'Verified Buyer'}</div>
        </div>
      </div>
    </div>`;
  };

  // Duplicate the list so the CSS animation can loop seamlessly (translateX -50%)
  const html = reviews.map(cardHTML).join('');
  track.innerHTML = html + html;
  track.style.animation = '';

  // Scale scroll duration with content so it always feels like a smooth, steady slide
  const duration = Math.max(20, reviews.length * 6);
  track.style.setProperty('--testi-duration', duration + 's');
}

// ================================================================
// ===== EXISTING: updateWaFloat (upgrade with cart prefill) =====
// ================================================================
function updateWaFloat() {
  const s = Settings.get();
  const wa = s.social && s.social.whatsapp;
  const btn = document.getElementById('wa-float');
  const link = document.getElementById('wa-float-link');
  if (wa && btn && link) {
    // Set base href; actual cart-prefill happens via waOrderCart
    link.href = wa.startsWith('http') ? wa : 'https://wa.me/' + wa.replace(/[^0-9]/g,'');
    btn.style.display = 'block';
  } else if (btn) {
    btn.style.display = 'none';
  }
}

// ================================================================
// ===== FEATURE: DIGITAL TOOLS CAROUSEL =====
// ================================================================
(function() {
  const DIGITAL_TOOLS = [
    {
      id: 't1', label: 'Course Book', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><path d="M20 28 Q20 25 23 25 L62 25 L62 102 Q42 96 20 102 Z" fill="#EAF2ED" stroke="#3D6650" stroke-width="2.2" stroke-linejoin="round"/><path d="M68 25 L107 25 Q110 25 110 28 L110 102 Q88 96 68 102 Z" fill="#F5FAF6" stroke="#3D6650" stroke-width="2.2" stroke-linejoin="round"/><path d="M62 25 Q65 23.5 68 25 L68 102 Q65 103.5 62 102 Z" fill="#C2D9CA"/><line x1="27" y1="40" x2="56" y2="40" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="27" y1="50" x2="56" y2="50" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="27" y1="60" x2="56" y2="60" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="27" y1="70" x2="48" y2="70" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="74" y1="40" x2="103" y2="40" stroke="#B5CFB9" stroke-width="1.8" stroke-linecap="round"/><line x1="74" y1="50" x2="103" y2="50" stroke="#B5CFB9" stroke-width="1.8" stroke-linecap="round"/><line x1="74" y1="60" x2="103" y2="60" stroke="#B5CFB9" stroke-width="1.8" stroke-linecap="round"/><line x1="74" y1="70" x2="93" y2="70" stroke="#B5CFB9" stroke-width="1.8" stroke-linecap="round"/><path d="M48 25 L57 25 L57 44 L52.5 40.5 L48 44 Z" fill="#3D6650"/></svg>'
    },
    {
      id: 't2', label: 'Notebook & Pen', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><rect x="28" y="20" width="74" height="88" rx="5" fill="#EAF2ED" stroke="#3D6650" stroke-width="2"/><rect x="28" y="20" width="14" height="88" rx="5" fill="#D0E3D6" stroke="#3D6650" stroke-width="2"/><circle cx="35" cy="30" r="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><circle cx="35" cy="43" r="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><circle cx="35" cy="56" r="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><circle cx="35" cy="69" r="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><circle cx="35" cy="82" r="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><circle cx="35" cy="95" r="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><line x1="50" y1="40" x2="94" y2="40" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="50" y1="52" x2="94" y2="52" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="50" y1="64" x2="94" y2="64" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><line x1="50" y1="76" x2="80" y2="76" stroke="#8BAFA0" stroke-width="1.8" stroke-linecap="round"/><g transform="translate(72,68) rotate(-38)"><rect x="-4" y="-24" width="8" height="36" rx="2" fill="#F5F0DC" stroke="#3D3D3D" stroke-width="1.2"/><polygon points="-4,12 4,12 0,22" fill="#E8C98A" stroke="#3D3D3D" stroke-width="1"/><rect x="-4" y="-28" width="8" height="6" rx="1" fill="#D9847B"/><line x1="-4" y1="-10" x2="4" y2="-10" stroke="#3D6650" stroke-width="1"/></g></svg>'
    },
    {
      id: 't3', label: 'Spreadsheet', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><path d="M25 22 L91 22 L105 36 L105 108 Q105 111 102 111 L25 111 Q22 111 22 108 L22 25 Q22 22 25 22 Z" fill="#EAF2ED" stroke="#3D6650" stroke-width="2"/><path d="M91 22 L105 36 L91 36 Z" fill="#B5CFB9" stroke="#3D6650" stroke-width="2" stroke-linejoin="round"/><rect x="30" y="45" width="68" height="13" rx="2" fill="#3D6650"/><rect x="30" y="60" width="68" height="11" rx="1" fill="none" stroke="#8BAFA0" stroke-width="1.2"/><rect x="30" y="73" width="68" height="11" rx="1" fill="#E0EDE4"/><rect x="30" y="86" width="68" height="11" rx="1" fill="none" stroke="#8BAFA0" stroke-width="1.2"/><line x1="52" y1="45" x2="52" y2="97" stroke="#8BAFA0" stroke-width="1.2"/><line x1="74" y1="45" x2="74" y2="97" stroke="#8BAFA0" stroke-width="1.2"/><rect x="31" y="46" width="20" height="11" rx="1" fill="#3D6650"/><rect x="53" y="46" width="20" height="11" rx="1" fill="#4D7A5E"/><rect x="75" y="46" width="22" height="11" rx="1" fill="#5B8A6A"/><rect x="31" y="61" width="20" height="9" rx="1" fill="white" opacity=".7"/><rect x="53" y="61" width="20" height="9" rx="1" fill="white" opacity=".5"/><rect x="75" y="61" width="22" height="9" rx="1" fill="white" opacity=".5"/></svg>'
    },
    {
      id: 't4', label: 'Checklist', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><path d="M22 25 L82 25 L98 42 L98 105 Q98 108 95 108 L22 108 Q19 108 19 105 L19 28 Q19 25 22 25 Z" fill="#EAF2ED" stroke="#3D6650" stroke-width="2"/><path d="M82 25 L98 42 L82 42 Z" fill="#B5CFB9" stroke="#3D6650" stroke-width="2" stroke-linejoin="round"/><rect x="27" y="52" width="9" height="9" rx="2" fill="none" stroke="#3D6650" stroke-width="1.8"/><polyline points="28.5,56.5 31,59 35,53.5" stroke="#3D6650" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="42" y1="56.5" x2="88" y2="56.5" stroke="#3D6650" stroke-width="1.8" stroke-linecap="round"/><rect x="27" y="67" width="9" height="9" rx="2" fill="none" stroke="#3D6650" stroke-width="1.8"/><polyline points="28.5,71.5 31,74 35,68.5" stroke="#3D6650" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="42" y1="71.5" x2="88" y2="71.5" stroke="#3D6650" stroke-width="1.8" stroke-linecap="round"/><rect x="27" y="82" width="9" height="9" rx="2" fill="none" stroke="#3D6650" stroke-width="1.8"/><line x1="42" y1="86.5" x2="80" y2="86.5" stroke="#AACCB5" stroke-width="1.8" stroke-linecap="round"/><circle cx="89" cy="98" r="16" fill="#3D6650" stroke="white" stroke-width="2.5"/><polyline points="81,98 86.5,104 98,90" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    },
    {
      id: 't5', label: 'Files & Folders', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><rect x="18" y="52" width="94" height="62" rx="6" fill="#C2D9CA" stroke="#3D6650" stroke-width="2"/><path d="M18 62 L18 52 Q18 46 24 46 L52 46 Q58 46 62 52 L66 58 L112 58 Q118 58 118 64 L118 114 Q118 117 115 117 L21 117 Q18 117 18 114 Z" fill="#D6E9DC" stroke="#3D6650" stroke-width="2"/><rect x="26" y="68" width="22" height="30" rx="3" fill="white" stroke="#3D6650" stroke-width="1.5" opacity=".9"/><rect x="54" y="62" width="22" height="36" rx="3" fill="white" stroke="#3D6650" stroke-width="1.5"/><rect x="82" y="66" width="22" height="32" rx="3" fill="white" stroke="#3D6650" stroke-width="1.5" opacity=".85"/></svg>'
    },
    {
      id: 't6', label: 'Presentations', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><line x1="65" y1="18" x2="65" y2="26" stroke="#3D6650" stroke-width="2.5" stroke-linecap="round"/><line x1="20" y1="26" x2="110" y2="26" stroke="#3D6650" stroke-width="2.5" stroke-linecap="round"/><rect x="24" y="26" width="82" height="62" rx="4" fill="white" stroke="#3D6650" stroke-width="2"/><line x1="65" y1="88" x2="50" y2="108" stroke="#3D6650" stroke-width="2.2" stroke-linecap="round"/><line x1="65" y1="88" x2="80" y2="108" stroke="#3D6650" stroke-width="2.2" stroke-linecap="round"/><path d="M32 82 L32 46 A28 28 0 0 1 60 74 Z" fill="#3D6650"/><path d="M32 46 A28 28 0 0 1 60 74 L32 74 Z" fill="#C2D9CA"/><path d="M32 74 L60 74 A28 28 0 0 1 32 102 Z" fill="#6B9E7A"/><rect x="72" y="50" width="11" height="32" rx="2" fill="#3D6650"/><rect x="86" y="60" width="11" height="22" rx="2" fill="#6B9E7A"/><rect x="100" y="55" width="0" height="0"/><rect x="86" y="60" width="0" height="0"/></svg>'
    },
    {
      id: 't7', label: 'Digital Reader', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><rect x="28" y="16" width="74" height="98" rx="10" fill="#2D2D2D" stroke="#1A1A1A" stroke-width="1.5"/><rect x="34" y="24" width="62" height="78" rx="5" fill="#E6EFE9"/><circle cx="65" cy="107" r="4" fill="#3D3D3D"/><circle cx="65" cy="20" r="2" fill="#3D3D3D"/><rect x="40" y="32" width="50" height="5" rx="2.5" fill="#8BAFA0"/><rect x="40" y="41" width="50" height="4" rx="2" fill="#B5CFB9"/><rect x="40" y="49" width="40" height="4" rx="2" fill="#B5CFB9"/><rect x="40" y="60" width="50" height="4" rx="2" fill="#B5CFB9"/><rect x="40" y="68" width="50" height="4" rx="2" fill="#B5CFB9"/><rect x="40" y="76" width="35" height="4" rx="2" fill="#B5CFB9"/><rect x="40" y="86" width="50" height="4" rx="2" fill="#B5CFB9"/><rect x="40" y="94" width="28" height="4" rx="2" fill="#B5CFB9"/></svg>'
    },
    {
      id: 't8', label: 'Photo Gallery', color: '#4D7A5E', bg: '#EAF2ED',
      svg: '<svg viewBox="0 0 130 130" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="130" height="130" fill="#F7FAF8"/><rect x="38" y="38" width="68" height="58" rx="5" fill="#D6E9DC" stroke="#3D6650" stroke-width="2" transform="rotate(8 72 67)"/><rect x="24" y="32" width="68" height="58" rx="5" fill="white" stroke="#3D6650" stroke-width="2"/><rect x="24" y="32" width="68" height="20" rx="5" fill="#EAF2ED"/><path d="M24 52 L28 44 L36 55 L46 40 L56 56 L64 47 L75 60 L92 60 L92 85 Q92 90 87 90 L29 90 Q24 90 24 85 Z" fill="#C2D9CA"/><circle cx="78" cy="44" r="6" fill="#D6E9DC" stroke="#3D6650" stroke-width="1.5"/><path d="M30 72 L38 62 L48 74 L60 64 L74 78 L74 88 L30 88 Z" fill="#8BAFA0" opacity=".6"/><circle cx="44" cy="56" r="4" fill="#AACCB5"/></svg>'
    },
  ];

  function renderCarousel() {
    const track = document.getElementById('game-carousel-track');
    if (!track) return;
    document.getElementById('game-carousel-section').style.display = '';

    // Triple for seamless loop (extra buffer)
    const allItems = [...DIGITAL_TOOLS, ...DIGITAL_TOOLS, ...DIGITAL_TOOLS];
    track.innerHTML = allItems.map(tool => `
      <div class="carousel-item dig-tool-card" title="${tool.label}" style="--tool-color:${tool.color}">
        <div class="dig-tool-inner">
          <div class="dig-tool-icon">${tool.svg}</div>
        </div>
      </div>
    `).join('');
  }

  // JS marquee — reliable across all browsers, no CSS animation issues
  function startMarquee() {
    const track = document.getElementById('game-carousel-track');
    if (!track) return;
    const speed = 0.6; // px per frame
    let x = 0;
    let paused = false;
    let raf;

    const wrap = track.parentElement;
    wrap.addEventListener('mouseenter', () => paused = true);
    wrap.addEventListener('mouseleave', () => paused = false);

    function step() {
      if (!paused) {
        x -= speed;
        // Reset when we've scrolled through exactly 1/3 of items (since we tripled)
        const singleSetWidth = track.scrollWidth / 3;
        if (Math.abs(x) >= singleSetWidth) x = 0;
        track.style.transform = `translateX(${x}px)`;
      }
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
  }

  function init() {
    renderCarousel();
    // Short delay to let DOM paint first
    setTimeout(startMarquee, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();