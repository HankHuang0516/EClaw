/**
 * SI stream D — agent-card-editor _renderInterviewError unit test.
 * card_7fc8e7abc3cb546e89721a26.
 *
 * Verifies that the friendly error renderer:
 *  - shows a localized message + reference code instead of raw server tokens
 *  - logs the raw token to console.error so DevTools still has it
 *  - tolerates missing statusEl (no-op, no throw)
 *
 * Uses jsdom-style stubs — no real DOM needed for this scoped test.
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
    // Minimal DOM-ish surface for the renderer to write into.
    const fakeEl = (tag) => ({
        tag, style: {}, textContent: '', children: [],
        appendChild(c) { this.children.push(c); },
    });
    const ctx = {
        window: {
            AgentCardEditor: null,
        },
        document: {
            createElement: (tag) => fakeEl(tag),
            getElementById: () => null,
        },
        // i18n fallback wrapper used by the editor.
        t: (_k, fallback) => fallback,
        // apiCall stub — not exercised in this test.
        apiCall: async () => ({}),
        showToast: () => {},
        console: {
            calls: [],
            error: function(msg) { this.calls.push(['error', msg]); },
            log: () => {},
            warn: () => {},
        },
        Math, Date, JSON, encodeURIComponent, decodeURIComponent,
    };
    ctx.window.console = ctx.console;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'agent-card-editor.js' });
    return ctx;
}

describe('AgentCardEditor._renderInterviewError (card_7fc8e7ab — SI stream D)', () => {
    const ctx = loadEditor();
    const AgentCardEditor = ctx.window.AgentCardEditor;

    test('module loaded and renderer exists on prototype', () => {
        expect(typeof AgentCardEditor).toBe('function');
        expect(typeof AgentCardEditor.prototype._renderInterviewError).toBe('function');
    });

    test('renders friendly message + reference code, swallows raw server token', () => {
        const statusEl = ctx.document.createElement('span');
        // Renderer is invoked as a prototype method but only touches `statusEl`.
        AgentCardEditor.prototype._renderInterviewError.call({}, statusEl, 'internal_error');
        const written = statusEl.children[0]?.textContent || '';
        // No raw server token surfaced.
        expect(written.includes('internal_error')).toBe(false);
        // Friendly fallback text from the t() stub.
        expect(written).toMatch(/Interview could not start/);
        // A reference code was substituted into the %s slot.
        expect(written).toMatch(/[0-9a-f]{8}/);
    });

    test('raw error is preserved in console.error for DevTools traceability', () => {
        ctx.console.calls.length = 0;
        const statusEl = ctx.document.createElement('span');
        AgentCardEditor.prototype._renderInterviewError.call({}, statusEl, 'duplicate_listing');
        const logged = ctx.console.calls.map(c => c.join(' ')).join('\n');
        expect(logged).toMatch(/\[interview\] error_id=[0-9a-f]+ raw=duplicate_listing/);
    });

    test('no statusEl → no-op, no throw', () => {
        expect(() =>
            AgentCardEditor.prototype._renderInterviewError.call({}, null, 'x')
        ).not.toThrow();
    });
});
