/**
 * Client-side model + resolver for the settings auto-sync seam (Stage 2, iOS half).
 *
 * TypeScript port of the Android reference
 * `app/src/main/java/com/hank/clawlive/settings/SettingsManifest.kt`
 * (`SettingsManifestResolver`) + `SettingsManifestSync.kt`, kept at exact parity so
 * both platforms resolve the same manifest identically.
 *
 * The backend ships `GET /api/settings-manifest?appVersion=&platform=ios` (Stage 1,
 * see backend/lib/settings-manifest.js + docs/specs/settings-manifest-spec.md).
 * Each enabled feature carries a `native` capability flag and a `webFallback` URL.
 * The app must, per feature, decide how to surface it:
 *
 *   native === true       -> render the native screen for that feature
 *   native === "partial"  -> render native UI + a "more on web" link -> webFallback
 *   native === false      -> open webFallback in a WebView
 *
 * The backend already applies the `minAppVersion` version gate when the app sends
 * `appVersion`. This client resolver mirrors that gate locally so the decision is
 * correct EVEN IF the app failed to send `appVersion` (e.g. the manifest was cached,
 * or fetched without the query param). A native flag the running binary cannot honor
 * is therefore never trusted blindly: if the running app version is below the
 * feature's `minAppVersion`, the feature is downgraded to the web fallback.
 *
 * IMPORTANT (matches Android client + card_411b8098): the LIVE endpoint returns
 * `native` and `minAppVersion` as SCALARS (true | "partial" | false  /  "1.0.0"),
 * NOT the spec §6.1 per-platform object — the backend resolves the platform before
 * sending. This module consumes the scalar shape, same as the Android client.
 *
 * This file is PURE TypeScript (no React Native / Expo deps) so the decision logic
 * is unit-testable in isolation.
 */

/** One feature row as returned by GET /api/settings-manifest. */
export interface SettingsManifestFeature {
  key: string;
  name: string;
  enabled: boolean;
  /**
   * The JSON `native` field: true | "partial" | false. Use {@link nativeSupport}
   * to normalise it; never branch on this raw field directly.
   */
  native: boolean | string;
  webFallback: string;
  minAppVersion: string;
  /** Stage-3 field registry (object | null); carried verbatim, not gated. */
  schema?: unknown;
}

/** Top-level manifest envelope: GET /api/settings-manifest. */
export interface SettingsManifest {
  platform: string;
  appVersion?: string | null;
  generatedAt?: string | null;
  stage: number;
  schemaVersion?: number;
  features: SettingsManifestFeature[];
}

/** API response wrapper: { success, manifest }. */
export interface SettingsManifestResponse {
  success: boolean;
  manifest?: SettingsManifest | null;
  error?: string | null;
}

/** Normalised native-support level for one feature on this platform. */
export enum NativeSupport {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
  NONE = 'NONE',
}

/**
 * How the app should surface one resolved feature.
 *
 * - NATIVE          : render the native screen (NativeSupport.FULL).
 * - NATIVE_PLUS_WEB : render native UI + a "more on web" link to webFallback
 *                     (NativeSupport.PARTIAL).
 * - WEB             : open webFallback in a WebView (NativeSupport.NONE, or a higher
 *                     level downgraded by the version gate).
 */
export enum FeatureSurface {
  NATIVE = 'NATIVE',
  NATIVE_PLUS_WEB = 'NATIVE_PLUS_WEB',
  WEB = 'WEB',
}

/** A feature after the client version gate has been applied. */
export interface ResolvedFeature {
  key: string;
  name: string;
  surface: FeatureSurface;
  webFallback: string;
}

/**
 * Parse the raw `native` JSON value (true | "partial" | false) into an enum.
 * Mirrors Android `SettingsManifestResolver.nativeSupport`.
 */
export function nativeSupport(raw: unknown): NativeSupport {
  if (raw === true) return NativeSupport.FULL;
  if (typeof raw === 'string') {
    if (raw.toLowerCase() === 'partial') return NativeSupport.PARTIAL;
    // Any non-"partial" string ("false", "true", "") -> fail safe; "true" is FULL,
    // everything else is "not natively renderable" -> web fallback.
    return raw.toLowerCase() === 'true' ? NativeSupport.FULL : NativeSupport.NONE;
  }
  return NativeSupport.NONE;
}

