/**
 * entity-gh-stats — card_8a25cadcc9fc88f153fa1316 (+ option-B author attribution).
 *
 * Pins the contract for the merged-PR count + smart-link widget data source:
 *   - AUTHOR attribution (entity-gh-author.json) takes precedence: count merged
 *     PRs whose commits are attributable to the entity's author identity
 *     (commit-search by author-email → resolve to merged PRs). Falls back to the
 *     indexed authored-commit count when commit→PR linkage is sparse.
 *   - GitHub LOGIN (entity-gh-login.json) is the fallback (preserves entities 2/5
 *     and login-only deployments) when no author identity is configured OR the
 *     author path fails.
 *   - Unmapped entity → setup_required:'no_login_mapped' (still 200).
 *   - Missing GITHUB_TOKEN → setup_required:'no_github_token' (still 200).
 *
 * GitHub is mocked via global.fetch so the test stays hermetic.
 */
'use strict';

const ghStats = require('../../entity-gh-stats');

const ORIG_FETCH = global.fetch;
const ORIG_TOKEN = process.env.GITHUB_TOKEN;
const ORIG_REPO = process.env.GITHUB_REPO;

// ── fetch router for the author path ──────────────────────────────────────────
// Routes /search/commits → commit hits, /commits/<sha>/pulls → merged PRs.
function authorFetchRouter({ commitsByEmail = {}, prsBySha = {} }) {
    return jest.fn(async (url) => {
        if (url.includes('/search/commits')) {
            // Pull author-email:<x> back out of the encoded query.
            const m = decodeURIComponent(url).match(/author-email:([^\s&]+)/);
            const email = m ? m[1] : '';
            const hit = commitsByEmail[email] || { total: 0, items: [] };
            return { ok: true, status: 200, json: async () => ({ total_count: hit.total, items: hit.items }) };
        }
        if (url.includes('/commits/') && url.endsWith('/pulls')) {
            const sm = url.match(/\/commits\/([^/]+)\/pulls/);
            const sha = sm ? sm[1] : '';
            return { ok: true, status: 200, json: async () => (prsBySha[sha] || []) };
        }
        // login path (search/issues) — default empty
        return { ok: true, status: 200, json: async () => ({ total_count: 0, items: [] }) };
    });
}

