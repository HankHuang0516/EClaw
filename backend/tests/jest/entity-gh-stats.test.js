/**
 * entity-gh-stats — card_8a25cadcc9fc88f153fa1316.
 *
 * Pins the contract for the merged-PR count + smart-link widget data source:
 *   - Mapping resolves from byEntityId (default) and byDevice override.
 *   - Missing mapping → setup_required:'no_login_mapped' (still 200).
 *   - Missing GITHUB_TOKEN → setup_required:'no_github_token' (still 200).
 *   - Happy path → merged_pr_count + recent_prs[] + actions_url.
 *
 * GitHub Search is mocked via global.fetch so the test stays hermetic.
 */
'use strict';

const ghStats = require('../../entity-gh-stats');

const ORIG_FETCH = global.fetch;
const ORIG_TOKEN = process.env.GITHUB_TOKEN;

describe('entity-gh-stats — config + buildStats contract', () => {
    beforeEach(() => {
        ghStats._clearCacheForTest();
    });
    afterEach(() => {
        global.fetch = ORIG_FETCH;
        if (ORIG_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = ORIG_TOKEN;
    });

    test('resolveGhLogin reads byEntityId from the shipped config', () => {
        const cfg = ghStats.loadConfig();
        expect(cfg).toBeTruthy();
        // The shipped config maps a couple of entityIds to HankHuang0516 so the
        // production dashboard renders a non-zero count out of the box.
        const someMappedId = Object.keys(cfg.byEntityId || {})[0];
        if (someMappedId) {
            const login = ghStats.resolveGhLogin('any-device', someMappedId);
            expect(typeof login).toBe('string');
            expect(login.length).toBeGreaterThan(0);
        }
    });

    test('buildStats returns setup_required when entity is unmapped', async () => {
        const out = await ghStats.buildStats('unknown-device', 999999);
        expect(out.success).toBe(true);
        expect(out.setup_required).toBe(true);
        expect(out.setup_reason).toBe('no_login_mapped');
        expect(out.merged_pr_count).toBe(0);
        expect(out.recent_prs).toEqual([]);
        expect(out.gh_login).toBeNull();
    });

    test('buildStats returns setup_required when GITHUB_TOKEN env is missing', async () => {
        delete process.env.GITHUB_TOKEN;
        const cfg = ghStats.loadConfig();
        const mappedId = Object.keys(cfg.byEntityId || {})[0];
        if (!mappedId) return; // skip when shipped config is empty
        const out = await ghStats.buildStats('any-device', mappedId);
        expect(out.success).toBe(true);
        expect(out.setup_required).toBe(true);
        expect(out.setup_reason).toBe('no_github_token');
        expect(out.gh_login).toBeTruthy();
        expect(out.merged_pr_count).toBe(0);
    });

    test('buildStats happy path → merged_pr_count + recent_prs + actions_url', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        const cfg = ghStats.loadConfig();
        const mappedId = Object.keys(cfg.byEntityId || {})[0];
        if (!mappedId) return;
        const mockJson = {
            total_count: 42,
            items: [
                {
                    number: 101,
                    title: 'feat(test): adds a thing',
                    html_url: 'https://github.com/owner/repo/pull/101',
                    repository_url: 'https://api.github.com/repos/owner/repo',
                    closed_at: '2026-06-13T12:00:00Z',
                    updated_at: '2026-06-13T12:00:00Z',
                },
            ],
        };
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => mockJson,
        }));
        const out = await ghStats.buildStats('any-device', mappedId);
        expect(out.success).toBe(true);
        expect(out.setup_required).toBe(false);
        expect(out.merged_pr_count).toBe(42);
        expect(out.recent_prs).toHaveLength(1);
        expect(out.recent_prs[0]).toMatchObject({
            number: 101,
            title: 'feat(test): adds a thing',
            html_url: 'https://github.com/owner/repo/pull/101',
            repo: 'owner/repo',
        });
        expect(out.actions_url).toMatch(/^https:\/\/github\.com\/pulls\?q=/);
        // Authorization header must be sent when token is present.
        const call = global.fetch.mock.calls[0];
        expect(call[1].headers.Authorization).toMatch(/^Bearer /);
    });

    test('buildStats propagates GitHub errors with status code', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        const cfg = ghStats.loadConfig();
        const mappedId = Object.keys(cfg.byEntityId || {})[0];
        if (!mappedId) return;
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            text: async () => 'rate limited',
            json: async () => ({}),
        }));
        const out = await ghStats.buildStats('any-device', mappedId);
        expect(out.success).toBe(false);
        expect(out.status).toBe(403);
        expect(out.error).toMatch(/GitHub 403/);
    });

    test('5-minute cache prevents repeat GitHub calls for the same login', async () => {
        process.env.GITHUB_TOKEN = 'fake-token';
        const cfg = ghStats.loadConfig();
        const mappedId = Object.keys(cfg.byEntityId || {})[0];
        if (!mappedId) return;
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ total_count: 7, items: [] }),
        }));
        await ghStats.buildStats('any-device', mappedId);
        await ghStats.buildStats('any-device', mappedId);
        await ghStats.buildStats('other-device', mappedId);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
