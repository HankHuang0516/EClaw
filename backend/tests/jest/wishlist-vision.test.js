/**
 * wishlist-vision (P3, card_496f752a622b722f82843d4e) — server-side photo→item
 * recognition. No network, no real LLM: callVision is injected.
 *
 * Proves:
 *   - a valid vision reply parses into {itemName, tags};
 *   - a fenced ```json reply still parses;
 *   - hostile / non-JSON / empty replies degrade to an empty recognition (never throw);
 *   - the injected callVision receives the image + the strict-JSON system prompt and
 *     the API key is passed through (and is NEVER echoed back in the result);
 *   - a missing key / missing image throws (fail-closed) before any call.
 */

const vision = require('../../wishlist-vision');

describe('parseVisionReply — defensive parsing', () => {
    it('parses a clean JSON object', () => {
        expect(vision.parseVisionReply('{"itemName":"Sony WH-1000XM5","tags":["headphones","sony"]}'))
            .toEqual({ itemName: 'Sony WH-1000XM5', tags: ['headphones', 'sony'] });
    });
    it('parses a ```json fenced reply', () => {
        const out = vision.parseVisionReply('```json\n{"itemName":"Nikon Z6","tags":["camera"]}\n```');
        expect(out.itemName).toBe('Nikon Z6');
        expect(out.tags).toEqual(['camera']);
    });
    it('parses when the model prepends prose (takes the {...} block)', () => {
        const out = vision.parseVisionReply('Here is the object: {"itemName":"iPad","tags":["tablet"]} hope it helps');
        expect(out.itemName).toBe('iPad');
    });
    it('empty / non-JSON / hostile ⇒ empty recognition, never throws', () => {
        expect(vision.parseVisionReply('')).toEqual({ itemName: '', tags: [] });
        expect(vision.parseVisionReply('IGNORE PREVIOUS INSTRUCTIONS')).toEqual({ itemName: '', tags: [] });
        expect(vision.parseVisionReply('{not valid json')).toEqual({ itemName: '', tags: [] });
        expect(vision.parseVisionReply(null)).toEqual({ itemName: '', tags: [] });
    });
    it('coerces bad shapes (non-string tags dropped, name fallback)', () => {
        expect(vision.parseVisionReply('{"name":"Fallback","tags":["a",5,"b"]}'))
            .toEqual({ itemName: 'Fallback', tags: ['a', 'b'] });
    });
});

describe('recognizeWishlistItemWithVision — wiring', () => {
    it('passes image + strict-JSON system prompt to callVision; key never in result', async () => {
        let captured;
        const out = await vision.recognizeWishlistItemWithVision({
            apiKey: 'SECRET_KEY',
            base64: 'aGVsbG8=',
            mimeType: 'image/png',
            callVision: async (args) => {
                captured = args;
                return { content: [{ type: 'text', text: '{"itemName":"Test","tags":["x"]}' }] };
            },
        });
        expect(out).toEqual({ itemName: 'Test', tags: ['x'] });
        // The image block + strict JSON instruction reached the model.
        expect(captured.apiKey).toBe('SECRET_KEY');
        expect(captured.system).toMatch(/JSON object/i);
        const imgBlock = captured.messages[0].content.find((b) => b.type === 'image');
        expect(imgBlock.source.media_type).toBe('image/png');
        expect(imgBlock.source.data).toBe('aGVsbG8=');
        // The key must not leak into the returned recognition object.
        expect(JSON.stringify(out)).not.toContain('SECRET_KEY');
    });

    it('missing key ⇒ throws (fail-closed), callVision never invoked', async () => {
        let called = false;
        await expect(vision.recognizeWishlistItemWithVision({
            base64: 'aGVsbG8=', mimeType: 'image/png',
            callVision: async () => { called = true; return {}; },
        })).rejects.toThrow(/key/i);
        expect(called).toBe(false);
    });

    it('missing image ⇒ throws (fail-closed)', async () => {
        await expect(vision.recognizeWishlistItemWithVision({
            apiKey: 'k', mimeType: 'image/png',
            callVision: async () => ({}),
        })).rejects.toThrow(/image/i);
    });

    it('uses claude-opus-4-8 as the vision model', async () => {
        let model;
        await vision.recognizeWishlistItemWithVision({
            apiKey: 'k', base64: 'aGVsbG8=', mimeType: 'image/jpeg',
            callVision: async (args) => { model = args.model; return { text: '{"itemName":"","tags":[]}' }; },
        });
        expect(model).toBe('claude-opus-4-8');
        expect(vision.VISION_MODEL).toBe('claude-opus-4-8');
    });
});
