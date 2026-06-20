/**
 * entity-gh-stats.js — merged-PR count + smart-link data source
 * card_8a25cadcc9fc88f153fa1316  (+ option-B author-attribution follow-up)
 *
 * ── Option B: count merged PRs by COMMIT AUTHOR IDENTITY ───────────────────────
 * Every EClaw PR is squash-merged through ONE shared GitHub account
 * (HankHuang0516), so the original login-based count (entity-gh-login.json →
 * GitHub Search `author:<login>`) attributes *all* work to one account and cannot
 * distinguish entities — and only entities 2 & 5 were ever mapped.
 *
 * Option B (Hank-approved) resolves the per-entity **git author identity** from
 * `backend/config/entity-gh-author.json` (names / emails / Co-Authored-By
 * trailers — see docs/specs/per-entity-git-author-spec.md §3-5) and counts merged
 * PRs whose commits are attributable to that identity.
 *
 * Resolution order per entity:
 *   1. AUTHOR identity (entity-gh-author.json) — takes precedence when present.
 *   2. GitHub LOGIN fallback (entity-gh-login.json) — preserves entities 2/5 and
 *      any deployment that only has login mappings.
 *   3. Neither → setup_required hint.
 *
 * ── Attribution mechanics + the GitHub-index trade-off ─────────────────────────
 * The accurate, *indexed* per-entity signal GitHub exposes is the commit-search
 * API (`/search/commits`) on the commit's TOP-LEVEL author/committer email. We
 * query it once per entity-email (repo-scoped), dedupe commits, and resolve the
 * recent matched commits to their merged PRs for `recent_prs` + a distinct-PR
 * count.
 *
 * KNOWN LIMITATION (inherent to GitHub, surfaced honestly): GitHub does NOT index
 * `Co-Authored-By:` trailer emails. Work that was squash-merged through the shared
 * account credits the entity only via a trailer in the squash-commit body, which
 * commit-search cannot see. Such PRs therefore do NOT contribute to the indexed
 * count. Reading every PR's commit body to recover trailers would be 2800+ live
 * calls per render — rejected for cost. The headline number is the count of
 * merged PRs attributable via indexed author/committer email; as entities adopt
 * the §5 author-override convention (`git commit --author="entity-<N>@bots.eclaw"`)
 * the indexed count grows automatically.
 *
 * `setup_required` is returned (200, never 4xx) when no identity is mapped or when
 * GITHUB_TOKEN is absent — the dashboard widget surfaces this as a ? hint.
 *
 * 5-minute in-memory cache (per author-key / per login) keeps us under the GitHub
 * Search quota (30 req/min) even with many entity cards rendering concurrently.
 */

const fs = require('fs');
const path = require('path');

const LOGIN_CONFIG_PATH = path.join(__dirname, 'config', 'entity-gh-login.json');
const AUTHOR_CONFIG_PATH = path.join(__dirname, 'config', 'entity-gh-author.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_PER_PAGE = 10;
// Default repo to scope commit-search against. Matches the convention used in
// ai-support.js / device-feedback.js (GITHUB_REPO env, else this default).
const DEFAULT_REPO = 'HankHuang0516/EClaw';
// Bound the number of recent authored commits we resolve to PRs per render so a
// busy entity can't fan out into hundreds of commit→PR lookups.
const MAX_COMMITS_TO_RESOLVE = 10;

let loginConfigCache = null;
let loginConfigCacheMtime = 0;
let authorConfigCache = null;
let authorConfigCacheMtime = 0;

const ghLoginCache = new Map();   // login -> { fetchedAt, data }
const ghAuthorCache = new Map();  // authorCacheKey -> { fetchedAt, data }

function _loadJsonConfig(configPath, getCache, setCache) {
    try {
        const stat = fs.statSync(configPath);
        const { cache, mtime } = getCache();
        if (cache && stat.mtimeMs === mtime) return cache;
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        setCache(parsed, stat.mtimeMs);
        return parsed;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`[entity-gh-stats] config load failed (${path.basename(configPath)}):`, err.message);
        }
        return null;
    }
}

