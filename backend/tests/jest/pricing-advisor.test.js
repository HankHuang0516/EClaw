/**
 * Pricing Advisor Module Unit Tests
 *
 * Pure unit tests — the module is stateless and has no I/O.
 */

const advisor = require('../../pricing-advisor');

describe('pricing-advisor: detectFamily', () => {
    test('detects Opus variants', () => {
        expect(advisor.detectFamily('claude-opus-4.6')).toBe('opus');
        expect(advisor.detectFamily('Claude Opus 3')).toBe('opus');
    });

    test('detects Sonnet / Haiku', () => {
        expect(advisor.detectFamily('claude-sonnet-4.5')).toBe('sonnet');
        expect(advisor.detectFamily('Claude Haiku 4.5')).toBe('haiku');
    });

    test('detects GPT-4 family', () => {
        expect(advisor.detectFamily('gpt-4-turbo')).toBe('gpt-4');
        expect(advisor.detectFamily('gpt-4o')).toBe('gpt-4o');
        expect(advisor.detectFamily('gpt-4o-mini')).toBe('gpt-4o-mini');
    });

    test('detects Gemini variants', () => {
        expect(advisor.detectFamily('gemini-1.5-flash')).toBe('gemini-flash');
        expect(advisor.detectFamily('gemini-pro')).toBe('gemini-pro');
    });

    test('falls back to unknown on garbage input', () => {
        expect(advisor.detectFamily('')).toBe('unknown');
        expect(advisor.detectFamily(null)).toBe('unknown');
        expect(advisor.detectFamily('llama3')).toBe('unknown');
    });
});

describe('pricing-advisor: countCapabilities', () => {
    test('counts supported:true entries only', () => {
        const caps = {
            python_exec: { supported: true },
            web_browse: { supported: false },
            vision: { supported: true },
        };
        expect(advisor.countCapabilities(caps)).toBe(2);
    });

    test('handles null / undefined gracefully', () => {
        expect(advisor.countCapabilities(null)).toBe(0);
        expect(advisor.countCapabilities(undefined)).toBe(0);
        expect(advisor.countCapabilities({})).toBe(0);
    });
});

describe('pricing-advisor: suggestRate', () => {
    test('opus + 2 capabilities produces high-confidence suggestion', () => {
        const s = advisor.suggestRate({
            modelName: 'claude-opus-4.6',
            capabilities: {
                python_exec: { supported: true },
                web_browse: { supported: true },
            },
            interviewPassed: true,
        });
        expect(s.family).toBe('opus');
        expect(s.capabilityCount).toBe(2);
        expect(s.confidence).toBe('high');
        // base 10_000 * (1 + 2 * 0.3) = 16_000
        expect(s.suggestedMli).toBe(16_000);
        expect(s.minMli).toBeLessThan(s.suggestedMli);
        expect(s.maxMli).toBeGreaterThan(s.suggestedMli);
    });

    test('unknown family produces low confidence', () => {
        const s = advisor.suggestRate({ modelName: 'custom-model' });
        expect(s.family).toBe('unknown');
        expect(s.confidence).toBe('low');
    });

    test('no capabilities produces base rate exactly', () => {
        const s = advisor.suggestRate({
            modelName: 'claude-haiku-4.5',
            capabilities: {},
            interviewPassed: true,
        });
        expect(s.suggestedMli).toBe(2_000); // haiku base
    });

    test('high confidence uses narrower band (±40%)', () => {
        const high = advisor.suggestRate({
            modelName: 'claude-sonnet-4.5', capabilities: {}, interviewPassed: true,
        });
        const low = advisor.suggestRate({
            modelName: 'custom', capabilities: {}, interviewPassed: false,
        });
        // high band is 40% of suggested, low is 60% → narrower range on high
        const highRange = high.maxMli - high.minMli;
        const lowRange = low.maxMli - low.minMli;
        const highRel = highRange / high.suggestedMli;
        const lowRel = lowRange / low.suggestedMli;
        expect(highRel).toBeLessThan(lowRel);
    });
});

describe('pricing-advisor: classifyRate', () => {
    const suggestion = {
        suggestedMli: 10_000,
        minMli: 6_000,
        maxMli: 14_000,
    };

    test('within min-max is in_range', () => {
        expect(advisor.classifyRate(8_000, suggestion)).toBe('in_range');
        expect(advisor.classifyRate(10_000, suggestion)).toBe('in_range');
    });

    test('just below min is below', () => {
        expect(advisor.classifyRate(5_500, suggestion)).toBe('below');
    });

    test('just above max is above', () => {
        expect(advisor.classifyRate(15_000, suggestion)).toBe('above');
    });

    test('more than 2x suggested is way_above', () => {
        expect(advisor.classifyRate(25_000, suggestion)).toBe('way_above');
    });

    test('less than half suggested is way_below', () => {
        expect(advisor.classifyRate(4_000, suggestion)).toBe('way_below');
    });

    test('handles null suggestion gracefully', () => {
        expect(advisor.classifyRate(5_000, null)).toBe('in_range');
    });
});
