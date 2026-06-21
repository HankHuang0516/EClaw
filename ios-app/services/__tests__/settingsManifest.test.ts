/**
 * Pure-logic tests for the Stage-2 iOS client manifest resolver
 * (ios-app/services/settingsManifest.ts).
 *
 * Mirrors the Android reference tests at parity:
 *   - app/src/test/java/com/hank/clawlive/settings/SettingsManifestResolverTest.kt
 *   - app/src/test/java/com/hank/clawlive/settings/SettingsManifestSyncTest.kt
 * and the backend contract in backend/lib/settings-manifest.js +
 * the worked version-gate example in docs/specs/settings-manifest-spec.md §3.
 *
 * No React Native / Expo deps — the resolver is a pure module.
 */

import {
  nativeSupport,
  compareVersions,
  resolveFeature,
  resolve,
  isVersionGated,
  planDynamicRows,
  NativeSupport,
  FeatureSurface,
  type SettingsManifest,
  type SettingsManifestFeature,
} from '../settingsManifest';

// ── native flag normalisation ─────────────────────────────────────────────────

describe('nativeSupport', () => {
  test('normalises true / "partial" / false (mirrors Android)', () => {
    expect(nativeSupport(true)).toBe(NativeSupport.FULL);
    expect(nativeSupport('partial')).toBe(NativeSupport.PARTIAL);
    expect(nativeSupport('PARTIAL')).toBe(NativeSupport.PARTIAL);
    expect(nativeSupport(false)).toBe(NativeSupport.NONE);
    expect(nativeSupport(null)).toBe(NativeSupport.NONE);
    expect(nativeSupport(undefined)).toBe(NativeSupport.NONE);
    // "true" as a JSON string still means natively renderable.
    expect(nativeSupport('true')).toBe(NativeSupport.FULL);
    // Any unknown string fails safe to web.
    expect(nativeSupport('maybe')).toBe(NativeSupport.NONE);
  });
});

// ── compareVersions parity with backend ───────────────────────────────────────

describe('compareVersions', () => {
  test('matches backend semantics', () => {
    expect(compareVersions('1.0.0', '2.5.0')).toBe(-1);
    expect(compareVersions('2.5.0', '2.5.0')).toBe(0);
    expect(compareVersions('3.0.0', '2.5.0')).toBe(1);
    // Missing segments treated as 0.
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
    // Suffixed build names tolerated (leading digits only).
    expect(compareVersions('2.5.0-debug', '2.5.0')).toBe(0);
  });
});

// ── version gating (spec §3 worked example: companion_petdx) ───────────────────

function feature(native: boolean | string, minVer: string): SettingsManifestFeature {
  return {
    key: 'companion_petdx',
    name: 'Companion (PetDX)',
    enabled: true,
    native,
    webFallback: 'https://eclawbot.com/portal/settings.html?focus=companion_petdx',
    minAppVersion: minVer,
  };
}

describe('resolveFeature — version gate decision table', () => {
  test('native true, old app below minVersion -> downgraded to WEB', () => {
    const r = resolveFeature(feature(true, '2.5.0'), '1.0.0');
    expect(r.surface).toBe(FeatureSurface.WEB);
    expect(r.webFallback).toBe(
      'https://eclawbot.com/portal/settings.html?focus=companion_petdx'
    );
  });

  test('native true, app AT minVersion -> NATIVE', () => {
    expect(resolveFeature(feature(true, '2.5.0'), '2.5.0').surface).toBe(
      FeatureSurface.NATIVE
    );
  });

  test('native true, app ABOVE minVersion -> NATIVE', () => {
    expect(resolveFeature(feature(true, '2.5.0'), '3.0.0').surface).toBe(
      FeatureSurface.NATIVE
    );
  });

  test('partial above gate -> NATIVE_PLUS_WEB', () => {
    expect(resolveFeature(feature('partial', '1.0.0'), '1.0.0').surface).toBe(
      FeatureSurface.NATIVE_PLUS_WEB
    );
  });

  test('partial below gate -> WEB', () => {
    expect(resolveFeature(feature('partial', '2.0.0'), '1.0.0').surface).toBe(
      FeatureSurface.WEB
    );
  });

  test('native false -> always WEB, even on a brand new app', () => {
    // rotate_secret / switch_device today: native:false on both platforms.
    expect(resolveFeature(feature(false, '0.0.0'), '99.0.0').surface).toBe(
      FeatureSurface.WEB
    );
  });

  test('missing/blank appVersion -> trusts declared native (no downgrade)', () => {
    expect(resolveFeature(feature(true, '2.5.0'), null).surface).toBe(
      FeatureSurface.NATIVE
    );
    expect(resolveFeature(feature(true, '2.5.0'), '').surface).toBe(
      FeatureSurface.NATIVE
    );
    expect(resolveFeature(feature(true, '2.5.0'), undefined).surface).toBe(
      FeatureSurface.NATIVE
    );
  });
});

