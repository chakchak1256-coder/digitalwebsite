// ================================================================
// FIREBASE.JS — Firebase Auth + Firestore (fully synced)
// ================================================================

const firebaseConfig = {
  apiKey: "AIzaSyAz6LUNMFRHOo4_pvLoB9UMg_u-VRc_RHA",
  authDomain: "generalwebsite-580f9.firebaseapp.com",
  projectId: "generalwebsite-580f9",
  storageBucket: "generalwebsite-580f9.firebasestorage.app",
  messagingSenderId: "566506288076",
  appId: "1:566506288076:web:58544c8c56cdab0df42369"
};

firebase.initializeApp(firebaseConfig);
const _auth    = firebase.auth();
const _db      = firebase.firestore();
const _storage = firebase.storage();

// ================================================================
// USER AUTH — Firebase Authentication
// ================================================================
const UserAuth = {
  _current: null,

  init() {
    _auth.onAuthStateChanged(user => {
      if (user) {
        // Dispatch auth:change immediately from Auth data so UI renders without waiting for Firestore
        this._current = { id: user.uid, email: user.email, name: user.displayName || user.email.split('@')[0] };
        window.dispatchEvent(new Event('auth:change'));
        // Then fetch Firestore users doc in background to correct email/name if needed
        // (fixes cases where Google account email differs from the registered email)
        _db.collection('users').doc(user.uid).get().then(doc => {
          if (doc.exists) {
            const data = doc.data();
            if (data.email || data.name) {
              this._current = { id: user.uid, email: data.email || user.email, name: data.name || user.displayName || user.email.split('@')[0] };
              window.dispatchEvent(new Event('auth:change'));
            }
          }
        }).catch(() => {});
      } else {
        this._current = null;
        window.dispatchEvent(new Event('auth:change'));
      }
    });
  },

  current() { return this._current; },

  async register(email, password, name, phone) {
    try {
      // ── Duplicate phone check ─────────────────────────────────
      if (phone) {
        const phoneSnap = await _db.collection('users').where('phone', '==', phone).limit(1).get();
        if (!phoneSnap.empty) {
          return { error: 'This phone number is already linked to another account.' };
        }
      }
      const cred = await _auth.createUserWithEmailAndPassword(email, password);
      const displayName = name || email.split('@')[0];
      await cred.user.updateProfile({ displayName });
      await _db.collection('users').doc(cred.user.uid).set({
        id: cred.user.uid, email: email.toLowerCase(), name: displayName,
        phone: phone || '',
        phoneVerified: !!phone,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      this._current = { id: cred.user.uid, email: cred.user.email, name: displayName, phone: phone || '' };
      window.dispatchEvent(new Event('auth:change'));
      return { user: this._current };
    } catch(e) { return { error: this._msg(e.code) }; }
  },

  async login(email, password, remember = false) {
    try {
      try {
        const persistence = remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION;
        await _auth.setPersistence(persistence);
      } catch(pe) {}
      const cred = await _auth.signInWithEmailAndPassword(email, password);
      this._current = { id: cred.user.uid, email: cred.user.email, name: cred.user.displayName || cred.user.email.split('@')[0] };
      window.dispatchEvent(new Event('auth:change'));
      return { user: this._current };
    } catch(e) { return { error: this._msg(e.code) }; }
  },

  async loginWithGoogle() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await _auth.signInWithPopup(provider);
      const user = cred.user;
      const isNew = cred.additionalUserInfo && cred.additionalUserInfo.isNewUser;

      // Check if user doc already exists with a phone (returning Google user)
      const existing = await _db.collection('users').doc(user.uid).get();
      if (existing.exists && existing.data().phone) {
        // Returning user — just update timestamp and return
        await _db.collection('users').doc(user.uid).set({
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        const data = existing.data();
        this._current = { id: user.uid, email: user.email, name: data.name || user.displayName, phone: data.phone };
        window.dispatchEvent(new Event('auth:change'));
        return { user: this._current, isNewUser: false };
      }

      // New Google user (or existing without phone) — sign them out temporarily
      // so they can complete the username+phone+OTP step before being fully registered
      await _auth.signOut();
      return {
        isNewUser: true,
        googleProfile: {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || '',
          photoURL: user.photoURL || '',
        }
      };
    } catch(e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
        return { error: null };
      }
      return { error: this._msg(e.code) };
    }
  },

  // Called after Google user completes username + phone step
  async completeGoogleRegistration(googleProfile, username, phone) {
    try {
      // Duplicate username check
      if (username) {
        const nameSnap = await _db.collection('users').where('name', '==', username).limit(1).get();
        if (!nameSnap.empty) {
          return { error: 'This username is already taken. Please choose another one.' };
        }
      }
      // Duplicate phone check
      if (phone) {
        const phoneSnap = await _db.collection('users').where('phone', '==', phone).limit(1).get();
        if (!phoneSnap.empty) {
          return { error: 'This phone number is already linked to another account.' };
        }
      }
      // Re-authenticate with Google to get credentials back
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'none', login_hint: googleProfile.email });
      const cred = await _auth.signInWithPopup(provider);
      const user = cred.user;
      const displayName = username || googleProfile.displayName || googleProfile.email.split('@')[0];
      await user.updateProfile({ displayName });
      await _db.collection('users').doc(user.uid).set({
        id: user.uid,
        email: user.email,
        name: displayName,
        phone: phone || '',
        photoURL: googleProfile.photoURL || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      this._current = { id: user.uid, email: user.email, name: displayName, phone: phone || '' };
      window.dispatchEvent(new Event('auth:change'));
      return { user: this._current };
    } catch(e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
        return { error: 'Google sign-in was cancelled. Please try again.' };
      }
      return { error: this._msg(e.code) };
    }
  },

  logout() { _auth.signOut(); this._current = null; window.dispatchEvent(new Event('auth:change')); },

  async getAll() {
    try {
      const snap = await _db.collection('users').get();
      return snap.docs.map(d => d.data());
    } catch(e) { return []; }
  },

  _msg(code) {
    console.warn('[Auth]', code);
    const m = {
      'auth/user-not-found': 'No account found with this email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/invalid-login-credentials': 'Incorrect email or password.',
      'auth/email-already-in-use': 'Email already registered.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/invalid-email': 'Invalid email address.',
      'auth/too-many-requests': 'Too many attempts. Try again later.',
      'auth/network-request-failed': 'Network error. Check your connection.',
      'auth/unsupported-persistence-type': 'Login not supported on file:// — use a local server.',
    };
    return m[code] || ('Error: ' + code);
  }
};
UserAuth.init();

