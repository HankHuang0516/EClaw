/**
 * Chat entity status badges — static analysis.
 *
 * Guards the Codex/channel observability badges on the chat target bar.
 */

const fs = require('fs');
const path = require('path');

const CHAT_HTML = path.resolve(__dirname, '../../public/portal/chat.html');

describe('chat entity status badges', () => {
    let html;

    beforeAll(() => {
        html = fs.readFileSync(CHAT_HTML, 'utf8');
    });

    test('tracks entity runtime status from socket updates', () => {
        expect(html).toContain('const entityRuntimeStatus = new Map()');
        expect(html).toContain('function recordEntityRuntimeStatus');
        expect(html).toContain('recordEntityRuntimeStatus({');
        expect(html).toContain('message: data.message ||');
        expect(html).toContain('lastUpdated: data.lastUpdated || data.updatedAt || Date.now()');
    });

    test('renders a status slot in every local entity target chip', () => {
        expect(html).toContain('label.dataset.entityId = e.entityId');
        expect(html).toContain('class="entity-status-slot"');
        expect(html).toContain('${renderEntityStatusBadge(e.entityId)}');
    });

    test('classifies the expected channel watchdog states', () => {
        expect(html).toContain("key: 'working'");
        expect(html).toContain("label: 'Working'");
        expect(html).toContain("key: 'waiting-approval'");
        expect(html).toContain("label: 'Waiting approval'");
        expect(html).toContain("key: 'no-progress'");
        expect(html).toContain("label: 'No progress 10m'");
        expect(html).toContain("key: 'self-check-failed'");
        expect(html).toContain("label: 'Self-check failed'");
    });

    test('uses the requested ten minute no-progress threshold', () => {
        expect(html).toMatch(/const ENTITY_NO_PROGRESS_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
        expect(html).toContain('now - status.updatedAt > ENTITY_NO_PROGRESS_MS');
        expect(html).toContain('setInterval(refreshEntityStatusBadges, 60 * 1000)');
    });

    test('ships CSS variants for all status badges', () => {
        for (const cssClass of [
            '.entity-status-badge.working',
            '.entity-status-badge.waiting-approval',
            '.entity-status-badge.no-progress',
            '.entity-status-badge.self-check-failed',
        ]) {
            expect(html).toContain(cssClass);
        }
    });
});