// ── manifest-level resolve ────────────────────────────────────────────────────

describe('resolve — manifest level', () => {
  test('drops disabled and gates each', () => {
    const manifest: SettingsManifest = {
      platform: 'ios',
      appVersion: '1.0.0',
      stage: 1,
      features: [
        { key: 'account_identity', name: 'Account & Identity', enabled: true, native: true, webFallback: 'wf_a', minAppVersion: '1.0.0' },
        { key: 'rotate_secret', name: 'Rotate Secret', enabled: true, native: false, webFallback: 'wf_r', minAppVersion: '0.0.0' },
        { key: 'companion_petdx', name: 'Companion', enabled: true, native: true, webFallback: 'wf_c', minAppVersion: '2.5.0' },
        { key: 'hidden_feature', name: 'Hidden', enabled: false, native: true, webFallback: 'wf_h', minAppVersion: '1.0.0' },
      ],
    };
    const resolved = resolve(manifest, '1.0.0');
    // disabled feature dropped
    expect(resolved.map((r) => r.key)).toEqual([
      'account_identity',
      'rotate_secret',
      'companion_petdx',
    ]);
    expect(resolved[0].surface).toBe(FeatureSurface.NATIVE); // account: native at 1.0.0
    expect(resolved[1].surface).toBe(FeatureSurface.WEB); // rotate_secret: native:false
    expect(resolved[2].surface).toBe(FeatureSurface.WEB); // companion gated out (1.0.0<2.5.0)
  });

  test('null manifest -> empty', () => {
    expect(resolve(null, '1.0.0')).toEqual([]);
    expect(resolve(undefined, '1.0.0')).toEqual([]);
  });
});

// ── Stage-2 dynamic row planner (port of SettingsManifestSyncTest) ─────────────

function f(
  key: string,
  native: boolean | string,
  opts: { enabled?: boolean; minVer?: string; webFallback?: string } = {}
): SettingsManifestFeature {
  return {
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    enabled: opts.enabled ?? true,
    native,
    webFallback:
      opts.webFallback ?? `https://eclawbot.com/portal/settings.html?focus=${key}`,
    minAppVersion: opts.minVer ?? '0.0.0',
  };
}

function manifest(...features: SettingsManifestFeature[]): SettingsManifest {
  return { platform: 'ios', appVersion: '1.0.0', stage: 1, features };
}

