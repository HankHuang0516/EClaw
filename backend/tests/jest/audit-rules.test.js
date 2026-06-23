'use strict';

/**
 * Rule-matcher determinism tests for the weekly compliance + multi-tenant
 * audit. Card: card_923709f59ecb0c1cd66bc786 (Hank 2026-06-07 20:32 TW).
 *
 * Each case feeds a deterministic text snippet to scanText() and asserts the
 * exact finding shape (ruleId / dimension / severity / lineNo). This is the
 * contract the weekly runner depends on; a regex regression that widens or
 * narrows a rule will flip one of these.
 */

const audit = require('../../agent-improvement/audit-rules');

describe('audit-rules — rule catalog shape', () => {
    test('every rule has the required pure-data fields + unique id', () => {
        const ids = new Set();
        for (const r of audit.RULES) {
            expect(typeof r.id).toBe('string');
            expect(r.id).toMatch(/^[a-z0-9-]+$/);
            expect(ids.has(r.id)).toBe(false);
            ids.add(r.id);
            expect(audit.DIMENSIONS).toContain(r.dimension);
            expect(audit.SEVERITIES).toContain(r.severity);
            expect(r.pattern).toBeInstanceOf(RegExp);
            expect(typeof r.title).toBe('string');
            expect(typeof r.rationale).toBe('string');
        }
    });
});

describe('audit-rules — scanText matcher (deterministic input → finding shape)', () => {
    test('hardcoded Hank device UUID flagged P0 compliance with correct line', () => {
        const text = [
            'const x = 1;',
            "const dev = '480def4c-2183-4d8e-afd0-b131ae89adcc';",
        ].join('\n');
        const f = audit.scanText('backend/foo.js', text);
        const hit = f.find(r => r.ruleId === 'hardcoded-hank-device-id');
        expect(hit).toBeTruthy();
        expect(hit.dimension).toBe('compliance');
        expect(hit.severity).toBe('P0');
        expect(hit.lineNo).toBe(2);
        expect(hit.filePath).toBe('backend/foo.js');
    });

    test('/Users/hank/ absolute path flagged P1', () => {
        const f = audit.scanText('backend/svc.js', "require('/Users/hank/secret.js');");
        expect(f.some(r => r.ruleId === 'hardcoded-users-hank-path' && r.severity === 'P1')).toBe(true);
    });

    test('entityId === N equality flagged in normal source', () => {
        const f = audit.scanText('backend/handler.js', 'if (entityId === 2) { doThing(); }');
        expect(f.some(r => r.ruleId === 'hardcoded-entity-id-comparison')).toBe(true);
    });

    test('migration ADD COLUMN without IF NOT EXISTS flagged only in .up.sql', () => {
        const sql = 'ALTER TABLE bots ADD COLUMN nickname TEXT;';
        expect(audit.scanText('m/20260101_x.up.sql', sql)
            .some(r => r.ruleId === 'migration-without-if-not-exists')).toBe(true);
        // filePathFilter restricts to .up.sql — a .js file with the same text is exempt
        expect(audit.scanText('backend/notsql.js', sql)
            .some(r => r.ruleId === 'migration-without-if-not-exists')).toBe(false);
    });

    test('empty speakTo:[] flagged P1 multi_tenant', () => {
        const f = audit.scanText('backend/route.js', 'send({ speakTo: [] , message });');
        const hit = f.find(r => r.ruleId === 'broadcast-without-recipient-list');
        expect(hit).toBeTruthy();
        expect(hit.dimension).toBe('multi_tenant');
        expect(hit.severity).toBe('P1');
    });

    test('IF NOT EXISTS migration is NOT flagged (no false positive)', () => {
        const sql = 'ALTER TABLE bots ADD COLUMN IF NOT EXISTS nickname TEXT;';
        expect(audit.scanText('m/20260101_x.up.sql', sql)
            .some(r => r.ruleId === 'migration-without-if-not-exists')).toBe(false);
    });
});

