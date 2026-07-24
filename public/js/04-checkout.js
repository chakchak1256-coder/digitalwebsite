// Multi-step checkout flow: account selection, payment method, SlickPay invoice creation, proof-of-payment upload, order placement.

// ===== CHECKOUT =====
let _coProofFiles = []; // proof screenshots (File objects or data URLs)
let _coUseAccount = false;

// SlickPay (the CIB/EDDAHABIA card gateway) always deducts a flat 40 DA
// commission from every transaction. We pass that on to the customer as a
// visible "payment processing fee" line at checkout — rather than eating it
// silently, which would just mean each sale nets less than the sticker price.
// This must match SLICKPAY_GATEWAY_FEE_DA in worker.js.
const SLICKPAY_FEE_DA = 40;

function openCheckout() {
  const user = UserAuth.current();
  if (!user) { openLoginModal('checkout'); return; }
  const validIds = new Set(DB.getAll('products').map(p => p.id));
  if (validIds.size) Cart.prune(validIds); // never let someone check out a product that was removed
  const cartItems = Cart.get();
  if (cartItems.length && Cart.total() <= 0) {
    // Entire cart is free (e.g. free items added before this update) —
    // claim everything directly, no payment step needed.
    claimFreeCart(cartItems);
    return;
  }
  document.getElementById('checkout-modal').classList.add('open');
  // Skip step 0 — go straight to form, auto-fill from account if available
  coChooseAccount(!!user);
}

