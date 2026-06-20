/**
 * Regression: Arena namecard capability badges must read the per-capability map,
 * not the numeric identity.interviewCapabilities score block.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEditor() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'agent-card-editor.js'),
        'utf8'
    );
    const ctx = {
        window: { AgentCardEditor: null },
        document: {
            createElement: () => ({ textContent: '', innerHTML: '' }),
            getElementById: () => null,
        },
        apiCall: async () => ({}),
        showToast: () => {},
        console: { error: () => {}, log: () => {}, warn: () => {} },
        Math, Date, JSON, encodeURIComponent, decodeURIComponent,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'agent-card-editor.js' });
    return ctx.window.AgentCardEditor;
}

describe('AgentCardEditor Arena capability selection', () => {
    const AgentCardEditor = loadEditor();
    const capMap = {
        reasoning: { supported: true, probes: [{ id: 'arena_memory', score: 10, maxScore: 10 }] },
    };

    test('uses agentCard/identity.public capabilities over numeric score block', () => {
        const selected = AgentCardEditor._selectArenaCapabilities(
            {
                interviewCapabilities: {
                    score: 142,
                    maxScore: 147,
                    normalized: 97,
                    passed: true,
                    source: 'arena',
                },
                public: { capabilities: capMap },
            },
            { capabilities: capMap }
        );
        expect(selected).toBe(capMap);
    });

    test('does not treat identity.interviewCapabilities numeric score as badge map', () => {
        const selected = AgentCardEditor._selectArenaCapabilities(
            { interviewCapabilities: { score: 142, maxScore: 147, normalized: 97, passed: true } },
            {}
        );
        expect(selected).toBeNull();
    });
});