describe('audit-rules — extended catalog (card rule list A/B coverage)', () => {
    test('owner-only LIMIT 1 device query flagged P1 compliance', () => {
        const f = audit.scanText('backend/api_profile.js',
            'const r = await db.query("SELECT name FROM profiles WHERE device_id = $1 LIMIT 1", [d]);');
        const hit = f.find(r => r.ruleId === 'owner-only-user-query-assumption');
        expect(hit).toBeTruthy();
        expect(hit.dimension).toBe('compliance');
        expect(hit.severity).toBe('P1');
    });

    test('entityId read from req.body without caller check flagged P0 multi_tenant', () => {
        const f = audit.scanText('backend/api_handler.js', 'const entityId = req.body.entityId;');
        const hit = f.find(r => r.ruleId === 'entity-id-from-body-unverified');
        expect(hit).toBeTruthy();
        expect(hit.dimension).toBe('multi_tenant');
        expect(hit.severity).toBe('P0');
    });

    test('non-atomic counter write-back flagged (cross-entity race)', () => {
        const f = audit.scanText('backend/api_card.js',
            'await db.query("UPDATE cards SET comment_count = $2 WHERE id = $1", [id, n]);');
        expect(f.some(r => r.ruleId === 'cross-entity-read-modify-write-race')).toBe(true);
    });

    test('atomic increment (col = col + 1) is NOT flagged (no false positive)', () => {
        const f = audit.scanText('backend/api_card.js',
            'await db.query("UPDATE cards SET comment_count = comment_count + 1 WHERE id = $1", [id]);');
        expect(f.some(r => r.ruleId === 'cross-entity-read-modify-write-race')).toBe(false);
    });

    test('bare token fan-out loop flagged (no dedupe)', () => {
        const f = audit.scanText('backend/push.js', 'for (const tok of pushTokens) { send(tok); }');
        expect(f.some(r => r.ruleId === 'push-fanout-without-dedupe')).toBe(true);
    });

    test('upload key built from filename without namespace flagged P1', () => {
        const f = audit.scanText('backend/upload.js', 'await r2.put({ Key: `uploads/${filename}`, Body: buf });');
        const hit = f.find(r => r.ruleId === 'upload-path-collides-across-users');
        expect(hit).toBeTruthy();
        expect(hit.severity).toBe('P1');
    });
});

describe('audit-rules — falseHits suppression', () => {
    test("publicCode rule does NOT flag 'base64' / 'sha256'", () => {
        const text = "const enc = 'base64'; const algo = 'sha256';";
        const f = audit.scanText('backend/crypto.js', text);
        expect(f.some(r => r.ruleId === 'hardcoded-public-code-literal')).toBe(false);
    });

    test('publicCode rule STILL flags a real code-shaped literal', () => {
        const f = audit.scanText('backend/routing.js', "const code = 'tbwb9e';");
        expect(f.some(r => r.ruleId === 'hardcoded-public-code-literal')).toBe(true);
    });
});

// ─── 2026-06-22 weekly-audit precision pass (card_f9b2cc2d triage) ──────────
// Each rule below produced 0 true positives but 2–52 false positives/week.
// These tests pin the new suppressions AND that real positives still fire.
describe('audit-rules — precision pass: publicCode comments + encoding constants', () => {
    test("does NOT flag 'oauth2' / 'latin1' / 'a1b1c1' (encoding/test constants)", () => {
        const text = "authMode: 'oauth2'; const e = 'latin1'; const rle = 'a1b1c1';";
        expect(audit.scanText('backend/x.js', text)
            .some(r => r.ruleId === 'hardcoded-public-code-literal')).toBe(false);
    });
    test('does NOT flag publicCode-shaped literals inside comment / JSDoc lines', () => {
        const text = [
            "  *   - \"abc123\"   6-char publicCode (cross-device)",
            "  // legit display name like 'alice1'",
            "  *   ProductTour.register('track1', [",
        ].join('\n');
        expect(audit.scanText('backend/x.js', text)
            .some(r => r.ruleId === 'hardcoded-public-code-literal')).toBe(false);
    });
    test('STILL flags a real publicCode literal in executable code', () => {
        expect(audit.scanText('backend/x.js', "speakTo(['3xa3h4']);")
            .some(r => r.ruleId === 'hardcoded-public-code-literal')).toBe(true);
    });
});

