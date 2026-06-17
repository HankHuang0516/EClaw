/**
 * settings-manifest.js — Auto-sync seam between the EClaw web Settings page and
 * the native mobile apps (Android / iOS).
 *
 * The EClaw mobile app is HYBRID: some Settings features are implemented
 * natively, others are WebView-embedded portal pages. Today there is NO
 * machine-readable description of "which settings features exist and how each
 * app should surface them", so the native half drifts from the web half
 * whenever a new web-only feature ships.
 *
 * This module is the Stage-1 backend seam. `buildSettingsManifest(appVersion,
 * platform)` returns a pure, device-/locale-agnostic (Globe-user) descriptor of
 * every Settings feature. An app queries GET /api/settings-manifest at launch
 * and, for each enabled feature, surfaces an entry:
 *   - native: true   → app renders its native screen for that feature
 *   - native: false  → app opens `webFallback` in a WebView
 *   - native:"partial" → app renders native UI but links out to `webFallback`
 *                        for the missing sub-features
 * The decision is gated by `minAppVersion`: if the running app is OLDER than the
 * version that shipped native support, the manifest downgrades that feature to
 * native:false + webFallback so an old binary still surfaces the feature
 * (via WebView) with ZERO rebuild.
 *
 * CONTRACT: a NEW settings feature only needs (a) a section in the web
 * settings.html + (b) one entry in FEATURES below. The app then surfaces it
 * automatically (native if its version qualifies, else WebView fallback) with
 * no app store release.
 *
 * Stage 2 (apps consume this manifest — needs a build) and Stage 3 (full
 * dynamic schema registry incl. field-level declarations) are follow-ups.
 *
 * Pure function: no I/O, no globals, no device/entity/locale hardcoding.
 */

'use strict';

const PORTAL_SETTINGS_BASE = 'https://eclawbot.com/portal/settings.html';

// Build the focus-deep-link form of the web Settings page. `?focus=<key>` tells
// the portal to scroll to / highlight that feature's section.
function portalFocus(key) {
    return `${PORTAL_SETTINGS_BASE}?focus=${encodeURIComponent(key)}`;
}

/**
 * Canonical declaration of every Settings feature.
 *
 * Per-platform native support is expressed as:
 *   native: { android: <support>, ios: <support> }
 * where <support> is one of:
 *   - true        : implemented natively
 *   - "partial"   : partial native UI, rest via webFallback
 *   - false       : no native UI, always WebView
 * `minAppVersion.android` / `.ios` is the FIRST app version that ships the
 * declared native support. If the running app is older, the feature is
 * downgraded to native:false + webFallback at resolve time.
 *
 * Support levels (native: false) that have no per-version gate use
 * minAppVersion "0.0.0" (always "below" any real app version's native, i.e.
 * never natively available — they live on the web).
 *
 * Drift list (from the 2026-06 settings audit) is reflected here:
 *   HIGH: rotate_secret, switch_device — missing from BOTH apps → native:false
 *   MED : rental_management (full UI web-only), agent_policy (web-only),
 *         channel_api (Android read-only → "partial"), notifications
 *         (iOS fewer categories → "partial").
 */
