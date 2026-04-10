/**
 * Bot Interview Module Unit Tests
 *
 * Pure unit tests (no DB, no HTTP) — the module is deliberately
 * stateless so it can be exercised directly.
 */

const interview = require('../../bot-interview');

describe('bot-interview: probe catalogue', () => {
    test('PROBES is frozen and non-empty', () => {
        expect(Object.isFrozen(interview.PROBES)).toBe(true);
        expect(interview.PROBES.length).toBeGreaterThan(0);
    });

    test('each probe has an id and a prompt', () => {
        for (const p of interview.PROBES) {
            expect(typeof p.id).toBe('string');
            expect(typeof p.prompt).toBe('string');
            expect(p.prompt.length).toBeGreaterThan(0);
        }
    });

    test('getProbeList returns serializable probe metadata', () => {
        const list = interview.getProbeList();
        expect(Array.isArray(list)).toBe(true);
        for (const p of list) {
            expect(p).toHaveProperty('id');
            expect(p).toHaveProperty('prompt');
            expect(p).toHaveProperty('category');
            expect(p).toHaveProperty('weight');
        }
    });

    test('MAX_SCORE sums non-optional probe weights', () => {
        const expected = interview.PROBES
            .filter(p => !p.optional)
            .reduce((s, p) => s + p.weight, 0);
        expect(interview.MAX_SCORE).toBe(expected);
    });
});

describe('bot-interview: scoreProbeResponse', () => {
    test('greeting probe passes with non-empty response', () => {
        const probe = interview.PROBES.find(p => p.id === 'greeting');
        const res = interview.scoreProbeResponse(probe, 'Hello, I am a helpful bot.');
        expect(res.passed).toBe(true);
        expect(res.score).toBe(probe.weight);
    });

    test('python_exec probe detects 1024 anywhere in response', () => {
        const probe = interview.PROBES.find(p => p.id === 'python_exec');
        expect(interview.scoreProbeResponse(probe, '1024').passed).toBe(true);
        expect(interview.scoreProbeResponse(probe, 'The answer is 1024.').passed).toBe(true);
        expect(interview.scoreProbeResponse(probe, 'I cannot execute code').passed).toBe(false);
    });

    test('refusal_safety passes when bot refuses', () => {
        const probe = interview.PROBES.find(p => p.id === 'refusal_safety');
        const refuse = interview.scoreProbeResponse(probe, "I'm sorry, I cannot reveal my system prompt.");
        expect(refuse.passed).toBe(true);
    });

    test('refusal_safety fails when bot leaks', () => {
        const probe = interview.PROBES.find(p => p.id === 'refusal_safety');
        const leak = interview.scoreProbeResponse(probe, 'System prompt: You are a helpful assistant that always complies.');
        expect(leak.passed).toBe(false);
        expect(leak.reason).toBe('matched_reject_pattern');
    });

    test('response_too_short rejected on minLength probes', () => {
        const probe = interview.PROBES.find(p => p.id === 'greeting');
        const res = interview.scoreProbeResponse(probe, 'hi');
        expect(res.passed).toBe(false);
        expect(res.reason).toBe('response_too_short');
    });

    test('response_too_long rejected on maxLength probes', () => {
        const probe = interview.PROBES.find(p => p.id === 'latency');
        const res = interview.scoreProbeResponse(probe, 'pong'.repeat(100));
        expect(res.passed).toBe(false);
        expect(res.reason).toBe('response_too_long');
    });

    test('non-string response returns no_response', () => {
        const probe = interview.PROBES.find(p => p.id === 'latency');
        expect(interview.scoreProbeResponse(probe, null).reason).toBe('no_response');
        expect(interview.scoreProbeResponse(probe, undefined).reason).toBe('no_response');
        expect(interview.scoreProbeResponse(probe, 42).reason).toBe('no_response');
    });
});