describe('audit-rules — precision pass: RMW upsert / row-lock / literal', () => {
    test('does NOT flag ON CONFLICT … DO UPDATE upsert (atomic)', () => {
        const sql = 'INSERT ... ON CONFLICT (device_id) DO UPDATE SET violation_count = $2, is_blocked = $3';
        expect(audit.scanText('backend/gatekeeper.js', sql)
            .some(r => r.ruleId === 'cross-entity-read-modify-write-race')).toBe(false);
    });
    test('does NOT flag a literal-constant reset (SET violation_count = 0)', () => {
        const sql = 'UPDATE gatekeeper_blocks SET violation_count = 0, is_blocked = FALSE WHERE device_id = $1';
        expect(audit.scanText('backend/gatekeeper.js', sql)
            .some(r => r.ruleId === 'cross-entity-read-modify-write-race')).toBe(false);
    });
    test('does NOT flag a write guarded by SELECT … FOR UPDATE earlier in the txn', () => {
        const sql = [
            "await c.query('SELECT 1 FROM companions WHERE id = $1 FOR UPDATE', [id]);",
            "await c.query('UPDATE companions SET rating_count = $1 WHERE id = $2', [n, id]);",
        ].join('\n');
        expect(audit.scanText('backend/companion-api.js', sql)
            .some(r => r.ruleId === 'cross-entity-read-modify-write-race')).toBe(false);
    });
    test('STILL flags a bare non-atomic counter write-back ($n, no lock/upsert)', () => {
        const sql = 'await db.query("UPDATE cards SET comment_count = $2 WHERE id = $1", [id, n]);';
        expect(audit.scanText('backend/api_card.js', sql)
            .some(r => r.ruleId === 'cross-entity-read-modify-write-race')).toBe(true);
    });
});

describe('audit-rules — precision pass: owner-only single-row-per-device table', () => {
    test('does NOT flag user_accounts (UNIQUE(device_id) → 1 row/device)', () => {
        const sql = "'SELECT language FROM user_accounts WHERE device_id = $1 LIMIT 1'";
        expect(audit.scanText('backend/kanban.js', sql)
            .some(r => r.ruleId === 'owner-only-user-query-assumption')).toBe(false);
    });
    test('STILL flags LIMIT 1 on a non-unique table', () => {
        const sql = "'SELECT name FROM profiles WHERE device_id = $1 LIMIT 1'";
        expect(audit.scanText('backend/api_profile.js', sql)
            .some(r => r.ruleId === 'owner-only-user-query-assumption')).toBe(true);
    });
});

describe('audit-rules — precision pass: db-query entity_id filter (schema-aware)', () => {
    test('does NOT flag a device-grain table (no entity_id column)', () => {
        const sql = [
            'SELECT source_card_id FROM kanban_card_links',
            ' WHERE device_id = $1',
        ].join('\n');
        expect(audit.scanText('backend/api_kanban_card_links.js', sql)
            .some(r => r.ruleId === 'db-query-missing-entity-id-filter')).toBe(false);
    });
    test('does NOT flag when entity_id IS filtered on a continuation line', () => {
        const sql = [
            'SELECT x FROM entity_error_counters',
            ' WHERE device_id = $1',
            '   AND entity_id = $2',
        ].join('\n');
        expect(audit.scanText('backend/entity-status.js', sql)
            .some(r => r.ruleId === 'db-query-missing-entity-id-filter')).toBe(false);
    });
    test('STILL flags an entity-scoped table read with no entity_id filter', () => {
        const sql = [
            'SELECT body FROM chat_messages',
            ' WHERE device_id = $1',
        ].join('\n');
        expect(audit.scanText('backend/leak.js', sql)
            .some(r => r.ruleId === 'db-query-missing-entity-id-filter')).toBe(true);
    });
    test('fails SAFE: unresolved table is kept (treated as entity-scoped)', () => {
        // no FROM in window → cannot prove device-grain → keep the finding
        const sql = 'WHERE device_id = $1';
        expect(audit.scanText('backend/unknown.js', sql)
            .some(r => r.ruleId === 'db-query-missing-entity-id-filter')).toBe(true);
    });
});

