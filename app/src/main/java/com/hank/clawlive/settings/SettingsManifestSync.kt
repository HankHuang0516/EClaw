package com.hank.clawlive.settings

/**
 * Stage-2 auto-sync planner: turns the resolved manifest into the *extra* settings
 * rows the running binary doesn't already render natively.
 *
 * The existing [com.hank.clawlive.SettingsActivity] is a hand-built static screen:
 * features such as Subscription / Language / Notifications already have native rows
 * wired by hand. The manifest's value is the AUTO-SYNC seam — when a NEW
 * settings feature ships web-only (`native:false`) or a native feature is gated out
 * by the running app version, the app must surface it WITHOUT a rebuild by opening
 * the web fallback. This planner computes exactly that delta:
 *
 *   - A feature that the running app already renders natively (its `key` is in
 *     [nativeRowKeys]) and the manifest agrees is native -> no extra row (the static
 *     screen already covers it).
 *   - A feature the manifest routes to the web ([FeatureSurface.WEB] /
 *     [FeatureSurface.NATIVE_PLUS_WEB]) that has NO native static row -> emit a
 *     dynamic row that opens the web fallback. This is how a brand-new web-only
 *     feature appears on day one with zero rebuild.
 *   - A feature the running app DOES render natively but the manifest has gated to
 *     the web (declared native, but the running app predates `minAppVersion`) ->
 *     emit a [DynamicSettingsRow] flagged [DynamicSettingsRow.gated] so the UI can
 *     show the spec §4 "?"-help (what / needs / next step) instead of a stale
 *     native control the binary can't honor.
 *
 * This file is pure Kotlin (no Android deps) so the delta logic is unit-testable.
 */

/** A settings row the manifest asks the app to surface beyond its static screen. */
data class DynamicSettingsRow(
    val key: String,
    val name: String,
    val webFallback: String,
    /**
     * True when this feature DECLARES native support but the running app version is
     * below its `minAppVersion` — i.e. it was downgraded to the web fallback by the
     * version gate. The UI shows the "?" gated-help affordance (update app / open on
     * web) rather than presenting it as a plain web-only feature.
     */
    val gated: Boolean
)

object SettingsManifestSync {

    /**
     * Manifest feature keys that this binary already renders as native settings rows
     * (hand-wired in SettingsActivity's static layout). Keep in sync with the static
     * screen — a key here means "the static screen covers it, don't add a dynamic
     * row when the manifest also says native".
     *
     * Note: `kanban_nudge` is intentionally NOT here even though a static row exists,
     * because that static row itself opens the web fallback — it is already the
     * web-surface, so re-emitting it would duplicate. Web-surfaced static rows are
     * tracked in [webBackedStaticRowKeys] instead.
     */
    val nativeRowKeys: Set<String> = setOf(
        "subscription",
        "invite",
        "language",
        "display",
        "chat_prefs",
        "notifications",
        "developer_broadcast",
        "wallet",
        "my_rentals",
        "files",
        "companion_petdx",
        "feedback",
        "account_identity",
        "channel_api",
        "logout"
    )

    /**
     * Manifest feature keys the static screen already surfaces via its OWN web link
     * (a hand-wired row that opens the portal). The manifest agrees these are web,
     * so the static row is correct — no dynamic duplicate needed.
     */
    val webBackedStaticRowKeys: Set<String> = setOf(
        "kanban_nudge"
    )

    private val staticallyCoveredKeys: Set<String> = nativeRowKeys + webBackedStaticRowKeys

    /**
     * Decide whether a feature DECLARES native support yet was gated to the web by
     * the running app version (vs being plain web-only). Used to flag rows so the UI
     * shows the "update app / open on web" help instead of a generic web row.
     */
    fun isVersionGated(feature: SettingsManifestFeature, appVersion: String?): Boolean {
        val declared = SettingsManifestResolver.nativeSupport(feature.native)
        if (declared == NativeSupport.NONE) return false // genuinely web-only, not gated
        if (appVersion.isNullOrBlank()) return false     // no version sent -> declared trusted
        return SettingsManifestResolver.compareVersions(appVersion, feature.minAppVersion) < 0
    }

    /**
     * Plan the dynamic rows to append to the static settings screen.
     *
     * @param manifest   the manifest envelope (null/failed fetch -> no extra rows;
     *                   the caller keeps its static screen as graceful degradation).
     * @param appVersion the running app versionName, for the client-side version gate.
     */
    fun planDynamicRows(manifest: SettingsManifest?, appVersion: String?): List<DynamicSettingsRow> {
        if (manifest == null) return emptyList()
        val resolved = SettingsManifestResolver.resolve(manifest, appVersion)
        val byKey = manifest.features.associateBy { it.key }

        return resolved.mapNotNull { r ->
            // Feature renders natively this binary already covers -> nothing to add.
            if (r.surface == FeatureSurface.NATIVE && r.key in nativeRowKeys) return@mapNotNull null
            // NATIVE_PLUS_WEB / WEB that the static screen already covers via its own
            // row (native row OR web-backed row) -> the static screen is enough.
            if (r.key in staticallyCoveredKeys && r.surface != FeatureSurface.WEB) {
                // partial native already rendered statically; no separate web row.
                return@mapNotNull null
            }
            // A WEB-surfaced feature the static screen already covers (e.g. a native
            // row that the manifest gated out, or a web-backed static row that is
            // already the web surface) -> only add a row if it is NOT statically
            // covered at all. Statically-covered web rows are left to the static UI.
            if (r.surface == FeatureSurface.WEB && r.key in staticallyCoveredKeys) {
                val feat = byKey[r.key]
                val gated = feat != null && isVersionGated(feat, appVersion)
                // If the static native row exists but the manifest gated it out, the
                // static row would present a control the binary can't fully honor;
                // surface a gated help row so the user can reach the web version.
                if (gated && r.key in nativeRowKeys) {
                    return@mapNotNull DynamicSettingsRow(r.key, r.name, r.webFallback, gated = true)
                }
                return@mapNotNull null
            }
            // Everything else: a feature with no native static row that the manifest
            // routes to the web -> THIS is the zero-rebuild auto-sync payoff.
            val feat = byKey[r.key]
            val gated = feat != null && isVersionGated(feat, appVersion)
            DynamicSettingsRow(r.key, r.name, r.webFallback, gated = gated)
        }
    }
}