// ================================================================
// PURCHASES — Firestore
// ================================================================
const Purchases = {
  async add(userId, userEmail, product, extra = {}) {
    const now = new Date().toISOString();

    // Proof images are already compressed base64 data URLs (converted in the browser
    // before this call). Store them directly in Firestore — no Firebase Storage involved,
    // which avoids CORS errors on workers.dev origins entirely.
    const proofImageUrls = (extra.proofImages || []).filter(
      s => typeof s === 'string' && s.length > 0
    );

    const doc = {
      userId, userEmail,
      productId:     product.id    || '',
      productName:   product.name  || '',
      productImage:  (product.images||[])[0] || product.productImage || '',
      productType:   product.category || extra.productType || 'Digital',
      accessLink:    extra.accessLink  || '',
      proofImages:   proofImageUrls,
      customerName:  extra.customerName  || '',
      customerPhone: extra.customerPhone || '',
      customerEmail: extra.customerEmail || userEmail || '',
      paymentMethod: extra.paymentMethod || '',
      orderNotes:    extra.orderNotes || '',
      status:        'pending',
      purchaseDate:  now,
      createdAt:     now,
      orderId:       extra.orderId || '',
      variantLabel:  extra.variantLabel || '',
    };
    const ref = await _db.collection('purchases').add(doc);
    return { ...doc, id: ref.id };
  },

  async forUser(userId) {
    try {
      const snap = await _db.collection('purchases').where('userId', '==', userId).get();
      const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      docs.sort((a, b) => {
        const ta = a.purchaseDate?.toDate?.() || new Date(a.createdAt || 0);
        const tb = b.purchaseDate?.toDate?.() || new Date(b.createdAt || 0);
        return tb - ta;
      });
      return docs;
    } catch(e) { console.error('Purchases.forUser:', e); return []; }
  },

  async getAll() {
    try {
      const snap = await _db.collection('purchases').get();
      const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      docs.sort((a, b) => {
        const ta = a.purchaseDate?.toDate?.() || new Date(a.createdAt || 0);
        const tb = b.purchaseDate?.toDate?.() || new Date(b.createdAt || 0);
        return tb - ta;
      });
      return docs;
    } catch(e) { console.error('Purchases.getAll:', e); return []; }
  },

  async delete(id) {
    try { await _db.collection('purchases').doc(id).delete(); } catch(e) { console.error(e); }
  },

  async update(id, data) {
    const patch = { ...data };
    // Only auto-set status when delivering (accessData/accessLink change),
    // and only if status is not already a cancel or picked-up state
    const preservedStatuses = ['canceled_by_client', 'canceled_by_admin', 'picked_up'];
    const existingStatus = data._existingStatus || null;
    const isPreserved = preservedStatuses.includes(existingStatus);
    delete patch._existingStatus; // internal helper, don't write to DB

    if (!isPreserved && !('status' in data)) {
      const hasAccessData = data.accessData && Object.values(data.accessData).some(v => v);
      const hasAccessLink = 'accessLink' in data && data.accessLink && data.accessLink.trim();
      if (hasAccessData || hasAccessLink) {
        patch.status = 'completed';
        patch.deliveredAt = new Date().toISOString();
      } else if ('accessLink' in data && !data.accessLink) {
        patch.status = 'pending';
        patch.deliveredAt = null;
      }
    }
    await _db.collection('purchases').doc(id).update(patch);
  },

  onSnapshotForUser(userId, callback) {
    return _db.collection('purchases').where('userId', '==', userId)
      .onSnapshot(snap => {
        const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        docs.sort((a, b) => {
          const ta = a.purchaseDate?.toDate?.() || new Date(a.createdAt || 0);
          const tb = b.purchaseDate?.toDate?.() || new Date(b.createdAt || 0);
          return tb - ta;
        });
        callback(docs);
      }, err => { console.error('onSnapshotForUser:', err); callback([]); });
  },

  onSnapshotAll(callback) {
    return _db.collection('purchases')
      .onSnapshot(snap => {
        const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        docs.sort((a, b) => {
          const ta = a.purchaseDate?.toDate?.() || new Date(a.createdAt || 0);
          const tb = b.purchaseDate?.toDate?.() || new Date(b.createdAt || 0);
          return tb - ta;
        });
        callback(docs);
      }, err => { console.error('onSnapshotAll:', err); callback([]); });
  },
};

