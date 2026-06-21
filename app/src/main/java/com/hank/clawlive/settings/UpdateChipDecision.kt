package com.hank.clawlive.settings

/**
 * Pure-logic decision for the Settings "update-available" chip
 * (card_28a8290a, per parent card_dfb85157189c3255300dc86e spec).
 *
 * The chip is shown ONLY when we are confident a newer build exists. The single
 * source of truth for "newer build exists" is the backend `/api/version` response
 * (`update.available`), which the backend computes by comparing the client's
 * `appVersion` against `LATEST_APP_VERSION` (see backend/index.js `/api/version`).
 *
 * We do NOT re-implement the server's comparison here; instead we mirror it as a
 * local, defensive cross-check so a stale/garbled `available` flag can never produce
 * a *false* update prompt:
 *   - chip shows  iff  server says available AND a local version-compare also says
 *     the latest string is strictly greater than the installed version.
 *   - any fetch failure / null update block / blank version => chip HIDDEN
 *     (graceful degradation — never a false "update now" prompt; see Acceptance).
 *
 * Local version comparison reuses [SettingsManifestResolver.compareVersions]
 * (the existing dotted-version comparator, tolerant of suffixes like "1.2.3-debug"
 * and mirrors backend/lib/settings-manifest.js), so we don't invent a new one.
 *
 * No Android dependencies — covered by a JVM unit test.
 */
object UpdateChipDecision {

    /**
     * @param available the backend's `update.available` flag (null when no update
     *   block was returned, e.g. fetch failed or no appVersion sent).
     * @param installedVersion the running build's versionName (BuildConfig.VERSION_NAME).
     * @param latestVersion the backend's `update.latestVersion`.
     * @return true if the update chip should be visible.
     */
    fun shouldShowChip(
        available: Boolean?,
        installedVersion: String?,
        latestVersion: String?
    ): Boolean {
        // Backend must affirmatively say an update is available.
        if (available != true) return false
        // Both version strings must be present and non-blank to compare safely.
        val installed = installedVersion?.trim().orEmpty()
        val latest = latestVersion?.trim().orEmpty()
        if (installed.isEmpty() || latest.isEmpty()) return false
        // Defensive local cross-check: only show when latest is strictly newer.
        // Equal or older latest (clock skew / stale flag) => safe default: hide.
        return SettingsManifestResolver.compareVersions(installed, latest) < 0
    }
}
