/**
 * card_00f9b4d3: admin.html removeBot must gate its destructive DELETE behind
 * the SHARED destructive-confirm modal (showConfirm, shared/api.js).
 *
 * Before: removeBot() fired apiCall('DELETE', /api/admin/official-bot/…)
 * unconditionally — the confirm lived only in a separate bespoke overlay
 * (confirmRemoveBot), so removeBot itself (a global inline-onclick handler)
 * was a one-call data-loss path, and the weekly audit rule
 * operability-destructive-no-confirm re-flagged admin.html every week.
 *
 * This EXECUTES the real removeBot() extracted from admin.html (same
 * new Function harness as mission-single-delete-undo.test.js) and pins:
 *   - the DELETE does NOT fire until showConfirm resolves true (FAIL-ON-OLD)
 *   - showConfirm is the shared destructive family (danger:true + itemName)
 *   - assigned bots delete with ?force=true, unassigned without
 *   - the audit rule is quiet on the REAL admin.html (FAIL-ON-OLD: fired)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'admin.html'), 'utf8'
);

function extractFunction(name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const m = re.exec(html);
    if (!m) throw new Error(`function ${name} not found in admin.html`);
    let depth = 1, i = m.index + m[0].length;
    while (i < html.length && depth > 0) {
        const ch = html[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return html.slice(m.index, i);
}

function makeHarness({ confirm = true, apiError = null } = {}) {
    const showConfirm = jest.fn(async () => confirm);
    const apiCall = jest.fn(async (method, url) => {
        if (apiError) throw apiError;
        if (method === 'GET') return { bots: [] };
        return { success: true };
    });
    const showToast = jest.fn();
    const render = jest.fn();
    const i18n = { t: (k) => k };
    const btnEl = { disabled: false, textContent: 'remove', closest: () => null };

    const factory = new Function(
        'showConfirm', 'apiCall', 'showToast', 'render', 'i18n', 'botsData',
        `${extractFunction('removeBot')}\n return removeBot;`
    );
    const removeBot = factory(showConfirm, apiCall, showToast, render, i18n, null);
    return { removeBot, showConfirm, apiCall, showToast, render, btnEl };
}

describe('admin removeBot — destructive confirm gate (card_00f9b4d3)', () => {
    it('does NOT fire the DELETE when the confirm is cancelled (FAIL-ON-OLD: DELETE fired with no confirm at all)', async () => {
        const h = makeHarness({ confirm: false });
        await h.removeBot('bot-123', 'assigned', h.btnEl);
        expect(h.apiCall).not.toHaveBeenCalled();          // FAIL-ON-OLD: was called unconditionally
        expect(h.showConfirm).toHaveBeenCalledTimes(1);    // FAIL-ON-OLD: never referenced
        expect(h.btnEl.disabled).toBe(false);              // cancel leaves the row button usable
    });

    it('asks via the SHARED destructive modal: danger:true and itemName names the bot', async () => {
        const h = makeHarness({ confirm: true });
        await h.removeBot('bot-123', 'available', h.btnEl);
        expect(h.showConfirm).toHaveBeenCalledWith(expect.objectContaining({
            danger: true,
            itemName: 'bot-123',
        }));
    });

    it('fires the DELETE with ?force=true for an ASSIGNED bot only after confirm resolves true', async () => {
        const h = makeHarness({ confirm: true });
        await h.removeBot('bot 123', 'assigned', h.btnEl);
        expect(h.apiCall).toHaveBeenCalledWith(
            'DELETE', '/api/admin/official-bot/' + encodeURIComponent('bot 123') + '?force=true'
        );
        expect(h.showToast).toHaveBeenCalledWith('admin_msg_bot_removed', 'success');
        expect(h.render).toHaveBeenCalled();
    });

    it('fires the DELETE WITHOUT force for an unassigned bot', async () => {
        const h = makeHarness({ confirm: true });
        await h.removeBot('bot-9', 'available', h.btnEl);
        expect(h.apiCall).toHaveBeenCalledWith('DELETE', '/api/admin/official-bot/bot-9');
    });

    it('API failure surfaces an error toast and re-enables the row button', async () => {
        const h = makeHarness({ confirm: true, apiError: new Error('boom') });
        await h.removeBot('bot-9', 'available', h.btnEl);
        expect(h.showToast).toHaveBeenCalledWith('boom', 'error');
        expect(h.btnEl.disabled).toBe(false);
        expect(h.btnEl.textContent).toBe('admin_btn_remove_bot');
    });

    it('audit rule operability-destructive-no-confirm is QUIET on the real admin.html (FAIL-ON-OLD: fired at removeBot)', () => {
        const audit = require('../../agent-improvement/audit-rules');
        const findings = audit
            .scanText('backend/public/portal/admin.html', html)
            .filter((r) => r.ruleId === 'operability-destructive-no-confirm');
        expect(findings).toEqual([]);
    });
});