const FEATURES = [
    {
        key: 'account_identity',
        name: 'Account & Identity',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'channel_api',
        name: 'Channel API',
        enabled: true,
        // Android settings screen is read-only for channel API (MED drift);
        // iOS has the full native editor.
        native: { android: 'partial', ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'subscription',
        name: 'Subscription',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'invite',
        name: 'Invite & Rewards',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'language',
        name: 'Language',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'display',
        name: 'Display',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'chat_prefs',
        name: 'Chat Preferences',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'rental_management',
        name: 'Rental Management',
        enabled: true,
        // Full rental-management UI is web-only on both apps (MED drift).
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
    },
    {
        key: 'notifications',
        name: 'Notifications',
        enabled: true,
        // iOS exposes fewer notification categories natively (MED drift) →
        // "partial"; Android has the full set.
        native: { android: true, ios: 'partial' },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'developer_broadcast',
        name: 'Developer Broadcast',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'agent_policy',
        name: 'Agent Policy',
        enabled: true,
        // Agent policy editor is web-only on both apps (MED drift).
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
    },
    {
        key: 'kanban_nudge',
        name: 'Kanban Nudge',
        enabled: true,
        // Web-only configuration surface today.
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
    },
    {
        key: 'passive_health',
        name: 'Passive Health-Check',
        enabled: true,
        // Web-only today: settings.html section wired to /api/passive-health.
        // native:false → app surfaces it via WebView focus=passive_health until a
        // native screen ships (card_a346b317920f6daf017c83e7).
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
    },
    {
        key: 'wallet',
        name: 'Wallet',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'my_rentals',
        name: 'My Rentals',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'files',
        name: 'Files',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'companion_petdx',
        name: 'Companion (PetDX)',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'feedback',
        name: 'Feedback & Support',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
    {
        key: 'rotate_secret',
        name: 'Rotate Secret',
        enabled: true,
        // HIGH drift: missing from BOTH native apps → web fallback only.
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
    },
    {
        key: 'switch_device',
        name: 'Switch Device',
        enabled: true,
        // HIGH drift: missing from BOTH native apps → web fallback only.
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
    },
    {
        key: 'logout',
        name: 'Logout',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
    },
];

const SUPPORTED_PLATFORMS = ['android', 'ios'];

// Self-contained semver-ish comparison (mirrors index.js compareVersions but
// keeps this module dependency-free and pure). Returns -1 / 0 / 1.
function compareVersions(v1, v2) {
    const a = String(v1).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(v2).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const p1 = a[i] || 0;
        const p2 = b[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }
    return 0;
}

/**
 * Resolve the per-platform native support for one feature against the running
 * app version, applying the minAppVersion gate.
 *
 * @returns {true|"partial"|false}
 */
function resolveNative(feature, appVersion, platform) {
    const declared = feature.native[platform];
    if (declared === false || declared === undefined) return false;

    const minVer = (feature.minAppVersion && feature.minAppVersion[platform]) || '0.0.0';
    // If no version supplied, assume the latest-capable app (show native as
    // declared). Manifest consumers always send appVersion in practice.
    if (!appVersion) return declared;

    // Older than the version that shipped this native support → downgrade to
    // web fallback so the old binary still surfaces the feature.
    if (compareVersions(appVersion, minVer) < 0) return false;
    return declared;
}

/**
 * Build the settings manifest for a given app version + platform.
 *
 * @param {string} [appVersion] e.g. "1.0.0". Optional; when omitted, native
 *   support is reported as declared (no version downgrade).
 * @param {string} [platform]   "android" | "ios" (case-insensitive). Defaults
 *   to "android". Unknown platforms fall back to "android".
 * @returns {{platform:string, appVersion:(string|null), generatedAt:string,
 *   stage:number, features:Array}} Pure manifest object.
 */
function buildSettingsManifest(appVersion, platform) {
    const plat = SUPPORTED_PLATFORMS.includes(String(platform).toLowerCase())
        ? String(platform).toLowerCase()
        : 'android';

    const features = FEATURES.map((f) => {
        const native = resolveNative(f, appVersion, plat);
        return {
            key: f.key,
            name: f.name,
            enabled: f.enabled,
            native, // true | "partial" | false
            // webFallback is ALWAYS present so the app can open it whenever
            // native is false/"partial" or the version gate downgrades it.
            webFallback: portalFocus(f.key),
            minAppVersion: (f.minAppVersion && f.minAppVersion[plat]) || '0.0.0',
        };
    });

    return {
        platform: plat,
        appVersion: appVersion || null,
        generatedAt: new Date().toISOString(),
        stage: 1,
        features,
    };
}

module.exports = {
    buildSettingsManifest,
    // exported for tests / Stage-2 reuse
    FEATURES,
    SUPPORTED_PLATFORMS,
    compareVersions,
    portalFocus,
};