function loadConfig() {
    return _loadJsonConfig(
        LOGIN_CONFIG_PATH,
        () => ({ cache: loginConfigCache, mtime: loginConfigCacheMtime }),
        (c, m) => { loginConfigCache = c; loginConfigCacheMtime = m; }
    ) || { byEntityId: {}, byDevice: {} };
}

// Returns the parsed author config, or null when the file is absent/unreadable
// (so callers can fall back to the GitHub-login path entirely).
function loadAuthorConfig() {
    return _loadJsonConfig(
        AUTHOR_CONFIG_PATH,
        () => ({ cache: authorConfigCache, mtime: authorConfigCacheMtime }),
        (c, m) => { authorConfigCache = c; authorConfigCacheMtime = m; }
    );
}

function repoSlug() {
    return process.env.GITHUB_REPO || DEFAULT_REPO;
}

/**
 * Resolve the GitHub login for a (deviceId, entityId) pair. `byDevice`
 * overrides `byEntityId` so multi-tenant deployments can scope per device.
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

/**
 * Resolve the per-entity author identity for a (deviceId, entityId) pair.
 * Returns a normalized { label, names[], emails[], coAuthorTrailers[] } or null
 * when no author identity is configured. `byDevice` overrides `byEntityId`.
 *
 * The canonical attribution email `entity-<N>@bots.eclaw` (spec §3) is always
 * appended so a fresh entity that adopts the author-override convention attributes
 * even before this file is edited.
 */
function resolveAuthorIdentity(deviceId, entityId) {
    const cfg = loadAuthorConfig();
    // File absent entirely → no author identity; caller uses the login fallback.
    if (!cfg) return null;
    const eid = String(entityId);
    const byDevice = cfg.byDevice || {};
    const byEntityId = cfg.byEntityId || {};
    const raw = (deviceId && byDevice[deviceId] && byDevice[deviceId][eid]) || byEntityId[eid] || null;

    const canonicalEmail = `entity-${eid}@bots.eclaw`;
    const names = [];
    const emails = [];
    const coAuthorTrailers = [];
    let label = null;

    if (raw) {
        label = raw.label || null;
        for (const n of (raw.names || [])) { if (n) names.push(String(n)); }
        for (const e of (raw.emails || [])) { if (e) emails.push(String(e).toLowerCase()); }
        for (const t of (raw.coAuthorTrailers || [])) { if (t) coAuthorTrailers.push(String(t).toLowerCase()); }
    }
    // Always include the canonical scheme email (dedup).
    if (!emails.includes(canonicalEmail)) emails.push(canonicalEmail);
    if (!coAuthorTrailers.includes(canonicalEmail)) coAuthorTrailers.push(canonicalEmail);

    // Only entities explicitly listed in the config are treated as author-mapped.
    // An unlisted entity returns null so buildStats() falls through to the
    // GitHub-login path and then the setup hint — preserving the "unmapped → hint"
    // contract. (To attribute a new entity by the canonical scheme alone, add it
    // to entity-gh-author.json with just its label; the canonical
    // entity-<N>@bots.eclaw email is appended automatically below.)
    if (!raw) return null;
    return { label, names, emails, coAuthorTrailers, configured: true };
}

