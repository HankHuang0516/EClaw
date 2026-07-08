/**
 * Resize Grip Guard — static analysis (Jest)
 * card_c44c318865d2aa77376e9746
 *
 * Guards the reusable drag-to-resize "拉桿" helper + its first consumer (the
 * 需要你 action-request reply textarea) + the settings toggle that gates it.
 *
 * Written to FAIL on old code (per feedback_every_gap_needs_testcase_or_ci):
 * before this feature, shared/resize-grip.js does not exist, chat.html does not
 * wire EclawResizeGrip onto .reply-preview-chip-answer, and device-preferences.js
 * has no action_request_reply_resize_enabled key.
 */

const fs = require('fs');
const path = require('path');

const PORTAL_DIR = path.resolve(__dirname, '../../public/portal');
const RESIZE_GRIP_JS = path.join(PORTAL_DIR, 'shared/resize-grip.js');
const STYLE_CSS = path.join(PORTAL_DIR, 'shared/style.css');
const CHAT_HTML = path.join(PORTAL_DIR, 'chat.html');
const SETTINGS_HTML = path.join(PORTAL_DIR, 'settings.html');
const DEVICE_PREFS = path.resolve(__dirname, '../../device-preferences.js');
const SETTINGS_MANIFEST = path.resolve(__dirname, '../../lib/settings-manifest.js');
const I18N_JS = path.resolve(__dirname, '../../public/shared/i18n.js');

const read = (p) => fs.readFileSync(p, 'utf-8');

