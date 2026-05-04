'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanSrc = fs.readFileSync(path.join(ROOT, 'kanban.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`unterminated function: ${signature}`);
}

describe('autoReviewOnTransform — cardId guard against false batch-close', () => {
    const sig = 'async function autoReviewOnTransform(deviceId, entityId, transformMessage, aboutCardId)';
    const body = extractFunctionBody(kanbanSrc, sig);

    test('signature accepts aboutCardId as 4th parameter', () => {
        expect(kanbanSrc).toContain(sig);
    });

    test('SELECT filters by c.id and ties query to aboutCardId', () => {
        expect(body).toMatch(/WHERE c\.id = \$1[\s\S]*?AND c\.device_id = \$2[\s\S]*?AND c\.assigned_bots::jsonb @> \$3::jsonb/);
    });

    test('skips entirely when aboutCardId is missing — no IDLE-content fallback close', () => {
        expect(body).toMatch(/if\s*\(\s*!\s*aboutCardId\s*\)\s*{[\s\S]*?autoReviewOnTransform skipped[\s\S]*?return/);
    });

    test('does not contain the legacy "exactly one eligible card" untargeted branch', () => {
        expect(body).not.toMatch(/result\.rows\.length\s*>\s*1/);
        expect(body).not.toMatch(/}\s*else\s*{[\s\S]*?WHERE c\.device_id = \$1/);
    });

    test('eligibility filter (auto-generated OR reviewer-tagged + active status) is intact', () => {
        expect(body).toMatch(/is_auto_generated = true OR .*reviewer_entity_id IS NOT NULL/);
        expect(body).toMatch(/status IN \('todo', 'in_progress'\)/);
        expect(body).toMatch(/archived = false/);
    });

    test('screenshot-review gate is still in place after refactor', () => {
        expect(body).toMatch(/requires_screenshot_review !== false/);
        expect(body).toMatch(/Auto-close blocked by screenshot gate/);
    });
});

describe('transform handler — wires aboutCardId through to autoReviewOnTransform', () => {
    test('POST /api/transform destructures aboutCardId from req.body', () => {
        expect(indexSrc).toMatch(/let\s*\{[^}]*\baboutCardId\b[^}]*\}\s*=\s*req\.body/);
    });

    test('autoReviewOnTransform call passes aboutCardId as 4th argument', () => {
        expect(indexSrc).toMatch(/autoReviewOnTransform\(deviceId,\s*eId,\s*finalMessage,\s*aboutCardId\)/);
    });
});