// ================================================================
// REVIEWS — Firestore collection: reviews
// ================================================================
const Reviews = {
  // Submit a new review (one per user per product, enforced client-side)
  async submit({ userId, userName, productId, productName, stars, comment }) {
    const data = {
      userId, userName, productId, productName,
      stars, comment: comment || '',
      status: 'pending', // pending | approved | rejected
      createdAt: new Date().toISOString(),
    };
    try {
      const ref = await _db.collection('reviews').add(data);
      return { ok: true, id: ref.id };
    } catch(e) { return { error: e.message }; }
  },

  // Check if user already reviewed a product
  async hasReviewed(userId, productId) {
    try {
      const snap = await _db.collection('reviews')
        .where('userId', '==', userId)
        .where('productId', '==', productId)
        .limit(1).get();
      return !snap.empty;
    } catch(e) { return false; }
  },

  // Get approved reviews for a product
  async forProduct(productId) {
    try {
      const snap = await _db.collection('reviews')
        .where('productId', '==', productId)
        .where('status', '==', 'approved')
        .get();
      return snap.docs.map(d => ({ ...d.data(), id: d.id }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch(e) { return []; }
  },

  // Get all approved reviews across all products (for homepage social proof carousel)
  async allApproved(limit) {
    try {
      const snap = await _db.collection('reviews')
        .where('status', '==', 'approved')
        .get();
      const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return limit ? docs.slice(0, limit) : docs;
    } catch(e) { return []; }
  },

  // Admin: realtime listener for all reviews
  onSnapshotAll(callback) {
    return _db.collection('reviews')
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => {
        callback(snap.docs.map(d => ({ ...d.data(), id: d.id })));
      }, () => callback([]));
  },

  // Admin: update review status
  async updateStatus(id, status) {
    try {
      await _db.collection('reviews').doc(id).update({ status, updatedAt: new Date().toISOString() });
      // If approved, update the product rating average
      const doc = await _db.collection('reviews').doc(id).get();
      if (doc.exists) await Reviews._recalcProductRating(doc.data().productId);
      return true;
    } catch(e) { return false; }
  },

  // Admin: delete a review
  async delete(id) {
    try {
      const doc = await _db.collection('reviews').doc(id).get();
      const productId = doc.exists ? doc.data().productId : null;
      await _db.collection('reviews').doc(id).delete();
      if (productId) await Reviews._recalcProductRating(productId);
      return true;
    } catch(e) { return false; }
  },

  // Recalculate average rating for a product based on approved reviews
  async _recalcProductRating(productId) {
    try {
      const snap = await _db.collection('reviews')
        .where('productId', '==', productId)
        .where('status', '==', 'approved').get();
      const docs = snap.docs;
      if (!docs.length) {
        await _db.collection('products').doc(productId).update({ rating: null, reviewCount: 0 });
        return;
      }
      const avg = docs.reduce((s, d) => s + (d.data().stars || 0), 0) / docs.length;
      await _db.collection('products').doc(productId).update({
        rating: Math.round(avg * 10) / 10,
        reviewCount: docs.length,
      });
      // Update local cache
      if (DB._cache.products) {
        const i = DB._cache.products.findIndex(p => p.id === productId);
        if (i >= 0) {
          DB._cache.products[i].rating = Math.round(avg * 10) / 10;
          DB._cache.products[i].reviewCount = docs.length;
          try { localStorage.setItem('dz_fc_products', JSON.stringify(DB._cache.products)); } catch(e) {}
        }
      }
    } catch(e) {}
  }
};

// ================================================================
// IMAGE COMPRESSION
// ================================================================
async function compressImage(file, maxDim = 700, quality = 0.72) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve('');
      img.src = e.target.result;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function generatePlaceholder(text, w = 400, h = 300) {
  const abbr = (text.split(' ').slice(0,2).map(x=>x[0]||'').join('')||text.slice(0,2)).toUpperCase();
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#1E1E1E"/>` +
    `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="${Math.min(w,h)*0.28}" fill="rgba(255,255,255,0.15)" font-weight="bold">${abbr}</text>` +
    `</svg>`
  );
}

// ================================================================
// ADMIN AUTH — sessionStorage only
// ================================================================
const AUTH_KEY   = 'dz_admin_auth';
const ADMIN_PASS = '121212';
const Auth = {
  isLoggedIn() { return sessionStorage.getItem(AUTH_KEY) === 'ok'; },
  login(pass)  { if (pass !== ADMIN_PASS) return false; try { sessionStorage.setItem(AUTH_KEY,'ok'); } catch(e){} return true; },
  logout()     { sessionStorage.removeItem(AUTH_KEY); }
};

// ================================================================
// DB — Firestore for products / categories / orders
// ================================================================
const DB = {
  // --- Internal cache to allow sync-like reads after first load ---
  _cache: {},

  // Load a collection into cache (call once on init)
  async _load(col) {
    // 1. Read from localStorage cache instantly (zero delay)
    try {
      const cached = localStorage.getItem('dz_fc_' + col);
      if (cached) {
        this._cache[col] = JSON.parse(cached);
        window.dispatchEvent(new CustomEvent('db:update', { detail: col }));
      }
    } catch(e) {}
    // 2. Fetch from Firestore in background, update if changed
    try {
      const snap = await _db.collection(col).get();
      const fresh = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      this._cache[col] = fresh;
      try { localStorage.setItem('dz_fc_' + col, JSON.stringify(fresh)); } catch(e) {}
      window.dispatchEvent(new CustomEvent('db:update', { detail: col }));
    } catch(e) { if (!this._cache[col]) this._cache[col] = []; }
  },

  // Sync read from cache (returns [] if not loaded yet)
  getAll(col) { return this._cache[col] || []; },

  getById(col, id) { return (this._cache[col] || []).find(x => x.id === id) || null; },

  async add(col, data) {
    try {
      const item = { ...data, createdAt: new Date().toISOString() };
      const ref = await _db.collection(col).add(item);
      const saved = { ...item, id: ref.id };
      if (!this._cache[col]) this._cache[col] = [];
      this._cache[col].unshift(saved);
      try { localStorage.setItem('dz_fc_' + col, JSON.stringify(this._cache[col])); } catch(e) {}
      this._emit(col);
      return saved;
    } catch(e) {
      // Log a helpful hint for the most common cause (Firestore security rules)
      if (e.code === 'permission-denied' || (e.message && e.message.includes('Missing or insufficient permissions'))) {
        console.error('[DIGITCH] Firestore write BLOCKED by security rules. Go to Firebase Console → Firestore → Rules and set: allow read, write: if true; (for testing) or proper auth rules.');
      } else {
        console.error('DB.add error:', e);
      }
      throw e; // Re-throw so callers (seed, admin) can show proper error messages
    }
  },

  async update(col, id, data) {
    try {
      await _db.collection(col).doc(id).update({ ...data, updatedAt: new Date().toISOString() });
      if (this._cache[col]) {
        const i = this._cache[col].findIndex(x => x.id === id);
        if (i >= 0) this._cache[col][i] = { ...this._cache[col][i], ...data, updatedAt: new Date().toISOString() };
      }
      try { localStorage.setItem('dz_fc_' + col, JSON.stringify(this._cache[col])); } catch(e) {}
      this._emit(col);
      return this._cache[col]?.find(x => x.id === id) || null;
    } catch(e) { console.error('DB.update:', e); return null; }
  },

  async delete(col, id) {
    try {
      await _db.collection(col).doc(id).delete();
      if (this._cache[col]) this._cache[col] = this._cache[col].filter(x => x.id !== id);
      try { localStorage.setItem('dz_fc_' + col, JSON.stringify(this._cache[col])); } catch(e) {}
      this._emit(col);
    } catch(e) { console.error('DB.delete:', e); }
  },

  _emit(col) { window.dispatchEvent(new CustomEvent('db:update', { detail: col })); }
};

// ================================================================
// SETTINGS — Firestore doc: settings/store
// ================================================================
const Settings = {
  _defaults: {
    storeName:'DIGITCH', logo:null, logoLight:null, logoDark:null,
    primary:'#10B981', secondary:'#10B981', accent:'#10B981', currency:'DA',
    social:{ facebook:'', instagram:'', whatsapp:'', telegram:'', tiktok:'', youtube:'' }
  },
  _data: null,

  get() {
    // Return cached data or defaults (for sync access)
    return { ...this._defaults, ...(this._data || {}) };
  },

  async load() {
    // Read localStorage cache instantly
    try {
      const cached = localStorage.getItem('dz_settings');
      if (cached) { this._data = JSON.parse(cached); }
    } catch(e) {}
    // Fetch fresh from Firestore in background
    try {
      const doc = await _db.collection('settings').doc('store').get();
      if (doc.exists) {
        this._data = doc.data();
        try { localStorage.setItem('dz_settings', JSON.stringify(this._data)); } catch(e) {}
      }
    } catch(e) { /* keep localStorage cache */ }
  },

  async save(patch) {
    this._data = { ...this.get(), ...patch };
    try {
      await _db.collection('settings').doc('store').set(this._data);
    } catch(e) { console.error('Settings.save:', e); }
    // Also keep in localStorage as instant-load cache
    try { localStorage.setItem('dz_settings', JSON.stringify(this._data)); } catch(e) {}
    window.dispatchEvent(new Event('settings:update'));
    return this._data;
  },

  applyTheme() {
    const s = this.get();
    const r = document.documentElement.style;
    r.setProperty('--accent', s.primary); r.setProperty('--primary', s.primary); r.setProperty('--secondary', s.primary);
    const rgb = hexToRgb(s.primary);
    if (rgb) {
      const v = `${rgb.r},${rgb.g},${rgb.b}`;
      r.setProperty('--accent-rgb', v); r.setProperty('--primary-rgb', v); r.setProperty('--secondary-rgb', v);
    }
    r.setProperty('--accent-dark', adjustColor(s.primary, -20));
    document.querySelectorAll('.store-name').forEach(el => el.textContent = s.storeName);
    const _theme = document.documentElement.getAttribute('data-theme') || 'light';
    const _logo = (_theme === 'dark' && s.logoDark) ? s.logoDark : (s.logoLight || s.logo || null);
    document.querySelectorAll('.nav-logo-img').forEach(el => { el.src = _logo||''; el.style.display = _logo ? 'block' : 'none'; });
    const t = document.getElementById('page-title'); if (t) t.textContent = s.storeName;
  }
};

function hexToRgb(hex){const r=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);return r?{r:parseInt(r[1],16),g:parseInt(r[2],16),b:parseInt(r[3],16)}:null;}
function adjustColor(hex,amount){const rgb=hexToRgb(hex);if(!rgb)return hex;const clamp=v=>Math.max(0,Math.min(255,v+amount));return '#'+[clamp(rgb.r),clamp(rgb.g),clamp(rgb.b)].map(v=>v.toString(16).padStart(2,'0')).join('');}

