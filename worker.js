// ================================================================
// WORKER.JS — DigiStore DZ
// Cloudflare Worker (no Node.js, no Express, no dependencies)
// Deploy via: npx wrangler deploy
//
// File storage: Cloudflare R2 via the native `env.BUCKET` binding.
// Upload flow: browser → Worker → R2 (no presigned URLs).
// Delete flow: Worker → R2.
//
// Payments: SlickPay (CIB / EDAHABIA via SATIM). Secret key lives ONLY in
// the Worker secret `SLICKPAY_KEY` (set with `wrangler secret put`), never
// in wrangler.jsonc `vars` and never shipped to the browser.
//
// Order writes go through the Firestore REST API, authenticated with a
// Google service-account JWT signed via Web Crypto (RS256) — no Node SDK,
// no extra npm dependency, fully Workers-compatible. The service account
// JSON is read from the Worker secret `FIREBASE_SERVICE_ACCOUNT`.
// ================================================================

// ---------------------------------------------------------------
// Admin-only route protection
// ---------------------------------------------------------------
// Routes that let the caller write/delete storage (upload-file,
// delete-file) must never be reachable by an anonymous visitor —
// only the admin should be able to call them.
//
// This used to be a static shared-secret header baked into firebase.js.
// That file ships to every visitor (it's loaded by the public storefront
// too), so the "secret" was really public — anyone could view-source it
// and call these routes directly. There is no fix that keeps a
// client-visible static secret; the caller's identity has to be proven
// server-side instead.
//
// The admin panel now signs the admin into real Firebase Authentication
// (see the `Auth` object in firebase.js) and sends the resulting ID
// token as `Authorization: Bearer <token>`. This function hands that
// token to Google's Identity Toolkit, which verifies its signature and
// expiry and tells us which Firebase account it actually belongs to —
// a token can't be forged or reused for a different account. We then
// check that account against the configured admin email.
//
// Set up once:
//   1. Firebase console → Authentication → Users → Add user (the admin's
//      real login email + a strong password).
//   2. Put that same email in ADMIN_EMAIL in firebase.js.
//   3. npx wrangler secret put ADMIN_EMAIL   (same email, on the Worker)
async function requireAdminAuth(request, env) {
  if (!env.ADMIN_EMAIL) {
    // Fail closed: if the secret was never configured, refuse rather
    // than silently allowing unauthenticated access.
    return { ok: false, status: 500, error: 'ADMIN_EMAIL is not configured on this Worker.' };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return { ok: false, status: 401, error: 'Missing bearer token.' };
  }
  const idToken = m[1];

  // Ask Google to verify the token (signature, expiry, issuer/audience)
  // and return the account it belongs to. This avoids re-implementing
  // JWT/JWKS verification by hand — Firebase's apiKey is not a secret,
  // it's the same value already public in firebaseConfig.
  let lookup;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY || '')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    lookup = await res.json();
    if (!res.ok) {
      return { ok: false, status: 401, error: (lookup && lookup.error && lookup.error.message) || 'Invalid or expired session — please log in again.' };
    }
  } catch (e) {
    return { ok: false, status: 401, error: 'Could not verify session: ' + e.message };
  }

  const user = lookup && lookup.users && lookup.users[0];
  if (!user || !user.email) {
    return { ok: false, status: 401, error: 'Unauthorized.' };
  }
  if (user.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    return { ok: false, status: 403, error: 'This account is not the admin account.' };
  }

  return { ok: true, uid: user.localId, email: user.email };
}

// ---------------------------------------------------------------
// SlickPay config
// ---------------------------------------------------------------
const SLICKPAY_BASE_URL = {
  sandbox:    'https://devapi.slick-pay.com/api/v2',
  production: 'https://prodapi.slick-pay.com/api/v2',
};

function slickpayBaseUrl(env) {
  const mode = (env.SLICKPAY_ENV || 'sandbox').toLowerCase();
  return SLICKPAY_BASE_URL[mode] || SLICKPAY_BASE_URL.sandbox;
}

function slickpayHeaders(env) {
  return {
    'Authorization': `Bearer ${env.SLICKPAY_KEY}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'User-Agent':    'DigiStoreDZ/1.0 (+https://digital-website.digitch.workers.dev)',
  };
}

class SlickPayError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SlickPayError';
    this.status = status;
    this.body = body;
  }
}

async function slickpayRequest(env, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${slickpayBaseUrl(env)}${path}`, {
    method,
    headers: slickpayHeaders(env),
    body: body ? JSON.stringify(body) : undefined,
  });

  const resClone = res.clone();
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }

  if (!res.ok) {
    let rawText = '';
    if (!data) { try { rawText = await resClone.text(); } catch {} }
    // SlickPay returns a generic "Server Error" when the merchant has no
    // linked bank account (RIB) — surface that distinctly so the caller
    // can map it to a clear 503 instead of a confusing 500.
    const msg = (data && (data.message || JSON.stringify(data.errors)))
      || (rawText ? `SlickPay ${res.status}: ${rawText.slice(0, 200)}` : `SlickPay HTTP ${res.status}`);
    throw new SlickPayError(msg, res.status, data);
  }
  return data;
}

