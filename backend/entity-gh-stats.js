/**
 * entity-gh-stats.js — merged-PR count + smart-link data source
 * card_8a25cadcc9fc88f153fa1316
 *
 * Resolves `entityId -> GitHub login` from `backend/config/entity-gh-login.json`
 * and queries the GitHub Search API for merged PRs authored by that login.
 *
 * `setup_required` is returned (200, never 4xx) when either the mapping is
 * empty for this entity or the GITHUB_TOKEN env var is absent — the dashboard
 * widget surfaces this as a ? icon with the exact remediation hint.
 *
 * 5-minute in-memory cache per gh_login keeps us comfortably under the 30 req/min
 * GitHub Search quota even with many entity cards rendering concurrently.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config', 'entity-gh-login.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_PER_PAGE = 10;

let configCache = null;
let configCacheMtime = 0;
const ghCache = new Map(); // login -> { fetchedAt, data }

function loadConfig() {
    try {
        const stat = fs.statSync(CONFIG_PATH);
        if (configCache && stat.mtimeMs === configCacheMtime) return configCache;
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        configCache = JSON.parse(raw);
        configCacheMtime = stat.mtimeMs;
        return configCache;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[entity-gh-stats] config load failed:', err.message);
        }
        return { byEntityId: {}, byDevice: {} };
    }
}

/**
 * Resolve the GitHub login for a (deviceId, entityId) pair. `byDevice`
 * overrides `byEntityId` so multi-tenant deployments can scope per device
 * without colliding on entity ids.
 */
function resolveGhLogin(deviceId, entityId) {
    const cfg = loadConfig();
    const eid = String(entityId);
    const byDevice = cfg.byDevice || {};
    if (deviceId && byDevice[deviceId] && byDevice[deviceId][eid]) {
        return String(byDevice[deviceId][eid]);
    }
    const byEntityId = cfg.byEntityId || {};
    if (byEntityId[eid]) return String(byEntityId[eid]);
    return null;
}

async function fetchMergedPrs(login) {
    const cached = ghCache.get(login);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    const q = encodeURIComponent(`is:pr is:merged author:${login}`);
    const url = `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=${SEARCH_PER_PAGE}`;
    const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'EClawbot-entity-gh-stats',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const data = {
        merged_pr_count: typeof json.total_count === 'number' ? json.total_count : 0,
        recent_prs: (json.items || []).slice(0, SEARCH_PER_PAGE).map(item => ({
            number: item.number,
            title: item.title,
            html_url: item.html_url,
            repo: extractRepoFromUrl(item.repository_url),
            mergedAt: item.closed_at || item.updated_at || null,
        })),
    };
    ghCache.set(login, { fetchedAt: Date.now(), data });
    return data;
}

function extractRepoFromUrl(repoUrl) {
    if (!repoUrl) return null;
    // https://api.github.com/repos/<owner>/<repo>
    const m = repoUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    return m ? m[1] : null;
}

/**
 * Build the response payload for GET /api/entities/:entityId/gh-stats.
 * Always returns a 200-shaped object — callers decide the HTTP status.
 */
async function buildStats(deviceId, entityId) {
    const gh_login = resolveGhLogin(deviceId, entityId);
    if (!gh_login) {
        return {
            success: true,
            merged_pr_count: 0,
            recent_prs: [],
            gh_login: null,
            setup_required: true,
            setup_reason: 'no_login_mapped',
        };
    }
    if (!process.env.GITHUB_TOKEN) {
        return {
            success: true,
            merged_pr_count: 0,
            recent_prs: [],
            gh_login,
            setup_required: true,
            setup_reason: 'no_github_token',
        };
    }
    try {
        const data = await fetchMergedPrs(gh_login);
        return {
            success: true,
            merged_pr_count: data.merged_pr_count,
            recent_prs: data.recent_prs,
            gh_login,
            setup_required: false,
            actions_url: `https://github.com/pulls?q=${encodeURIComponent(`is:pr is:merged author:${gh_login}`)}`,
        };
    } catch (err) {
        return {
            success: false,
            error: err.message || 'GitHub fetch failed',
            status: err.status || 500,
            gh_login,
        };
    }
}

function _clearCacheForTest() {
    ghCache.clear();
    configCache = null;
    configCacheMtime = 0;
}

module.exports = {
    buildStats,
    resolveGhLogin,
    loadConfig,
    _clearCacheForTest,
};
