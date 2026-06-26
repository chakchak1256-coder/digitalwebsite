// ================================================================
// WORKER.JS — DigiStore DZ
// Cloudflare Worker (no Node.js, no Express, no dependencies)
// Deploy via: npx wrangler deploy
//
// File storage: Cloudflare R2 via the native `env.BUCKET` binding.
// Upload flow: browser → Worker → R2 (no presigned URLs).
// Delete flow: Worker → R2.
// ================================================================

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

    // ── 404 for unknown /api routes ───────────────────────────────
    if (path.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }

    // ── Non-API routes: serve static files via the ASSETS binding ──
    return env.ASSETS.fetch(request);
  },
};