// SlickPay's commission is configured per merchant account and is NOT
// guaranteed to be a flat amount — it can be a percentage (the guide's own
// example shows 190 DA commission on a 10,000 DA sale, ~1.9%, not a flat
// fee). Hardcoding a guessed number here would silently undercharge the
// customer and eat into the merchant's payout whenever the real rate is
// higher. So the real fee is looked up from SlickPay's own commission
// endpoint at checkout time (see getGatewayFee below) and used everywhere
// instead. This constant is kept ONLY as a fallback for the rare case
// where that lookup call itself fails, so checkout never hard-breaks.
const SLICKPAY_GATEWAY_FEE_DA_FALLBACK = 40;

const SlickPay = {
  async createInvoice(env, { amount, items, firstname, lastname, email, phone, address, returnUrl, webhookUrl, webhookSignature, webhookMetaData, fees = 100 }) {
    const payload = {
      amount,
      items,
      fees,
      url: returnUrl,
      firstname,
      lastname,
      email,
      phone,
      address,
    };
    if (env.SLICKPAY_ACCOUNT) payload.account = env.SLICKPAY_ACCOUNT;
    if (webhookUrl)       payload.webhook_url       = webhookUrl;
    if (webhookSignature) payload.webhook_signature = webhookSignature;
    if (webhookMetaData)  payload.webhook_meta_data  = webhookMetaData;

    return slickpayRequest(env, '/users/invoices', { method: 'POST', body: payload });
  },

  async getInvoice(env, id) {
    return slickpayRequest(env, `/users/invoices/${id}`, { method: 'GET' });
  },

  async commission(env, amount) {
    return slickpayRequest(env, '/users/invoices/commission', { method: 'POST', body: { amount } });
  },

  async listAccounts(env) {
    return slickpayRequest(env, '/users/accounts', { method: 'GET' });
  },
};

// Ask SlickPay what this merchant's account will actually be charged in
// commission for a given base amount, so the surcharge shown to and
// collected from the customer matches what SlickPay will really deduct
// (we pass fees: 0 on invoice creation — see the checkout route — meaning
// SlickPay deducts its real commission from the payout rather than adding
// it again at the payment page; this fee lookup is what makes sure we've
// already collected exactly that much from the customer up front, so the
// merchant nets the full listed product price).
// Falls back to SLICKPAY_GATEWAY_FEE_DA_FALLBACK if the lookup itself
// fails, so a transient SlickPay API hiccup never blocks checkout.
async function getGatewayFee(env, baseAmount) {
  try {
    const res = await SlickPay.commission(env, baseAmount);
    const fee = Number(res && res.commission);
    if (Number.isFinite(fee) && fee > 0) return fee;
    throw new Error('Unexpected response shape: ' + JSON.stringify(res));
  } catch (err) {
    console.error('[checkout] commission lookup failed, using fallback fee:', err.message);
    return SLICKPAY_GATEWAY_FEE_DA_FALLBACK;
  }
}

// ---------------------------------------------------------------
// Firestore REST helper, authenticated via Google service-account JWT
// (RS256, signed with Web Crypto — no firebase-admin, no jose/jsonwebtoken)
// ---------------------------------------------------------------
let _cachedAccessTokens = {}; // { [scope]: { token, expiresAt } } — per-isolate cache

function base64url(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  if (!pem || typeof pem !== 'string') {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT is missing its "private_key" field (or the secret ' +
      'was never set on this Worker). Run: npx wrangler secret put FIREBASE_SERVICE_ACCOUNT'
    );
  }
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function getFirebaseAccessToken(env, scope = 'https://www.googleapis.com/auth/datastore') {
  const now = Math.floor(Date.now() / 1000);
  const cached = _cachedAccessTokens[scope];
  if (cached && cached.expiresAt > now + 30) {
    return cached.token;
  }

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT secret is not set on this Worker. ' +
      'Run: npx wrangler secret put FIREBASE_SERVICE_ACCOUNT (then paste the full service-account JSON) and redeploy.'
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    // Diagnose the common cause without ever logging the secret itself:
    // pasting multi-line JSON into an interactive `wrangler secret put`
    // prompt often mangles it (a stray leading "-" from inside the
    // private_key's "-----BEGIN PRIVATE KEY-----" line is a classic sign
    // the JSON structure around it got dropped). Log a safe fingerprint —
    // length and first character only — never the content.
    const raw = env.FIREBASE_SERVICE_ACCOUNT || '';
    const looksTruncated = raw.trimStart()[0] !== '{';
    console.error(
      '[FIREBASE_SERVICE_ACCOUNT] JSON.parse failed:', e.message,
      '| length:', raw.length,
      '| starts with "{":', !looksTruncated,
      looksTruncated
        ? '| This usually means the secret was pasted interactively and got corrupted. Fix: pipe the key file in instead of pasting — e.g. '
          + '`Get-Content .\\key.json -Raw | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` (PowerShell) or '
          + '`type key.json | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` (cmd.exe), then `npx wrangler deploy`.'
        : ''
    );
    throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not valid JSON: ' + e.message);
  }
  if (!serviceAccount.private_key || !serviceAccount.client_email || !serviceAccount.project_id) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT is missing required fields (private_key, client_email, or project_id). ' +
      'Re-paste the complete service-account JSON with: npx wrangler secret put FIREBASE_SERVICE_ACCOUNT'
    );
  }

  const header  = { alg: 'RS256', typ: 'JWT' };
  const claims  = {
    iss:   serviceAccount.client_email,
    sub:   serviceAccount.client_email,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
    scope,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${base64url(signature)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error('Failed to get Firebase access token: ' + JSON.stringify(tokenData));
  }

  _cachedAccessTokens[scope] = { token: tokenData.access_token, expiresAt: now + tokenData.expires_in };
  return tokenData.access_token;
}

