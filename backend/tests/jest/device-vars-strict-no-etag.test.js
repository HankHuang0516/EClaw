'use strict';

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

describe('POST /api/device-vars — strict no-etag guard (card_908a34a9 / vault zombification re-occurrence)', () => {
    test('strictMode env flag read from VAULT_STRICT_NO_ETAG with "warn" default', () => {
        expect(indexSrc).toMatch(/process\.env\.VAULT_STRICT_NO_ETAG\s*\|\|\s*['"]warn['"]/);
    });

    test('guard fires only when expectedUpdatedAt is absent', () => {
        expect(indexSrc).toMatch(/if\s*\(\s*!expectedUpdatedAt\s*\)\s*{[\s\S]*?VAULT_STRICT_NO_ETAG/);
    });

    test('guard skips entirely when strictMode is "off"', () => {
        // The block only enters the gate when strictMode is 'warn' OR 'reject'
        expect(indexSrc).toMatch(/strictMode === ['"]warn['"]\s*\|\|\s*strictMode === ['"]reject['"]/);
    });

    test('guard requires existing row with at least one key (existingKeyCount > 0)', () => {
        expect(indexSrc).toMatch(/existingKeyCount\s*>\s*0/);
        expect(indexSrc).toMatch(/var_keys\s*&&\s*Array\.isArray\(existingRow\.var_keys\)/);
    });

    test('reject mode returns 400 with stale_write_no_etag and serverUpdatedAt', () => {
        expect(indexSrc).toMatch(/error:\s*['"]stale_write_no_etag['"]/);
        expect(indexSrc).toMatch(/POST is missing expectedUpdatedAt and a server vault already exists/);
        expect(indexSrc).toMatch(/return res\.status\(400\)\.json\(\s*{[\s\S]*?serverUpdatedAt:\s*existingUpdatedAt/);
    });

    test('warn mode logs + falls through (does NOT return 400)', () => {
        // Audit row written with action refuse_no_etag (reject) or warn_no_etag (warn)
        expect(indexSrc).toMatch(/action:\s*strictMode === ['"]reject['"]\s*\?\s*['"]refuse_no_etag['"]\s*:\s*['"]warn_no_etag['"]/);
        // console.warn fires either way
        expect(indexSrc).toMatch(/\[Vars\] POST without expectedUpdatedAt against non-empty row/);
    });

    test('guard does not fire when existing row is empty (existingKeyCount = 0)', () => {
        // First-time POST (no existing keys) must succeed — strict mode only protects
        // against overwriting an existing non-empty vault with a stale snapshot
        const block = indexSrc.match(/if\s*\(\s*!expectedUpdatedAt\s*\)\s*{[\s\S]*?else\s*{[\s\S]*?const currentRow = await db\.getDeviceVars/);
        expect(block).toBeTruthy();
        // The early-return path (400) is inside the existingKeyCount > 0 branch
        expect(block[0]).toMatch(/if\s*\(\s*existingKeyCount\s*>\s*0\s*\)\s*{[\s\S]*?return res\.status\(400\)/);
    });

    test('audit row records source label (web/app/legacy) for forensic trace', () => {
        expect(indexSrc).toMatch(/const _srcLabel = \(source === ['"]web['"]\s*\|\|\s*source === ['"]app['"]\)\s*\?\s*source\s*:\s*['"]legacy['"]/);
    });

    test('coexists with existing expectedUpdatedAt path (else branch preserved)', () => {
        // The original 409 stale_write logic (when expectedUpdatedAt is sent but mismatched)
        // must remain intact in the else branch
        expect(indexSrc).toMatch(/else\s*{[\s\S]*?const currentRow = await db\.getDeviceVars[\s\S]*?currentUpdatedAt !== expectedUpdatedAt[\s\S]*?error:\s*['"]stale_write['"]/);
    });

    test('comment cites card_908a34a9 (follow-up) and card_946cfefe (origin)', () => {
        expect(indexSrc).toMatch(/card_908a34a9[\s\S]*?card_946cfefe/);
    });
});