describe('entity-gh-stats — config + buildStats contract', () => {
    beforeEach(() => {
        ghStats._clearCacheForTest();
        process.env.GITHUB_REPO = 'HankHuang0516/EClaw';
    });
    afterEach(() => {
        global.fetch = ORIG_FETCH;
        if (ORIG_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = ORIG_TOKEN;
        if (ORIG_REPO === undefined) delete process.env.GITHUB_REPO;
        else process.env.GITHUB_REPO = ORIG_REPO;
    });

    // ── config resolvers ──────────────────────────────────────────────────────
    test('resolveGhLogin reads byEntityId from the shipped login config', () => {
        const cfg = ghStats.loadConfig();
        expect(cfg).toBeTruthy();
        const someMappedId = Object.keys(cfg.byEntityId || {})[0];
        if (someMappedId) {
            const login = ghStats.resolveGhLogin('any-device', someMappedId);
            expect(typeof login).toBe('string');
            expect(login.length).toBeGreaterThan(0);
        }
    });

    test('resolveAuthorIdentity returns identity for a mapped entity + appends canonical email', () => {
        const id = ghStats.resolveAuthorIdentity('any-device', 2);
        expect(id).toBeTruthy();
        expect(id.configured).toBe(true);
        // Canonical scheme email is always present.
        expect(id.emails).toContain('entity-2@bots.eclaw');
        // Historical identity derived from git history is present + lowercased.
        expect(id.emails).toContain('entity2@eclawbot.com');
        expect(id.coAuthorTrailers).toContain('entity-2@bots.eclaw');
    });

    test('resolveAuthorIdentity returns null for an unlisted entity (→ login/hint fallback)', () => {
        expect(ghStats.resolveAuthorIdentity('any-device', 999999)).toBeNull();
    });

    // ── setup hints ───────────────────────────────────────────────────────────
    test('buildStats returns setup_required when entity has neither author nor login', async () => {
        const out = await ghStats.buildStats('unknown-device', 999999);
        expect(out.success).toBe(true);
        expect(out.setup_required).toBe(true);
        expect(out.setup_reason).toBe('no_login_mapped');
        expect(out.merged_pr_count).toBe(0);
        expect(out.recent_prs).toEqual([]);
    });

    test('buildStats returns setup_required when GITHUB_TOKEN env is missing', async () => {
        delete process.env.GITHUB_TOKEN;
        const out = await ghStats.buildStats('any-device', 2); // entity 2 IS author-mapped
        expect(out.success).toBe(true);
        expect(out.setup_required).toBe(true);
        expect(out.setup_reason).toBe('no_github_token');
        expect(out.merged_pr_count).toBe(0);
    });

    // ── author attribution (option B) ─────────────────────────────────────────
    test('author path: counts DISTINCT merged PRs attributed via commit-author email', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        // Entity 2's emails include entity2@eclawbot.com — give it 2 commits that
        // each resolve to a merged PR (one shared PR → dedupe to 2 distinct PRs).
        global.fetch = authorFetchRouter({
            commitsByEmail: {
                'entity2@eclawbot.com': {
                    total: 3,
                    items: [
                        { sha: 'aaa', commit: { committer: { date: '2026-06-13T12:00:00Z' } } },
                        { sha: 'bbb', commit: { committer: { date: '2026-06-12T12:00:00Z' } } },
                    ],
                },
            },
            prsBySha: {
                aaa: [{ number: 101, title: 'feat: a', html_url: 'https://github.com/HankHuang0516/EClaw/pull/101', merged_at: '2026-06-13T12:00:00Z' }],
                // bbb maps to the SAME PR 101 (dedupe) + a second PR 102
                bbb: [
                    { number: 101, title: 'feat: a', html_url: 'https://github.com/HankHuang0516/EClaw/pull/101', merged_at: '2026-06-13T12:00:00Z' },
                    { number: 102, title: 'feat: b', html_url: 'https://github.com/HankHuang0516/EClaw/pull/102', merged_at: '2026-06-12T12:00:00Z' },
                ],
            },
        });
        const out = await ghStats.buildStats('any-device', 2);
        expect(out.success).toBe(true);
        expect(out.attribution).toBe('author');
        expect(out.setup_required).toBe(false);
        expect(out.distinct_pr_count).toBe(2); // 101 + 102 (101 deduped)
        expect(out.authored_commit_count).toBe(3);
        // count = max(distinct, authored) → 3 (sparse-linkage fallback)
        expect(out.merged_pr_count).toBe(3);
        expect(out.recent_prs.map(p => p.number).sort()).toEqual([101, 102]);
        expect(out.actions_url).toMatch(/type=commits/);
    });

    test('author path: distinct PR count wins when it exceeds authored-commit count', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        global.fetch = authorFetchRouter({
            commitsByEmail: {
                'entity2@eclawbot.com': { total: 1, items: [{ sha: 'sha1', commit: { committer: { date: '2026-06-13T12:00:00Z' } } }] },
            },
            prsBySha: {
                sha1: [
                    { number: 201, title: 'x', html_url: 'u201', merged_at: '2026-06-13T12:00:00Z' },
                    { number: 202, title: 'y', html_url: 'u202', merged_at: '2026-06-12T12:00:00Z' },
                ],
            },
        });
        const out = await ghStats.buildStats('any-device', 2);
        expect(out.distinct_pr_count).toBe(2);
        expect(out.authored_commit_count).toBe(1);
        expect(out.merged_pr_count).toBe(2); // max(2,1)
    });

    test('author path: entity with zero authored commits → count 0, not a hint', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        // Entity 4 (Eclaw_Office) has no historical identity → only canonical email,
        // which returns zero commits.
        global.fetch = authorFetchRouter({ commitsByEmail: {} });
        const out = await ghStats.buildStats('any-device', 4);
        expect(out.success).toBe(true);
        expect(out.attribution).toBe('author');
        expect(out.setup_required).toBe(false);
        expect(out.merged_pr_count).toBe(0);
        expect(out.recent_prs).toEqual([]);
    });

    test('author path: 422 on one email is skipped, others still counted', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        global.fetch = jest.fn(async (url) => {
            const dq = decodeURIComponent(url);
            if (url.includes('/search/commits')) {
                if (dq.includes('author-email:entity-2@bots.eclaw')) {
                    return { ok: false, status: 422, text: async () => 'bad query', json: async () => ({}) };
                }
                if (dq.includes('author-email:entity2@eclawbot.com')) {
                    return { ok: true, status: 200, json: async () => ({ total_count: 5, items: [] }) };
                }
                return { ok: true, status: 200, json: async () => ({ total_count: 0, items: [] }) };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const out = await ghStats.buildStats('any-device', 2);
        expect(out.success).toBe(true);
        expect(out.authored_commit_count).toBe(5);
        expect(out.merged_pr_count).toBe(5);
    });

    // ── login fallback ────────────────────────────────────────────────────────
    test('login fallback: author path 403 degrades to login count when login mapped', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        global.fetch = jest.fn(async (url) => {
            if (url.includes('/search/commits')) {
                return { ok: false, status: 403, text: async () => 'rate limited', json: async () => ({}) };
            }
            if (url.includes('/search/issues')) {
                return { ok: true, status: 200, json: async () => ({
                    total_count: 42,
                    items: [{ number: 9, title: 'login pr', html_url: 'https://github.com/o/r/pull/9', repository_url: 'https://api.github.com/repos/o/r', closed_at: '2026-06-01T00:00:00Z' }],
                }) };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        // Entity 2 has BOTH an author identity and a login mapping.
        const out = await ghStats.buildStats('any-device', 2);
        expect(out.success).toBe(true);
        expect(out.attribution).toBe('login');
        expect(out.merged_pr_count).toBe(42);
        expect(out.gh_login).toBe('HankHuang0516');
    });

    test('login fallback: author 403 with NO login → propagates error', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        // Entity 1 is author-mapped but has no login in entity-gh-login.json.
        expect(ghStats.resolveGhLogin('any-device', 1)).toBeNull();
        global.fetch = jest.fn(async (url) => {
            if (url.includes('/search/commits')) {
                return { ok: false, status: 403, text: async () => 'rate limited', json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const out = await ghStats.buildStats('any-device', 1);
        expect(out.success).toBe(false);
        expect(out.status).toBe(403);
        expect(out.error).toMatch(/GitHub commits 403/);
    });

    // ── caching ───────────────────────────────────────────────────────────────
    test('author results are cached per repo+emails (no repeat commit-search)', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        const fetchMock = authorFetchRouter({
            commitsByEmail: { 'entity2@eclawbot.com': { total: 7, items: [] } },
        });
        global.fetch = fetchMock;
        await ghStats.buildStats('any-device', 2);
        const firstCallCount = fetchMock.mock.calls.length;
        await ghStats.buildStats('any-device', 2);
        // Second build served entirely from cache → no new fetches.
        expect(fetchMock.mock.calls.length).toBe(firstCallCount);
    });
});
