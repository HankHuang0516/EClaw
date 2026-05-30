const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');

// Grab the whole handler body: from the route registration to the closing
// res.json line at the bottom. Both endpoints fit on a contiguous span so a
// fixed-radius window around the route header captures the body cleanly.
function handlerBody() {
    const start = SRC.indexOf(`app.post('/api/admin/petdx-phase0/backfill'`);
    if (start < 0) throw new Error('route not registered');
    const end = SRC.indexOf('committed: commit === true', start);
    if (end < 0) throw new Error('response shape not found');
    return SRC.slice(start, end + 200);
}

describe('POST /api/admin/petdx-phase0/backfill', () => {
    test('endpoint is registered', () => {
        expect(SRC).toMatch(/app\.post\(['"]\/api\/admin\/petdx-phase0\/backfill['"]/);
    });
    test('requires deviceId + deviceSecret', () => {
        const body = handlerBody();
        expect(body).toMatch(/deviceId and deviceSecret are required/);
        expect(body).toMatch(/safeEqual\(device\.deviceSecret,\s*deviceSecret\)/);
    });
    test('dispatches the petdx Phase 0 hook in backfill mode', () => {
        const body = handlerBody();
        expect(body).toMatch(/mode:\s*['"]backfill['"]/);
        expect(body).toMatch(/source:\s*['"]backfill-script['"]/);
        expect(body).toMatch(/assignDefaultCompanionIfMissing/);
    });
    test('honors dry-run by stubbing the IO writes', () => {
        const body = handlerBody();
        expect(body).toMatch(/setDeviceVars:\s*async \(\) => \{\}/);
        expect(body).toMatch(/setDeviceVar:\s*async \(\) => \{\}/);
        expect(body).toMatch(/appendCompanionSelectLog:\s*async \(\) => \{\}/);
    });
    test('returns committed flag + per-entity results buckets', () => {
        const body = handlerBody();
        expect(body).toMatch(/results\.assigned\.push/);
        expect(body).toMatch(/results\.skipped\.push/);
        expect(body).toMatch(/results\.errors\.push/);
        expect(body).toMatch(/committed:\s*commit === true/);
    });
});
