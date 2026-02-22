package com.hank.clawlive.service

import android.service.wallpaper.WallpaperService
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for [ClawWallpaperService].
 *
 * Runs on an Android device/emulator — verifies that the service is
 * correctly declared and is a valid WallpaperService subclass.
 *
 * More complex rendering tests should go in ClawRendererTest.
 */
@RunWith(AndroidJUnit4::class)
class ClawWallpaperServiceTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    // ── Class structure ───────────────────────────────────────────────────────

    @Test
    fun serviceExtendsWallpaperService() {
        // Verify inheritance chain: ClawWallpaperService → WallpaperService
        assertTrue(
            "ClawWallpaperService must extend WallpaperService",
            WallpaperService::class.java.isAssignableFrom(ClawWallpaperService::class.java)
        )
    }

    @Test
    fun serviceClassCanBeLoaded() {
        // Verifies the class is on the classpath (would fail if class was deleted/renamed)
        val clazz = Class.forName("com.hank.clawlive.service.ClawWallpaperService")
        assertNotNull("ClawWallpaperService class must be loadable", clazz)
    }

    // ── Manifest declaration ──────────────────────────────────────────────────

    @Test
    fun serviceIsDeclaredInManifest() {
        val packageManager = context.packageManager
        val packageName = context.packageName

        val serviceInfoList = packageManager
            .getPackageInfo(packageName, android.content.pm.PackageManager.GET_SERVICES)
            .services

        val isDeclared = serviceInfoList?.any { serviceInfo ->
            serviceInfo.name == ClawWallpaperService::class.java.name
        } ?: false

        assertTrue(
            "ClawWallpaperService must be declared in AndroidManifest.xml",
            isDeclared
        )
    }

    // ── Package context ───────────────────────────────────────────────────────

    @Test
    fun targetContextPackageMatchesApp() {
        // Sanity check: instrumentation is running against the correct package
        assertNotNull("Target context must not be null", context)
        assertTrue(
            "Package name should start with 'com.hank.clawlive'",
            context.packageName.startsWith("com.hank.clawlive")
        )
    }
}
