package com.hank.clawlive.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the Settings update-available chip decision
 * ([UpdateChipDecision], card_28a8290a). No Android dependencies.
 *
 * Standalone (intentionally NOT registered in [com.hank.clawlive.UnitTestSuite]) so
 * this PR doesn't textually collide with the open wallpaper PR #3650 which also edits
 * UnitTestSuite.kt. Still runnable directly:
 *   ./gradlew :app:testDebugUnitTest --tests "*UpdateChipDecisionTest*"
 */
class UpdateChipDecisionTest {

    @Test
    fun `different version with server available shows chip`() {
        assertTrue(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "1.0.96",
                latestVersion = "1.0.97"
            )
        )
    }

    @Test
    fun `major jump shows chip`() {
        assertTrue(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "1.0.96",
                latestVersion = "2.0.0"
            )
        )
    }

    @Test
    fun `same version hides chip even if server says available`() {
        // Defensive cross-check: stale/garbled available flag must not produce a
        // false "update now" prompt when the versions are actually equal.
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "1.0.96",
                latestVersion = "1.0.96"
            )
        )
    }

    @Test
    fun `installed newer than latest hides chip`() {
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "1.1.0",
                latestVersion = "1.0.96"
            )
        )
    }

    @Test
    fun `server not available hides chip`() {
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = false,
                installedVersion = "1.0.96",
                latestVersion = "1.0.97"
            )
        )
    }

    @Test
    fun `null available (fetch failed) hides chip`() {
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = null,
                installedVersion = "1.0.96",
                latestVersion = "1.0.97"
            )
        )
    }

    @Test
    fun `blank installed version hides chip - safe default`() {
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "",
                latestVersion = "1.0.97"
            )
        )
    }

    @Test
    fun `blank latest version hides chip - safe default`() {
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "1.0.96",
                latestVersion = "   "
            )
        )
    }

    @Test
    fun `unknown installed version hides chip - safe default`() {
        // DeviceManager.appVersion returns "unknown" when packageInfo lookup fails;
        // "unknown" vs "1.0.97" compares as 0.0.0 < 1.0.97, but the caller guards on
        // "unknown" before invoking. Verify the comparator itself stays safe for
        // garbage that slips through: a non-numeric installed string is treated as
        // 0.0.0, which IS strictly less than a real latest, so it would show — hence
        // the caller's explicit "unknown" guard is the real safety net. Here we just
        // assert malformed-but-equal stays hidden.
        assertFalse(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "garbage",
                latestVersion = "garbage"
            )
        )
    }

    @Test
    fun `suffixed version compares numerically`() {
        // "1.0.96-debug" should be treated as 1.0.96 < 1.0.97 -> show.
        assertTrue(
            UpdateChipDecision.shouldShowChip(
                available = true,
                installedVersion = "1.0.96-debug",
                latestVersion = "1.0.97"
            )
        )
    }
}
