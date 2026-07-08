/* ═══════════════════════════════════════════════════════════════
   /api/commit-archive.js  —  Vercel Serverless Function
   Takes a blob URL that the browser already uploaded straight to
   Vercel Blob (see blob-upload.js) and commits its contents into
   the GitHub repo under rawData/<name>.<ext>, using the Git Data
   API (blob → tree → commit → ref) rather than the simpler
   Contents API, because Contents API PUT gets unreliable well
   before 90MB in practice even though GitHub documents a 100MB
   ceiling.

   Once committed, the temporary file is deleted from Vercel Blob
   storage — GitHub is the permanent home for it, Blob storage was
   only ever a relay.

   Required Vercel environment variables (same GitHub ones as
   update-json.js, plus BLOB_READ_WRITE_TOKEN which the Vercel
   Blob store connection adds automatically):
     GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
     ALLOWED_ORIGINS, SECRET_KEY (optional)
     BLOB_READ_WRITE_TOKEN
     RAW_DATA_DIR → folder to commit archives into (defaults to "rawData")
   ═══════════════════════════════════════════════════════════════ */

'use strict';

import { del } from '@vercel/blob';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SECRET_KEY    = process.env.SECRET_KEY;
const RAW_DATA_DIR  = process.env.RAW_DATA_DIR || 'rawData';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

const MAX_UPLOAD_BYTES = 90 * 1024 * 1024; // 90 MB — defense in depth

const ALLOWED_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2'];

const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

const GH_HEADERS = {
    Accept:                 'application/vnd.github+json',
    Authorization:          `Bearer ${GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
};

function corsHeaders(requestOrigin) {
    const allow =
        ALLOWED_ORIGINS.includes('*')           ? '*'           :
        ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin :
        null;
    if (!allow) return {};
    return {
        'Access-Control-Allow-Origin':  allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Update-Secret',
        'Access-Control-Max-Age':       '86400',
    };
}

function sanitiseName(name) {
    // Keep this conservative: letters, numbers, dashes, underscores, spaces.
    // Anything else gets stripped so it's always a safe path segment.
    return String(name || '').trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 80);
}

function detectExtension(filename) {
    const lower = String(filename || '').toLowerCase();
    // longest-suffix-first so ".tar.gz" isn't mistaken for ".gz"
    for (const ext of ['.tar.gz', '.tar.bz2']) {
        if (lower.endsWith(ext)) return ext;
    }
    for (const ext of ['.zip', '.tar', '.tgz', '.tbz2']) {
        if (lower.endsWith(ext)) return ext;
    }
    return null;
}

async function githubJson(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body?.message || `GitHub API error ${res.status} at ${url}`);
    }
    return body;
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

    if (SECRET_KEY) {
        const provided = req.headers['x-update-secret'] || '';
        if (provided !== SECRET_KEY)
            return res.status(401).json({ error: 'Unauthorised: invalid or missing secret.' });
    }

    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        console.error('[commit-archive] Missing required environment variables.');
        return res.status(500).json({ error: 'Server misconfiguration: missing env vars.' });
    }

    let payload;
    try {
        payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Invalid JSON body.' });
    }

    const { blobUrl, pluginName, fileName } = payload || {};
    if (!blobUrl || !pluginName || !fileName)
        return res.status(400).json({ error: 'Body must include blobUrl, pluginName, and fileName.' });

    const ext = detectExtension(fileName);
    if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
        return res.status(400).json({
            error: `Unsupported archive type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
        });
    }

    const safeName = sanitiseName(pluginName);
    if (!safeName) return res.status(400).json({ error: 'Invalid plugin name.' });

    const targetPath = `${RAW_DATA_DIR}/${safeName}${ext}`;

    /* ── Step 1: fetch the uploaded archive from Vercel Blob ─────────── */
    let buffer;
    try {
        const blobRes = await fetch(blobUrl);
        if (!blobRes.ok) throw new Error(`Could not fetch uploaded file (HTTP ${blobRes.status})`);
        const arrayBuffer = await blobRes.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
    } catch (err) {
        return res.status(502).json({ error: `Failed to read uploaded file: ${err.message}` });
    }

    if (buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(413).json({
            error: `File is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, which exceeds the 90MB limit.`
        });
    }

    try {
        /* ── Step 2: create a blob object in the GitHub repo ──────────── */
        const blobResult = await githubJson(`${API_BASE}/git/blobs`, {
            method:  'POST',
            headers: GH_HEADERS,
            body: JSON.stringify({
                content:  buffer.toString('base64'),
                encoding: 'base64',
            }),
        });
        const blobSha = blobResult.sha;

        /* ── Step 3: get the current branch ref + its commit + tree ───── */
        const refResult = await githubJson(
            `${API_BASE}/git/ref/heads/${GITHUB_BRANCH}`,
            { headers: GH_HEADERS }
        );
        const baseCommitSha = refResult.object.sha;

        const baseCommit = await githubJson(
            `${API_BASE}/git/commits/${baseCommitSha}`,
            { headers: GH_HEADERS }
        );
        const baseTreeSha = baseCommit.tree.sha;

        /* ── Step 4: create a new tree with just this file added/updated ─ */
        const newTree = await githubJson(`${API_BASE}/git/trees`, {
            method:  'POST',
            headers: GH_HEADERS,
            body: JSON.stringify({
                base_tree: baseTreeSha,
                tree: [{
                    path: targetPath,
                    mode: '100644',
                    type: 'blob',
                    sha:  blobSha,
                }],
            }),
        });

        /* ── Step 5: create a commit pointing at the new tree ─────────── */
        const newCommit = await githubJson(`${API_BASE}/git/commits`, {
            method:  'POST',
            headers: GH_HEADERS,
            body: JSON.stringify({
                message: `chore: upload archive "${safeName}" via plugin manager`,
                tree:    newTree.sha,
                parents: [baseCommitSha],
            }),
        });

        /* ── Step 6: fast-forward the branch ref to the new commit ────── */
        await githubJson(`${API_BASE}/git/refs/heads/${GITHUB_BRANCH}`, {
            method:  'PATCH',
            headers: GH_HEADERS,
            body: JSON.stringify({ sha: newCommit.sha }),
        });

        /* ── Step 7: clean up the temporary Blob copy (non-fatal) ──────── */
        try {
            await del(blobUrl);
        } catch (err) {
            console.warn('[commit-archive] Could not delete temp blob (non-fatal):', err.message);
        }

        const rawUrl =
            `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${targetPath}`;

        return res.status(200).json({
            ok:     true,
            commit: newCommit.sha,
            path:   targetPath,
            rawUrl,
        });

    } catch (err) {
        console.error('[commit-archive] GitHub commit failed:', err.message);
        return res.status(502).json({ error: `GitHub commit failed: ${err.message}` });
    }
};
