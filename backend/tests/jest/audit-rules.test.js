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
