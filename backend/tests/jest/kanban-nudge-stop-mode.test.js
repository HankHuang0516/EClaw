'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const kanbanSrc = fs.readFileSync(path.join(ROOT, 'kanban.js'), 'utf8');
const devicePrefsSrc = fs.readFileSync(path.join(ROOT, 'device-preferences.js'), 'utf8');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'settings.html'), 'utf8');
const socketSrc = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'socket.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

describe('kanban nudge stop-mode preferences', () => {
    test('device preferences expose stop-mode as a per-entity override key', () => {
        expect(devicePrefsSrc).toMatch(/kanban_nudge_stop_mode:\s*false/);
        expect(devicePrefsSrc).toMatch(/NUDGE_ENTITY_OVERRIDE_KEYS[\s\S]*'kanban_nudge_stop_mode'/);
    });

    test('stale-card processing skips stopped assignees before recipient selection', () => {
        const body = extractFunctionBody(
            kanbanSrc,
            'async function processDeviceStaleCards(deviceId, cards)'
        );

        expect(body).toMatch(/baseStopMode = basePrefs\.kanban_nudge_stop_mode === true/);
        expect(body).toMatch(/stopMode: merged\.kanban_nudge_stop_mode === true/);
        expect(body).toMatch(/statusEligible:\s*!baseStopMode && baseStatuses\.has\(card\.status\)/);
        expect(body).toMatch(/if \(ep\.stopMode\) continue/);
        expect(body).toMatch(/if \(recipientBots\.length === 0\)[\s\S]*statusEligible:\s*false/);
        expect(body).toMatch(/picked\.push\(\{ card, recipients: ce\.recipientBots \}\)/);
        expect(body).toMatch(/fireLevelOneNudge\(item\.card, item\.recipients\)/);
    });

    test('level two and three escalation notifications filter stopped recipients', () => {
        const body = extractFunctionBody(
            kanbanSrc,
            'async function processDeviceStaleCards(deviceId, cards)'
        );

        expect(body).toMatch(/function filterNudgeStoppedRecipients\(ids\)/);
        expect(body).toMatch(/if \(effectiveFor\(n\)\.stopMode\) continue/);
        expect(body).toMatch(/fireBlockEscalation\(card, filterNudgeStoppedRecipients\(buildEscalationRecipients\(card\)\)\)/);
        expect(body).toMatch(/fireLevelTwoEscalation\(card, filterNudgeStoppedRecipients\(buildEscalationRecipients\(card\)\)\)/);
    });

    test('nudge delivery helpers accept filtered recipient lists and record only those recipients', () => {
        const l1 = extractFunctionBody(kanbanSrc, 'async function fireLevelOneNudge(card, recipientIds = null)');
        const l2 = extractFunctionBody(kanbanSrc, 'async function fireLevelTwoEscalation(card, recipientIds = null)');
        const l3 = extractFunctionBody(kanbanSrc, 'async function fireBlockEscalation(card, recipientIds = null)');

        expect(l1).toMatch(/const bots = Array\.isArray\(recipientIds\) \? recipientIds : \(card\.assigned_bots \|\| \[\]\)/);
        expect(l1).toMatch(/notifyEntities\(card\.device_id, bots/);
        expect(l1).toMatch(/recordEntityNudge\(card\.device_id, bots\)/);
        expect(l2).toMatch(/const recipients = Array\.isArray\(recipientIds\) \? recipientIds : buildEscalationRecipients\(card\)/);
        expect(l3).toMatch(/const recipients = Array\.isArray\(recipientIds\) \? recipientIds : buildEscalationRecipients\(card\)/);
    });
});

describe('kanban nudge stop-mode portal sync and watermark', () => {
    test('settings UI can toggle stop-mode and marks local preference updates', () => {
        expect(settingsHtml).toContain('id="kanbanNudgeEntStopMode"');
        expect(settingsHtml).toContain("onKanbanNudgeEntityOverrideToggle('kanban_nudge_stop_mode', this.checked)");
        expect(settingsHtml).toContain("next[field] = true");
        expect(settingsHtml).toContain("localStorage.setItem('eclaw_kanban_nudge_prefs_updated'");
        expect(settingsHtml).toContain('data-i18n="kanban_nudge_per_entity_stop_mode"');
        expect(settingsHtml).toMatch(/window\.onSocketDevicePreferences = function\(data\)[\s\S]*applyKanbanNudgePrefs\(data\.prefs\)/);
        expect(kanbanSrc).toContain('emitDevicePreferences(deviceId, updated)');
    });

    test('kanban board renders triangular stop-mode warning marks on assigned avatars', () => {
        expect(kanbanHtml).toContain('.kb-card-avatar-face.nudge-stopped::after');
        expect(kanbanHtml).toContain('.kb-card-avatar-face.nudge-stopped::before');
        expect(kanbanHtml).toContain('let kanbanNudgeStopEntityIds = new Set()');
        expect(kanbanHtml).toContain('function applyKanbanNudgeStopPrefs(prefs)');
        expect(kanbanHtml).toContain("const avatarClass = 'kb-card-avatar-face' + (stopped ? ' nudge-stopped' : '')");
        expect(kanbanHtml).toContain("t('kanban_nudge_stop_mode_avatar_title', 'Nudge stop-mode enabled')");
        expect(kanbanHtml).toContain('renderKanbanEntityAvatar(id, 16, avatarClass)');
    });

    test('preference changes synchronize through socket and cross-tab localStorage marker', () => {
        expect(socketSrc).toContain("portalSocket.on('device:preferences'");
        expect(indexSrc).toContain("io.to(`device:${deviceId}`).emit('device:preferences'");
        expect(indexSrc).toContain('emitDevicePreferences: (deviceId, prefs)');
        expect(kanbanHtml).toMatch(/window\.onSocketDevicePreferences = function\(data\)[\s\S]*applyKanbanNudgeStopPrefs\(data\.prefs\)[\s\S]*renderBoard\(true\)/);
        expect(kanbanHtml).toContain("event.key === 'eclaw_kanban_nudge_prefs_updated'");
        expect(kanbanHtml).toContain('refreshKanbanNudgeStopModes()');
    });
});