// ================================================================
// CART — localStorage (per-device, intentional)
// ================================================================
const Cart = {
  get(){try{return JSON.parse(localStorage.getItem('dz_cart')||'[]');}catch{return[];}},
  _save(c){try{localStorage.setItem('dz_cart',JSON.stringify(c));}catch{}window.dispatchEvent(new Event('cart:update'));},
  add(prod,qty=1){const c=this.get();const cartId=prod.variantLabel?(prod.id+'__'+prod.variantLabel):prod.id;const ex=c.find(i=>i.id===cartId);if(ex)ex.qty+=qty;else c.push({id:cartId,productId:prod.id,name:prod.variantLabel?(prod.name+' — '+prod.variantLabel):prod.name,price:prod.price,img:(prod.images||[])[0]||null,qty,variantLabel:prod.variantLabel||null});this._save(c);},
  remove(id){this._save(this.get().filter(i=>i.id!==id));},
  setQty(id,qty){if(qty<1)return this.remove(id);const c=this.get();const it=c.find(i=>i.id===id);if(it){it.qty=qty;this._save(c);}},
  clear(){localStorage.removeItem('dz_cart');window.dispatchEvent(new Event('cart:update'));},
  total(){return this.get().reduce((s,i)=>s+i.price*i.qty,0);},
  count(){return this.get().reduce((s,i)=>s+i.qty,0);},
};

