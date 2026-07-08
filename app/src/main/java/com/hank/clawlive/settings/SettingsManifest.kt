package com.hank.clawlive.settings

/**
 * Client-side model + resolver for the settings auto-sync seam (Stage 2).
 *
 * The backend ships `GET /api/settings-manifest?appVersion=&platform=` (Stage 1,
 * see backend/lib/settings-manifest.js + docs/specs/settings-manifest-spec.md).
 * Each enabled feature carries a `native` capability flag and a `webFallback`
 * URL. The app must, per feature, decide how to surface it:
 *
 *   native == true       -> render the native screen for that feature
 *   native == "partial"  -> render native UI + a "more on web" link -> webFallback
 *   native == false      -> open webFallback in a WebView
 *
 * The backend already applies the `minAppVersion` version gate when the app sends
 * `appVersion`. This client resolver mirrors that gate locally so the decision is
 * correct EVEN IF the app failed to send `appVersion` (e.g. the manifest was
 * cached, or fetched without the query param). A native flag the running binary
 * cannot honor is therefore never trusted blindly: if the running app version is
 * below the feature's `minAppVersion`, the feature is downgraded to the web
 * fallback. This is a pure function — no Android deps — so it is unit-testable.
 */

/** One feature row as returned by GET /api/settings-manifest. */
data class SettingsManifestFeature(
    val key: String = "",
    val name: String = "",
    val enabled: Boolean = false,
    // Gson decodes the JSON `native` field (true | "partial" | false) into Any?.
    // Use [nativeSupport] to normalise it; never read this raw field directly.
    val native: Any? = false,
    val webFallback: String = "",
    val minAppVersion: String = "0.0.0"
)

/** Top-level manifest envelope: GET /api/settings-manifest. */
data class SettingsManifest(
    val platform: String = "android",
    val appVersion: String? = null,
    val generatedAt: String? = null,
    val stage: Int = 0,
    val features: List<SettingsManifestFeature> = emptyList()
)

/** Retrofit response wrapper: { success, manifest }. */
data class SettingsManifestResponse(
    val success: Boolean = false,
    val manifest: SettingsManifest? = null,
    val error: String? = null
)

/** Normalised native-support level for one feature on this platform. */
enum class NativeSupport { FULL, PARTIAL, NONE }

/**
 * How the app should surface one resolved feature.
 *
 * - [NATIVE]        : render the native screen ([NativeSupport.FULL]).
 * - [NATIVE_PLUS_WEB]: render native UI + a "more on web" link to [webFallback]
 *                      ([NativeSupport.PARTIAL]).
 * - [WEB]           : open [webFallback] in a WebView ([NativeSupport.NONE], or a
 *                      higher level downgraded by the version gate).
 */
enum class FeatureSurface { NATIVE, NATIVE_PLUS_WEB, WEB }

/** A feature after the client version gate has been applied. */
data class ResolvedFeature(
    val key: String,
    val name: String,
    val surface: FeatureSurface,
    val webFallback: String
)

object SettingsManifestResolver {

    /** Parse the raw `native` JSON value (true | "partial" | false) into an enum. */
    fun nativeSupport(raw: Any?): NativeSupport = when (raw) {
        true -> NativeSupport.FULL
        is String -> if (raw.equals("partial", ignoreCase = true)) {
            NativeSupport.PARTIAL
        } else {
            // Any non-"partial" string (incl. "false", "true", "") is treated as
            // "not natively renderable" — fail safe to the web fallback.
            if (raw.equals("true", ignoreCase = true)) NativeSupport.FULL else NativeSupport.NONE
        }
        else -> NativeSupport.NONE
    }

    /**
     * Compare two dotted version strings. Returns -1 / 0 / 1. Mirrors
     * backend/lib/settings-manifest.js `compareVersions` (non-numeric or missing
     * segments are treated as 0). Tolerant of suffixes like "1.2.3-debug".
     */
    fun compareVersions(v1: String, v2: String): Int {
        val a = splitVersion(v1)
        val b = splitVersion(v2)
        val n = maxOf(a.size, b.size)
        for (i in 0 until n) {
            val p1 = a.getOrElse(i) { 0 }
            val p2 = b.getOrElse(i) { 0 }
            if (p1 < p2) return -1
            if (p1 > p2) return 1
        }
        return 0
    }

    private fun splitVersion(v: String): List<Int> =
        v.split('.').map { seg ->
            // Take the leading run of digits ("3-debug" -> 3), default 0.
            seg.takeWhile { it.isDigit() }.toIntOrNull() ?: 0
        }

    /**
     * Resolve one feature against the running app version, applying the
     * minAppVersion gate. A FULL/PARTIAL native flag is downgraded to the web
     * surface when the running app is older than the feature's minAppVersion.
     *
     * @param appVersion the running app's versionName. When null/blank, the
     *   declared native level is trusted (the backend reports it as declared
     *   when no appVersion is sent).
     */
    fun resolveFeature(feature: SettingsManifestFeature, appVersion: String?): ResolvedFeature {
        val declared = nativeSupport(feature.native)
        val gated = if (declared == NativeSupport.NONE) {
            NativeSupport.NONE
        } else if (appVersion.isNullOrBlank()) {
            declared
        } else if (compareVersions(appVersion, feature.minAppVersion) < 0) {
            // Running app predates native support for this feature -> web fallback.
            NativeSupport.NONE
        } else {
            declared
        }

        val surface = when (gated) {
            NativeSupport.FULL -> FeatureSurface.NATIVE
            NativeSupport.PARTIAL -> FeatureSurface.NATIVE_PLUS_WEB
            NativeSupport.NONE -> FeatureSurface.WEB
        }

        return ResolvedFeature(
            key = feature.key,
            name = feature.name,
            surface = surface,
            webFallback = feature.webFallback
        )
    }

    /**
     * Resolve every ENABLED feature in the manifest into a render plan. Disabled
     * features are dropped (the app surfaces nothing for them).
     */
    fun resolve(manifest: SettingsManifest?, appVersion: String?): List<ResolvedFeature> {
        if (manifest == null) return emptyList()
        return manifest.features
            .filter { it.enabled }
            .map { resolveFeature(it, appVersion) }
    }
}
