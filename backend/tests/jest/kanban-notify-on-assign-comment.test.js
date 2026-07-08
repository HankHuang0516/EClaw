'use strict';

/**
 * card_cc20541e — Kanban notify on (re)assignment + @-mentioned comment,
 * with latest-comment enrichment.
 *
 * Root cause (verified by file:line on origin/main backend/kanban.js):
 *   - notifyEntities() was ONLY wired into create / move / reopen / cron-spawn.
 *   - PUT /card/:id changed assigned_bots WITHOUT notifying the new assignee.
 *   - POST /card/:id/comment inserted a留言 WITHOUT notifying anyone — so an
 *     @-mention in a comment never reached the mentioned agent.
 *
 * This suite drives the real router (supertest) over a mocked pg pool and a
 * captured pushToChannelCallback, asserting the three new behaviours plus the
 * anti-spam rules (no notify on unchanged assignment / plain comment / own @).
 *
 * Mock-ordering note: notifyEntities is fire-and-forget (NOT awaited inside the
 * handlers), so the HTTP response resolves before the push runs. Each test
 * awaits flushAsync() to let the microtask + I/O queue drain before asserting
 * on the push spy.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../safe-equal', () => (a, b) => a === b);

const express = require('express');
const request = require('supertest');

let app;
let pushSpy;

// Channel-bound entities so notifyEntities() takes the pushToChannelCallback
// path and parseMentions() can resolve @<publicCode> tokens.
const mockDevices = {
    'test-dev': {
        deviceSecret: 'test-secret',
        entities: {
            0: { isBound: true, bindingType: 'channel', channelAccountId: 'acct0', botSecret: 'sec0', publicCode: 'aaaaaa', name: 'Bot0', character: 'Bot0' },
            1: { isBound: true, bindingType: 'channel', channelAccountId: 'acct1', botSecret: 'sec1', publicCode: 'bbbbbb', name: 'Bot1', character: 'Bot1' },
            3: { isBound: true, bindingType: 'channel', channelAccountId: 'acct3', botSecret: 'sec3', publicCode: 'cccccc', name: 'Bot3', character: 'Bot3' },
        },
    },
};

beforeAll(() => {
    app = express();
    app.use(express.json());

    pushSpy = jest.fn().mockResolvedValue({ pushed: true });

    const kanbanModule = require('../../kanban')(mockDevices, {
        pushToChannelCallback: (...args) => pushSpy(...args),
    });
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    pushSpy.mockReset();
    pushSpy.mockResolvedValue({ pushed: true });
});

const put = (path) => request(app).put(path);
const post = (path) => request(app).post(path);
const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

// Let the fire-and-forget notifyEntities() chain settle before asserting.
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

// Pull the text of every captured channel push.
const pushedTexts = () => pushSpy.mock.calls.map((c) => c[2] && c[2].text);
// Which entityIds received a push (2nd positional arg of pushToChannelCallback).
const pushedEntityIds = () => pushSpy.mock.calls.map((c) => c[1]);

function updatedCardRow(overrides = {}) {
    return {
        id: 'card_x', device_id: 'test-dev', title: 'My task',
        description: 'do the thing', priority: 'P2', status: 'todo',
        assigned_bots: [0], created_by: 0,
        created_at: new Date(), updated_at: new Date(),
        status_changed_at: new Date(), archived: false,
        ...overrides,
    };
}

// ════════════════════════════════════════════════════════════════
// A. PUT /card/:id — notify newly-added assignees
// ════════════════════════════════════════════════════════════════
describe('A. PUT /card/:id assignment notify', () => {
    it('notifies ONLY the newly-added entity with the description', async () => {
        mockQuery
            // existing SELECT *  (was assigned to [0])
            .mockResolvedValueOnce({ rows: [updatedCardRow({ assigned_bots: [0] })] })
            // UPDATE RETURNING * (now assigned to [0, 3])
            .mockResolvedValueOnce({ rows: [updatedCardRow({ assigned_bots: [0, 3] })] })
            // bumpVersion
            .mockResolvedValueOnce({ rows: [] });
        // getDeviceLanguage user_accounts SELECT + latest-comment fetch fall
        // through to the default empty resolve.

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [0, 3] });
        expect(res.status).toBe(200);

        await flushAsync();

        // Only the new id (3) is pinged; the unchanged assignee (0) is not.
        expect(pushedEntityIds()).toEqual([3]);
        const texts = pushedTexts();
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatch(/Assigned to you|指派給你/);
        expect(texts[0]).toMatch(/\[TASK DESCRIPTION\]\ndo the thing/);
    });

    it('does NOT notify when assigned_bots is unchanged', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [updatedCardRow({ assigned_bots: [0] })] })
            .mockResolvedValueOnce({ rows: [updatedCardRow({ assigned_bots: [0] })] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [0] });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it('does NOT notify when the PUT does not touch assigned_bots at all', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [updatedCardRow({ assigned_bots: [0] })] })
            .mockResolvedValueOnce({ rows: [updatedCardRow({ assigned_bots: [0], title: 'Renamed' })] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, title: 'Renamed' });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushSpy).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════
// B. POST /card/:id/comment — notify @-mentioned entities
// ════════════════════════════════════════════════════════════════
describe('B. POST /card/:id/comment mention notify', () => {
    function commentRow(text, fromEntityId = 0) {
        return {
            id: 'cmt1', card_id: 'card_x', device_id: 'test-dev',
            from_entity_id: fromEntityId, text, is_system: false,
            created_at: new Date(),
        };
    }

    // cardCheck SELECT → INSERT comment RETURNING → UPDATE updated_at → bumpVersion
    function primeCommentMocks(text, fromEntityId = 0) {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'card_x', title: 'My task', assigned_bots: [0] }] })
            .mockResolvedValueOnce({ rows: [commentRow(text, fromEntityId)] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
    }

    it('@#3 in a comment → pushes to entity 3 with the comment text as the brief', async () => {
        primeCommentMocks('hey @#3 please look at this', 0);

        const res = await post('/api/mission/card/card_x/comment')
            .send({ ...AUTH, entityId: 0, text: 'hey @#3 please look at this' });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushedEntityIds()).toEqual([3]);
        const texts = pushedTexts();
        expect(texts[0]).toMatch(/@-mentioned|@ 你/);
        expect(texts[0]).toMatch(/\[LATEST COMMENT\]\nhey @#3 please look at this/);
    });

    it('@<publicCode> resolves to the bound entity', async () => {
        primeCommentMocks('ping @cccccc take over', 0);

        const res = await post('/api/mission/card/card_x/comment')
            .send({ ...AUTH, entityId: 0, text: 'ping @cccccc take over' });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushedEntityIds()).toEqual([3]);
    });

    it('plain comment with NO @-mention notifies nobody (anti-spam)', async () => {
        primeCommentMocks('just a status note, no mention', 0);

        const res = await post('/api/mission/card/card_x/comment')
            .send({ ...AUTH, entityId: 0, text: 'just a status note, no mention' });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it('does NOT notify a commenter who @-mentions themselves', async () => {
        // Entity 3 comments and @-mentions @#3 (itself) → no self-ping.
        primeCommentMocks('noting @#3 for myself', 3);

        const res = await post('/api/mission/card/card_x/comment')
            .send({ ...AUTH, entityId: 3, text: 'noting @#3 for myself' });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it('mentioning multiple entities pings each one (but not the commenter)', async () => {
        // Commenter is entity 0, mentions @#1 and @#3 and @#0 (self) → only 1 & 3.
        primeCommentMocks('@#1 @#3 and me @#0 sync up', 0);

        const res = await post('/api/mission/card/card_x/comment')
            .send({ ...AUTH, entityId: 0, text: '@#1 @#3 and me @#0 sync up' });
        expect(res.status).toBe(200);

        await flushAsync();
        expect(pushedEntityIds().sort()).toEqual([1, 3]);
    });
});

// ════════════════════════════════════════════════════════════════
// C. notifyEntities — latest-comment block enrichment
// ════════════════════════════════════════════════════════════════
describe('C. latest-comment enrichment', () => {
    // The comment-mention path passes latestComment explicitly (covered in B).
    // Here we assert the OTHER half: when only cardId is given (assignment
    // path), notifyEntities fetches the newest non-system comment and appends
    // the [LATEST COMMENT] block.
    // getDeviceLanguage() caches per-device, and notifyEntities issues its
    // latest-comment SELECT out of band, so positional mockResolvedValueOnce
    // ordering is brittle here. Drive the mock by SQL shape instead: the
    // newest-comment lookup is the only query that hits kanban_comments with
    // `is_system = false ... ORDER BY created_at DESC`.
    function sqlAwareMock(latestText) {
        mockQuery.mockImplementation((sql) => {
            if (/FROM kanban_comments[\s\S]*ORDER BY created_at DESC/.test(sql)) {
                return Promise.resolve({ rows: [{ text: latestText }] });
            }
            if (/UPDATE kanban_cards SET[\s\S]*RETURNING/.test(sql)) {
                return Promise.resolve({ rows: [updatedCardRow({ assigned_bots: [0, 3] })] });
            }
            if (/^\s*SELECT \* FROM kanban_cards/.test(sql)) {
                return Promise.resolve({ rows: [updatedCardRow({ assigned_bots: [0] })] });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
    }

    it('PUT assignment notify appends the latest留言 fetched by cardId', async () => {
        sqlAwareMock('latest discussion line');

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [0, 3] });
        expect(res.status).toBe(200);

        await flushAsync();
        const texts = pushedTexts();
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatch(/\[LATEST COMMENT\]\nlatest discussion line\n\[\/LATEST COMMENT\]/);
    });

    it('caps an over-long latest comment to ~1500 chars', async () => {
        sqlAwareMock('x'.repeat(5000));

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [0, 3] });
        expect(res.status).toBe(200);

        await flushAsync();
        const text = pushedTexts()[0];
        const m = text.match(/\[LATEST COMMENT\]\n([\s\S]*?)\n\[\/LATEST COMMENT\]/);
        expect(m).toBeTruthy();
        // 1500 sliced chars + the truncation ellipsis.
        expect(m[1].length).toBeLessThanOrEqual(1501);
        expect(m[1].endsWith('…')).toBe(true);
    });
});
