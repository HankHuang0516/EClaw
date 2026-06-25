/**
 * Unit tests for lib/settings-manifest.js — the Stage-1 settings auto-sync seam.
 *
 * Pure logic, no DB / HTTP. Asserts manifest structure, required keys on every
 * feature, minAppVersion version gating (old app → native:false + webFallback),
 * and that webFallback URLs are well-formed.
 */

const {
    buildSettingsManifest,
    FEATURES,
    SUPPORTED_PLATFORMS,
    FIELD_SCHEMA_VERSION,
    compareVersions,
} = require('../../lib/settings-manifest');

// Per #6 ruling: the field registry is now nested under `schema`. Each feature
// carries `schema` (object or null); the envelope still carries `schemaVersion`.
const REQUIRED_KEYS = ['key', 'name', 'enabled', 'native', 'webFallback', 'minAppVersion', 'schema'];

const FIELD_TYPES = ['boolean', 'string', 'number', 'enum', 'multi_enum', 'action'];
// #6 control vocabulary: boolean→switch, string→text|textarea|password,
// number→slider|stepper, enum→select|multiselect, action→button.
const FIELD_CONTROLS = ['switch', 'slider', 'stepper', 'text', 'textarea', 'password', 'select', 'multiselect', 'button'];
const FIELD_SCOPES = ['device', 'entity', 'user'];
const RENDERERS = ['form'];
const DATASOURCE_AUTH = ['device', 'entity', 'user', 'none'];

// Shared assertion: a #6 {i18n, fallback} localizable descriptor.
function assertLabelShape(obj) {
    expect(obj).toBeTruthy();
    expect(typeof obj.fallback).toBe('string');
    expect(obj.fallback.length).toBeGreaterThan(0);
    expect(typeof obj.i18n).toBe('string');
    expect(obj.i18n.length).toBeGreaterThan(0);
}

// Assert a dataSource endpoint descriptor {method, path, auth, [responsePath|requestPath]}.
function assertEndpointShape(ep) {
    expect(ep).toBeTruthy();
    expect(['GET', 'PUT', 'POST', 'PATCH', 'DELETE']).toContain(ep.method);
    expect(typeof ep.path).toBe('string');
    expect(ep.path.startsWith('/api/')).toBe(true);
    expect(DATASOURCE_AUTH).toContain(ep.auth);
}

