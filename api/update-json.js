/* ═══════════════════════════════════════════════════════════════
   /api/update-json.js  —  Vercel Serverless Function
   Receives a POST request from the GitHub Pages frontend and:
     1. Updates plugins.json in the GitHub repository
     2. Immediately writes parse-status.json to "running" so the
        frontend sees the state change without waiting for the
        GitHub Action to spin up (which takes 30-60 seconds)

   Required Vercel environment variables:
     GITHUB_TOKEN   → Personal access token with repo write scope
     GITHUB_OWNER   → e.g. "givemefood5"
     GITHUB_REPO    → e.g. "endless-sky-ship-builder"
     GITHUB_PATH    → e.g. "plugins.json"
     GITHUB_BRANCH  → e.g. "main" (defaults to "main")
     ALLOWED_ORIGINS → comma-separated list of allowed origins
     SECRET_KEY     → optional shared secret for access control
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_PATH   = process.env.GITHUB_PATH   || 'plugins.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SECRET_KEY    = process.env.SECRET_KEY;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

/* ── Pre-built constants (built once at module load) ─────────── */
const FILE_URL   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
const STATUS_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/parse-status.json`;

const GH_HEADERS = {
    Accept:                 'application/vnd.github+json',
    Authorization:          `Bearer ${GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
};

/* ── SHA cache — Vercel keeps function instances warm ────────── */
let _cachedPluginsSha = null;
let _cachedStatusSha  = null;

/* ═══════════════════════════════════════════════════════════════
   Helper: build CORS headers for a given request origin
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   Helper: fetch current SHA for a file (uses cache if available)
   ═══════════════════════════════════════════════════════════════ */
async function fetchSha(url, cachedSha) {
    if (cachedSha) return { sha: cachedSha, fromCache: true };

    const res = await fetch(url, { headers: GH_HEADERS });
    if (!res.ok) {
        // 404 means the file doesn't exist yet — that's fine, sha = null
        if (res.status === 404) return { sha: null, fromCache: false };
        const body = await res.json().catch(() => ({}));
        throw new Error(`GitHub GET failed (${res.status}): ${body?.message || res.statusText}`);
    }

    const body = await res.json().catch(() => ({}));
    return { sha: body?.sha ?? null, fromCache: false };
}

/* ═══════════════════════════════════════════════════════════════
   Helper: commit a file to GitHub
   ═══════════════════════════════════════════════════════════════ */
async function commitFile(url, content, sha, message) {
    const base64Content = Buffer.from(content, 'utf8').toString('base64');

    const body = {
        message,
        content: base64Content,
        branch:  GITHUB_BRANCH,
    };

    // sha is required when updating an existing file;
    // omit it entirely when creating a new file
    if (sha) body.sha = sha;

    const res = await fetch(url, {
        method:  'PUT',
        headers: GH_HEADERS,
        body:    JSON.stringify(body),
    });

    const resBody = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: resBody };
}

