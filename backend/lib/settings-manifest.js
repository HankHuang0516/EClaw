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
 * Stage 2 (apps consume this manifest — needs a build) is a follow-up.
 *
 * STAGE 3 (this slice — backend only, NO app build): the JSON-schema-lite
 * FIELD REGISTRY. Each feature may declare a `fields` array (order-preserving)
 * of field descriptors so an app can render the *contents* of a settings screen
 * — not just whether it is native — directly from the manifest. Each field is:
 *   {
 *     key,                    // stable per-feature field id, never renamed
 *     type,                   // boolean | string | number | enum | multi_enum | action
 *     control,                // UI hint: switch | slider | text | select | multiselect | button
 *     label: {fallback, i18nKey},   // Globe-user: i18nKey is canonical, fallback is the EN default
 *     help:  {fallback, i18nKey},   // optional, same shape
 *     scope,                  // device | entity | user — what the value is keyed to
 *     default,                // default value (omit for type:'action')
 *     validation,             // type-specific: number {min,max,step,unit};
 *                             //   enum/multi_enum {options:[{value,label}]}; string {maxLength};
 *                             //   any {required}
 *   }
 * Each feature that ships a field registry also carries `schemaVersion` (int)
 * so consumers can detect breaking field-format changes independently of the
 * feature set. `fields` is version-gated exactly like the rest of the manifest
 * (it is emitted verbatim; the version downgrade only touches `native`).
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
// JSON-schema-lite field-registry version. Bump on any breaking change to the
// `fields` descriptor format (not on simply adding/removing a field).
const FIELD_SCHEMA_VERSION = 1;