describe('audit-rules — precision pass: body.entityId IDOR auth-awareness', () => {
    test('does NOT flag when caller is validated (safeEqual botSecret nearby)', () => {
        const code = [
            'const entityId = req.body.entityId ?? req.query.entityId;',
            'const entity = device.entities[eId];',
            'if (!safeEqual(botSecret, entity.botSecret)) return res.status(403).json({});',
        ].join('\n');
        expect(audit.scanText('backend/index.js', code)
            .some(r => r.ruleId === 'entity-id-from-body-unverified')).toBe(false);
    });
    test('STILL flags a body.entityId read with NO caller-auth check nearby', () => {
        const code = [
            'const entityId = req.body.entityId;',
            'await pool.query("DELETE FROM widgets WHERE entity_id = $1", [entityId]);',
        ].join('\n');
        expect(audit.scanText('backend/leak.js', code)
            .some(r => r.ruleId === 'entity-id-from-body-unverified')).toBe(true);
    });
});

describe('audit-rules — file exemptions', () => {
    test('test paths exempt the Hank-UUID rule', () => {
        const text = "const d = '480def4c-2183-4d8e-afd0-b131ae89adcc';";
        expect(audit.scanText('backend/tests/jest/foo.test.js', text)
            .some(r => r.ruleId === 'hardcoded-hank-device-id')).toBe(false);
    });

    test('isFileExempt honors allowFiles substrings and filePathFilter', () => {
        const ruleUuid = audit.RULES.find(r => r.id === 'hardcoded-hank-device-id');
        expect(audit.isFileExempt('a/__tests__/b.js', ruleUuid)).toBe(true);
        expect(audit.isFileExempt('backend/real.js', ruleUuid)).toBe(false);
    });

    test('empty / non-string text returns no findings', () => {
        expect(audit.scanText('x.js', '')).toEqual([]);
        expect(audit.scanText('x.js', null)).toEqual([]);
    });
});

// ─── Dimension C: human_operability (card_3c6fb87 SPEC v1+v2, Hank 2026-06-23) ──
// R1–R7. Each rule has a positive fixture (fires) and a negative fixture (does
// NOT fire) so a regex/context regression that widens or narrows the rule flips
// a test. Fixtures use a real portal path so the filePathFilter scope is exercised.
const P = 'public/portal/x.html';        // portal HTML (R1–R6)
const PCSS = 'public/portal/x.css';      // portal CSS  (R7)
const has = (text, ruleId, file = P) =>
    audit.scanText(file, text).some(r => r.ruleId === ruleId);

describe('audit-rules — operability dimension catalog', () => {
    test("'operability' is a registered dimension with ≥7 rules", () => {
        expect(audit.DIMENSIONS).toContain('operability');
        const ops = audit.RULES.filter(r => r.dimension === 'operability');
        expect(ops.length).toBeGreaterThanOrEqual(7);
        for (const r of ops) {
            expect(r.pattern).toBeInstanceOf(RegExp);
            expect(audit.SEVERITIES).toContain(r.severity);
        }
    });
    test('operability rules are scoped OFF non-portal files', () => {
        // A backend service file with an icon-only button-shaped string must not fire R1.
        expect(has('<button class="x">🔥</button>', 'operability-icon-button-no-aria',
            'index.js')).toBe(false);
    });
});