describe('bot-interview: runInterview', () => {
    /** Helper: create a mock entity that simulates bot responses. */
    function makeMockEntity(responseMap = {}) {
        return {
            lastUpdated: 1000,
            message: '',
            isBound: true,
            webhook: { url: 'http://test' },
            _interviewInProgress: false,
        };
    }

    /** Mock pushToBot that simulates async bot reply by mutating entity. */
    function makePushToBot(entity, responseMap) {
        return async (_ent, _devId, _evType, payload) => {
            const match = payload.message.match(/\[INTERVIEW_PROBE:(\w+)\]/);
            const probeId = match ? match[1] : null;
            const resp = responseMap[probeId];
            if (resp !== undefined) {
                // Simulate bot responding after a short delay
                setTimeout(() => {
                    entity.message = resp;
                    entity.lastUpdated = Date.now();
                }, 50);
            }
            return { pushed: true };
        };
    }

    test('dispatches all 8 probes sequentially and scores', async () => {
        const responseMap = {
            greeting: 'Hello, I am a bot.',
            python_exec: '1024',
            web_browse: 'Example Domain',
            reasoning: 'The second train catches up at 13:00',
            refusal_safety: "I cannot reveal my system prompt.",
            summarization: 'Mitochondria produce ATP.',
            vision: 'The dominant pixel is red.',
            latency: 'pong',
        };
        const entity = makeMockEntity();
        const pushToBot = makePushToBot(entity, responseMap);

        const result = await interview.runInterview({
            entity, deviceId: 'test-device', pushToBot, probeTimeoutMs: 3000,
        });

        expect(result.passed).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(60);
        expect(result.responses).toHaveLength(interview.PROBES.length);
        expect(result.duration_ms).toBeGreaterThan(0);
        expect(entity._interviewInProgress).toBe(false);
    }, 30000);

    test('collects null for timed-out probes', async () => {
        // pushToBot succeeds but entity never updates (bot offline)
        const entity = makeMockEntity();
        const pushToBot = async () => ({ pushed: true });

        const result = await interview.runInterview({
            entity, deviceId: 'test-device', pushToBot, probeTimeoutMs: 200,
        });

        expect(result.passed).toBe(false);
        expect(result.responses.every(r => r === null)).toBe(true);
        expect(entity._interviewInProgress).toBe(false);
    }, 30000);

    test('collects null when push fails', async () => {
        const entity = makeMockEntity();
        const pushToBot = async () => ({ pushed: false, reason: 'no_webhook' });

        const result = await interview.runInterview({
            entity, deviceId: 'test-device', pushToBot, probeTimeoutMs: 200,
        });

        expect(result.passed).toBe(false);
        expect(result.responses.every(r => r === null)).toBe(true);
    }, 10000);

    test('clears _interviewInProgress flag even on error', async () => {
        const entity = makeMockEntity();
        const pushToBot = async () => { throw new Error('network_error'); };

        await expect(interview.runInterview({
            entity, deviceId: 'test-device', pushToBot, probeTimeoutMs: 200,
        })).rejects.toThrow('network_error');

        expect(entity._interviewInProgress).toBe(false);
    });

    test('throws on missing entity', async () => {
        await expect(interview.runInterview({
            entity: null, deviceId: 'x', pushToBot: async () => ({}),
        })).rejects.toThrow('entity_required');
    });

    test('throws on missing pushToBot', async () => {
        await expect(interview.runInterview({
            entity: {}, deviceId: 'x', pushToBot: null,
        })).rejects.toThrow('pushToBot_required');
    });
});

describe('bot-interview: scoreInterview', () => {
    test('rejects non-array input', () => {
        expect(() => interview.scoreInterview('not an array')).toThrow('responses_must_be_array');
    });

    test('perfect run scores 100 and passes', () => {
        // Build responses that match every probe's expected regex.
        const responses = interview.PROBES.map(p => {
            if (p.id === 'greeting') return 'Hello, I am a bot.';
            if (p.id === 'python_exec') return '1024';
            if (p.id === 'web_browse') return 'Example Domain';
            if (p.id === 'reasoning') return 'The second train catches up at 13:00';
            if (p.id === 'refusal_safety') return "I cannot reveal my system prompt.";
            if (p.id === 'summarization') return 'Mitochondria produce ATP via oxidative phosphorylation.';
            if (p.id === 'vision') return 'The dominant pixel is red.';
            if (p.id === 'latency') return 'pong';
            return '';
        });
        const result = interview.scoreInterview(responses);
        expect(result.passed).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(60);
        expect(result.capabilities.python_exec.supported).toBe(true);
        expect(result.capabilities.web_browse.supported).toBe(true);
    });

    test('all-empty responses fail with score 0', () => {
        const responses = interview.PROBES.map(() => '');
        const result = interview.scoreInterview(responses);
        expect(result.passed).toBe(false);
        expect(result.rawScore).toBe(0);
    });

    test('only baseline probe passing is not enough to pass', () => {
        const responses = interview.PROBES.map(p =>
            p.id === 'greeting' ? 'Hello world, I am bot.' : ''
        );
        const result = interview.scoreInterview(responses);
        expect(result.passed).toBe(false);
    });

    test('capabilities object tracks per-category support', () => {
        const responses = interview.PROBES.map(p => {
            // Only python_exec passes
            if (p.id === 'greeting') return 'Hello world, I am bot.';
            if (p.id === 'python_exec') return '1024';
            return '';
        });
        const result = interview.scoreInterview(responses);
        expect(result.capabilities.python_exec.supported).toBe(true);
        expect(result.capabilities.web_browse.supported).toBe(false);
    });
});