/** Take the leading run of digits of a version segment ("3-debug" -> 3), default 0. */
function segmentToInt(seg: string): number {
  const m = seg.match(/^\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

/**
 * Compare two dotted version strings. Returns -1 / 0 / 1. Mirrors
 * backend/lib/settings-manifest.js `compareVersions` and Android
 * `SettingsManifestResolver.compareVersions` (non-numeric or missing segments
 * treated as 0; suffixes like "1.2.3-debug" tolerated).
 */
export function compareVersions(v1: string, v2: string): number {
  const a = String(v1).split('.').map(segmentToInt);
  const b = String(v2).split('.').map(segmentToInt);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const p1 = a[i] ?? 0;
    const p2 = b[i] ?? 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Resolve one feature against the running app version, applying the minAppVersion
 * gate. A FULL/PARTIAL native flag is downgraded to the web surface when the
 * running app is older than the feature's minAppVersion.
 *
 * @param appVersion the running app's version. When null/blank, the declared native
 *   level is trusted (the backend reports it as declared when no appVersion is sent).
 */
export function resolveFeature(
  feature: SettingsManifestFeature,
  appVersion: string | null | undefined
): ResolvedFeature {
  const declared = nativeSupport(feature.native);
  let gated: NativeSupport;
  if (declared === NativeSupport.NONE) {
    gated = NativeSupport.NONE;
  } else if (!appVersion || appVersion.trim() === '') {
    gated = declared;
  } else if (compareVersions(appVersion, feature.minAppVersion) < 0) {
    // Running app predates native support for this feature -> web fallback.
    gated = NativeSupport.NONE;
  } else {
    gated = declared;
  }

  let surface: FeatureSurface;
  switch (gated) {
    case NativeSupport.FULL:
      surface = FeatureSurface.NATIVE;
      break;
    case NativeSupport.PARTIAL:
      surface = FeatureSurface.NATIVE_PLUS_WEB;
      break;
    default:
      surface = FeatureSurface.WEB;
  }

  return {
    key: feature.key,
    name: feature.name,
    surface,
    webFallback: feature.webFallback,
  };
}

/**
 * Resolve every ENABLED feature in the manifest into a render plan. Disabled
 * features are dropped (the app surfaces nothing for them). Mirrors Android
 * `SettingsManifestResolver.resolve`.
 */
export function resolve(
  manifest: SettingsManifest | null | undefined,
  appVersion: string | null | undefined
): ResolvedFeature[] {
  if (!manifest) return [];
  return manifest.features
    .filter((f) => f.enabled)
    .map((f) => resolveFeature(f, appVersion));
}

// ────────────────────────────────────────────────────────────────────────────
// Stage-2 auto-sync planner (port of SettingsManifestSync.kt)
//
// Turns the resolved manifest into the *extra* settings rows the running iOS
// binary doesn't already render natively. The static settings screen
// (ios-app/app/(tabs)/settings.tsx) hand-wires some features (Account /
// Subscription / Language / Notifications / Wallet / …). The manifest's value is
// the AUTO-SYNC seam: a NEW web-only feature (native:false) or a native feature
// gated out by the running app version is surfaced WITHOUT a rebuild by opening the
// web fallback. This planner computes exactly that delta.
// ────────────────────────────────────────────────────────────────────────────

/** A settings row the manifest asks the app to surface beyond its static screen. */
export interface DynamicSettingsRow {
  key: string;
  name: string;
  webFallback: string;
  /**
   * True when this feature DECLARES native support but the running app version is
   * below its minAppVersion — i.e. it was downgraded to the web fallback by the
   * version gate. The UI shows the "?" gated-help affordance (update app / open on
   * web) rather than presenting it as a plain web-only feature.
   */
  gated: boolean;
}

/**
 * Manifest feature keys this iOS binary already renders as native settings rows
 * (hand-wired in ios-app/app/(tabs)/settings.tsx). A key here means "the static
 * screen covers it, don't add a dynamic row when the manifest also says native".
 *
 * NOTE: this list reflects what the iOS static screen ACTUALLY renders natively,
 * which is intentionally narrower than the Android list — keys the iOS screen does
 * NOT render (channel_api, display, chat_prefs, developer_broadcast,
 * companion_petdx) are deliberately absent so the manifest auto-surfaces them as
 * web rows. That is exactly the drift-fix the seam exists for. Keep in sync with
 * the static screen.
 */
export const nativeRowKeys: ReadonlySet<string> = new Set([
  'account_identity',
  'subscription',
  'language',
  'notifications',
  'invite',
  'wallet',
  'my_rentals',
  'files',
  'feedback',
  // Stage-3 native (card_c3b13f64): Rotate Secret + Switch Device are now
  // rendered as native settings rows (see ios-app/app/(tabs)/settings.tsx), so
  // the manifest auto-sync path must NOT also emit duplicate web rows for them.
  // Mirrors the Android SettingsManifestSync.nativeRowKeys addition (PR #3742).
  'rotate_secret',
  'switch_device',
  'logout',
]);

/**
 * Manifest feature keys the static screen already surfaces via its OWN web link (a
 * hand-wired row that opens the portal). The manifest agrees these are web, so the
 * static row is correct — no dynamic duplicate needed.
 */
export const webBackedStaticRowKeys: ReadonlySet<string> = new Set(['kanban_nudge']);

const staticallyCoveredKeys: ReadonlySet<string> = new Set([
  ...nativeRowKeys,
  ...webBackedStaticRowKeys,
]);

/**
 * Decide whether a feature DECLARES native support yet was gated to the web by the
 * running app version (vs being plain web-only). Used to flag rows so the UI shows
 * "update app / open on web" help instead of a generic web row. Mirrors Android
 * `SettingsManifestSync.isVersionGated`.
 */
export function isVersionGated(
  feature: SettingsManifestFeature,
  appVersion: string | null | undefined
): boolean {
  const declared = nativeSupport(feature.native);
  if (declared === NativeSupport.NONE) return false; // genuinely web-only, not gated
  if (!appVersion || appVersion.trim() === '') return false; // no version -> trusted
  return compareVersions(appVersion, feature.minAppVersion) < 0;
}

/**
 * Plan the dynamic rows to append to the static settings screen. Mirrors Android
 * `SettingsManifestSync.planDynamicRows` decision-for-decision.
 *
 * @param manifest   the manifest envelope (null/failed fetch -> no extra rows; the
 *                   caller keeps its static screen as graceful degradation).
 * @param appVersion the running app version, for the client-side version gate.
 */
export function planDynamicRows(
  manifest: SettingsManifest | null | undefined,
  appVersion: string | null | undefined
): DynamicSettingsRow[] {
  if (!manifest) return [];
  const resolved = resolve(manifest, appVersion);
  const byKey = new Map(manifest.features.map((f) => [f.key, f]));

  const rows: DynamicSettingsRow[] = [];
  for (const r of resolved) {
    // Feature renders natively this binary already covers -> nothing to add.
    if (r.surface === FeatureSurface.NATIVE && nativeRowKeys.has(r.key)) continue;
    // NATIVE_PLUS_WEB / WEB that the static screen already covers via its own row
    // (native row OR web-backed row) -> the static screen is enough.
    if (staticallyCoveredKeys.has(r.key) && r.surface !== FeatureSurface.WEB) {
      // partial native already rendered statically; no separate web row.
      continue;
    }
    // A WEB-surfaced feature the static screen already covers (e.g. a native row
    // the manifest gated out, or a web-backed static row that is already the web
    // surface) -> only add a row if it is NOT statically covered at all.
    if (r.surface === FeatureSurface.WEB && staticallyCoveredKeys.has(r.key)) {
      const feat = byKey.get(r.key);
      const gated = !!feat && isVersionGated(feat, appVersion);
      // Static native row exists but the manifest gated it out -> the static row
      // would present a control the binary can't fully honor; surface a gated help
      // row so the user can reach the web version.
      if (gated && nativeRowKeys.has(r.key)) {
        rows.push({ key: r.key, name: r.name, webFallback: r.webFallback, gated: true });
      }
      continue;
    }
    // Everything else: a feature with no native static row that the manifest routes
    // to the web -> THIS is the zero-rebuild auto-sync payoff.
    const feat = byKey.get(r.key);
    const gated = !!feat && isVersionGated(feat, appVersion);
    rows.push({ key: r.key, name: r.name, webFallback: r.webFallback, gated });
  }
  return rows;
}
