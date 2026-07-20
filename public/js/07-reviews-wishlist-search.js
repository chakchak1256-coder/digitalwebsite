// Star rating widget, wishlist panel, nav live search.

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
  _save(a) {
    try { localStorage.setItem('dz_wishlist', JSON.stringify(a)); } catch {}
    window.dispatchEvent(new Event('wishlist:update'));
    // Persist to the account immediately so it survives logout/device switches —
    // previously this only happened opportunistically inside WishlistSync.load().
    if (typeof WishlistSync !== 'undefined' && UserAuth.current()) WishlistSync.save(a);
  },
  has(id) { return this.get().includes(id); },
  add(id) { const a = this.get(); if (!a.includes(id)) { a.push(id); this._save(a); } },
  remove(id) { this._save(this.get().filter(x => x !== id)); },
  toggle(id) { this.has(id) ? this.remove(id) : this.add(id); return this.has(id); },
  count() { return this.get().length; },
  // Drop any wishlisted id whose product no longer exists in the live
  // catalog. `validIds` is a Set of currently-existing product ids.
  // Saves (and syncs to Firestore for logged-in users) only if something
  // actually changed, which also fires 'wishlist:update' so the badge
  // count corrects itself automatically.
  prune(validIds) {
    const ids = this.get();
    const kept = ids.filter(id => validIds.has(id));
    if (kept.length !== ids.length) this._save(kept);
  }
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
function toggleWishlistPanel() {
  document.getElementById('wishlist-page').classList.contains('active') ? closeWishlist() : openWishlist();
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
        <div class="ns-price">${formatPrice(p.price, s.currency)}</div>
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