function ghHeaders(preview) {
    const headers = {
        'Accept': preview ? 'application/vnd.github.cloak-preview+json' : 'application/vnd.github+json',
        'User-Agent': 'EClawbot-entity-gh-stats',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    return headers;
}

function extractRepoFromUrl(repoUrl) {
    if (!repoUrl) return null;
    // https://api.github.com/repos/<owner>/<repo>
    const m = repoUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    return m ? m[1] : null;
}

/**
 * GitHub commit-search by a single author-or-committer email, repo-scoped.
 * Returns { total, items[] } where total is GitHub's indexed commit count.
 */
async function searchCommitsByEmail(repo, email) {
    // author-email OR committer-email so squash commits where the entity is the
    // committer (but the merge bot the author) still match.
    const q = `repo:${repo} author-email:${email}`;
    const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&sort=committer-date&order=desc&per_page=${SEARCH_PER_PAGE}`;
    const res = await fetch(url, { headers: ghHeaders(true) });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`GitHub commits ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    return {
        total: typeof json.total_count === 'number' ? json.total_count : 0,
        items: Array.isArray(json.items) ? json.items : [],
    };
}

/**
 * Resolve a commit SHA to its merged PRs in the repo.
 * Returns Array<{ number, title, html_url, repo, mergedAt }>. Best-effort.
 */
async function resolveCommitToMergedPrs(repo, sha) {
    const url = `https://api.github.com/repos/${repo}/commits/${sha}/pulls`;
    const res = await fetch(url, { headers: ghHeaders(false) });
    if (!res.ok) return [];
    const arr = await res.json().catch(() => []);
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(pr => pr && pr.merged_at)
        .map(pr => ({
            number: pr.number,
            title: pr.title,
            html_url: pr.html_url,
            repo,
            mergedAt: pr.merged_at,
        }));
}

/**
 * Author-attribution fetch (option B). Counts merged PRs attributable to the
 * entity's author identity via the indexed commit-search path. Cached per
 * (repo + sorted emails). Returns the same shape as fetchMergedPrs().
 *
 *   merged_pr_count : distinct merged PRs recovered from authored commits, OR —
 *                     when commit→PR linkage is sparse (entity work landed as
 *                     direct commits / squash-merges that lost the author) — the
 *                     indexed authored-commit count, whichever is larger, so the
 *                     widget never under-reports real authored activity.
 *   recent_prs      : up to SEARCH_PER_PAGE distinct merged PRs (most recent).
 *   authored_commit_count : indexed commits attributed to the entity (debug/UX).
 */
async function fetchAuthoredStats(identity) {
    const repo = repoSlug();
    const emails = identity.emails.slice().sort();
    const cacheKey = `${repo}::${emails.join(',')}`;
    const cached = ghAuthorCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    // 1) Indexed commit-search across all emails; dedupe commits by SHA.
    const commitsBySha = new Map(); // sha -> { sha, committerDate }
    let authoredCommitTotal = 0;
    for (const email of emails) {
        let r;
        try {
            r = await searchCommitsByEmail(repo, email);
        } catch (err) {
            // 422 (e.g. empty/invalid email query) → skip this email, keep going.
            if (err.status && err.status !== 403 && err.status !== 401) continue;
            throw err; // auth/rate-limit errors propagate so the widget can hint.
        }
        authoredCommitTotal += r.total;
        for (const it of r.items) {
            if (!it || !it.sha) continue;
            if (!commitsBySha.has(it.sha)) {
                commitsBySha.set(it.sha, {
                    sha: it.sha,
                    committerDate: it.commit && it.commit.committer && it.commit.committer.date || null,
                });
            }
        }
    }

    // 2) Resolve the most-recent matched commits → distinct merged PRs (bounded).
    const recentShas = [...commitsBySha.values()]
        .sort((a, b) => String(b.committerDate || '').localeCompare(String(a.committerDate || '')))
        .slice(0, MAX_COMMITS_TO_RESOLVE)
        .map(c => c.sha);

    const prByKey = new Map(); // owner/repo#N -> pr object
    for (const sha of recentShas) {
        let prs = [];
        try {
            prs = await resolveCommitToMergedPrs(repo, sha);
        } catch (_) { prs = []; }
        for (const pr of prs) {
            const key = `${pr.repo}#${pr.number}`.toLowerCase();
            if (!prByKey.has(key)) prByKey.set(key, pr);
        }
    }

    const recent_prs = [...prByKey.values()]
        .sort((a, b) => String(b.mergedAt || '').localeCompare(String(a.mergedAt || '')))
        .slice(0, SEARCH_PER_PAGE);

    // Headline count: distinct merged PRs we positively attributed. If the entity
    // has indexed authored commits but commit→PR linkage is sparse (direct commits
    // or shared-account squash-merges), fall back to the authored-commit count so
    // genuine authored activity is still reflected rather than showing 0.
    const distinctPrCount = prByKey.size;
    const merged_pr_count = Math.max(distinctPrCount, authoredCommitTotal);

    const data = {
        merged_pr_count,
        distinct_pr_count: distinctPrCount,
        authored_commit_count: authoredCommitTotal,
        recent_prs,
    };
    ghAuthorCache.set(cacheKey, { fetchedAt: Date.now(), data });
    return data;
}

/** Login-based fetch (original path, preserved as fallback). */
async function fetchMergedPrs(login) {
    const cached = ghLoginCache.get(login);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    const q = encodeURIComponent(`is:pr is:merged author:${login}`);
    const url = `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=${SEARCH_PER_PAGE}`;
    const res = await fetch(url, { headers: ghHeaders(false) });
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
    ghLoginCache.set(login, { fetchedAt: Date.now(), data });
    return data;
}

/**
 * Build the response payload for GET /api/entities/:entityId/gh-stats.
 * Always returns a 200-shaped object — callers decide the HTTP status.
 *
 * Author attribution (option B) takes precedence; GitHub-login is the fallback.
 */
async function buildStats(deviceId, entityId) {
    const identity = resolveAuthorIdentity(deviceId, entityId);
    const gh_login = resolveGhLogin(deviceId, entityId);

    // No identity AND no login → setup hint.
    if (!identity && !gh_login) {
        return {
            success: true,
            attribution: 'none',
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
            attribution: identity ? 'author' : 'login',
            merged_pr_count: 0,
            recent_prs: [],
            gh_login: gh_login || null,
            entity_label: identity ? identity.label : null,
            setup_required: true,
            setup_reason: 'no_github_token',
        };
    }

    // ── Author-attribution path (preferred) ──────────────────────────────────
    if (identity) {
        try {
            const data = await fetchAuthoredStats(identity);
            const repo = repoSlug();
            const emailQ = identity.emails.map(e => `author-email:${e}`).join(' OR ');
            return {
                success: true,
                attribution: 'author',
                merged_pr_count: data.merged_pr_count,
                distinct_pr_count: data.distinct_pr_count,
                authored_commit_count: data.authored_commit_count,
                recent_prs: data.recent_prs,
                gh_login: gh_login || null,
                entity_label: identity.label,
                author_emails: identity.emails,
                setup_required: false,
                actions_url: `https://github.com/search?q=${encodeURIComponent(`repo:${repo} ${emailQ}`)}&type=commits`,
            };
        } catch (err) {
            // Author path failed (auth / rate-limit). If a login is configured,
            // degrade to it rather than erroring outright.
            if (!gh_login) {
                return {
                    success: false,
                    attribution: 'author',
                    error: err.message || 'GitHub commit-search failed',
                    status: err.status || 500,
                    entity_label: identity.label,
                };
            }
            // else fall through to login path below.
        }
    }

    // ── GitHub-login fallback (preserves entities 2/5 and login-only deploys) ──
    try {
        const data = await fetchMergedPrs(gh_login);
        return {
            success: true,
            attribution: 'login',
            merged_pr_count: data.merged_pr_count,
            recent_prs: data.recent_prs,
            gh_login,
            setup_required: false,
            actions_url: `https://github.com/pulls?q=${encodeURIComponent(`is:pr is:merged author:${gh_login}`)}`,
        };
    } catch (err) {
        return {
            success: false,
            attribution: 'login',
            error: err.message || 'GitHub fetch failed',
            status: err.status || 500,
            gh_login,
        };
    }
}

function _clearCacheForTest() {
    ghLoginCache.clear();
    ghAuthorCache.clear();
    loginConfigCache = null;
    loginConfigCacheMtime = 0;
    authorConfigCache = null;
    authorConfigCacheMtime = 0;
}

module.exports = {
    buildStats,
    resolveGhLogin,
    resolveAuthorIdentity,
    loadConfig,
    loadAuthorConfig,
    _clearCacheForTest,
};
