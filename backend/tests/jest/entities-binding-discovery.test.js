/**
 * Regression: bots must be able to discover how each entity is bound.
 *
 * /api/entities/status    (botSecret auth)   must return bindingType +
 *                                            channelAccountId + channelProvider
 *                                            per entity.
 * /api/entities           (deviceSecret)     must also carry channelProvider.
 * /api/entity/lookup      (public)           must carry bindingType but
 *                                            NOT channelProvider.
 *
 * Static source-level assertions — no live DB required.
 */

const fs = require('fs');

const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

function slice(anchor, span = 2000) {
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + span);
}

describe('deriveChannelProvider helper', () => {
    it('is defined in index.js and covers the four known providers', () => {
        const block = slice('function deriveChannelProvider', 800);
        expect(block).toMatch(/'openclaw'/);
        expect(block).toMatch(/'claude'/);
        expect(block).toMatch(/'hermes'/);
        expect(block).toMatch(/'custom'/);
    });

    it('short-circuits on null/missing callback_url', () => {
        const block = slice('function deriveChannelProvider', 800);
        expect(block).toMatch(/if\s*\(!callbackUrl\)\s*return\s+null/);
    });

    // Evaluate the helper in isolation (no express/pool) by extracting its
    // body from source so we can drive real URLs through it.
    function extractFn(name) {
        const re = new RegExp(`function ${name}\\b([\\s\\S]*?)\\n\\}\\n`);
        const m = src.match(re);
        if (!m) throw new Error(`could not extract ${name}`);
        // eslint-disable-next-line no-new-func
        return new Function(`return function ${name}${m[1]}}`)();
    }
    const derive = extractFn('deriveChannelProvider');

    it.each([
        [null, null],
        ['', null],
        ['https://plugin.openclaw.dev/callback', 'openclaw'],
        ['https://my.openclaw-host.com/hook', 'openclaw'],
        ['https://example.com/claude-code/webhook', 'claude'],
        ['https://claude.ai/relay', 'claude'],
        ['https://hermes.example.com/hook', 'hermes'],
        ['https://a.eclawbot.com/eclaw-webhook', 'custom'],
        ['not a url', 'custom'],
    ])('%s -> %s', (url, expected) => {
        expect(derive(url)).toBe(expected);
    });
});

describe('/api/entities/status response shape', () => {
    const handler = slice("app.get('/api/entities/status'", 3000);

    it('is async (needs to look up channel_accounts)', () => {
        expect(handler).toMatch(/app\.get\('\/api\/entities\/status',\s*async\s*\(req,\s*res\)\s*=>/);
    });

    it('fetches channel_accounts once via db.getChannelAccountsByDevice', () => {
        expect(handler).toContain('db.getChannelAccountsByDevice(deviceId)');
    });

    it('each entity carries bindingType, channelAccountId, channelProvider', () => {
        expect(handler).toMatch(/bindingType,/);
        expect(handler).toMatch(/channelAccountId,/);
        expect(handler).toMatch(/channelProvider,/);
    });

    it('channelProvider only set when bindingType="channel" AND channelAccountId present', () => {
        expect(handler).toMatch(/bindingType === 'channel' && channelAccountId/);
    });
});

describe('/api/entities response shape', () => {
    const handler = slice("app.get('/api/entities',", 5000);

    it('is async (now does channel_accounts lookup)', () => {
        expect(handler).toMatch(/app\.get\('\/api\/entities',\s*async\s*\(req,\s*res\)\s*=>/);
    });

    it('annotates each bound entity with channelProvider', () => {
        expect(handler).toMatch(/channelProvider:/);
    });

    it('provider lookup is best-effort (logs warn, does not throw)', () => {
        expect(handler).toMatch(/console\.warn\(`\[\/api\/entities\] channel_accounts lookup failed/);
    });
});

describe('/api/entity/lookup response shape (public)', () => {
    // Widened span: the lookup handler now also computes the petdx 夥伴 avatar
    // enrichment (audit P3, card_8512e936d13662c0dc1495bf) before the response,
    // which pushes the response-shape fields further down the function body.
    const handler = slice("app.get('/api/entity/lookup'", 4200);

    it('exposes bindingType (coarse binding class)', () => {
        expect(handler).toMatch(/bindingType:\s*entity\.bindingType/);
    });

    it('does NOT expose channelProvider (fingerprinting)', () => {
        expect(handler).not.toMatch(/channelProvider:/);
    });
});
