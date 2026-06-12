/**
 * Cross-surface E2E matrix definition — OODA-R Phase 3 #8
 * (card_42ffca0d29ce22b369d55ca4, parent card_be59aa03 roadmap).
 *
 * Pure data: 5 canonical flows × 3 platforms. The runner (run-matrix.js)
 * resolves each flow key to a driver function; this file is the single
 * source of truth CI and humans read to know what the gate covers.
 */
'use strict';

const PLATFORMS = [
    {
        key: 'desktop',
        viewport: { width: 1366, height: 900 },
        userAgent: undefined, // playwright default desktop chrome
    },
    {
        key: 'mobile',
        viewport: { width: 390, height: 844 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
    {
        key: 'webview',
        viewport: { width: 390, height: 844 },
        // EClawAndroid token flips the portal into app-webview mode
        // (body.app-webview CSS + isAndroidWebView JS branches).
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 EClawAndroid/1.0.88',
    },
];

const FLOWS = [
    {
        key: 'login_refresh',
        title: 'Login bounce carries reason + return_to; post-login lands back',
        // pain 4 chain: api.js 401 → index.html?authReason&return_to → redirectAfterAuth honors allowlist
    },
    {
        key: 'redirect',
        title: '/r/ universal entry 302s to the registry target with traceId (real router)',
        // pain 1+5 chain: redirect-router mounted for real in the matrix server
    },
    {
        key: 'message_send',
        title: 'Chat send shows optimistic sending bubble online; queues offline',
        // card_751 outbox + 情緒價值 #2 sending state
    },
    {
        key: 'kanban_lifecycle',
        title: 'Kanban card moves todo→in_progress→done optimistically with undo toast',
        // 情緒價值 #2 optimistic move path
    },
    {
        key: 'agent_reply_visibility',
        title: 'Bot reply in chat history renders as a visible bubble with sender identity',
    },
];

module.exports = { PLATFORMS, FLOWS };