describe('buildSettingsManifest() — structure', () => {
    it('returns the manifest envelope with expected top-level fields', () => {
        const m = buildSettingsManifest('1.0.0', 'android');
        expect(m).toMatchObject({
            platform: 'android',
            appVersion: '1.0.0',
            stage: 1,
        });
        expect(typeof m.generatedAt).toBe('string');
        expect(Number.isNaN(Date.parse(m.generatedAt))).toBe(false);
        expect(Array.isArray(m.features)).toBe(true);
        expect(m.features.length).toBe(FEATURES.length);
        // Field-registry layer advertises its format version at envelope level.
        expect(m.schemaVersion).toBe(FIELD_SCHEMA_VERSION);
        expect(m.schemaVersion).toBe(1);
    });

    it('every feature has all required keys with valid types', () => {
        const m = buildSettingsManifest('1.0.0', 'ios');
        for (const f of m.features) {
            for (const k of REQUIRED_KEYS) {
                expect(f).toHaveProperty(k);
            }
            expect(typeof f.key).toBe('string');
            expect(f.key.length).toBeGreaterThan(0);
            expect(typeof f.name).toBe('string');
            expect(typeof f.enabled).toBe('boolean');
            expect([true, false, 'partial']).toContain(f.native);
            expect(typeof f.webFallback).toBe('string');
            expect(typeof f.minAppVersion).toBe('string');
            // Per #6: field registry is nested under `schema` (object or null).
            expect(f).toHaveProperty('schema');
            expect(f.schema === null || typeof f.schema === 'object').toBe(true);
        }
    });

    it('declares all real settings feature keys (no drift in the canonical set)', () => {
        const keys = buildSettingsManifest('1.0.0', 'android').features.map((f) => f.key);
        const expected = [
            'account_identity', 'channel_api', 'subscription', 'invite', 'language',
            'display', 'chat_prefs', 'action_requests', 'rental_management', 'notifications',
            'developer_broadcast', 'agent_policy', 'kanban_nudge', 'passive_health',
            'wallet', 'my_rentals', 'files', 'companion_petdx', 'feedback',
            'rotate_secret', 'switch_device', 'logout',
        ];
        for (const k of expected) expect(keys).toContain(k);
        expect(keys.length).toBe(expected.length);
    });

    it('feature keys are unique', () => {
        const keys = buildSettingsManifest('1.0.0', 'android').features.map((f) => f.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('buildSettingsManifest() — platform handling', () => {
    it('supports android and ios', () => {
        expect(buildSettingsManifest('1.0.0', 'android').platform).toBe('android');
        expect(buildSettingsManifest('1.0.0', 'ios').platform).toBe('ios');
    });

    it('is case-insensitive on platform', () => {
        expect(buildSettingsManifest('1.0.0', 'iOS').platform).toBe('ios');
        expect(buildSettingsManifest('1.0.0', 'ANDROID').platform).toBe('android');
    });

    it('falls back to android for unknown / missing platform', () => {
        expect(buildSettingsManifest('1.0.0', 'windows').platform).toBe('android');
        expect(buildSettingsManifest('1.0.0').platform).toBe('android');
    });

    it('reflects per-platform native drift (channel_api Android partial, iOS true)', () => {
        const a = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'channel_api');
        const i = buildSettingsManifest('1.0.0', 'ios').features.find((f) => f.key === 'channel_api');
        expect(a.native).toBe('partial');
        expect(i.native).toBe(true);
    });

    it('reflects iOS notifications partial drift', () => {
        const a = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'notifications');
        const i = buildSettingsManifest('1.0.0', 'ios').features.find((f) => f.key === 'notifications');
        expect(a.native).toBe(true);
        expect(i.native).toBe('partial');
    });
});

describe('drift list — HIGH/MED features are web-only on both platforms', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
        for (const key of ['rotate_secret', 'switch_device', 'rental_management', 'agent_policy', 'kanban_nudge', 'passive_health', 'action_requests']) {
            it(`${key} is native:false on ${platform}`, () => {
                const f = buildSettingsManifest('1.0.0', platform).features.find((x) => x.key === key);
                expect(f.native).toBe(false);
                expect(f.webFallback).toContain(`focus=${key}`);
            });
        }
    }
});

describe('minAppVersion gating', () => {
    // Synthetic gate: temporarily lift a feature's native floor so we can prove
    // an old app gets downgraded. We do this by mutating the exported FEATURES
    // entry and restoring it (table-driven, deterministic).
    const target = FEATURES.find((f) => f.key === 'companion_petdx');
    const origNative = JSON.parse(JSON.stringify(target.native));
    const origMin = JSON.parse(JSON.stringify(target.minAppVersion));

    afterEach(() => {
        target.native = JSON.parse(JSON.stringify(origNative));
        target.minAppVersion = JSON.parse(JSON.stringify(origMin));
    });

    it('an app OLDER than minAppVersion sees native:false + webFallback', () => {
        target.native = { android: true, ios: true };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const oldApp = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'companion_petdx');
        expect(oldApp.native).toBe(false);
        expect(oldApp.webFallback).toContain('focus=companion_petdx');
        expect(oldApp.minAppVersion).toBe('2.5.0');
    });

    it('an app AT or ABOVE minAppVersion keeps native support', () => {
        target.native = { android: true, ios: true };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const atVer = buildSettingsManifest('2.5.0', 'android').features.find((f) => f.key === 'companion_petdx');
        const above = buildSettingsManifest('3.0.0', 'android').features.find((f) => f.key === 'companion_petdx');
        expect(atVer.native).toBe(true);
        expect(above.native).toBe(true);
    });

    it('partial native is also downgraded for an old app', () => {
        target.native = { android: 'partial', ios: 'partial' };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const oldApp = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'companion_petdx');
        expect(oldApp.native).toBe(false);
    });

    it('omitting appVersion reports native as declared (no downgrade)', () => {
        target.native = { android: true, ios: true };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const noVer = buildSettingsManifest(undefined, 'android').features.find((f) => f.key === 'companion_petdx');
        expect(noVer.native).toBe(true);
        expect(noVer.appVersion).toBeUndefined(); // it's a feature, no appVersion field
    });
});

