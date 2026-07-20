// Flash sale banner, coupon codes, WhatsApp cart order, order tracking, reviews, recently-viewed history, social proof carousel, WhatsApp float button, digital tools carousel.

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
        <div style="display:flex;justify-content:space-between;padding:.3rem 0"><span style="font-size:.83rem;color:var(--text-muted)">Payment</span><span style="font-size:.83rem;font-weight:600">${mpPaymentLabel(first.paymentMethod)||'—'}</span></div>
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
          <div class="rv-item-price">${formatPrice(p.price, s.currency)}</div>
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

