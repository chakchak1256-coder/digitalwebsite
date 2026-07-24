// Global state, app init/bootstrapping, and scroll-spy nav highlighting.

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
// If the page was loaded via a shared per-product link (?product=<id>),
// open that product's detail page once the catalog has loaded.
let _pendingProductOpen = new URLSearchParams(window.location.search).get('product') || '';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUserAuth();
  updateCartBadge();
  updateWishlistBadge();
  initScrollSpy();
  Presence.start();
  CartLive.start();
  // Handle ?open= param (e.g. redirects from payment-return.html)
  (function handleOpenParam() {
    const p = new URLSearchParams(window.location.search).get('open');
    if (!p) return;
    // Remove the param from the URL bar without a page reload
    history.replaceState(null, '', window.location.pathname + window.location.hash);
    if (p === 'wishlist') { openWishlist(); }
    else if (p === 'products') { openAllProducts(); }
    else if (p === 'my-products') { openMyProducts(); }
  })();
  window.addEventListener('cart:update', () => { updateCartBadge(); _coRefreshOrderSummary(); });
  // db:update fires when Firestore data arrives — renders happen here
  window.addEventListener('db:update', () => {
    // Clean up stale references to products that were deleted by the
    // seller: drop them from anyone's cart and wishlist so people can no
    // longer buy a removed product, and the wishlist badge count stays
    // accurate. Guarded on validIds.size so this never wipes carts before
    // the product list has actually loaded.
    const validIds = new Set(DB.getAll('products').map(p => p.id));
    if (validIds.size) {
      const removedFromCart = Cart.prune(validIds);
      if (removedFromCart > 0) {
        showToast(`${removedFromCart} item${removedFromCart > 1 ? 's' : ''} removed from your cart — no longer available`);
      }
      Wishlist.prune(validIds);
    }
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
    // Deep link to a single product (e.g. someone opened a shared product link)
    if (_pendingProductOpen) {
      const sharedProd = DB.getById('products', _pendingProductOpen);
      if (sharedProd) openProductDetail(sharedProd.id, false);
      _pendingProductOpen = ''; // only try once — catalog is fully loaded by the first db:update
    }
  });
});

window.addEventListener('scroll', () => {
  document.getElementById('nav').classList.toggle('scrolled', scrollY > 50);
});

// ===== SCROLLSPY — active nav link ====
function initScrollSpy() {
  const sections = ['hero','products','best-sellers','about','warranty','contact'];
  const navLinks = document.querySelectorAll('.nav-links a[data-section]');
  // Map section ids to nav link data-section (the "products" section shows New Arrivals content)
  const map = { hero:'hero', products:'new-arrivals', 'best-sellers':'best-sellers', about:'about', warranty:'warranty', contact:'contact' };
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