describe('resize-grip helper (shared/resize-grip.js)', () => {
    let code;
    beforeAll(() => { code = read(RESIZE_GRIP_JS); });

    test('exists and exports window.EclawResizeGrip.attach', () => {
        expect(fs.existsSync(RESIZE_GRIP_JS)).toBe(true);
        expect(code).toMatch(/window\.EclawResizeGrip\s*=/);
        expect(code).toMatch(/attach/);
        expect(code).toMatch(/function attach\s*\(/);
    });

    test('has a size clamp with viewport awareness', () => {
        expect(code).toMatch(/function clampSize/);
        expect(code).toMatch(/window\.innerHeight/);
        expect(code).toMatch(/window\.innerWidth/);
    });

    test('supports pointer drag (pointerdown/move/up/cancel)', () => {
        expect(code).toMatch(/pointerdown/);
        expect(code).toMatch(/pointermove/);
        expect(code).toMatch(/pointerup/);
        expect(code).toMatch(/pointercancel/);
    });

    test('supports keyboard resize (Arrow keys + Shift bigger step)', () => {
        expect(code).toMatch(/keydown/);
        expect(code).toMatch(/ArrowUp/);
        expect(code).toMatch(/ArrowDown/);
        expect(code).toMatch(/shiftKey/);
    });

    test('persists per-key to a namespaced localStorage object', () => {
        expect(code).toMatch(/eclaw_resize_grip_state_v1/);
        expect(code).toMatch(/localStorage\.setItem/);
        expect(code).toMatch(/localStorage\.getItem/);
        expect(code).toMatch(/storageKey/);
    });

    test('respects an enabled flag (no-op when disabled)', () => {
        expect(code).toMatch(/getEnabled/);
    });

    test('grip has a11y attributes (separator role, orientation, label, tabindex)', () => {
        expect(code).toMatch(/setAttribute\(\s*'role'\s*,\s*'separator'\s*\)/);
        expect(code).toMatch(/aria-orientation/);
        expect(code).toMatch(/aria-label/);
        expect(code).toMatch(/tabindex/);
    });

    test('does NOT reach into ai-chat.js internals (standalone helper)', () => {
        // The helper must not couple to the AI-chat panel; a future PR dedupes.
        expect(code).not.toMatch(/aiChatPanel/);
        expect(code).not.toMatch(/ai-chat-panel/);
    });
});

describe('resize-grip CSS (shared/style.css)', () => {
    let css;
    beforeAll(() => { css = read(STYLE_CSS); });

    test('defines .eclaw-resize-grip affordance + disabled + focus a11y', () => {
        expect(css).toMatch(/\.eclaw-resize-grip\s*\{/);
        expect(css).toMatch(/\.eclaw-resize-grip-disabled\s*\{\s*display:\s*none/);
        expect(css).toMatch(/\.eclaw-resize-grip:focus-visible/);
        expect(css).toMatch(/touch-action:\s*none/);
    });
});

describe('chat.html wires the grip onto the reply input, gated by the pref', () => {
    let html;
    beforeAll(() => { html = read(CHAT_HTML); });

    test('loads shared/resize-grip.js', () => {
        expect(html).toMatch(/<script src="shared\/resize-grip\.js"><\/script>/);
    });

    test('reads action_request_reply_resize_enabled into a module flag (DEFAULT-ON)', () => {
        expect(html).toMatch(/let actionRequestReplyResizeEnabled\s*=\s*true/);
        expect(html).toMatch(/prefs\.action_request_reply_resize_enabled\s*!==\s*false/);
    });

    test('renderReplyPreviews attaches EclawResizeGrip on .reply-preview-chip-answer, gated', () => {
        // The wiring must be inside the renderReplyPreviews path where the answer
        // textarea is created; assert the gate + attach + target height storageKey.
        expect(html).toMatch(/reply-preview-chip-answer/);
        expect(html).toMatch(/if\s*\(actionRequestReplyResizeEnabled\s*&&\s*window\.EclawResizeGrip/);
        expect(html).toMatch(/window\.EclawResizeGrip\.attach\(/);
        expect(html).toMatch(/storageKey:\s*'ar-reply'/);
        expect(html).toMatch(/getEnabled:\s*\(\)\s*=>\s*actionRequestReplyResizeEnabled/);
    });
});

describe('settings.html surfaces the toggle', () => {
    let html;
    beforeAll(() => { html = read(SETTINGS_HTML); });

    test('has the toggle switch + save/apply wiring', () => {
        expect(html).toMatch(/id="toggleActionRequestReplyResize"/);
        expect(html).toMatch(/saveActionRequestReplyResizePref\(this\.checked\)/);
        expect(html).toMatch(/action_request_reply_resize_enabled:\s*!!enabled/);
        expect(html).toMatch(/prefs\.action_request_reply_resize_enabled\s*!==\s*false/);
    });

    test('has an i18n label key', () => {
        expect(html).toMatch(/action_request_reply_resize_label/);
    });
});

describe('device-preferences.js registers the pref (DEFAULT-ON + string-safe coercion)', () => {
    let code;
    beforeAll(() => { code = read(DEVICE_PREFS); });

    test('DEFAULTS has action_request_reply_resize_enabled: true', () => {
        expect(code).toMatch(/action_request_reply_resize_enabled:\s*true/);
    });

    test('coerceValue includes the key in the string-safe boolean branch', () => {
        // It must ride the `raw === true || raw === 'true'` branch so an explicit
        // string 'false' stays false (not coerced true by a bare !!raw).
        expect(code).toMatch(/key === 'action_request_reply_resize_enabled'/);
        expect(code).toMatch(/return raw === true \|\| raw === 'true'/);
    });

    // Behavioral: an explicit false / 'false' disables; unset defaults to true.
    test('coercion + defaults behave DEFAULT-ON', () => {
        const mod = require(DEVICE_PREFS);
        expect(mod.DEFAULTS.action_request_reply_resize_enabled).toBe(true);
    });
});

describe('settings-manifest.js declares the field', () => {
    test('action_requests feature has the boolean/switch field', () => {
        const mod = require(SETTINGS_MANIFEST);
        const src = read(SETTINGS_MANIFEST);
        expect(src).toMatch(/action_request_reply_resize_enabled/);
        expect(src).toMatch(/action_request_reply_resize_label/);
        // sanity: manifest builds and the field is present under action_requests
        const manifest = mod.buildSettingsManifest ? mod.buildSettingsManifest('99.0.0', 'android') : null;
        expect(manifest).toBeTruthy();
        expect(Array.isArray(manifest.features)).toBe(true);
        const ar = manifest.features.find((f) => f.key === 'action_requests');
        expect(ar).toBeTruthy();
        const fields = (ar && ar.schema && ar.schema.fields) || [];
        expect(fields.some((f) => f.key === 'action_request_reply_resize_enabled')).toBe(true);
    });
});

describe('i18n has EN + ZH label/desc/help for the pref', () => {
    let code;
    beforeAll(() => { code = read(I18N_JS); });
    test('EN + ZH label present', () => {
        expect(code).toMatch(/"action_request_reply_resize_label":\s*"Resizable reply box"/);
        expect(code).toMatch(/"action_request_reply_resize_label":\s*"需要你回覆框可拉桿調整大小"/);
        expect(code).toMatch(/"action_request_reply_resize_help":/);
    });
});
