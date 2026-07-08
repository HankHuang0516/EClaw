'use strict';

/**
 * card_c0819f4e — Kanban notifications must carry an explicit task-lifecycle
 * directive, not just a passive API tool-list.
 *
 * Root cause (Hank-direct): getMissionApiHints lists the "Move card" curl but
 * never tells the assigned agent it is OBLIGATED to advance the card's status
 * on start/completion. A stateless agent (e.g. Hermes/#5) does the work,
 * reports in chat, and never moves the card → it sits in todo/in_progress and
 * re-nudges + auto-escalates forever. The fix injects a directive that names
 * the SPECIFIC card id and states the obligation, shipped in every push path.
 *
 * Style: static source-grep, matching kanban-done-device-push-wiring.test.js
 * (the kanban module requires a live pg pool, so behavioral mocking is not the
 * convention for this module). These pin the structural invariants so the
 * directive cannot silently rot or get dropped from a push path.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

describe('kanban notify → task-lifecycle directive (card_c0819f4e)', () => {
    test('builds a lifecycleDirective gated on cardId', () => {
        expect(kanbanSrc).toMatch(/const lifecycleDirective = cardId\s*\?/);
    });

    test('directive names the SPECIFIC card id (not just the CARD_ID placeholder)', () => {
        const block = kanbanSrc.slice(kanbanSrc.indexOf('const lifecycleDirective = cardId'));
        // The actual card id must be interpolated so even a stateless agent
        // knows which card to move (the whole point of the fix).
        expect(block).toMatch(/concerns card \$\{cardId\}/);
        expect(block).toMatch(/CARD_ID=\$\{cardId\}/);
    });

    test('directive states the move-on-start / move-on-complete obligation', () => {
        const block = kanbanSrc.slice(kanbanSrc.indexOf('const lifecycleDirective = cardId')).slice(0, 1200);
        expect(block).toMatch(/in_progress/);
        expect(block).toMatch(/done \(or review/);
        // Replying in chat must be explicitly called out as NOT closing the card.
        expect(block).toMatch(/Replying in chat does NOT change the card's status/);
        expect(block).toMatch(/Move card/);
    });

    test('hints + directive are combined into one missionBlock', () => {
        // card_e9379868 appended the dispatcher routingDirective to the same block
        // so the reply-routing target ships alongside the lifecycle obligation.
        expect(kanbanSrc).toMatch(/const missionBlock = kanbanHints \+ lifecycleDirective \+ routingDirective;/);
    });

    test('ALL three push paths ship missionBlock (channel / webhook / legacy), not bare kanbanHints', () => {
        // channel path
        expect(kanbanSrc).toMatch(/missionHints: missionBlock,/);
        // webhook path: missionBlock is an element of the pushMsg array
        const webhookBlock = kanbanSrc.slice(kanbanSrc.indexOf('Non-channel: build full push message')).slice(0, 600);
        expect(webhookBlock).toMatch(/missionBlock,/);
        // legacy path (card_cc20541e inserts ${commentBlock} between descBlock and missionBlock)
        expect(kanbanSrc).toMatch(/\$\{descBlock\}\$\{commentBlock\}\$\{missionBlock\}/);

        // Guard: no push path may still emit the bare kanbanHints variable —
        // every consumer must go through missionBlock so the directive travels.
        expect(kanbanSrc).not.toMatch(/missionHints: kanbanHints,/);
        expect(kanbanSrc).not.toMatch(/\$\{descBlock\}\$\{kanbanHints\}/);
    });
});