// Minimal Firestore value (en/de)coders — only the subtypes this file needs.
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object')  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, toFirestoreValue(val)])) } };
  return { stringValue: String(v) };
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue'  in v) return parseInt(v.integerValue, 10);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue'     in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, fromFirestoreValue(val)]));
  return null;
}

function docToObject(doc) {
  if (!doc || !doc.fields) return null;
  const id = (doc.name || '').split('/').pop();
  return { id, ...Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, fromFirestoreValue(v)])) };
}

const Firestore = {
  async _baseUrl(env) {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    return `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents`;
  },

  async getDoc(env, collection, id) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const res = await fetch(`${base}/${collection}/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore getDoc failed: ${res.status} ${await res.text()}`);
    return docToObject(await res.json());
  },

  async addDoc(env, collection, data) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)]));
    const res = await fetch(`${base}/${collection}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`Firestore addDoc failed: ${res.status} ${await res.text()}`);
    return docToObject(await res.json());
  },

  async updateDoc(env, collection, id, data) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)]));
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const res = await fetch(`${base}/${collection}/${id}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`Firestore updateDoc failed: ${res.status} ${await res.text()}`);
    return docToObject(await res.json());
  },

  async setDoc(env, collection, id, data) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)]));
    const res = await fetch(`${base}/${collection}/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`Firestore setDoc failed: ${res.status} ${await res.text()}`);
    return docToObject(await res.json());
  },

  async deleteDoc(env, collection, id) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const res = await fetch(`${base}/${collection}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    // Deleting a doc that's already gone is fine — treat 404 as success.
    if (!res.ok && res.status !== 404) throw new Error(`Firestore deleteDoc failed: ${res.status} ${await res.text()}`);
  },

  // List a collection ordered/limited — e.g. the most recent admin login
  // records. Unlike queryCollection, this has no filters, just ordering.
  async listCollection(env, collection, { orderByField, direction = 'DESCENDING', limit = 50 } = {}) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const structuredQuery = { from: [{ collectionId: collection }], limit };
    if (orderByField) {
      structuredQuery.orderBy = [{ field: { fieldPath: orderByField }, direction }];
    }
    const res = await fetch(`${base}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) throw new Error(`Firestore listCollection failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return rows.filter(r => r.document).map(r => docToObject(r.document));
  },

  // Run a structured query, e.g. find a purchase by a field value.
  async queryCollection(env, collection, fieldFilters, limit = 10) {
    const token = await getFirebaseAccessToken(env);
    const base  = await this._baseUrl(env);
    const structuredQuery = {
      from: [{ collectionId: collection }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: fieldFilters.map(([field, value]) => ({
            fieldFilter: {
              field: { fieldPath: field },
              op: 'EQUAL',
              value: toFirestoreValue(value),
            },
          })),
        },
      },
      limit,
    };
    const res = await fetch(`${base.replace(/\/documents$/, '/documents')}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) throw new Error(`Firestore query failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return rows.filter(r => r.document).map(r => docToObject(r.document));
  },
};

// ---------------------------------------------------------------
// Identity Toolkit admin calls — deleting a Firebase Auth account can only
// be done server-side (the client SDK can only delete the currently signed
// in user's own account). Uses the same service-account JWT flow as
// Firestore, but with the identitytoolkit scope instead.
// ---------------------------------------------------------------
async function deleteFirebaseAuthUser(env, uid) {
  const token = await getFirebaseAccessToken(env, 'https://www.googleapis.com/auth/identitytoolkit');
  let projectId;
  try { projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id; }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not valid JSON: ' + e.message); }

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: uid }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch {}
    // A user that's already gone shouldn't block cleanup of our own records.
    if (res.status === 400 && /USER_NOT_FOUND/i.test(detail)) return;
    throw new Error(`Failed to delete Firebase Auth account: ${res.status} ${detail}`);
  }
}

// ---------------------------------------------------------------
// Pricing — re-derived server-side from the product doc, never trusted
// from the client. Mirrors the variant-price logic in firebase.js /
// index.html (prod.variables[].items[].price, legacy prod.variants[].price,
// falling back to prod.price).
// ---------------------------------------------------------------
function resolveVariantPrice(product, variantLabel) {
  if (!variantLabel) return product.price;
  if (Array.isArray(product.variables)) {
    for (const grp of product.variables) {
      const item = (grp.items || []).find(it => it.label === variantLabel || variantLabel.split(' / ').includes(it.label));
      if (item && item.price != null) return item.price;
    }
  }
  if (Array.isArray(product.variants)) {
    const item = product.variants.find(v => v.label === variantLabel);
    if (item && item.price != null) return item.price;
  }
  return product.price;
}

