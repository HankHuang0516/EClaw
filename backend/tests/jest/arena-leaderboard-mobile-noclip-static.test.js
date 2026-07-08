'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('Arena leaderboard entity avatars and card popup', () => {
    const arenaIndex = read('public/arena/index.html');
    const exam = read('public/arena/exam.html');
    const server = read('interview-arena.js');

    test('GET /api/arena/leaderboard exposes entity metadata for card popups', () => {
        expect(server).toMatch(/AS entity_id/);
        expect(server).toMatch(/AS entity_name/);
        expect(server).toMatch(/AS petdx_avatar_url/);
        expect(server).toMatch(/AS public_code/);
        expect(server).toMatch(/AS agent_card/);
        expect(server).toContain('toLeaderboardApiRow');
    });

    test('leaderboard detail stores the bound public code when a submit has credentials', () => {
        expect(server).toContain('attachLinkedEntityToArenaDetail');
        expect(server).toContain('linkedPublicCode');
        expect(server).toContain('publicEntitySnapshot(entity, eId)');
        expect(server).toContain('owner_entity_id');
        expect(server).toContain('owner mismatch');
    });

    test.each([
        ['arena index', arenaIndex],
        ['arena exam', exam],
    ])('%s renders avatar column in a mobile-safe horizontal scroll wrapper', (_label, html) => {
        expect(html).toContain('lb-table-scroll');
        expect(html).toContain('lb-avatar-cell');
        expect(html).toContain('lbAvatarHtml');
        expect(html).toMatch(/@media \(max-width: 600px\)[\s\S]*\.lb-table \{ min-width: 560px; \}/);
    });

    test.each([
        ['arena index', arenaIndex],
        ['arena exam', exam],
    ])('%s opens the same card popup from avatar and name triggers', (_label, html) => {
        expect(html).toContain('showAgentCardFromEntry');
        expect(html).toContain('agentPopupAvatar');
        expect(html).toContain('agentPopupDescription');
        expect(html).toContain('agentPopupTags');
        expect(html).toContain('petdx_avatar_url');
        expect(html).toContain('agent_card');
        expect(html).toContain('public_code');
    });

    test('exam submit prefers the linked exam owner before active local entity', () => {
        expect(exam).toContain('linkedEntityId');
        expect(exam).toMatch(/Number\.isFinite\(linkedId\)[\s\S]*bound\.find\(e => lbEntryEntityId\(e\) === linkedId\)[\s\S]*Number\.isFinite\(activeId\)/);
    });
});
