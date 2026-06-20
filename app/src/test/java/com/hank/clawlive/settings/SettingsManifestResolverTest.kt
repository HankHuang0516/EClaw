package com.hank.clawlive.settings

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-logic tests for the Stage-2 client manifest resolver. Mirrors the
 * backend contract in backend/lib/settings-manifest.js + the worked version-gate
 * example in docs/specs/settings-manifest-spec.md §3. No Android deps.
 */
class SettingsManifestResolverTest {

    // ── native flag normalisation ────────────────────────────────────────────

    @Test
    fun nativeSupport_normalisesTruePartialFalse() {
        assertEquals(NativeSupport.FULL, SettingsManifestResolver.nativeSupport(true))
        assertEquals(NativeSupport.PARTIAL, SettingsManifestResolver.nativeSupport("partial"))
        assertEquals(NativeSupport.PARTIAL, SettingsManifestResolver.nativeSupport("PARTIAL"))
        assertEquals(NativeSupport.NONE, SettingsManifestResolver.nativeSupport(false))
        assertEquals(NativeSupport.NONE, SettingsManifestResolver.nativeSupport(null))
        // "true" as a JSON string still means natively renderable.
        assertEquals(NativeSupport.FULL, SettingsManifestResolver.nativeSupport("true"))
        // Any unknown string fails safe to web.
        assertEquals(NativeSupport.NONE, SettingsManifestResolver.nativeSupport("maybe"))
    }

    // ── compareVersions parity with backend ──────────────────────────────────

    @Test
    fun compareVersions_matchesBackendSemantics() {
        assertEquals(-1, SettingsManifestResolver.compareVersions("1.0.0", "2.5.0"))
        assertEquals(0, SettingsManifestResolver.compareVersions("2.5.0", "2.5.0"))
        assertEquals(1, SettingsManifestResolver.compareVersions("3.0.0", "2.5.0"))
        // Missing segments treated as 0.
        assertEquals(0, SettingsManifestResolver.compareVersions("1.0", "1.0.0"))
        assertEquals(1, SettingsManifestResolver.compareVersions("1.0.1", "1.0"))
        // Suffixed build names tolerated (leading digits only).
        assertEquals(0, SettingsManifestResolver.compareVersions("2.5.0-debug", "2.5.0"))
    }

    // ── version gating (spec §3 worked example: companion_petdx) ──────────────

    private fun feature(native: Any?, minVer: String) = SettingsManifestFeature(
        key = "companion_petdx",
        name = "Companion (PetDX)",
        enabled = true,
        native = native,
        webFallback = "https://eclawbot.com/portal/settings.html?focus=companion_petdx",
        minAppVersion = minVer
    )

    @Test
    fun resolve_oldAppBelowMinVersion_downgradesToWeb() {
        val r = SettingsManifestResolver.resolveFeature(feature(true, "2.5.0"), "1.0.0")
        assertEquals(FeatureSurface.WEB, r.surface)
        assertEquals("https://eclawbot.com/portal/settings.html?focus=companion_petdx", r.webFallback)
    }

    @Test
    fun resolve_appAtMinVersion_getsNative() {
        val r = SettingsManifestResolver.resolveFeature(feature(true, "2.5.0"), "2.5.0")
        assertEquals(FeatureSurface.NATIVE, r.surface)
    }

    @Test
    fun resolve_appAboveMinVersion_getsNative() {
        val r = SettingsManifestResolver.resolveFeature(feature(true, "2.5.0"), "3.0.0")
        assertEquals(FeatureSurface.NATIVE, r.surface)
    }

    @Test
    fun resolve_partialFeatureAboveGate_getsNativePlusWeb() {
        val r = SettingsManifestResolver.resolveFeature(feature("partial", "1.0.0"), "1.0.0")
        assertEquals(FeatureSurface.NATIVE_PLUS_WEB, r.surface)
    }

    @Test
    fun resolve_partialFeatureBelowGate_downgradesToWeb() {
        val r = SettingsManifestResolver.resolveFeature(feature("partial", "2.0.0"), "1.0.0")
        assertEquals(FeatureSurface.WEB, r.surface)
    }

    @Test
    fun resolve_nativeFalseFeature_alwaysWeb_evenOnNewApp() {
        // rotate_secret / switch_device today: native:false on both platforms.
        val r = SettingsManifestResolver.resolveFeature(feature(false, "0.0.0"), "99.0.0")
        assertEquals(FeatureSurface.WEB, r.surface)
    }

    @Test
    fun resolve_missingAppVersion_trustsDeclaredNative() {
        // Backend reports native as declared when appVersion is absent; the client
        // resolver mirrors that (no downgrade) so cached/param-less fetches agree.
        val r = SettingsManifestResolver.resolveFeature(feature(true, "2.5.0"), null)
        assertEquals(FeatureSurface.NATIVE, r.surface)
        val rBlank = SettingsManifestResolver.resolveFeature(feature(true, "2.5.0"), "")
        assertEquals(FeatureSurface.NATIVE, rBlank.surface)
    }

    // ── manifest-level resolve ───────────────────────────────────────────────

    @Test
    fun resolveManifest_dropsDisabled_andGatesEach() {
        val manifest = SettingsManifest(
            platform = "android",
            appVersion = "1.0.0",
            stage = 1,
            features = listOf(
                SettingsManifestFeature("account_identity", "Account & Identity", true, true, "wf_a", "1.0.0"),
                SettingsManifestFeature("rotate_secret", "Rotate Secret", true, false, "wf_r", "0.0.0"),
                SettingsManifestFeature("companion_petdx", "Companion", true, true, "wf_c", "2.5.0"),
                SettingsManifestFeature("hidden_feature", "Hidden", false, true, "wf_h", "1.0.0")
            )
        )
        val resolved = SettingsManifestResolver.resolve(manifest, "1.0.0")

        // disabled feature dropped
        assertEquals(listOf("account_identity", "rotate_secret", "companion_petdx"), resolved.map { it.key })
        // account: native at min 1.0.0 on a 1.0.0 app
        assertEquals(FeatureSurface.NATIVE, resolved[0].surface)
        // rotate_secret: native:false -> web
        assertEquals(FeatureSurface.WEB, resolved[1].surface)
        // companion: gated out (1.0.0 < 2.5.0) -> web
        assertEquals(FeatureSurface.WEB, resolved[2].surface)
    }

    @Test
    fun resolveManifest_nullManifest_isEmpty() {
        assertEquals(emptyList<ResolvedFeature>(), SettingsManifestResolver.resolve(null, "1.0.0"))
    }
}