describe('planDynamicRows — Stage-2 auto-sync delta', () => {
  test('NEW web-only feature with no native row -> emits web row (the payoff)', () => {
    const rows = planDynamicRows(manifest(f('rotate_secret', false)), '1.0.94');
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('rotate_secret');
    expect(rows[0].gated).toBe(false);
    expect(rows[0].webFallback).toBe(
      'https://eclawbot.com/portal/settings.html?focus=rotate_secret'
    );
  });

  test('native feature the static screen renders -> no dynamic row', () => {
    const rows = planDynamicRows(
      manifest(
        f('subscription', true, { minVer: '1.0.0' }),
        f('language', true, { minVer: '1.0.0' }),
        f('notifications', true, { minVer: '1.0.0' })
      ),
      '1.0.94'
    );
    expect(rows).toEqual([]);
  });

  test('web-backed static row (kanban_nudge) -> not duplicated', () => {
    const rows = planDynamicRows(manifest(f('kanban_nudge', false)), '1.0.94');
    expect(rows).toEqual([]);
  });

  test('disabled feature -> dropped', () => {
    const rows = planDynamicRows(
      manifest(f('agent_policy', false, { enabled: false })),
      '1.0.94'
    );
    expect(rows).toEqual([]);
  });

  test('version-gated NATIVE feature with a static row -> gated help row', () => {
    // subscription declares native at 2.5.0 but app is 1.0.0 -> static native row
    // can't be honored -> surface a gated help row.
    const rows = planDynamicRows(
      manifest(f('subscription', true, { minVer: '2.5.0' })),
      '1.0.0'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('subscription');
    expect(rows[0].gated).toBe(true);
  });

  test('NEW native-declared feature gated out, no static row -> gated web row', () => {
    const rows = planDynamicRows(
      manifest(f('companion_v2', true, { minVer: '3.0.0' })),
      '1.0.0'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('companion_v2');
    expect(rows[0].gated).toBe(true);
  });

  test('isVersionGated distinguishes gated vs plain web-only', () => {
    expect(isVersionGated(f('x', true, { minVer: '2.0.0' }), '1.0.0')).toBe(true);
    expect(isVersionGated(f('x', true, { minVer: '1.0.0' }), '1.0.0')).toBe(false);
    expect(isVersionGated(f('x', false), '1.0.0')).toBe(false);
    expect(isVersionGated(f('x', true, { minVer: '2.0.0' }), null)).toBe(false);
  });

  test('null manifest -> no rows (caller keeps static screen)', () => {
    expect(planDynamicRows(null, '1.0.0')).toEqual([]);
    expect(planDynamicRows(undefined, '1.0.0')).toEqual([]);
  });

  test('live-like iOS manifest -> only the features iOS does not render natively surface', () => {
    // Reflects the iOS static screen: account/subscription/language/notifications/
    // invite/wallet/my_rentals/files/feedback render natively; kanban_nudge is a
    // web-backed static row. channel_api / display / chat_prefs /
    // developer_broadcast / companion_petdx are NOT in the iOS static screen, so
    // the manifest auto-surfaces them (the drift-fix the seam exists for).
    const rows = planDynamicRows(
      manifest(
        f('account_identity', true, { minVer: '1.0.0' }),
        f('channel_api', true, { minVer: '1.0.0' }), // not in iOS static -> web row
        f('subscription', true, { minVer: '1.0.0' }),
        f('invite', true, { minVer: '1.0.0' }),
        f('language', true, { minVer: '1.0.0' }),
        f('display', true, { minVer: '1.0.0' }), // not in iOS static -> web row
        f('chat_prefs', true, { minVer: '1.0.0' }), // not in iOS static -> web row
        f('rental_management', false), // NEW web-only -> row
        f('notifications', 'partial', { minVer: '1.0.0' }),
        f('developer_broadcast', true, { minVer: '1.0.0' }), // not in iOS static -> web row
        f('agent_policy', false), // NEW web-only -> row
        f('kanban_nudge', false), // web-backed static row -> skip
        f('passive_health', false), // NEW web-only -> row
        f('wallet', true, { minVer: '1.0.0' }),
        f('my_rentals', true, { minVer: '1.0.0' }),
        f('files', true, { minVer: '1.0.0' }),
        f('companion_petdx', true, { minVer: '1.0.0' }), // not in iOS static -> web row
        f('feedback', true, { minVer: '1.0.0' }),
        f('rotate_secret', false), // NEW web-only -> row
        f('switch_device', false) // NEW web-only -> row
      ),
      '1.0.94'
    );
    expect(rows.map((r) => r.key)).toEqual([
      'channel_api',
      'display',
      'chat_prefs',
      'rental_management',
      'developer_broadcast',
      'agent_policy',
      'passive_health',
      'companion_petdx',
      'rotate_secret',
      'switch_device',
    ]);
    expect(rows.some((r) => r.gated)).toBe(false);
  });
});