async function priceCartItems(env, cartItems) {
  // Fetch every product in the cart concurrently instead of one at a time —
  // a 5-item cart used to mean 5 sequential Firestore round-trips before
  // checkout could even create the invoice. Promise.all fires them together.
  const priced = await Promise.all(cartItems.map(async (item) => {
    const productId = item.productId || item.id;
    const product = await Firestore.getDoc(env, 'products', productId);
    if (!product) throw new Error(`Product not found: ${productId}`);
    const unitPrice = resolveVariantPrice(product, item.variantLabel);
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    return {
      productId,
      name: item.variantLabel ? `${product.name} — ${item.variantLabel}` : product.name,
      images: product.images || [],
      category: product.category || '',
      unitPrice,
      qty,
      variantLabel: item.variantLabel || null,
      // Carried along so deliverOrder() doesn't need a second product fetch.
      autoDeliver:   !!product.autoDeliver,
      deliveryLink:  product.deliveryLink  || '',
      deliveryType:  product.deliveryType  || 'link',
      deliveryFiles: product.deliveryFiles || [],
    };
  }));
  return priced;
}

// ---------------------------------------------------------------
// Order fulfillment — creates `purchases` docs for a paid order so
// the buyer sees them on My Products without any admin action.
// If a product has autoDeliver + deliveryLink configured, the purchase
// is created already `completed` with the access link attached.
// Otherwise it's created `pending`, same as the manual proof-of-payment
// flow, so the admin can deliver it by hand from the admin panel.
// ---------------------------------------------------------------
async function deliverOrder(env, order) {
  if (!order || !order.userId) {
    // No user to attach the purchase to (e.g. a very old/legacy order) —
    // nothing we can do automatically. The admin can still see the raw
    // slickpay_orders record.
    return;
  }
  const now = new Date().toISOString();

  let items = Array.isArray(order.items) && order.items.length ? order.items : null;
  if (!items) {
    // Legacy single-item order (created before cart items were persisted).
    items = [{
      productId:    order.product_id || order.productId || '',
      name:         order.product_name || order.productName || '',
      images:       [],
      category:     '',
      unitPrice:    order.amount,
      qty:          1,
      variantLabel: null,
      autoDeliver:  false,
      deliveryLink: '',
      deliveryType: 'link',
    }];
  }

  // Legacy items may not carry delivery info — resolve all of those product
  // lookups concurrently up front rather than one-by-one inside the loop
  // below (this only ever affects old orders created before cart items
  // carried their own delivery info, but no reason to make it sequential).
  const resolvedItems = await Promise.all(items.map(async (item) => {
    let { autoDeliver, deliveryLink, deliveryType, images, category, name, deliveryFiles } = item;
    if ((autoDeliver === undefined || !Array.isArray(deliveryFiles)) && item.productId) {
      try {
        const product = await Firestore.getDoc(env, 'products', item.productId);
        if (product) {
          autoDeliver   = !!product.autoDeliver;
          deliveryLink  = product.deliveryLink || '';
          deliveryType  = product.deliveryType || 'link';
          deliveryFiles = product.deliveryFiles || [];
          images        = product.images || [];
          category      = product.category || '';
          name          = name || product.name;
        }
      } catch { /* best-effort */ }
    }
    return { ...item, autoDeliver, deliveryLink, deliveryType, images, category, name, deliveryFiles };
  }));

  for (const item of resolvedItems) {
    const { autoDeliver, deliveryLink, deliveryType, images, category, name, deliveryFiles } = item;
    const isAuto = !!(autoDeliver && deliveryLink);

    // Build accessData: Download Link and the uploaded file list are now
    // independent — a product can have either, or both merged together
    // (e.g. a video link plus a bonus PDF). Attach whichever is actually
    // populated rather than gating _Files behind deliveryType === 'pdf'.
    let accessData = {};
    if (isAuto) {
      accessData = { '_DeliveryType': deliveryType || 'link', 'Download Link': deliveryLink };
      if (Array.isArray(deliveryFiles) && deliveryFiles.length) {
        accessData['_Files'] = deliveryFiles.map(f => ({ url: f.url, name: f.name }));
      }
    }

    const purchaseDoc = {
      userId:        order.userId,
      userEmail:     order.userEmail || order.email || '',
      productId:     item.productId || '',
      productName:   item.variantLabel ? `${name || ''} — ${item.variantLabel}` : (name || ''),
      productImage:  (images || [])[0] || '',
      productType:   category || 'Digital',
      accessLink:    isAuto ? deliveryLink : '',
      accessData,
      proofImages:   [],
      customerName:  `${order.firstname || ''} ${order.lastname || ''}`.trim(),
      customerPhone: order.phone || '',
      customerEmail: order.userEmail || order.email || '',
      paymentMethod: 'slickpay',
      orderNotes:    '',
      status:        isAuto ? 'completed' : 'pending',
      purchaseDate:  now,
      createdAt:     now,
      orderId:       order.orderId || '',
      variantLabel:  item.variantLabel || null,
      deliveryType:  isAuto ? (deliveryType || 'link') : '',
    };
    if (isAuto) purchaseDoc.deliveredAt = now;

    try {
      await Firestore.addDoc(env, 'purchases', purchaseDoc);
    } catch (e) {
      console.error('[deliverOrder] Firestore addDoc failed:', e.message);
    }
  }
}

