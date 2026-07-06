/**
 * Regression guard for the mission.html note-page share link (card_091d24a5).
 *
 * BUG: copyNotePageLink() always built the /p/<code>/<noteId> URL from the
 * FIRST bound entity's public code (`boundEntities.find(e => e.publicCode)`
 * — /api/entities sorts entities ascending, so bound[0] is always the lowest
 * entityId, usually #1). On a multi-entity device the copied share link was
 * attributed to the wrong entity, regardless of which entity is active.
 *
 * FIX (same pattern as the exam.html fix, card_cea91e58): prefer the shared
 * active-entity localStorage key `eclaw_petdex_active_entity_id`; fall back to
 * the first bound entity with a public code only when the active id is unset,
 * no longer bound, or has no public code.
 *
 * This test extracts the REAL copyNotePageLink source from mission.html (like
 * mission-card-deeplink-noloop.test.js) and drives it against a stubbed
 * clipboard, so it fails on the old bound[0]-only binding and passes on the
 * active-entity binding.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MISSION_HTML = path.resolve(__dirname, '../../public/portal/mission.html');

// Extract the exact `function copyNotePageLink() { ... }` block from
// mission.html so the test exercises the shipped source, not a copy.
function extractCopyNotePageLinkSource() {
    const html = fs.readFileSync(MISSION_HTML, 'utf8');
    const start = html.indexOf('function copyNotePageLink() {');
    if (start === -1) throw new Error('mission.html: copyNotePageLink not found');
    // Close on the first 8-space-indented `}` (the declaration terminator —
    // every line inside the body is indented 12+ spaces).
    const end = html.indexOf('\n        }', start);
    if (end === -1) throw new Error('mission.html: copyNotePageLink terminator not found');
    return html.slice(start, end + '\n        }'.length);
}

// Instantiate the real function with its free identifiers shadowed by stubs.
function buildHarness({ activeEntityId, boundEntities }) {
    const writeText = jest.fn().mockResolvedValue(undefined);
    const showToast = jest.fn();
    const btn = { textContent: '', style: {} };
    const localStorage = {
        getItem: jest.fn((key) => (key === 'eclaw_petdex_active_entity_id' ? activeEntityId : null)),
    };
    const src = extractCopyNotePageLinkSource();
    const factory = new Function(
        'viewerNoteId', 'boundEntities', 'localStorage', 'navigator',
        'document', 'i18n', 'showToast', 'setTimeout',
        src + '\nreturn copyNotePageLink;'
    );
    const copyNotePageLink = factory(
        'note-42',
        boundEntities,
        localStorage,
        { clipboard: { writeText } },
        { getElementById: () => btn, createElement: () => { throw new Error('fallback path should not run'); }, body: {} },
        { t: () => '' },
        showToast,
        jest.fn() // shadow setTimeout so no timers leak past the test
    );
    return { copyNotePageLink, writeText, showToast };
}

const flush = () => new Promise((r) => setImmediate(r));

const TWO_ENTITIES = [
    { entityId: 1, publicCode: 'aaa111' },
    { entityId: 3, publicCode: 'ccc333' },
];

describe('mission.html copyNotePageLink binds the share link to the ACTIVE entity (card_091d24a5)', () => {
    test('FAIL-ON-OLD: active entity #3 gets #3\'s public code, not bound[0] (#1)', async () => {
        const { copyNotePageLink, writeText } = buildHarness({
            activeEntityId: '3',
            boundEntities: TWO_ENTITIES,
        });
        copyNotePageLink();
        await flush();
        expect(writeText).toHaveBeenCalledTimes(1);
        // Old code copied https://eclawbot.com/p/aaa111/note-42 here.
        expect(writeText).toHaveBeenCalledWith('https://eclawbot.com/p/ccc333/note-42');
    });

    test('falls back to the first bound entity with a code when the active key is unset', async () => {
        const { copyNotePageLink, writeText } = buildHarness({
            activeEntityId: null,
            boundEntities: TWO_ENTITIES,
        });
        copyNotePageLink();
        await flush();
        expect(writeText).toHaveBeenCalledWith('https://eclawbot.com/p/aaa111/note-42');
    });

    test('falls back to bound[0] when the active entity is no longer bound', async () => {
        const { copyNotePageLink, writeText } = buildHarness({
            activeEntityId: '9', // not in boundEntities
            boundEntities: TWO_ENTITIES,
        });
        copyNotePageLink();
        await flush();
        expect(writeText).toHaveBeenCalledWith('https://eclawbot.com/p/aaa111/note-42');
    });

    test('falls back past an active entity that has no public code', async () => {
        const { copyNotePageLink, writeText } = buildHarness({
            activeEntityId: '3',
            boundEntities: [
                { entityId: 1, publicCode: 'aaa111' },
                { entityId: 3, publicCode: null },
            ],
        });
        copyNotePageLink();
        await flush();
        expect(writeText).toHaveBeenCalledWith('https://eclawbot.com/p/aaa111/note-42');
    });

    test('shows the no-public-code toast when no bound entity has a code', async () => {
        const { copyNotePageLink, writeText, showToast } = buildHarness({
            activeEntityId: '3',
            boundEntities: [{ entityId: 3, publicCode: null }],
        });
        copyNotePageLink();
        await flush();
        expect(writeText).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('No public code available', 'error');
    });
});
