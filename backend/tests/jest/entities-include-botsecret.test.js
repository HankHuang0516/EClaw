/**
 * Regression: /api/entities must include each bound entity's botSecret
 * field in the response when the caller authenticates at owner level
 * (deviceSecret or JWT cookie for this device). It must NOT include
 * botSecret for peer-bot callers (botSecret-auth path).
 *
 * Pre-fix: Android live-wallpaper service called /api/entities with
 * deviceSecret, parsed EntityStatus.botSecret as null for every entity,
 * and ClawWallpaperService.ensureCompanionPollers (which filters
 * entities.mapNotNull { e -> e.botSecret?.let{} }) skipped all of them.
 * No companion poller ever started; the wallpaper rendered the
 * "colored lobster" fallback regardless of petdx selection.
 *
 * Post-fix: handler computes `includeBotSecret = deviceAuthed || jwt`
 * and attaches entity.botSecret to each entity payload when true.
 */

const fs = require('fs');

const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

function slice(anchor, span = 6500) {
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + span);
}

describe('/api/entities botSecret exposure', () => {
    const handler = slice("app.get('/api/entities',", 6500);

    it('derives an includeBotSecret flag from auth mode', () => {
        expect(handler).toMatch(/const includeBotSecret\s*=\s*deviceAuthed\s*\|\|\s*\(jwtDeviceId\s*&&\s*jwtDeviceId\s*===\s*authedDeviceId\)/);
    });

    it('only attaches botSecret when the flag is true AND entity has one', () => {
        expect(handler).toMatch(/if \(includeBotSecret && entity\.botSecret\) \{\s*\n\s*payload\.botSecret = entity\.botSecret;\s*\n\s*\}/);
    });

    it('does NOT attach botSecret unconditionally inside the payload literal', () => {
        // Pull the object literal that the handler pushes; it must not
        // include a bare `botSecret: entity.botSecret` line.
        const literalStart = handler.indexOf('const payload = {');
        expect(literalStart).toBeGreaterThan(-1);
        const literalEnd = handler.indexOf('};', literalStart);
        const literal = handler.slice(literalStart, literalEnd);
        expect(literal).not.toMatch(/botSecret:\s*entity\.botSecret/);
    });

    it('botSecret-auth callers (peer bots) are gated by includeBotSecret', () => {
        // deviceAuthed is false on the botSecret path, and jwtDeviceId comes
        // from JWT cookie middleware (req.user); botAuthed alone never
        // flips includeBotSecret true.
        expect(handler).toMatch(/let botAuthed = false;/);
        // includeBotSecret must not reference botAuthed.
        const flagLine = handler.match(/const includeBotSecret\s*=\s*[^;]+;/);
        expect(flagLine).not.toBeNull();
        expect(flagLine[0]).not.toMatch(/botAuthed/);
    });
});
