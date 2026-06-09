'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    RULES,
    scanFile,
    summarize,
    isExempt,
    HANKS_DEVICE_ID,
    HANKS_EMAIL,
} = require('../../scripts/compliance-scan');

function withFixture(name, content, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-'));
    const full = path.join(dir, name);
    fs.writeFileSync(full, content);
    try {
        run(full, name);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('compliance-scan rules', () => {
    test('detects hardcoded deviceId literal', () => {
        withFixture('fake.js', `const id = "${HANKS_DEVICE_ID}";\n`, (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'hardcoded-device-id');
            expect(hits.length).toBe(1);
            expect(hits[0].line).toBe(1);
        });
    });

    test('detects hardcoded entityId comparison', () => {
        withFixture('handler.js', 'if (entityId === 3) doThing();\n', (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'hardcoded-entity-id');
            expect(hits.length).toBe(1);
        });
    });

    test('ignores entityId === 0 (often legitimate sentinel)', () => {
        withFixture('handler.js', 'if (entityId === 0) skip();\n', (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'hardcoded-entity-id');
            expect(hits.length).toBe(0);
        });
    });

    test('detects /Users/hank/ path literal', () => {
        withFixture('cfg.js', 'const p = "/Users/hank/Desktop/foo";\n', (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'hardcoded-hank-path');
            expect(hits.length).toBe(1);
        });
    });

    test('detects email gate', () => {
        withFixture('auth.js', `if (user.email === "${HANKS_EMAIL}") allow();\n`, (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'email-gate');
            expect(hits.length).toBe(1);
        });
    });

    test('detects non-eclawbot prod URL', () => {
        withFixture('client.js', 'fetch("https://my-private-app.example-corp.com/api/data");\n', (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'non-eclawbot-prod-url');
            expect(hits.length).toBe(1);
        });
    });

    test('ignores eclawbot.com URLs', () => {
        withFixture('client.js', 'fetch("https://eclawbot.com/api/x");\n', (full, rel) => {
            const violations = [];
            scanFile(full, rel, violations);
            const hits = violations.filter(v => v.rule === 'non-eclawbot-prod-url');
            expect(hits.length).toBe(0);
        });
    });

    test('isExempt skips test files', () => {
        expect(isExempt('backend/tests/jest/foo.test.js')).toBe(true);
        expect(isExempt('backend/__tests__/foo.js')).toBe(true);
        expect(isExempt('backend/scripts/dev-only/seed.js')).toBe(true);
        expect(isExempt('docs/compliance-baseline-2026-06-09.json')).toBe(true);
        expect(isExempt('backend/scripts/compliance-scan.js')).toBe(true);
    });

    test('isExempt does NOT skip normal product code', () => {
        expect(isExempt('backend/public/portal/chat.html')).toBe(false);
        expect(isExempt('backend/index.js')).toBe(false);
    });

    test('summarize counts by rule', () => {
        const sample = [
            { rule: 'hardcoded-device-id' },
            { rule: 'hardcoded-device-id' },
            { rule: 'email-gate' },
        ];
        expect(summarize(sample)).toEqual({
            by_rule: { 'hardcoded-device-id': 2, 'email-gate': 1 },
            total: 3,
        });
    });
});