const FEATURES = [
    {
        key: 'account_identity',
        name: 'Account & Identity',
        enabled: true,
        native: { android: true, ios: true },
        minAppVersion: { android: '1.0.0', ios: '1.0.0' },
        schemaVersion: FIELD_SCHEMA_VERSION,
        fields: [
            {
                key: 'user_display_name',
                type: 'string',
                control: 'text',
                label: { fallback: 'My Display Name', i18nKey: 'settings_user_display_name_title' },
                help: {
                    fallback: 'The name shown in chat headers in place of "Device Owner". Leave blank to use the default.',
                    i18nKey: 'settings_user_display_name_desc',
                },
                scope: 'user',
                default: '',
                validation: { required: false, maxLength: 64 },
            },
        ],
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
        schemaVersion: FIELD_SCHEMA_VERSION,
        fields: [
            {
                key: 'avatar_size',
                type: 'enum',
                control: 'select',
                label: { fallback: 'Avatar Size', i18nKey: 'settings_chat_avatar_size' },
                help: {
                    fallback: 'Applies to chat list, chat header, and message avatars',
                    i18nKey: 'settings_chat_avatar_size_desc',
                },
                scope: 'device',
                default: 'medium',
                validation: {
                    required: true,
                    options: [
                        { value: 'small', label: { fallback: 'Small', i18nKey: 'settings_chat_avatar_size_small' } },
                        { value: 'medium', label: { fallback: 'Medium', i18nKey: 'settings_chat_avatar_size_medium' } },
                        { value: 'large', label: { fallback: 'Large', i18nKey: 'settings_chat_avatar_size_large' } },
                    ],
                },
            },
        ],
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
        schemaVersion: FIELD_SCHEMA_VERSION,
        // Per-category notification preference toggles (settings.html notification
        // prefs section, persisted per-device). Each maps to a real notif_pref_* key.
        fields: [
            {
                key: 'bot_reply',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'Bot Replies', i18nKey: 'notif_pref_bot_reply' },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'broadcast',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'Broadcasts', i18nKey: 'notif_pref_broadcast' },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'speak_to',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'Entity Messages', i18nKey: 'notif_pref_speak_to' },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'feedback',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'Feedback Updates', i18nKey: 'notif_pref_feedback' },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'todo',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'TODO Completed', i18nKey: 'notif_pref_todo' },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'scheduled',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'Scheduled Messages', i18nKey: 'notif_pref_scheduled' },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'user_mention',
                type: 'boolean',
                control: 'switch',
                label: { fallback: '@Mention pings', i18nKey: 'notif_pref_user_mention' },
                help: {
                    fallback: 'Get pinged when someone @-mentions you in chat.',
                    i18nKey: 'notif_pref_user_mention_help',
                },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
            {
                key: 'rich_card',
                type: 'boolean',
                control: 'switch',
                label: { fallback: 'Rich-card questions', i18nKey: 'notif_pref_rich_card' },
                help: {
                    fallback: 'Notify when a bot asks a question via an interactive rich card.',
                    i18nKey: 'notif_pref_rich_card_help',
                },
                scope: 'device',
                default: true,
                validation: { required: false },
            },
        ],
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
        schemaVersion: FIELD_SCHEMA_VERSION,
        // Real number settings (settings.html: <input type="number"> with
        // min/max/step). batch_size is device-wide; interval is stored in minutes.
        fields: [
            {
                key: 'kanban_nudge_batch_size',
                type: 'number',
                control: 'slider',
                label: { fallback: 'Cards per cycle', i18nKey: 'kanban_nudge_batch_label' },
                help: {
                    fallback: 'Maximum number of L1 stale cards picked per cron tick — device-wide cap, NOT per-entity.',
                    i18nKey: 'kanban_nudge_batch_help',
                },
                scope: 'device',
                default: 5,
                validation: { required: false, min: 1, max: 20, step: 1, unit: 'cards' },
            },
            {
                key: 'kanban_nudge_interval_minutes',
                type: 'number',
                control: 'slider',
                label: { fallback: 'Interval', i18nKey: 'kanban_nudge_interval_label' },
                help: {
                    fallback: 'Base interval (minutes) between stale-card nudges. Default 180 (3h). Per-entity overrides win when set.',
                    i18nKey: 'kanban_nudge_interval_help',
                },
                scope: 'device',
                default: 180,
                validation: { required: false, min: 0, max: 1440, step: 1, unit: 'minutes' },
            },
        ],
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
        schemaVersion: FIELD_SCHEMA_VERSION,
        // No stored value — a single destructive action that mints a new device
        // secret. type:'action' fields carry no `default`.
        fields: [
            {
                key: 'rotate_device_secret',
                type: 'action',
                control: 'button',
                label: { fallback: 'Rotate Device Secret', i18nKey: 'settings_rotate_device_secret' },
                help: {
                    fallback: 'Generate a new Device Secret if the current one has leaked. Other sessions will need the new value to sign in.',
                    i18nKey: 'settings_rotate_device_secret_hint',
                },
                scope: 'device',
                validation: { confirm: true },
            },
        ],
    },
    {
        key: 'switch_device',
        name: 'Switch Device',
        enabled: true,
        // HIGH drift: missing from BOTH native apps → web fallback only.
        native: { android: false, ios: false },
        minAppVersion: { android: '0.0.0', ios: '0.0.0' },
        schemaVersion: FIELD_SCHEMA_VERSION,
        // Two text inputs (the new credentials) + a confirm action.
        fields: [
            {
                key: 'device_id',
                type: 'string',
                control: 'text',
                label: { fallback: 'Device ID', i18nKey: 'settings_device_id' },
                scope: 'device',
                default: '',
                validation: { required: true },
            },
            {
                key: 'device_secret',
                type: 'string',
                control: 'text',
                label: { fallback: 'Device Secret', i18nKey: 'settings_device_secret' },
                scope: 'device',
                default: '',
                validation: { required: true },
            },
            {
                key: 'switch_device',
                type: 'action',
                control: 'button',
                label: { fallback: 'Switch', i18nKey: 'settings_switch_device_confirm' },
                help: {
                    fallback: 'Sign this browser into a different Device ID. Useful if you have a second admin account with its own entities.',
                    i18nKey: 'settings_switch_device_hint',
                },
                scope: 'device',
                validation: { confirm: true },
            },
        ],
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
        const entry = {
            key: f.key,
            name: f.name,
            enabled: f.enabled,
            native, // true | "partial" | false
            // webFallback is ALWAYS present so the app can open it whenever
            // native is false/"partial" or the version gate downgrades it.
            webFallback: portalFocus(f.key),
            minAppVersion: (f.minAppVersion && f.minAppVersion[plat]) || '0.0.0',
        };
        // Stage-3 JSON-schema-lite field registry. Emitted verbatim (not affected
        // by the native version gate). `fields` is always an array (empty for
        // features that have no settable fields yet) and `schemaVersion` is always
        // present so consumers can rely on a uniform shape.
        entry.schemaVersion = f.schemaVersion || FIELD_SCHEMA_VERSION;
        entry.fields = Array.isArray(f.fields) ? f.fields : [];
        return entry;
    });

    return {
        platform: plat,
        appVersion: appVersion || null,
        generatedAt: new Date().toISOString(),
        // `stage` stays 1 for backward compatibility (Stage-2 apps key off it).
        // The field-registry layer advertises itself via `schemaVersion` so a
        // consumer can detect the Stage-3 field format independently.
        stage: 1,
        schemaVersion: FIELD_SCHEMA_VERSION,
        features,
    };
}

module.exports = {
    buildSettingsManifest,
    // exported for tests / Stage-2 reuse
    FEATURES,
    SUPPORTED_PLATFORMS,
    FIELD_SCHEMA_VERSION,
    compareVersions,
    portalFocus,
};