async function claimFreeCart(cartItems) {
  const items = cartItems || Cart.get();
  for (const item of items) {
    await claimFreeProduct({
      id: item.productId || item.id,
      name: item.name,
      price: 0,
      variantLabel: item.variantLabel || null,
    });
  }
  Cart.clear();
  toggleCart();
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
    // Safety net: whichever flow got us here (proof order, SlickPay return,
    // or the test-payment simulator) already empties the cart, but make sure
    // the cart drawer is fully closed and cleared before moving on — it
    // shouldn't still be sitting open with old items in it.
    const closeCartDrawer = () => {
      const cartOverlay = document.getElementById('cart-overlay');
      const cartDrawer = document.getElementById('cart-drawer');
      if (cartDrawer) cartDrawer.classList.remove('open');
      if (cartOverlay) cartOverlay.classList.remove('open');
      document.body.classList.remove('no-scroll');
      Cart.clear();
    };
    if (myProdsBtn) myProdsBtn.onclick = () => { _doCloseCheckout(); closeCartDrawer(); openMyProducts(); };
    if (continueBtn) continueBtn.onclick = () => { _doCloseCheckout(); closeCartDrawer(); };
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
  coShowPaymentInstructions('cib');
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

  // CIB online payment — no instruction card needed, but SlickPay's flat
  // gateway fee applies (charged transparently, not hidden in the price)
  if (method === 'cib') {
    if (instrEl) instrEl.style.display = 'none';
    _coRefreshOrderSummary(0, SLICKPAY_FEE_DA);
    return;
  }

  // EDDAHABIA manual transfer — single fixed account/card number, no fees
  const eddahabiaNumbers = [
    s.eddahabiaNumber || '00799999004421651019'
  ].filter(Boolean);

  const defaultEddahabiaText = `يرجى تحويل المبلغ المطلوب عبر بطاقة EDDAHABIA إلى الرقم التالي:\n\nبعد إتمام التحويل، قم برفع صورة أو لقطة شاشة تثبت عملية الدفع حتى يتم التحقق من طلبك ومعالجته بسرعة.`;

  const text = (s.eddahabiaInstructions || defaultEddahabiaText);

  titleEl.textContent = '🏧 تعليمات الدفع عبر EDDAHABIA';
  textEl.textContent  = text;

  // No fees for EDDAHABIA manual transfer
  _coRefreshOrderSummary(0, 0);

  // Build copy-number rows
  const numbers = eddahabiaNumbers;
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
function buildOrderSummaryHTML(surchargeRate, surchargeFlat) {
  const items = Cart.get();
  const s = Settings.get();
  if (!items.length) return '';
  const rate = surchargeRate != null ? surchargeRate : (_coSurchargeRate || 0);
  const flat = surchargeFlat != null ? surchargeFlat : (_coSurchargeFlat || 0);
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
  const pctFeeAmount = rate > 0 ? Math.round(baseTotal * rate) : 0;
  const flatFeeAmount = flat > 0 ? flat : 0;
  const feeAmount = pctFeeAmount + flatFeeAmount;
  const finalTotal = baseTotal + feeAmount;
  const feeLabel = flatFeeAmount > 0
    ? 'Payment processing fee'
    : `Service fee (+${Math.round(rate*100)}%)`;
  const feeRow = feeAmount > 0 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:.45rem">
      <span style="font-size:.8rem;color:#F59E0B;display:flex;align-items:center;gap:.35rem"><i class="fa-solid fa-circle-exclamation" style="font-size:.72rem"></i> ${feeLabel}</span>
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
    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:.55rem;margin-top:.1rem;${(feeAmount>0||couponDiscount>0)?'border-top:1px solid var(--border);':''}">
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
let _coSurchargeRate = 0; // 0 = none (percentage-based fee, currently unused)
let _coSurchargeFlat = 0; // 0 = none (flat DA fee — used for the SlickPay/CIB gateway fee)

function _coRefreshOrderSummary(surchargeRate, surchargeFlat) {
  if (surchargeRate !== undefined) _coSurchargeRate = surchargeRate;
  if (surchargeFlat !== undefined) _coSurchargeFlat = surchargeFlat;
  const wrap = document.getElementById('co-form-wrap');
  if (!wrap) return;
  const old = document.getElementById('co-order-summary-block');
  if (old) old.remove();
  const html = buildOrderSummaryHTML(_coSurchargeRate, _coSurchargeFlat);
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

// Returns the cart items (if any) the signed-in user already owns, by
// cross-checking against their existing "My Products" purchase records
// (same product id + variant). Used to stop someone from re-buying
// something they already have.
async function coGetAlreadyOwnedCartItems(userId) {
  try {
    const owned = await Purchases.forUser(userId);
    const cartItems = Cart.get();
    return cartItems.filter(item =>
      owned.some(p =>
        p.productId === (item.productId || item.id) &&
        (p.variantLabel || '') === (item.variantLabel || '')
      )
    );
  } catch (e) {
    console.warn('[Checkout] ownership check failed:', e);
    return []; // fail open — a transient read error shouldn't block a legitimate purchase
  }
}

// Shows the "you already have this" warning in the checkout form.
// One owned item → names it. More than one → a single summary message,
// since listing every duplicate gets noisy.
function coShowAlreadyOwnedError(ownedItems) {
  const errEl = document.getElementById('co-form-err');
  if (!errEl) return;
  errEl.textContent = ownedItems.length === 1
    ? `⚠️ You already have "${ownedItems[0].name}" — check My Products.`
    : `⚠️ You already have ${ownedItems.length} of the products in your cart — check My Products. Please remove them before continuing.`;
  errEl.style.display = 'block';
}

// STEP 1 → STEP 2: validate info, then show proof upload
// Route the "Next" button based on selected payment method
async function coHandleNextStep() {
  const currentUser = UserAuth.current();
  if (currentUser) {
    const owned = await coGetAlreadyOwnedCartItems(currentUser.id);
    if (owned.length) { coShowAlreadyOwnedError(owned); return; }
  }
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
  // Digital products only — no shipping address needed from the customer.
  // SlickPay requires a non-empty address (min 5 chars) on the invoice, so
  // we send a fixed placeholder automatically.
  const address      = 'Algérie - Livraison numérique';
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
        items: cartItems.map(it => ({
          product_id:    it.productId || it.id,
          variant_label: it.variantLabel || null,
          qty:           it.qty || 1,
        })),
        user_id:      currentUser.id,
        user_email:   currentUser.email || email,
        product_id:   cartItems[0]?.productId || cartItems[0]?.id || '',
        product_name: productName,
        amount:       total + SLICKPAY_FEE_DA,
        firstname,
        lastname,
        email,
        phone,
        address,
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
  _coSurchargeFlat = 0;
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
  if (cartDrawer) cartDrawer.classList.remove('open');
  if (cartOverlay) cartOverlay.classList.remove('open');
  Cart.clear();
  _showCoStep('success');
}

function showCheckoutError(msg) {
  const errEl = document.getElementById('co-form-err');
  if (errEl) { errEl.textContent = '⚠️ ' + msg; errEl.style.display = 'block'; }
}

// Old proceedToProofStep kept for compatibility
function proceedToProofStep(e) {
  if (e) e.preventDefault();
  coProceedToProofStep();
}

