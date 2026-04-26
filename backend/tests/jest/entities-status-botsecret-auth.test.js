/**
 * Regression: /api/entities and /api/status must accept three auth paths:
 *   1. deviceId + deviceSecret  (device-owner)
 *   2. deviceId + botSecret + entityId  (per-entity bot self-introspection)
 *   3. JWT cookie  (web session)
 *
 * Static source-level assertions — no live DB required.
 *
 * Bug context: API Health probe (card_1629e85f) called all 3 auth-required
 * endpoints with botSecret+entityId; /api/mission/dashboard accepted (200),
 * /api/entities + /api/status returned 403 because their auth blocks predated
 * the kanban authenticate() helper that supports botSecret. This test guards
 * the fix that adds path #2 to both handlers.
 */

const fs = require('fs');

const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

function slice(anchor, span = 2500) {
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + span);
}

describe('/api/entities auth paths', () => {
    const handler = slice("app.get('/api/entities',", 2500);

    it('reads botSecret + entityId from query', () => {
        expect(handler).toMatch(/const botSecret\s*=\s*req\.query\.botSecret/);
        expect(handler).toMatch(/parseInt\(req\.query\.entityId\)/);
    });

    it('validates botSecret against entity.botSecret via safeEqual', () => {
        expect(handler).toMatch(/safeEqual\([^)]*botSecret[^)]*botSecret\)/);
    });

    it('requires entity to be bound for botSecret path', () => {
        expect(handler).toMatch(/botEntity\.isBound/);
    });

    it('still supports deviceSecret path', () => {
        expect(handler).toMatch(/safeEqual\(devices\[filterDeviceId\]\.deviceSecret,\s*deviceSecret\)/);
    });

    it('still supports JWT path', () => {
        expect(handler).toMatch(/jwtDeviceId/);
    });

    it('returns 403 when no auth path resolves', () => {
        expect(handler).toMatch(/status\(403\)/);
    });
});

describe('/api/status auth paths', () => {
    const handler = slice("app.get('/api/status',", 2500);

    it('reads botSecret from query', () => {
        expect(handler).toMatch(/const botSecret\s*=\s*req\.query\.botSecret/);
    });

    it('validates botSecret against entity.botSecret via safeEqual', () => {
        expect(handler).toMatch(/safeEqual\([^)]*botSecret[^)]*botSecret\)/);
    });

    it('requires entity to be bound for botSecret path', () => {
        expect(handler).toMatch(/botEntity\.isBound/);
    });

    it('still supports deviceSecret path', () => {
        expect(handler).toMatch(/safeEqual\(devices\[deviceId\]\.deviceSecret,\s*deviceSecret\)/);
    });

    it('still supports JWT path', () => {
        expect(handler).toMatch(/jwtDeviceId/);
    });

    it('returns 403 when no auth path resolves', () => {
        expect(handler).toMatch(/status\(403\)/);
    });
});
