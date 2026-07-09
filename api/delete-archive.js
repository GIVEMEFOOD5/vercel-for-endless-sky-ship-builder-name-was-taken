/* ═══════════════════════════════════════════════════════════════
   /api/delete-archive.js  —  Vercel Serverless Function
   Deletes an archive file from rawData/ in the GitHub repo, given
   its raw.githubusercontent.com URL. Used when the user removes an
   "archive"-type plugin entry from the Plugin Manager — otherwise
   the uploaded file would sit in rawData/ forever, unreferenced.

   Uses the (simpler, sufficient for a single-file delete) GitHub
   Contents API rather than the Git Data API used for the original
   upload — deletes don't have the same size ceiling problems writes
   do, since no content is sent in the request body.

   Required Vercel environment variables (same as the other endpoints):
     GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
     ALLOWED_ORIGINS, SECRET_KEY (optional)
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SECRET_KEY    = process.env.SECRET_KEY;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

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

/**
 * Parse owner/repo/branch/path out of a raw.githubusercontent.com URL,
 * rather than trusting the currently-configured GITHUB_OWNER/REPO/BRANCH
 * env vars to still match what the file was originally uploaded under
 * (branch could have changed since upload, for instance).
 */
function parseRawUrl(rawUrl) {
    const m = String(rawUrl || '').match(
        /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
    );
    if (!m) return null;
    const [, owner, repo, branch, path] = m;
    return { owner, repo, branch, path };
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
        console.error('[delete-archive] Missing required environment variables.');
        return res.status(500).json({ error: 'Server misconfiguration: missing env vars.' });
    }

    let payload;
    try {
        payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Invalid JSON body.' });
    }

    const { rawUrl } = payload || {};
    if (!rawUrl) return res.status(400).json({ error: 'Body must include rawUrl.' });

    const parsed = parseRawUrl(rawUrl);
    if (!parsed) return res.status(400).json({ error: 'rawUrl is not a recognised raw.githubusercontent.com URL.' });

    // Safety check: only ever delete from the repo this backend is
    // actually configured for, even though we parse owner/repo/branch
    // from the URL for the API calls themselves.
    if (parsed.owner !== GITHUB_OWNER || parsed.repo !== GITHUB_REPO) {
        return res.status(400).json({
            error: `rawUrl points at ${parsed.owner}/${parsed.repo}, which doesn't match this server's configured repo.`
        });
    }

    const contentsUrl =
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${parsed.path}`;

    try {
        // Step 1: look up the file's current sha (required for delete).
        const getRes = await fetch(`${contentsUrl}?ref=${encodeURIComponent(parsed.branch)}`, {
            headers: GH_HEADERS,
        });

        if (getRes.status === 404) {
            // Already gone — treat as success, this is idempotent.
            return res.status(200).json({ ok: true, alreadyDeleted: true });
        }

        if (!getRes.ok) {
            const body = await getRes.json().catch(() => ({}));
            throw new Error(body?.message || `GitHub GET failed (${getRes.status})`);
        }

        const fileInfo = await getRes.json();

        // Step 2: delete it.
        const delRes = await fetch(contentsUrl, {
            method:  'DELETE',
            headers: GH_HEADERS,
            body: JSON.stringify({
                message: `chore: remove archive "${parsed.path}" via plugin manager`,
                sha:     fileInfo.sha,
                branch:  parsed.branch,
            }),
        });

        const delBody = await delRes.json().catch(() => ({}));

        if (!delRes.ok) {
            throw new Error(delBody?.message || `GitHub DELETE failed (${delRes.status})`);
        }

        return res.status(200).json({ ok: true, commit: delBody?.commit?.sha ?? null });

    } catch (err) {
        console.error('[delete-archive] Failed:', err.message);
        return res.status(502).json({ error: `Failed to delete archive: ${err.message}` });
    }
};