/* ═══════════════════════════════════════════════════════════════
   Main handler — exported as default for Vercel
   ═══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    const cors   = corsHeaders(origin);

    /* ── Reject disallowed origins ───────────────────────────── */
    if (origin && Object.keys(cors).length === 0)
        return res.status(403).json({ error: 'Origin not allowed.' });

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    /* ── Handle CORS pre-flight ──────────────────────────────── */
    if (req.method === 'OPTIONS') return res.status(204).end();

    /* ── Only POST is accepted ───────────────────────────────── */
    if (req.method !== 'POST')
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });

    /* ── Verify shared secret (optional) ─────────────────────── */
    if (SECRET_KEY) {
        const provided = req.headers['x-update-secret'] || '';
        if (provided !== SECRET_KEY)
            return res.status(401).json({ error: 'Unauthorised: invalid or missing secret.' });
    }

    /* ── Validate environment variables ──────────────────────── */
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        console.error('[update-json] Missing required environment variables.');
        return res.status(500).json({ error: 'Server misconfiguration: missing env vars.' });
    }

    /* ── Parse and validate the request body ─────────────────── */
    let payload;
    try {
        payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Invalid JSON body.' });
    }

    if (!payload || !Array.isArray(payload.plugins))
        return res.status(400).json({ error: 'Body must be { plugins: [...] }.' });

    /* ── Step 1: Get current SHA for plugins.json ────────────── */
    let pluginsSha;
    try {
        const result  = await fetchSha(FILE_URL, _cachedPluginsSha);
        pluginsSha    = result.sha;
    } catch (err) {
        console.error('[update-json] Failed to fetch plugins.json SHA:', err.message);
        return res.status(502).json({ error: `Could not reach GitHub API: ${err.message}` });
    }

    if (!pluginsSha) {
        _cachedPluginsSha = null;
        return res.status(502).json({ error: 'Could not retrieve plugins.json SHA from GitHub.' });
    }

    /* ── Step 2: Commit updated plugins.json ─────────────────── */
    const newPluginsContent = JSON.stringify({ plugins: payload.plugins }, null, 2);
    let pluginsPutResult;

    try {
        pluginsPutResult = await commitFile(
            FILE_URL,
            newPluginsContent,
            pluginsSha,
            'chore: update plugins.json via plugin manager'
        );
    } catch (err) {
        _cachedPluginsSha = null;
        console.error('[update-json] Network error writing plugins.json:', err.message);
        return res.status(502).json({ error: `Network error writing file: ${err.message}` });
    }

    /* ── Handle SHA conflict (two people saving simultaneously) ─ */
    if (pluginsPutResult.status === 409) {
        _cachedPluginsSha = null;
        return res.status(409).json({
            error: 'Conflict: plugins.json was updated by someone else. Please refresh and try again.'
        });
    }

    if (!pluginsPutResult.ok) {
        _cachedPluginsSha = null;
        const msg = pluginsPutResult.body?.message || `HTTP ${pluginsPutResult.status}`;
        console.error('[update-json] GitHub PUT failed for plugins.json:', msg);
        return res.status(502).json({ error: `GitHub commit failed: ${msg}` });
    }

    // Cache the new SHA returned by GitHub so the next save skips the GET
    _cachedPluginsSha = pluginsPutResult.body?.content?.sha ?? null;
    const commitSha   = pluginsPutResult.body?.commit?.sha  ?? null;

    /* ── Step 3: Immediately write parse-status.json = running ──
       This means the frontend sees "running" within seconds of the
       save completing, rather than waiting 30-60s for GitHub Actions
       to spin up and write it themselves.
       Non-fatal: if this fails the Action will still set it eventually. */
    try {
        // Get current SHA of parse-status.json (needed to update it)
        const statusShaResult = await fetchSha(STATUS_URL, _cachedStatusSha);
        const statusSha       = statusShaResult.sha; // null = file doesn't exist yet

        const statusContent = JSON.stringify({
            status:    'running',
            startedAt: new Date().toISOString(),
        }, null, 2);

        const statusPutResult = await commitFile(
            STATUS_URL,
            statusContent,
            statusSha,
            'chore: mark parse as running'
        );

        if (statusPutResult.ok) {
            // Cache the new status SHA
            _cachedStatusSha = statusPutResult.body?.content?.sha ?? null;
            console.log('[update-json] parse-status.json set to running');
        } else {
            // Non-fatal — log and continue
            _cachedStatusSha = null;
            console.warn(
                '[update-json] Could not write parse-status.json:',
                statusPutResult.body?.message || statusPutResult.status
            );
        }
    } catch (err) {
        // Non-fatal — the Action will still set it, just with the usual delay
        _cachedStatusSha = null;
        console.warn('[update-json] Could not pre-set parse-status.json:', err.message);
    }

    /* ── All done ────────────────────────────────────────────── */
    return res.status(200).json({
        ok:     true,
        commit: commitSha,
    });
}