// ================================================================
// ORDERS — Firestore
// ================================================================
const Orders = {
  place(customer) {
    const items = Cart.get(); if (!items.length) return null;
    const order = { customer, items: [...items], total: Cart.total(), status: 'pending' };
    Cart.clear();
    DB.add('orders', order);
    return order;
  }
};

// ================================================================
// STORAGE (for admin storage manager)
// ================================================================
const Storage = {
  usage() {
    let bytes = 0;
    for (const k in localStorage) { if (localStorage.hasOwnProperty(k)) bytes += (k.length + (localStorage[k]||'').length) * 2; }
    return Math.round(bytes / 1024);
  },

  // Upload a file through the Worker, which stores it in Cloudflare R2.
  // folder:     storage path prefix, e.g. 'deliveries/<purchaseId>'
  // onProgress: optional callback(percent:number)
  uploadFile(file, folder, onProgress) {
    return new Promise((resolve, reject) => {
      const backendUrl = (window.DIGISTORE_BACKEND_URL || '').replace(/\/+$/, '');
      if (!backendUrl) {
        reject(new Error('DIGISTORE_BACKEND_URL is not configured.'));
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', folder || 'deliveries/misc');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${backendUrl}/api/upload-file`, true);

      xhr.upload.onprogress = e => {
        if (onProgress && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          reject(new Error('Upload failed: invalid response from server.'));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.url) {
          resolve({
            url:  data.url,
            path: data.path,
            name: data.name || file.name,
            size: data.size || file.size || 0,
          });
        } else {
          reject(new Error('Upload failed: ' + (data && data.error ? data.error : `HTTP ${xhr.status}`)));
        }
      };

      xhr.onerror = () => reject(new Error('Upload failed: network error.'));

      xhr.send(formData);
    });
  },

  async deleteFile(path) {
    if (!path) return;
    const backendUrl = (window.DIGISTORE_BACKEND_URL || '').replace(/\/+$/, '');
    if (!backendUrl) {
      console.warn('Storage.deleteFile: DIGISTORE_BACKEND_URL is not configured.');
      return;
    }
    try {
      const res = await fetch(`${backendUrl}/api/delete-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.warn('Storage.deleteFile:', data.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn('Storage.deleteFile:', e);
    }
  }
};

// ================================================================
// INIT — load all data from Firestore on startup
// ================================================================
async function initFirestoreData() {
  // Step 1: load from localStorage cache instantly (synchronous, zero delay)
  const COLS = ['products', 'categories', 'orders'];
  COLS.forEach(col => {
    try {
      const cached = localStorage.getItem('dz_fc_' + col);
      if (cached) DB._cache[col] = JSON.parse(cached);
    } catch(e) {}
  });
  try {
    const s = localStorage.getItem('dz_settings');
    if (s) Settings._data = JSON.parse(s);
  } catch(e) {}

  // Step 2: fire events so UI renders immediately with cached data
  window.dispatchEvent(new Event('settings:update'));
  window.dispatchEvent(new CustomEvent('db:update', { detail: 'all' }));

  // Step 3: refresh from Firestore in background (DB._load handles update)
  Settings.load().then(() => window.dispatchEvent(new Event('settings:update'))).catch(()=>{});
  Promise.all(COLS.map(col => DB._load(col))).then(() => {
    if (DB._cache.products) DB._cache.products.sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
  }).catch(e => console.error('Firestore refresh:', e));
}

// Run immediately (synchronous cache part runs before first paint)
initFirestoreData().catch(e => console.error('initFirestoreData:', e));