describe('webFallback URLs are well-formed', () => {
    it('every webFallback is an https eclawbot.com portal URL with a focus param', () => {
        const m = buildSettingsManifest('1.0.0', 'android');
        for (const f of m.features) {
            const u = new URL(f.webFallback);
            expect(u.protocol).toBe('https:');
            expect(u.hostname).toBe('eclawbot.com');
            expect(u.pathname).toBe('/portal/settings.html');
            expect(u.searchParams.get('focus')).toBe(f.key);
        }
    });
});

describe('Stage-3 field registry — #6 nested schema', () => {
    const manifest = buildSettingsManifest('1.0.0', 'android');
    const byKey = (k) => manifest.features.find((f) => f.key === k);
    // Convenience: pull the nested fields array (empty when schema is null).
    const fieldsOf = (k) => {
        const f = byKey(k);
        return f && f.schema ? f.schema.fields : [];
    };

    it('every feature carries `schema` (object or null), never the old top-level fields', () => {
        for (const f of manifest.features) {
            expect(f).toHaveProperty('schema');
            // Old flat shape is gone.
            expect(f).not.toHaveProperty('fields');
            expect(f).not.toHaveProperty('schemaVersion');
            expect(f.schema === null || typeof f.schema === 'object').toBe(true);
        }
    });

    it('every non-null schema has {version, renderer, dataSource, fields}', () => {
        for (const f of manifest.features) {
            if (!f.schema) continue;
            expect(f.schema.version).toBe(1);
            expect(RENDERERS).toContain(f.schema.renderer);
            expect(typeof f.schema.dataSource).toBe('object');
            expect(Array.isArray(f.schema.fields)).toBe(true);
            expect(f.schema.fields.length).toBeGreaterThan(0);
        }
    });

    it('schema.dataSource read/write endpoints are well-formed real /api/* endpoints', () => {
        for (const f of manifest.features) {
            if (!f.schema) continue;
            const ds = f.schema.dataSource;
            // At least one of read/write must be present.
            expect(ds.read || ds.write).toBeTruthy();
            if (ds.read) {
                assertEndpointShape(ds.read);
                expect(typeof ds.read.responsePath).toBe('string');
            }
            if (ds.write) {
                assertEndpointShape(ds.write);
            }
        }
    });

    it('value-bearing features expose both read+write; pure-action features write-only', () => {
        // Read+write features.
        for (const k of ['account_identity', 'notifications', 'chat_prefs', 'action_requests', 'kanban_nudge']) {
            const ds = byKey(k).schema.dataSource;
            expect(ds.read).toBeTruthy();
            expect(ds.write).toBeTruthy();
            expect(typeof ds.read.responsePath).toBe('string');
            expect(typeof ds.write.requestPath).toBe('string');
        }
        // Pure-action features (no value to read) carry write only.
        for (const k of ['rotate_secret', 'switch_device']) {
            const ds = byKey(k).schema.dataSource;
            expect(ds.read).toBeFalsy();
            expect(ds.write).toBeTruthy();
            expect(ds.write.method).toBe('POST');
        }
    });

    it('dataSource endpoints map to the real settings APIs', () => {
        expect(byKey('account_identity').schema.dataSource.read.path).toBe('/api/device/user-profile');
        expect(byKey('account_identity').schema.dataSource.write.path).toBe('/api/device/user-profile');
        expect(byKey('account_identity').schema.dataSource.read.responsePath).toBe('profile');

        expect(byKey('notifications').schema.dataSource.read.path).toBe('/api/notification-preferences');
        expect(byKey('notifications').schema.dataSource.read.responsePath).toBe('prefs');
        expect(byKey('notifications').schema.dataSource.write.requestPath).toBe('prefs');

        expect(byKey('chat_prefs').schema.dataSource.read.path).toBe('/api/device-preferences');
        expect(byKey('action_requests').schema.dataSource.read.path).toBe('/api/device-preferences');
        expect(byKey('action_requests').schema.dataSource.write.path).toBe('/api/device-preferences');
        expect(byKey('action_requests').schema.dataSource.read.responsePath).toBe('prefs');
        expect(byKey('action_requests').schema.dataSource.write.requestPath).toBe('prefs');
        expect(byKey('kanban_nudge').schema.dataSource.read.path).toBe('/api/device-preferences');

        expect(byKey('rotate_secret').schema.dataSource.write.path).toBe('/api/device/rotate-secret');
        expect(byKey('switch_device').schema.dataSource.write.path).toBe('/api/auth/device-login');
    });

    it('every field has a valid type/control/scope and {i18n,fallback} label', () => {
        for (const f of manifest.features) {
            for (const field of fieldsOf(f.key)) {
                expect(typeof field.key).toBe('string');
                expect(field.key.length).toBeGreaterThan(0);
                expect(FIELD_TYPES).toContain(field.type);
                expect(FIELD_CONTROLS).toContain(field.control);
                expect(FIELD_SCOPES).toContain(field.scope);
                assertLabelShape(field.label);
                if (field.help !== undefined) assertLabelShape(field.help);
                if (field.writeAliases !== undefined) {
                    expect(Array.isArray(field.writeAliases)).toBe(true);
                    expect(field.writeAliases.length).toBeGreaterThan(0);
                    for (const a of field.writeAliases) expect(typeof a).toBe('string');
                }
            }
        }
    });

    it('field keys are unique within each feature', () => {
        for (const f of manifest.features) {
            const keys = fieldsOf(f.key).map((x) => x.key);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('non-action fields declare a default; action fields do not', () => {
        for (const f of manifest.features) {
            for (const field of fieldsOf(f.key)) {
                if (field.type === 'action') {
                    expect(field).not.toHaveProperty('default');
                } else {
                    expect(field).toHaveProperty('default');
                }
            }
        }
    });

    it('fields preserve declaration order (notifications: bot_reply first)', () => {
        const fields = fieldsOf('notifications');
        expect(fields.length).toBe(8);
        expect(fields[0].key).toBe('bot_reply');
        expect(fields.map((x) => x.key)).toEqual([
            'bot_reply', 'broadcast', 'speak_to', 'feedback',
            'todo', 'scheduled', 'user_mention', 'rich_card',
        ]);
    });

    it('notification fields are boolean switches scoped to device with required:false', () => {
        for (const field of fieldsOf('notifications')) {
            expect(field.type).toBe('boolean');
            expect(field.control).toBe('switch');
            expect(field.scope).toBe('device');
            expect(typeof field.default).toBe('boolean');
            expect(field.validation.required).toBe(false);
        }
    });

    it('notification writeAliases bridge manifest keys to the real notif pref keys', () => {
        const fields = fieldsOf('notifications');
        const by = (k) => fields.find((x) => x.key === k);
        // feedback toggle governs BOTH feedback categories.
        expect(by('feedback').writeAliases).toEqual(['feedback_resolved', 'feedback_reply']);
        expect(by('todo').writeAliases).toEqual(['todo_done']);
        expect(by('rich_card').writeAliases).toEqual(['rich_card_question']);
        // Keys that match the API need no alias.
        expect(by('bot_reply').writeAliases).toBeUndefined();
        expect(by('broadcast').writeAliases).toBeUndefined();
    });

    it('chat_prefs avatar_size is an enum/select with options[] + writeAlias', () => {
        const field = fieldsOf('chat_prefs').find((x) => x.key === 'avatar_size');
        expect(field.type).toBe('enum');
        expect(field.control).toBe('select');
        expect(field.default).toBe('medium');
        expect(field.writeAliases).toEqual(['chat_avatar_size']);
        expect(Array.isArray(field.validation.options)).toBe(true);
        expect(field.validation.options.map((o) => o.value)).toEqual(['small', 'medium', 'large']);
        for (const opt of field.validation.options) assertLabelShape(opt.label);
    });

    it('action_requests exposes realtime and timeout policy device prefs', () => {
        const fields = fieldsOf('action_requests');
        expect(fields.map((x) => x.key)).toEqual([
            'action_request_realtime',
            'action_request_timeout_policy',
        ]);

        const realtime = fields.find((x) => x.key === 'action_request_realtime');
        expect(realtime.type).toBe('boolean');
        expect(realtime.control).toBe('switch');
        expect(realtime.scope).toBe('device');
        expect(realtime.default).toBe(true);
        expect(realtime.validation.required).toBe(false);

        const timeout = fields.find((x) => x.key === 'action_request_timeout_policy');
        expect(timeout.type).toBe('enum');
        expect(timeout.control).toBe('select');
        expect(timeout.scope).toBe('device');
        expect(timeout.default).toBe('keep');
        expect(timeout.validation.required).toBe(false);
        expect(timeout.validation.options.map((o) => o.value)).toEqual(['keep', 'auto_dismiss', 'escalate']);
        for (const opt of timeout.validation.options) assertLabelShape(opt.label);
    });

    it('account_identity display name is a string field with maxLength + writeAlias', () => {
        const field = fieldsOf('account_identity').find((x) => x.key === 'user_display_name');
        expect(field.type).toBe('string');
        expect(field.control).toBe('text');
        expect(field.scope).toBe('user');
        expect(field.writeAliases).toEqual(['userDisplayName']);
        expect(field.validation.maxLength).toBe(64);
        expect(field.validation.required).toBe(false);
    });

    it('rotate_secret exposes a single action field (no default, confirm:true)', () => {
        const fields = fieldsOf('rotate_secret');
        expect(fields.length).toBe(1);
        const action = fields[0];
        expect(action.type).toBe('action');
        expect(action.control).toBe('button');
        expect(action).not.toHaveProperty('default');
        expect(action.validation.confirm).toBe(true);
        assertLabelShape(action.help);
    });

    it('switch_device exposes two required text/password fields + a confirm action', () => {
        const fields = fieldsOf('switch_device');
        const action = fields.find((x) => x.type === 'action');
        const texts = fields.filter((x) => x.type === 'string');
        expect(action).toBeTruthy();
        expect(action.control).toBe('button');
        expect(texts.map((x) => x.key)).toEqual(['device_id', 'device_secret']);
        // The credential inputs map to the device-login body keys.
        expect(fields.find((x) => x.key === 'device_id').writeAliases).toEqual(['deviceId']);
        expect(fields.find((x) => x.key === 'device_secret').writeAliases).toEqual(['deviceSecret']);
        expect(fields.find((x) => x.key === 'device_secret').control).toBe('password');
        for (const t of texts) {
            expect(['text', 'password']).toContain(t.control);
            expect(t.validation.required).toBe(true);
        }
    });

    it('kanban_nudge batch_size is a number field with {min,max,step,unit} validation', () => {
        const field = fieldsOf('kanban_nudge').find((x) => x.key === 'kanban_nudge_batch_size');
        expect(field.type).toBe('number');
        expect(field.control).toBe('slider');
        expect(field.scope).toBe('device');
        expect(field.default).toBe(5);
        expect(field.validation.min).toBe(1);
        expect(field.validation.max).toBe(20);
        expect(field.validation.step).toBe(1);
        expect(field.validation.unit).toBe('cards');
    });

    it('every number-typed field declares {min,max} or {step,unit} bounds', () => {
        let numberFieldCount = 0;
        for (const f of manifest.features) {
            for (const field of fieldsOf(f.key)) {
                if (field.type === 'number') {
                    numberFieldCount += 1;
                    const v = field.validation || {};
                    const hasBounds = typeof v.min === 'number' || typeof v.max === 'number'
                        || typeof v.step === 'number' || typeof v.unit === 'string';
                    expect(hasBounds).toBe(true);
                }
            }
        }
        // Sanity: this slice ships at least one real number field.
        expect(numberFieldCount).toBeGreaterThanOrEqual(2);
    });

    it('action type appears for the HIGH-drift features rotate_secret + switch_device', () => {
        const hasAction = (k) => fieldsOf(k).some((x) => x.type === 'action');
        expect(hasAction('rotate_secret')).toBe(true);
        expect(hasAction('switch_device')).toBe(true);
    });

    it('schema is emitted regardless of platform (not gated by native downgrade)', () => {
        const ios = buildSettingsManifest('1.0.0', 'ios').features.find((f) => f.key === 'notifications');
        // notifications is iOS:"partial" but its field registry is still present.
        expect(ios.schema.fields.length).toBe(8);
    });

    it('features with no settable fields emit schema:null', () => {
        const noFieldKeys = ['channel_api', 'subscription', 'invite', 'language', 'display'];
        for (const k of noFieldKeys) {
            expect(byKey(k).schema).toBeNull();
        }
    });
});

describe('compareVersions()', () => {
    it('orders versions correctly', () => {
        expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
        expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
        expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
        expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });
});