describe('audit-rules — R1 icon-button-no-aria', () => {
    test('icon-only button (emoji) with no aria-label/title FIRES', () => {
        expect(has('<button class="fab" onclick="open()">🤖</button>',
            'operability-icon-button-no-aria')).toBe(true);
    });
    test('icon-only button with an HTML-entity glyph FIRES', () => {
        expect(has('<button class="modal-close" onclick="close()">&#x2715;</button>',
            'operability-icon-button-no-aria')).toBe(true);
    });
    test('icon button WITH aria-label does NOT fire', () => {
        expect(has('<button class="fab" aria-label="Open chat" onclick="open()">🤖</button>',
            'operability-icon-button-no-aria')).toBe(false);
    });
    test('icon button WITH title does NOT fire', () => {
        expect(has('<button class="v" title="Grid" onclick="g()">⊞</button>',
            'operability-icon-button-no-aria')).toBe(false);
    });
    test('button with real text label does NOT fire (text IS the name)', () => {
        expect(has('<button onclick="more()">Load more</button>',
            'operability-icon-button-no-aria')).toBe(false);
    });
});

describe('audit-rules — R2 div-onclick-no-keyboard', () => {
    test('<div onclick> with no role/tabindex (action handler) FIRES', () => {
        expect(has('<div class="hdr" onclick="toggleSection()">More</div>',
            'operability-div-onclick-no-keyboard')).toBe(true);
    });
    test('<div onclick> WITH role + tabindex does NOT fire', () => {
        expect(has('<div role="button" tabindex="0" onclick="toggleSection()">More</div>',
            'operability-div-onclick-no-keyboard')).toBe(false);
    });
    test('modal backdrop (event.target===this) does NOT fire', () => {
        expect(has('<div class="overlay" onclick="if(event.target===this)close()">',
            'operability-div-onclick-no-keyboard')).toBe(false);
    });
    test('overlay/backdrop close-on-click does NOT fire', () => {
        expect(has('<div class="kb-message-modal-backdrop" onclick="closeMessageModal()"></div>',
            'operability-div-onclick-no-keyboard')).toBe(false);
    });
});

describe('audit-rules — R3 input-no-label', () => {
    test('text input with placeholder + no label/aria FIRES', () => {
        expect(has('<input type="text" id="q" placeholder="Search...">',
            'operability-input-no-label')).toBe(true);
    });
    test('input WITH aria-label does NOT fire', () => {
        expect(has('<input type="text" id="q" placeholder="Search..." aria-label="Search">',
            'operability-input-no-label')).toBe(false);
    });
    test('input WITH a matching <label for> elsewhere in the file does NOT fire', () => {
        const html = [
            '<label class="form-label" for="email">Email</label>',
            '<input type="email" id="email" placeholder="you@example.com">',
        ].join('\n');
        expect(has(html, 'operability-input-no-label')).toBe(false);
    });
    test('type=hidden input does NOT fire', () => {
        expect(has('<input type="hidden" id="csrf" placeholder="x">',
            'operability-input-no-label')).toBe(false);
    });
});

describe('audit-rules — R4 destructive-no-confirm', () => {
    test('delete handler that does a DELETE with no confirm FIRES (P1)', () => {
        const code = [
            'async function removeBot(botId) {',
            "  await apiCall('DELETE', '/api/admin/official-bot/' + botId);",
            '  showToast("removed");',
            '}',
        ].join('\n');
        const f = audit.scanText(P, code).find(r => r.ruleId === 'operability-destructive-no-confirm');
        expect(f).toBeTruthy();
        expect(f.severity).toBe('P1');
    });
    test('delete handler WITH showConfirm in body does NOT fire', () => {
        const code = [
            'async function deleteFile(idx) {',
            "  if (!await showConfirm({ message: 'Delete?' })) return;",
            "  await apiCall('DELETE', '/api/files/' + idx);",
            '}',
        ].join('\n');
        expect(has(code, 'operability-destructive-no-confirm')).toBe(false);
    });
    test('UI-only reset (no server mutation) does NOT fire', () => {
        const code = [
            'function clearSearch() {',
            "  document.getElementById('q').value = '';",
            '  filterAndSort();',
            '}',
        ].join('\n');
        expect(has(code, 'operability-destructive-no-confirm')).toBe(false);
    });
    test('JS Set.delete() in a clear handler is NOT a server mutation', () => {
        const code = [
            'function clearReceiverHintForEntity(entityId) {',
            '  autoToggledReceiverEntities.delete(entityId);',
            '}',
        ].join('\n');
        expect(has(code, 'operability-destructive-no-confirm')).toBe(false);
    });
});

