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
    'User-Agent':    'DigiStoreDZ/1.0 (+https://digital-website.chakchak1256.workers.dev)',
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

// ---------------------------------------------------------------
// Firestore REST helper, authenticated via Google service-account JWT
// (RS256, signed with Web Crypto — no firebase-admin, no jose/jsonwebtoken)
// ---------------------------------------------------------------
let _cachedAccessToken = null; // { token, expiresAt } — per-isolate cache

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

async function getFirebaseAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedAccessToken && _cachedAccessToken.expiresAt > now + 30) {
    return _cachedAccessToken.token;
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
    scope: 'https://www.googleapis.com/auth/datastore',
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

  _cachedAccessToken = { token: tokenData.access_token, expiresAt: now + tokenData.expires_in };
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
  const priced = [];
  for (const item of cartItems) {
    const productId = item.productId || item.id;
    const product = await Firestore.getDoc(env, 'products', productId);
    if (!product) throw new Error(`Product not found: ${productId}`);
    const unitPrice = resolveVariantPrice(product, item.variantLabel);
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    priced.push({
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
    });
  }
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

  for (const item of items) {
    let { autoDeliver, deliveryLink, deliveryType, images, category, name } = item;

    // Legacy items may not carry delivery info — fetch the product once.
    if (autoDeliver === undefined && item.productId) {
      try {
        const product = await Firestore.getDoc(env, 'products', item.productId);
        if (product) {
          autoDeliver  = !!product.autoDeliver;
          deliveryLink = product.deliveryLink || '';
          deliveryType = product.deliveryType || 'link';
          images       = product.images || [];
          category     = product.category || '';
          name         = name || product.name;
        }
      } catch { /* best-effort */ }
    }

    const isAuto = !!(autoDeliver && deliveryLink);

    const purchaseDoc = {
      userId:        order.userId,
      userEmail:     order.userEmail || order.email || '',
      productId:     item.productId || '',
      productName:   item.variantLabel ? `${name || ''} — ${item.variantLabel}` : (name || ''),
      productImage:  (images || [])[0] || '',
      productType:   category || 'Digital',
      accessLink:    isAuto ? deliveryLink : '',
      accessData:    isAuto ? { '_DeliveryType': deliveryType || 'link', 'Download Link': deliveryLink } : {},
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
      'Access-Control-Allow-Headers': 'Content-Type',
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
    // ROUTE: POST /api/webhook
    // Receives SlickPay's async payment notification. This is a backstop
    // to the status-poll endpoint below — it lets an order get delivered
    // even if the buyer closes the tab right after paying.
    // ============================================================
    if (path === '/api/webhook' && method === 'POST') {
      try {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        // Optional signature check, if a webhook secret is configured.
        if (env.SLICKPAY_WEBHOOK_SIG) {
          const sig = body.webhook_signature || body.signature || request.headers.get('x-webhook-signature') || '';
          const ok = await constantTimeEqual(String(sig), String(env.SLICKPAY_WEBHOOK_SIG));
          if (!ok) return json({ error: 'Invalid webhook signature.' }, 403);
        }

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
          product_id, product_name, amount, firstname, lastname, email, phone, address,
          items: rawItems, user_id, user_email,
        } = body || {};
        const safeAddress = (address && address.trim().length >= 5) ? address.trim() : 'Algérie - Livraison numérique';

        if (!firstname || !lastname || (!email && !phone)) {
          return json({ error: 'Missing required fields: firstname, lastname, and email or phone.' }, 400);
        }

        // If the client sent the full cart, re-derive pricing server-side —
        // never trust the client-computed `amount`. This also lets us know
        // exactly which products/variants were bought so the order can be
        // auto-delivered once paid.
        let pricedItems = null;
        let computedAmount = Number(amount) || 0;
        if (Array.isArray(rawItems) && rawItems.length) {
          try {
            pricedItems = await priceCartItems(env, rawItems.map(it => ({
              productId:    it.product_id || it.productId || it.id,
              variantLabel: it.variant_label || it.variantLabel || null,
              qty:          it.qty || 1,
            })));
          } catch (err) {
            return json({ error: 'Failed to price cart items: ' + err.message }, 400);
          }
          computedAmount = pricedItems.reduce((sum, it) => sum + it.unitPrice * it.qty, 0);
        }

        const finalProductName = product_name || (pricedItems
          ? (pricedItems.length === 1 ? pricedItems[0].name : `Order (${pricedItems.length} items)`)
          : '');

        if (!finalProductName || !computedAmount) {
          return json({ error: 'Missing required fields: product_name/items and amount.' }, 400);
        }
        if (Number(computedAmount) <= 100) {
          return json({ error: 'Amount must be greater than 100 DZD.' }, 400);
        }

        const appUrl = env.APP_URL || 'https://digital-website.chakchak1256.workers.dev';
        const returnUrl = `${appUrl}/payment-return.html`;

        // Generate a short order ID stored in webhook meta
        const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

        let invoiceData;
        try {
          invoiceData = await SlickPay.createInvoice(env, {
            amount: Number(computedAmount),
            items: pricedItems
              ? pricedItems.map(it => ({ name: it.name, price: it.unitPrice, quantity: it.qty }))
              : [{ name: finalProductName, price: Number(computedAmount), quantity: 1 }],
            firstname,
            lastname,
            email: email || undefined,
            phone: phone || undefined,
            address: safeAddress,
            returnUrl,
            webhookUrl:       env.SLICKPAY_WEBHOOK_URL || undefined,
            webhookSignature: env.SLICKPAY_WEBHOOK_SIG || undefined,
            webhookMetaData:  { order_id: orderId, product_id: product_id || '' },
            fees: 100, // client pays commission
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
            amount:       Number(computedAmount),
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

        return json({ order_id: orderId, payment_url: paymentUrl, amount: Number(computedAmount), invoice_id: invoiceId });

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