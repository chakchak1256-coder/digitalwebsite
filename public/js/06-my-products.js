// "My Products" page: purchase history list, filters, detail modal.

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
function mpPaymentLabel(method) {
  if (method === 'eddahabia') return '🏧 EDDAHABIA';
  if (method === 'cib')       return '💳 CIB / EDAHABIA';
  if (method === 'baridimob') return '🏦 BaridiMob';
  if (method === 'free')      return '🎁 Free';
  return method || null;
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
      // Multi-file delivery: use the full file list if present, otherwise fall
      // back to the single legacy Download Link for older purchases.
      const files = Array.isArray(data['_Files']) && data['_Files'].length
        ? data['_Files']
        : [{ url: data['Download Link'] || data['File'] || hasAccessLink || '', name: data['File Name'] || 'Download File' }];

      const fileRows = files.filter(f => f.url).map(f => {
        const fileName = f.name || 'Download File';
        return `<div style="display:flex;align-items:center;gap:.75rem;background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:8px;padding:.7rem .9rem;margin-bottom:.6rem">
          <i class="fa-solid fa-file-pdf" style="font-size:1.4rem;color:#EF4444;flex-shrink:0"></i>
          <div style="flex:1;min-width:0">
            <div style="font-size:.88rem;font-weight:700;color:var(--text);word-break:break-word">${fileName}</div>
            <div style="font-size:.72rem;color:var(--text-muted);margin-top:.1rem">Ready to download</div>
          </div>
          <a href="${f.url}" download="${fileName}" target="_blank" rel="noopener noreferrer"
            style="flex-shrink:0;display:flex;align-items:center;justify-content:center;gap:.4rem;padding:8px 14px;border-radius:var(--radius-sm);background:#EF4444;color:#fff;font-weight:700;font-size:.82rem;text-decoration:none">
            <i class="fa-solid fa-download"></i> Download
          </a>
        </div>`;
      }).join('');

      accessHtml = `<div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:var(--radius-sm);padding:1rem">
        <div style="font-size:.75rem;color:#EF4444;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.75rem">
          <i class="fa-solid fa-file-arrow-down"></i> ${files.length > 1 ? 'Your Files' : 'PDF / File'}
        </div>
        ${fileRows}
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
      ${mpPaymentLabel(purchase.paymentMethod) ? `<div style="display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--border)"><span style="font-size:.83rem;color:var(--text-muted)">Payment</span><span style="font-size:.83rem;font-weight:600">${mpPaymentLabel(purchase.paymentMethod)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;padding:.3rem 0"><span style="font-size:.83rem;color:var(--text-muted)">Order ID</span><span style="font-size:.78rem;font-family:monospace;color:var(--text-muted)">${purchase.id}</span></div>
    </div>
    ${accessHtml}`;
  document.getElementById('mp-detail-modal').classList.add('open');
}



// ================================================================
