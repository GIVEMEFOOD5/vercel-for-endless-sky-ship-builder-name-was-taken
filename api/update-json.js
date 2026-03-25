/* ═══════════════════════════════════════════════════════════════
   /api/update-json.js  —  Vercel Serverless Function
   Receives a POST request from the GitHub Pages frontend and
   updates plugins.json in the GitHub repository via the GitHub
   REST API.  The GitHub token never leaves this function.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Configuration ───────────────────────────────────────────────
   All three values must be set:
     GITHUB_TOKEN  → Vercel environment variable (never hardcoded)
     GITHUB_OWNER  → Vercel environment variable  e.g. "jane-doe"
     GITHUB_REPO   → Vercel environment variable  e.g. "endless-sky-plugins"
     GITHUB_PATH   → Vercel environment variable  e.g. "plugins.json"
                     (can be a sub-path: "data/plugins.json")
   ─────────────────────────────────────────────────────────────── */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_PATH  = process.env.GITHUB_PATH || 'plugins.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main'; // or 'master'

/* ── Optional simple shared secret for basic access control ──────
   Set SECRET_KEY in your Vercel env vars and send it from the
   frontend in the X-Update-Secret header.
   Leave SECRET_KEY unset to disable this check entirely.
   ─────────────────────────────────────────────────────────────── */
const SECRET_KEY = process.env.SECRET_KEY;

/* ── GitHub API base URL ──────────────────────────────────────── */
const GH_API = 'https://api.github.com';

/* ── CORS: list every origin that is allowed to call this API ────
   Replace with your actual GitHub Pages domain.
   ─────────────────────────────────────────────────────────────── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/* ═══════════════════════════════════════════════════════════════
   Helper: build CORS headers for a given request origin
   ═══════════════════════════════════════════════════════════════ */
function corsHeaders(requestOrigin) {
    // If no allowed origins are configured, deny cross-origin requests.
    // During local dev you can set ALLOWED_ORIGINS=* in .env.local
    const allow =
        ALLOWED_ORIGINS.includes('*') ? '*' :
        ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin :
        null;

    if (!allow) return {};   // caller will return 403

    return {
        'Access-Control-Allow-Origin':  allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Update-Secret',
        'Access-Control-Max-Age':       '86400',
    };
}

/* ═══════════════════════════════════════════════════════════════
   Helper: call the GitHub Contents API
   ═══════════════════════════════════════════════════════════════ */
async function githubFetch(path, options = {}) {
    const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            Accept:        'application/vnd.github+json',
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });

    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
}

/* ═══════════════════════════════════════════════════════════════
   Main handler — exported as default for Vercel
   ═══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    const cors   = corsHeaders(origin);

    /* ── Reject disallowed origins ───────────────────────────── */
    if (origin && Object.keys(cors).length === 0) {
        return res.status(403).json({ error: 'Origin not allowed.' });
    }

    /* ── Set CORS headers on every response ──────────────────── */
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    /* ── Handle CORS pre-flight ──────────────────────────────── */
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    /* ── Only POST is accepted ───────────────────────────────── */
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    /* ── Verify shared secret (optional, recommended) ────────── */
    if (SECRET_KEY) {
        const provided = req.headers['x-update-secret'] || '';
        if (provided !== SECRET_KEY) {
            return res.status(401).json({ error: 'Unauthorised: invalid or missing secret.' });
        }
    }

    /* ── Validate environment variables ──────────────────────── */
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        console.error('[update-json] Missing required environment variables.');
        return res.status(500).json({ error: 'Server misconfiguration: missing env vars.' });
    }

    /* ── Parse and validate the request body ─────────────────── */
    let payload;
    try {
        // Vercel automatically parses JSON bodies; fall back to manual parse
        payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Invalid JSON body.' });
    }

    if (!payload || !Array.isArray(payload.plugins)) {
        return res.status(400).json({ error: 'Body must be { plugins: [...] }.' });
    }

    /* ── Step 1: fetch the current file to get its SHA ───────── */
    const getResult = await githubFetch().catch(err => {
        console.error('[update-json] Network error fetching file:', err);
        return null;
    });

    if (!getResult) {
        return res.status(502).json({ error: 'Could not reach GitHub API.' });
    }

    if (!getResult.ok) {
        const msg = getResult.body?.message || `HTTP ${getResult.status}`;
        console.error('[update-json] GitHub GET failed:', msg);
        return res.status(502).json({ error: `GitHub API error: ${msg}` });
    }

    const currentSha = getResult.body?.sha;
    if (!currentSha) {
        return res.status(502).json({ error: 'Could not retrieve file SHA from GitHub.' });
    }

    /* ── Step 2: encode the new content as base64 ────────────── */
    const newContent   = JSON.stringify({ plugins: payload.plugins }, null, 2);
    const base64Content = Buffer.from(newContent, 'utf8').toString('base64');

    /* ── Step 3: commit the new content via PUT ──────────────── */
    const putResult = await githubFetch(null, {
        method: 'PUT',
        body: JSON.stringify({
            message: 'chore: update plugins.json via plugin manager',
            content: base64Content,
            sha:     currentSha,
            branch:  GITHUB_BRANCH,
        }),
    }).catch(err => {
        console.error('[update-json] Network error writing file:', err);
        return null;
    });

    if (!putResult) {
        return res.status(502).json({ error: 'Could not reach GitHub API for write.' });
    }

    if (!putResult.ok) {
        const msg = putResult.body?.message || `HTTP ${putResult.status}`;
        console.error('[update-json] GitHub PUT failed:', msg);
        return res.status(502).json({ error: `GitHub commit failed: ${msg}` });
    }

    /* ── All done ────────────────────────────────────────────── */
    return res.status(200).json({
        ok:     true,
        commit: putResult.body?.commit?.sha ?? null,
    });
}