async function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aBuf = enc.encode(a), bBuf = enc.encode(b);
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) diff |= aBuf[i] ^ bBuf[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;
    const path   = url.pathname;

    // ── CORS headers (added to every response) ───────────────────
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    // ============================================================
    // ROUTE: GET /api/health
    // ============================================================
    if (path === '/api/health' && method === 'GET') {
      return json({ status: 'ok' });
    }

    // ============================================================
    // ROUTE: POST /api/upload-file
    // Stores the uploaded file in R2 via the native `env.BUCKET`
    // binding and returns its public URL.
    // ============================================================
    if (path === '/api/upload-file' && method === 'POST') {
      const auth = await requireAdminAuth(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      try {
        let form;
        try {
          form = await request.formData();
        } catch {
          return json({ error: 'Expected multipart/form-data with a "file" field.' }, 400);
        }

        const file   = form.get('file');
        const folder = (form.get('folder') || 'deliveries/misc').toString();

        if (!file || typeof file.arrayBuffer !== 'function') {
          return json({ error: 'No file provided.' }, 400);
        }

        const MAX_BYTES = 50 * 1024 * 1024; // 50MB
        if (file.size > MAX_BYTES) {
          return json({ error: 'File is too large — must be under 50MB.' }, 400);
        }

        if (!env.BUCKET) {
          return json({ error: 'R2 bucket binding (env.BUCKET) is not configured.' }, 500);
        }
        if (!env.R2_PUBLIC_URL) {
          return json({ error: 'R2_PUBLIC_URL is not configured.' }, 500);
        }

        const safeName    = (file.name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const safeFolder  = folder.replace(/[^a-zA-Z0-9/_\-]/g, '_').replace(/^\/+/, '');
        const objectPath  = `${safeFolder}/${Date.now()}_${safeName}`;
        const contentType = file.type || 'application/octet-stream';
        const fileBytes   = await file.arrayBuffer();

        // Upload to R2 via the native binding — no S3 API, no signing.
        await env.BUCKET.put(objectPath, fileBytes, {
          httpMetadata: {
            contentType,
            contentDisposition: `attachment; filename="${file.name || safeName}"`,
          },
        });

        // Build the public URL. R2_PUBLIC_URL is the base URL of your
        // public R2 bucket — either its r2.dev URL or your connected
        // custom domain, e.g. "https://pub-xxxxxxxx.r2.dev" or
        // "https://files.yourdomain.com" (no trailing slash).
        const pathParts   = objectPath.split('/').map(encodeURIComponent).join('/');
        const downloadUrl = `${env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${pathParts}`;

        return json({
          url:  downloadUrl,
          path: objectPath,
          name: file.name || safeName,
          size: file.size || 0,
        });

      } catch (err) {
        console.error('[upload-file] error:', err.message);
        return json({ error: 'Internal server error.', message: err.message }, 500);
      }
    }

    // ============================================================
    // ROUTE: POST /api/delete-file
    // Deletes the object from R2 via the native `env.BUCKET` binding.
    // ============================================================
    if (path === '/api/delete-file' && method === 'POST') {
      const auth = await requireAdminAuth(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      try {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        const objectPath = (body.path || '').toString();
        if (!objectPath) return json({ error: 'path is required.' }, 400);

        if (!env.BUCKET) {
          return json({ error: 'R2 bucket binding (env.BUCKET) is not configured.' }, 500);
        }

        // R2 delete is idempotent — no error if the key doesn't exist.
        await env.BUCKET.delete(objectPath);

        return json({ ok: true });

      } catch (err) {
        console.error('[delete-file] error:', err.message);
        return json({ error: 'Internal server error.' }, 500);
      }
    }

    // ============================================================
    // ROUTE: POST /api/admin/log-access
    // Called once by admin.html right after a successful admin sign-in
    // (fresh login or a restored session). Records who/when/where/how for
    // a security audit trail — e.g. to notice a sign-in that wasn't you.
    // IP + geolocation come from Cloudflare's own request metadata
    // (request.cf) — nothing external is called, nothing is guessed.
    // ============================================================
    if (path === '/api/admin/log-access' && method === 'POST') {
      const auth = await requireAdminAuth(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      try {
        const cf = request.cf || {};
        await Firestore.addDoc(env, 'admin_login_log', {
          email:     auth.email,
          uid:       auth.uid,
          ip:        request.headers.get('CF-Connecting-IP') || 'unknown',
          country:   cf.country  || '',
          region:    cf.region   || '',
          city:      cf.city     || '',
          timezone:  cf.timezone || '',
          userAgent: request.headers.get('User-Agent') || 'unknown',
          at:        new Date().toISOString(),
        });
        return json({ ok: true });
      } catch (err) {
        console.error('[log-access] error:', err.message);
        // Non-critical — don't block the admin from using the panel just
        // because the audit log write failed.
        return json({ ok: false }, 200);
      }
    }

    // ============================================================
    // ROUTE: GET /api/admin/login-history
    // Returns recent admin sign-in records, most recent first.
    // ============================================================
    if (path === '/api/admin/login-history' && method === 'GET') {
      const auth = await requireAdminAuth(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
        const entries = await Firestore.listCollection(env, 'admin_login_log', {
          orderByField: 'at', direction: 'DESCENDING', limit,
        });
        return json({ entries });
      } catch (err) {
        console.error('[login-history] error:', err.message);
        return json({ error: 'Internal server error.' }, 500);
      }
    }

    // ============================================================
    // ROUTE: POST /api/delete-user
    // Deletes a customer: their Firestore `users/{uid}` doc AND their real
    // Firebase Auth account (the latter can only be done server-side, with
    // the service account — the client SDK can't delete other users).
    // Their `purchases` docs are left in place — deleting a user shouldn't
    // silently wipe order history/analytics.
    // ============================================================
    if (path === '/api/delete-user' && method === 'POST') {
      const auth = await requireAdminAuth(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      try {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        const uid = (body.uid || '').toString().trim();
        if (!uid) return json({ error: 'uid is required.' }, 400);

        // Guard rail: the admin can't delete the account they're signed in
        // as — that would be an easy way to accidentally lock yourself out.
        if (uid === auth.uid) {
          return json({ error: "You can't delete the account you're currently signed in as." }, 400);
        }

        await Firestore.deleteDoc(env, 'users', uid);
        await deleteFirebaseAuthUser(env, uid);

        return json({ ok: true });
      } catch (err) {
        console.error('[delete-user] error:', err.message);
        return json({ error: 'Internal server error.', message: err.message }, 500);
      }
    }

    // ============================================================
    // ROUTE: POST /api/webhook
    // Receives SlickPay's async payment notification. This is a backstop
    // to the status-poll endpoint below — it lets an order get delivered
    // even if the buyer closes the tab right after paying.
    // ============================================================
    if (path === '/api/webhook' && method === 'POST') {
      try {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        // Signature verification is REQUIRED, not optional. Without it, anyone
        // who finds this URL can POST a fake "payment completed" event for any
        // order and get a product delivered for free. If this 500s, set the
        // secret with: npx wrangler secret put SLICKPAY_WEBHOOK_SIG
        // (use the same value passed as webhookSignature when creating invoices).
        if (!env.SLICKPAY_WEBHOOK_SIG) {
          console.error('[webhook] rejected: SLICKPAY_WEBHOOK_SIG is not configured on this Worker.');
          return json({ error: 'Webhook secret not configured on server.' }, 500);
        }
        const sig = body.webhook_signature || body.signature || request.headers.get('x-webhook-signature') || '';
        const sigOk = await constantTimeEqual(String(sig), String(env.SLICKPAY_WEBHOOK_SIG));
        if (!sigOk) return json({ error: 'Invalid webhook signature.' }, 403);

        const invoice   = body.data || body.invoice || body;
        const completed = (invoice.completed === 1 || body.completed === 1) ? 1 : 0;
        const meta       = body.meta_data || body.webhook_meta_data || invoice.meta_data || {};
        let orderId      = meta.order_id || meta.orderId || '';
        const invoiceId  = String(invoice.id || body.id || '');

        let order = null;
        if (orderId) {
          order = await Firestore.getDoc(env, 'slickpay_orders', orderId);
        }
        if (!order && invoiceId) {
          const matches = await Firestore.queryCollection(env, 'slickpay_orders', [['invoiceId', invoiceId]], 1);
          order = matches[0] || null;
          if (order) orderId = order.id;
        }
        if (!order) return json({ error: 'Order not found for webhook.' }, 404);

        if (completed === 1 && order.status !== 'delivered') {
          try {
            await deliverOrder(env, order);
            await Firestore.updateDoc(env, 'slickpay_orders', orderId, {
              status: 'delivered',
              paidAt: new Date().toISOString(),
            });
          } catch (fsErr) {
            console.error('[webhook] delivery failed:', fsErr.message);
          }
        }

        return json({ ok: true });
      } catch (err) {
        console.error('[webhook] unexpected error:', err.message);
        return json({ error: 'Internal server error.' }, 500);
      }
    }

    // ============================================================
    // ROUTE: GET /api/checkout/fee?amount=NNN
    // Lets the cart/checkout UI show the REAL SlickPay commission for the
    // current total before the customer submits, instead of a guessed flat
    // number — so what's shown in the cart matches what's actually charged
    // when POST /api/checkout runs the same lookup.
    // ============================================================
    if (path === '/api/checkout/fee' && method === 'GET') {
      const amount = Number(url.searchParams.get('amount'));
      if (!Number.isFinite(amount) || amount <= 0) {
        return json({ error: 'Missing or invalid amount.' }, 400);
      }
      const fee = await getGatewayFee(env, amount);
      return json({ fee });
    }

    // ============================================================
    // ROUTE: POST /api/checkout
    // Creates a SlickPay invoice and returns { order_id, payment_url, amount }
    // Body: { product_id, product_name, amount, firstname, lastname, email, phone }
    // ============================================================
    if (path === '/api/checkout' && method === 'POST') {
      try {
        if (!env.SLICKPAY_KEY) {
          return json({ error: 'Payment gateway not configured.' }, 503);
        }

        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        const {
          product_id, product_name, firstname, lastname, email, phone, address,
          items: rawItems, user_id, user_email,
        } = body || {};
        // NOTE: a client-supplied `amount` field, if present in the request body,
        // is intentionally ignored below. Price is ALWAYS re-derived server-side
        // from product IDs looked up in Firestore — never trust a client-computed
        // total, or anyone can pay whatever they want for a product.
        const safeAddress = (address && address.trim().length >= 5) ? address.trim() : 'Algérie - Livraison numérique';

        if (!firstname || !lastname || (!email && !phone)) {
          return json({ error: 'Missing required fields: firstname, lastname, and email or phone.' }, 400);
        }

        // Build a normalized items list whether the client sent a full cart
        // or a single product_id (legacy/buy-now flow) — either way, pricing
        // is looked up server-side from the product DB, never from the client.
        const normalizedItems = (Array.isArray(rawItems) && rawItems.length)
          ? rawItems.map(it => ({
              productId:    it.product_id || it.productId || it.id,
              variantLabel: it.variant_label || it.variantLabel || null,
              qty:          it.qty || 1,
            }))
          : (product_id ? [{ productId: product_id, variantLabel: null, qty: 1 }] : []);

        if (!normalizedItems.length) {
          return json({ error: 'Missing required fields: items or product_id.' }, 400);
        }

        let pricedItems;
        try {
          pricedItems = await priceCartItems(env, normalizedItems);
        } catch (err) {
          // Full detail goes to the Worker's own logs (visible to you via
          // `npx wrangler tail` or the Cloudflare dashboard) — never to the
          // customer. A raw config/secret error was previously shown
          // directly in the checkout modal, which leaked internal backend
          // state (e.g. "FIREBASE_SERVICE_ACCOUNT secret is not valid
          // JSON") to shoppers.
          console.error('[checkout] priceCartItems failed:', err.message);
          return json({ error: 'We could not process your cart right now. Please try again in a moment, or contact support if this persists.' }, 400);
        }
        const computedAmount = pricedItems.reduce((sum, it) => sum + it.unitPrice * it.qty, 0);

        const finalProductName = product_name || (pricedItems.length === 1 ? pricedItems[0].name : `Order (${pricedItems.length} items)`);

        if (!finalProductName || !computedAmount) {
          return json({ error: 'Missing required fields: product_name/items and amount.' }, 400);
        }
        if (Number(computedAmount) <= 100) {
          return json({ error: 'Amount must be greater than 100 DZD.' }, 400);
        }

        // The customer is charged the products total PLUS SlickPay's real
        // commission for this order — looked up fresh via getGatewayFee()
        // rather than assumed, since the rate isn't necessarily flat (see
        // comment above SLICKPAY_GATEWAY_FEE_DA_FALLBACK). Itemized as its
        // own line so it's never hidden inside the product price.
        const gatewayFee   = await getGatewayFee(env, Number(computedAmount));
        const chargeAmount = Number(computedAmount) + gatewayFee;

        const appUrl = env.APP_URL || 'https://digital-website.digitch.workers.dev';
        const returnUrl = `${appUrl}/payment-return.html`;

        // Generate a short order ID stored in webhook meta
        const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

        let invoiceData;
        try {
          invoiceData = await SlickPay.createInvoice(env, {
            amount: chargeAmount,
            items: [
              ...(pricedItems
                ? pricedItems.map(it => ({ name: it.name, price: it.unitPrice, quantity: it.qty }))
                : [{ name: finalProductName, price: Number(computedAmount), quantity: 1 }]),
              { name: 'Payment processing fee', price: gatewayFee, quantity: 1 },
            ],
            firstname,
            lastname,
            email: email || undefined,
            phone: phone || undefined,
            address: safeAddress,
            returnUrl,
            webhookUrl:       env.SLICKPAY_WEBHOOK_URL || undefined,
            webhookSignature: env.SLICKPAY_WEBHOOK_SIG || undefined,
            webhookMetaData:  { order_id: orderId, product_id: product_id || '' },
            // We already fold SlickPay's flat commission into `chargeAmount`
            // above (as its own "Payment processing fee" line item), so the
            // customer is already paying it there. Passing fees: 100 here
            // tells SlickPay's own API to ALSO add its commission on top at
            // the CIB payment page, which is what was stacking a second
            // 40 DA on the total (500 -> 540). fees: 0 = merchant absorbs
            // SlickPay's cut out of the chargeAmount we already collected,
            // instead of it being charged to the customer a second time.
            fees: 0,
          });
        } catch (err) {
          console.error('[checkout] SlickPay error:', err.message);
          if (err instanceof SlickPayError) {
            const isNoRib = err.message.toLowerCase().includes('server error') || err.status === 500;
            return json({ error: isNoRib ? 'Payment service temporarily unavailable. Please try another method.' : err.message }, isNoRib ? 503 : 502);
          }
          return json({ error: 'Payment gateway error.' }, 502);
        }

        // The root-level `url` is the SATIM card page; `invoice.url` is the merchant view
        const paymentUrl = invoiceData.url;
        const invoiceId  = invoiceData.id;

        if (!paymentUrl) {
          return json({ error: 'Payment gateway did not return a payment URL.' }, 502);
        }

        // Persist the pending order in Firestore (best-effort — don't block payment)
        try {
          await Firestore.setDoc(env, 'slickpay_orders', orderId, {
            orderId,
            invoiceId: String(invoiceId),
            product_id:   product_id       || (pricedItems && pricedItems.length === 1 ? pricedItems[0].productId : ''),
            product_name: finalProductName || '',
            amount:       Number(chargeAmount),      // total actually charged to the customer (products + gateway fee)
            productsAmount: Number(computedAmount),  // products-only subtotal, for reference
            gatewayFee:   gatewayFee,
            items:        pricedItems || null,
            userId:       user_id    || '',
            userEmail:    user_email || email || '',
            firstname,
            lastname,
            email:        email        || '',
            phone:        phone        || '',
            address:      safeAddress,
            status:       'pending',
            paymentUrl,
            createdAt:    new Date().toISOString(),
          });
        } catch (fsErr) {
          // Non-fatal — log and continue
          console.error('[checkout] Firestore write failed:', fsErr.message);
        }

        return json({ order_id: orderId, payment_url: paymentUrl, amount: Number(chargeAmount), invoice_id: invoiceId });

      } catch (err) {
        console.error('[checkout] unexpected error:', err.message);
        return json({ error: 'Internal server error.' }, 500);
      }
    }

    // ============================================================
    // ROUTE: GET /api/checkout/status/:order_id
    // Polls SlickPay for payment status.
    // Returns { status, completed, invoice_id, rejection_reason }
    // ============================================================
    if (path.startsWith('/api/checkout/status/') && method === 'GET') {
      try {
        const orderId = path.replace('/api/checkout/status/', '').trim();
        if (!orderId) return json({ error: 'Missing order_id.' }, 400);

        // Fetch our persisted order from Firestore
        let order = null;
        try {
          order = await Firestore.getDoc(env, 'slickpay_orders', orderId);
        } catch { /* not found */ }

        if (!order || !order.invoiceId) {
          return json({ error: 'Order not found.' }, 404);
        }

        // If already marked paid/delivered, return immediately. If payment was
        // confirmed on a previous poll but delivery hadn't finished yet
        // (status === 'paid'), retry delivery now before responding.
        if (order.status === 'paid' || order.status === 'delivered') {
          if (order.status === 'paid') {
            try {
              await deliverOrder(env, order);
              await Firestore.updateDoc(env, 'slickpay_orders', orderId, { status: 'delivered' });
            } catch (fsErr) {
              console.error('[checkout/status] delivery retry failed:', fsErr.message);
            }
          }
          return json({ status: 'paid', completed: 1, invoice_id: order.invoiceId, rejection_reason: null });
        }

        // Poll SlickPay for fresh status
        let invoiceStatus;
        try {
          invoiceStatus = await SlickPay.getInvoice(env, order.invoiceId);
        } catch (err) {
          return json({ status: order.status, completed: 0, invoice_id: order.invoiceId, rejection_reason: err.message });
        }

        const completed = invoiceStatus.completed === 1 ? 1 : 0;
        const rejectionReason = invoiceStatus.data?.rejection_reason || null;

        // Payment confirmed — create the buyer's `purchases` doc(s) right away
        // (auto-delivered if the product has an auto-delivery link configured,
        // otherwise queued as `pending` for the admin to fulfill manually),
        // then mark the order as delivered so we never re-run this twice.
        if (completed === 1 && order.status === 'pending') {
          try {
            await deliverOrder(env, order);
            await Firestore.updateDoc(env, 'slickpay_orders', orderId, {
              status:  'delivered',
              paidAt:  new Date().toISOString(),
            });
          } catch (fsErr) {
            console.error('[checkout/status] Firestore update failed:', fsErr.message);
          }
        }

        return json({
          status:           completed === 1 ? 'paid' : order.status,
          completed,
          invoice_id:       order.invoiceId,
          rejection_reason: rejectionReason,
        });

      } catch (err) {
        console.error('[checkout/status] unexpected error:', err.message);
        return json({ error: 'Internal server error.' }, 500);
      }
    }

    // ── 404 for unknown /api routes ───────────────────────────────
    if (path.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }

    // ── Non-API routes: serve static files via the ASSETS binding ──
    return env.ASSETS.fetch(request);
  },
};