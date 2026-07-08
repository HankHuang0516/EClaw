package com.hank.clawlive.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for the Stage-2 auto-sync row planner ([SettingsManifestSync]).
 *
 * The planner computes the DELTA between what the static SettingsActivity already
 * renders and what the manifest declares: only web-fallback / version-gated features
 * with no native static row become dynamic rows. No Android deps.
 */
class SettingsManifestSyncTest {

    private fun feature(
        key: String,
        native: Any?,
        enabled: Boolean = true,
        minVer: String = "0.0.0",
        webFallback: String = "https://eclawbot.com/portal/settings.html?focus=$key"
    ) = SettingsManifestFeature(
        key = key,
        name = key.replaceFirstChar { it.uppercase() },
        enabled = enabled,
        native = native,
        webFallback = webFallback,
        minAppVersion = minVer
    )

    private fun manifest(vararg features: SettingsManifestFeature) = SettingsManifest(
        platform = "android",
        appVersion = "1.0.0",
        stage = 1,
        features = features.toList()
    )

    // ── new web-only feature with no native row → appears (the auto-sync payoff) ──

    @Test
    fun planDynamicRows_newWebOnlyFeature_emitsWebRow() {
        // rental_management: native:false, no static native row → dynamic web row.
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(feature("rental_management", native = false)),
            "1.0.94"
        )
        assertEquals(1, rows.size)
        assertEquals("rental_management", rows[0].key)
        assertFalse("plain web-only feature is not version-gated", rows[0].gated)
        assertEquals(
            "https://eclawbot.com/portal/settings.html?focus=rental_management",
            rows[0].webFallback
        )
    }

    // ── Stage 3 native (card_c3b13f64): rotate_secret / switch_device are now ──
    // ── handled by native dialogs, so even though the manifest declares them   ──
    // ── web-only (native:false) the planner must NOT emit a duplicate web row. ──

    @Test
    fun planDynamicRows_stage3NativeRows_areCoveredNatively() {
        assertTrue("rotate_secret is a native static row", "rotate_secret" in SettingsManifestSync.nativeRowKeys)
        assertTrue("switch_device is a native static row", "switch_device" in SettingsManifestSync.nativeRowKeys)
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(
                feature("rotate_secret", native = false),
                feature("switch_device", native = false)
            ),
            "1.0.94"
        )
        assertTrue("native-handled features emit no dynamic web row", rows.isEmpty())
    }

    // ── feature the static screen already renders natively → no dynamic row ──

    @Test
    fun planDynamicRows_nativeFeatureWithStaticRow_isSkipped() {
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(
                feature("subscription", native = true, minVer = "1.0.0"),
                feature("language", native = true, minVer = "1.0.0"),
                feature("notifications", native = true, minVer = "1.0.0")
            ),
            "1.0.94"
        )
        assertTrue("static native rows produce no extra rows", rows.isEmpty())
    }

    // ── web-backed static row (kanban_nudge opens web itself) → no duplicate ──

    @Test
    fun planDynamicRows_webBackedStaticRow_isNotDuplicated() {
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(feature("kanban_nudge", native = false)),
            "1.0.94"
        )
        assertTrue("kanban_nudge has its own static web row — no dynamic duplicate", rows.isEmpty())
    }

    // ── disabled feature is dropped before planning ──

    @Test
    fun planDynamicRows_disabledFeature_isDropped() {
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(feature("agent_policy", native = false, enabled = false)),
            "1.0.94"
        )
        assertTrue(rows.isEmpty())
    }

    // ── version-gated NATIVE feature with a static row → gated help row ──

    @Test
    fun planDynamicRows_nativeFeatureGatedByVersion_emitsGatedRow() {
        // subscription declares native at minVer 2.5.0, but the running app is 1.0.0,
        // so the static native row can't be honored → surface a gated help row.
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(feature("subscription", native = true, minVer = "2.5.0")),
            "1.0.0"
        )
        assertEquals(1, rows.size)
        assertEquals("subscription", rows[0].key)
        assertTrue("downgraded native feature is flagged gated", rows[0].gated)
    }

    // ── a NEW native-declared feature gated out, no static row → gated web row ──

    @Test
    fun planDynamicRows_newNativeFeatureGated_emitsGatedRow() {
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(feature("companion_v2", native = true, minVer = "3.0.0")),
            "1.0.0"
        )
        assertEquals(1, rows.size)
        assertEquals("companion_v2", rows[0].key)
        assertTrue(rows[0].gated)
    }

    // ── isVersionGated distinguishes gated vs plain web-only ──

    @Test
    fun isVersionGated_distinguishesGatedFromWebOnly() {
        // declared native but app too old → gated
        assertTrue(
            SettingsManifestSync.isVersionGated(feature("x", native = true, minVer = "2.0.0"), "1.0.0")
        )
        // declared native and app new enough → not gated
        assertFalse(
            SettingsManifestSync.isVersionGated(feature("x", native = true, minVer = "1.0.0"), "1.0.0")
        )
        // genuinely web-only → not "gated" (it never declared native)
        assertFalse(
            SettingsManifestSync.isVersionGated(feature("x", native = false, minVer = "0.0.0"), "1.0.0")
        )
        // no appVersion sent → declared native trusted, not gated
        assertFalse(
            SettingsManifestSync.isVersionGated(feature("x", native = true, minVer = "2.0.0"), null)
        )
    }

    // ── graceful fallback: null manifest → no rows (caller keeps static screen) ──

    @Test
    fun planDynamicRows_nullManifest_isEmpty() {
        assertEquals(emptyList<DynamicSettingsRow>(), SettingsManifestSync.planDynamicRows(null, "1.0.0"))
    }

    // ── realistic live manifest shape → only the expected extras surface ──

    @Test
    fun planDynamicRows_liveLikeManifest_surfacesOnlyMissingFeatures() {
        val rows = SettingsManifestSync.planDynamicRows(
            manifest(
                feature("account_identity", native = true, minVer = "1.0.0"),
                feature("channel_api", native = "partial", minVer = "1.0.0"),
                feature("subscription", native = true, minVer = "1.0.0"),
                feature("notifications", native = true, minVer = "1.0.0"),
                feature("kanban_nudge", native = false),          // web-backed static row
                feature("rental_management", native = false),      // NEW web-only → row
                feature("agent_policy", native = false),           // NEW web-only → row
                feature("passive_health", native = false),         // NEW web-only → row
                feature("rotate_secret", native = false),          // Stage 3 native → no row
                feature("switch_device", native = false)           // Stage 3 native → no row
            ),
            "1.0.94"
        )
        assertEquals(
            // rotate_secret/switch_device are now native static rows (Stage 3) so they
            // are statically covered — only the genuinely web-only features surface.
            listOf("rental_management", "agent_policy", "passive_health"),
            rows.map { it.key }
        )
        assertTrue("all are plain web-only, none gated", rows.none { it.gated })
    }
}