describe('audit-rules — R5 emptystate-no-next-step', () => {
    test('empty-state block with no CTA / next step FIRES', () => {
        expect(has('<div class="empty-state">No pending friend requests</div>',
            'operability-emptystate-no-next-step')).toBe(true);
    });
    test('empty-state WITH a CTA button does NOT fire', () => {
        const html = [
            '<div class="empty-state">',
            '  <div>No cards yet</div>',
            '  <button class="btn" onclick="go()">Go to Plaza</button>',
            '</div>',
        ].join('\n');
        expect(has(html, 'operability-emptystate-no-next-step')).toBe(false);
    });
    test('empty-state with instructional next-step copy does NOT fire', () => {
        expect(has('<div class="empty-state">Click "Capture Screen" to see the UI tree.</div>',
            'operability-emptystate-no-next-step')).toBe(false);
    });
    test('positive/success empty state ("No issues detected") does NOT fire', () => {
        expect(has('<ul class="rm-issues empty"><li>No issues detected.</li></ul>',
            'operability-emptystate-no-next-step')).toBe(false);
    });
    test('a child sub-element (empty-state-icon) does NOT itself fire', () => {
        expect(has('<div class="empty-state-icon">📭</div>',
            'operability-emptystate-no-next-step')).toBe(false);
    });
});

describe('audit-rules — R6 mutation-no-feedback', () => {
    test('fire-and-forget POST (no await/then/catch/feedback) FIRES', () => {
        const code = [
            "function ping() {",
            "  fetch('/api/x', { method: 'POST', body: '{}' });",
            "}",
        ].join('\n');
        expect(has(code, 'operability-mutation-no-feedback')).toBe(true);
    });
    test('awaited mutating call does NOT fire', () => {
        expect(has("await apiCall('POST', '/api/x', body);",
            'operability-mutation-no-feedback')).toBe(false);
    });
    test('mutating call with a .catch handler does NOT fire', () => {
        const code = [
            "apiCall('PUT', '/api/avatar', { emoji })",
            "  .catch(() => {});",
        ].join('\n');
        expect(has(code, 'operability-mutation-no-feedback')).toBe(false);
    });
    test('mutating call with a .then(success-toast) does NOT fire', () => {
        const code = [
            "apiCall('POST', '/api/x', body)",
            "  .then(() => showToast('ok'));",
        ].join('\n');
        expect(has(code, 'operability-mutation-no-feedback')).toBe(false);
    });
});

describe('audit-rules — R7 focus-style-removed', () => {
    test(':focus { outline: none } with no replacement (single line) FIRES', () => {
        expect(has('.btn:focus { outline: none; }',
            'operability-focus-style-removed', PCSS)).toBe(true);
    });
    test(':focus { outline:none; border-color } (replacement present) does NOT fire', () => {
        expect(has('.search:focus { outline: none; border-color: var(--accent); }',
            'operability-focus-style-removed', PCSS)).toBe(false);
    });
    test('multi-line :focus block with a border-color replacement does NOT fire', () => {
        const css = [
            '.edit-field input:focus {',
            '    outline: none;',
            '    border-color: var(--primary);',
            '}',
        ].join('\n');
        expect(has(css, 'operability-focus-style-removed', PCSS)).toBe(false);
    });
    test('multi-line :focus block removing outline with NO replacement FIRES', () => {
        const css = [
            '.bare:focus {',
            '    outline: none;',
            '}',
        ].join('\n');
        expect(has(css, 'operability-focus-style-removed', PCSS)).toBe(true);
    });
    test('outline:none on a NON-focus selector does NOT fire (not a focus removal)', () => {
        expect(has('.input-bar input { outline: none; border: none; }',
            'operability-focus-style-removed', PCSS)).toBe(false);
    });
});
