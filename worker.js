// ================================================================
// WORKER.JS — DigiStore DZ
// Cloudflare Worker (no Node.js, no Express, no dependencies)
// Deploy via: npx wrangler deploy
// ================================================================

// Firebase service account credentials (hardcoded — no secrets needed)
const FIREBASE_PROJECT_ID    = 'generalwebsite-580f9';
const FIREBASE_CLIENT_EMAIL  = 'firebase-adminsdk-fbsvc@generalwebsite-580f9.iam.gserviceaccount.com';
// ⚠️  REPLACE THIS with a fresh key from Firebase Console → Project Settings → Service Accounts → Generate new private key
// The previous key was corrupted (truncated by 1 byte), causing the 500 error on file uploads.
// Paste the FULL "private_key" value from the downloaded JSON here.
const FIREBASE_PRIVATE_KEY   = `-----BEGIN PRIVATE KEY-----
REPLACE_WITH_YOUR_NEW_PRIVATE_KEY_FROM_FIREBASE_CONSOLE
-----END PRIVATE KEY-----`;
const FIREBASE_STORAGE_BUCKET = 'generalwebsite-580f9.firebasestorage.app';

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
    // ROUTE: GET /api/test-auth
    // Diagnoses JWT signing and token exchange step by step.
    // Remove this route after confirming uploads work.
    // ============================================================
    if (path === '/api/test-auth' && method === 'GET') {
      const steps = [];
      try {
        steps.push('step1: building JWT claims');
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const claims = {
          iss: FIREBASE_CLIENT_EMAIL,
          scope: 'https://www.googleapis.com/auth/devstorage.read_write',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        };

        steps.push('step2: base64url encoding header+claims');
        const b64url = str => {
          const bytes = new TextEncoder().encode(str);
          let binary = '';
          for (const b of bytes) binary += String.fromCharCode(b);
          return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        };
        const headerB64 = b64url(JSON.stringify(header));
        const claimsB64 = b64url(JSON.stringify(claims));
        const sigInput = `${headerB64}.${claimsB64}`;

        steps.push('step3: stripping PEM key');
        const pemBody = FIREBASE_PRIVATE_KEY
          .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
          .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
          .replace(/\s/g, '');
        steps.push(`step3 result: PEM body length = ${pemBody.length}`);

        steps.push('step4: decoding PEM to bytes');
        const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
        steps.push(`step4 result: keyBytes length = ${keyBytes.length}`);

        steps.push('step5: importing crypto key');
        const cryptoKey = await crypto.subtle.importKey(
          'pkcs8', keyBytes.buffer,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false, ['sign']
        );
        steps.push('step5 result: key imported OK');

        steps.push('step6: signing JWT');
        const sigBytes = await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5', cryptoKey,
          new TextEncoder().encode(sigInput)
        );
        const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const jwt = `${sigInput}.${sigB64}`;
        steps.push('step6 result: JWT signed OK');

        steps.push('step7: exchanging JWT for access token');
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
        });
        const tokenData = await tokenRes.json();
        steps.push(`step7 result: HTTP ${tokenRes.status}`);

        if (!tokenData.access_token) {
          return json({ ok: false, steps, tokenError: tokenData });
        }
        steps.push('step8: got access token OK');
        return json({ ok: true, steps, tokenType: tokenData.token_type, expiresIn: tokenData.expires_in });

      } catch (e) {
        return json({ ok: false, steps, error: e.message, stack: e.stack });
      }
    }

    // ============================================================
    // ROUTE: POST /api/upload-file
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

        const safeName   = (file.name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const safeFolder = folder.replace(/[^a-zA-Z0-9/_\-]/g, '_').replace(/^\/+/, '');
        const objectPath = `${safeFolder}/${Date.now()}_${safeName}`;
        const contentType = file.type || 'application/octet-stream';
        const fileBytes  = await file.arrayBuffer();

        // Get an access token scoped for Storage R/W
        const token = await getGoogleAccessToken(
          'https://www.googleapis.com/auth/devstorage.read_write'
        );

        const bucket = FIREBASE_STORAGE_BUCKET;

        // Upload the bytes via the GCS JSON API
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
          console.error('[upload-file] GCS upload failed:', uploadRes.status, errText);
          return json({ error: 'Upload to storage failed.', detail: errText, status: uploadRes.status }, 502);
        }

        // Set Content-Disposition
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

        // Make the object public
        await fetch(`${metaUrl}/acl`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ entity: 'allUsers', role: 'READER' }),
        });

        // Build the public download URL
        const pathParts = objectPath.split('/').map(encodeURIComponent).join('/');
        const downloadUrl = `https://storage.googleapis.com/${bucket}/${pathParts}`;

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
    // ============================================================
    if (path === '/api/delete-file' && method === 'POST') {
      try {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

        const objectPath = (body.path || '').toString();
        if (!objectPath) return json({ error: 'path is required.' }, 400);

        const token = await getGoogleAccessToken(
          'https://www.googleapis.com/auth/devstorage.read_write'
        );
        const bucket = FIREBASE_STORAGE_BUCKET;
        const deleteUrl =
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}`;

        const res = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });

        // 404 just means it's already gone — treat as success
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
// GOOGLE JWT HELPER — fixed base64url encoding
// ================================================================
async function getGoogleAccessToken(scope = 'https://www.googleapis.com/auth/datastore') {
  const now     = Math.floor(Date.now() / 1000);
  const expires = now + 3600;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss:   FIREBASE_CLIENT_EMAIL,
    scope,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   expires,
  };

  // Correct base64url: TextEncoder → bytes → binary string → btoa → url-safe
  const b64url = str => {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };

  const headerB64 = b64url(JSON.stringify(header));
  const claimsB64 = b64url(JSON.stringify(claims));
  const sigInput  = `${headerB64}.${claimsB64}`;

  // Strip PEM headers and decode base64
  const pemBody = FIREBASE_PRIVATE_KEY
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

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${sigInput}.${sigB64}`;

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