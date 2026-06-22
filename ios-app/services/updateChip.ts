/**
 * Pure-logic decision + store-link constants for the Settings
 * "update-available" chip (card_1771f826, per parent card_dfb85157189c3255300dc86e
 * spec). iOS counterpart of the Android `UpdateChipDecision` (card_28a8290a).
 *
 * The chip is shown ONLY when we are confident a newer build exists. The single
 * source of truth for "newer build exists" is the backend `/api/version`
 * response (`update.available` + `update.latestVersion`), which the backend
 * computes by comparing the client's `appVersion` against `LATEST_APP_VERSION`.
 *
 * We do NOT re-implement the server's comparison; we mirror it as a local,
 * defensive cross-check so a stale/garbled `available` flag can never produce a
 * *false* update prompt:
 *   - chip shows  iff  server says available AND a local version-compare also
 *     says the latest string is strictly greater than the installed version.
 *   - any fetch failure / null update block / blank version => chip HIDDEN
 *     (graceful degradation — never a false "update now" prompt).
 *
 * Local version comparison reuses [compareVersions] from settingsManifest.ts
 * (the existing dotted-version comparator, tolerant of suffixes like
 * "1.2.3-debug" and mirroring backend/lib/settings-manifest.js), so we don't
 * invent a new one.
 *
 * No React Native / Expo deps — covered by a Jest unit test. The actual store
 * redirect (Linking.openURL) lives in the Settings screen, mirroring how the
 * Android side keeps the Play Core flow in SettingsActivity, not in the pure
 * decision object.
 */
import { compareVersions } from './settingsManifest';

/**
 * App Store Connect app id for EClaw (eas.json `ascAppId`; bundle
 * com.eclawbot.app). Hardcoded per the card spec ("client 寫死 EClaw Apple App
 * ID"). Used to build the App Store product links below.
 */
export const APP_STORE_ID = '6762198865';

/**
 * `itms-apps://` opens the App Store *app* directly on the EClaw product page —
 * Apple-compliant (the user still taps "Update" there; no silent install) and
 * the closest in-spec behaviour available to a managed Expo build. A native
 * `SKStoreProductViewController` in-app overlay (truly "不離 App") would require
 * a custom native module / config plugin — tracked as a follow-up; this card
 * ships the spec's explicit `itms-apps://` path.
 */
export const appStoreDeepLink = `itms-apps://apps.apple.com/app/id${APP_STORE_ID}`;

/** Universal https fallback when `itms-apps://` can't be handled (rare). */
export const appStoreHttpsLink = `https://apps.apple.com/app/id${APP_STORE_ID}`;

/**
 * @param available the backend's `update.available` flag (null/undefined when no
 *   update block was returned, e.g. fetch failed or no appVersion sent).
 * @param installedVersion the running build's version (Constants.expoConfig.version).
 * @param latestVersion the backend's `update.latestVersion`.
 * @returns true if the update chip should be visible.
 */
export function shouldShowChip(
  available: boolean | null | undefined,
  installedVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): boolean {
  // Backend must affirmatively say an update is available.
  if (available !== true) return false;
  // Both version strings must be present and non-blank to compare safely.
  const installed = (installedVersion ?? '').trim();
  const latest = (latestVersion ?? '').trim();
  if (installed.length === 0 || latest.length === 0) return false;
  // Defensive local cross-check: only show when latest is strictly newer.
  // Equal or older latest (clock skew / stale flag) => safe default: hide.
  return compareVersions(installed, latest) < 0;
}
