// ================================================================
// WORKER.JS — DigiStore DZ × Chargily Pay
// Cloudflare Worker (no Node.js, no Express, no dependencies)
// Deploy via: Cloudflare Dashboard → Workers & Pages → Create Worker
// ================================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;
    const path   = url.pathname;

    // ── CORS headers (added to every response) ───────────────────
    const corsHeaders = {
      'Access-Control-Allow-Origin':  env.ALLOWED_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
    };

    // Handle preflight OPTIONS requests
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Helper: JSON response ─────────────────────────────────────
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    // ── Config from environment variables (set in CF dashboard) ──
    const CHARGILY_SECRET_KEY = env.CHARGILY_SECRET_KEY;
    const CHARGILY_BASE_URL   = env.CHARGILY_MODE === 'live'
      ? 'https://pay.chargily.net/api/v2'
      : 'https://pay.chargily.net/test/api/v2';

    // APP_URL = your Cloudflare Pages domain (where HTML files are hosted)
    // e.g. https://digitalwebsite.pages.dev  OR  https://yourdomain.com
    const APP_URL = env.APP_URL || 'https://digitalwebsite.pages.dev';

    // ============================================================
    // ROUTE: GET /api/health
    // ============================================================
    if (path === '/api/health' && method === 'GET') {
      return json({ status: 'ok', mode: env.CHARGILY_MODE || 'test' });
    }

    // ============================================================
    // ROUTE: POST /api/checkout
    // Creates a Chargily Pay checkout session.
    // ============================================================
    if (path === '/api/checkout' && method === 'POST') {
      try {
        if (!CHARGILY_SECRET_KEY) {
          return json({ error: 'Chargily secret key not configured.' }, 500);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'Invalid JSON body.' }, 400);
        }

        const { items, customer, userId, purchaseIds = [], locale = 'ar' } = body;

        // ── Validate ────────────────────────────────────────────
        if (!items || !Array.isArray(items) || items.length === 0) {
          return json({ error: 'items array is required and must not be empty.' }, 400);
        }
        if (!customer || !customer.email) {
          return json({ error: 'customer.email is required.' }, 400);
        }

        // ── Calculate total ─────────────────────────────────────
        const total = items.reduce(
          (sum, item) => sum + Number(item.price) * Number(item.quantity || 1), 0
        );
        if (total <= 0) {
          return json({ error: 'Total amount must be greater than 0.' }, 400);
        }

        const description = items.map(i => `${i.name} ×${i.quantity || 1}`).join(', ');

        // ── Build redirect URLs ─────────────────────────────────
        // The meta param lets the success/failure pages know which user + purchases
        const metaParam  = encodeURIComponent(JSON.stringify({ userId, purchaseIds }));
        const successUrl = `${APP_URL}/payment-success.html?meta=${metaParam}`;
        const failureUrl = `${APP_URL}/payment-failure.html?meta=${metaParam}`;
        // Webhook points back to THIS worker
        const webhookUrl = `${new URL(request.url).origin}/api/webhook`;

        // ── Call Chargily API ───────────────────────────────────
        const chargilyRes = await fetch(`${CHARGILY_BASE_URL}/checkouts`, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${CHARGILY_SECRET_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            amount:       total,
            currency:     'dzd',
            description,
            locale,
            success_url:      successUrl,
            failure_url:      failureUrl,
            webhook_endpoint: webhookUrl,
            collect_shipping_address: false,
            metadata: {
              userId:        userId        || '',
              purchaseIds:   purchaseIds.join(','),
              customerEmail: customer.email,
              customerName:  customer.name || '',
            },
          }),
        });

        const chargilyData = await chargilyRes.json();

        if (!chargilyRes.ok) {
          return json({
            error:   chargilyData.message || 'Chargily API error.',
            details: chargilyData,
          }, chargilyRes.status);
        }

        return json({
          checkout_url: chargilyData.checkout_url,
          checkout_id:  chargilyData.id,
        });

      } catch (err) {
        return json({ error: 'Internal server error.', message: err.message }, 500);
      }
    }

    // ============================================================
    // ROUTE: POST /api/webhook
    // Receives Chargily events, verifies HMAC-SHA256 signature,
    // then updates Firestore via the REST API (no Firebase SDK needed).
    // ============================================================
    if (path === '/api/webhook' && method === 'POST') {
      try {
        if (!CHARGILY_SECRET_KEY) {
          return new Response('Server misconfigured', { status: 500 });
        }

        // ── 1. Read raw body (needed for signature check) ───────
        const rawBody = await request.arrayBuffer();
        const bodyBytes = new Uint8Array(rawBody);

        // ── 2. Verify HMAC-SHA256 signature ─────────────────────
        // Cloudflare Workers support SubtleCrypto natively
        const signature = request.headers.get('signature') || '';
        if (!signature) {
          return new Response('Missing signature', { status: 400 });
        }

        const keyMaterial = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(CHARGILY_SECRET_KEY),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );

        const signatureBytes = await crypto.subtle.sign('HMAC', keyMaterial, bodyBytes);
        const computedSig = Array.from(new Uint8Array(signatureBytes))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (computedSig !== signature.toLowerCase()) {
          return new Response('Signature mismatch', { status: 403 });
        }

        // ── 3. Parse event ───────────────────────────────────────
        const event = JSON.parse(new TextDecoder().decode(bodyBytes));

        // ── 4. Handle checkout.paid ──────────────────────────────
        if (event.type === 'checkout.paid') {
          const checkout    = event.data;
          const meta        = checkout.metadata || {};
          const purchaseIds = (meta.purchaseIds || '')
            .split(',').map(id => id.trim()).filter(Boolean);

          if (purchaseIds.length > 0) {
            // Update Firestore via REST API (no SDK required in Workers)
            // Uses a Google OAuth2 service account token stored as env var
            await updateFirestorePurchases(purchaseIds, checkout, env);
          }
        }

        // Always respond 200 immediately so Chargily doesn't retry
        return new Response('OK', { status: 200 });

      } catch (err) {
        // Still 200 — prevents Chargily from retrying on our errors
        console.error('[webhook] error:', err.message);
        return new Response('OK', { status: 200 });
      }
    }

    // ============================================================
    // ROUTE: GET /api/verify-checkout/:id
    // ============================================================
    const verifyMatch = path.match(/^\/api\/verify-checkout\/([^/]+)$/);
    if (verifyMatch && method === 'GET') {
      try {
        if (!CHARGILY_SECRET_KEY) {
          return json({ error: 'Server configuration error.' }, 500);
        }

        const id = verifyMatch[1];
        const chargilyRes = await fetch(`${CHARGILY_BASE_URL}/checkouts/${id}`, {
          headers: { 'Authorization': `Bearer ${CHARGILY_SECRET_KEY}` },
        });

        const data = await chargilyRes.json();

        if (!chargilyRes.ok) {
          return json({ error: 'Could not retrieve checkout.' }, chargilyRes.status);
        }

        // Return only a safe subset — never expose full Chargily data
        return json({ id: data.id, status: data.status, amount: data.amount });

      } catch (err) {
        return json({ error: 'Internal server error.' }, 500);
      }
    }

    // ============================================================
    // ROUTE: POST /api/upload-file
    // Admin uploads a file (PDF/etc). Worker forwards it to Firebase
    // Storage server-to-server using the service account — this is
    // what avoids the browser CORS problem entirely, since the
    // browser only ever talks to this Worker, never to Firebase
    // Storage directly.
    //
    // Request: multipart/form-data with fields:
    //   file   — the binary file
    //   folder — storage path prefix, e.g. "deliveries/<purchaseId>"
    // Response: { url, path, name, size }
    // ============================================================
    if (path === '/api/upload-file' && method === 'POST') {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
          return json({ error: 'Server is missing Firebase credentials.' }, 500);
        }

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

        const MAX_BYTES = 50 * 1024 * 1024; // 50MB, matches the admin panel's limit
        if (file.size > MAX_BYTES) {
          return json({ error: 'File is too large — must be under 50MB.' }, 400);
        }

        const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const safeFolder = folder.replace(/[^a-zA-Z0-9/_\-]/g, '_').replace(/^\/+/, '');
        const objectPath = `${safeFolder}/${Date.now()}_${safeName}`;
        const contentType = file.type || 'application/octet-stream';

        const fileBytes = await file.arrayBuffer();

        // ── 1. Get an access token scoped for Storage R/W ──────────
        const token = await getGoogleAccessToken(
          env,
          'https://www.googleapis.com/auth/devstorage.read_write'
        );

        const bucket = env.FIREBASE_STORAGE_BUCKET || `${env.FIREBASE_PROJECT_ID}.firebasestorage.app`;

        // ── 2. Upload the bytes via the GCS JSON API ────────────────
        // contentDisposition forces a download (not inline preview)
        // when a customer opens the link, matching the old SDK upload.
        const uploadUrl =
          `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
          `?uploadType=media&name=${encodeURIComponent(objectPath)}`;

        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': contentType,
          },
          body: fileBytes,
        });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          console.error('[upload-file] GCS upload failed:', errText);
          return json({ error: 'Upload to storage failed.' }, 502);
        }

        // ── 3. Set Content-Disposition + make the object public ────
        // (so the resulting download URL works without auth, same
        // behavior as the old getDownloadURL() from the Storage SDK)
        const metaUrl =
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}`;

        await fetch(metaUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contentDisposition: `attachment; filename="${file.name || safeName}"`,
          }),
        });

        await fetch(`${metaUrl}/acl`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ entity: 'allUsers', role: 'READER' }),
        });

        // ── 4. Build the public download URL ─────────────────────
        const downloadUrl =
          `https://storage.googleapis.com/${bucket}/${encodeURIComponent(objectPath).replace(/%2F/g, '/')}`;

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
    // Deletes a previously uploaded file from Firebase Storage.
    // Body: { path: "deliveries/<purchaseId>/<filename>" }
    // ============================================================
    if (path === '/api/delete-file' && method === 'POST') {
      try {
        if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
          return json({ error: 'Server is missing Firebase credentials.' }, 500);
        }

        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        const objectPath = (body.path || '').toString();
        if (!objectPath) return json({ error: 'path is required.' }, 400);

        const token = await getGoogleAccessToken(
          env,
          'https://www.googleapis.com/auth/devstorage.read_write'
        );
        const bucket = env.FIREBASE_STORAGE_BUCKET || `${env.FIREBASE_PROJECT_ID}.firebasestorage.app`;
        const deleteUrl =
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}`;

        const res = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });

        // 404 just means it's already gone — treat as success either way
        if (!res.ok && res.status !== 404) {
          const errText = await res.text();
          console.warn('[delete-file] GCS delete failed:', errText);
        }

        return json({ ok: true });

      } catch (err) {
        console.error('[delete-file] error:', err.message);
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

// ================================================================
// FIRESTORE REST HELPER
// Updates purchase documents to status:"paid" using the Firestore
// REST API + a Google service account JWT — no Firebase SDK needed.
// ================================================================
async function updateFirestorePurchases(purchaseIds, checkout, env) {
  try {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
      console.warn('[webhook] Firebase env vars missing — skipping Firestore update.');
      console.log('[webhook] Would have marked paid:', purchaseIds);
      return;
    }

    // ── 1. Get a Google OAuth2 access token via JWT ──────────────
    const token = await getGoogleAccessToken(env);

    // ── 2. Update each purchase doc via Firestore REST API ───────
    const now = new Date().toISOString();
    const updatePromises = purchaseIds.map(async (docId) => {
      const firestoreUrl =
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/purchases/${docId}` +
        `?updateMask.fieldPaths=status&updateMask.fieldPaths=chargilyId&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=paymentMethod`;

      const body = {
        fields: {
          status:        { stringValue: 'paid' },
          chargilyId:    { stringValue: checkout.id || '' },
          paidAt:        { stringValue: now },
          paymentMethod: { stringValue: checkout.payment_method || 'unknown' },
        },
      };

      const res = await fetch(firestoreUrl, {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[webhook] Firestore update failed for ${docId}:`, err);
      } else {
        console.log(`[webhook] Purchase marked paid: ${docId}`);
      }
    });

    await Promise.all(updatePromises);

  } catch (err) {
    console.error('[webhook] updateFirestorePurchases error:', err.message);
  }
}

// ================================================================
// GOOGLE JWT HELPER
// Signs a JWT with the service account private key and exchanges
// it for a short-lived OAuth2 access token.
// Cloudflare Workers support SubtleCrypto — no libraries needed.
// ================================================================
async function getGoogleAccessToken(env, scope = 'https://www.googleapis.com/auth/datastore') {
  const clientEmail  = env.FIREBASE_CLIENT_EMAIL;
  const privateKeyPem = (env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const now     = Math.floor(Date.now() / 1000);
  const expires = now + 3600;

  // ── 1. Build JWT header + claims ────────────────────────────────
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss:   clientEmail,
    scope,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   expires,
  };

  const encode = obj =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const headerB64  = encode(header);
  const claimsB64  = encode(claims);
  const sigInput   = `${headerB64}.${claimsB64}`;

  // ── 2. Import the RSA private key ────────────────────────────────
  // Strip PEM headers and decode base64
  const pemBody = privateKeyPem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // ── 3. Sign the JWT ───────────────────────────────────────────────
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${sigInput}.${sigB64}`;

  // ── 4. Exchange JWT for access token ─────────────────────────────
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get Google access token: ' + JSON.stringify(tokenData));
  }

  return tokenData.access_token;
}