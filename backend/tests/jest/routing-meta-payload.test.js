/**
 * Static invariant test for routing_meta message payload (routing-viz v1, Part A).
 * Card: card_b3724a801eb600036aab901c — chat page must prove org-hierarchy /
 * smart routing actually fired by carrying a per-message routing trace.
 *
 * #6 v1 spec point 3: routing_meta MUST be produced by the backend payload
 * (from/to/lv/mode/status); the frontend only renders it, never recomputes.
 *
 * jest.config.js uses testEnvironment:'node'. index.js is a multi-MB server we
 * cannot import standalone, so we lock the SOURCE surface (same pattern as
 * chat-quote-smart-receiver.test.js): the migration column, the saveChatMessage
 * persistence + Socket.IO emit, and the deliverToEntity trace construction.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const indexJs = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

describe('routing_meta — schema migration', () => {
    test('chat_messages gains a routing_meta JSONB column (follows card/attachments precedent)', () => {
        expect(indexJs).toMatch(/ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS routing_meta JSONB DEFAULT NULL/);
    });
});

describe('routing_meta — saveChatMessage persistence', () => {
    test('saveChatMessage accepts a trailing routingMeta param', () => {
        expect(indexJs).toMatch(/async function saveChatMessage\([^)]*viaChannel = null,\s*routingMeta = null\)/);
    });

    test('INSERT persists routing_meta as the 16th column/param', () => {
        // column list ends with via_channel, routing_meta
        expect(indexJs).toMatch(/is_from_bot, media_type, media_url, schedule_id, schedule_label, backup_url, mentions, card, attachments, via_channel, routing_meta\)/);
        // 16 positional placeholders
        expect(indexJs).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14, \$15, \$16\) RETURNING id/);
        // param is JSON-stringified like card/attachments
        expect(indexJs).toMatch(/routingMeta \? JSON\.stringify\(routingMeta\) : null/);
    });

    test('Socket.IO chat:message emit includes routing_meta', () => {
        expect(indexJs).toMatch(/routing_meta: routingMeta \|\| null/);
    });
});

describe('routing_meta — deliverToEntity trace construction', () => {
    // Extract the deliverToEntity routingMeta object literal and assert it carries
    // every field the #6 v1 spec requires, plus a resolved mode + status.
    const m = indexJs.match(/const routingMeta = \{[\s\S]*?status: 'sent'\s*\};/);
    test('routingMeta literal is present in deliverToEntity', () => {
        expect(m).not.toBeNull();
    });
    test('carries mode/from/to/lv/status per #6 v1 spec', () => {
        const body = m ? m[0] : '';
        expect(body).toMatch(/mode: isBroadcast \? 'broadcast' : \(isCrossDevice \? 'xdevice' : 'speakTo'\)/);
        expect(body).toMatch(/from_entity_id: fromId/);
        expect(body).toMatch(/from_name: entityName\(fromEntity, fromId\)/);
        expect(body).toMatch(/from_lv: entityLv\(fromEntity\)/);
        expect(body).toMatch(/to_entity_id: toId/);
        expect(body).toMatch(/to_name: entityName\(toEntity, toId\)/);
        expect(body).toMatch(/to_lv: entityLv\(toEntity\)/);
        expect(body).toMatch(/status: 'sent'/);
    });
    test('level helper clamps to a finite number (defaults LV1)', () => {
        expect(indexJs).toMatch(/const entityLv = \(e\) => \(e && Number\.isFinite\(Number\(e\.level\)\)\) \? Number\(e\.level\) : 1;/);
    });
    test('both real-delivery saveChatMessage calls forward routingMeta', () => {
        // the non-broadcast target save + the cross-device sender-copy save
        const calls = indexJs.match(/saveChatMessage\([^;]*viaChannel, routingMeta\)/g) || [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });
});
