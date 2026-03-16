/**
 * Regression test for Issue #221:
 * AI customer support should force a conclusion at step 14 (avoid exceeding step limit).
 *
 * Tests the anthropic-client module's agentic loop convergence logic.
 */

// Mock fetch before requiring the module
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set required env
process.env.ANTHROPIC_API_KEY = 'test-key-for-jest';

const path = require('path');

// We need to test the module's exported functions
let chatWithClaude;

beforeAll(() => {
    // Clear module cache to pick up our mock
    delete require.cache[require.resolve('../../anthropic-client')];
    const client = require('../../anthropic-client');
    chatWithClaude = client.chatWithClaude;
});

afterEach(() => {
    mockFetch.mockReset();
});

describe('Issue #221: AI chat step limit and forced convergence', () => {
    test('single-turn response returns immediately without looping', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'Hello! How can I help?' }],
                stop_reason: 'end_turn'
            })
        });

        const result = await chatWithClaude({
            message: 'Hi',
            history: []
        });

        expect(result.response).toBe('Hello! How can I help?');
        expect(result.actions).toBeNull();
        // Only 1 API call (no looping)
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('tool_use triggers agentic loop and returns after tool acknowledgment', async () => {
        // First call: model requests tool use
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [
                    { type: 'text', text: 'I\'ll create an issue for you.' },
                    {
                        type: 'tool_use',
                        id: 'toolu_123',
                        name: 'create_github_issue',
                        input: { title: 'Bug report', body: 'Something is broken', labels: ['bug'] }
                    }
                ],
                stop_reason: 'tool_use'
            })
        });

        // Second call: model provides final text
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'I\'ve created the issue for you.' }],
                stop_reason: 'end_turn'
            })
        });

        const result = await chatWithClaude({
            message: 'Report a bug: app crashes on startup',
            history: []
        });

        expect(result.response).toBe('I\'ve created the issue for you.');
        expect(result.actions).toEqual([{
            type: 'create_issue',
            title: 'Bug report',
            body: 'Something is broken',
            labels: ['bug']
        }]);
        // 2 API calls: initial + after tool result
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('convergence instruction injected at step 14', async () => {
        // Simulate a model that keeps requesting tool_use for 13 steps
        for (let i = 0; i < 13; i++) {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    content: [
                        { type: 'tool_use', id: `toolu_${i}`, name: 'create_github_issue',
                          input: { title: `Issue ${i}`, body: 'test', labels: ['bug'] } }
                    ],
                    stop_reason: 'tool_use'
                })
            });
        }

        // Step 14 (convergence): model should get no tools and forced conclusion instruction
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'Here is my summary based on analysis so far.' }],
                stop_reason: 'end_turn'
            })
        });

        const result = await chatWithClaude({
            message: 'Complex analysis request',
            history: []
        });

        expect(result.response).toBe('Here is my summary based on analysis so far.');

        // Step 14 call should have no tools (forcing conclusion)
        const step14Call = mockFetch.mock.calls[13];
        const step14Body = JSON.parse(step14Call[1].body);
        expect(step14Body.tools).toBeUndefined(); // empty tools array omitted by callAnthropic
        expect(step14Body.system).toContain('You MUST provide your final answer NOW');
    });

    test('max steps exceeded returns fallback message', async () => {
        // Simulate 15 consecutive tool_use responses (should not happen with convergence, but safety net)
        for (let i = 0; i < 15; i++) {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    content: [
                        { type: 'tool_use', id: `toolu_${i}`, name: 'create_github_issue',
                          input: { title: `Issue ${i}`, body: 'test', labels: ['bug'] } }
                    ],
                    stop_reason: 'tool_use'
                })
            });
        }

        const result = await chatWithClaude({
            message: 'Very complex question',
            history: []
        });

        // Should return a graceful fallback, not an error
        expect(result.response).toContain('complexity limits');
        expect(result.actions).not.toBeNull();
        expect(result.actions.length).toBe(15);
    });
});
