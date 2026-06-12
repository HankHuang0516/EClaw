/**
 * Flow drivers for the cross-surface E2E matrix (card_42ffca0d29ce22b369d55ca4).
 *
 * Each driver: async (page, { base, platform }) => { ok: boolean, detail: string }.
 * A driver verifies ONE canonical flow on the live target. Keep them auth-light
 * where possible (public surfaces) so the baseline runs without seeded secrets;
 * auth-bound flows document what they need.
 *
 * Implemented: redirect (self-contained, public /r/ entry).
 * Pending (intentionally absent → runner reports `pending`, never silent-pass):
 *   login_refresh, message_send, kanban_lifecycle, agent_reply_visibility.
 * Add each as its own slice; flip run-matrix.js's gate to fatal-on-pending once
 * all five exist.
 */
'use strict';

const DRIVERS = {
    // pain 1+5: /r/:target universal entry 302s to the registry web URL with traceId.
    // profile is a non-sensitive target (/p/{publicCode}), so no HMAC sig needed.
    redirect: async (page, { base }) => {
        const publicCode = process.env.MATRIX_REDIRECT_CODE || 'tbwb9e'; // #1 Mac_F public profile
        const entry = `${base}/r/profile?publicCode=${publicCode}`;
        const resp = await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const finalUrl = page.url();
        const landed = finalUrl.includes(`/p/${publicCode}`);
        const status = resp ? resp.status() : 0;
        return {
            ok: landed && status < 400,
            detail: `entry=/r/profile?publicCode=${publicCode} → ${finalUrl} (status ${status})`,
        };
    },
};

module.exports = { DRIVERS };
