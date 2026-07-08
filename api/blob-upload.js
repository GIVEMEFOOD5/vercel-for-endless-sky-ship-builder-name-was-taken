/* ═══════════════════════════════════════════════════════════════
   /api/blob-upload.js  —  Vercel Serverless Function
   Issues short-lived Vercel Blob upload tokens directly to the
   browser, so the archive file itself NEVER passes through a
   Vercel Function body (which is capped at 4.5MB) — the browser
   uploads straight to Vercel Blob storage.

   This endpoint does NOT write to GitHub. Once the browser's
   upload finishes, the client calls /api/commit-archive with the
   resulting blob URL to actually commit the file into the repo.

   Required Vercel environment variables:
     BLOB_READ_WRITE_TOKEN → created automatically when you connect
                              a Vercel Blob store to this project
     ALLOWED_ORIGINS        → comma-separated list of allowed origins
     SECRET_KEY             → optional shared secret (same one used
                               by update-json.js), checked via the
                               clientPayload the frontend sends
   ═══════════════════════════════════════════════════════════════ */

'use strict';

import { handleUpload } from '@vercel/blob/client';

const SECRET_KEY = process.env.SECRET_KEY;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// Hard cap — enforced here server-side. The client also checks this before
// starting an upload so people get instant feedback, but THIS is the check
// that actually matters since client-side checks can be bypassed.
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024; // 90 MB

const ALLOWED_CONTENT_TYPES = [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-tar',
    'application/gzip',
    'application/x-gzip',
    'application/x-bzip2',
    'application/octet-stream', // browsers often report this for .tar/.tgz
];

function corsHeaders(requestOrigin) {
    const allow =
        ALLOWED_ORIGINS.includes('*')           ? '*'           :
        ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin :
        null;
    if (!allow) return {};
    return {
        'Access-Control-Allow-Origin':  allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age':       '86400',
    };
}

export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    const cors   = corsHeaders(origin);

    if (origin && Object.keys(cors).length === 0)
        return res.status(403).json({ error: 'Origin not allowed.' });

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    try {
        const jsonResponse = await handleUpload({
            body,
            request: req,

            onBeforeGenerateToken: async (pathname, clientPayload) => {
                // Optional shared-secret check, mirroring update-json.js.
                if (SECRET_KEY) {
                    let parsed = {};
                    try { parsed = JSON.parse(clientPayload || '{}'); } catch { /* ignore */ }
                    if (parsed.secret !== SECRET_KEY) {
                        throw new Error('Unauthorised: invalid or missing secret.');
                    }
                }

                return {
                    allowedContentTypes: ALLOWED_CONTENT_TYPES,
                    maximumSizeInBytes:  MAX_UPLOAD_BYTES,
                    addRandomSuffix:     true,
                    // We don't need the upload-completed webhook — the client
                    // calls /api/commit-archive itself right after upload()
                    // resolves, so nothing else needs to happen here.
                };
            },

            onUploadCompleted: async () => {
                // Intentionally a no-op — see note above.
            },
        });

        return res.status(200).json(jsonResponse);
    } catch (err) {
        console.error('[blob-upload] error:', err.message);
        return res.status(400).json({ error: err.message });
    }
};
